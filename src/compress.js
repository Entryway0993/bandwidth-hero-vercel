import sharp from 'sharp';

// Sharp global config for serverless (1024MB RAM)
sharp.cache({ memory: 50, files: 0 });
sharp.concurrency(1);
sharp.simd(true);

// AVIF and WebP both cap at 16383px per dimension. JPEG handles up to 65535.
const MAX_CODEC_DIM = 16383;

async function compress(req, res, inputBuffer) {
  const { quality, grayscale } = req.opts;
  
  const instance = sharp(inputBuffer, {
    animated: true,
    limitInputPixels: 40_000_000, // 40MP: Safe ceiling for massive Manhwa strips
  });
  
  const metadata = await instance.metadata();
  const animated = (metadata.pages || 1) > 1;
  
  const outWidth = metadata.width || 0;
  const outHeight = metadata.height || 0;
  const maxDim = Math.max(outWidth, outHeight);
  const totalPixels = outWidth * outHeight;
  
  if (grayscale) {
    instance.grayscale();
  }
  
  instance.on('error', (err) => {
    if (!res.headersSent) res.status(500).end();
    else res.end();
  });
  
  // 🛑 THE CODEC TUNING: Maximum compression effort + 4:2:0 subsampling
  if (animated) {
    res.setHeader('Content-Type', 'image/webp');
    instance
      .webp({ quality, effort: 6, smartSubsample: true, animated: true })
      .pipe(res);
  } else if (req.opts.webp) {
    if (maxDim > MAX_CODEC_DIM || totalPixels > 30_000_000) {
      // Massive images -> JPEG (Mozjpeg + 4:2:0 subsampling)
      res.setHeader('Content-Type', 'image/jpeg');
      instance
        .jpeg({ quality, progressive: true, mozjpeg: true, chromaSubsampling: '4:2:0' })
        .pipe(res);
    } else if (totalPixels > 3_000_000) {
      // Tall strips -> AVIF Effort 5 (Balances CPU time vs Size)
      res.setHeader('Content-Type', 'image/avif');
      instance
        .avif({ quality, effort: 5, chromaSubsampling: '4:2:0' })
        .pipe(res);
    } else {
      // Normal pages -> AVIF Effort 6 (Maximum compression)
      res.setHeader('Content-Type', 'image/avif');
      instance
        .avif({ quality, effort: 6, chromaSubsampling: '4:2:0' })
        .pipe(res);
    }
  } else {
    res.setHeader('Content-Type', 'image/jpeg');
    instance
      .jpeg({ quality, progressive: true, mozjpeg: true, chromaSubsampling: '4:2:0' })
      .pipe(res);
  }
}

export default compress;
