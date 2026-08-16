import { parseSafeUrl } from './urlGuard.js';

const clampInt = (value, fallback, min, max) => {
  const n = parseInt(value, 10);
  return Number.isNaN(n) ? fallback : Math.min(Math.max(n, min), max);
};

const DEFAULT_QUALITY = clampInt(process.env.DEFAULT_QUALITY, 40, 10, 100);
const MAX_QUALITY = clampInt(process.env.MAX_QUALITY, 100, 10, 100);
const MIN_QUALITY = clampInt(process.env.MIN_QUALITY, 10, 1, 100);

const DEFAULT_MAX_OUTPUT_DIM = clampInt(process.env.MAX_OUTPUT_DIM, 2560, 0, 4096);
const DEFAULT_MAX_STRIP_WIDTH = clampInt(process.env.MAX_STRIP_WIDTH, 1600, 0, 4096);

const DEFAULT_GRAYSCALE = ['1', 'true', 'yes', 'on'].includes(
  String(process.env.DEFAULT_GRAYSCALE || process.env.DEFAULT_BW || '').trim().toLowerCase()
);

const ALLOW_ACCEPT_FALLBACK = ['1', 'true', 'yes', 'on'].includes(
  String(process.env.ALLOW_ACCEPT_FALLBACK || '').trim().toLowerCase()
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
  if (parseBoolean(req.query.jpeg, false)) return 'jpeg';
  if (parseBoolean(req.query.avif, false)) return 'avif';
  if (parseBoolean(req.query.webp, false)) return 'webp';

  if (ALLOW_ACCEPT_FALLBACK) {
    const accept = String(req.headers.accept || '').toLowerCase();
    
    if (!accept || accept === '*/*' || accept.includes('*/*')) return 'avif';
    
    if (accept.includes('image/avif')) return 'avif';
    if (accept.includes('image/webp')) return 'webp';
    
    return 'jpeg';
  }

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
      grayscale: parseBoolean(req.query.bw, DEFAULT_GRAYSCALE),
      quality: parseQuality(
        req.query.l ?? req.query.q ?? req.query.quality,
        DEFAULT_QUALITY,
        MIN_QUALITY,
        MAX_QUALITY
      ),
      maxDim: clampInt(
        req.query.max_dim ?? req.query.maxdim ?? req.query.max,
        DEFAULT_MAX_OUTPUT_DIM,
        0,
        4096
      ),
      maxStripWidth: clampInt(
        req.query.strip_w ?? req.query.stripw ?? req.query.strip_width,
        DEFAULT_MAX_STRIP_WIDTH,
        0,
        4096
      )
    };

    // 🛑 THE PROFILE INJECTION
    // The client sends one word. The proxy rewrites the physics.
    const mode = String(req.query.mode || '').toLowerCase();

    if (mode === 'manga' || mode === 'comic') {
      // Standard manga pages. Cap side, force sharpen.
      req.opts.maxDim = req.opts.maxDim || DEFAULT_MAX_OUTPUT_DIM;
      req.opts.maxStripWidth = 0; // Disable strip logic
      if (req.query.sharpen === undefined) req.query.sharpen = '1';
      
    } else if (mode === 'strip' || mode === 'webtoon' || mode === 'manhwa' || mode === 'manhua') {
      // Long vertical strips. Disable side cap, cap width, force sharpen.
      req.opts.maxDim = 0; 
      req.opts.maxStripWidth = req.opts.maxStripWidth || DEFAULT_MAX_STRIP_WIDTH;
      if (req.query.sharpen === undefined) req.query.sharpen = '1';
      
    } else if (mode === 'photo' || mode === 'normal') {
      // Normal photos. Cap side, disable sharpen to save CPU.
      req.opts.maxDim = req.opts.maxDim || DEFAULT_MAX_OUTPUT_DIM;
      req.opts.maxStripWidth = 0;
      if (req.query.sharpen === undefined) req.query.sharpen = '0';
      
    } else if (mode === 'raw' || mode === 'bypass') {
      // No resizing. Pass straight to encoder.
      req.opts.maxDim = 0;
      req.opts.maxStripWidth = 0;
      req.query.sharpen = '0';
    }

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
