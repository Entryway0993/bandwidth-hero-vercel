import auth from 'basic-auth';
import crypto from 'crypto';

const { LOGIN, PASSWORD, API_KEY, NODE_ENV } = process.env;

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest();
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;

  return crypto.timingSafeEqual(sha256(a), sha256(b));
}

export default function authenticate(req, res, next) {
  const hasBasic = Boolean(LOGIN && PASSWORD);
  const hasApiKey = Boolean(API_KEY);

  if (!hasBasic && !hasApiKey) {
    if (NODE_ENV === 'production') {
      return res.status(500).json({ error: 'Auth not configured' });
    }

    return next();
  }

  if (hasApiKey) {
    const headerKey =
      req.get('x-api-key') ||
      (req.get('authorization')?.startsWith('Bearer ')
        ? req.get('authorization').slice(7)
        : '');

    if (headerKey && safeEqual(headerKey, API_KEY)) {
      return next();
    }
  }

  if (hasBasic) {
    const credentials = auth(req);

    if (
      credentials &&
      safeEqual(credentials.name, LOGIN) &&
      safeEqual(credentials.pass, PASSWORD)
    ) {
      return next();
    }
  }

  res.setHeader('WWW-Authenticate', 'Basic realm="Bandwidth-Hero"');

  return res.status(401).json({ error: 'Access denied' });
}
