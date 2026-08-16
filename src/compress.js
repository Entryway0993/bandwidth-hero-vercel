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
  if (Number.isNaN(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function envFloat(name, fallback, min = 0.1, max = 3.0) {
  const n = parseFloat(process.env[name]);
  if (Number.isNaN(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

const AVIF_EFFORT_SMALL = envInt('AVIF_EFFORT_SMALL', 4);
const AVIF_EFFORT_MEDIUM = envInt('AVIF_EFFORT_MEDIUM', 3);
const AVIF_EFFORT_LARGE = envInt('AVIF_EFFORT_LARGE', 2);
const WEBP_EFFORT = envInt('WEBP_EFFORT', 4);

const SHARPEN_MODE = String(process.env.SHARPEN_MODE || 'resized').toLowerCase();
const SHARPEN_SIGMA = envFloat('SHARPEN_SIGMA', 0.8);

const MIN_QUALITY = envInt('MIN_QUALITY', 10, 1, 100);
const MAX_QUALITY = envInt('MAX_QUALITY', 100, 10, 100);

function sendOriginal(req, res, inputBuffer) {
  try {
    if (!res.headersSent && !res.writableEnded) {
      const originType = req.opts?.originType || 'application/octet-stream';
      res.setHeader('Content-Type', originType);
      res.setHeader('Content-Length', inputBuffer.length);
      res.status(200).end(inputBuffer);
      return;
    }
    if (!res.writableEnded) res.end();
  } catch {
    try {
      if (!res.writableEnded) res.end();
    } catch {}
  }
}

async function compress(req, res, inputBuffer) {
  let format = req.opts?.format;

  if (!format) {
    format = req.opts?.webp === false ? 'jpeg' : 'webp';
  }

  if (!['avif', 'webp', 'jpeg'].includes(format)) {
    format = 'webp';
  }

  const baseQuality = req.opts?.quality ?? 40;
  const grayscale = req.opts?.grayscale ?? false;
  const maxOutputDim = Number(req.opts?.maxDim) || 0;
  const maxStripWidth = Number(req.opts?.maxStripWidth) || 0;

  const sharpenQuery = req.query?.sharpen;
  let sharpenOverride;
  if (sharpenQuery === '1' || sharpenQuery === 'true' || sharpenQuery === 'on') sharpenOverride = true;
  if (sharpenQuery === '0' || sharpenQuery === 'false' || sharpenQuery === 'off') sharpenOverride = false;

  try {
    const instance = sharp(inputBuffer, {
      animated: true,
      limitInputPixels: SHARP_PIXEL_LIMIT
    });

    res.on('close', () => {
      if (!res.writableEnded) instance.destroy?.();
    });

    const metadata = await instance.metadata();
    const frameCount = metadata.pages || 1;
    const animated = frameCount > 1;

    let outWidth = metadata.width || 0;
    let outHeight = metadata.height || 0;
    const orientation = metadata.orientation || 1;

    // Swap dimensions for EXIF orientation 5-8
    if (!animated && orientation >= 5 && orientation <= 8) {
      const tmp = outWidth;
      outWidth = outHeight;
      outHeight = tmp;
    }

    const MAX_RAM_FOR_FRAMES = 700 * 1024 * 1024; 
    const pixelsPerFrame = Math.max(1, outWidth * outHeight);
    const dynamicFrameCap = Math.floor(MAX_RAM_FOR_FRAMES / (pixelsPerFrame * 4));
    const safeFrameCap = Math.max(1, Math.min(dynamicFrameCap, 1000));

    if (animated && frameCount > safeFrameCap) {
      return sendOriginal(req, res, inputBuffer);
    }

    const originalMaxDim = Math.max(outWidth, outHeight);
    const totalPixels = outWidth * outHeight;
    const isLongStrip = outHeight > outWidth * 3;

    // 🛑 AUTOMATIC EXIF ROTATION
    if (!animated && orientation > 1) {
      instance.rotate();
    }

    // 🛑 THE CMYK EXORCIST
    // Force the color space to sRGB and strip embedded ICC profiles.
    // This fixes radioactive/neon colors on mobile screens.
    if (!animated) {
      instance.toColorspace('srgb');
    }

    let estimatedPixels = totalPixels;
    let didResize = false;

    if (!animated) {
      if (isLongStrip) {
        if (maxStripWidth > 0 && outWidth > maxStripWidth) {
          instance.resize({ width: maxStripWidth, withoutEnlargement: true, kernel: 'lanczos3' });
          estimatedPixels = Math.round(totalPixels * (maxStripWidth / outWidth));
          didResize = true;
        }
      } else if (maxOutputDim > 0 && originalMaxDim > maxOutputDim) {
        instance.resize({ width: maxOutputDim, height: maxOutputDim, fit: 'inside', withoutEnlargement: true, kernel: 'lanczos3' });
        const scale = maxOutputDim / originalMaxDim;
        estimatedPixels = Math.round(totalPixels * scale * scale);
        didResize = true;
      }
    }

    let shouldSharpen = false;
    if (sharpenOverride !== undefined) {
      shouldSharpen = sharpenOverride;
    } else if (SHARPEN_MODE === 'always') {
      shouldSharpen = true;
    } else if (SHARPEN_MODE === 'resized') {
      shouldSharpen = didResize;
    }

    if (!animated && shouldSharpen) {
      instance.sharpen({ sigma: SHARPEN_SIGMA });
    }

    // 🛑 SMART GRAYSCALE DETECTION
    let skipGrayscaleConversion = false;
    if (grayscale && !animated) {
      const isAlreadyGrayscale = metadata.channels === 1 || metadata.space === 'b-w' || metadata.space === 'gray';
      
      if (isAlreadyGrayscale) {
        skipGrayscaleConversion = true;
      } else if (metadata.channels >= 3) {
        try {
          const thumbStats = await sharp(inputBuffer).resize(50, 50, { fit: 'inside' }).stats();
          const r = thumbStats.channels[0].mean;
          const g = thumbStats.channels[1].mean;
          const b = thumbStats.channels[2].mean;
          const maxDiff = Math.max(Math.abs(r - g), Math.abs(g - b), Math.abs(r - b));
          if (maxDiff < 3.0) skipGrayscaleConversion = true;
        } catch {}
      }
    }

    if (grayscale && !skipGrayscaleConversion) {
      instance.grayscale();
    }

    const needsFlatten = !animated && metadata.hasAlpha && format === 'jpeg';
    if (needsFlatten) {
      instance.flatten({ background: { r: 255, g: 255, b: 255 } });
    }

    const megapixels = estimatedPixels / 1_000_000;
    let dynamicQuality = baseQuality;
    if (!animated) {
      if (megapixels < 1) {
        dynamicQuality = Math.min(baseQuality + 20, MAX_QUALITY);
      } else if (megapixels > 4) {
        dynamicQuality = Math.max(baseQuality - 10, MIN_QUALITY);
      }
    }

    let effectiveMaxDim = originalMaxDim;
    if (!animated) {
      if (isLongStrip) {
        effectiveMaxDim = outHeight;
      } else if (maxOutputDim > 0 && originalMaxDim > maxOutputDim) {
        effectiveMaxDim = maxOutputDim;
      }
    }

    if (animated) {
      res.setHeader('Content-Type', 'image/webp');
      await pipeline(
        instance.webp({ quality: baseQuality, effort: WEBP_EFFORT, smartSubsample: true, animated: true }),
        res
      );
      return;
    }

    if (format === 'avif' && effectiveMaxDim <= MAX_CODEC_DIM) {
      res.setHeader('Content-Type', 'image/avif');
      let effort = AVIF_EFFORT_LARGE;
      if (estimatedPixels < SMALL_PIXEL_LINE) effort = AVIF_EFFORT_SMALL;
      else if (estimatedPixels < MID_PIXEL_LINE) effort = AVIF_EFFORT_MEDIUM;

      await pipeline(
        instance.avif({ quality: dynamicQuality, effort, chromaSubsampling: '4:2:0' }),
        res
      );
      return;
    }

    if (format === 'webp' && effectiveMaxDim <= MAX_CODEC_DIM) {
      res.setHeader('Content-Type', 'image/webp');
      await pipeline(
        instance.webp({ quality: dynamicQuality, effort: WEBP_EFFORT, smartSubsample: true }),
        res
      );
      return;
    }

    res.setHeader('Content-Type', 'image/jpeg');
    await pipeline(
      instance.jpeg({ quality: dynamicQuality, progressive: true, mozjpeg: true, chromaSubsampling: '4:2:0' }),
      res
    );
  } catch {
    sendOriginal(req, res, inputBuffer);
  }
}

export default compress;
