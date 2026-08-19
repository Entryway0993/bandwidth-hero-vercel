import sharp from 'sharp';
import { createHash } from 'crypto';
import { PassThrough } from 'stream';
import os from 'os';
import { LRUCache } from 'lru-cache';

// 🛑 HARD CAP: libvips internal cache limited to 700MB.
// Prevents unbounded memory growth across sequential encodes.
const SHARP_CACHE_MEMORY_MB = parseInt(process.env.SHARP_CACHE_MEMORY_MB, 10) || 700;
sharp.cache({ memory: SHARP_CACHE_MEMORY_MB, files: 0, items: 100 });

// 🛑 PATCH 2: FIXED CRYPTO CRASH (Replace generateExactHash function ~line 236)
async function generateExactHash(buffer) {
  try {
    // createHash is already imported at the top of the file
    return createHash('sha256').update(buffer).digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}

// 🛑 PATCH 3: PIXEL LIMIT MAXED OUT (Replace sharp initialization ~line 584)
      let pipeline = sharp(buffer, {
        animated: isAnimated,
        limitInputPixels: 0, // 🛑 0 disables the limit entirely, making it as high as possible.
      });

// ============================================================
// CONFIGURATION
// ============================================================

const MAX_OUTPUT_DIM = parseInt(process.env.MAX_OUTPUT_DIM) || 2048;
const DEFAULT_QUALITY = parseInt(process.env.DEFAULT_QUALITY) || 75;
const ANIME_QUALITY = parseInt(process.env.ANIME_QUALITY) || 80;
const PHOTO_QUALITY = parseInt(process.env.PHOTO_QUALITY) || 70;
const MAX_STRIP_WIDTH = parseInt(process.env.MAX_STRIP_WIDTH) || 1200;
const MAX_ANIMATION_FRAMES = parseInt(process.env.MAX_ANIMATION_FRAMES) || 50;
const VIEWPORT_FALLBACK = parseInt(process.env.VIEWPORT_FALLBACK) || 1080;
const HEALTH_LAG_THRESHOLD = parseInt(process.env.HEALTH_LAG_THRESHOLD) || 100;
const SHUTDOWN_TIMEOUT = parseInt(process.env.SHUTDOWN_TIMEOUT) || 10000;

// ============================================================
// FEATURE 1: THE ORACLE'S LEDGER (Global Telemetry)
// ============================================================

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
  semaphoreRejections: 0,
  voidDetections: 0,
  encodingFailures: 0,
  formatCounts: { avif: 0, webp: 0, jpeg: 0, png: 0 },
  featureActivations: {
    ditherAssassin: 0,
    bandingExorcist: 0,
    moireRemoval: 0,
    lineDenoise: 0,
    luminanceFix: 0,
    ghostStripper: 0,
    deskew: 0,
    alphaSentinel: 0,
    quantumSorcerer: 0,
    formatDuelist: 0,
    metadataReaper: 0,
    streamReaper: 0
  },
  chronosStateHistory: [],
};

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
    semaphoreRejections: metrics.semaphoreRejections,
    voidDetections: metrics.voidDetections,
    encodingFailures: metrics.encodingFailures,
    formatCounts: metrics.formatCounts,
    featureActivations: metrics.featureActivations,
    activeEncodes,
    activeRequests,
    isShuttingDown,
  };
}

// ============================================================
// FEATURE 2: THE HEARTBEAT SENTINEL (Event Loop Lag Detection)
// ============================================================

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
      });
    });
  });
}

// ============================================================
// FEATURE 3: THE GUILLOTINE'S GRACE (Graceful Shutdown)
// ============================================================

let activeRequests = 0;
let isShuttingDown = false;

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
      console.log('[GUILLOTINE-GRACE] All requests completed. Exiting with dignity.');
      process.exit(0);
    }
  }, 100);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ============================================================
// CACHES (O(1) LRU, byte-bounded, no pixel vandalism)
// ============================================================

// 🛑 Perceptual cache: fuzzy match for visually similar images.
const perceptualCache = new LRUCache({
  max: 500,
  maxSize: 200 * 1024 * 1024, // 200MB cap
  sizeCalculation: (entry) => entry.buffer.length
});

// 🛑 Exact cache: replaces Lorekeeper steganography.
// Keyed by MD5 of input buffer. No pixel modification. No double-encoding.
const exactCache = new LRUCache({
  max: 200,
  maxSize: 100 * 1024 * 1024, // 100MB cap
  sizeCalculation: (entry) => entry.buffer.length
});

// ============================================================
// FEATURE: THE TIER WARDEN (Size-Based Concurrency Tiers)
// ============================================================

const MAX_MEMORY_SLOTS = parseInt(process.env.MAX_MEMORY_SLOTS, 10) || 80;
const MB = 1024 * 1024;

// 🛑 HARD TIERS: Each tier caps concurrency for its size class.
// All tiers share a global slot budget to prevent cross-tier OOM.
const CONCURRENCY_TIERS = [
  { maxMB: 70, maxConcurrent: 1 },   // 70MB × 1 × 10x = 700MB
  { maxMB: 35, maxConcurrent: 2 },   // 35MB × 2 × 10x = 700MB
  { maxMB: 17, maxConcurrent: 4 },   // 17MB × 4 × 10x = 680MB
  { maxMB: 8,  maxConcurrent: 8 },   //  8MB × 8 × 10x = 640MB
  { maxMB: 4,  maxConcurrent: 16 },  //  4MB × 16 × 10x = 640MB
  { maxMB: 2,  maxConcurrent: 32 },  //  2MB × 32 × 10x = 640MB
  { maxMB: 1,  maxConcurrent: 64 },  //  1MB × 64 × 10x = 640MB
];

const activeEncodesByTier = new Array(CONCURRENCY_TIERS.length).fill(0);
let activeSlots = 0;
let activeEncodes = 0;

function acquireSemaphore(bufferLength) {
  if (isShuttingDown) return { acquired: false, reason: 'SHUTTING_DOWN' };

  const sizeMB = bufferLength / MB;
  const tierIndex = CONCURRENCY_TIERS.findIndex(t => sizeMB <= t.maxMB);

  // Image exceeds the largest tier → reject outright.
  if (tierIndex === -1) {
    return { acquired: false, reason: 'TOO_LARGE' };
  }

  const tier = CONCURRENCY_TIERS[tierIndex];
  const slotsNeeded = Math.max(1, Math.ceil(sizeMB));

  // Tier concurrency check.
  if (activeEncodesByTier[tierIndex] >= tier.maxConcurrent) {
    return { acquired: false, reason: 'TIER_SATURATED', tierIndex };
  }

  // Global memory budget check (prevents cross-tier OOM).
  if (activeSlots + slotsNeeded > MAX_MEMORY_SLOTS) {
    return { acquired: false, reason: 'MEMORY_SATURATED', tierIndex };
  }

  activeEncodesByTier[tierIndex]++;
  activeSlots += slotsNeeded;
  activeEncodes++;
  return { acquired: true, tierIndex, slotsNeeded };
}

function releaseSemaphore(tierIndex, slotsNeeded) {
  if (tierIndex >= 0 && activeEncodesByTier[tierIndex] > 0) {
    activeEncodesByTier[tierIndex]--;
  }
  if (activeSlots >= slotsNeeded) {
    activeSlots -= slotsNeeded;
  } else {
    activeSlots = 0;
  }
  if (activeEncodes > 0) activeEncodes--;
}

// ============================================================
// FEATURE: THE CHRONOS SCRIBE (Adaptive Effort)
// ============================================================

const rollingEncodeTimes = [];
const ROLLING_WINDOW = 20;

function recordEncodeTime(ms) {
  rollingEncodeTimes.push(ms);
  if (rollingEncodeTimes.length > ROLLING_WINDOW) {
    rollingEncodeTimes.shift();
  }
}

function getAverageEncodeTime() {
  if (rollingEncodeTimes.length === 0) return 0;
  return rollingEncodeTimes.reduce((a, b) => a + b, 0) / rollingEncodeTimes.length;
}

function getChronosState(pixelCount) {
  if (rollingEncodeTimes.length === 0) {
    const millions = pixelCount / 1_000_000;
    let effort = 9;
    if (millions > 50) effort = 2;       // Extreme: 50MP+ 
    else if (millions > 30) effort = 3;  // 30-50MP
    else if (millions > 15) effort = 4;  // 15-30MP
    else if (millions > 8) effort = 5;   // 8-15MP
    else if (millions > 4) effort = 6;   // 4-8MP
    else if (millions > 2) effort = 7;   // 2-4MP
    return { state: 'COLD-START', effort };
  }

  const avg = getAverageEncodeTime();
  const ENCODE_BUDGET_MS = 55000; // 55s budget (5s safety margin under 60s)
  const SEGMENT = ENCODE_BUDGET_MS / 8;

  let effort;
  if      (avg > SEGMENT * 7) { effort = 2; }
  else if (avg > SEGMENT * 6) { effort = 3; }
  else if (avg > SEGMENT * 5) { effort = 4; }
  else if (avg > SEGMENT * 4) { effort = 5; }
  else if (avg > SEGMENT * 3) { effort = 6; }
  else if (avg > SEGMENT * 2) { effort = 7; }
  else if (avg > SEGMENT * 1) { effort = 8; }
  else                        { effort = 9; }

  const state =
    effort >= 9 ? 'COLD' :
    effort >= 7 ? 'COOL' :
    effort >= 5 ? 'WARM' :
    effort >= 3 ? 'HOT' :
                  'CRITICAL';

  metrics.chronosStateHistory.push({ state, effort, avg: Math.round(avg), time: Date.now() });
  if (metrics.chronosStateHistory.length > 100) {
    metrics.chronosStateHistory.shift();
  }

  return { state, effort };
}

// ============================================================
// ENVIRONMENT TOGGLES
// ============================================================

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
const ENABLE_PALETTE = envBool('ENABLE_PALETTE', true);
const ENABLE_DESKEW = envBool('ENABLE_DESKEW', true);
const ENABLE_VOID_WATCHER = envBool('ENABLE_VOID_WATCHER', true);
const ENABLE_DITHER_ASSASSIN = envBool('ENABLE_DITHER_ASSASSIN', true);
const ENABLE_BANDING_EXORCIST = envBool('ENABLE_BANDING_EXORCIST', true);
const ENABLE_ALPHA_SENTINEL = envBool('ENABLE_ALPHA_SENTINEL', true);
const ENABLE_LAYOUT_PROPHET = envBool('ENABLE_LAYOUT_PROPHET', true);
const ENABLE_ENCODING_VERIFIER = envBool('ENABLE_ENCODING_VERIFIER', true);
const ENABLE_GHOST_STRIPPER = envBool('ENABLE_GHOST_STRIPPER', true);
const ENABLE_FORMAT_DUELIST = envBool('ENABLE_FORMAT_DUELIST', true);
const ENABLE_METADATA_REAPER = envBool('ENABLE_METADATA_REAPER', true);
const ENABLE_WEBP_PRESET = envBool('ENABLE_WEBP_PRESET', true);
const ENABLE_PROGRESSIVE_PNG = envBool('ENABLE_PROGRESSIVE_PNG', true);
const ENABLE_STREAM_REAPER = envBool('ENABLE_STREAM_REAPER', true);
const ENABLE_TIMEOUT_GUILLOTINE = envBool('ENABLE_TIMEOUT_GUILLOTINE', true);
const ENABLE_DIMENSION_OVERLORD = envBool('ENABLE_DIMENSION_OVERLORD', true);
const ENABLE_SEMAPHORE_WARDEN = envBool('ENABLE_SEMAPHORE_WARDEN', true);
const ENABLE_QUANTUM_SORCERER = envBool('ENABLE_QUANTUM_SORCERER', true);
const ENABLE_CHRONOS_SCRIBE = envBool('ENABLE_CHRONOS_SCRIBE', true);
const ENABLE_ORACLE_LEDGER = envBool('ENABLE_ORACLE_LEDGER', true);
const ENABLE_HEARTBEAT_SENTINEL = envBool('ENABLE_HEARTBEAT_SENTINEL', true);
const ENABLE_GUILLOTINE_GRACE = envBool('ENABLE_GUILLOTINE_GRACE', true);

// ============================================================
// HELPER FUNCTIONS
// ============================================================

// 🛑 ASYNC exact hash (replaces sync MD5 that blocked event loop)
async function generateExactHash(buffer) {
  try {
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return Buffer.from(digest).toString('hex').slice(0, 16);
    return createHash('sha256').update(buffer).digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}

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
      data[h * w - 1],
    ];
    const bgValue = corners.reduce((a, b) => a + b, 0) / 4;

    let sumX = 0, sumY = 0, sumXX = 0, sumYY = 0, sumXY = 0, count = 0;

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
        raw: { width: size, height: size, channels: channels },
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
    case 'png':
      return buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47;
    case 'webp':
      return buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
             buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50;
    case 'avif':
      return buffer[4] === 0x66 && buffer[5] === 0x74 && buffer[6] === 0x79 && buffer[7] === 0x70;
    default:
      return true;
  }
}

function getWebpPreset(analysis, lineArtResult, origW, origH) {
  if (!ENABLE_WEBP_PRESET) return 'default';
  if (lineArtResult && lineArtResult.isLineArt && lineArtResult.confidence > 0.85) return 'drawing';
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
  // 🛑 OPTIMIZED: resize before stats() to reduce memory on massive images
  const statsSource = metadata.width > 4096 || metadata.height > 4096
    ? await sharp(buffer).resize(4096, 4096, { fit: 'inside', withoutEnlargement: true }).toBuffer()
    : buffer;

  const stats = await sharp(statsSource).stats();
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
      colorVariance = Math.abs(rMean - gMean) + Math.abs(gMean - bMean) + Math.abs(rMean - bMean);
    }
  }

  const isGrayscale = colorVariance < 15;
  const isHighContrast = totalEntropy > 6.5;
  const isColorful = colorVariance > 80;
  const aspectRatio = (metadata.height || height) / (metadata.width || width);

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
    maxLuminance,
  };
}

function calculateQuality(analysis, baseQuality) {
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
  if (analysis.isColorful && analysis.sharpness > 80) return '4:4:4';
  return '4:2:0';
}

// ============================================================
// MAIN COMPRESS FUNCTION
// ============================================================

export default async function compress(req, res, buffer) {
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

  if (ENABLE_TIMEOUT_GUILLOTINE) {
    req.on('close', () => {
      clientDisconnected = true;
      abortController.abort();
    });

    res.on('close', () => {
      clientDisconnected = true;
      abortController.abort();
    });
  }

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

    // 🛑 EXACT CACHE: Non-destructive replacement for Lorekeeper steganography.
    const exactHash = await generateExactHash(buffer);
    if (exactHash) {
      const exactHit = exactCache.get(exactHash);
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

    let thumbResult = null;
    if (ENABLE_VOID_WATCHER || ENABLE_PALETTE || ENABLE_PLACEHOLDER) {
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

    const pHash = await generatePerceptualHash(buffer);
    const cachedResult = pHash ? perceptualCache.get(pHash) : null;

    if (cachedResult) {
      res.setHeader('X-Perceptual-Cache', 'HIT');
      res.setHeader('Content-Type', cachedResult.contentType);
      if (cachedResult.placeholder) res.setHeader('X-Placeholder', cachedResult.placeholder);
      if (cachedResult.grade) res.setHeader('X-Quality-Grade', cachedResult.grade);
      if (cachedResult.palette && cachedResult.palette.length > 0) {
        res.setHeader('X-Palette', cachedResult.palette.join(','));
      }
      if (ENABLE_ORACLE_LEDGER) {
        metrics.cacheHits++;
        metrics.totalBytesOut += cachedResult.buffer.length;
        metrics.totalBytesSaved += buffer.length - cachedResult.buffer.length;
      }
      return cachedResult.buffer;
    }

    if (ENABLE_ORACLE_LEDGER) {
      metrics.cacheMisses++;
    }

    if (signal.aborted) {
      res.setHeader('X-Timeout-Guillotine', 'ABORTED');
      res.status(499);
      return Buffer.alloc(0);
    }

    // 🛑 TIER WARDEN: Acquire semaphore based on image size tier.
    let semaphoreResult = { acquired: false, tierIndex: -1, slotsNeeded: 0 };
    if (ENABLE_SEMAPHORE_WARDEN) {
      semaphoreResult = acquireSemaphore(buffer.length);
      if (!semaphoreResult.acquired) {
        res.status(503);
        res.setHeader('X-Semaphore-Warden', semaphoreResult.reason);
        res.setHeader('X-Active-Encodes', `${activeEncodes}`);
        res.setHeader('X-Active-Slots', `${activeSlots}/${MAX_MEMORY_SLOTS}`);
        res.setHeader('Retry-After', '5');
        if (ENABLE_ORACLE_LEDGER) {
          metrics.semaphoreRejections++;
        }
        return Buffer.alloc(0);
      }
      res.setHeader('X-Semaphore-Warden', 'ACTIVE');
      res.setHeader('X-Semaphore-Tier', `${semaphoreResult.tierIndex}`);
      res.setHeader('X-Active-Slots', `${activeSlots}/${MAX_MEMORY_SLOTS}`);
    }

    try {
      const analysis = await detectImageType(buffer, metadata);
      const viewportMaxDim = getViewportMaxDim(req);

      let placeholder = thumbResult ? thumbResult.placeholder : null;
      let palette = thumbResult ? thumbResult.palette : [];

      if (ENABLE_PALETTE && palette.length > 0) {
        res.setHeader('X-Palette', palette.join(','));
      }

      let skewAngle = 0;
      if (ENABLE_DESKEW && !analysis.isMangaStrip) {
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

      let judgeResult = null;
      if (ENABLE_JUDGE) {
        judgeResult = judgeQuality(analysis, metadata);
      }

      let halftoneResult = null;
      if (ENABLE_MOIRE) {
        halftoneResult = await detectHalftone(buffer, metadata, analysis);
      }

      let lineArtResult = null;
      if (ENABLE_LINE_DENOISE || ENABLE_DITHER_ASSASSIN) {
        lineArtResult = await detectLineArt(buffer, analysis);
      }

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

      const pixelCount = (metadata.width || 0) * (metadata.height || 0);
      const chronos = ENABLE_CHRONOS_SCRIBE ? getChronosState(pixelCount) : { state: 'COLD', effort: 9 };

      const millions = pixelCount / 1_000_000;
      let effortCeiling;
      if (millions > 80)      effortCeiling = 2;
      else if (millions > 50) effortCeiling = 3;
      else if (millions > 30) effortCeiling = 4;
      else if (millions > 15) effortCeiling = 5;
      else if (millions > 8)  effortCeiling = 6;
      else if (millions > 4)  effortCeiling = 7;
      else if (millions > 2)  effortCeiling = 8;
      else                    effortCeiling = 9;

      const adaptiveEffort = Math.min(chronos.effort, effortCeiling);

      const requestedFormat = req.opts?.format || req.query.f || req.query.format;
      let outputFormat = 'jpeg';

      if (FORCE_JPEG) {
        outputFormat = 'jpeg';
      } else if (requestedFormat === 'avif' && ENABLE_AVIF) {
        outputFormat = 'avif';
      } else if (requestedFormat === 'webp' && ENABLE_WEBP) {
        outputFormat = 'webp';
      } else if (requestedFormat === 'jpeg' || requestedFormat === 'jpg') {
        outputFormat = 'jpeg';
      } else if (requestedFormat === 'png') {
        outputFormat = 'png';
      }

      const baseQuality = req.opts?.quality ?? (parseInt(req.query.q || req.query.quality) || DEFAULT_QUALITY);
      let quality = calculateQuality(analysis, baseQuality);

      if (judgeResult) {
        quality = Math.max(10, Math.min(95, quality + judgeResult.qualityAdjust));
      }

      const frameCount = metadata.pages || 1;

      if (isAnimated && frameCount > MAX_ANIMATION_FRAMES) {
        res.setHeader('X-Frame-Cap', 'TRUNCATED');
        if (ENABLE_ORACLE_LEDGER) {
          metrics.totalBytesOut += buffer.length;
        }
        return buffer;
      }

      let ditherAssassinActive = false;
      if (ENABLE_DITHER_ASSASSIN && lineArtResult && lineArtResult.isLineArt && lineArtResult.confidence > 0.85 && !isAnimated) {
        ditherAssassinActive = true;
        recordMetric('ditherAssassin');
      }

      let bandingExorcistActive = false;
      if (ENABLE_BANDING_EXORCIST && !ditherAssassinActive && !isAnimated) {
        if (analysis.stdevLuminance > 20 && analysis.stdevLuminance < 50 && analysis.sharpness < 30) {
          bandingExorcistActive = true;
          recordMetric('bandingExorcist');
        }
      }

      if (signal.aborted) {
        res.setHeader('X-Timeout-Guillotine', 'ABORTED');
        res.status(499);
        return Buffer.alloc(0);
      }

      let pipeline = sharp(buffer, {
        animated: isAnimated,
        limitInputPixels: 0,
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

      const userExplicitlyWantsColor = req.opts?.grayscale === false;
      const userExplicitlyWantsBW = req.opts?.grayscale === true;
      if (FORCE_GRAYSCALE || userExplicitlyWantsBW || (!userExplicitlyWantsColor && analysis.isGrayscale && !analysis.isColorful)) {
        pipeline = pipeline.grayscale();
      }

      if (ENABLE_LUMINANCE && !isAnimated && !ditherAssassinActive) {
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

      if (ENABLE_GHOST_STRIPPER && !isAnimated && !ditherAssassinActive) {
        if (analysis.meanLuminance > 150 && analysis.maxLuminance > 200 && analysis.maxLuminance < 253) {
          const stretch = 255 / analysis.maxLuminance;
          pipeline = pipeline.linear(stretch, 0);
          res.setHeader('X-Ghost-Stripper', `STRETCHED (max:${analysis.maxLuminance} -> 255)`);
          recordMetric('ghostStripper');
        }
      }

      if (ENABLE_DESKEW && skewAngle !== 0) {
        pipeline = pipeline.rotate(skewAngle, {
          background: analysis.isGrayscale ? { r: 255, g: 255, b: 255 } : { r: 255, g: 255, b: 255, alpha: 0 },
        });
      }

      if (halftoneResult && halftoneResult.isHalftone && halftoneResult.confidence > 0.85) {
        pipeline = pipeline.median(3);
        res.setHeader('X-Moire-Removed', 'true');
        recordMetric('moireRemoval');
      }

      if (lineArtResult && lineArtResult.isLineArt && lineArtResult.confidence > 0.85 && !ditherAssassinActive) {
        pipeline = pipeline.median(3);
        pipeline = pipeline.sharpen({
          sigma: 0.6,
          flat: 3.0,
          jagged: 1.5,
        });
        res.setHeader('X-Line-Denoise', 'true');
        recordMetric('lineDenoise');
      }

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

      if (targetWidth || targetHeight) {
        pipeline = pipeline.resize(targetWidth, targetHeight, {
          fit: 'inside',
          withoutEnlargement: true,
          kernel: sharp.kernel.lanczos3,
        });
      }

      if (analysis.sharpness < 50 && !analysis.isMangaStrip && !ditherAssassinActive) {
        const alreadySharpened = lineArtResult && lineArtResult.isLineArt && lineArtResult.confidence > 0.85;
        if (!alreadySharpened) {
          pipeline = pipeline.sharpen({
            sigma: 0.8,
            flat: 2.0,
            jagged: 1.0,
          });
        }
      }

      if (alphaStrippable) {
        pipeline = pipeline.flatten({ background: { r: 255, g: 255, b: 255 } });
      } else if (STRIP_ALPHA && outputFormat === 'jpeg' && !ditherAssassinActive) {
        pipeline = pipeline.flatten({ background: { r: 255, g: 255, b: 255 } });
      }

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

      let outputBuffer;
      let contentType;

      const encodeStart = Date.now();

      const needsBuffer = ENABLE_ENCODING_VERIFIER ||
                          ditherAssassinActive ||
                          (outputFormat === 'png' && !ENABLE_PROGRESSIVE_PNG);

      if (ENABLE_STREAM_REAPER && !needsBuffer && !clientDisconnected) {
        res.setHeader('X-Stream-Reaper', 'ACTIVE');
        recordMetric('streamReaper');

        const passthrough = new PassThrough();

        switch (outputFormat) {
          case 'avif':
            contentType = 'image/avif';
            pipeline = pipeline.avif({
              quality: Math.min(quality, 63),
              effort: adaptiveEffort,
              chromaSubsampling: getChromaSubsampling(analysis),
            });
            break;
          case 'webp':
            contentType = 'image/webp';
            pipeline = pipeline.webp({
              quality: quality,
              effort: adaptiveEffort,
              smartSubsample: true,
              preset: getWebpPreset(analysis, lineArtResult, origW, origH),
            });
            break;
          case 'jpeg':
          default:
            contentType = 'image/jpeg';
            pipeline = pipeline.jpeg({
              quality: quality,
              progressive: true,
              mozjpeg: true,
              chromaSubsampling: getChromaSubsampling(analysis),
              trellisQuantisation: true,
              overshootDeringing: true,
              optimiseScans: true,
            });
            break;
        }

        res.setHeader('Content-Type', contentType);
        res.setHeader('X-Perceptual-Cache', 'MISS');
        res.setHeader('X-Encode-Quality', String(quality));
        res.setHeader('X-Encode-Effort', String(adaptiveEffort));
        res.setHeader('X-Encode-Dims', `${targetWidth || origW}x${targetHeight || origH}`);
        if (judgeResult) {
          res.setHeader('X-Quality-Grade', judgeResult.grade);
          res.setHeader('X-Quality-Score', String(judgeResult.score));
        }
        if (ENABLE_CHRONOS_SCRIBE) {
          res.setHeader('X-Chronos-State', chronos.state);
          res.setHeader('X-Adaptive-Effort', String(adaptiveEffort));
        }
        res.setHeader('X-Image-Type', analysis.isMangaStrip ? 'manga-strip' :
          analysis.isMangaPage ? 'manga-page' :
          analysis.isAnime ? 'anime' :
          analysis.isGrayscale ? 'grayscale' : 'photo');

        pipeline.pipe(passthrough);
        passthrough.pipe(res);

        // 🛑 ABORT LISTENER (streaming path)
        if (ENABLE_TIMEOUT_GUILLOTINE) {
          signal.addEventListener('abort', () => {
            pipeline.destroy();
            passthrough.destroy();
            if (!res.writableEnded) {
              res.end();
            }
          }, { once: true });
        }

        await new Promise((resolve, reject) => {
          passthrough.on('finish', resolve);
          passthrough.on('error', reject);
          passthrough.on('close', resolve);
          pipeline.on('error', reject);
        });

        const encodeEnd = Date.now();
        const encodeTime = encodeEnd - encodeStart;
        if (ENABLE_CHRONOS_SCRIBE) {
          recordEncodeTime(encodeTime);
          res.setHeader('X-Processing-Time', `${encodeTime}ms`);
        }

        if (ENABLE_ORACLE_LEDGER) {
          metrics.formatCounts[outputFormat] = (metrics.formatCounts[outputFormat] || 0) + 1;
          metrics.totalEncodeTime += encodeTime;
          metrics.encodeCount++;
        }

        return null;
      }

      // 🛑 NON-STREAMING PATH (with abort listener fix)
      let pipelinePromise;

      if (ditherAssassinActive) {
        pipeline = pipeline.threshold(128);
        pipelinePromise = pipeline.png({
          palette: true,
          colours: 2,
          compressionLevel: 9,
          dither: 0,
          progressive: ENABLE_PROGRESSIVE_PNG,
        }).toBuffer();
        contentType = 'image/png';
        res.setHeader('X-Dither-Assassin', 'ACTIVE');
      } else {
        const chromaSubsampling = getChromaSubsampling(analysis);

        switch (outputFormat) {
          case 'avif':
            pipelinePromise = pipeline.avif({
              quality: Math.min(quality, 63),
              effort: adaptiveEffort,
              chromaSubsampling: chromaSubsampling,
            }).toBuffer();
            contentType = 'image/avif';
            break;

          case 'webp':
            pipelinePromise = pipeline.webp({
              quality: quality,
              effort: adaptiveEffort,
              smartSubsample: true,
              preset: getWebpPreset(analysis, lineArtResult, origW, origH),
            }).toBuffer();
            contentType = 'image/webp';
            break;

          case 'png': {
            const useQuantumSorcerer = ENABLE_QUANTUM_SORCERER && (
              analysis.entropy < 6.0 ||
              (lineArtResult && lineArtResult.isLineArt && lineArtResult.confidence > 0.7) ||
              analysis.isMangaPage ||
              analysis.isMangaStrip
            );

            if (useQuantumSorcerer) {
              pipelinePromise = pipeline.png({
                compressionLevel: 8,
                palette: true,
                colours: 256,
                dither: 1.0,
                quality: quality,
                progressive: ENABLE_PROGRESSIVE_PNG,
              }).toBuffer();
              res.setHeader('X-Quantum-Sorcerer', 'ACTIVE');
              recordMetric('quantumSorcerer');
            } else {
              pipelinePromise = pipeline.png({
                compressionLevel: 8,
                palette: analysis.isGrayscale,
                quality: quality,
                progressive: ENABLE_PROGRESSIVE_PNG,
              }).toBuffer();
            }
            contentType = 'image/png';
            break;
          }

          case 'jpeg':
          default:
            pipelinePromise = pipeline.jpeg({
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
      }

      // 🛑 ABORT LISTENER (non-streaming path) — kills the pipeline if client disconnects.
      if (ENABLE_TIMEOUT_GUILLOTINE) {
        const onAbort = () => {
          pipeline.destroy();
        };
        signal.addEventListener('abort', onAbort, { once: true });
        try {
          outputBuffer = await pipelinePromise;
        } finally {
          signal.removeEventListener('abort', onAbort);
        }
      } else {
        outputBuffer = await pipelinePromise;
      }

      const encodeEnd = Date.now();
      const encodeTime = encodeEnd - encodeStart;

      if (ENABLE_CHRONOS_SCRIBE) {
        recordEncodeTime(encodeTime);
        res.setHeader('X-Processing-Time', `${encodeTime}ms`);
        res.setHeader('X-Chronos-State', chronos.state);
        res.setHeader('X-Adaptive-Effort', String(adaptiveEffort));
        res.setHeader('X-Avg-Encode-Time', `${Math.round(getAverageEncodeTime())}ms`);
      }

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

      if (ENABLE_CHRONOS_SCRIBE) {
        const bytesSaved = buffer.length - outputBuffer.length;
        res.setHeader('X-Bytes-Saved', `${(bytesSaved / 1024).toFixed(1)}KB`);
      }

      // 🛑 CACHE INSERTION: Store in both caches.
      const cacheEntry = {
        buffer: outputBuffer,
        contentType: contentType,
        placeholder: placeholder,
        grade: judgeResult ? judgeResult.grade : null,
        palette: palette,
      };

      if (exactHash) exactCache.set(exactHash, cacheEntry);
      if (pHash) perceptualCache.set(pHash, cacheEntry);

      res.setHeader('X-Perceptual-Cache', 'MISS');
      res.setHeader('X-Encode-Quality', String(quality));
      res.setHeader('X-Encode-Effort', String(adaptiveEffort));
      res.setHeader('X-Encode-Dims', `${targetWidth || origW}x${targetHeight || origH}`);
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

    } finally {
      if (ENABLE_SEMAPHORE_WARDEN && semaphoreResult.acquired) {
        releaseSemaphore(semaphoreResult.tierIndex, semaphoreResult.slotsNeeded);
      }
    }

  } catch (err) {
    if (clientDisconnected || signal.aborted) {
      res.setHeader('X-Timeout-Guillotine', 'ABORTED');
      return Buffer.alloc(0);
    }
    console.error('[COMPRESS ERROR]', err.message);
    res.setHeader('X-Compression', 'FAILED');
    if (ENABLE_ORACLE_LEDGER) {
      metrics.encodingFailures++;
      metrics.totalBytesOut += buffer.length;
    }
    if (!res.headersSent && !res.writableEnded) {
      res.setHeader('Content-Type', `image/${req.opts?.originType || 'jpeg'}`);
      res.end(buffer);
    } else if (!res.writableEnded) {
      res.end();
    }
    return null;
  } finally {
    activeRequests--;
  }
    }
