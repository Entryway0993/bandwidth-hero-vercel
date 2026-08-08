import got from 'got';
import shouldCompress from './shouldCompress.js';
import compress from './compress.js';
import copyHeaders from './copyHeaders.js';
import { parseSafeUrl, safeLookup } from './urlGuard.js';

const CLOUDFLARE_STATUS_CODES = new Set([403, 503]);
const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 3;

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === 'string') return Buffer.from(value);
  return Buffer.alloc(0);
}

function bypass(req, res, rawBody, statusCode = 200) {
  if (!res.headersSent) {
    res.status(statusCode);
  }

  res.end(rawBody);
}

function detectContentType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 2) {
    return 'application/octet-stream';
  }

  if (
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return 'image/jpeg';
  }

  if (
    buffer.length >= 4 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return 'image/png';
  }

  if (
    buffer.length >= 4 &&
    buffer[0] === 0x47 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x38
  ) {
    return 'image/gif';
  }

  if (buffer[0] === 0x42 && buffer[1] === 0x4d) {
    return 'image/bmp';
  }

  if (
    buffer.length >= 12 &&
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }

  if (
    buffer.length >= 12 &&
    buffer.subarray(4, 8).toString('ascii') === 'ftyp'
  ) {
    const brand = buffer.subarray(8, 12).toString('ascii');

    if (brand === 'avif' || brand === 'avis') {
      return 'image/avif';
    }
  }

  return 'application/octet-stream';
}

async function fetchSafe(targetUrl, config) {
  let currentUrl = targetUrl;

  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const parsed = parseSafeUrl(currentUrl);

    if (!parsed) {
      const error = new Error('SSRF_BLOCKED');
      error.code = 'SSRF_BLOCKED';
      throw error;
    }

    const response = await got(parsed.href, {
      ...config,
      followRedirect: false
    });

    const { statusCode, headers } = response;

    const location = Array.isArray(headers.location)
      ? headers.location[0]
      : headers.location;

    if (REDIRECT_STATUS_CODES.has(statusCode) && location) {
      currentUrl = new URL(String(location), parsed.href).toString();
      continue;
    }

    return response;
  }

  const error = new Error('TOO_MANY_REDIRECTS');
  error.code = 'TOO_MANY_REDIRECTS';
  throw error;
}

export default async function proxy(req, res) {
  const targetUrl = req.opts.url;

  if (!targetUrl) {
    return res.status(400).json({ error: 'Missing URL parameter' });
  }

  const {
    cookie,
    referer,
    authorization,
    'user-agent': userAgent
  } = req.headers;

  const headers = {
    'user-agent':
      userAgent ||
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/128 Safari/537.36',
    accept:
      req.headers.accept ||
      'image/avif,image/webp,image/*;q=0.8,*/*;q=0.5',
    'accept-encoding': 'gzip, deflate, br',
    'accept-language':
      req.headers['accept-language'] || 'en-US,en;q=0.9'
  };

  if (cookie) headers.cookie = cookie;
  if (referer) headers.referer = referer;
  if (authorization) headers.authorization = authorization;

  const config = {
    headers,
    timeout: {
      request: 15000,
      response: 20000
    },
    responseType: 'buffer',
    decompress: true,
    throwHttpErrors: false,
    lookup: safeLookup,
    http2: false,
    followRedirect: false,
    retry: {
      limit: 0
    }
  };

  try {
    const response = await fetchSafe(targetUrl, config);

    const { statusCode, headers } = response;

    const rawBody = toBuffer(response.rawBody ?? response.body);

    if (CLOUDFLARE_STATUS_CODES.has(statusCode)) {
      return bypass(req, res, rawBody, statusCode);
    }

    let contentType = String(headers['content-type'] || '');

    if (!contentType.trim().toLowerCase().startsWith('image/')) {
      const detected = detectContentType(rawBody);

      if (detected.startsWith('image/')) {
        contentType = detected;
      }
    }

    delete headers['content-encoding'];
    delete headers['content-length'];

    copyHeaders({ headers, status: statusCode }, res);

    if (contentType) {
      res.setHeader('Content-Type', contentType);
    }

    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('referrer-policy', 'strict-origin-when-cross-origin');
    res.setHeader('x-proxy-cache', 'MISS');

    req.opts.originType = contentType;
    req.opts.originSize = rawBody.length;

    if (shouldCompress(req, rawBody)) {
      return compress(req, res, rawBody);
    }

    return bypass(req, res, rawBody, statusCode);
  } catch (error) {
    if (
      error.code === 'SSRF_BLOCKED' ||
      error.code === 'SSRF_BLOCKED_DNS' ||
      String(error.message || '').includes('SSRF_BLOCKED_DNS')
    ) {
      return res.status(403).json({ error: 'Forbidden: internal address' });
    }

    if (
      error.code === 'ERR_BODY_LARGE' ||
      error.code === 'BODY_TOO_LARGE'
    ) {
      console.warn(`⚠️ File too large: ${targetUrl}`);
      return res.status(413).send('File too large');
    }

    if (
      error.code === 'ETIMEDOUT' ||
      error.code === 'ERR_GOT_REQUEST_TIMEOUT'
    ) {
      return res.status(504).json({ error: 'Origin request timed out' });
    }

    console.error(
      `❌ Proxy request failed: ${error.message} (${targetUrl})`
    );

    return res.status(502).json({ error: 'Proxy request failed' });
  }
    }
