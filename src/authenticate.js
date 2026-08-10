import auth from 'basic-auth';
import crypto from 'crypto';

const { LOGIN, PASSWORD, API_KEY } = process.env;

function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  
  if (bufferA.length !== bufferB.length) {
    crypto.timingSafeEqual(bufferB, bufferB);
    return false;
  }
  
  return crypto.timingSafeEqual(bufferA, bufferB);
}

export default function authenticate(req, res, next) {
  if (!LOGIN && !PASSWORD && !API_KEY) {
    console.error('🚨 CRITICAL: No authentication configured. Refusing to serve.');
    return res.status(500).json({
      error: 'Server misconfigured: Authentication is required.'
    });
  }
  
  // 1. Check Header API Key (Secure)
  const headerKey = req.headers['x-api-key'];
  if (API_KEY && headerKey && safeCompare(headerKey, API_KEY)) {
    return next();
  }
  
  // 2. Check Query String API Key (The Insecure Lobotomy for your phone app)
  let queryKey = req.query.api || req.query.apikey || req.query.api_key;
  
  // 🛑 SURGICAL FIX: Strip trailing slashes added by dumb app auto-tags
  if (typeof queryKey === 'string') {
    queryKey = queryKey.trim().replace(/\/$/, '');
  }
  
  if (API_KEY && queryKey && safeCompare(String(queryKey), API_KEY)) {
    return next();
  }
  
  // 3. Check Basic Auth
  if (LOGIN && PASSWORD) {
    const credentials = auth(req);
    if (
      credentials &&
      safeCompare(credentials.name, LOGIN) &&
      safeCompare(credentials.pass, PASSWORD)
    ) {
      return next();
    }
  }
  
  // 4. Fallback: Deny access
  if (LOGIN && PASSWORD) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Bandwidth-Hero Compression Service"');
  }
  
  return res.status(401).json({ error: 'Access denied. Provide valid Basic Auth or x-api-key header.' });
}