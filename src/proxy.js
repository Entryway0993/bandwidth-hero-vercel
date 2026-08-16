import got from 'got';
import { Agent } from 'node:https';
import sharp from 'sharp';
import { parseSafeUrl, safeLookup } from './urlGuard.js';
import shouldCompress from './shouldCompress.js';
import compress from './compress.js';
import copyHeaders from './copyHeaders.js';

const UPSTREAM_ACCEPT_ENCODING = process.env.UPSTREAM_ACCEPT_ENCODING || 'identity';
const MAX_DOWNLOAD_BYTES = parseInt(process.env.MAX_DOWNLOAD_BYTES, 10) || (20 * 1024 * 1024);
const REQUEST_TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT_MS, 10) || 45000;

const CLOUDFLARE_STATUS_CODES = new Set([403, 503]);

const chromeCipherAgent = new Agent({
  ciphers: [
    'TLS_AES_128_GCM_SHA256', 'TLS_AES_256_GCM_SHA384', 'TLS_CHACHA20_POLY1305_SHA256',
    'ECDHE-ECDSA-AES128-GCM-SHA256', 'ECDHE-RSA-AES128-GCM-SHA256',
    'ECDHE-ECDSA-AES256-GCM-SHA384', 'ECDHE-RSA-AES256-GCM-SHA384'
  ].join(':'),
  minVersion: 'TLSv1.2',
  maxVersion: 'TLSv1.3'
});

const UA_POOL = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:145.0) Gecko/20100101 Firefox/145.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 15; SM-A736B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36 Edg/147.0.0.0'
];

function getRandomUA() {
  return UA_POOL[Math.floor(Math.random() * UA_POOL.length)];
}

const GHOST_WEBP = await sharp({
  create: { width: 200, height: 200, channels: 3, background: { r: 35, g: 35, b: 40 } }
}).webp({ quality: 10, effort: 1 }).toBuffer();

function sendGhost(res, cacheSeconds = 3600) {
  if (!res.headersSent) {
    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('Cache-Control', `public, max-age=${cacheSeconds}`);
    res.setHeader('x-ghost', 'true');
    res.status(200).end(GHOST_WEBP);
  }
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === 'string') return Buffer.from(value);
  return Buffer.alloc(0);
}

function bypass(req, res, rawBody, statusCode = 200) {
  if (!res.headersSent) res.status(statusCode);
  res.end(rawBody);
}

function detectContentType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 2) return 'application/octet-stream';

  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 4 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png';
  if (buffer.length >= 4 && buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) return 'image/gif';
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) return 'image/bmp';
  if (buffer.length >= 6 && buffer[0] === 0x00 && buffer[1] === 0x00 && buffer[2] === 0x01 && buffer[3] === 0x00) return 'image/x-icon';
  if (buffer.length >= 12 && buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = buffer.subarray(8, 12).toString('ascii');
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
  }

  return 'application/octet-stream';
}

// 🛑 FETCH EXECUTOR (Tracks download size to prevent RAM bombs)
function executeFetch(url, cfg) {
  const request = got(url, cfg);
  request.on('downloadProgress', (progress) => {
    const size = Math.max(progress.total || 0, progress.transferred || 0);
    if (size > MAX_DOWNLOAD_BYTES) {
      request.destroy(new Error('BODY_TOO_LARGE'));
    }
  });
  return request;
}

export default async function proxy(req, res) {
  let targetUrl = req.opts?.url || req.query?.url;

  if (Array.isArray(targetUrl)) {
    targetUrl = targetUrl.find(u => u && typeof u === 'string') || String(targetUrl[0]);
  }

  if (!targetUrl || typeof targetUrl !== 'string') {
    return sendGhost(res, 60);
  }

  targetUrl = targetUrl.trim();
  if (!targetUrl.startsWith('http')) targetUrl = 'https://' + targetUrl;

  try {
    targetUrl = new URL(targetUrl).href;
  } catch {
    return sendGhost(res, 60);
  }

  const { 'user-agent': userAgent } = req.headers;

  // 🛑 THE AUTOMATIC REFERER (Origin Injection)
  const queryReferer = Array.isArray(req.query?.referer) ? req.query.referer[0] : req.query?.referer;
  let autoReferer = '';
  try {
    const parsedTarget = new URL(targetUrl);
    autoReferer = parsedTarget.origin;
  } catch {}
  
  const finalReferer = (queryReferer && typeof queryReferer === 'string') ? queryReferer : autoReferer;

  const headers = {
    'user-agent': userAgent || getRandomUA(),
    accept: req.headers.accept || 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
    'accept-encoding': UPSTREAM_ACCEPT_ENCODING,
    'accept-language': req.headers['accept-language'] || 'en-US,en;q=0.9',
    'sec-fetch-dest': 'image',
    'sec-fetch-mode': 'no-cors',
    'sec-fetch-site': 'cross-site',
    'sec-ch-ua': '"Chromium";v="148", "Not;A=Brand";v="24", "Google Chrome";v="148"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    ...(finalReferer ? { referer: finalReferer } : {})
  };

  const config = {
    headers,
    dnsLookup: safeLookup,
    agent: { https: chromeCipherAgent },
    timeout: { request: REQUEST_TIMEOUT_MS, response: REQUEST_TIMEOUT_MS },
    responseType: 'buffer',
    decompress: true,
    throwHttpErrors: false,
    followRedirect: true,
    retry: { limit: 0 },
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

  let workerBase = process.env.CF_WORKER_URL || '';
  if (workerBase === 'undefined' || workerBase === 'null') workerBase = '';
  if (workerBase && !workerBase.startsWith('http')) workerBase = 'https://' + workerBase;
  if (workerBase.endsWith('/')) workerBase = workerBase.slice(0, -1);

  let fetchUrl = targetUrl;
  let fetchConfig = config;
  let isWorkerFetch = false;

  if (workerBase && workerBase.startsWith('https://')) {
    const internalKey = process.env.INTERNAL_KEY;

    if (internalKey) {
      isWorkerFetch = true;
      fetchUrl = `${workerBase}/raw?url=${encodeURIComponent(targetUrl)}`;
      fetchConfig = {
        headers: { ...config.headers, 'x-internal-key': internalKey },
        timeout: config.timeout,
        responseType: 'buffer',
        decompress: true,
        throwHttpErrors: false,
        followRedirect: true,
        retry: { limit: 0 }
      };
    }
  }

  let response;
  let statusCode;
  let responseHeaders;
  let activeUrl = fetchUrl;
  let activeConfig = fetchConfig;

  try {
    response = await executeFetch(activeUrl, activeConfig);
    statusCode = response.statusCode;
    responseHeaders = response.headers;

    // 🛑 WORKER FALLBACK PROTOCOL (Worker 5xx triggers direct rescue)
    if (isWorkerFetch && statusCode >= 500 && statusCode < 600) {
      throw new Error('WORKER_5XX_FAILURE');
    }
  } catch (err) {
    if (isWorkerFetch) {
      // 🛑 WORKER FALLBACK PROTOCOL (Direct-to-Origin Rescue)
      activeUrl = targetUrl;
      activeConfig = config;
      response = await executeFetch(activeUrl, activeConfig);
      statusCode = response.statusCode;
      responseHeaders = response.headers;
    } else {
      throw err;
    }
  }

  // 🛑 403 RETRY PROTOCOL (Automated Hotlink Evasion)
  if (statusCode === 403) {
    const retryHeaders = { ...activeConfig.headers, 'user-agent': getRandomUA() };
    try {
      response = await executeFetch(activeUrl, { ...activeConfig, headers: retryHeaders });
      statusCode = response.statusCode;
      responseHeaders = response.headers;
    } catch {
      // Retry failed, keep original 403
    }
  }

  try {
    const rawBody = toBuffer(response.rawBody ?? response.body);

    if (rawBody.length > MAX_DOWNLOAD_BYTES) {
      return sendGhost(res, 3600);
    }

    // 🛑 ORIGIN OBEDIENCE PROTOCOL (Pass upstream max-age to Worker)
    const upstreamCacheControl = responseHeaders['cache-control'] || '';
    const maxAgeMatch = upstreamCacheControl.match(/max-age=(\d+)/i);
    if (maxAgeMatch) {
      const upstreamMaxAge = parseInt(maxAgeMatch[1], 10);
      if (!Number.isNaN(upstreamMaxAge) && upstreamMaxAge > 0) {
        responseHeaders['x-upstream-max-age'] = String(upstreamMaxAge);
      }
    }

    if (statusCode === 404 || statusCode === 410) {
      return sendGhost(res, 86400);
    }
    
    if (statusCode === 403) {
      return sendGhost(res, 3600);
    }

    if (statusCode < 200 || statusCode >= 300) {
      return sendGhost(res, 60);
    }

    const detectedType = detectContentType(rawBody);

    if (!detectedType.startsWith('image/') || detectedType === 'image/svg+xml') {
      return sendGhost(res, 3600);
    }

    delete responseHeaders['content-encoding'];
    delete responseHeaders['content-length'];

    copyHeaders({ headers: responseHeaders, status: statusCode }, res);
    res.setHeader('Content-Type', detectedType);

    req.opts.originType = detectedType;

    // 🛑 THE GENERATION SAVER (Magic Byte Bypass)
    const isModernFormat = detectedType === 'image/webp' || detectedType === 'image/avif';
    const isSmallFile = rawBody.length < 150 * 1024;

    if (isModernFormat && isSmallFile) {
      return bypass(req, res, rawBody, statusCode);
    }

    if (shouldCompress(req, rawBody)) {
      await compress(req, res, rawBody);
      return;
    }

    return bypass(req, res, rawBody, statusCode);

  } catch (error) {
    const isBodyTooLarge =
      error.message === 'BODY_TOO_LARGE' ||
      error.code === 'ERR_BODY_LARGE' ||
      error.code === 'BODY_TOO_LARGE';

    if (isBodyTooLarge) return sendGhost(res, 3600);

    const code = error.code;

    if (code === 'SSRF_BLOCKED_REDIRECT' || code === 'SSRF_BLOCKED_DNS') {
      return sendGhost(res, 86400);
    }

    if (code === 'ETIMEDOUT' || code === 'ERR_GOT_REQUEST_TIMEOUT') {
      return sendGhost(res, 60);
    }

    return sendGhost(res, 60);
  }
    }
