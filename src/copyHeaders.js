const BLOCKED_HEADERS = new Set([
  // hop-by-hop
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',

  // body/encoding conflicts
  'host',
  'content-length',
  'content-encoding',
  'content-type',

  // auth/session leakage
  'authorization',
  'cookie',
  'set-cookie',

  // upstream security/CORS policy leakage
  'content-security-policy',
  'content-security-policy-report-only',
  'strict-transport-security',
  'access-control-allow-origin',
  'access-control-allow-methods',
  'access-control-allow-headers',
  'access-control-expose-headers',

  // caching/redirect interference
  'cache-control',
  'expires',
  'pragma',
  'location'
]);

export default function copyHeaders(source, target) {
  if (!source?.headers || !target) return;

  const status = source.status || source.statusCode;

  if (status && Number.isInteger(status)) {
    if (typeof target.status === 'function') {
      target.status(status);
    } else {
      target.statusCode = status;
    }
  }

  for (const [key, value] of Object.entries(source.headers)) {
    const lowerKey = key.toLowerCase();

    if (BLOCKED_HEADERS.has(lowerKey)) continue;
    if (value === null || value === undefined) continue;

    try {
    // 🛑 PHASE 4 FIX: IMMUTABLE EDGE CACHING
    // Cache for 1 year. Vercel Edge will serve this instantly for free.
    target.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    
    // CRITICAL: Isolate the cache by Auth headers.
    // This forces the CDN to cache a separate version for every unique API Key.
    // Without this, User B could get a cached private image requested by User A.
    target.setHeader('Vary', 'Authorization, X-Api-Key');
  } catch {
    // ignore
  }
 }
}