import sharp from 'sharp';
import isAnimated from 'is-animated';
import { pipeline } from 'node:stream/promises';

// Sharp global config for serverless (1024MB RAM)
sharp.cache({ memory: 50, files: 0 });
sharp.concurrency(1);
sharp.simd(true);

/**
 * Compresses an image buffer based on request params.
 * Streams output directly to response.
 */
async function compress(req, res, inputBuffer) {
  const { quality, grayscale, maxWidth } = req.params;
  const animated = isAnimated(inputBuffer);

  const instance = sharp({
    animated: true,
    limitInputPixels: 50_000_000,
  });

  // Grayscale (default on — perfect for B&W manga)
  if (grayscale) {
    instance.grayscale();
  }

  // Get metadata for resize decision
  const metadata = await instance.clone().metadata();

  // Opt-in resize: only when ?w= is passed and image is wider
  if (maxWidth > 0 && metadata.width > maxWidth) {
    instance.resize({ width: maxWidth, withoutEnlargement: true });
  }

  // Format selection
  if (animated) {
    // Animated GIF/APNG/WebP → animated WebP
    res.setHeader('Content-Type', 'image/webp');
    instance.webp({
      quality,
      effort: 4,
      smartSubsample: true,
      animated: true,
    });
  } else if (req.params.webp) {
    // Static → AVIF (best quality-per-byte at low q)
    res.setHeader('Content-Type', 'image/avif');
    instance.avif({
      quality,
      effort: 6,
    });
  } else {
    // Explicit ?jpeg → progressive JPEG
    res.setHeader('Content-Type', 'image/jpeg');
    instance.jpeg({
      quality,
      progressive: true,
      mozjpeg: true,
    });
  }

  // Stream: input buffer → sharp → response
  const { Readable } = await import('node:stream');
  await pipeline(Readable.from(inputBuffer), instance, res);
}

export default compress;
