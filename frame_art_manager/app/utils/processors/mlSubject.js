'use strict';

// ── Alpine/musl compatibility ──────────────────────────────────────────────────
//
// @huggingface/transformers v3 browser bundle looks for the ONNX Runtime at
// globalThis[Symbol.for('onnxruntime')]. In a browser this is populated by
// onnxruntime-web's own init code; in Node.js it is not. The IIFE below sets it
// synchronously at module load time — before the first dynamic import of the
// transformers module evaluates.
//
// This must be at the top of the file so it runs when pipeline.js requires
// this module, which is before mlSubjectProcessor() is ever called.
(function () {
  const sym = Symbol.for('onnxruntime');
  if (!(sym in globalThis)) {
    try {
      // Use the default onnxruntime-web entry. The /wasm subpath uses blob: URLs
      // which Node.js ESM rejects; the default entry uses https: by default but
      // env.wasm.wasmPaths redirects it to a local file:// URL instead.
      const ortWeb = require('onnxruntime-web');
      const ortObj = ortWeb.default ?? ortWeb;
      const wasmDistDir = require('url').pathToFileURL(
        require('path').dirname(require.resolve('onnxruntime-web')) + require('path').sep
      ).href;
      ortObj.env.wasm.wasmPaths = wasmDistDir;
      ortObj.env.wasm.numThreads = 1;
      globalThis[sym] = ortObj;
    } catch (_) {}
  }
  // Expose sharp to the transformers.web.js bundle (Patch 3 uses this via
  // globalThis.__nativeSharp; require() is unavailable inside webpack factories).
  try {
    if (!globalThis.__nativeSharp) globalThis.__nativeSharp = require('sharp');
  } catch (_) {}
})();

const sharp = require('sharp');

/**
 * ML Subject window-setter processor.
 *
 * Uses briaai/RMBG-1.4 (background removal model, q8 quantized, ~44 MB) to
 * detect the foreground subject of an image and set context.focusWindow to its
 * bounding box. Downstream crop processors use this window to center their crop
 * on the actual subject (person, figure, focal object) rather than relying on
 * variance heuristics.
 *
 * Why this works for paintings: RMBG-1.4 was trained on a broad dataset of
 * photographs and generalises well to painted subjects — it detects the figure
 * (person, animal, focal object) rather than canvas boundaries. This makes it
 * suitable as a focus-window setter even for classical portraiture where
 * variance-based approaches pick up detailed clothing instead of the face.
 *
 * Performance: ~11 s first inference (WASM single-threaded). Model is cached
 * at /data/huggingface after first download (~44 MB). Pipeline session reused
 * across calls (singleton).
 *
 * Alpine compatibility: @huggingface/transformers requires Dockerfile patch to
 * remove the "node" export condition so Node.js loads the browser/WASM bundle
 * instead of the onnxruntime-node glibc bundle (see Dockerfile). The IIFE above
 * pre-populates the onnxruntime global before any import evaluates the module.
 *
 * Preprocessing is done manually with Sharp (not via RawImage) to avoid
 * relying on transformers' sharp webpack mock, which is stubbed out in the
 * web bundle.
 *
 * options:
 *   threshold    0.5   Mask value above which a pixel is considered foreground.
 *   padFraction  0.10  Expand the detected bounding box by this fraction of its
 *                      dimension on each edge, to include context around the subject.
 *   dtype        'q8'  ONNX model quantization: 'q8' (44 MB) or 'fp32' (175 MB).
 */

const MODEL_ID         = 'briaai/RMBG-1.4';
const MODEL_INPUT_SIZE = 1024;
// ImageNet normalization (used by RMBG-1.4 preprocessing)
const IMAGENET_MEAN = [0.485, 0.456, 0.406];
const IMAGENET_STD  = [0.229, 0.224, 0.225];

// ── Singleton model ────────────────────────────────────────────────────────────

let _modelPromise = null;

function getModel(dtype = 'q8') {
  if (!_modelPromise) {
    _modelPromise = (async () => {
      const t0 = Date.now();
      console.log('[ml_subject] loading RMBG-1.4 model...');

      // Dynamic import required: the browser bundle is an ES Module.
      // Use pipeline('background-removal') rather than AutoModelForImageSegmentation:
      // RMBG-1.4 has model_type 'segformer' which is unsupported in transformers.js
      // model class dispatch, but the background-removal pipeline loads the ONNX
      // files directly and bypasses that dispatch.
      const { pipeline, env } = await import('@huggingface/transformers');

      // Set cache directory to HA persistent storage before loading the model.
      env.cacheDir = '/data/huggingface';

      const pipe = await pipeline('background-removal', MODEL_ID, {
        dtype,
        device: 'wasm',
      });

      console.log(`[ml_subject] RMBG-1.4 ready in ${Date.now() - t0}ms`);
      return pipe;
    })();

    _modelPromise.catch((e) => {
      console.error(`[ml_subject] model load failed: ${e.message}`);
      _modelPromise = null;   // allow retry on next call
    });
  }
  return _modelPromise;
}

// Pre-warm: kick off model loading at module load time. Uses dynamic import()
// which is valid in CJS. Errors are expected on first startup (model not yet
// cached) — swallow them here; each request retries via getModel().
import('@huggingface/transformers').catch(() => {});


// ── Processor ─────────────────────────────────────────────────────────────────

async function mlSubjectProcessor(context, {
  threshold   = 0.5,
  padFraction = 0.10,
  dtype       = 'q8',
} = {}) {
  const t0    = Date.now();
  const origW = context.width;
  const origH = context.height;

  // Load pipeline (cached after first call).
  let pipe;
  try {
    pipe = await getModel(dtype);
  } catch (e) {
    console.warn(`[ml_subject] model unavailable: ${e.message} — skipping`);
    context.debug.ml_subject = { error: e.message, timing: { total: Date.now() - t0 } };
    return context;
  }

  const tLoad = Date.now();

  // Pass image as a base64 data URL. The pipeline handles its own preprocessing
  // (resize to 1024×1024, normalization). We avoid Sharp preprocessing here so
  // we don't conflict with the pipeline's internal image handling.
  const dataUrl = `data:image/jpeg;base64,${context.buffer.toString('base64')}`;

  // Run inference.
  let results;
  try {
    results = await pipe(dataUrl);
  } catch (e) {
    console.warn(`[ml_subject] inference failed: ${e.message} — skipping`);
    context.debug.ml_subject = { error: `inference: ${e.message}`, timing: { total: Date.now() - t0 } };
    return context;
  }

  const tInfer = Date.now();

  // The background-removal pipeline may return two formats:
  //   (a) [{label, score, mask: RawImage}]  — ImageSegmentation format
  //   (b) [RawImage]                         — RGBA image (alpha = foreground mask)
  // Handle both: prefer .mask (grayscale 0-255); fall back to alpha channel.
  const result = Array.isArray(results) ? results[0] : results;
  let maskData, maskW, maskH;
  if (result && result.mask && result.mask.data) {
    // Format (a): grayscale mask RawImage
    maskData = result.mask.data;
    maskW    = result.mask.width;
    maskH    = result.mask.height;
  } else if (result && result.data && result.width && result.height) {
    // Format (b): RGBA RawImage — extract alpha channel as mask
    maskW = result.width;
    maskH = result.height;
    const ch = result.channels || Math.round(result.data.length / (maskW * maskH));
    if (ch === 4) {
      maskData = new Uint8Array(maskW * maskH);
      for (let i = 0; i < maskW * maskH; i++) maskData[i] = result.data[i * 4 + 3];
    } else if (ch === 1) {
      maskData = result.data;
    }
  }
  if (!maskData) {
    const keys = result ? Object.keys(result).join(',') : 'null';
    console.warn(`[ml_subject] no mask in pipeline result (keys: ${keys}) — skipping`);
    context.debug.ml_subject = { error: 'no mask in result', resultKeys: keys, timing: { total: Date.now() - t0 } };
    return context;
  }

  const maskThresh = Math.round(threshold * 255);

  // Find bounding box of foreground pixels (mask value >= threshold).
  let minX = maskW, minY = maskH, maxX = -1, maxY = -1;
  let fgCount = 0;
  for (let y = 0; y < maskH; y++) {
    for (let x = 0; x < maskW; x++) {
      if (maskData[y * maskW + x] >= maskThresh) {
        fgCount++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (fgCount === 0 || maxX < minX || maxY < minY) {
    console.log('[ml_subject] no foreground detected — focusWindow unchanged');
    context.debug.ml_subject = {
      detected: false,
      timing: { total: Date.now() - t0, load: tLoad - t0, infer: tInfer - tLoad },
    };
    return context;
  }

  // Project bounding box to original image coordinates.
  // The background-removal pipeline returns a mask at the original image size,
  // so scale from maskW/maskH → origW/origH (usually 1:1, but use actual mask dims).
  const scaleX = origW / maskW;
  const scaleY = origH / maskH;
  const bboxW  = (maxX - minX) * scaleX;
  const bboxH  = (maxY - minY) * scaleY;
  const padX   = Math.round(bboxW * padFraction);
  const padY   = Math.round(bboxH * padFraction);

  const wx = Math.max(0,    Math.round(minX * scaleX) - padX);
  const wy = Math.max(0,    Math.round(minY * scaleY) - padY);
  const wr = Math.min(origW, Math.round(maxX * scaleX) + padX);
  const wb = Math.min(origH, Math.round(maxY * scaleY) + padY);

  context.focusWindow = {
    x: wx, y: wy, w: wr - wx, h: wb - wy,
    confidence: 0.85,
    source: 'ml_subject',
  };

  const tEnd = Date.now();
  console.log(
    `[ml_subject] fg=${fgCount}px mask${maskW}×${maskH}(${minX},${minY}→${maxX},${maxY})` +
    ` → orig window(${wx},${wy} ${wr-wx}×${wb-wy})` +
    ` [load=${tLoad-t0}ms infer=${tInfer-tLoad}ms post=${tEnd-tInfer}ms]`
  );

  context.debug.ml_subject = {
    timing:    { total: tEnd - t0, load: tLoad - t0, infer: tInfer - tLoad, postprocess: tEnd - tInfer },
    detected:  true,
    fgPixels:  fgCount,
    bboxMask:  { x: minX, y: minY, w: maxX - minX, h: maxY - minY },
    maskSize:  { w: maskW, h: maskH },
    window:    { ...context.focusWindow },
  };

  return context;
}

module.exports = { mlSubjectProcessor };
