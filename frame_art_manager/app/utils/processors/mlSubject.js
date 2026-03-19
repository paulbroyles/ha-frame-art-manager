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
  try {
    const ort = require('onnxruntime-web');
    const sym = Symbol.for('onnxruntime');
    if (!globalThis[sym]) globalThis[sym] = ort;
  } catch (_) {}
})();

const sharp = require('sharp');
const path  = require('path');
const fs    = require('fs');

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

      // Set cache directory to HA persistent storage before first import.
      // Must be set on the env object before the model is loaded.
      const tf = require('@huggingface/transformers');
      tf.env.cacheDir = '/data/huggingface';

      const model = await tf.AutoModelForImageSegmentation.from_pretrained(MODEL_ID, {
        dtype,
        device: 'wasm',
      });

      console.log(`[ml_subject] RMBG-1.4 ready in ${Date.now() - t0}ms`);
      return model;
    })();

    _modelPromise.catch((e) => {
      console.error(`[ml_subject] model load failed: ${e.message}`);
      _modelPromise = null;   // allow retry on next call
    });
  }
  return _modelPromise;
}

// Pre-warm: start loading at module load time so the first pipeline request
// doesn't wait for the full model load. Errors are expected before the model
// is cached (/data/huggingface may not exist yet) — swallow them here.
getModel().catch(() => {});


// ── Processor ─────────────────────────────────────────────────────────────────

async function mlSubjectProcessor(context, {
  threshold   = 0.5,
  padFraction = 0.10,
  dtype       = 'q8',
} = {}) {
  const t0    = Date.now();
  const origW = context.width;
  const origH = context.height;

  // Load model (cached after first call).
  let model;
  try {
    model = await getModel(dtype);
  } catch (e) {
    console.warn(`[ml_subject] model unavailable: ${e.message} — skipping`);
    context.debug.ml_subject = { error: e.message, timing: { total: Date.now() - t0 } };
    return context;
  }

  const tLoad = Date.now();

  // Preprocess manually with Sharp — resize to MODEL_INPUT_SIZE × MODEL_INPUT_SIZE,
  // extract raw RGB, build NCHW float32 tensor with ImageNet normalization.
  // We do NOT use RawImage.fromURL/fromBlob to avoid the transformers sharp mock.
  const { data: pixels, info } = await sharp(context.buffer)
    .resize(MODEL_INPUT_SIZE, MODEL_INPUT_SIZE, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const n = MODEL_INPUT_SIZE * MODEL_INPUT_SIZE;
  const inputData = new Float32Array(3 * n);
  const ch = info.channels;
  for (let i = 0; i < n; i++) {
    inputData[i]         = (pixels[i * ch]     / 255 - IMAGENET_MEAN[0]) / IMAGENET_STD[0];
    inputData[i + n]     = (pixels[i * ch + 1] / 255 - IMAGENET_MEAN[1]) / IMAGENET_STD[1];
    inputData[i + 2 * n] = (pixels[i * ch + 2] / 255 - IMAGENET_MEAN[2]) / IMAGENET_STD[2];
  }

  const { Tensor } = require('@huggingface/transformers');
  const pixel_values = new Tensor('float32', inputData, [1, 3, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE]);

  const tPreprocess = Date.now();

  // Run inference.
  let outputs;
  try {
    outputs = await model({ pixel_values });
  } catch (e) {
    console.warn(`[ml_subject] inference failed: ${e.message} — skipping`);
    context.debug.ml_subject = { error: `inference: ${e.message}`, timing: { total: Date.now() - t0 } };
    return context;
  }

  const tInfer = Date.now();

  // Extract mask. RMBG-1.4 output tensor may be named 'output' or be the first value.
  const maskTensor = outputs.output ?? Object.values(outputs)[0];
  if (!maskTensor) {
    console.warn('[ml_subject] no output tensor — skipping');
    context.debug.ml_subject = { error: 'no output tensor', timing: { total: Date.now() - t0 } };
    return context;
  }
  const mask = maskTensor.data;  // Float32Array [MODEL_INPUT_SIZE × MODEL_INPUT_SIZE]

  // Find bounding box of foreground pixels (mask value >= threshold).
  let minX = MODEL_INPUT_SIZE, minY = MODEL_INPUT_SIZE, maxX = -1, maxY = -1;
  let fgCount = 0;
  for (let y = 0; y < MODEL_INPUT_SIZE; y++) {
    for (let x = 0; x < MODEL_INPUT_SIZE; x++) {
      if (mask[y * MODEL_INPUT_SIZE + x] >= threshold) {
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
      timing: { total: Date.now() - t0, load: tLoad - t0, preprocess: tPreprocess - tLoad, infer: tInfer - tPreprocess },
    };
    return context;
  }

  // Project bounding box to original image coordinates + expand by padFraction.
  const scaleX = origW / MODEL_INPUT_SIZE;
  const scaleY = origH / MODEL_INPUT_SIZE;
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
    `[ml_subject] fg=${fgCount}px mask(${minX},${minY}→${maxX},${maxY})` +
    ` → orig window(${wx},${wy} ${wr-wx}×${wb-wy})` +
    ` [load=${tLoad-t0}ms pre=${tPreprocess-tLoad}ms infer=${tInfer-tPreprocess}ms post=${tEnd-tInfer}ms]`
  );

  context.debug.ml_subject = {
    timing:    { total: tEnd - t0, load: tLoad - t0, preprocess: tPreprocess - tLoad, infer: tInfer - tPreprocess, postprocess: tEnd - tInfer },
    detected:  true,
    fgPixels:  fgCount,
    bbox1024:  { x: minX, y: minY, w: maxX - minX, h: maxY - minY },
    window:    { ...context.focusWindow },
  };

  return context;
}

module.exports = { mlSubjectProcessor };
