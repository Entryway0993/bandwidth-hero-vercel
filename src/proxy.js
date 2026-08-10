import got from 'got';
import { Agent } from 'node:https';
import { parseSafeUrl, safeLookup } from './urlGuard.js';
import shouldCompress from './shouldCompress.js';
import compress from './compress.js';
import copyHeaders from './copyHeaders.js';

const CLOUDFLARE_STATUS_CODES = new Set([403, 503]);

// 🛑 WAF EVASION: Force Chrome-like TLS Ciphers to bypass JA3 fingerprinting
const chromeCipherAgent = new Agent({
  ciphers: [
    'TLS_AES_128_GCM_SHA256',
    'TLS_AES_256_GCM_SHA384',
    'TLS_CHACHA20_POLY1305_SHA256',
    'ECDHE-ECDSA-AES128-GCM-SHA256',
    'ECDHE-RSA-AES128-GCM-SHA256',
    'ECDHE-ECDSA-AES256-GCM-SHA384',
    'ECDHE-RSA-AES256-GCM-SHA384'
  ].join(':'),
  minVersion: 'TLSv1.2',
  maxVersion: 'TLSv1.3'
});

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

export default async function proxy(req, res) {
  const targetUrl = req.opts.url;

  if (!targetUrl) {
    return res.status(400).json({ error: 'Missing URL parameter' });
  }

  const {
    cookie,
    referer,
    'user-agent': userAgent
  } = req.headers;

  const headers = {
    // 🛑 WAF EVASION: Desktop Masquerade
    'user-agent':
      userAgent ||
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.6613.113 Safari/537.36',
    accept:
      req.headers.accept ||
      'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
    'accept-encoding': 'gzip, deflate, br',
    'accept-language':
      req.headers['accept-language'] || 'en-US,en;q=0.9',
    'sec-fetch-dest': 'image',
    'sec-fetch-mode': 'no-cors',
    'sec-fetch-site': 'cross-site',
    'sec-ch-ua': '"Chromium";v="128", "Not;A=Brand";v="24", "Google Chrome";v="128"',
    'sec-ch-ua-mobile': '?0', // <--- 0 means NOT mobile
    'sec-ch-ua-platform': '"Windows"' // <--- Must match the Desktop UA
  };

  if (cookie) headers.cookie = cookie;
  if (referer) headers.referer = referer;

  const config = {
    headers,
    dnsLookup: safeLookup,
    // 🛑 WAF EVASION: Inject the custom TLS cipher agent
    agent: {
      https: chromeCipherAgent
    },
    timeout: {
      request: 15000,
      response: 20000
    },
    responseType: 'buffer',
    decompress: true,
    throwHttpErrors: false,
    followRedirect: true,
    retry: {
      limit: 0
    },
    hooks: {
      beforeRedirect: [
        (options) => {
          const redirectUrl = options?.url?.href || String(options?.url || '');

          if (!parseSafeUrl(redirectUrl)) {
            const error = new Error('SSRF_BLOCKED_REDIRECT');
            error.code = 'SSRF_BLOCKED_REDIRECT';
            throw error;
          }
        }
      ]
    }
  };

  try {
    const request = got(targetUrl, config);

    // 🛑 SURGICAL FIX: DEFUSE THE RAM BOMB (got v14 compatible)
    // Watches the download in real-time. If it exceeds 20MB, kill the connection instantly.
    request.on('downloadProgress', (progress) => {
      const size = progress.total > 0 ? progress.total : progress.transferred;
      if (size > 20 * 1024 * 1024) {
        request.destroy(new Error('BODY_TOO_LARGE'));
      }
    });

    const response = await request;

    const { statusCode, headers: responseHeaders } = response;

    const rawBody = toBuffer(response.rawBody ?? response.body);

    // Set security headers BEFORE the Cloudflare bypass so they are always applied
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('referrer-policy', 'strict-origin-when-cross-origin');
    res.setHeader('x-proxy-cache', 'MISS');

    if (CLOUDFLARE_STATUS_CODES.has(statusCode)) {
      return bypass(req, res, rawBody, statusCode);
    }

    let contentType = String(responseHeaders['content-type'] || '');

    if (!contentType.trim().toLowerCase().startsWith('image/')) {
      const detected = detectContentType(rawBody);

      if (detected.startsWith('image/')) {
        contentType = detected;
      }
    }

    delete responseHeaders['content-encoding'];
    delete responseHeaders['content-length'];

    copyHeaders({ headers: responseHeaders, status: statusCode }, res);

    if (contentType) {
      res.setHeader('Content-Type', contentType);
    }

    req.opts.originType = contentType;

    if (shouldCompress(req, rawBody)) {
      // 🛑 SURGICAL FIX: Await the async function to catch Sharp rejections
      await compress(req, res, rawBody);
      return;
    }

    return bypass(req, res, rawBody, statusCode);
  } catch (error) {
    // 🛑 LOG SANITIZER: Strip potential tokens from error messages
    const safeMessage = error.message?.replace(/https?:\/\/[^\s]+/g, '[REDACTED_URL]') || 'Unknown error';
    console.error(`❌ Proxy request failed: ${safeMessage}`);

    // 🛑 SURGICAL FIX: Materialize the phantom variable
    const code = error.code;

    if (code === 'SSRF_BLOCKED_REDIRECT' || code === 'SSRF_BLOCKED_DNS') {
      return res.status(403).json({ error: 'Blocked by SSRF guard' });
    }

    if (code === 'ERR_BODY_LARGE' || code === 'BODY_TOO_LARGE') {
      console.warn('⚠️ File too large'); // Removed targetUrl to prevent leaking tokens
      return res.status(413).send('File too large');
    }

    if (code === 'ETIMEDOUT' || code === 'ERR_GOT_REQUEST_TIMEOUT') {
      return res.status(504).json({ error: 'Origin request timed out' });
    }

    console.error(`❌ Proxy request failed: ${error.message}`); // Removed targetUrl

    return res.status(502).json({ error: 'Proxy request failed' });
  }
}