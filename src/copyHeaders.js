// 🛑 THE HEADER ASSASSIN
// Only these headers are allowed to survive the purge.
const ALLOWED_HEADERS = new Set([
  'content-type',
  'cache-control',
  'etag',
  'last-modified',
  'expires'
]);

export default function copyHeaders(response, res) {
  if (!response?.headers) return;

  for (const [key, value] of Object.entries(response.headers)) {
    const lowerKey = key.toLowerCase();
    
    // Execute any header not on the whitelist.
    if (ALLOWED_HEADERS.has(lowerKey)) {
      res.setHeader(lowerKey, value);
    }
  }
}
