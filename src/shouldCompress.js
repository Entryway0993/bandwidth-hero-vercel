import isAnimated from 'is-animated';

// --- Configuration ---
const ENV_MIN_LENGTH = parseInt(process.env.MIN_COMPRESS_LENGTH, 10);
const MIN_COMPRESS_LENGTH = !isNaN(ENV_MIN_LENGTH) ? ENV_MIN_LENGTH : 1024;

// Thresholds
const MIN_TRANSPARENT_COMPRESS_LENGTH = MIN_COMPRESS_LENGTH * 50;
const ALREADY_COMPRESSED_THRESHOLD = MIN_COMPRESS_LENGTH * 100;

// Content Types
const EXCLUDED_TYPES = new Set(['image/svg+xml', 'application/pdf', 'image/x-icon']);
const LEGACY_TYPES = new Set(['image/png', 'image/gif']);
const MODERN_TYPES = new Set(['image/webp', 'image/avif']);

/**
 * Determines if an image should be compressed/converted.
 */
export default function shouldCompress(req, buffer) {
  const { originType, originSize, webp, grayscale, quality } = req.opts || {};

  // 1. Validate Input
  if (!originType || !originSize || !Buffer.isBuffer(buffer)) {
    return false;
  }

  // 2. Non-Image and Vector Checks
  if (!originType.startsWith('image/') || EXCLUDED_TYPES.has(originType)) {
    return false;
  }

  // 3. Size Checks: Too Small
  if (originSize < MIN_COMPRESS_LENGTH) {
    return false;
  }

  // 4. "Already Modern" Check
  if (MODERN_TYPES.has(originType)) {
    const isEditing = Boolean(grayscale || quality);
    const isLarge = originSize > ALREADY_COMPRESSED_THRESHOLD;

    if (!isEditing && !isLarge) {
      return false;
    }
  }

  // 5. Transparent/Legacy Check (PNG/GIF)
  if (LEGACY_TYPES.has(originType) && !webp) {
    if (originSize < MIN_TRANSPARENT_COMPRESS_LENGTH) {
      return false;
    }
  }

  // 6. Animation Check
  try {
    if (isAnimated(buffer) && originSize > 14 * 1024 * 1024) {
      return false;
    }
  } catch (err) {
    console.warn(`⚠️ Animation check error: ${err.message}`);
    return false;
  }

  return true;
}
