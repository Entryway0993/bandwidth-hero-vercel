import sharp from 'sharp';
import { createHash, webcrypto } from 'node:crypto';
import { LRUCache } from 'lru-cache';
import memoryGovernor from './memoryGovernor.js';

const subtle = webcrypto?.subtle ?? globalThis.crypto?.subtle;

function safeInt(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function safeFloat(value, fallback) {
  const n = parseFloat(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const SHARP_CACHE_MEMORY_MB = safeInt(process.env.SHARP_CACHE_MEMORY_MB, 350);
sharp.cache({ memory: SHARP_CACHE_MEMORY_MB, files: 0, items: 100 });

async function generateExactHash(buffer) {
  try {
    if (subtle) {
      const digest = await subtle.digest('SHA-256', buffer);
      return Buffer.from(digest).toString('hex').slice(0, 16);
    }

    return createHash('sha256').update(buffer).digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}

const MAX_OUTPUT_DIM = safeInt(process.env.MAX_OUTPUT_DIM, 2560);
const DEFAULT_QUALITY = safeInt(process.env.DEFAULT_QUALITY, 55);
const MAX_STRIP_WIDTH = safeInt(process.env.MAX_STRIP_WIDTH, 1600);
const MAX_ANIMATION_FRAMES = safeInt(process.env.MAX_ANIMATION_FRAMES, 300);
const VIEWPORT_FALLBACK = safeInt(process.env.VIEWPORT_FALLBACK, 1080);
const HEALTH_LAG_THRESHOLD = safeInt(process.env.HEALTH_LAG_THRESHOLD, 100);
const SHUTDOWN_TIMEOUT = safeInt(process.env.SHUTDOWN_TIMEOUT, 10000);
const SHARP_HARD_TIMEOUT_MS = safeInt(process.env.SHARP_HARD_TIMEOUT_MS, 50000);

// Sharp AVIF hard limit is UNKNOWN, so these are conservative safety limits.
const AVIF_MAX_PIXELS = safeInt(process.env.AVIF_MAX_PIXELS, 50_000_000);
const AVIF_MAX_DIMENSION = safeInt(process.env.AVIF_MAX_DIMENSION, 1200);

const metrics = {
  startTime: Date.now(),
  totalRequests: 0,
  cacheHits: 0,
  cacheMisses: 0,
  totalBytesIn: 0,
  totalBytesOut: 0,
  totalBytesSaved: 0,
  totalEncodeTime: 0,
  encodeCount: 0,
  memoryRejections: 0,
  voidDetections: 0,
  encodingFailures: 0,
  formatCounts: {
    avif: 0,
    webp: 0,
    jpeg: 0
  },
  featureActivations: {
    deskew: 0,
    alphaSentinel: 0,
    moireRemoval: 0,
    lineDenoise: 0,
    luminanceFix: 0,
    ghostStripper: 0,
    bandingExorcist: 0,
    metadataReaper: 0
  }
};

let activeRequests = 0;
let activeEncodes = 0;
let isShuttingDown = false;

function recordMetric(key, value = 1) {
  if (metrics.featureActivations[key] !== undefined) {
    metrics.featureActivations[key] += value;
  }
}

export function getMetrics() {
  const uptime = Date.now() - metrics.startTime;

  const avgEncodeTime = metrics.encodeCount > 0
    ? Math.round(metrics.totalEncodeTime / metrics.encodeCount)
    : 0;

  const cacheHitRate = metrics.totalRequests > 0
    ? ((metrics.cacheHits / metrics.totalRequests) * 100).toFixed(2) + '%'
    : '0%';

  const compressionRatio = metrics.totalBytesIn > 0
    ? ((1 - metrics.totalBytesOut / metrics.totalBytesIn) * 100).toFixed(2) + '%'
    : '0%';

  return {
    uptime: `${Math.floor(uptime / 1000)}s`,
    totalRequests: metrics.totalRequests,
    cacheHits: metrics.cacheHits,
    cacheMisses: metrics.cacheMisses,
    cacheHitRate,
    totalBytesIn: `${(metrics.totalBytesIn / 1024 / 1024).toFixed(2)}MB`,
    totalBytesOut: `${(metrics.totalBytesOut / 1024 / 1024).toFixed(2)}MB`,
    totalBytesSaved: `${(metrics.totalBytesSaved / 1024 / 1024).toFixed(2)}MB`,
    compressionRatio,
    avgEncodeTime: `${avgEncodeTime}ms`,
    memoryRejections: metrics.memoryRejections,
    voidDetections: metrics.voidDetections,
    encodingFailures: metrics.encodingFailures,
    formatCounts: metrics.formatCounts,
    featureActivations: metrics.featureActivations,
    activeRequests,
    activeEncodes,
    isShuttingDown,
    memoryGovernor: {
      rssMB: memoryGovernor.getRssMB(),
      availableMB: memoryGovernor.getAvailableMB(),
      pixelBudget: memoryGovernor.getPixelBudget(),
      activePixels: memoryGovernor.getActivePixelCost(),
      ceilingMB: memoryGovernor.MEMORY_CEILING_MB
    }
  };
}

export function checkHealth() {
  return new Promise((resolve) => {
    const start = process.hrtime.bigint();

    setImmediate(() => {
      const lag = Number(process.hrtime.bigint() - start) / 1e6;
      const healthy = lag < HEALTH_LAG_THRESHOLD;

      resolve({
        healthy,
        eventLoopLag: `${lag.toFixed(2)}ms`,
        threshold: `${HEALTH_LAG_THRESHOLD}ms`,
        uptime: `${Math.floor(process.uptime())}s`,
        activeRequests,
        activeEncodes,
        isShuttingDown,
        memory: {
          rssMB: memoryGovernor.getRssMB(),
          ceilingMB: memoryGovernor.MEMORY_CEILING_MB,
          underPressure: memoryGovernor.isUnderPressure()
        }
      });
    });
  });
}

function gracefulShutdown(signal) {
  if (isShuttingDown) return;

  isShuttingDown = true;
  console.log(`[GUILLOTINE-GRACE] ${signal} received. Shutting down gracefully.`);

  const forceTimeout = setTimeout(() => {
    console.log('[GUILLOTINE-GRACE] Timeout reached. Forcing shutdown.');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT);

  const checkInterval = setInterval(() => {
    if (activeRequests === 0 && activeEncodes === 0) {
      clearTimeout(forceTimeout);
      clearInterval(checkInterval);
      console.log('[GUILLOTINE-GRACE] All requests completed. Exiting.');
      process.exit(0);
    }
  }, 100);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

const exactCache = new LRUCache({
  max: 200,
  maxSize: 100 * 1024 * 1024,
  sizeCalculation: (entry) => entry.buffer.length
});

// ============================================================
// CHRONOS v2 — pixel/format aware, no blind effort 9
// ============================================================

const CHRONOS_WINDOW = 10;

const rollingByFormat = {
  avif: [],
  webp: []
};

function recordEncodeTime(ms, pixelCount, format) {
  if (format !== 'avif' && format !== 'webp') return;
  if (!Number.isFinite(ms) || ms <= 0) return;
  if (!Number.isFinite(pixelCount) || pixelCount <= 0) pixelCount = 1;

  const mp = pixelCount / 1_000_000;
  const msPerMegapixel = ms / Math.max(mp, 0.1);

  if (!rollingByFormat[format]) rollingByFormat[format] = [];

  rollingByFormat[format].push(msPerMegapixel);

  if (rollingByFormat[format].length > CHRONOS_WINDOW) {
    rollingByFormat[format].shift();
  }
}

function getAverageMsPerMegapixel(format) {
  const arr = rollingByFormat[format] || [];

  if (arr.length === 0) return 0;

  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function getColdStartEffort(pixelCount, outputFormat) {
  const mp = pixelCount / 1_000_000;

  if (outputFormat === 'avif') {
    if (mp <= 1) return 6;
    if (mp <= 3) return 5;
    if (mp <= 8) return 4;
    if (mp <= 20) return 3;
    if (mp <= 50) return 2;
    return 2;
  }

  if (outputFormat === 'webp') {
    if (mp <= 2) return 6;
    if (mp <= 8) return 5;
    if (mp <= 20) return 4;
    return 3;
  }

  return 4;
}

function getChronosState(pixelCount, outputFormat) {
  const samples = rollingByFormat[outputFormat] || [];

  if (samples.length < 3) {
    return {
      state: 'COLD',
      effort: getColdStartEffort(pixelCount, outputFormat)
    };
  }

  const avg = getAverageMsPerMegapixel(outputFormat);

  if (avg < 40) return { state: 'FAST', effort: 9 };
  if (avg < 80) return { state: 'SWIFT', effort: 8 };
  if (avg < 150) return { state: 'NORMAL', effort: 7 };
  if (avg < 250) return { state: 'LIGHT', effort: 6 };
  if (avg < 400) return { state: 'MODERATE', effort: 5 };
  if (avg < 700) return { state: 'HEAVY', effort: 4 };
  if (avg < 1200) return { state: 'SEVERE', effort: 3 };

  return { state: 'CRITICAL', effort: 2 };
}

// ============================================================
// FEATURE FLAGS
// ============================================================

function envBool(name, fallback = false) {
  const v = process.env[name];
  if (v === undefined) return fallback;
  return v === '1' || v === 'true' || v === 'yes';
}

const FORCE_GRAYSCALE = envBool('FORCE_GRAYSCALE', false);
const STRIP_ALPHA = envBool('STRIP_ALPHA', true);

const ENABLE_PLACEHOLDER = envBool('ENABLE_PLACEHOLDER', true);
const ENABLE_PALETTE = envBool('ENABLE_PALETTE', true);
const ENABLE_VOID_WATCHER = envBool('ENABLE_VOID_WATCHER', true);
const ENABLE_JUDGE = envBool('ENABLE_JUDGE', true);
const ENABLE_MOIRE = envBool('ENABLE_MOIRE', true);
const ENABLE_LINE_DENOISE = envBool('ENABLE_LINE_DENOISE', true);
const ENABLE_LUMINANCE = envBool('ENABLE_LUMINANCE', true);
const ENABLE_DESKEW = envBool('ENABLE_DESKEW', true);
const ENABLE_BANDING_EXORCIST = envBool('ENABLE_BANDING_EXORCIST', true);
const ENABLE_ALPHA_SENTINEL = envBool('ENABLE_ALPHA_SENTINEL', true);
const ENABLE_LAYOUT_PROPHET = envBool('ENABLE_LAYOUT_PROPHET', true);
const ENABLE_ENCODING_VERIFIER = envBool('ENABLE_ENCODING_VERIFIER', true);
const ENABLE_GHOST_STRIPPER = envBool('ENABLE_GHOST_STRIPPER', true);
const ENABLE_METADATA_REAPER = envBool('ENABLE_METADATA_REAPER', true);
const ENABLE_WEBP_PRESET = envBool('ENABLE_WEBP_PRESET', true);
const ENABLE_TIMEOUT_GUILLOTINE = envBool('ENABLE_TIMEOUT_GUILLOTINE', true);
const ENABLE_DIMENSION_OVERLORD = envBool('ENABLE_DIMENSION_OVERLORD', true);
const ENABLE_ORACLE_LEDGER = envBool('ENABLE_ORACLE_LEDGER', true);

function parseTriState(value, defaultValue) {
  if (Array.isArray(value)) {
    value = value[0];
  }

  if (value === undefined) return defaultValue;

  const str = String(value).trim().toLowerCase();

  if (['1', 'true', 'yes', 'on'].includes(str)) return true;
  if (['0', 'false', 'no', 'off'].includes(str)) return false;

  return defaultValue;
}

// ============================================================
// ANALYSIS HELPERS
// ============================================================

async function generatePlaceholderAndPalette(buffer) {
  try {
    const { data, info } = await sharp(buffer)
      .resize(32, 32, { fit: 'inside' })
      .raw()
      .toBuffer({ resolveWithObject: true });

    const channels = info.channels;
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

    if (ENABLE_PLACEHOLDER && !isVoid) {
      const thumbBuffer = await sharp(buffer)
        .resize(32, 32, { fit: 'inside' })
        .blur(2)
        .grayscale()
        .jpeg({ quality: 20 })
        .toBuffer();

      placeholder = 'data:image/jpeg;base64,' + thumbBuffer.toString('base64');
    }

    return { placeholder, palette, stdev, isVoid };
  } catch {
    return { placeholder: null, palette: [], stdev: 0, isVoid: false };
  }
}

async function detectSkew(buffer) {
  try {
    const { data, info } = await sharp(buffer)
      .resize(256, 256, { fit: 'inside' })
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const w = info.width;
    const h = info.height;

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

    const angle = 0.5 * Math.atan2(2 * covXY, covXX - covYY) * (180 / Math.PI);

    if (Math.abs(angle) > 1.5 && Math.abs(angle) < 15) {
      return angle;
    }

    return 0;
  } catch {
    return 0;
  }
}

let _noiseTilePromise = null;

function getNoiseTile() {
  if (!_noiseTilePromise) {
    _noiseTilePromise = (async () => {
      const size = 128;
      const channels = 4;
      const data = Buffer.alloc(size * size * channels);

      for (let i = 0; i < size * size; i++) {
        const noise = Math.floor(Math.random() * 256);

        data[i * channels] = noise;
        data[i * channels + 1] = noise;
        data[i * channels + 2] = noise;
        data[i * channels + 3] = 6;
      }

      return sharp(data, {
        raw: { width: size, height: size, channels: channels }
      }).png().toBuffer();
    })();
  }

  return _noiseTilePromise;
}

async function detectAlphaStrippable(buffer, metadata) {
  if (!metadata.hasAlpha) return false;

  try {
    const sampleSize = 64;

    const { data, info } = await sharp(buffer)
      .resize(sampleSize, sampleSize, { fit: 'inside' })
      .raw()
      .toBuffer({ resolveWithObject: true });

    const channels = info.channels;
    const alphaIdx = channels - 1;
    let minAlpha = 255;

    for (let i = alphaIdx; i < data.length; i += channels) {
      if (data[i] < minAlpha) {
        minAlpha = data[i];
        if (minAlpha < 255) return false;
      }
    }

    return minAlpha === 255;
  } catch {
    return false;
  }
}

function verifyOutput(buffer, format) {
  if (!buffer || buffer.length < 100) return false;

  switch (format) {
    case 'jpeg':
      return buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF;

    case 'webp':
      return (
        buffer[0] === 0x52 &&
        buffer[1] === 0x49 &&
        buffer[2] === 0x46 &&
        buffer[3] === 0x46 &&
        buffer[8] === 0x57 &&
        buffer[9] === 0x45 &&
        buffer[10] === 0x42 &&
        buffer[11] === 0x50
      );

    case 'avif':
      return (
        buffer[4] === 0x66 &&
        buffer[5] === 0x74 &&
        buffer[6] === 0x79 &&
        buffer[7] === 0x70
      );

    default:
      return true;
  }
}

function getWebpPreset(analysis, lineArtResult, origW, origH) {
  if (!ENABLE_WEBP_PRESET) return 'default';

  if (lineArtResult && lineArtResult.isLineArt && lineArtResult.confidence > 0.85) {
    return 'drawing';
  }

  if (analysis.isAnime) return 'picture';
  if (analysis.entropy > 7.5) return 'photo';
  if (origW < 256 && origH < 256) return 'icon';

  return 'default';
}

function judgeQuality(analysis, metadata) {
  const sharpness = analysis.sharpness || 0;
  const width = metadata.width || 0;
  const height = metadata.height || 0;
  const entropy = analysis.entropy || 0;
  const colorVariance = analysis.colorVariance || 0;

  const aspectRatio = height / Math.max(width, 1);
  const isVerticalStrip = aspectRatio > 2.5;
  const resolution = isVerticalStrip ? width : Math.max(width, height);

  let score = 0;

  if (sharpness > 80) score += 35;
  else if (sharpness > 60) score += 28;
  else if (sharpness > 40) score += 21;
  else if (sharpness > 25) score += 14;
  else if (sharpness > 15) score += 7;

  if (resolution > 2000) score += 25;
  else if (resolution > 1500) score += 20;
  else if (resolution > 1000) score += 15;
  else if (resolution > 700) score += 10;
  else if (resolution > 400) score += 5;

  if (entropy > 5 && entropy < 7) score += 25;
  else if (entropy > 4 && entropy < 8) score += 18;
  else if (entropy > 3 && entropy < 8.5) score += 12;
  else score += 5;

  if (colorVariance > 80) score += 15;
  else if (colorVariance > 40) score += 8;
  else if (colorVariance < 15) score -= 10;

  let grade, qualityAdjust;

  if (score >= 90) { grade = 'S'; qualityAdjust = -15; }
  else if (score >= 75) { grade = 'A'; qualityAdjust = -10; }
  else if (score >= 60) { grade = 'B'; qualityAdjust = -5; }
  else if (score >= 45) { grade = 'C'; qualityAdjust = 0; }
  else if (score >= 30) { grade = 'D'; qualityAdjust = 5; }
  else if (score >= 15) { grade = 'E'; qualityAdjust = 10; }
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
      macroVariance
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
  const statsSource = metadata.width > 4096 || metadata.height > 4096
    ? await sharp(buffer).resize(4096, 4096, { fit: 'inside', withoutEnlargement: true }).toBuffer()
    : buffer;

  const stats = await sharp(statsSource).stats();
  const { channels } = stats;

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
  const aspectRatio = (metadata.height || 0) / Math.max(metadata.width || 1, 1);

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
  if (analysis.isColorful && analysis.sharpness > 80) return '4:4:4';
  return '4:2:0';
    }

// ============================================================
// FORCED FORMAT SELECTOR
// ============================================================

function chooseOutputFormat(metadata, totalPixelCost) {
  const isAnimated = (metadata.pages || 1) > 1;
  const format = metadata.format;

  if (format === 'gif' || isAnimated) {
    return { format: 'webp', reason: 'animated_or_gif' };
  }

  const width = metadata.width || 0;
  const height = metadata.height || 0;

  if (width <= 0 || height <= 0) {
    return { format: 'jpeg', reason: 'unknown_dimensions' };
  }

  // WebP has a hard spec limit of 16383x16383. 
  // If a strip is taller than that, WebP will crash. Force JPEG.
  if (height > 16383 || width > 16383) {
    return { format: 'jpeg', reason: 'exceeds_webp_and_safe_limits' };
  }

  // Trust the pixel cost. The Memory Governor already admitted it.
  if (totalPixelCost <= AVIF_MAX_PIXELS) {
    return { format: 'avif', reason: 'avif_allowed' };
  }

  // Over pixel cap: resize down to fit, still use AVIF
  return { format: 'avif', reason: 'avif_resized_to_fit' };

// ============================================================
// MAIN COMPRESS FUNCTION
// ============================================================

export default async function compress(req, res, buffer, governor) {
  const memGov = governor || memoryGovernor;
  const reqId = req.id || 'unknown';

  if (isShuttingDown) {
    res.status(503);
    res.setHeader('X-Guillotine-Grace', 'SHUTTING_DOWN');
    res.setHeader('Retry-After', '10');
    return Buffer.alloc(0);
  }

  activeRequests++;

  if (ENABLE_ORACLE_LEDGER) {
    metrics.totalRequests++;
    metrics.totalBytesIn += buffer.length;
  }

  const abortController = new AbortController();
  const { signal } = abortController;

  let clientDisconnected = false;

  const startedAt = Date.now();

  const timeoutHandle = setTimeout(() => {
    console.warn(JSON.stringify({
      event: 'COMPRESS_ABORT',
      reqId,
      reason: 'SHARP_HARD_TIMEOUT',
      elapsedMs: Date.now() - startedAt,
      limitMs: SHARP_HARD_TIMEOUT_MS
    }));

    clientDisconnected = true;
    abortController.abort(new Error('SHARP_HARD_TIMEOUT'));
  }, SHARP_HARD_TIMEOUT_MS);

  if (ENABLE_TIMEOUT_GUILLOTINE) {
    req.on('close', () => {
      if (!res.writableEnded) {
        console.warn(JSON.stringify({
          event: 'COMPRESS_ABORT',
          reqId,
          reason: 'CLIENT_DISCONNECT',
          elapsedMs: Date.now() - startedAt
        }));

        clientDisconnected = true;
        abortController.abort(new Error('CLIENT_DISCONNECT'));
      }
    });

    res.on('close', () => {
      if (!res.writableEnded) {
        console.warn(JSON.stringify({
          event: 'COMPRESS_ABORT',
          reqId,
          reason: 'RESPONSE_CLOSED',
          elapsedMs: Date.now() - startedAt
        }));

        clientDisconnected = true;
        abortController.abort(new Error('RESPONSE_CLOSED'));
      }
    });
  }

  let totalPixelCost = 0;

  try {
    if (signal.aborted) {
      res.setHeader('X-Timeout-Guillotine', 'ABORTED');
      res.status(499);
      return Buffer.alloc(0);
    }

    const metadata = await sharp(buffer).metadata();
    const format = metadata.format;

    if (!format || format === 'raw') {
      return buffer;
    }

    // F12-MODIFIED: raw/bypass removed
    const mode = req.opts?.mode || 'auto';
    const isPhotoMode = mode === 'photo' || mode === 'normal';
    const isMangaMode = mode === 'manga' || mode === 'comic';
    const isStripMode = ['strip', 'webtoon', 'manhwa', 'manhua'].includes(mode);

    const sharpenPreference = parseTriState(req.query?.sharpen, req.opts?.sharpen);

    const allowEnhancements = true;
    const allowLineArtFilters = allowEnhancements && !isPhotoMode;
    const allowPhotoFilters = allowEnhancements && !isMangaMode && !isStripMode;

    // Dimension overlord
    if (ENABLE_DIMENSION_OVERLORD) {
      const MAX_DIMENSION = 16383;
      const MAX_ASPECT_RATIO = 200;

      const width = metadata.width || 0;
      const height = metadata.height || 0;

      if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
        res.status(413);
        res.setHeader('X-Dimension-Overlord', 'REJECTED_DIMENSION');
        return Buffer.alloc(0);
      }

      const minDim = Math.max(1, Math.min(width, height));
      const maxDim = Math.max(width, height);
      const aspectRatio = maxDim / minDim;

      if (aspectRatio > MAX_ASPECT_RATIO) {
        res.status(413);
        res.setHeader('X-Dimension-Overlord', 'REJECTED_ASPECT');
        return Buffer.alloc(0);
      }
    }

    if (signal.aborted) {
      res.setHeader('X-Timeout-Guillotine', 'ABORTED');
      res.status(499);
      return Buffer.alloc(0);
    }

    // Calculate pixel cost for memory governor
    const frames = metadata.pages || 1;
    const width = metadata.width || 0;
    const height = metadata.height || 0;
    totalPixelCost = width * height * frames;

    // FORCED FORMAT SELECTION
    const formatDecision = chooseOutputFormat(metadata, totalPixelCost);
    const outputFormat = formatDecision.format;

    let logUrl = 'unknown';
    try {
      const u = new URL(req.opts?.url);
      logUrl = u.origin + u.pathname;
    } catch {}

    res.setHeader('X-Format-Reason', formatDecision.reason);

    console.log(JSON.stringify({
      event: 'FORMAT_DECISION',
      reqId,
      url: logUrl,
      format: outputFormat,
      reason: formatDecision.reason,
      width,
      height,
      frames,
      totalPixelCost,
      avifMaxPixels: AVIF_MAX_PIXELS,
      avifMaxDimension: AVIF_MAX_DIMENSION
    }));
    const paramFingerprint = [
      outputFormat,
      req.opts?.quality,
      req.opts?.grayscale,
      req.opts?.maxDim,
      req.opts?.maxStripWidth,
      mode,
      sharpenPreference === undefined ? '' : String(sharpenPreference),
      req.opts?.rotate || 0
    ].join('|');

    // Exact cache lookup
    const exactHash = await generateExactHash(buffer);
    const exactKey = exactHash ? `${exactHash}:${paramFingerprint}` : null;

    if (exactKey) {
      const exactHit = exactCache.get(exactKey);

      if (exactHit) {
        res.setHeader('X-Exact-Cache', 'HIT');
        res.setHeader('Content-Type', exactHit.contentType);

        if (exactHit.placeholder) res.setHeader('X-Placeholder', exactHit.placeholder);
        if (exactHit.grade) res.setHeader('X-Quality-Grade', exactHit.grade);
        if (exactHit.palette && exactHit.palette.length > 0) {
          res.setHeader('X-Palette', exactHit.palette.join(','));
        }

        if (ENABLE_ORACLE_LEDGER) {
          metrics.cacheHits++;
          metrics.totalBytesOut += exactHit.buffer.length;
          metrics.totalBytesSaved += buffer.length - exactHit.buffer.length;
        }

        return exactHit.buffer;
      }
    }

    // Void watcher / placeholder / palette
    let thumbResult = null;

    if ((ENABLE_VOID_WATCHER || ENABLE_PALETTE || ENABLE_PLACEHOLDER) && allowEnhancements) {
      thumbResult = await generatePlaceholderAndPalette(buffer);

      if (ENABLE_VOID_WATCHER && thumbResult.isVoid) {
        res.setHeader('X-Void', 'TRUE');
        res.setHeader('Content-Type', `image/${format}`);

        if (ENABLE_ORACLE_LEDGER) {
          metrics.voidDetections++;
          metrics.totalBytesOut += buffer.length;
        }

        return buffer;
      }
    }

    if (signal.aborted) {
      res.setHeader('X-Timeout-Guillotine', 'ABORTED');
      res.status(499);
      return Buffer.alloc(0);
    }

    if (ENABLE_ORACLE_LEDGER) {
      metrics.cacheMisses++;
    }

    // Memory governor pixel admission
    if (!memGov.admitPixels(totalPixelCost)) {
      res.status(503);
      res.setHeader('X-Memory-Governor', 'REJECTED');
      res.setHeader('X-RSS-MB', String(memGov.getRssMB()));
      res.setHeader('X-Pixel-Budget', String(memGov.getPixelBudget()));
      res.setHeader('Retry-After', '5');

      if (ENABLE_ORACLE_LEDGER) {
        metrics.memoryRejections++;
      }

      return Buffer.alloc(0);
    }

    res.setHeader('X-Memory-Governor', 'ADMITTED');
    res.setHeader('X-Pixel-Cost', String(totalPixelCost));

    try {
      const analysis = await detectImageType(buffer, metadata);
      const viewportMaxDim = getViewportMaxDim(req);

      let placeholder = thumbResult ? thumbResult.placeholder : null;
      let palette = thumbResult ? thumbResult.palette : [];

      if (ENABLE_PALETTE && palette.length > 0) {
        res.setHeader('X-Palette', palette.join(','));
      }

      // Deskew
      let skewAngle = 0;

      if (ENABLE_DESKEW && allowEnhancements && !isStripMode && !analysis.isMangaStrip) {
        skewAngle = await detectSkew(buffer);

        if (skewAngle !== 0) {
          res.setHeader('X-Deskew-Angle', skewAngle.toFixed(2));
          recordMetric('deskew');
        }
      }

      if (signal.aborted) {
        res.setHeader('X-Timeout-Guillotine', 'ABORTED');
        res.status(499);
        return Buffer.alloc(0);
      }

      // Judge quality
      let judgeResult = null;

      if (ENABLE_JUDGE && allowEnhancements) {
        judgeResult = judgeQuality(analysis, metadata);
      }

      // Halftone / moire detection
      let halftoneResult = null;

      if (ENABLE_MOIRE && allowEnhancements && !isStripMode) {
        halftoneResult = await detectHalftone(buffer, metadata, analysis);
      }

      // Line art detection
      let lineArtResult = null;

      if (ENABLE_LINE_DENOISE && allowLineArtFilters) {
        lineArtResult = await detectLineArt(buffer, analysis);
      }

      // Alpha sentinel
      let alphaStrippable = false;
      const isAnimated = metadata.pages > 1;

      if (ENABLE_ALPHA_SENTINEL && metadata.hasAlpha && !isAnimated) {
        alphaStrippable = await detectAlphaStrippable(buffer, metadata);

        if (alphaStrippable) {
          res.setHeader('X-Alpha-Sentinel', 'STRIPPED');
          recordMetric('alphaSentinel');
        }
      }

      if (signal.aborted) {
        res.setHeader('X-Timeout-Guillotine', 'ABORTED');
        res.status(499);
        return Buffer.alloc(0);
      }

      // CHRONOS v2: pixel/format aware effort
      const chronos = getChronosState(totalPixelCost, outputFormat);
      const effort = chronos.effort;

      res.setHeader('X-Chronos-State', chronos.state);
      res.setHeader('X-Chronos-Effort', String(effort));

      // Quality
      let quality = req.opts?.quality ?? (parseInt(req.query.q || req.query.quality) || DEFAULT_QUALITY);

      if (judgeResult) {
        quality = Math.max(10, Math.min(95, quality + judgeResult.qualityAdjust));
      }

      // Frame cap for animated images
      const frameCount = metadata.pages || 1;

      if (isAnimated && frameCount > MAX_ANIMATION_FRAMES) {
        res.setHeader('X-Frame-Cap', 'TRUNCATED');

        if (ENABLE_ORACLE_LEDGER) {
          metrics.totalBytesOut += buffer.length;
        }

        return buffer;
      }

      // Banding exorcist check
      let bandingExorcistActive = false;

      if (
        ENABLE_BANDING_EXORCIST &&
        allowPhotoFilters &&
        !isAnimated
      ) {
        if (
          analysis.stdevLuminance > 20 &&
          analysis.stdevLuminance < 50 &&
          analysis.sharpness < 30
        ) {
          bandingExorcistActive = true;
          recordMetric('bandingExorcist');
        }
      }

      if (signal.aborted) {
        res.setHeader('X-Timeout-Guillotine', 'ABORTED');
        res.status(499);
        return Buffer.alloc(0);
      }

      // Build Sharp pipeline
      let pipeline = sharp(buffer, {
        animated: isAnimated,
        limitInputPixels: 0
      });

      if (ENABLE_METADATA_REAPER) {
        pipeline = pipeline.rotate();
        recordMetric('metadataReaper');
      } else {
        pipeline = pipeline.withMetadata({
          orientation: metadata.orientation || 1,
        });
      }

      pipeline = pipeline.toColourspace('srgb');

      // F13-MODIFIED: Apply safe manual rotation
      if (req.opts?.rotate) {
        pipeline = pipeline.rotate(req.opts.rotate);
      }

      // Grayscale
      const userExplicitlyWantsColor = req.opts?.grayscale === false;
      const userExplicitlyWantsBW = req.opts?.grayscale === true;

      if (
        FORCE_GRAYSCALE ||
        userExplicitlyWantsBW ||
        (!userExplicitlyWantsColor && analysis.isGrayscale && !analysis.isColorful)
      ) {
        pipeline = pipeline.grayscale();
      }

      // Luminance fix
      if (ENABLE_LUMINANCE && allowPhotoFilters && !isAnimated) {
        if (analysis.meanLuminance < 85 && analysis.stdevLuminance < 50) {
          pipeline = pipeline.gamma(1.4);
          res.setHeader('X-Luminance-Fix', 'UNDEREXPOSED');
          recordMetric('luminanceFix');
        } else if (analysis.meanLuminance > 210 && analysis.stdevLuminance < 50) {
          pipeline = pipeline.gamma(0.7);
          res.setHeader('X-Luminance-Fix', 'OVEREXPOSED');
          recordMetric('luminanceFix');
        }
      }

      // Ghost stripper
      if (ENABLE_GHOST_STRIPPER && allowPhotoFilters && !isAnimated) {
        if (analysis.meanLuminance > 150 && analysis.maxLuminance > 200 && analysis.maxLuminance < 253) {
          const stretch = 255 / analysis.maxLuminance;
          pipeline = pipeline.linear(stretch, 0);
          res.setHeader('X-Ghost-Stripper', `STRETCHED (max:${analysis.maxLuminance} -> 255)`);
          recordMetric('ghostStripper');
        }
      }

      // Deskew rotation
      if (ENABLE_DESKEW && allowEnhancements && skewAngle !== 0) {
        pipeline = pipeline.rotate(skewAngle, {
          background: analysis.isGrayscale
            ? { r: 255, g: 255, b: 255 }
            : { r: 255, g: 255, b: 255, alpha: 0 },
        });
      }

      // Moire removal
      if (
        allowEnhancements &&
        halftoneResult &&
        halftoneResult.isHalftone &&
        halftoneResult.confidence > 0.85
      ) {
        pipeline = pipeline.median(3);
        res.setHeader('X-Moire-Removed', 'true');
        recordMetric('moireRemoval');
      }

      // Line denoise
      if (
        allowLineArtFilters &&
        lineArtResult &&
        lineArtResult.isLineArt &&
        lineArtResult.confidence > 0.85
      ) {
        pipeline = pipeline.median(3);

        if (sharpenPreference !== false) {
          pipeline = pipeline.sharpen({
            sigma: 0.6,
            flat: 3.0,
            jagged: 1.5,
          });
        }

        res.setHeader('X-Line-Denoise', 'true');
        recordMetric('lineDenoise');
      }

      // Resize
      let targetWidth = null;
      let targetHeight = null;

      const { width: origW, height: origH } = metadata;

      const effectiveStripWidth = (req.opts?.maxStripWidth > 0) ? req.opts.maxStripWidth : MAX_STRIP_WIDTH;
      const effectiveMaxDim = (req.opts?.maxDim > 0) ? req.opts.maxDim : viewportMaxDim;

      if (analysis.isMangaStrip) {
        if (effectiveStripWidth > 0 && origW > effectiveStripWidth) {
          targetWidth = effectiveStripWidth;
        }
      } else {
        if (effectiveMaxDim > 0 && (origW > effectiveMaxDim || origH > effectiveMaxDim)) {
          const scale = Math.min(effectiveMaxDim / origW, effectiveMaxDim / origH);
          targetWidth = Math.round(origW * scale);
          targetHeight = Math.round(origH * scale);
        }
      }

      // Layout prophet headers
      if (ENABLE_LAYOUT_PROPHET) {
        let outW = origW;
        let outH = origH;

        if (targetWidth && targetHeight) {
          outW = targetWidth;
          outH = targetHeight;
        } else if (targetWidth) {
          outW = targetWidth;
          outH = Math.round(origH * (targetWidth / origW));
        } else if (targetHeight) {
          outH = targetHeight;
          outW = Math.round(origW * (targetHeight / origH));
        }

        const aspectRatio = (outW / outH).toFixed(4);
        const orientation = outW > outH ? 'landscape' : outH > outW ? 'portrait' : 'square';

        res.setHeader('X-Output-Width', String(outW));
        res.setHeader('X-Output-Height', String(outH));
        res.setHeader('X-Aspect-Ratio', aspectRatio);
        res.setHeader('X-Orientation', orientation);
      }

      // If pixel cost exceeds AVIF cap, force resize to fit
      if (outputFormat === 'avif' && totalPixelCost > AVIF_MAX_PIXELS) {
        const scaleFactor = Math.sqrt(AVIF_MAX_PIXELS / totalPixelCost);
        targetWidth = Math.round(origW * scaleFactor);
        targetHeight = Math.round(origH * scaleFactor);

        res.setHeader('X-AVIF-Resize-To-Fit', 'true');
        res.setHeader('X-AVIF-Resize-Scale', scaleFactor.toFixed(4));
      }

      if (targetWidth || targetHeight) {
        pipeline = pipeline.resize(targetWidth, targetHeight, {
          fit: 'inside',
          withoutEnlargement: true,
          kernel: sharp.kernel.lanczos3,
        });
      }

      // Sharpen
      const contentWantsSharpen =
        sharpenPreference !== false &&
        analysis.sharpness < 50 &&
        !analysis.isMangaStrip;

      if (
        allowEnhancements &&
        (sharpenPreference === true || contentWantsSharpen)
      ) {
        const alreadySharpened =
          allowLineArtFilters &&
          lineArtResult &&
          lineArtResult.isLineArt &&
          lineArtResult.confidence > 0.85;

        if (!alreadySharpened) {
          pipeline = pipeline.sharpen({
            sigma: 0.8,
            flat: 2.0,
            jagged: 1.0,
          });
        }
      }

      // Alpha handling
      if (alphaStrippable) {
        pipeline = pipeline.flatten({ background: { r: 255, g: 255, b: 255 } });
      } else if (STRIP_ALPHA && outputFormat === 'jpeg') {
        pipeline = pipeline.flatten({ background: { r: 255, g: 255, b: 255 } });
      }

      // Banding exorcist
      if (bandingExorcistActive) {
        const noiseTile = await getNoiseTile();

        pipeline = pipeline.composite([{
          input: noiseTile,
          tile: true,
          blend: 'over',
        }]);

        res.setHeader('X-Banding-Exorcist', 'ACTIVE');
      }

      if (signal.aborted) {
        res.setHeader('X-Timeout-Guillotine', 'ABORTED');
        res.status(499);
        return Buffer.alloc(0);
      }

      // ENCODE — forced format: avif / webp / jpeg only
      let outputBuffer;
      let contentType;

      const encodeStart = Date.now();
      activeEncodes++;

      if (ENABLE_TIMEOUT_GUILLOTINE) {
        const onAbort = () => {
          pipeline.destroy();
        };

        signal.addEventListener('abort', onAbort, { once: true });

        try {
          switch (outputFormat) {
            case 'avif':
              outputBuffer = await pipeline.avif({
                quality: Math.min(quality, 63),
                effort: Math.min(Math.max(effort, 0), 9),
                chromaSubsampling: getChromaSubsampling(analysis),
              }).toBuffer();
              contentType = 'image/avif';
              break;

            case 'webp':
              outputBuffer = await pipeline.webp({
                quality: quality,
                effort: Math.min(Math.max(effort, 0), 6),
                smartSubsample: true,
                preset: getWebpPreset(analysis, lineArtResult, origW, origH),
              }).toBuffer();
              contentType = 'image/webp';
              break;

            case 'jpeg':
            default:
              outputBuffer = await pipeline.jpeg({
                quality: quality,
                progressive: true,
                mozjpeg: true,
                chromaSubsampling: getChromaSubsampling(analysis),
                trellisQuantisation: true,
                overshootDeringing: true,
                optimiseScans: true,
              }).toBuffer();
              contentType = 'image/jpeg';
              break;
          }
        } finally {
          signal.removeEventListener('abort', onAbort);
        }
      } else {
        switch (outputFormat) {
          case 'avif':
            outputBuffer = await pipeline.avif({
              quality: Math.min(quality, 63),
              effort: Math.min(Math.max(effort, 0), 9),
              chromaSubsampling: getChromaSubsampling(analysis),
            }).toBuffer();
            contentType = 'image/avif';
            break;

          case 'webp':
            outputBuffer = await pipeline.webp({
              quality: quality,
              effort: Math.min(Math.max(effort, 0), 6),
              smartSubsample: true,
              preset: getWebpPreset(analysis, lineArtResult, origW, origH),
            }).toBuffer();
            contentType = 'image/webp';
            break;

          case 'jpeg':
          default:
            outputBuffer = await pipeline.jpeg({
              quality: quality,
              progressive: true,
              mozjpeg: true,
              chromaSubsampling: getChromaSubsampling(analysis),
              trellisQuantisation: true,
              overshootDeringing: true,
              optimiseScans: true,
            }).toBuffer();
            contentType = 'image/jpeg';
            break;
        }
      }

      activeEncodes--;

      const encodeEnd = Date.now();
      const encodeTime = encodeEnd - encodeStart;

      // Chronos: record encode time for adaptive effort
      recordEncodeTime(encodeTime, totalPixelCost, outputFormat);

      res.setHeader('X-Processing-Time', `${encodeTime}ms`);
      res.setHeader('X-Encode-Effort', String(effort));

      if (ENABLE_ORACLE_LEDGER) {
        metrics.formatCounts[outputFormat] = (metrics.formatCounts[outputFormat] || 0) + 1;
        metrics.totalEncodeTime += encodeTime;
        metrics.encodeCount++;
      }

      if (signal.aborted) {
        res.setHeader('X-Timeout-Guillotine', 'ABORTED');
        res.status(499);
        return Buffer.alloc(0);
      }

      // Encoding verifier
      if (ENABLE_ENCODING_VERIFIER) {
        if (!verifyOutput(outputBuffer, outputFormat)) {
          res.setHeader('X-Encoding-Verifier', 'FAILED');
          res.status(404);

          if (ENABLE_ORACLE_LEDGER) {
            metrics.encodingFailures++;
          }

          return Buffer.alloc(0);
        }

        res.setHeader('X-Encoding-Verifier', 'PASSED');
      }

      // If compressed is larger than original, return original
      if (outputBuffer.length >= buffer.length) {
        res.setHeader('X-Compression', 'SKIPPED');
        res.setHeader('Content-Type', `image/${format}`);

        if (placeholder) res.setHeader('X-Placeholder', placeholder);
        if (judgeResult) res.setHeader('X-Quality-Grade', judgeResult.grade);
        if (palette.length > 0) res.setHeader('X-Palette', palette.join(','));

        if (ENABLE_ORACLE_LEDGER) {
          metrics.totalBytesOut += buffer.length;
        }

        return buffer;
      }

      if (ENABLE_ORACLE_LEDGER) {
        metrics.totalBytesOut += outputBuffer.length;
        metrics.totalBytesSaved += buffer.length - outputBuffer.length;
      }

      const bytesSaved = buffer.length - outputBuffer.length;
      res.setHeader('X-Bytes-Saved', `${(bytesSaved / 1024).toFixed(1)}KB`);

      // Cache set
      const cacheEntry = {
        buffer: outputBuffer,
        contentType: contentType,
        placeholder: placeholder,
        grade: judgeResult ? judgeResult.grade : null,
        palette: palette,
      };

      if (exactKey) exactCache.set(exactKey, cacheEntry);

      res.setHeader('X-Perceptual-Cache', 'REMOVED');
      res.setHeader('X-Encode-Quality', String(quality));
      res.setHeader('X-Encode-Dims', `${targetWidth || origW}x${targetHeight || origH}`);
      res.setHeader('Content-Type', contentType);
      res.setHeader('X-Compression-Ratio', ((1 - outputBuffer.length / buffer.length) * 100).toFixed(1) + '%');

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

      // Vercel log: image analysis summary
      console.log(JSON.stringify({
        event: 'COMPRESS',
        reqId: reqId,
        url: (() => {
  try {
    const u = new URL(req.opts?.url);
    return u.origin + u.pathname;
  } catch {
    return 'unknown';
  }
})(),
        format: outputFormat,
        quality: quality,
        effort: effort,
        chronosState: chronos.state,
        grade: judgeResult ? judgeResult.grade : null,
        score: judgeResult ? judgeResult.score : null,
        inputBytes: buffer.length,
        outputBytes: outputBuffer.length,
        savedBytes: buffer.length - outputBuffer.length,
        compressionRatio: ((1 - outputBuffer.length / buffer.length) * 100).toFixed(1) + '%',
        encodeTimeMs: encodeTime,
        inputDims: `${origW}x${origH}`,
        outputDims: `${targetWidth || origW}x${targetHeight || origH}`,
        pixelCost: totalPixelCost,
        imageType: analysis.isMangaStrip ? 'manga-strip' :
          analysis.isMangaPage ? 'manga-page' :
          analysis.isAnime ? 'anime' :
          analysis.isGrayscale ? 'grayscale' : 'photo',
        frames: frames,
        mode: mode
      }));

      res.setHeader('Content-Length', outputBuffer.length);

      return outputBuffer;
    
    } finally {
      // Release pixel budget
      if (totalPixelCost > 0) {
        memGov.releasePixels(totalPixelCost);
      }
    }
  } catch (err) {
    if (clientDisconnected || signal.aborted) {
      res.setHeader('X-Timeout-Guillotine', 'ABORTED');
      return Buffer.alloc(0);
    }

    // F20: Request ID in error logs
    const safeMessage = err?.message ? String(err.message).split('?')[0] : 'Unknown compress error';
    console.error(`[COMPRESS ERROR] [${reqId}]`, safeMessage);

    res.setHeader('X-Compression', 'FAILED');

    if (ENABLE_ORACLE_LEDGER) {
      metrics.encodingFailures++;
      metrics.totalBytesOut += buffer.length;
    }

    if (!res.headersSent && !res.writableEnded) {
      res.setHeader('Content-Type', `image/${req.opts?.originType || 'jpeg'}`);
      res.end(buffer);
    } else {
      req.socket?.destroy();
    }

    return null;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    activeRequests--;
  }
                  }
