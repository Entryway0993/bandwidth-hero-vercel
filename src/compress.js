import sharp from 'sharp';
import redirect from './redirect.js';
import { URL } from 'url';
import sanitizeFilename from 'sanitize-filename';

// ─── Sharp Global Config ──────────────────────────────────────────────────────
sharp.cache({ memory: 50, files: 0 });
sharp.concurrency(1);
sharp.simd(true);

// ─── Constants ────────────────────────────────────────────────────────────────
const MAX_DIMENSION        = 16_384;
const LARGE_IMAGE_PIXELS   = 4_000_000;
const MEDIUM_IMAGE_PIXELS  = 1_000_000;
const MAX_PIXEL_LIMIT      = 100_000_000;
const PROCESSING_TIMEOUT   = 55_000;

// ─── Main Entry Point ─────────────────────────────────────────────────────────

/**
 * Compress and serve an image, streaming large files to save RAM.
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 * @param {Buffer | string}            input  - Raw buffer or file path
 */
export default async function compress(req, res, input) {
  validateInput(input);

  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), PROCESSING_TIMEOUT);

  // Resolve outside try so catch/finally can reference them
  let pipeline = null;

  try {
    const params  = parseCompressionParams(req);
    const source  = sharp(input, {
      animated:         true,
      limitInputPixels: MAX_PIXEL_LIMIT,
    });

    const metadata = await source.metadata();
    assertValidMetadata(metadata);

    const { width, height, pages = 1 } = metadata;
    const isAnimated  = pages > 1;
    const pixelCount  = width * height;

    if (pixelCount > MAX_PIXEL_LIMIT) {
      throw new CompressionError('Image exceeds maximum pixel limit', 413);
    }

    const format       = isAnimated ? 'webp' : params.format;
    const formatOpts   = buildFormatOptions(format, params.quality, width, height, isAnimated);

    // Build the Sharp pipeline
    pipeline = buildPipeline(source, { grayscale: params.grayscale, width, height, isAnimated });
    pipeline = pipeline.toFormat(format, formatOpts);

    // ── Stream path: large buffers skip toBuffer() to save RAM ───────────────
    const isLargeBuffer = Buffer.isBuffer(input) && input.length > 2_000_000;
    if (isLargeBuffer) {
      await streamImage(pipeline, { req, res, format, abortController });
      return;
    }

    // ── Buffer path ───────────────────────────────────────────────────────────
    const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });

    sendImage(res, data, format, {
      url:        req.params.url ?? '',
      originSize: req.params.originSize ?? 0,
      bytesSaved: Math.max((req.params.originSize ?? 0) - info.size, 0),
    });

  } catch (err) {
    pipeline?.destroy?.();
    fail(err, req, res);
  } finally {
    clearTimeout(timeout);
  }
}

// ─── Pipeline Builder ─────────────────────────────────────────────────────────

function buildPipeline(source, { grayscale, width, height, isAnimated }) {
  let pipe = source.clone();

  if (grayscale) {
    pipe = pipe.grayscale();
  }

  const cap = isAnimated ? 600 : MAX_DIMENSION;
const needsResize = width > cap || height > cap;
  if (needsResize) {
    pipe = pipe.resize({
      width:               Math.min(width, cap),
      height:              Math.min(height, cap),
      fit:                 'inside',
      withoutEnlargement: true,
    });
  }

  return pipe;
}

// ─── Streaming ────────────────────────────────────────────────────────────────

/**
 * Pipe a Sharp transform stream directly to the HTTP response.
 * Cleans up on client disconnect or abort signal.
 */
function streamImage(pipeline, { req, res, format, abortController }) {
  return new Promise((resolve, reject) => {
    setCommonHeaders(res, format);
    res.setHeader('Transfer-Encoding', 'chunked');

    const stream = pipeline; // pipeline is already a Transform stream

    const cleanup = () => {
      stream.destroy?.();
      abortController.abort();
    };

    req.socket.once('close', cleanup);
    abortController.signal.addEventListener('abort', cleanup, { once: true });

    stream
      .pipe(res)
      .on('finish', resolve)
      .on('error', (err) => {
        if (!res.headersSent) reject(new CompressionError('Streaming failed', 500, err));
        else resolve(); // headers sent — nothing more we can do
      });
  });
}

// ─── Response Helpers ─────────────────────────────────────────────────────────

function sendImage(res, data, format, { url, originSize, bytesSaved }) {
  const rawName = (() => {
    try { return new URL(url).pathname.split('/').pop() || 'image'; }
    catch { return 'image'; }
  })();
  const filename = `${sanitizeFilename(rawName)}.${format}`;

  setCommonHeaders(res, format);
  res.setHeader('Content-Length',       data.length);
  res.setHeader('Content-Disposition',  `inline; filename="${filename}"`);
  res.setHeader('x-original-size',      originSize);
  res.setHeader('x-bytes-saved',        bytesSaved);
  res.status(200).end(data);
}

function setCommonHeaders(res, format) {
  const ONE_YEAR = 'public, max-age=31536000, immutable';
  res.setHeader('Content-Type',                  `image/${format}`);
  res.setHeader('X-Content-Type-Options',        'nosniff');
  res.setHeader('Cache-Control',                 ONE_YEAR);
  res.setHeader('CDN-Cache-Control',             ONE_YEAR);
  res.setHeader('Vercel-CDN-Cache-Control',      ONE_YEAR);
}

// ─── Format / Quality ─────────────────────────────────────────────────────────

function parseCompressionParams(req) {
  return {
    format:  req.params?.webp ? 'avif' : 'jpeg',
    quality: clamp(parseInt(req.params?.quality, 10) || 75, 10, 100),
    grayscale: req.params?.grayscale === 'true' || req.params?.grayscale === true,
  };
}

function buildFormatOptions(format, quality, width, height, isAnimated) {
  if (format === 'webp') {
    return {
      quality: isAnimated ? 35 : quality,
      alphaQuality: 45,
      effort: 6,
      smartSubsample: true,
      minSize: true,
      ...(isAnimated && { loop: 0 }),
    };
  }
  if (format === 'avif') {
    return {
      quality,
      effort: 4,
      ...avifTileParams(width * height),
    };
  }
  return {
    quality,
    chromaSubsampling: '4:2:0',
  };
    }

function avifTileParams(area) {
  if (area > LARGE_IMAGE_PIXELS)  return { tileRows: 1, tileCols: 1, minQuantizer: 20, maxQuantizer: 40, effort: 3 };
  if (area > MEDIUM_IMAGE_PIXELS) return { tileRows: 1, tileCols: 1, minQuantizer: 28, maxQuantizer: 48, effort: 3 };
  return                                 { tileRows: 1, tileCols: 1, minQuantizer: 26, maxQuantizer: 46, effort: 4 };
}

// ─── Validation ───────────────────────────────────────────────────────────────

function validateInput(input) {
  if (!Buffer.isBuffer(input) && typeof input !== 'string') {
    throw new CompressionError('Invalid input: must be a Buffer or file path', 400);
  }
}

function assertValidMetadata(metadata) {
  if (!metadata?.width || !metadata?.height) {
    throw new CompressionError('Could not read image metadata', 422);
  }
}

// ─── Error Handling ───────────────────────────────────────────────────────────

class CompressionError extends Error {
  /** @param {string} message @param {number} statusCode @param {Error} [cause] */
  constructor(message, statusCode = 500, cause = null) {
    super(message, { cause });
    this.name        = 'CompressionError';
    this.statusCode  = statusCode;
  }
}

function fail(err, req, res) {
  const isDev = process.env.NODE_ENV === 'development';

  console.error(JSON.stringify({
    level:      'error',
    message:    err?.message,
    statusCode: err?.statusCode,
    url:        req?.params?.url?.slice(0, 100),
    cause:      err?.cause?.message,
    ...(isDev && { stack: err?.stack }),
  }));

  redirect(req, res);
}

// ─── Utilities ────────────────────────────────────────────────────────────────

const clamp = (v, min, max) => Math.min(Math.max(v, min), max);
