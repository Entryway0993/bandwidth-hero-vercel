import auth from 'basic-auth';
import crypto from 'crypto';

const { LOGIN, PASSWORD, API_KEY } = process.env;

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest();
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;

  return crypto.timingSafeEqual(sha256(a), sha256(b));
}

function getPathKey(req) {
  try {
    const firstSegment = req.path.split('/').filter(Boolean)[0];

    if (!firstSegment) return '';

    return decodeURIComponent(firstSegment);
  } catch {
    return '';
  }
}

export default function authenticate(req, res, next) {
  if (process.env.DISABLE_AUTH === '1') {
    return next();
  }

  const hasBasic = Boolean(LOGIN && PASSWORD);
  const hasApiKey = Boolean(API_KEY);

  if (!hasBasic && !hasApiKey) {
    return next();
  }

  if (hasApiKey) {
    const headerKey =
      req.get('x-api-key') ||
      (req.get('authorization')?.startsWith('Bearer ')
        ? req.get('authorization').slice(7)
        : '');

    const pathKey = getPathKey(req);

    if (headerKey && safeEqual(headerKey, API_KEY)) {
      return next();
    }

    if (pathKey && safeEqual(pathKey, API_KEY)) {
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
