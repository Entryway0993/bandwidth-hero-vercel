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

// 🛑 THE VECTOR EXORCIST (SVG Sanitization)
function sanitizeSvg(buffer) {
  try {
    let svgStr = buffer.toString('utf8');
    // Remove <script> tags
    svgStr = svgStr.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
    // Remove on* attributes (e.g., onload="...", onclick="...")
    svgStr = svgStr.replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
    // Remove javascript: protocol
    svgStr = svgStr.replace(/javascript:/gi, '');
    return Buffer.from(svgStr, 'utf8');
  } catch {
    return buffer;
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

  // 🛑 THE VECTOR EXORCIST (Sanitize SVGs before processing)
  let safeBuffer = inputBuffer;
  if (req.opts.originType === 'image/svg+xml') {
    safeBuffer = sanitizeSvg(inputBuffer);
  }

  try {
    const instance = sharp(safeBuffer, {
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
    if (!animated) {
      instance.toColorspace('srgb');
    }

    // 🛑 THE MOIRÉ EXORCIST (Halftone Descreening)
    if (!animated && (outWidth > 2000 || outHeight > 2000)) {
      instance.median(1);
    }

    let estimatedPixels = totalPixels;
    let didResize = false;
    let resizeScale = 1;

    if (!animated) {
      if (isLongStrip) {
        if (maxStripWidth > 0 && outWidth > maxStripWidth) {
          instance.resize({ width: maxStripWidth, withoutEnlargement: true, kernel: 'lanczos3' });
          resizeScale = maxStripWidth / outWidth;
          estimatedPixels = Math.round(totalPixels * resizeScale * resizeScale);
          didResize = true;
        }
      } else if (maxOutputDim > 0 && originalMaxDim > maxOutputDim) {
        instance.resize({ width: maxOutputDim, height: maxOutputDim, fit: 'inside', withoutEnlargement: true, kernel: 'lanczos3' });
        resizeScale = maxOutputDim / originalMaxDim;
        estimatedPixels = Math.round(totalPixels * resizeScale * resizeScale);
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
      // 🛑 THE SMART SHARPEN RADIUS
      let sigma = SHARPEN_SIGMA;
      if (didResize && resizeScale < 1) {
        sigma = Math.min(Math.max(SHARPEN_SIGMA / resizeScale, 0.5), 2.5);
      }
      instance.sharpen({ sigma });
    }

    // 🛑 SMART GRAYSCALE DETECTION
    let skipGrayscaleConversion = false;
    if (grayscale && !animated) {
      const isAlreadyGrayscale = metadata.channels === 1 || metadata.space === 'b-w' || metadata.space === 'gray';
      
      if (isAlreadyGrayscale) {
        skipGrayscaleConversion = true;
      } else if (metadata.channels >= 3) {
        try {
          const thumbStats = await sharp(safeBuffer).resize(50, 50, { fit: 'inside' }).stats();
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

    // 🛑 THE CHROMA GUILLOTINE (Dynamic Subsampling)
    let chromaSubsampling = '4:2:0';
    if (!animated && metadata.channels >= 3) {
      try {
        const chromaStats = await sharp(safeBuffer).stats();
        if (chromaStats.channels.length >= 3) {
          const rStdev = chromaStats.channels[0].stdev;
          const gStdev = chromaStats.channels[1].stdev;
          const bStdev = chromaStats.channels[2].stdev;
          const maxStdev = Math.max(rStdev, gStdev, bStdev);
          
          // High color variance suggests text/graphics that need full color resolution
          if (maxStdev > 50) {
            chromaSubsampling = '4:4:4';
          }
        }
      } catch {}
    }

    const needsFlatten = !animated && metadata.hasAlpha && format === 'jpeg';
    if (needsFlatten) {
      instance.flatten({ background: { r: 255, g: 255, b: 255 } });
    }

    // 🛑 THE ENTROPY GUILLOTINE (Complexity-Based Quality)
    let entropyAdjustment = 0;
    if (!animated) {
      try {
        const entropyStats = await sharp(safeBuffer).stats();
        const avgStdev = entropyStats.channels.reduce((sum, ch) => sum + ch.stdev, 0) / entropyStats.channels.length;
        
        // Simple image (mostly white/blank): reduce quality
        // Complex image (detailed/noisy): increase quality
        if (avgStdev < 30) {
          entropyAdjustment = -20;
        } else if (avgStdev > 60) {
          entropyAdjustment = 15;
        }
      } catch {}
    }

    const megapixels = estimatedPixels / 1_000_000;
    let dynamicQuality = baseQuality + entropyAdjustment;
    if (!animated) {
      if (megapixels < 1) {
        dynamicQuality += 20;
      } else if (megapixels > 4) {
        dynamicQuality -= 10;
      }
    }
    dynamicQuality = Math.max(MIN_QUALITY, Math.min(dynamicQuality, MAX_QUALITY));

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

    // 🛑 THE PANIC ENCODER (JPEG Last Resort)
    try {
      if (format === 'avif' && effectiveMaxDim <= MAX_CODEC_DIM) {
        res.setHeader('Content-Type', 'image/avif');
        let effort = AVIF_EFFORT_LARGE;
        if (estimatedPixels < SMALL_PIXEL_LINE) effort = AVIF_EFFORT_SMALL;
        else if (estimatedPixels < MID_PIXEL_LINE) effort = AVIF_EFFORT_MEDIUM;

        await pipeline(
          instance.avif({ quality: dynamicQuality, effort, chromaSubsampling }),
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
        instance.jpeg({ quality: dynamicQuality, progressive: true, mozjpeg: true, chromaSubsampling }),
        res
      );
    } catch (encodeError) {
      // If AVIF/WebP encoding fails, fall back to JPEG instead of sending the raw original
      if (!res.headersSent) {
        try {
          res.setHeader('Content-Type', 'image/jpeg');
          await pipeline(
            instance.jpeg({ quality: dynamicQuality, progressive: true, mozjpeg: true, chromaSubsampling: '4:2:0' }),
            res
          );
          return;
        } catch {
          // If JPEG also fails, fall through to sendOriginal
        }
      }
      sendOriginal(req, res, inputBuffer);
    }
  } catch {
    sendOriginal(req, res, inputBuffer);
  }
}

export default compress;
