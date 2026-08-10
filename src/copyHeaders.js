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
  
  // 🛑 SURGICAL FIX: IMMUTABLE EDGE CACHING & XSS SHIELD
  // Applied ONCE, outside the loop, to stop the CPU bleeding.
  try {
    target.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    target.setHeader('Vary', 'Authorization, X-Api-Key');
    target.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
  } catch {
    // ignore
  }
  
  for (const [key, value] of Object.entries(source.headers)) {
    const lowerKey = key.toLowerCase();
    
    if (BLOCKED_HEADERS.has(lowerKey)) continue;
    if (value === null || value === undefined) continue;
    
    try {
      // 🛑 SURGICAL FIX: Actually copy the surviving whitelisted upstream headers
      target.setHeader(key, value);
    } catch {
      // ignore invalid header errors from Express
    }
  }
}