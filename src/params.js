import { parseSafeUrl } from './urlGuard.js';

const clampInt = (value, fallback, min, max) => {
  const n = parseInt(value, 10);
  return Number.isNaN(n) ? fallback : Math.min(Math.max(n, min), max);
};

const DEFAULT_QUALITY = clampInt(process.env.DEFAULT_QUALITY, 40, 10, 100);
const MAX_QUALITY = clampInt(process.env.MAX_QUALITY, 100, 10, 100);
const MIN_QUALITY = clampInt(process.env.MIN_QUALITY, 10, 1, 100);

const AUTH_PARAMS = [
  'api',
  'apikey',
  'api_key'
];

function parseBoolean(value, defaultValue) {
  if (value === undefined) return defaultValue;

  const str = String(value).trim().toLowerCase();

  if (['1', 'true', 'yes', 'on'].includes(str)) return true;
  if (['0', 'false', 'no', 'off'].includes(str)) return false;

  return defaultValue;
}

function parseQuality(q, defaultValue, min, max) {
  const n = parseInt(q, 10);

  if (Number.isNaN(n)) return defaultValue;
  if (n < min) return min;
  if (n > max) return max;

  return n;
}

function parseFormat(req) {
  // Emergency escape hatch.
  if (parseBoolean(req.query.jpeg, false)) return 'jpeg';

  // Explicit overrides.
  if (parseBoolean(req.query.avif, false)) return 'avif';
  if (parseBoolean(req.query.webp, false)) return 'webp';

  // Forced AVIF default.
  return 'avif';
}

function extractHiddenUrl(req) {
  for (const param of AUTH_PARAMS) {
    const value = req.query[param];

    if (value === undefined || value === null || value === '') {
      continue;
    }

    const authGarbage = Array.isArray(value)
      ? String(value[0] || '')
      : String(value);

    const urlMatch = authGarbage.match(/[?&]url=([^&]+)/);

    if (urlMatch) {
      try {
        return decodeURIComponent(urlMatch[1]);
      } catch {
        return null;
      }
    }
  }

  return undefined;
}

function params(req, res, next) {
  try {
    let { url } = req.query;

    // Recover URL if the dumb client swallowed it into an auth param.
    if (!url) {
      const hiddenUrl = extractHiddenUrl(req);

      if (hiddenUrl === null) {
        return res.status(400).json({ error: 'Malformed URL encoding.' });
      }

      if (hiddenUrl) {
        url = hiddenUrl;
      }
    }

    if (url === undefined || url === null || url === '') {
      return res.status(200).send('bandwidth-hero-proxy');
    }

    if (Array.isArray(url)) {
      return res.status(400).json({ error: 'Multiple URL parameters are not allowed.' });
    }

    if (typeof url !== 'string') {
      return res.status(400).json({ error: 'Invalid URL parameter.' });
    }

    url = url.trim();

    if (!url) {
      return res.status(200).send('bandwidth-hero-proxy');
    }

    if (!/^https?:\/\//i.test(url)) {
      return res.status(400).json({
        error: 'Invalid URL. Must include protocol (http or https).'
      });
    }

    const safeUrl = parseSafeUrl(url);

    if (!safeUrl) {
      return res.status(403).json({
        error: 'Blocked or invalid URL.'
      });
    }

    req.opts = {
      url: safeUrl.href,
      format: parseFormat(req),
      grayscale: parseBoolean(req.query.bw, true),
      quality: parseQuality(
        req.query.l ?? req.query.q ?? req.query.quality,
        DEFAULT_QUALITY,
        MIN_QUALITY,
        MAX_QUALITY
      )
    };

    return next();
  } catch (err) {
    console.error('[Params Middleware Error]', err);

    if (!res.headersSent) {
      res.status(500).json({
        error: 'Internal server error in params middleware.'
      });
    }
  }
}

export default params;
