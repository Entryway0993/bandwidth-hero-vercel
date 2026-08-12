import isAnimated from 'is-animated';

const EXCLUDED_TYPES = new Set([
  'image/svg+xml',
  'application/pdf',
  'image/x-icon',
  'image/vnd.microsoft.icon'
]);

export default function shouldCompress(req, buffer) {
  const { originType } = req.opts || {};

  if (!originType || !Buffer.isBuffer(buffer) || buffer.length === 0) {
    return false;
  }

  if (!originType.startsWith('image/') || EXCLUDED_TYPES.has(originType)) {
    return false;
  }

  try {
    // 🛑 1GB RAM / 60s CONSTRAINT: O(1) Short-Circuit.
    // Checks the size FIRST. If the image is < 14MB, isAnimated() is NEVER called.
    // This prevents V8 from synchronously parsing binary data for 99% of web traffic.
    if (buffer.length > 14 * 1024 * 1024 && isAnimated(buffer)) {
      return false;
    }
  } catch {
    return false;
  }
} 
