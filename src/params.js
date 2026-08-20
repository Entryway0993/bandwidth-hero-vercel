import { parseSafeUrl } from './urlGuard.js';

const PROTOCOL_REGEX = /^https?:\/\//i;

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

// F12-MODIFIED: raw/bypass removed
const ALLOWED_MODES = new Set([
  'auto',
  'photo',
  'normal',
  'manga',
  'comic',
  'strip',
  'webtoon',
  'manhwa',
  'manhua'
]);

// F13-MODIFIED: Safe rotation increments only
const SAFE_ROTATIONS = new Set([90, 180, 270]);

function parseBoolean(value, defaultValue) {
  if (Array.isArray(value)) {
    value = value[0];
  }

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

// F13-MODIFIED: Parse safe rotation
function parseRotation(value) {
  const n = parseInt(value, 10);
  if (SAFE_ROTATIONS.has(n)) return n;
  return 0;
}

function parseFormat(req) {
  if (parseBoolean(req.query.jpeg, false)) return 'jpeg';
  if (parseBoolean(req.query.avif, false)) return 'avif';
  if (parseBoolean(req.query.webp, false)) return 'webp';

  if (ALLOW_ACCEPT_FALLBACK) {
    const accept = String(req.headers.accept || '').toLowerCase();
    const wantsJpeg = accept.includes('image/jpeg');
    const wantsWebp = accept.includes('image/webp');
    const wantsAvif = accept.includes('image/avif');
    const isWildcard = !accept || accept === '*/*' || accept.includes('*/*');

    if (wantsJpeg && !wantsAvif && !wantsWebp && !isWildcard) return 'jpeg';
    if (wantsWebp && !wantsAvif) return 'webp';

    return 'avif';
  }

  return 'avif';
}

function extractHiddenUrlFromRaw(req) {
  const rawUrl = req.originalUrl || req.url || '';
  const qIndex = rawUrl.indexOf('?');
  if (qIndex === -1) return undefined;

  const rawQuery = rawUrl.slice(qIndex + 1);

  const match = rawQuery.match(/(?:^|[?&])url=(.+)$/);

  if (match) {
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  }

  return undefined;
}

function params(req, res, next) {
  try {
    let { url } = req.query;

    // F16: removed unreachable hiddenUrl === null check
    if (!url) {
      const hiddenUrl = extractHiddenUrlFromRaw(req);

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
      ),
      // F13-MODIFIED: safe rotation
      rotate: parseRotation(req.query.rotate)
    };

    // F12-MODIFIED: Normalize mode, raw/bypass treated as auto
    const rawMode = Array.isArray(req.query.mode) ? req.query.mode[0] : req.query.mode;
    const modeInput = String(rawMode || '').toLowerCase();
    const mode = ALLOWED_MODES.has(modeInput) ? modeInput : 'auto';

    let sharpenDefault;

    if (
      mode === 'manga' ||
      mode === 'comic' ||
      mode === 'strip' ||
      mode === 'webtoon' ||
      mode === 'manhwa' ||
      mode === 'manhua'
    ) {
      sharpenDefault = true;
    } else if (
      mode === 'photo' ||
      mode === 'normal'
    ) {
      sharpenDefault = false;
    } else {
      sharpenDefault = undefined;
    }

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
    }

    req.opts.mode = mode;
    req.opts.sharpen = parseBoolean(req.query.sharpen, sharpenDefault);

    return next();
  } catch (err) {
    const safeMessage = err?.message ? String(err.message).split('?')[0] : 'Unknown error';
    console.error('[Params Middleware Error]', safeMessage);

    if (!res.headersSent) {
      res.status(500).json({
        error: 'Internal server error in params middleware.'
      });
    }
  }
}

export default params;
