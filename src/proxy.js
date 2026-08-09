import got from 'got';
import { parseSafeUrl, safeLookup } from './urlGuard.js';
import shouldCompress from './shouldCompress.js';
import compress from './compress.js';
import copyHeaders from './copyHeaders.js';

const CLOUDFLARE_STATUS_CODES = new Set([403, 503]);
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB limit

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
  
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 4 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png';
  if (buffer.length >= 4 && buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) return 'image/gif';
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) return 'image/bmp';
  
  if (buffer.length >= 12 && buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = buffer.subarray(8, 12).toString('ascii');
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
  }
  
  return 'application/octet-stream';
}

export default async function proxy(req, res) {
  const targetUrl = req.opts.url;
  
  if (!targetUrl) {
    return res.status(400).json({ error: 'Missing URL parameter' });
  }
  
  const { cookie, referer, 'user-agent': userAgent } = req.headers;
  
  const headers = {
    'user-agent': userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/128 Safari/537.36',
    accept: req.headers.accept || 'image/avif,image/webp,image/*;q=0.8,*/*;q=0.5',
    'accept-encoding': 'gzip, deflate, br',
    'accept-language': req.headers['accept-language'] || 'en-US,en;q=0.9'
  };
  
  if (cookie) headers.cookie = cookie;
  if (referer) headers.referer = referer;
  
  const config = {
    headers,
    dnsLookup: safeLookup,
    timeout: { request: 15000, response: 20000 },
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
  
  try {
    // 🛑 FIX: Use stream to prevent memory exhaustion (OOM kill)
    const stream = got.stream(targetUrl, config);
    let statusCode = 200;
    let responseHeaders = {};
    let aborted = false;
    
    stream.on('response', (response) => {
      statusCode = response.statusCode;
      responseHeaders = response.headers;
      
      // Check content-length immediately before downloading the body
      const len = parseInt(response.headers['content-length'], 10);
      if (len && len > MAX_FILE_SIZE) {
        aborted = true;
        stream.destroy(new Error('BODY_TOO_LARGE'));
      }
    });
    
    const chunks = [];
    let totalLength = 0;
    
    // Read the stream chunk by chunk
    for await (const chunk of stream) {
      totalLength += chunk.length;
      if (totalLength > MAX_FILE_SIZE) {
        aborted = true;
        stream.destroy(new Error('BODY_TOO_LARGE'));
        break;
      }
      chunks.push(chunk);
    }
    
    if (aborted) {
      console.warn('⚠️ File too large');
      return res.status(413).send('File too large');
    }
    
    const rawBody = Buffer.concat(chunks, totalLength);
    
    if (CLOUDFLARE_STATUS_CODES.has(statusCode)) {
      res.setHeader('x-content-type-options', 'nosniff');
      res.setHeader('x-frame-options', 'DENY');
      res.setHeader('referrer-policy', 'strict-origin-when-cross-origin');
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
    
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('referrer-policy', 'strict-origin-when-cross-origin');
    res.setHeader('x-proxy-cache', 'MISS');
    
    if (contentType) {
      res.setHeader('Content-Type', contentType);
    }
    
    req.opts.originType = contentType;
    
    if (shouldCompress(req, rawBody)) {
      return compress(req, res, rawBody);
    }
    
    const baseType = contentType.split(';')[0].trim().toLowerCase();
    const SAFE_BYPASS_TYPES = [
      'image/jpeg', 'image/png', 'image/gif',
      'image/webp', 'image/avif', 'image/bmp'
    ];
    
    if (!SAFE_BYPASS_TYPES.includes(baseType)) {
      return res.status(403).json({ error: 'Content type not allowed or unsafe to bypass.' });
    }
    
    return bypass(req, res, rawBody, statusCode);
    
  } catch (error) {
    const code = error.code || error.cause?.code || error.message || '';
    
    if (code === 'SSRF_BLOCKED_REDIRECT' || code === 'SSRF_BLOCKED_DNS') {
      return res.status(403).json({ error: 'Blocked by SSRF guard' });
    }
    
    if (code === 'BODY_TOO_LARGE' || code === 'ERR_BODY_LARGE') {
      console.warn('⚠️ File too large');
      return res.status(413).send('File too large');
    }
    
    if (code === 'ETIMEDOUT' || code === 'ERR_GOT_REQUEST_TIMEOUT') {
      return res.status(504).json({ error: 'Origin request timed out' });
    }
    
    console.error(`❌ Proxy request failed: ${error.message}`);
    return res.status(502).json({ error: 'Proxy request failed' });
  }
}