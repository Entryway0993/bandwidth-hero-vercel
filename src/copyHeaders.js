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
      if (Array.isArray(value)) {
        const cleanValues = value
          .filter(v => v !== null && v !== undefined)
          .map(String);

        if (cleanValues.length > 0) {
          target.setHeader(key, cleanValues);
        }
      } else {
        target.setHeader(key, String(value));
      }
    } catch {
      // ignore invalid upstream headers
    }
  }

  try {
    target.setHeader('Cache-Control', 'no-store');
  } catch {
    // ignore
  }
}
