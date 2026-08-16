// middleware.js (Vercel Edge Middleware)
// 🛑 THE EDGE SENTINEL
// This runs at the Vercel Edge, before Node.js wakes up.
// It eliminates cold starts for simple requests.

export default function middleware(request) {
  const url = new URL(request.url);

  // 🛑 HEALTH CHECK AT THE EDGE
  // Returns 200 OK instantly without waking up Node.js.
  if (url.pathname === '/healthz' || url.pathname === '/health') {
    return new Response(JSON.stringify({ status: 'ok', timestamp: Date.now() }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store'
      }
    });
  }

  // 🛑 PROXY BADGE AT THE EDGE
  // Returns proxy info instantly for monitoring.
  if (url.pathname === '/badge' || url.pathname === '/info') {
    return new Response(JSON.stringify({
      proxy: 'bandwidth-hero',
      version: '2.0',
      features: ['avif', 'webp', 'manga-optimization', 'edge-sentinel'],
      timestamp: Date.now()
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=3600'
      }
    });
  }

  // 🛑 METHOD FILTERING AT THE EDGE
  // Rejects non-GET/HEAD requests instantly.
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response(JSON.stringify({ error: 'Method Not Allowed' }), {
      status: 405,
      headers: {
        'Content-Type': 'application/json',
        'Allow': 'GET, HEAD',
        'Cache-Control': 'no-store'
      }
    });
  }

  // Pass all other requests to the Node.js function
  return;
}
