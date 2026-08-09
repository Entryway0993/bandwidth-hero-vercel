  import { parseSafeUrl } from './urlGuard.js';
  
  const clampInt = (value, fallback, min, max) => {
    const n = parseInt(value, 10);
    return Number.isNaN(n) ? fallback : Math.min(Math.max(n, min), max);
  };
  
  const DEFAULT_QUALITY = clampInt(process.env.DEFAULT_QUALITY, 40, 10, 100);
  const MAX_QUALITY = clampInt(process.env.MAX_QUALITY, 100, 10, 100);
  const MIN_QUALITY = clampInt(process.env.MIN_QUALITY, 10, 1, 100);
  
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
  
  function params(req, res, next) {
    try {
      let { url } = req.query;
  
      if (!url) {
        return res.status(200).send('bandwidth-hero-proxy');
      }
  
      if (Array.isArray(url)) {
        url = url.filter(u => u && u.trim()).pop() || url[0];
      }
  
      if (!url) {
        return res.status(400).json({
          error: 'Missing URL.'
        });
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
        webp: !parseBoolean(req.query.jpeg, false),
        grayscale: parseBoolean(req.query.bw, true),
        quality: parseQuality(
          req.query.l ?? req.query.q ?? req.query.quality,
          DEFAULT_QUALITY,
          MIN_QUALITY,
          MAX_QUALITY
        ),
        maxWidth: 0
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
