import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import authenticate from './src/authenticate.js';
import params from './src/params.js';
import proxy from './src/proxy.js';

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: false,
  frameguard: { action: 'deny' },
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));

app.get('/healthz', (req, res) => res.status(200).json({ status: 'OK' }));

// 🛑 SURGICAL TRACE MIDDLEWARE
// We wrap every step in explicit logs to catch the exact line of death.

app.use((req, res, next) => {
  console.log('[TRACE-1] 🟢 Request hit Express');
  next();
});

app.use((req, res, next) => {
  console.log('[TRACE-2] 🟡 Entering authenticate...');
  authenticate(req, res, () => {
    console.log('[TRACE-3] 🟢 authenticate passed');
    next();
  });
});

app.use((req, res, next) => {
  console.log('[TRACE-4] 🟡 Entering params...');
  params(req, res, () => {
    console.log('[TRACE-5] 🟢 params passed. Target URL:', req.opts?.url);
    next();
  });
});

app.use((req, res, next) => {
  console.log('[TRACE-6] 🔴 Entering proxy... (If it hangs here, proxy.js is deadlocking)');
  
  // Force flush logs to Vercel console immediately
  process.stdout.write('[TRACE-6-FLUSH] Forcing stdout flush\n');

  proxy(req, res).then(() => {
    console.log('[TRACE-7] 🟢 proxy resolved successfully');
  }).catch(err => {
    console.error('[TRACE-FATAL] proxy threw unhandled error:', err);
    if (!res.headersSent) res.status(500).end();
  });
});

app.use((req, res) => {
  console.log('[TRACE-8] ⚪ Catch-all 404');
  res.status(404).json({ error: 'Endpoint not found' });
});

if (!process.env.VERCEL) {
  app.listen(3000, () => console.log('Local dev listening'));
}

export default app;
