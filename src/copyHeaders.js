const BLOCKED_HEADERS = new Set([
  // Hop-by-hop / connection headers
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',

  // Request identity / auth / cookies
  'host',
  'authorization',
  'cookie',
  'set-cookie',
  'www-authenticate',

  // Body framing and content negotiation controlled by the proxy
  'content-length',
  'content-encoding',
  'content-type',
  'content-range',
  'accept-ranges',
  'vary',

  // Caching controlled by the proxy
  'cache-control',
  'expires',
  'pragma',
  'age',
  'etag',
  'last-modified',
  'alt-svc',

  // Redirect / download / metadata noise
  'location',
  'refresh',
  'link',
  'content-disposition',
  'server',
  'date',
  'server-timing',
  'timing-allow-origin',

  // Security policies controlled by the proxy
  'content-security-policy',
  'content-security-policy-report-only',
  'strict-transport-security',

  // CORS / cross-origin isolation controlled by the proxy
  'access-control-allow-origin',
  'access-control-allow-methods',
  'access-control-allow-headers',
  'access-control-expose-headers',
  'access-control-max-age',
  'access-control-allow-credentials',
  'cross-origin-embedder-policy',
  'cross-origin-opener-policy',
  'cross-origin-resource-policy',
  'origin-agent-cluster',

  // Misc dangerous or useless proxy noise
  'permissions-policy',
  'feature-policy',
  'report-to',
  'nel',
  'service-worker-allowed',
  'x-powered-by'
]);

export default function copyHeaders(source, target) {
  if (!source?.headers || !target || typeof target.setHeader !== 'function') {
    return;
  }

  const status = source.status ?? source.statusCode;

  if (Number.isInteger(status)) {
    if (typeof target.status === 'function') {
      target.status(status);
    } else {
      target.statusCode = status;
    }
  }

  // Copy allowed upstream headers first.
  for (const [key, value] of Object.entries(source.headers)) {
    const lowerKey = key.toLowerCase();

    if (BLOCKED_HEADERS.has(lowerKey)) continue;
    if (value === undefined || value === null) continue;

    try {
      target.setHeader(key, value);
    } catch {
      // Ignore invalid header errors.
    }
  }

  // Remove dangerous headers that may already exist on the target.
  if (typeof target.removeHeader === 'function') {
    for (const header of BLOCKED_HEADERS) {
      try {
        target.removeHeader(header);
      } catch {
        // Ignore removal errors.
      }
    }
  }

  // Set final controlled headers after upstream copy so they cannot be overwritten.
  try {
    target.setHeader('Cache-Control', 'private, no-store, must-revalidate');
    target.setHeader('Pragma', 'no-cache');
    target.setHeader('Expires', '0');

    target.setHeader('Content-Security-Policy', "default-src 'none'");

    target.setHeader('X-Content-Type-Options', 'nosniff');
    target.setHeader('X-Frame-Options', 'DENY');
    target.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

    // Required so browsers can load proxied images cross-origin.
    target.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  } catch {
    // Ignore final header errors.
  }
}
