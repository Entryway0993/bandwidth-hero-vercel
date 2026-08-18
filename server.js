// ============================================================
// DIAGNOSTIC BUILD - Deploy this and check Vercel Function Logs
// Each numbered log tells us exactly where the hang occurs.
// ============================================================

console.log('[DIAG-1] Module evaluation started');

// Dynamic imports so we can see which one hangs
let express, sharp, got;

try {
  console.log('[DIAG-2] Importing express...');
  express = (await import('express')).default;
  console.log('[DIAG-3] Express loaded');
} catch (e) {
  console.error('[DIAG-FAIL] Express import failed:', e.message);
}

try {
  console.log('[DIAG-4] Importing sharp...');
  sharp = (await import('sharp')).default;
  console.log('[DIAG-5] Sharp loaded');
} catch (e) {
  console.error('[DIAG-FAIL] Sharp import failed:', e.message);
}

try {
  console.log('[DIAG-6] Importing got...');
  got = (await import('got')).default;
  console.log('[DIAG-7] Got loaded');
} catch (e) {
  console.error('[DIAG-FAIL] Got import failed:', e.message);
}

console.log('[DIAG-8] Creating Express app...');
const app = express();

app.use((req, res, next) => {
  console.log('[DIAG-9] Request received:', req.method, req.url);
  next();
});

app.get('/healthz', (req, res) => {
  console.log('[DIAG-10] Health check hit');
  res.json({ status: 'ok' });
});

app.get('/', (req, res) => {
  console.log('[DIAG-11] Root handler hit');
  res.json({
    status: 'diagnostic-ok',
    express: !!express,
    sharp: !!sharp,
    got: !!got,
    url: req.url,
    query: req.query
  });
});

// Catch-all
app.use((req, res) => {
  console.log('[DIAG-12] Catch-all hit:', req.method, req.url);
  res.json({ status: 'catch-all', url: req.url });
});

if (!process.env.VERCEL) {
  app.listen(3000, () => console.log('[DIAG-13] Local server listening on 3000'));
}

console.log('[DIAG-14] Module evaluation complete. Exporting app.');
export default app;
