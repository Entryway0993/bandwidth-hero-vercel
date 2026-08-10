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
  // 🛑 SURGICAL FIX: Lowered limitInputPixels to 20MP (~80MB RAM) to prevent serverless OOM DoS.
  const instance = sharp(inputBuffer, {
    animated: true,
    limitInputPixels: 20_000_000,
  });
  
  // Get metadata (Sharp is the source of truth for animation)
  const metadata = await instance.metadata();
  
  const animated = (metadata.pages || 1) > 1;
  
  // Effective output dimensions (No resizing. What you see is what you get.)
  const outWidth = metadata.width || 0;
  const outHeight = metadata.height || 0;
  const maxDim = Math.max(outWidth, outHeight);
  const totalPixels = outWidth * outHeight;
  
  // Grayscale (default on — perfect for B&W manga)
  if (grayscale) {
    instance.grayscale();
  }
  
  // 🛑 DEAD CODE PURGED: The resizing logic has been executed.
  
  // Catch encode errors so the function never hangs until timeout
  instance.on('error', (err) => {
    console.error('❌ Sharp encode error:', err.message);
    if (!res.headersSent) res.status(500).end();
    else res.end();
  });
  
  // Format selection + stream to response
  if (animated) {
    res.setHeader('Content-Type', 'image/webp');
    instance
      .webp({ quality, effort: 4, smartSubsample: true, animated: true })
      .pipe(res);
  } else if (req.opts.webp) {
    if (maxDim > MAX_CODEC_DIM || totalPixels > 30_000_000) {
      // Too tall/large for AVIF/WebP — JPEG is the only codec that fits
      res.setHeader('Content-Type', 'image/jpeg');
      instance
        .jpeg({ quality, progressive: true, mozjpeg: true })
        .pipe(res);
    } else if (totalPixels > 3_000_000) {
      // Tall strips (3M-30M, within codec limits): AVIF effort 2
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