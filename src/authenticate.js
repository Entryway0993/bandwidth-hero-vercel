import auth from 'basic-auth';
import crypto from 'crypto';

const { LOGIN, PASSWORD, API_KEY, NODE_ENV } = process.env;

function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  
  // Prevent timing attacks on length differences
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(Buffer.from('a'.repeat(32)), Buffer.from('b'.repeat(32)));
    return false;
  }
  
  return crypto.timingSafeEqual(bufA, bufB);
}

export default function authenticate(req, res, next) {
  const hasBasic = Boolean(LOGIN && PASSWORD);
  const hasApiKey = Boolean(API_KEY);

  // Fail closed in production if no auth is configured
  if (!hasBasic && !hasApiKey) {
    if (NODE_ENV === 'production') {
      return res.status(500).json({ error: 'Auth not configured' });
    }
    return next();
  }

  // 1. API Key (Header ONLY - Never path)
  if (hasApiKey) {
    const headerKey = req.headers['x-api-key'];
    if (headerKey && safeCompare(headerKey, API_KEY)) {
      return next();
    }
  }

  // 2. Basic Auth
  if (hasBasic) {
    const credentials = auth(req);
    if (
      credentials &&
      safeCompare(credentials.name, LOGIN) &&
      safeCompare(credentials.pass, PASSWORD)
    ) {
      return next();
    }
  }

  res.setHeader('WWW-Authenticate', 'Basic realm="Bandwidth-Hero"');
  return res.status(401).json({ error: 'Access denied' });
}
