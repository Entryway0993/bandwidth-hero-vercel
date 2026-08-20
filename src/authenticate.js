import crypto from 'node:crypto';

const { LOGIN, PASSWORD, API_KEY } = process.env;

// F5-MODIFIED: Legacy query auth toggle
const ALLOW_QUERY_API_KEY = ['1', 'true', 'yes', 'on'].includes(
  String(process.env.ALLOW_QUERY_API_KEY || 'true').trim().toLowerCase()
);

// F6: In-memory auth failure throttle
const AUTH_FAILURES = new Map();
const AUTH_FAILURE_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 60000;
const AUTH_FAILURE_MAX = parseInt(process.env.RATE_LIMIT_MAX_AUTH_FAILURES, 10) || 10;

function recordAuthFailure(key) {
  const now = Date.now();
  const entry = AUTH_FAILURES.get(key) || { count: 0, windowStart: now };

  if (now - entry.windowStart > AUTH_FAILURE_WINDOW_MS) {
    entry.count = 0;
    entry.windowStart = now;
  }

  entry.count++;
  AUTH_FAILURES.set(key, entry);

  if (AUTH_FAILURES.size > 1000) {
    const oldest = AUTH_FAILURES.keys().next().value;
    if (oldest !== undefined) AUTH_FAILURES.delete(oldest);
  }

  return entry.count;
}

function isAuthRateLimited(key) {
  const entry = AUTH_FAILURES.get(key);
  if (!entry) return false;

  const now = Date.now();
  if (now - entry.windowStart > AUTH_FAILURE_WINDOW_MS) {
    AUTH_FAILURES.delete(key);
    return false;
  }

  return entry.count >= AUTH_FAILURE_MAX;
}

function clearAuthFailure(key) {
  AUTH_FAILURES.delete(key);
}

function parseBasicAuth(req) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Basic ')) return undefined;

  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const colonIndex = decoded.indexOf(':');

    if (colonIndex === -1) return undefined;

    return {
      name: decoded.slice(0, colonIndex),
      pass: decoded.slice(colonIndex + 1)
    };
  } catch {
    return undefined;
  }
}

function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const hashA = crypto.createHash('sha256').update(a).digest();
  const hashB = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

export default function authenticate(req, res, next) {
  if (!LOGIN && !PASSWORD && !API_KEY) {
    console.error('🚨 CRITICAL: No authentication configured. Refusing to serve.');
    return res.status(500).json({
      error: 'Server misconfigured: Authentication is required.'
    });
  }

  // F5-MODIFIED: Prevent referer leakage of query keys
  res.setHeader('Referrer-Policy', 'no-referrer');

  const clientKey = req.headers['x-api-key'] ||
    req.query.api || req.query.apikey || req.query.api_key ||
    req.ip || 'unknown';

  // F6: Rate limit auth failures
  if (isAuthRateLimited(clientKey)) {
    return res.status(429).json({ error: 'Too many authentication failures. Try again later.' });
  }

  // 1. Check Header API Key (preferred)
  const headerKey = req.headers['x-api-key'];
  if (API_KEY && headerKey && safeCompare(headerKey, API_KEY)) {
    clearAuthFailure(clientKey);
    return next();
  }

  // 2. Check Query String API Key (F5-MODIFIED: legacy support)
  if (ALLOW_QUERY_API_KEY) {
    let queryKey = req.query.api || req.query.apikey || req.query.api_key;

    if (typeof queryKey === 'string') {
      queryKey = queryKey.split(/[\/\?]/)[0].trim();
    }

    if (API_KEY && queryKey && safeCompare(String(queryKey), API_KEY)) {
      clearAuthFailure(clientKey);
      return next();
    }
  }

  // 3. Check Basic Auth
  if (LOGIN && PASSWORD) {
    const credentials = parseBasicAuth(req);
    if (
      credentials &&
      safeCompare(credentials.name, LOGIN) &&
      safeCompare(credentials.pass, PASSWORD)
    ) {
      clearAuthFailure(clientKey);
      return next();
    }
  }

  // 4. Deny access
  recordAuthFailure(clientKey);

  if (LOGIN && PASSWORD) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Bandwidth-Hero Compression Service"');
  }

  return res.status(401).json({ error: 'Access denied. Provide valid Basic Auth or x-api-key header.' });
}
