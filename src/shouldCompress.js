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
    // Bypass compression entirely for massive files to protect serverless memory.
    if (buffer.length > 14 * 1024 * 1024) {
      return false;
    }
  } catch {
    return false;
  }

  return true;
}
