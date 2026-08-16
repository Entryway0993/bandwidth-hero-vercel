import sharp from 'sharp';
import { createHash } from 'crypto';

const MAX_OUTPUT_DIM = parseInt(process.env.MAX_OUTPUT_DIM) || 2048;
const DEFAULT_QUALITY = parseInt(process.env.DEFAULT_QUALITY) || 75;
const ANIME_QUALITY = parseInt(process.env.ANIME_QUALITY) || 80;
const PHOTO_QUALITY = parseInt(process.env.PHOTO_QUALITY) || 70;
const MAX_STRIP_WIDTH = parseInt(process.env.MAX_STRIP_WIDTH) || 1200;
const MAX_ANIMATION_FRAMES = parseInt(process.env.MAX_ANIMATION_FRAMES) || 50;
const VIEWPORT_FALLBACK = parseInt(process.env.VIEWPORT_FALLBACK) || 1080;

const perceptualCache = new Map();
const PERCEPTUAL_CACHE_MAX = 500;

function envBool(name, fallback = false) {
  const v = process.env[name];
  if (v === undefined) return fallback;
  return v === '1' || v === 'true' || v === 'yes';
}

const ENABLE_AVIF = envBool('ENABLE_AVIF', true);
const ENABLE_WEBP = envBool('ENABLE_WEBP', true);
const FORCE_JPEG = envBool('FORCE_JPEG', false);
const FORCE_GRAYSCALE = envBool('FORCE_GRAYSCALE', false);
const STRIP_ALPHA = envBool('STRIP_ALPHA', true);
const ENABLE_PLACEHOLDER = envBool('ENABLE_PLACEHOLDER', true);
const ENABLE_JUDGE = envBool('ENABLE_JUDGE', true);
const ENABLE_MOIRE = envBool('ENABLE_MOIRE', true);
const ENABLE_LINE_DENOISE = envBool('ENABLE_LINE_DENOISE', true);
const ENABLE_LUMINANCE = envBool('ENABLE_LUMINANCE', true);

async function generatePerceptualHash(buffer) {
  try {
    const { data } = await sharp(buffer)
      .resize(8, 8, { fit: 'fill' })
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    let hash = '';
    const avg = data.reduce((sum, v) => sum + v, 0) / data.length;
    for (let i = 0; i < data.length; i++) {
      hash += data[i] > avg ? '1' : '0';
    }
    return createHash('md5').update(hash).digest('hex');
  } catch {
    return null;
  }
}

function checkPerceptualCache(hash) {
  if (!hash) return null;
  return perceptualCache.get(hash) || null;
}

function setPerceptualCache(hash, result) {
  if (!hash) return;
  if (perceptualCache.size >= PERCEPTUAL_CACHE_MAX) {
    const firstKey = perceptualCache.keys().next().value;
    perceptualCache.delete(firstKey);
  }
  perceptualCache.set(hash, result);
}

async function generatePlaceholder(buffer) {
  try {
    const thumb = await sharp(buffer)
      .resize(32, 32, { fit: 'inside' })
      .blur(2)
      .grayscale()
      .jpeg({ quality: 20 })
      .toBuffer();
    return 'data:image/jpeg;base64,' + thumb.toString('base64');
  } catch {
    return null;
  }
}

function judgeQuality(analysis, metadata) {
  const sharpness = analysis.sharpness || 0;
  const width = metadata.width || 0;
  const height = metadata.height || 0;
  const resolution = Math.max(width, height);
  const entropy = analysis.entropy || 0;

  let score = 0;

  if (sharpness > 80) score += 40;
  else if (sharpness > 60) score += 32;
  else if (sharpness > 40) score += 24;
  else if (sharpness > 25) score += 16;
  else if (sharpness > 15) score += 8;

  if (resolution > 2000) score += 30;
  else if (resolution > 1500) score += 24;
  else if (resolution > 1000) score += 18;
  else if (resolution > 700) score += 12;
  else if (resolution > 400) score += 6;

  if (entropy > 5 && entropy < 7) score += 30;
  else if (entropy > 4 && entropy < 8) score += 22;
  else if (entropy > 3 && entropy < 8.5) score += 14;
  else score += 6;

  let grade, qualityAdjust;
  if (score >= 85) { grade = 'S'; qualityAdjust = -10; }
  else if (score >= 70) { grade = 'A'; qualityAdjust = -5; }
  else if (score >= 55) { grade = 'B'; qualityAdjust = 0; }
  else if (score >= 40) { grade = 'C'; qualityAdjust = 5; }
  else if (score >= 25) { grade = 'D'; qualityAdjust = 10; }
  else { grade = 'F'; qualityAdjust = 15; }

  return { grade, qualityAdjust, score };
}

async function detectHalftone(buffer, metadata, analysis) {
  if (analysis.colorVariance > 50) {
    return { isHalftone: false, confidence: 0 };
  }

  try {
    const width = metadata.width;
    const height = metadata.height;
    const sampleSize = Math.min(200, Math.min(width, height));

    if (sampleSize < 32) {
      return { isHalftone: false, confidence: 0 };
    }

    const left = Math.floor((width - sampleSize) / 2);
    const top = Math.floor((height - sampleSize) / 2);

    const { data } = await sharp(buffer)
      .extract({ left, top, width: sampleSize, height: sampleSize })
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    let microSum = 0;
    let microCount = 0;
    for (let y = 0; y < sampleSize - 2; y += 3) {
      for (let x = 0; x < sampleSize - 2; x += 3) {
        let sum = 0;
        let sumSq = 0;
        for (let dy = 0; dy < 3; dy++) {
          for (let dx = 0; dx < 3; dx++) {
            const v = data[(y + dy) * sampleSize + (x + dx)];
            sum += v;
            sumSq += v * v;
          }
        }
        const mean = sum / 9;
        const variance = sumSq / 9 - mean * mean;
        microSum += variance;
        microCount++;
      }
    }
    const microVariance = microSum / Math.max(microCount, 1);

    let macroSum = 0;
    let macroCount = 0;
    const macroSize = Math.min(24, sampleSize);
    for (let y = 0; y < sampleSize - macroSize + 1; y += macroSize) {
      for (let x = 0; x < sampleSize - macroSize + 1; x += macroSize) {
        let sum = 0;
        let sumSq = 0;
        let count = 0;
        for (let dy = 0; dy < macroSize; dy++) {
          for (let dx = 0; dx < macroSize; dx++) {
            const v = data[(y + dy) * sampleSize + (x + dx)];
            sum += v;
            sumSq += v * v;
            count++;
          }
        }
        const mean = sum / count;
        const variance = sumSq / count - mean * mean;
        macroSum += variance;
        macroCount++;
      }
    }
    const macroVariance = macroSum / Math.max(macroCount, 1);

    const ratio = microVariance / Math.max(macroVariance, 1);
    const isHalftone = microVariance > 150 && macroVariance < 600 && ratio > 0.35;

    return {
      isHalftone,
      confidence: isHalftone ? 0.9 : 0.1,
      microVariance,
      macroVariance,
    };
  } catch {
    return { isHalftone: false, confidence: 0 };
  }
}

async function detectLineArt(buffer, analysis) {
  if (!analysis.isGrayscale) {
    return { isLineArt: false, confidence: 0 };
  }

  try {
    const { data } = await sharp(buffer)
      .resize(256, 256, { fit: 'inside' })
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const hist = new Array(256).fill(0);
    for (let i = 0; i < data.length; i++) {
      hist[data[i]]++;
    }

    const total = data.length;

    let darkPeak = 0;
    let lightPeak = 0;
    for (let i = 0; i <= 80; i++) darkPeak = Math.max(darkPeak, hist[i]);
    for (let i = 175; i <= 255; i++) lightPeak = Math.max(lightPeak, hist[i]);

    let middleSum = 0;
    for (let i = 100; i <= 155; i++) middleSum += hist[i];

    const darkRatio = darkPeak / total;
    const lightRatio = lightPeak / total;
    const middleRatio = middleSum / total;

    const isBimodal = darkRatio > 0.05 && lightRatio > 0.15 && middleRatio < 0.15;
    const isSharp = analysis.sharpness > 30;

    const isLineArt = isBimodal && isSharp;
    const confidence = isLineArt ? 0.93 : 0.1;

    return { isLineArt, confidence, darkRatio, lightRatio, middleRatio };
  } catch {
    return { isLineArt: false, confidence: 0 };
  }
}

async function detectImageType(buffer, metadata) {
  const stats = await sharp(buffer).stats();
  const { channels, width, height } = stats;

  let totalEntropy = 0;
  let totalSharpness = 0;
  let colorVariance = 0;
  let meanLuminance = 128;
  let stdevLuminance = 50;

  if (channels && channels.length > 0) {
    meanLuminance = channels[0].mean || 128;
    stdevLuminance = channels[0].stdev || 50;

    for (const ch of channels) {
      totalEntropy += ch.entropy || 0;
      totalSharpness += ch.sharpness || 0;
    }
    totalEntropy /= channels.length;
    totalSharpness /= channels.length;

    if (channels.length >= 3) {
      const rMean = channels[0].mean || 0;
      const gMean = channels[1].mean || 0;
      const bMean = channels[2].mean || 0;
      colorVariance = Math.abs(rMean - gMean) + Math.abs(gMean - bMean) + Math.abs(rMean - bMean);
    }
  }

  const isGrayscale = colorVariance < 15;
  const isHighContrast = totalEntropy > 6.5;
  const isColorful = colorVariance > 80;
  const aspectRatio = height / width;

  const isMangaStrip = aspectRatio > 2.5 && isGrayscale;
  const isMangaPage = aspectRatio > 1.2 && aspectRatio < 2.0 && isGrayscale;
  const isAnime = isColorful && totalSharpness > 100;

  return {
    isGrayscale,
    isHighContrast,
    isColorful,
    isMangaStrip,
    isMangaPage,
    isAnime,
    entropy: totalEntropy,
    sharpness: totalSharpness,
    colorVariance,
    aspectRatio,
    meanLuminance,
    stdevLuminance,
  };
}

function calculateQuality(analysis, baseQuality) {
  if (analysis.isAnime) return ANIME_QUALITY;
  if (analysis.isMangaStrip || analysis.isMangaPage) return Math.min(baseQuality + 10, 90);
  if (analysis.isGrayscale) return Math.min(baseQuality + 5, 85);
  if (analysis.entropy > 7.5) return PHOTO_QUALITY;
  return baseQuality;
}

function getViewportMaxDim(req) {
  const viewportWidth = parseInt(req.headers['sec-ch-viewport-width']) ||
                        parseInt(req.headers['viewport-width']) ||
                        VIEWPORT_FALLBACK;
  const dpr = parseFloat(req.headers['sec-ch-dpr']) ||
              parseFloat(req.headers['dpr']) || 1;
  const effectiveWidth = Math.round(viewportWidth * dpr);
  return Math.max(320, Math.min(effectiveWidth, MAX_OUTPUT_DIM));
}

function getChromaSubsampling(analysis) {
  if (analysis.isGrayscale) return '4:0:0';
  if (analysis.isColorful && analysis.sharpness > 80) return '4:4:4';
  if (analysis.isAnime) return '4:2:2';
  return '4:2:0';
}

export default async function compress(req, res, buffer) {
  try {
    const metadata = await sharp(buffer).metadata();
    const format = metadata.format;

    if (!format || format === 'raw') {
      return buffer;
    }

    const pHash = await generatePerceptualHash(buffer);
    const cachedResult = checkPerceptualCache(pHash);

    if (cachedResult) {
      res.setHeader('X-Perceptual-Cache', 'HIT');
      res.setHeader('Content-Type', cachedResult.contentType);
      if (cachedResult.placeholder) res.setHeader('X-Placeholder', cachedResult.placeholder);
      if (cachedResult.grade) res.setHeader('X-Quality-Grade', cachedResult.grade);
      return cachedResult.buffer;
    }

    const analysis = await detectImageType(buffer, metadata);
    const viewportMaxDim = getViewportMaxDim(req);

    let placeholder = null;
    if (ENABLE_PLACEHOLDER) {
      placeholder = await generatePlaceholder(buffer);
    }

    let judgeResult = null;
    if (ENABLE_JUDGE) {
      judgeResult = judgeQuality(analysis, metadata);
    }

    let halftoneResult = null;
    if (ENABLE_MOIRE) {
      halftoneResult = await detectHalftone(buffer, metadata, analysis);
    }

    let lineArtResult = null;
    if (ENABLE_LINE_DENOISE) {
      lineArtResult = await detectLineArt(buffer, analysis);
    }

    const requestedFormat = req.query.f || req.query.format;
    let outputFormat = 'jpeg';

    if (FORCE_JPEG) {
      outputFormat = 'jpeg';
    } else if (requestedFormat === 'avif' && ENABLE_AVIF) {
      outputFormat = 'avif';
    } else if (requestedFormat === 'webp' && ENABLE_WEBP) {
      outputFormat = 'webp';
    } else if (!requestedFormat) {
      const accept = req.headers.accept || '';
      if (ENABLE_AVIF && accept.includes('image/avif')) {
        outputFormat = 'avif';
      } else if (ENABLE_WEBP && accept.includes('image/webp')) {
        outputFormat = 'webp';
      }
    } else if (requestedFormat === 'jpeg' || requestedFormat === 'jpg') {
      outputFormat = 'jpeg';
    } else if (requestedFormat === 'png') {
      outputFormat = 'png';
    }

    const baseQuality = parseInt(req.query.q || req.query.quality) || DEFAULT_QUALITY;
    let quality = calculateQuality(analysis, baseQuality);

    if (judgeResult) {
      quality = Math.max(10, Math.min(95, quality + judgeResult.qualityAdjust));
    }

    const isAnimated = metadata.pages > 1;
    const frameCount = metadata.pages || 1;

    if (isAnimated && frameCount > MAX_ANIMATION_FRAMES) {
      res.setHeader('X-Frame-Cap', 'TRUNCATED');
      return buffer;
    }

    let pipeline = sharp(buffer, {
      animated: isAnimated,
      limitInputPixels: 268402689,
    });

    pipeline = pipeline.withMetadata({
      orientation: metadata.orientation || 1,
    });

    pipeline = pipeline.toColourspace('srgb');

    if (FORCE_GRAYSCALE || (analysis.isGrayscale && !analysis.isColorful)) {
      pipeline = pipeline.grayscale();
    }

    if (ENABLE_LUMINANCE && !isAnimated) {
      if (analysis.meanLuminance < 85 && analysis.stdevLuminance < 50) {
        pipeline = pipeline.gamma(1.4);
        res.setHeader('X-Luminance-Fix', 'UNDEREXPOSED');
      } else if (analysis.meanLuminance > 210 && analysis.stdevLuminance < 50) {
        pipeline = pipeline.gamma(0.7);
        res.setHeader('X-Luminance-Fix', 'OVEREXPOSED');
      }
    }

    if (halftoneResult && halftoneResult.isHalftone && halftoneResult.confidence > 0.85) {
      pipeline = pipeline.median(3);
      res.setHeader('X-Moire-Removed', 'true');
    }

    if (lineArtResult && lineArtResult.isLineArt && lineArtResult.confidence > 0.85) {
      pipeline = pipeline.median(3);
      pipeline = pipeline.sharpen({
        sigma: 0.6,
        flat: 3.0,
        jagged: 1.5,
      });
      res.setHeader('X-Line-Denoise', 'true');
    }

    let targetWidth = null;
    let targetHeight = null;

    const { width: origW, height: origH } = metadata;

    if (analysis.isMangaStrip) {
      if (origW > MAX_STRIP_WIDTH) {
        targetWidth = MAX_STRIP_WIDTH;
      }
    } else {
      if (origW > viewportMaxDim || origH > viewportMaxDim) {
        const scale = Math.min(viewportMaxDim / origW, viewportMaxDim / origH);
        targetWidth = Math.round(origW * scale);
        targetHeight = Math.round(origH * scale);
      }
    }

    if (targetWidth || targetHeight) {
      pipeline = pipeline.resize(targetWidth, targetHeight, {
        fit: 'inside',
        withoutEnlargement: true,
        kernel: sharp.kernel.lanczos3,
      });
    }

    if (analysis.sharpness < 50 && !analysis.isMangaStrip) {
      const alreadySharpened = lineArtResult && lineArtResult.isLineArt && lineArtResult.confidence > 0.85;
      if (!alreadySharpened) {
        pipeline = pipeline.sharpen({
          sigma: 0.8,
          flat: 2.0,
          jagged: 1.0,
        });
      }
    }

    if (STRIP_ALPHA && outputFormat === 'jpeg') {
      pipeline = pipeline.flatten({ background: { r: 255, g: 255, b: 255 } });
    }

    const chromaSubsampling = getChromaSubsampling(analysis);

    let outputBuffer;
    let contentType;

    switch (outputFormat) {
      case 'avif':
        outputBuffer = await pipeline.avif({
          quality: Math.min(quality, 63),
          effort: 4,
          chromaSubsampling: chromaSubsampling,
        }).toBuffer();
        contentType = 'image/avif';
        break;

      case 'webp':
        outputBuffer = await pipeline.webp({
          quality: quality,
          effort: 4,
          smartSubsample: true,
        }).toBuffer();
        contentType = 'image/webp';
        break;

      case 'png':
        outputBuffer = await pipeline.png({
          compressionLevel: 8,
          palette: analysis.isGrayscale,
          quality: quality,
        }).toBuffer();
        contentType = 'image/png';
        break;

      case 'jpeg':
      default:
        outputBuffer = await pipeline.jpeg({
          quality: quality,
          progressive: true,
          mozjpeg: true,
          chromaSubsampling: chromaSubsampling,
          trellisQuantisation: true,
          overshootDeringing: true,
          optimiseScans: true,
        }).toBuffer();
        contentType = 'image/jpeg';
        break;
    }

    if (outputBuffer.length >= buffer.length) {
      res.setHeader('X-Compression', 'SKIPPED');
      res.setHeader('Content-Type', `image/${format}`);
      if (placeholder) res.setHeader('X-Placeholder', placeholder);
      if (judgeResult) res.setHeader('X-Quality-Grade', judgeResult.grade);
      return buffer;
    }

    setPerceptualCache(pHash, {
      buffer: outputBuffer,
      contentType: contentType,
      placeholder: placeholder,
      grade: judgeResult ? judgeResult.grade : null,
    });

    res.setHeader('X-Perceptual-Cache', 'MISS');
    res.setHeader('Content-Type', contentType);
    res.setHeader('X-Compression-Ratio',
      ((1 - outputBuffer.length / buffer.length) * 100).toFixed(1) + '%');

    if (placeholder) {
      res.setHeader('X-Placeholder', placeholder);
    }

    if (judgeResult) {
      res.setHeader('X-Quality-Grade', judgeResult.grade);
      res.setHeader('X-Quality-Score', String(judgeResult.score));
    }

    res.setHeader('X-Image-Type', analysis.isMangaStrip ? 'manga-strip' :
      analysis.isMangaPage ? 'manga-page' :
      analysis.isAnime ? 'anime' :
      analysis.isGrayscale ? 'grayscale' : 'photo');

    return outputBuffer;

  } catch (err) {
    console.error('[COMPRESS ERROR]', err.message);
    res.setHeader('X-Compression', 'FAILED');
    return buffer;
  }
  }
