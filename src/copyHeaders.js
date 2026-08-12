const BLOCKED_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length',
  'content-encoding', 'content-type', 'authorization', 'cookie', 'set-cookie',
  'content-security-policy', 'content-security-policy-report-only',
  'strict-transport-security', 'access-control-allow-origin',
  'access-control-allow-methods', 'access-control-allow-headers',
  'access-control-expose-headers', 'cache-control', 'expires', 'pragma', 'location'
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
  
  try {
    target.setHeader('Cache-Control', 'private, no-store, must-revalidate');
    target.setHeader('Vary', 'Authorization, X-Api-Key, Cookie');
    target.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
  } catch {}
  
  for (const [key, value] of Object.entries(source.headers)) {
    const lowerKey = key.toLowerCase();
    if (BLOCKED_HEADERS.has(lowerKey)) continue;
    if (value === null || value === undefined) continue;
    try {
      target.setHeader(key, value);
    } catch {}
  }
}
