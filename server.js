// Force V8 heap limit before any imports load
process.env.NODE_OPTIONS = '--max-old-space-size=1024';

import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import crypto from 'node:crypto';
import { brotliCompress } from 'node:zlib';
import { promisify } from 'node:util';
import authenticate from './src/authenticate.js';
import params from './src/params.js';
import proxy from './src/proxy.js';
import { getMetrics, checkHealth } from './src/compress.js';
import memoryGovernor from './src/memoryGovernor.js';

const brotliCompressAsync = promisify(brotliCompress);

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: false,
  frameguard: { action: 'deny' },
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  referrerPolicy: { policy: 'no-referrer' }
}));

// F20: Request ID middleware
app.use((req, res, next) => {
  const reqId = req.headers['x-request-id'] || crypto.randomUUID();
  req.id = reqId;
  res.setHeader('X-Request-ID', reqId);
  next();
});

// F5-MODIFIED / F15: Redact API keys in logs instead of skipping
const redactFormat = morgan((tokens, req, res) => {
  let url = tokens.url(req, res) || '';
  url = url.replace(/([?&])(api|apikey|api_key)=([^&]*)/gi, '$1$2=[REDACTED]');
  return [
    tokens.method(req, res),
    url,
    tokens.status(req, res),
    tokens.res(req, res, 'content-length'),
    '-',
    tokens['response-time'](req, res),
    'ms'
  ].join(' ');
});

app.use(redactFormat);

// Brotli JSON compression for admin endpoints
app.use((req, res, next) => {
  const acceptEncoding = req.headers['accept-encoding'] || '';
  if (!acceptEncoding.includes('br')) return next();

  const originalJson = res.json.bind(res);

  res.json = async (body) => {
    try {
      const raw = JSON.stringify(body);

      if (raw.length < 1024) {
        return originalJson(body);
      }

      const compressed = await brotliCompressAsync(Buffer.from(raw));

      res.setHeader('Content-Encoding', 'br');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Length', compressed.length);
      res.setHeader('Vary', 'Accept-Encoding');

      return res.end(compressed);
    } catch {
      return originalJson(body);
    }
  };

  next();
});

// F8: CORS / OPTIONS handler
app.use((req, res, next) => {
  if (req.method === 'OPTIONS') {
    res.setHeader('Allow', 'GET, HEAD, OPTIONS');
    const corsOrigin = process.env.CORS_ORIGIN || '*';
    res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'x-api-key, content-type, authorization');
    res.setHeader('Access-Control-Max-Age', '86400');
    return res.status(204).end();
  }
  next();
});

// Health endpoints
app.get('/healthz', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/favicon.ico', (req, res) => {
  res.status(204).end();
});

// F17: /metrics requires auth
app.get('/metrics', authenticate, (req, res) => {
  res.json(getMetrics());
});

// F17: /deep-health requires auth
app.get('/deep-health', authenticate, async (req, res) => {
  try {
    const health = await checkHealth();
    res.status(health.healthy ? 200 : 503).json(health);
  } catch (err) {
    res.status(500).json({ error: 'Health check failed' });
  }
});

// Main pipeline
app.use(authenticate, params, proxy);

// 404
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Global error handler
app.use((err, req, res, next) => {
  const reqId = req.id || 'unknown';
  const safeMessage = err?.message ? String(err.message).split('?')[0] : 'Unknown error';
  console.error(`[SERVER ERROR] [${reqId}]`, safeMessage);

  if (res.headersSent) {
    return req.socket?.destroy();
  }

  res.status(500).json({ error: 'Internal server error' });
});

if (!process.env.VERCEL) {
  const PORT = parseInt(process.env.PORT, 10) || 3000;
  app.listen(PORT, () => {
    console.log(`[SERVER] Listening on port ${PORT}`);
    console.log(`[SERVER] Memory ceiling: ${memoryGovernor.MEMORY_CEILING_MB}MB`);
  });
}

export default app;
