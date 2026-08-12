import { pipeline } from 'node:stream/promises';
import sharp from 'sharp';

// 🛑 1GB RAM CONSTRAINT: Strict limits to prevent OOM kills
sharp.cache({ memory: 100, files: 0 }); // Capped at 100MB (10% of total RAM)
sharp.concurrency(1); // MANDATORY: Force single-threaded processing to save RAM
sharp.simd(true);

// AVIF/WebP codec hard wall: 16383px per dimension. JPEG goes to 65535.
const MAX_CODEC_DIM = 16383;
// 🛑 Sharp's absolute ceiling. Anything over this throws before we even encode.
const SHARP_PIXEL_LIMIT = 40_000_000;
// 🛑 Below this → effort 4 (small, safe to max out)
const SMALL_PIXEL_LINE = 3_000_000;
// 🛑 Below this (and above small) → effort 3. Above this → effort 2.
const MID_PIXEL_LINE = 20_000_000;

async function compress(req, res, inputBuffer) {
  const { quality, grayscale } = req.opts;
  
  const instance = sharp(inputBuffer, {
    animated: true,
    limitInputPixels: SHARP_PIXEL_LIMIT,
  });
  
  const metadata = await instance.metadata();
  const animated = (metadata.pages || 1) > 1;
  
  const outWidth = metadata.width || 0;
  const outHeight = metadata.height || 0;
  const maxDim = Math.max(outWidth, outHeight);
  const totalPixels = outWidth * outHeight;
  
  if (grayscale) instance.grayscale();
  
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
    if (maxDim > MAX_CODEC_DIM) {
      // Only the hard codec dimension wall forces JPEG now
      res.setHeader('Content-Type', 'image/jpeg');
      instance
        .jpeg({ quality, progressive: true, mozjpeg: true, chromaSubsampling: '4:2:0' })
        .pipe(res);
    } else if (totalPixels < SMALL_PIXEL_LINE) {
      // 🛑 SMALL: effort 4 — fast enough to max out
      res.setHeader('Content-Type', 'image/avif');
      instance
        .avif({ quality, effort: 4, chromaSubsampling: '4:2:0' })
        .pipe(res);
    } else if (totalPixels < MID_PIXEL_LINE) {
      // 🛑 MEDIUM: effort 3 — balance of squeeze and speed
      res.setHeader('Content-Type', 'image/avif');
      instance
        .avif({ quality, effort: 3, chromaSubsampling: '4:2:0' })
        .pipe(res);
    } else {
      // 🛑 LARGE (20MP → 40MP): effort 2 — the survival gamble at Sharp's ceiling
      res.setHeader('Content-Type', 'image/avif');
      instance
        .avif({ quality, effort: 2, chromaSubsampling: '4:2:0' })
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
