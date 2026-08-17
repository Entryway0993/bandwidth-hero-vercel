import { parseSafeUrl } from './urlGuard.js';

// 🛑 SURGICAL FIX: Module-level regex constants prevent V8 recompilation on every request.
const PROTOCOL_REGEX = /^https?:\/\//i;
const HIDDEN_URL_REGEX = /[?&]url=(.+?)(?:[&\s]|$)/;

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

    // 🛑 SURGICAL FIX: Lazy match preserves target URLs with their own query params.
    const urlMatch = authGarbage.match(HIDDEN_URL_REGEX);

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

    // 🛑 SURGICAL FIX: Use module-level compiled regex.
    if (!PROTOCOL_REGEX.test(url)) {
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

    // 🛑 THE DATA SAVER PROTOCOL (Android Automation)
    // Reads the standard Save-Data header sent by your Samsung Galaxy A73.
    const saveData = ['1', 'true', 'yes', 'on'].includes(
      String(req.headers['save-data'] || req.headers['sec-ch-save-data'] || '').toLowerCase()
    );

    const baseQuality = saveData ? Math.max(MIN_QUALITY, DEFAULT_QUALITY - 20) : DEFAULT_QUALITY;
    const baseMaxDim = saveData ? 1440 : DEFAULT_MAX_OUTPUT_DIM;
    const baseStripWidth = saveData ? 1080 : DEFAULT_MAX_STRIP_WIDTH;

    req.opts = {
      url: safeUrl.href,
      format: parseFormat(req),
      grayscale: parseBoolean(req.query.bw, DEFAULT_GRAYSCALE),
      quality: parseQuality(
        req.query.l ?? req.query.q ?? req.query.quality,
        baseQuality,
        MIN_QUALITY,
        MAX_QUALITY
      ),
      maxDim: clampInt(
        req.query.max_dim ?? req.query.maxdim ?? req.query.max,
        baseMaxDim,
        0,
        4096
      ),
      maxStripWidth: clampInt(
        req.query.strip_w ?? req.query.stripw ?? req.query.strip_width,
        baseStripWidth,
        0,
        4096
      )
    };

    const mode = String(req.query.mode || '').toLowerCase();

    if (mode === 'manga' || mode === 'comic') {
      req.opts.maxDim = req.opts.maxDim || baseMaxDim;
      req.opts.maxStripWidth = 0;
      if (req.query.sharpen === undefined) req.query.sharpen = '1';
      
    } else if (mode === 'strip' || mode === 'webtoon' || mode === 'manhwa' || mode === 'manhua') {
      req.opts.maxDim = 0; 
      req.opts.maxStripWidth = req.opts.maxStripWidth || baseStripWidth;
      if (req.query.sharpen === undefined) req.query.sharpen = '1';
      
    } else if (mode === 'photo' || mode === 'normal') {
      req.opts.maxDim = req.opts.maxDim || baseMaxDim;
      req.opts.maxStripWidth = 0;
      if (req.query.sharpen === undefined) req.query.sharpen = '0';
      
    } else if (mode === 'raw' || mode === 'bypass') {
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
