import 'dotenv/config';
import express from 'express';
import morgan from 'morgan';
import helmet from 'helmet';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import authenticate from './src/authenticate.js';
import params from './src/params.js';
import proxy from './src/proxy.js';
import { getMetrics, checkHealth } from './src/compress.js';

const brotliCompress = promisify(zlib.brotliCompress);

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 3000;

app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: false,
  frameguard: { action: 'deny' },
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));

if (process.env.LOG === '1') {
  app.use(morgan('tiny', {
    skip: (req) => !!(req.query.api || req.query.apikey || req.query.api_key || req.headers['x-api-key'])
  }));
}

// 🛑 FIXED: Async Brotli compression. No more event loop blocking.
app.use((req, res, next) => {
  const acceptEncoding = req.headers['accept-encoding'] || '';
  if (!acceptEncoding.includes('br')) return next();

  const originalJson = res.json.bind(res);
  res.json = async (body) => {
    const raw = JSON.stringify(body);
    try {
      const compressed = await brotliCompress(Buffer.from(raw), {
        params: {
          [zlib.constants.BROTLI_PARAM_QUALITY]: 4,
        },
      });
      res.setHeader('Content-Encoding', 'br');
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Length', String(compressed.length));
      return res.end(compressed);
    } catch {
      return originalJson(body);
    }
  };
  next();
});

app.use((req, res, next) => {
  if (req.method === 'OPTIONS') {
    res.setHeader('Allow', 'GET');
    // 🛑 CORS: Lock to specific origin if configured, otherwise allow all for extension compatibility.
    const corsOrigin = process.env.CORS_ORIGIN || '*';
    res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET');
    res.setHeader('Access-Control-Allow-Headers', 'x-api-key, content-type');
    res.setHeader('Access-Control-Max-Age', '86400');
    return res.status(204).end();
  }

  if (req.method === 'HEAD') {
    res.setHeader('Allow', 'GET');
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  next();
});

app.get('/healthz', (req, res) => res.status(200).json({ status: 'OK' }));
app.get('/favicon.ico', (req, res) => res.status(204).end());

app.get('/metrics', authenticate, (req, res) => {
  res.json(getMetrics());
});

app.get('/deep-health', async (req, res) => {
  try {
    const health = await checkHealth();
    if (health.healthy) {
      res.json(health);
    } else {
      res.status(503).json(health);
    }
  } catch {
    res.status(500).json({ error: 'Health check failed' });
  }
});

app.use(authenticate, params, proxy);

app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

app.use((err, req, res, next) => {
  console.error('[Global Error]', err);
  if (!res.headersSent) {
    res.status(500).json({ error: 'Internal server error' });
  } else {
    req.socket?.destroy();
  }
});

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Listening on port ${PORT}`);
  });
}

export default app;
