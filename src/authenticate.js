import auth from 'basic-auth';
import crypto from 'crypto';

const { LOGIN, PASSWORD, API_KEY } = process.env;

function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  
  // Length check prevents timingSafeEqual from crashing, 
  // though it does leak the length of the secret (acceptable for API keys).
  if (bufferA.length !== bufferB.length) return false;
  
  return crypto.timingSafeEqual(bufferA, bufferB);
}

export default function authenticate(req, res, next) {
  // If absolutely no auth is configured, skip (preserves original behavior, but dangerous)
  if (!LOGIN && !PASSWORD && !API_KEY) return next();
  
  // 🛑 FIX 1: Check Header API Key (Secure, won't be logged in URLs)
  const headerKey = req.headers['x-api-key'];
  if (API_KEY && headerKey && safeCompare(headerKey, API_KEY)) {
    return next();
  }
  
  // 🛑 FIX 2: Check Basic Auth (Only if credentials are actually configured)
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
  
  // 3. Fallback: Deny access
  if (LOGIN && PASSWORD) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Bandwidth-Hero Compression Service"');
  }
  
  return res.status(401).json({ error: 'Access denied. Provide valid Basic Auth or x-api-key header.' });
}