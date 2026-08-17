import 'dotenv/config';
import express from 'express';
import morgan from 'morgan';
import helmet from 'helmet';
import authenticate from './src/authenticate.js';
import params from './src/params.js';
import proxy from './src/proxy.js';
import { getMetrics, checkHealth } from './src/compress.js';

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

app.use((req, res, next) => {
  if (req.method === 'OPTIONS') {
    res.setHeader('Allow', 'GET');
    res.setHeader('Access-Control-Allow-Origin', '*');
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

// 🛑 SURGICAL FIX: Wire the Oracle's Ledger to a real route.
// The Edge Middleware does NOT intercept /metrics, so this reaches Node.js.
app.get('/metrics', authenticate, (req, res) => {
  res.json(getMetrics());
});

// 🛑 SURGICAL FIX: Wire the Heartbeat Sentinel to a route the Edge Middleware does NOT intercept.
// Edge Middleware intercepts /health and /healthz, so we use /deep-health instead.
app.get('/deep-health', async (req, res) => {
  try {
    const health = await checkHealth();
    if (health.healthy) {
      res.json(health);
    } else {
      res.status(503).json(health);
    }
  } catch (err) {
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
