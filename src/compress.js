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
  
  // 🛑 1GB RAM CONSTRAINT: ZOMBIE STREAM DEFUSAL
  // If the client disconnects mid-download, abort the Sharp instance to save CPU/RAM
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
    // Client disconnected or encoding failed
    if (!res.headersSent) {
      res.status(500).end();
    } else {
      res.end();
    }
  }
}
