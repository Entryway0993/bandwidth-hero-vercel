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
    if (totalPixels > 30_000_000) {
      // Extreme (30M+): JPEG — safety valve, never times out
      res.setHeader('Content-Type', 'image/jpeg');
      instance
        .jpeg({ quality, progressive: true, mozjpeg: true })
        .pipe(res);
    } else if (totalPixels > 3_000_000) {
      // Tall strips (3M-30M): AVIF effort 2 — best compression, still fast
      res.setHeader('Content-Type', 'image/avif');
      instance
        .avif({ quality, effort: 2 })
        .pipe(res);
    } else {
      // Normal pages (<3M): AVIF effort 4 — maximum compression
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
