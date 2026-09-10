import crypto from 'node:crypto';
import rateLimiter from './rateLimiter.js';

const { LOGIN, PASSWORD, API_KEY, VERCEL_SERVICE_KEY } = process.env;

// F5-MODIFIED: Legacy query auth toggle
const ALLOW_QUERY_API_KEY = ['1', 'true', 'yes', 'on'].includes(
  String(process.env.ALLOW_QUERY_API_KEY || 'true').trim().toLowerCase()
);

if (ALLOW_QUERY_API_KEY && API_KEY) {
  console.warn(
    '[AUTH WARNING] ALLOW_QUERY_API_KEY is enabled. Query-string API keys can leak into proxy logs, browser history, and referrers. Prefer x-api-key header auth.'
  );
}

const AUTH_FAILURE_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 60000;
const AUTH_FAILURE_MAX = parseInt(process.env.RATE_LIMIT_MAX_AUTH_FAILURES, 10) || 10;
const AUTH_RATE_LIMIT_SCOPE = 'auth-fail';

async function recordAuthFailure(key) {
  await rateLimiter.increment({
    scope: AUTH_RATE_LIMIT_SCOPE,
    key,
    windowMs: AUTH_FAILURE_WINDOW_MS,
    max: AUTH_FAILURE_MAX
  }).catch(() => {});
}

async function isAuthRateLimited(key) {
  try {
    const state = await rateLimiter.peek({
      scope: AUTH_RATE_LIMIT_SCOPE,
      key,
      windowMs: AUTH_FAILURE_WINDOW_MS
    });

    return state.count >= AUTH_FAILURE_MAX;
  } catch {
    return false;
  }
}

async function clearAuthFailure(key) {
  await rateLimiter.reset({
    scope: AUTH_RATE_LIMIT_SCOPE,
    key,
    windowMs: AUTH_FAILURE_WINDOW_MS
  }).catch(() => {});
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
  if (a.length === 0 || b.length === 0) return false;
  
  const hashA = crypto.createHash('sha256').update(a).digest();
  const hashB = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

export default async function authenticate(req, res, next) {
  if (!LOGIN && !PASSWORD && !API_KEY && !VERCEL_SERVICE_KEY) {
    console.error('🚨 CRITICAL: No authentication configured. Refusing to serve.');
    return res.status(500).json({
      error: 'Server misconfigured: Authentication is required.'
    });
  }

  // F5-MODIFIED: Prevent referer leakage of query keys
  res.setHeader('Referrer-Policy', 'no-referrer');

  // F6: Rate limit auth failures by IP to prevent bucket-churning via rotating fake keys.
  // Attackers can bypass per-key limits by sending a new invalid key per request.
  const clientIp = req.ip || req.socket?.remoteAddress || 'unknown';
  const clientKey = `ip:${clientIp}`;

  // F6: Rate limit auth failures
  if (await isAuthRateLimited(clientKey)) {
    return res.status(429).json({ error: 'Too many authentication failures. Try again later.' });
  }

  // 0. Check Internal Service Key (from Cloudflare Worker - F10 FIX)
  const serviceKey = req.headers['x-vercel-service-key'];
  if (VERCEL_SERVICE_KEY && serviceKey && safeCompare(serviceKey, VERCEL_SERVICE_KEY)) {
    await clearAuthFailure(clientKey);
    return next();
  }

  // 1. Check Header API Key (preferred)
  const headerKey = req.headers['x-api-key'];
  if (API_KEY && headerKey && safeCompare(headerKey, API_KEY)) {
    await clearAuthFailure(clientKey);
    return next();
  }

  // 2. Check Query String API Key (F5-MODIFIED: legacy support)
  if (ALLOW_QUERY_API_KEY) {
    let queryKey = req.query.api || req.query.apikey || req.query.api_key;

    if (typeof queryKey === 'string') {
      queryKey = queryKey.split(/[\/\?]/)[0].trim();
    }

    if (API_KEY && queryKey && safeCompare(String(queryKey), API_KEY)) {
      await clearAuthFailure(clientKey);
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
      await clearAuthFailure(clientKey);
      return next();
    }
  }

  // 4. Deny access
  await recordAuthFailure(clientKey);

  if (LOGIN && PASSWORD) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Bandwidth-Hero Compression Service"');
  }

  return res.status(401).json({ error: 'Access denied. Provide valid Basic Auth or x-api-key header.' });
}
