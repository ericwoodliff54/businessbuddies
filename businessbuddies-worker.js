/**
 * BusinessBuddies Cloudflare Worker
 * Endpoints:
 *   POST /audit-receipt   -> Gemini Vision receipt OCR (merchant, date, total, category, lineItems)
 *   GET  /lookup-barcode  -> Fast ISBN / UPC title lookup (Open Library + optional KV cache)
 *
 * Required Secret: GEMINI_API_KEY
 * Optional KV Binding: BB_CATALOG_DB
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const RATE_BUCKETS = new Map();
function checkEdgeRateLimit(ip, route, limitPerMin) {
  const now = Date.now();
  const key = `${ip}:${route}`;
  const entry = RATE_BUCKETS.get(key) || [];
  const fresh = entry.filter((t) => now - t < 60000);
  if (fresh.length >= limitPerMin) {
    RATE_BUCKETS.set(key, fresh);
    return false;
  }
  fresh.push(now);
  RATE_BUCKETS.set(key, fresh);
  return true;
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

    if (url.pathname === '/audit-receipt' && request.method === 'POST') {
      if (!checkEdgeRateLimit(ip, 'audit-receipt', 18)) {
        return jsonResponse({ error: 'Rate limit exceeded. Please wait a minute.' }, 429);
      }
      if (!env.GEMINI_API_KEY) {
        return jsonResponse({ error: 'Worker missing GEMINI_API_KEY secret.' }, 500);
      }

      let body;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: 'Invalid JSON body.' }, 400);
      }

      const rawBase64 = (body.imageBase64 || '').replace(/^data:image\/[a-zA-Z+]+;base64,/, '');
      const mimeType = body.mimeType || 'image/jpeg';
      if (!rawBase64) {
        return jsonResponse({ error: 'Missing imageBase64.' }, 400);
      }

      const prompt = `Extract receipt details for a reselling / side-hustle expense log.
Return ONLY valid JSON (no markdown fences) with this exact shape:
{
  "merchant": "Store or vendor name",
  "date": "YYYY-MM-DD or empty string",
  "total": 0.00,
  "category": "One of: Acquisition / Bid | Transportation / Gas | Supplies & Boxes | Platform Fees | Storage Rent | Other",
  "summaryTitle": "Short 3-6 word expense title like 'Home Depot - Boxes & Tape'",
  "lineItems": [{"name": "Item description", "qty": 1, "price": 0.00}]
}`;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 25000);
      try {
        const geminiRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env.GEMINI_API_KEY}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify({
              contents: [
                {
                  parts: [
                    { text: prompt },
                    { inline_data: { mime_type: mimeType, data: rawBase64 } },
                  ],
                },
              ],
              generationConfig: {
                temperature: 0.1,
                responseMimeType: 'application/json',
              },
            }),
          }
        );
        clearTimeout(timer);

        if (!geminiRes.ok) {
          const errText = await geminiRes.text();
          return jsonResponse({ error: 'Gemini API error', detail: errText.slice(0, 200) }, 502);
        }

        const data = await geminiRes.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
        const cleaned = text.replace(/^```json\s*|```$/g, '').trim();
        const parsed = JSON.parse(cleaned);
        return jsonResponse({ ok: true, receipt: parsed });
      } catch (err) {
        clearTimeout(timer);
        const msg = err.name === 'AbortError' ? 'Receipt OCR timed out after 25s.' : err.message;
        return jsonResponse({ error: msg }, 504);
      }
    }

    if (url.pathname === '/lookup-barcode' && request.method === 'GET') {
      if (!checkEdgeRateLimit(ip, 'lookup-barcode', 25)) {
        return jsonResponse({ error: 'Rate limit exceeded.' }, 429);
      }
      const code = (url.searchParams.get('code') || '').replace(/[^0-9A-Za-z-]/g, '');
      if (!code) return jsonResponse({ found: false }, 400);

      // 1. Optional KV cache check
      if (env.BB_CATALOG_DB) {
        try {
          const cached = await env.BB_CATALOG_DB.get(`barcode:${code}`, 'json');
          if (cached && cached.title) return jsonResponse({ found: true, ...cached, source: 'kv' });
        } catch {}
      }

      // 2. ISBN lookup via Open Library (books/media)
      if (/^(978|979)\d{10}$/.test(code) || /^\d{9}[0-9X]$/.test(code)) {
        try {
          const olRes = await fetch(`https://openlibrary.org/isbn/${code}.json`);
          if (olRes.ok) {
            const book = await olRes.json();
            if (book && book.title) {
              const payload = { title: book.title, brand: 'Book / ISBN', category: 'Media' };
              if (env.BB_CATALOG_DB) {
                env.BB_CATALOG_DB.put(`barcode:${code}`, JSON.stringify(payload)).catch(() => {});
              }
              return jsonResponse({ found: true, ...payload, source: 'openlibrary' });
            }
          }
        } catch {}
      }

      return jsonResponse({ found: false, code });
    }

    return jsonResponse({ ok: true, service: 'businessbuddies-worker', version: '1.0.0' });
  },
};
