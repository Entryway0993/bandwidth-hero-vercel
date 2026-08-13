import { pipeline } from 'node:stream/promises';
import sharp from 'sharp';

sharp.cache({ memory: 100, files: 0 });
sharp.concurrency(1);
sharp.simd(true);

const MAX_CODEC_DIM = 16383;
const SHARP_PIXEL_LIMIT = 40_000_000;
const SMALL_PIXEL_LINE = 3_000_000;
const MID_PIXEL_LINE = 20_000_000;

function envInt(name, fallback, min = 0, max = 9) {
  const n = parseInt(process.env[name], 10);

  if (Number.isNaN(n)) {
    return fallback;
  }

  return Math.min(Math.max(n, min), max);
}

// Heavier AVIF blade.
const AVIF_EFFORT_SMALL = envInt('AVIF_EFFORT_SMALL', 4);
const AVIF_EFFORT_MEDIUM = envInt('AVIF_EFFORT_MEDIUM', 3);
const AVIF_EFFORT_LARGE = envInt('AVIF_EFFORT_LARGE', 2);
const WEBP_EFFORT = envInt('WEBP_EFFORT', 4);

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
      // Connection is already dead.
    }
  }
}

async function compress(req, res, inputBuffer) {
  let format = req.opts?.format;

  // Backward compatibility with older params.js using req.opts.webp.
  if (!format) {
    format = req.opts?.webp === false ? 'jpeg' : 'webp';
  }

  if (!['avif', 'webp', 'jpeg'].includes(format)) {
    format = 'webp';
  }

  const quality = req.opts?.quality ?? 40;
  const grayscale = req.opts?.grayscale ?? false;

  // Normal images cap.
  const maxOutputDim = Number(req.opts?.maxDim) || 0;

  // Manga/manhwa/manhua long strip width cap.
  const maxStripWidth = Number(req.opts?.maxStripWidth) || 0;

  try {
    const instance = sharp(inputBuffer, {
      animated: true,
      limitInputPixels: SHARP_PIXEL_LIMIT
    });

    res.on('close', () => {
      if (!res.writableEnded) {
        instance.destroy?.();
      }
    });

    const metadata = await instance.metadata();
    const animated = (metadata.pages || 1) > 1;

    let outWidth = metadata.width || 0;
    let outHeight = metadata.height || 0;
    const orientation = metadata.orientation || 1;

    // If EXIF says the image is rotated 90/270, swap effective dimensions.
    if (!animated && orientation >= 5 && orientation <= 8) {
      const tmp = outWidth;
      outWidth = outHeight;
      outHeight = tmp;
    }

    const originalMaxDim = Math.max(outWidth, outHeight);
    const totalPixels = outWidth * outHeight;

    // Long vertical comic strip detection.
    const isLongStrip = outHeight > outWidth * 3;

    // EXIF auto-rotate for static images.
    if (!animated && orientation > 1) {
      instance.rotate();
    }

    let estimatedPixels = totalPixels;

    if (!animated) {
      if (isLongStrip) {
        // 🛑 MANGA / MANHWA / MANHUA MODE:
        // Cap width only. Never crush the height.
        if (maxStripWidth > 0 && outWidth > maxStripWidth) {
          instance.resize({
            width: maxStripWidth,
            withoutEnlargement: true,
            kernel: 'lanczos3'
          });

          estimatedPixels = Math.round(totalPixels * (maxStripWidth / outWidth));
        }
      } else if (maxOutputDim > 0 && originalMaxDim > maxOutputDim) {
        // 🛑 NORMAL IMAGE MODE:
        // Cap max side, keep aspect ratio.
        instance.resize({
          width: maxOutputDim,
          height: maxOutputDim,
          fit: 'inside',
          withoutEnlargement: true,
          kernel: 'lanczos3'
        });

        const scale = maxOutputDim / originalMaxDim;
        estimatedPixels = Math.round(totalPixels * scale * scale);
      }
    }

    if (grayscale) {
      instance.grayscale();
    }

    let effectiveMaxDim = originalMaxDim;

    if (!animated) {
      if (isLongStrip) {
        // Width-only resize does not reduce height.
        effectiveMaxDim = outHeight;
      } else if (maxOutputDim > 0 && originalMaxDim > maxOutputDim) {
        effectiveMaxDim = maxOutputDim;
      }
    }

    if (animated) {
      res.setHeader('Content-Type', 'image/webp');

      await pipeline(
        instance.webp({
          quality,
          effort: WEBP_EFFORT,
          smartSubsample: true,
          animated: true
        }),
        res
      );

      return;
    }

    if (format === 'avif' && effectiveMaxDim <= MAX_CODEC_DIM) {
      res.setHeader('Content-Type', 'image/avif');

      let effort = AVIF_EFFORT_LARGE;

      if (estimatedPixels < SMALL_PIXEL_LINE) {
        effort = AVIF_EFFORT_SMALL;
      } else if (estimatedPixels < MID_PIXEL_LINE) {
        effort = AVIF_EFFORT_MEDIUM;
      }

      await pipeline(
        instance.avif({
          quality,
          effort,
          chromaSubsampling: '4:2:0'
        }),
        res
      );

      return;
    }

    if (format === 'webp' && effectiveMaxDim <= MAX_CODEC_DIM) {
      res.setHeader('Content-Type', 'image/webp');

      await pipeline(
        instance.webp({
          quality,
          effort: WEBP_EFFORT,
          smartSubsample: true
        }),
        res
      );

      return;
    }

    // Safe fallback for JPEG, huge dimensions, or unsupported codec cases.
    res.setHeader('Content-Type', 'image/jpeg');

    await pipeline(
      instance.jpeg({
        quality,
        progressive: true,
        mozjpeg: true,
        chromaSubsampling: '4:2:0'
      }),
      res
    );
  } catch {
    // If compression fails, serve the original image instead of dying.
    sendOriginal(req, res, inputBuffer);
  }
}

export default compress;
