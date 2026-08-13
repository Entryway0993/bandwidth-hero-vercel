import { parseSafeUrl } from './urlGuard.js';

const clampInt = (value, fallback, min, max) => {
  const n = parseInt(value, 10);
  return Number.isNaN(n) ? fallback : Math.min(Math.max(n, min), max);
};

const DEFAULT_QUALITY = clampInt(process.env.DEFAULT_QUALITY, 40, 10, 100);
const MAX_QUALITY = clampInt(process.env.MAX_QUALITY, 100, 10, 100);
const MIN_QUALITY = clampInt(process.env.MIN_QUALITY, 10, 1, 100);

// Normal images: cap max side.
const DEFAULT_MAX_OUTPUT_DIM = clampInt(process.env.MAX_OUTPUT_DIM, 2560, 0, 4096);

// Manga/manhwa/manhua long strips: cap width only.
const DEFAULT_MAX_STRIP_WIDTH = clampInt(process.env.MAX_STRIP_WIDTH, 1600, 0, 4096);

// 🛑 IMPORTANT:
// false = keep color for manhwa/manhua/normal images
// true  = grayscale by default, old bandwidth-hero behavior
const DEFAULT_GRAYSCALE = ['1', 'true', 'yes', 'on'].includes(
  String(process.env.DEFAULT_GRAYSCALE || process.env.DEFAULT_BW || '').trim().toLowerCase()
);

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

      // Use ?bw=1 for grayscale, ?bw=0 for color.
      grayscale: parseBoolean(req.query.bw, DEFAULT_GRAYSCALE),

      quality: parseQuality(
        req.query.l ?? req.query.q ?? req.query.quality,
        DEFAULT_QUALITY,
        MIN_QUALITY,
        MAX_QUALITY
      ),

      // Normal image max side cap.
      maxDim: clampInt(
        req.query.max_dim ?? req.query.maxdim ?? req.query.max,
        DEFAULT_MAX_OUTPUT_DIM,
        0,
        4096
      ),

      // Long manga/manhwa strip width cap.
      maxStripWidth: clampInt(
        req.query.strip_w ?? req.query.stripw ?? req.query.strip_width,
        DEFAULT_MAX_STRIP_WIDTH,
        0,
        4096
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
