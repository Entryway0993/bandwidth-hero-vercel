import sharp from 'sharp';

// Sharp global config for serverless (1024MB RAM)
sharp.cache({ memory: 50, files: 0 });
sharp.concurrency(1);
sharp.simd(true);

/**
 * Compresses an image buffer based on request params.
 * Outputs directly to response.
 */
async function compress(req, res, inputBuffer) {
  const { quality, grayscale, maxWidth } = req.opts;

  // Get metadata (Sharp is the source of truth for animation)
  const metadata = await sharp(inputBuffer, {
    animated: true,
    limitInputPixels: 50_000_000,
  }).metadata();

  const animated = (metadata.pages || 1) > 1;
  const totalPixels = (metadata.width || 0) * (metadata.height || 0);

  // Build processing pipeline
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
  } else if (req.opts.webp) {
    // Adaptive: huge images get lower effort or JPEG fallback
    if (totalPixels > 20_000_000) {
      // Extreme (800×25000+): JPEG — fast encode, no timeout
      res.setHeader('Content-Type', 'image/jpeg');
      instance
        .jpeg({ quality, progressive: true, mozjpeg: true })
        .pipe(res);
    } else if (totalPixels > 8_000_000) {
      // Tall strip (800×10000+): AVIF effort 2 — still small, much faster
      res.setHeader('Content-Type', 'image/avif');
      instance
        .avif({ quality, effort: 2 })
        .pipe(res);
    } else {
      // Normal page: AVIF effort 4 — best compression
      res.setHeader('Content-Type', 'image/avif');
      instance
        .avif({ quality, effort: 4 })
        .pipe(res);
    }
  } else {
    res.setHeader('Content-Type', 'image/jpeg');
    instance
      .jpeg({ quality, progressive: true, mozjpeg: true })
      .pipe(res);
  }
}

export default compress;
