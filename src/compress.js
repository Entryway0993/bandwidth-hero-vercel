import sharp from 'sharp';

sharp.cache({ memory: 50, files: 0 });
sharp.concurrency(1);
sharp.simd(true);

const MAX_CODEC_DIM = 16383;

async function compress(req, res, inputBuffer) {
  const { quality, grayscale } = req.opts;
  
  const instance = sharp(inputBuffer, {
    animated: true,
    limitInputPixels: 40_000_000,
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
  
  if (animated) {
    // Animation: WebP is the only animated codec Sharp supports
    res.setHeader('Content-Type', 'image/webp');
    instance
      .webp({ quality, effort: 4, smartSubsample: true, animated: true })
      .pipe(res);
  } else if (req.opts.webp) {
    if (maxDim > MAX_CODEC_DIM || totalPixels > 30_000_000) {
      // Too tall/large for AVIF — JPEG is the only codec that fits
      res.setHeader('Content-Type', 'image/jpeg');
      instance
        .jpeg({ quality, progressive: true, mozjpeg: true, chromaSubsampling: '4:2:0' })
        .pipe(res);
    } else {
      // 🛑 COMPRESSION KING: AVIF effort 4 for everything that fits
      res.setHeader('Content-Type', 'image/avif');
      instance
        .avif({ quality, effort: 4, chromaSubsampling: '4:2:0' })
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
