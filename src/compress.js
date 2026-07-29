import sharp from 'sharp';
import isAnimated from 'is-animated';

// Sharp global config for serverless (1024MB RAM)
sharp.cache({ memory: 50, files: 0 });
sharp.concurrency(1);
sharp.simd(true);

/**
 * Compresses an image buffer based on request params.
 * Outputs directly to response.
 */
async function compress(req, res, inputBuffer) {
  const { quality, grayscale, maxWidth } = req.params;
  const animated = isAnimated(inputBuffer);

  // Get metadata from the actual buffer
  const metadata = await sharp(inputBuffer, {
    animated: true,
    limitInputPixels: 50_000_000,
  }).metadata();

  // Build processing pipeline with buffer as input
  const instance = sharp(inputBuffer, {
    animated: true,
    limitInputPixels: 50_000_000,
  });

  // Grayscale (default on — perfect for B&W manga)
  if (grayscale) {
    instance.grayscale();
  }

  // Opt-in resize: only when ?w= is passed and image is wider
  if (maxWidth > 0 && metadata.width > maxWidth) {
    instance.resize({ width: maxWidth, withoutEnlargement: true });
  }

  // Format selection + stream to response
  if (animated) {
    res.setHeader('Content-Type', 'image/webp');
    instance
      .webp({ quality, effort: 4, smartSubsample: true, animated: true })
      .pipe(res);
  } else if (req.params.webp) {
    res.setHeader('Content-Type', 'image/avif');
    instance
      .avif({ quality, effort: 6 })
      .pipe(res);
  } else {
    res.setHeader('Content-Type', 'image/jpeg');
    instance
      .jpeg({ quality, progressive: true, mozjpeg: true })
      .pipe(res);
  }
}

export default compress;
