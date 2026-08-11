import sharp from 'sharp';

// Sharp global config for serverless (1024MB RAM)
sharp.cache({ memory: 50, files: 0 });
sharp.concurrency(1);
sharp.simd(true);

// AVIF and WebP both cap at 16383px per dimension. JPEG handles up to 65535.
const MAX_CODEC_DIM = 16383;

/**
 * Compresses an image buffer based on request params.
 * Outputs directly to response.
 */
async function compress(req, res, inputBuffer) {
  const { quality, grayscale } = req.opts;
  
  // 🛑 SURGICAL FIX: Single instantiation to prevent double CPU parsing.
  const instance = sharp(inputBuffer, {
    animated: true,
    limitInputPixels: 40_000_000, // 40MP: Safe ceiling for massive Manhwa strips
  });
  
  // Get metadata (Sharp is the source of truth for animation)
  const metadata = await instance.metadata();
  
  const animated = (metadata.pages || 1) > 1;
  
  // Effective output dimensions (No resizing. What you see is what you get.)
  const outWidth = metadata.width || 0;
  const outHeight = metadata.height || 0;
  const maxDim = Math.max(outWidth, outHeight);
  const totalPixels = outWidth * outHeight;
  
  // 🛑 THE ENTROPY ENGINE: Calculate visual complexity to dynamically adjust quality
  let dynamicQuality = quality;
  try {
    // We use a separate lightweight instance for stats to prevent consuming the main pipeline stream
    const stats = await sharp(inputBuffer, { limitInputPixels: 40_000_000 }).stats();
    const entropy = stats.entropy; // Scale roughly 0 to 8
    
    if (entropy < 3.0) {
      // Low complexity (blank margins, simple gradients) -> Crush it to save bandwidth
      dynamicQuality = Math.max(15, Math.round(quality * 0.6));
    } else if (entropy > 6.5) {
      // High complexity (dense text, intricate line art) -> Protect it
      dynamicQuality = Math.min(85, Math.round(quality * 1.15));
    }
  } catch (err) {
    // If stats fail for any reason, fallback to requested quality silently
  }

  // Grayscale (default on — perfect for B&W manga)
  if (grayscale) {
    instance.grayscale();
  }
  
  // Catch encode errors so the function never hangs until timeout
  instance.on('error', (err) => {
    if (!res.headersSent) res.status(500).end();
    else res.end();
  });
  
  // Format selection + stream to response
  if (animated) {
    res.setHeader('Content-Type', 'image/webp');
    instance
      .webp({ quality: dynamicQuality, effort: 4, smartSubsample: true, animated: true })
      .pipe(res);
  } else if (req.opts.webp) {
    if (maxDim > MAX_CODEC_DIM || totalPixels > 30_000_000) {
      // Too tall/large for AVIF/WebP — JPEG is the only codec that fits
      res.setHeader('Content-Type', 'image/jpeg');
      instance
        .jpeg({ quality: dynamicQuality, progressive: true, mozjpeg: true })
        .pipe(res);
    } else if (totalPixels > 3_000_000) {
      // Tall strips (3M-30M, within codec limits): AVIF effort 2
      res.setHeader('Content-Type', 'image/avif');
      instance
        .avif({ quality: dynamicQuality, effort: 2 })
        .pipe(res);
    } else {
      // Normal pages (<3M): AVIF effort 4 — maximum compression
      res.setHeader('Content-Type', 'image/avif');
      instance
        .avif({ quality: dynamicQuality, effort: 4 })
        .pipe(res);
    }
  } else {
    res.setHeader('Content-Type', 'image/jpeg');
    instance
      .jpeg({ quality: dynamicQuality, progressive: true, mozjpeg: true })
      .pipe(res);
  }
}

export default compress;
