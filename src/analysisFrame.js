// src/analysisFrame.js
// Long-term fix for redundant Sharp decoding.
// Builds one reusable raw analysis frame and derives heuristics from it.

import sharp from 'sharp';
import { createHash } from 'node:crypto';

const ANALYSIS_FRAME_MAX_DIM =
  parseInt(process.env.ANALYSIS_FRAME_MAX_DIM, 10) || 2048;

function rawSharp(frame) {
  return sharp(frame.data, {
    raw: {
      width: frame.width,
      height: frame.height,
      channels: frame.channels
    }
  });
}

export async function buildAnalysisContext(buffer, metadata = {}) {
  try {
    const maxDim = Math.max(metadata.width || 0, metadata.height || 0);
    const targetDim = Math.min(
      ANALYSIS_FRAME_MAX_DIM,
      maxDim || ANALYSIS_FRAME_MAX_DIM
    );

    const { data, info } = await sharp(buffer, {
      animated: false,
      limitInputPixels: 0
    })
      .resize(targetDim, targetDim, {
        fit: 'inside',
        withoutEnlargement: true
      })
      .toColourspace('srgb')
      .raw()
      .toBuffer({ resolveWithObject: true });

    if (info.channels !== 3 && info.channels !== 4) {
      return null;
    }

    return {
      data,
      width: info.width,
      height: info.height,
      channels: info.channels
    };
  } catch {
    return null;
  }
}

export async function detectImageTypeFromFrame(frame, metadata = {}) {
  if (!frame) return null;

  try {
    let pipeline = rawSharp(frame);

    if (frame.channels === 4) {
      pipeline = pipeline.removeAlpha();
    }

    const stats = await pipeline.stats();
    const { channels, width, height } = stats;

    let totalEntropy = 0;
    let totalSharpness = 0;
    let colorVariance = 0;
    let meanLuminance = 128;
    let stdevLuminance = 50;
    let maxLuminance = 255;

    if (channels && channels.length > 0) {
      meanLuminance = channels[0].mean || 128;
      stdevLuminance = channels[0].stdev || 50;
      maxLuminance = channels[0].max || 255;

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

        colorVariance =
          Math.abs(rMean - gMean) +
          Math.abs(gMean - bMean) +
          Math.abs(rMean - bMean);
      }
    }

    const isGrayscale = colorVariance < 15;
    const isHighContrast = totalEntropy > 6.5;
    const isColorful = colorVariance > 80;

    const metaW = metadata.width || width || 0;
    const metaH = metadata.height || height || 0;
    const aspectRatio = metaH / Math.max(metaW, 1);

    const isMangaStrip = aspectRatio > 2.5;
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
      maxLuminance
    };
  } catch {
    return null;
  }
}

export async function generatePerceptualHashFromFrame(frame) {
  if (!frame) return null;

  try {
    let pipeline = rawSharp(frame);

    if (frame.channels === 4) {
      pipeline = pipeline.removeAlpha();
    }

    const { data } = await pipeline
      .resize(8, 8, { fit: 'fill' })
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    if (!data || data.length === 0) return null;

    const avg = data.reduce((sum, v) => sum + v, 0) / data.length;

    let hash = '';

    for (let i = 0; i < data.length; i++) {
      hash += data[i] > avg ? '1' : '0';
    }

    return createHash('md5').update(hash).digest('hex');
  } catch {
    return null;
  }
}

export async function generatePlaceholderAndPaletteFromFrame(frame) {
  const fallback = {
    placeholder: null,
    palette: [],
    stdev: 0,
    isVoid: false
  };

  if (!frame) return fallback;

  try {
    let pipeline = rawSharp(frame);

    if (frame.channels === 4) {
      pipeline = pipeline.flatten({
        background: { r: 255, g: 255, b: 255 }
      });
    } else {
      pipeline = pipeline.removeAlpha();
    }

    const { data, info } = await pipeline
      .resize(32, 32, { fit: 'inside' })
      .toColourspace('srgb')
      .raw()
      .toBuffer({ resolveWithObject: true });

    const channels = info.channels;

    if (channels < 3) {
      return fallback;
    }

    let sum = 0;
    let sumSq = 0;

    const pixelCount = data.length / channels;
    const colorCounts = new Map();

    for (let i = 0; i < data.length; i += channels) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];

      const lum = 0.299 * r + 0.587 * g + 0.114 * b;

      sum += lum;
      sumSq += lum * lum;

      const colorKey = (r << 16) | (g << 8) | b;
      colorCounts.set(colorKey, (colorCounts.get(colorKey) || 0) + 1);
    }

    const mean = sum / pixelCount;
    const stdev = Math.sqrt(Math.max(0, sumSq / pixelCount - mean * mean));
    const isVoid = stdev < 1;

    let palette = [];

    if (!isVoid) {
      const sorted = [...colorCounts.entries()].sort((a, b) => b[1] - a[1]);

      palette = sorted.slice(0, 3).map(([colorKey]) => {
        const hex = colorKey.toString(16).padStart(6, '0');
        return `#${hex}`;
      });
    }

    let placeholder = null;

    try {
      const thumbBuffer = await sharp(data, {
        raw: {
          width: info.width,
          height: info.height,
          channels
        }
      })
        .blur(2)
        .grayscale()
        .jpeg({ quality: 20 })
        .toBuffer();

      placeholder =
        'data:image/jpeg;base64,' + thumbBuffer.toString('base64');
    } catch {
      placeholder = null;
    }

    return {
      placeholder,
      palette,
      stdev,
      isVoid
    };
  } catch {
    return fallback;
  }
}

export async function detectSkewFromFrame(frame) {
  if (!frame) return 0;

  try {
    let pipeline = rawSharp(frame);

    if (frame.channels === 4) {
      pipeline = pipeline.removeAlpha();
    }

    const { data, info } = await pipeline
      .resize(256, 256, {
        fit: 'inside',
        withoutEnlargement: true
      })
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const w = info.width;
    const h = info.height;

    if (!w || !h || data.length < w * h) return 0;

    const corners = [
      data[0],
      data[w - 1],
      data[(h - 1) * w],
      data[h * w - 1]
    ];

    const bgValue = corners.reduce((a, b) => a + b, 0) / 4;

    let sumX = 0;
    let sumY = 0;
    let sumXX = 0;
    let sumYY = 0;
    let sumXY = 0;
    let count = 0;

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const v = data[y * w + x];

        if (Math.abs(v - bgValue) > 30) {
          sumX += x;
          sumY += y;
          sumXX += x * x;
          sumYY += y * y;
          sumXY += x * y;
          count++;
        }
      }
    }

    if (count < 100) return 0;

    const meanX = sumX / count;
    const meanY = sumY / count;

    const covXX = sumXX / count - meanX * meanX;
    const covYY = sumYY / count - meanY * meanY;
    const covXY = sumXY / count - meanX * meanY;

    const angle =
      0.5 * Math.atan2(2 * covXY, covXX - covYY) * (180 / Math.PI);

    if (Math.abs(angle) > 1.5 && Math.abs(angle) < 15) {
      return angle;
    }

    return 0;
  } catch {
    return 0;
  }
}

export async function detectHalftoneFromFrame(frame, analysis) {
  if (!frame || !analysis || analysis.colorVariance > 50) {
    return {
      isHalftone: false,
      confidence: 0
    };
  }

  try {
    const width = frame.width;
    const height = frame.height;

    const sampleSize = Math.min(200, Math.min(width, height));

    if (sampleSize < 32) {
      return {
        isHalftone: false,
        confidence: 0
      };
    }

    const left = Math.floor((width - sampleSize) / 2);
    const top = Math.floor((height - sampleSize) / 2);

    let pipeline = rawSharp(frame);

    if (frame.channels === 4) {
      pipeline = pipeline.removeAlpha();
    }

    const { data } = await pipeline
      .extract({
        left,
        top,
        width: sampleSize,
        height: sampleSize
      })
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

    const isHalftone =
      microVariance > 150 &&
      macroVariance < 600 &&
      ratio > 0.35;

    return {
      isHalftone,
      confidence: isHalftone ? 0.9 : 0.1,
      microVariance,
      macroVariance
    };
  } catch {
    return {
      isHalftone: false,
      confidence: 0
    };
  }
}

export async function detectLineArtFromFrame(frame, analysis) {
  if (!frame || !analysis || !analysis.isGrayscale) {
    return {
      isLineArt: false,
      confidence: 0
    };
  }

  try {
    let pipeline = rawSharp(frame);

    if (frame.channels === 4) {
      pipeline = pipeline.removeAlpha();
    }

    const { data } = await pipeline
      .resize(256, 256, {
        fit: 'inside',
        withoutEnlargement: true
      })
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

    for (let i = 0; i <= 80; i++) {
      darkPeak = Math.max(darkPeak, hist[i]);
    }

    for (let i = 175; i <= 255; i++) {
      lightPeak = Math.max(lightPeak, hist[i]);
    }

    let middleSum = 0;

    for (let i = 100; i <= 155; i++) {
      middleSum += hist[i];
    }

    const darkRatio = darkPeak / total;
    const lightRatio = lightPeak / total;
    const middleRatio = middleSum / total;

    const isBimodal =
      darkRatio > 0.05 &&
      lightRatio > 0.15 &&
      middleRatio < 0.15;

    const isSharp = analysis.sharpness > 30;

    const isLineArt = isBimodal && isSharp;
    const confidence = isLineArt ? 0.93 : 0.1;

    return {
      isLineArt,
      confidence,
      darkRatio,
      lightRatio,
      middleRatio
    };
  } catch {
    return {
      isLineArt: false,
      confidence: 0
    };
  }
}

export function detectAlphaStrippableFromFrame(frame, metadata = {}) {
  if (!metadata.hasAlpha || !frame || frame.channels < 4) {
    return false;
  }

  const totalPixels = frame.width * frame.height;

  if (!totalPixels) return false;

  const alphaIndex = frame.channels - 1;
  const sampleTarget = 4096;
  const stride = Math.max(1, Math.floor(totalPixels / sampleTarget));

  let minAlpha = 255;

  for (let px = 0; px < totalPixels; px += stride) {
    const alpha = frame.data[px * frame.channels + alphaIndex];

    if (alpha < minAlpha) {
      minAlpha = alpha;

      if (minAlpha < 255) {
        return false;
      }
    }
  }

  return minAlpha === 255;
  }
