import { pipeline } from 'node:stream/promises';
import sharp from 'sharp';

sharp.cache({ memory: 100, files: 0 });
sharp.concurrency(1);
sharp.simd(true);

const MAX_CODEC_DIM = 16383;
const SHARP_PIXEL_LIMIT = 40_000_000;
const SMALL_PIXEL_LINE = 3_000_000;
const MID_PIXEL_LINE = 20_000_000;

function sendOriginal(req, res, inputBuffer) {
  try {
    if (!res.headersSent && !res.writableEnded) {
      const originType = req.opts?.originType || 'application/octet-stream';

      res.setHeader('Content-Type', originType);
      res.setHeader('Content-Length', inputBuffer.length);
      res.status(200).end(inputBuffer);
      return;
    }

    if (!res.writableEnded) {
      res.end();
    }
  } catch {
    try {
      if (!res.writableEnded) res.end();
    } catch {
      // Last resort: connection is already dead.
    }
  }
}

async function compress(req, res, inputBuffer) {
  let format = req.opts?.format;

  // Backward compatibility with older params.js using req.opts.webp
  if (!format) {
    format = req.opts?.webp === false ? 'jpeg' : 'webp';
  }

  if (!['avif', 'webp', 'jpeg'].includes(format)) {
    format = 'webp';
  }

  const quality = req.opts?.quality ?? 40;
  const grayscale = req.opts?.grayscale ?? false;

  try {
    const instance = sharp(inputBuffer, {
      animated: true,
      limitInputPixels: SHARP_PIXEL_LIMIT,
    });

    res.on('close', () => {
      if (!res.writableEnded) {
        instance.destroy?.();
      }
    });

    const metadata = await instance.metadata();
    const animated = (metadata.pages || 1) > 1;

    const outWidth = metadata.width || 0;
    const outHeight = metadata.height || 0;
    const maxDim = Math.max(outWidth, outHeight);
    const totalPixels = outWidth * outHeight;

    if (grayscale) instance.grayscale();

    if (animated) {
      res.setHeader('Content-Type', 'image/webp');
      await pipeline(
        instance.webp({ quality, effort: 4, smartSubsample: true, animated: true }),
        res
      );
      return;
    }

    if (format === 'avif' && maxDim <= MAX_CODEC_DIM) {
      res.setHeader('Content-Type', 'image/avif');

      if (totalPixels < SMALL_PIXEL_LINE) {
        await pipeline(
          instance.avif({ quality, effort: 4, chromaSubsampling: '4:2:0' }),
          res
        );
      } else if (totalPixels < MID_PIXEL_LINE) {
        await pipeline(
          instance.avif({ quality, effort: 3, chromaSubsampling: '4:2:0' }),
          res
        );
      } else {
        await pipeline(
          instance.avif({ quality, effort: 2, chromaSubsampling: '4:2:0' }),
          res
        );
      }

      return;
    }

    if (format === 'webp' && maxDim <= MAX_CODEC_DIM) {
      res.setHeader('Content-Type', 'image/webp');
      await pipeline(
        instance.webp({ quality, effort: 4, smartSubsample: true }),
        res
      );
      return;
    }

    // Safe fallback for JPEG, unsupported codec dimensions, or forced AVIF on huge images.
    res.setHeader('Content-Type', 'image/jpeg');
    await pipeline(
      instance.jpeg({ quality, progressive: true, mozjpeg: true, chromaSubsampling: '4:2:0' }),
      res
    );
  } catch (err) {
    // 🛑 SURGICAL FIX: If compression fails, serve the original image instead of dying with 500.
    sendOriginal(req, res, inputBuffer);
  }
}

export default compress;
