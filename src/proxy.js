import * as crypto from 'node:crypto';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import { Readable } from 'node:stream';
import { request, Agent } from 'undici';
import sharp from 'sharp';
import { LRUCache } from 'lru-cache';
import { parseSafeUrl, safeLookup } from './urlGuard.js';
import shouldCompress from './shouldCompress.js';
import compress from './compress.js';
import copyHeaders from './copyHeaders.js';
import memoryGovernor from './memoryGovernor.js';

const createHash = crypto.createHash;
const subtle = crypto.webcrypto?.subtle ?? globalThis.crypto?.subtle;

const UPSTREAM_ACCEPT_ENCODING = process.env.UPSTREAM_ACCEPT_ENCODING || 'identity';
const REQUEST_TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT_MS, 10) || 8000;
const BODY_TIMEOUT_MS = parseInt(process.env.BODY_TIMEOUT_MS, 10) || 20000;
const UPSTREAM_DEADLINE_MS = parseInt(process.env.UPSTREAM_DEADLINE_MS, 10) || 20000;

// F11: RAW_VAULT reduced, adaptive governor handles primary limits
const RAW_VAULT_MAX_BYTES = 20 * 1024 * 1024;
const RAW_VAULT_MAX_ENTRY = 4 * 1024 * 1024;
const RAW_VAULT_MAX_ENTRIES = 30;

const RAW_VAULT = new LRUCache({
  max: RAW_VAULT_MAX_ENTRIES,
  maxSize: RAW_VAULT_MAX_BYTES,
  sizeCalculation: (entry) => entry.size
});

function vaultGet(url) {
  return RAW_VAULT.get(url) ?? null;
}

function vaultSet(url, raw, etag, lastModified) {
  if (raw.length > RAW_VAULT_MAX_ENTRY) return;
  RAW_VAULT.set(url, { raw, etag, lastModified, size: raw.length });
}

const chromeDispatcher = new Agent({
  connect: {
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
    maxVersion: 'TLSv1.3',
    lookup: safeLookup
  },
  headersTimeout: REQUEST_TIMEOUT_MS,
  bodyTimeout: BODY_TIMEOUT_MS,
  keepAliveTimeout: 10000
});

// F18-MODIFIED: General desktop UAs, no device-specific strings
const UA_POOL = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36 Edg/148.0.0.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36'
];

function getRandomUA() {
  return UA_POOL[Math.floor(Math.random() * UA_POOL.length)];
}

const GHOST_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

function sendGhost(res, cacheSeconds = 3600) {
  if (!res.headersSent) {
    res.setHeader('Content-Type', 'image/gif');
    res.setHeader('Cache-Control', `public, max-age=${cacheSeconds}`);
    res.setHeader('x-ghost', 'true');
    res.status(200).end(GHOST_GIF);
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

// F15: Sanitize URLs for logging
function sanitizeUrl(url) {
  try {
    const u = new URL(url);
    return u.origin + '/*';
  } catch {
    return String(url).split('?')[0].split('/').slice(0, 3).join('/') + '/*';
  }
}

// F15: Sanitize error messages
function sanitizeError(err) {
  let msg = err?.message ? String(err.message) : 'Unknown error';
  msg = msg.replace(/\?[^\s]*/g, '');
  msg = msg.replace(/(api[_-]?key|apikey|api|key|token|secret|password)=([^\s&]*)/gi, '$1=[REDACTED]');
  return msg;
}

function detectContentType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 2) return 'application/octet-stream';

  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';

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

  if (buffer[0] === 0x42 && buffer[1] === 0x4d) return 'image/bmp';

  if (
    buffer.length >= 6 &&
    buffer[0] === 0x00 &&
    buffer[1] === 0x00 &&
    buffer[2] === 0x01 &&
    buffer[3] === 0x00
  ) {
    return 'image/x-icon';
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

  if (buffer.length >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = buffer.subarray(8, 12).toString('ascii');
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
  }

  return 'application/octet-stream';
}

async function sha256Hex(data) {
  const input = Buffer.isBuffer(data) ? data : Buffer.from(data);

  try {
    if (subtle) {
      const view = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
      const digest = await subtle.digest('SHA-256', view);
      return Buffer.from(digest).toString('hex');
    }
  } catch {
    // Fall through
  }

  if (typeof crypto.hash === 'function') {
    return crypto.hash('sha256', input, 'hex');
  }

  return createHash('sha256').update(input).digest('hex');
}

async function generateETag(req, targetUrl, upstreamHeaders, body) {
  const paramsFingerprint = JSON.stringify({
    url: targetUrl,
    format: req.opts?.format,
    quality: req.opts?.quality,
    grayscale: req.opts?.grayscale,
    maxDim: req.opts?.maxDim,
    maxStripWidth: req.opts?.maxStripWidth,
    sharpen: req.opts?.sharpen,
    rotate: req.opts?.rotate
  });

  const upstreamEtag = upstreamHeaders?.['etag'];
  const upstreamLM = upstreamHeaders?.['last-modified'];
  const upstreamLen = upstreamHeaders?.['content-length'];

  let upstreamIdentity;

  if (upstreamEtag || upstreamLM) {
    upstreamIdentity = `${upstreamEtag || ''}|${upstreamLM || ''}|${upstreamLen || ''}`;
  } else {
    upstreamIdentity = await sha256Hex(body);
  }

  const material = Buffer.from(paramsFingerprint + '|' + upstreamIdentity);
  const digest = await sha256Hex(material);

  return `"${digest.slice(0, 32)}"`;
}

// F4: Adaptive decompression budget
async function decompressBody(buffer, encoding) {
  if (!encoding) return buffer;

  const enc = String(encoding).toLowerCase().trim();

  let decompressor;

  if (enc === 'gzip' || enc === 'x-gzip') {
    decompressor = createGunzip();
  } else if (enc === 'deflate') {
    decompressor = createInflate();
  } else if (enc === 'br') {
    decompressor = createBrotliDecompress();
  } else {
    return buffer;
  }

  const maxDecompressed = memoryGovernor.getDecompressBudget();

  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalLength = 0;

    const stream = Readable.from(buffer).pipe(decompressor);

    stream.on('data', (chunk) => {
      totalLength += chunk.length;

      if (totalLength > maxDecompressed) {
        stream.destroy(new Error('DECOMPRESS_BOMB'));
        return;
      }

      chunks.push(chunk);
    });

    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', (err) => reject(err));
  });
}

// F4: Adaptive download limit
async function consumeWithLimit(body) {
  const maxDownload = memoryGovernor.getDownloadBudget();
  const chunks = [];
  let total = 0;

  for await (const chunk of body) {
    total += chunk.length;

    if (total > maxDownload) {
      body.destroy();
      const err = new Error('BODY_TOO_LARGE');
      err.code = 'BODY_TOO_LARGE';
      throw err;
    }

    chunks.push(chunk);
  }

  const finalBuffer = Buffer.allocUnsafe(total);
  let offset = 0;

  for (const chunk of chunks) {
    chunk.copy(finalBuffer, offset);
    offset += chunk.length;
  }

  return finalBuffer;
}

async function safeRequest(url, headers, signal, maxRedirects = 5) {
  let currentUrl = url;
  const deadline = Date.now() + UPSTREAM_DEADLINE_MS;

  for (let i = 0; i <= maxRedirects; i++) {
    if (Date.now() > deadline) {
      const err = new Error('UPSTREAM_DEADLINE');
      err.code = 'UPSTREAM_DEADLINE';
      throw err;
    }

    const { statusCode, headers: resHeaders, body } = await request(currentUrl, {
      dispatcher: chromeDispatcher,
      method: 'GET',
      headers,
      signal,
      maxRedirections: 0
    });

    if ([301, 302, 303, 307, 308].includes(statusCode)) {
      await body.dump().catch(() => {});

      const location = resHeaders['location'];

      if (!location) {
        return { statusCode, headers: resHeaders, body: Buffer.alloc(0) };
      }

      let nextUrl;

      try {
        nextUrl = new URL(location, currentUrl).href;
      } catch {
        const err = new Error('INVALID_REDIRECT');
        err.code = 'INVALID_REDIRECT';
        throw err;
      }

      if (!parseSafeUrl(nextUrl)) {
        const err = new Error('SSRF_BLOCKED_REDIRECT');
        err.code = 'SSRF_BLOCKED_REDIRECT';
        throw err;
      }

      currentUrl = nextUrl;
      continue;
    }

    const buffer = await consumeWithLimit(body);
    return { statusCode, headers: resHeaders, body: buffer };
  }

  const err = new Error('TOO_MANY_REDIRECTS');
  err.code = 'TOO_MANY_REDIRECTS';
  throw err;
}

export default async function proxy(req, res) {
  const startTime = Date.now();
  const reqId = req.id || 'unknown';

  // F2-ADAPTIVE: Memory pressure gate
  if (memoryGovernor.isUnderPressure()) {
    res.setHeader('Retry-After', '10');
    return res.status(503).json({ error: 'Memory pressure. Try again shortly.' });
  }

  // Express 5 natively exposes req.signal for client disconnects

  let targetUrl = req.opts?.url || req.query?.url;

  if (Array.isArray(targetUrl)) {
    targetUrl = targetUrl.find(u => u && typeof u === 'string') || String(targetUrl[0]);
  }

  if (!targetUrl || typeof targetUrl !== 'string') {
    return sendGhost(res, 60);
  }

  targetUrl = targetUrl.trim();

  if (!targetUrl.startsWith('http')) {
    targetUrl = 'https://' + targetUrl;
  }

  try {
    targetUrl = new URL(targetUrl).href;
  } catch {
    return sendGhost(res, 60);
  }

  const { 'user-agent': userAgent } = req.headers;

  const queryReferer = Array.isArray(req.query?.referer)
    ? req.query.referer[0]
    : req.query?.referer;

  let autoReferer = '';

  try {
    const parsedTarget = new URL(targetUrl);
    autoReferer = parsedTarget.origin;
  } catch {}

  const finalReferer = (queryReferer && typeof queryReferer === 'string')
    ? queryReferer
    : autoReferer;

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

  const vaultEntry = vaultGet(targetUrl);

  if (vaultEntry) {
    if (vaultEntry.etag) headers['if-none-match'] = vaultEntry.etag;
    if (vaultEntry.lastModified) headers['if-modified-since'] = vaultEntry.lastModified;
  }

  let workerBase = process.env.CF_WORKER_URL || '';

  if (workerBase === 'undefined' || workerBase === 'null') workerBase = '';
  if (workerBase && !workerBase.startsWith('http')) workerBase = 'https://' + workerBase;
  if (workerBase.endsWith('/')) workerBase = workerBase.slice(0, -1);

  let fetchUrl = targetUrl;
  let fetchHeaders = headers;
  let isWorkerFetch = false;

  if (workerBase && workerBase.startsWith('https://')) {
    const internalKey = process.env.INTERNAL_KEY;

    if (internalKey) {
      isWorkerFetch = true;
      fetchUrl = `${workerBase}/raw?url=${encodeURIComponent(targetUrl)}`;
      fetchHeaders = { ...headers, 'x-internal-key': internalKey };
    }
  }

  let response;
  let statusCode;
  let responseHeaders;
  let activeUrl = fetchUrl;
  let activeHeaders = fetchHeaders;

  try {
    response = await safeRequest(activeUrl, activeHeaders, req.signal);
    statusCode = response.statusCode;
    responseHeaders = response.headers;

    if (isWorkerFetch && statusCode >= 500 && statusCode < 600) {
      throw new Error('WORKER_5XX_FAILURE');
    }
  } catch (err) {
    if (req.signal.aborted) return;

    if (isWorkerFetch) {
      activeUrl = targetUrl;
      activeHeaders = headers;

      try {
        response = await safeRequest(activeUrl, activeHeaders, req.signal);
        statusCode = response.statusCode;
        responseHeaders = response.headers;
      } catch (fallbackErr) {
        if (req.signal.aborted) return;
        throw fallbackErr;
      }
    } else {
      throw err;
    }
  }

  if (statusCode === 403) {
    const retryHeaders = { ...activeHeaders, 'user-agent': getRandomUA() };

    try {
      response = await safeRequest(activeUrl, retryHeaders, req.signal);
      statusCode = response.statusCode;
      responseHeaders = response.headers;
    } catch (err) {
      if (req.signal.aborted) return;
    }
  }

  try {
    let rawBody;

    if (statusCode === 304 && vaultEntry) {
      rawBody = vaultEntry.raw;
      res.setHeader('X-Conditional-Fetch', '304_VAULT_HIT');
    } else {
      rawBody = toBuffer(response.body);

      const encoding = responseHeaders?.['content-encoding'];

      if (encoding) {
        try {
          rawBody = await decompressBody(rawBody, encoding);
        } catch {
          return sendGhost(res, 60);
        }
      }
    }

    // F4: Adaptive size check
    const downloadBudget = memoryGovernor.getDownloadBudget();
    if (rawBody.length > downloadBudget) {
      return sendGhost(res, 3600);
    }

    if (statusCode === 200 && rawBody.length <= RAW_VAULT_MAX_ENTRY) {
      const upstreamEtag = responseHeaders['etag'] || null;
      const upstreamLastModified = responseHeaders['last-modified'] || null;

      if (upstreamEtag || upstreamLastModified) {
        vaultSet(targetUrl, rawBody, upstreamEtag, upstreamLastModified);
      }
    }

    // F3: Honor upstream cache-control
    const upstreamCacheControl = String(responseHeaders['cache-control'] || '').toLowerCase();
    const isNoStore = /no-store|private|no-cache/.test(upstreamCacheControl);
    const upstreamMaxAgeMatch = upstreamCacheControl.match(/max-age=(\d+)/i);
    const upstreamMaxAge = upstreamMaxAgeMatch ? parseInt(upstreamMaxAgeMatch[1], 10) : null;

    // MOVED UP: Debug check before ghost returns
    if (req.query?.debug === '1') {
      const preview = rawBody.slice(0, 512).toString('utf8', 0, 512).replace(/[^\x20-\x7E]/g, '');
      return res.status(200).json({
        status: statusCode,
        detectedType: detectContentType(rawBody),
        sizeBytes: rawBody.length,
        preview: preview,
        requestId: reqId
      });
    }
    
    if (statusCode === 404 || statusCode === 410) {
      return sendGhost(res, 86400);
    }

    if (statusCode === 403) {
      return sendGhost(res, 3600);
    }

    if (statusCode !== 304 && (statusCode < 200 || statusCode >= 300)) {
      return sendGhost(res, 60);
    }

    const detectedType = detectContentType(rawBody);

    if (!detectedType.startsWith('image/')) {
      return sendGhost(res, 3600);
    }

    if (req.query?.debug === '1') {
      try {
        const metadata = await sharp(rawBody).metadata();

        const report = {
          status: statusCode,
          originType: detectedType,
          format: metadata.format,
          width: metadata.width,
          height: metadata.height,
          space: metadata.space,
          channels: metadata.channels,
          isAnimated: (metadata.pages || 1) > 1,
          frames: metadata.pages || 1,
          hasAlpha: metadata.hasAlpha,
          exif: metadata.exif ? 'present' : 'none',
          sizeBytes: rawBody.length,
          upstreamCacheControl,
          executionTimeMs: Date.now() - startTime,
          requestId: reqId
        };

        return res.status(200).json(report);
      } catch (err) {
        return res.status(500).json({
          error: 'Debug analysis failed',
          message: sanitizeError(err),
          requestId: reqId
        });
      }
    }

    const etag = await generateETag(req, targetUrl, responseHeaders, rawBody);

    if (req.headers['if-none-match'] === etag) {
      res.setHeader('ETag', etag);
      return res.status(304).end();
    }

    delete responseHeaders['content-encoding'];
    delete responseHeaders['content-length'];

    copyHeaders({ headers: responseHeaders, status: statusCode }, res);

    res.setHeader('Content-Type', detectedType);
    res.setHeader('x-upstream-content-length', String(rawBody.length));
    res.setHeader('ETag', etag);
    res.setHeader('Vary', 'Accept, Accept-Encoding, Sec-CH-Save-Data');

    // F3: Adaptive cache-control based on upstream policy
    if (isNoStore) {
      res.setHeader('Cache-Control', 'no-store');
    } else if (upstreamMaxAge !== null && upstreamMaxAge > 0) {
      const ttl = Math.min(upstreamMaxAge, 30 * 24 * 60 * 60);
      res.setHeader('Cache-Control', `public, max-age=${ttl}, s-maxage=${ttl}, stale-while-revalidate=604800, stale-if-error=604800`);
      res.setHeader('x-upstream-max-age', String(upstreamMaxAge));
    } else {
      res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800, stale-if-error=604800');
    }

    req.opts.originType = detectedType;

    const requestedFormat = req.opts?.format;

    const formatMatchesDetected =
      (requestedFormat === 'jpeg' && detectedType === 'image/jpeg') ||
      (requestedFormat === 'webp' && detectedType === 'image/webp') ||
      (requestedFormat === 'avif' && detectedType === 'image/avif');

    const isModernFormat = detectedType === 'image/webp' || detectedType === 'image/avif';
    const isSmallFile = rawBody.length < 150 * 1024;

    if (isModernFormat && isSmallFile && formatMatchesDetected) {
      return bypass(req, res, rawBody, statusCode);
    }

    if (shouldCompress(req, rawBody, memoryGovernor)) {
      const compressedResult = await compress(req, res, rawBody, memoryGovernor);

      if (!res.writableEnded) {
        if (compressedResult && compressedResult.length > 0) {
          res.end(compressedResult);
        } else {
          res.end();
        }
      }

      return;
    }

    return bypass(req, res, rawBody, statusCode);
  } catch (error) {
    if (req.signal.aborted) return;

    const isBodyTooLarge =
      error.message === 'BODY_TOO_LARGE' ||
      error.code === 'ERR_BODY_LARGE' ||
      error.code === 'BODY_TOO_LARGE';

    if (isBodyTooLarge) return sendGhost(res, 3600);

    const code = error.code;

    if (code === 'SSRF_BLOCKED_REDIRECT' || code === 'SSRF_BLOCKED_DNS') {
      return sendGhost(res, 86400);
    }

    if (
      code === 'ETIMEDOUT' ||
      code === 'ERR_GOT_REQUEST_TIMEOUT' ||
      code === 'UND_ERR_HEADERS_TIMEOUT' ||
      code === 'UND_ERR_BODY_TIMEOUT' ||
      code === 'UPSTREAM_DEADLINE'
    ) {
      return sendGhost(res, 60);
    }

    // F15: Sanitized error logging with request ID
    console.error(`[PROXY ERROR] [${reqId}]`, sanitizeError(error));

    return sendGhost(res, 60);
  }
}
