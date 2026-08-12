import { pipeline } from 'node:stream/promises';
import sharp from 'sharp';

sharp.cache({ memory: 100, files: 0 });
sharp.concurrency(1);
sharp.simd(true);

const MAX_CODEC_DIM = 16383;
const SHARP_PIXEL_LIMIT = 40_000_000;
const SMALL_PIXEL_LINE = 3_000_000;
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
  
  res.on('close', () => {
    if (!res.writableEnded) {
      instance.destroy?.(); 
    }
  });

  try {
    if (animated) {
      res.setHeader('Content-Type', 'image/webp');
      await pipeline(
        instance.webp({ quality, effort: 4, smartSubsample: true, animated: true }),
        res
      );
    } else if (req.opts.webp) {
      if (maxDim > MAX_CODEC_DIM) {
        res.setHeader('Content-Type', 'image/jpeg');
        await pipeline(
          instance.jpeg({ quality, progressive: true, mozjpeg: true, chromaSubsampling: '4:2:0' }),
          res
        );
      } else if (totalPixels < SMALL_PIXEL_LINE) {
        res.setHeader('Content-Type', 'image/avif');
        await pipeline(
          instance.avif({ quality, effort: 4, chromaSubsampling: '4:2:0' }),
          res
        );
      } else if (totalPixels < MID_PIXEL_LINE) {
        res.setHeader('Content-Type', 'image/avif');
        await pipeline(
          instance.avif({ quality, effort: 3, chromaSubsampling: '4:2:0' }),
          res
        );
      } else {
        res.setHeader('Content-Type', 'image/avif');
        await pipeline(
          instance.avif({ quality, effort: 2, chromaSubsampling: '4:2:0' }),
          res
        );
      }
    } else {
      res.setHeader('Content-Type', 'image/jpeg');
      await pipeline(
        instance.jpeg({ quality, progressive: true, mozjpeg: true, chromaSubsampling: '4:2:0' }),
        res
      );
    }
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).end();
    } else {
      res.end();
    }
  }
}

export default compress;
