const EXCLUDED_TYPES = new Set([
  'image/svg+xml',
  'application/pdf',
  'image/x-icon',
  'image/vnd.microsoft.icon'
]);

// 🛑 ALIGNED: 70MB absolute cap. Matches MAX_DOWNLOAD_BYTES and CONCURRENCY_TIERS[0].
const MAX_COMPRESS_BYTES = parseInt(process.env.MAX_DOWNLOAD_BYTES, 10) || (70 * 1024 * 1024);

export default function shouldCompress(req, buffer) {
  const { originType } = req.opts || {};

  if (!originType || !Buffer.isBuffer(buffer) || buffer.length === 0) {
    return false;
  }

  if (!originType.startsWith('image/') || EXCLUDED_TYPES.has(originType)) {
    return false;
  }

  // 🛑 O(1) Short-Circuit: Reject anything above the 70MB cap.
  // The Tier Warden in compress.js handles concurrency for sizes below this.
  if (buffer.length > MAX_COMPRESS_BYTES) {
    return false;
  }

  return true;
}
