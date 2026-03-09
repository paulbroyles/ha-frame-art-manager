'use strict';

const sharp = require('sharp');

// ── Target dimensions ─────────────────────────────────────────────────────────

const LANDSCAPE_TARGET = { w: 3840, h: 2160 };
const PORTRAIT_TARGET  = { w: 2160, h: 3840 };

// ── Crop engine registry ──────────────────────────────────────────────────────

/**
 * Crop engine interface:
 *   async (buffer, inputW, inputH, targetW, targetH, options) → Buffer
 *
 * The engine is responsible for both scaling (if needed) and cropping.
 * It must never upscale — targetW <= inputW and targetH <= inputH are guaranteed
 * by computeTargetDimensions.
 */

/**
 * Sharp-based crop engine.
 * options.strategy: 'attention' | 'entropy' | 'centre'
 *
 * 'attention' (default): saliency-based; favors faces and high-contrast subjects.
 *   Best for paintings — handles portraits and figurative work well.
 * 'entropy': maximizes Shannon entropy; favors complex/textured regions.
 * 'centre': crops from the geometric center; predictable, no analysis.
 */
async function sharpCropEngine(buffer, inputW, inputH, targetW, targetH, { strategy = 'attention' } = {}) {
  if (targetW === inputW && targetH === inputH) return buffer;
  return sharp(buffer)
    .resize(targetW, targetH, { fit: 'cover', position: strategy })
    .toBuffer();
}

const CROP_ENGINES = {
  sharp: sharpCropEngine,
  // Future: ml: mlCropEngine
};

// ── Pre-processors ────────────────────────────────────────────────────────────

/**
 * Pre-processor interface:
 *   async (buffer, options) → Buffer
 *
 * Pre-processors run before the TV-fit step. They detect and remove decorative
 * frames or borders from artwork images so the crop engine sees only painting content.
 */

/**
 * Sharp Trim pre-processor.
 * Removes pixels along the image edges that match the corner pixel color within
 * a tolerance threshold. Works best on solid uniform borders (e.g., matte black).
 *
 * options.threshold (default 10): color similarity tolerance (0–255).
 *   Higher values trim more aggressively.
 */
async function trimPreProcessor(buffer, { threshold = 10 } = {}) {
  try {
    return await sharp(buffer).trim({ threshold }).toBuffer();
  } catch {
    // Sharp throws if trim() would eliminate the entire image — return original.
    return buffer;
  }
}

/**
 * Variance Scan pre-processor.
 * Scans inward from each edge, computing per-row/column luminance variance.
 * Rows/columns with variance below varianceThreshold are considered frame (low
 * detail) and removed. Scanning stops at the first high-variance row/column
 * (painting content) or when maxCropFraction is reached.
 *
 * options.varianceThreshold (default 400): minimum luminance variance to be
 *   treated as painting content. Solid black → ~0; textured frame → ~100–600;
 *   complex painting → typically 1000+. Tune upward for heavily textured frames.
 *
 * options.maxCropFraction (default 0.25): hard cap on how much of any single
 *   dimension may be cropped. Guards against pathological over-cropping of
 *   paintings with dark or simple edges.
 */
async function varianceScanPreProcessor(buffer, {
  varianceThreshold = 400,
  maxCropFraction  = 0.25,
} = {}) {
  const { data, info } = await sharp(buffer)
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;

  // Luminance (BT.601) variance for a horizontal row.
  function rowVariance(y) {
    const offset = y * width * channels;
    let sum = 0, sumSq = 0;
    for (let x = 0; x < width; x++) {
      const b = offset + x * channels;
      const lum = 0.299 * data[b] + 0.587 * data[b + 1] + 0.114 * data[b + 2];
      sum += lum;
      sumSq += lum * lum;
    }
    const mean = sum / width;
    return sumSq / width - mean * mean;
  }

  // Luminance variance for a vertical column.
  function colVariance(x) {
    let sum = 0, sumSq = 0;
    for (let y = 0; y < height; y++) {
      const b = (y * width + x) * channels;
      const lum = 0.299 * data[b] + 0.587 * data[b + 1] + 0.114 * data[b + 2];
      sum += lum;
      sumSq += lum * lum;
    }
    const mean = sum / height;
    return sumSq / height - mean * mean;
  }

  const maxRows = Math.floor(height * maxCropFraction);
  const maxCols = Math.floor(width  * maxCropFraction);

  // Scan each edge inward; extend crop while variance is below threshold.
  let cropTop = 0;
  for (let y = 0; y < maxRows; y++) {
    if (rowVariance(y) < varianceThreshold) cropTop = y + 1; else break;
  }
  let cropBottom = 0;
  for (let y = height - 1; y >= height - maxRows; y--) {
    if (rowVariance(y) < varianceThreshold) cropBottom = height - y; else break;
  }
  let cropLeft = 0;
  for (let x = 0; x < maxCols; x++) {
    if (colVariance(x) < varianceThreshold) cropLeft = x + 1; else break;
  }
  let cropRight = 0;
  for (let x = width - 1; x >= width - maxCols; x--) {
    if (colVariance(x) < varianceThreshold) cropRight = width - x; else break;
  }

  if (cropTop === 0 && cropBottom === 0 && cropLeft === 0 && cropRight === 0) {
    return buffer;
  }

  const extractLeft   = cropLeft;
  const extractTop    = cropTop;
  const extractWidth  = width  - cropLeft - cropRight;
  const extractHeight = height - cropTop  - cropBottom;

  console.log(`[imageProcessor] variance_scan: removing ${cropTop}px top, ${cropBottom}px bottom, ${cropLeft}px left, ${cropRight}px right`);
  return sharp(buffer)
    .extract({ left: extractLeft, top: extractTop, width: extractWidth, height: extractHeight })
    .toBuffer();
}

// TODO (Option 3): ML-based frame segmentation
// Use a pre-trained ONNX model (e.g., fine-tuned SAM or SegFormer) to identify
// painting region vs. decorative frame — handles irregular and ornate frames.
// Cost: ~50–200 MB model weights, onnxruntime-node dependency, startup latency.
// See docs/ROADMAP.md for discussion.

const PRE_PROCESSORS = {
  trim:          trimPreProcessor,
  variance_scan: varianceScanPreProcessor,
};

// ── Dimension computation ─────────────────────────────────────────────────────

/**
 * Compute output dimensions given input size and orientation.
 *
 * Rules:
 *  - Identify which dimension is the "anchor" (won't be cropped) vs. "crop" dimension,
 *    based on whether the input is wider or narrower than the 16:9 (or 9:16) target.
 *  - If the anchor dimension exceeds the 4K target, scale down to fit.
 *  - Never upscale: if the anchor is smaller than 4K, keep the original size.
 *  - Crop the other dimension to achieve the target aspect ratio at the anchor size.
 *
 * Guarantee: finalW <= inputW and finalH <= inputH (safe to pass to any crop engine).
 */
function computeTargetDimensions(inputW, inputH, orientation) {
  const target = orientation === 'portrait' ? PORTRAIT_TARGET : LANDSCAPE_TARGET;
  const { w: tw, h: th } = target;

  const aspectInput  = inputW / inputH;
  const aspectTarget = tw / th;

  if (aspectInput >= aspectTarget) {
    // Image as wide or wider than target → height is anchor, width will be cropped
    if (inputH > th) {
      // Scale down so height = th; width guaranteed >= tw (proof: W/H >= tw/th → W*(th/H) >= tw)
      return { finalW: tw, finalH: th };
    } else {
      // Don't upscale; keep height, crop width to target ratio
      return { finalW: Math.round(inputH * tw / th), finalH: inputH };
    }
  } else {
    // Image taller than target → width is anchor, height will be cropped
    if (inputW > tw) {
      // Scale down so width = tw; height guaranteed >= th (proof: H/W > th/tw → H*(tw/W) > th)
      return { finalW: tw, finalH: th };
    } else {
      // Don't upscale; keep width, crop height to target ratio
      return { finalW: inputW, finalH: Math.round(inputW * th / tw) };
    }
  }
}

// ── Main pipeline ─────────────────────────────────────────────────────────────

/**
 * Process a web source image for display on the TV.
 *
 * Phase 1 (optional): pre-process (e.g., future frame/border detection).
 * Phase 2: fit to TV — scale down if needed, then crop to 16:9 or 9:16.
 *
 * @param {Buffer} buffer
 * @param {'landscape'|'portrait'} orientation
 * @param {object}  [options]
 * @param {string}  [options.preProcess]                       Pre-processor key ('trim'|'variance_scan'|null)
 * @param {object}  [options.preProcessOptions]                Passed through to the pre-processor
 * @param {string}  [options.cropEngine='sharp']               Crop engine key
 * @param {object}  [options.cropEngineOptions]                Passed through to the crop engine
 * @param {string}  [options.cropEngineOptions.strategy='attention']  Sharp strategy
 * @returns {Promise<Buffer>}
 */
async function processWebSourceImage(buffer, orientation = 'landscape', {
  preProcess = null,
  preProcessOptions = {},
  cropEngine = 'sharp',
  cropEngineOptions = {},
} = {}) {
  let processed = buffer;

  // Phase 1: pre-process (frame/border detection and removal)
  if (preProcess && PRE_PROCESSORS[preProcess]) {
    processed = await PRE_PROCESSORS[preProcess](processed, preProcessOptions);
  }

  // Phase 2: fit to TV
  const { width, height } = await sharp(processed).metadata();
  const { finalW, finalH } = computeTargetDimensions(width, height, orientation);

  const engine = CROP_ENGINES[cropEngine] || CROP_ENGINES.sharp;
  return engine(processed, width, height, finalW, finalH, cropEngineOptions);
}

// ── Schema (for UI) ───────────────────────────────────────────────────────────

const IMAGE_PROCESSING_SCHEMA = {
  preProcessors: [
    { value: 'none',          label: 'None — skip frame detection' },
    { value: 'variance_scan', label: 'Variance Scan — detect and remove frame/border regions (recommended)' },
    { value: 'trim',          label: 'Sharp Trim — remove solid uniform borders only' },
    // TODO (Option 3): ML Segmentation — handles irregular/ornate frames; see docs/ROADMAP.md
  ],
  cropEngines: [
    { value: 'sharp', label: 'Sharp (built-in)' },
  ],
  sharpStrategies: [
    { value: 'attention', label: 'Attention — focus on faces and salient regions (recommended for paintings)' },
    { value: 'entropy',   label: 'Entropy — focus on high-detail, textured regions' },
    { value: 'centre',    label: 'Center — crop from the geometric center' },
  ],
};

module.exports = {
  processWebSourceImage,
  computeTargetDimensions,
  CROP_ENGINES,
  PRE_PROCESSORS,
  IMAGE_PROCESSING_SCHEMA,
};