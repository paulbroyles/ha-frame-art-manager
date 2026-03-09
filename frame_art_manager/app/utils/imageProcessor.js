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

// ── Pre-processor registry ────────────────────────────────────────────────────

/**
 * Pre-processor interface:
 *   async (buffer) → Buffer
 *
 * Pre-processors run before the TV-fit step. Intended for future use cases such
 * as detecting and removing decorative frames or borders from artwork images
 * before cropping to the target aspect ratio.
 */
const PRE_PROCESSORS = {
  // Future: detect_frame: detectFramePreProcessor
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
 * @param {string}  [options.preProcess]           Pre-processor key (reserved for future use)
 * @param {string}  [options.cropEngine='sharp']   Crop engine key
 * @param {object}  [options.cropEngineOptions]    Passed through to the crop engine
 * @param {string}  [options.cropEngineOptions.strategy='attention']  Sharp strategy
 * @returns {Promise<Buffer>}
 */
async function processWebSourceImage(buffer, orientation = 'landscape', {
  preProcess = null,
  cropEngine = 'sharp',
  cropEngineOptions = {},
} = {}) {
  let processed = buffer;

  // Phase 1: pre-process
  if (preProcess && PRE_PROCESSORS[preProcess]) {
    processed = await PRE_PROCESSORS[preProcess](processed);
  }

  // Phase 2: fit to TV
  const { width, height } = await sharp(processed).metadata();
  const { finalW, finalH } = computeTargetDimensions(width, height, orientation);

  const engine = CROP_ENGINES[cropEngine] || CROP_ENGINES.sharp;
  return engine(processed, width, height, finalW, finalH, cropEngineOptions);
}

// ── Schema (for UI) ───────────────────────────────────────────────────────────

const IMAGE_PROCESSING_SCHEMA = {
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