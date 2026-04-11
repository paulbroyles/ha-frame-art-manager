'use strict';

/**
 * Modular image processing pipeline.
 *
 * Processors are chained through a shared context object, eliminating
 * redundant encode/decode round-trips between steps. Each processor receives
 * the context, operates on context.buffer (and optionally context.raw), and
 * returns the updated context.
 *
 * Context shape:
 * {
 *   buffer:      Buffer,              // encoded image (JPEG/PNG/etc)
 *   raw:         { data, info }|null, // decoded raw pixels (lazy; null until ensureRaw() is called)
 *   width:       number,
 *   height:      number,
 *   channels:    number,
 *   orientation: 'landscape'|'portrait',
 *   targetW:     number,              // TV target width (computed from input dimensions)
 *   targetH:     number,              // TV target height
 *   focusWindow: { x, y, w, h, confidence, source }|null,  // set by window-setter processors
 *   debug:       {},                  // timing and diagnostic info per processor
 * }
 *
 * Focus window protocol:
 *   - Window-setter processors (type: 'window_set') write context.focusWindow
 *   - Window-consumer processors read context.focusWindow and use it if non-null,
 *     otherwise fall back to their default behaviour
 *   - window_clear explicitly sets context.focusWindow = null; it is the only
 *     way to cancel a previously set window mid-pipeline
 *   - Multiple setters: the last setter before a consumer wins (natural pipeline state)
 *
 * Processor interface:
 *   async (context, options) → context
 *
 * If a processor modifies the image it must update context.buffer,
 * context.width, context.height, and set context.raw = null.
 */

const sharp                         = require('sharp');
const { TV_TARGETS }                = require('./thumbSize');
const { backgroundStripProcessor }  = require('./processors/backgroundStrip');
const { sharpCropProcessor }        = require('./processors/sharpCrop');
const { frameAwareCropProcessor }   = require('./processors/frameAwareCrop');
const { scoredCropProcessor }       = require('./processors/scoredCrop');
const { coherenceCropProcessor }    = require('./processors/coherenceCrop');
const { peakVarianceProcessor }     = require('./processors/peakVariance');
const { mlSubjectProcessor }        = require('./processors/mlSubject');
const { windowClearProcessor }      = require('./processors/windowClear');
const { PRE_PROCESSOR_WRAPPERS }    = require('./processors/preprocessorWrappers');
const { ensureRaw, invalidateRaw }  = require('./processors/contextUtils');

// ── Target dimensions ─────────────────────────────────────────────────────────
// Imported from thumbSize.js — single source of truth for TV resolution targets.

/**
 * Compute output dimensions given input size and orientation.
 *
 * Rules:
 *  - Identify which dimension is the "anchor" (won't be cropped) vs. "crop"
 *    dimension, based on whether the input is wider or narrower than the 16:9
 *    (or 9:16) target.
 *  - If the anchor dimension exceeds the 4K target, scale down to fit.
 *  - Never upscale: if the anchor is smaller than 4K, keep the original size.
 *  - Crop the other dimension to achieve the target aspect ratio at the anchor size.
 *
 * Guarantee: finalW <= inputW and finalH <= inputH (safe to pass to any crop engine).
 */
function computeTargetDimensions(inputW, inputH, orientation) {
  const target = TV_TARGETS[orientation] || TV_TARGETS.landscape;
  const { w: tw, h: th } = target;

  const aspectInput  = inputW / inputH;
  const aspectTarget = tw / th;

  if (aspectInput >= aspectTarget) {
    // Image as wide or wider than target → height is anchor, width will be cropped
    if (inputH > th) {
      return { finalW: tw, finalH: th };
    } else {
      return { finalW: Math.round(inputH * tw / th), finalH: inputH };
    }
  } else {
    // Image taller than target → width is anchor, height will be cropped
    if (inputW > tw) {
      return { finalW: tw, finalH: th };
    } else {
      return { finalW: inputW, finalH: Math.round(inputW * th / tw) };
    }
  }
}


// ── Processor registry ─────────────────────────────────────────────────────────

/**
 * PROCESSORS maps step keys to processor descriptors.
 *
 * Each descriptor has:
 *   fn:              async (context, options) → context
 *   type:            category string:
 *                      'background_strip' | 'frame_detect' | 'aspect_crop' |
 *                      'unified_frame_crop' | 'window_set' | 'window_clear'
 *   label:           human-readable description
 *   auto:            true if this processor runs automatically (not user-selectable)
 *   consumesWindow:  true if this processor uses context.focusWindow when set
 */
const PROCESSORS = {
  background_strip: {
    fn: backgroundStripProcessor,
    type: 'background_strip',
    label: 'Background Strip — remove solid-color borders',
    auto: true,
  },
  peak_variance: {
    fn: peakVarianceProcessor,
    type: 'window_set',
    label: 'Peak Variance — find the most densely complex compact region and set focus window',
  },
  ml_subject: {
    fn: mlSubjectProcessor,
    type: 'window_set',
    label: 'ML Subject — detect foreground subject with RMBG-1.4 and set focus window (~11 s, model cached after first use)',
  },
  window_clear: {
    fn: windowClearProcessor,
    type: 'window_clear',
    label: 'Clear Focus Window — reset any focus window set by upstream processors',
  },
  sharp_crop: {
    fn: sharpCropProcessor,
    type: 'aspect_crop',
    label: 'Sharp Crop — scale and crop to TV aspect ratio',
  },
  frame_aware_crop: {
    fn: frameAwareCropProcessor,
    type: 'unified_frame_crop',
    label: 'Frame-Aware Crop — detect frame and fit to TV aspect ratio in one informed pass',
    replaces: ['frame_detect', 'aspect_crop'],
    consumesWindow: true,
  },
  scored_crop: {
    fn: scoredCropProcessor,
    type: 'unified_frame_crop',
    label: 'Scored Crop — score candidate crop rectangles for edge uniformity and interior complexity; finds painting without explicit frame detection',
    replaces: ['frame_detect', 'aspect_crop'],
    consumesWindow: true,
  },
  coherence_crop: {
    fn: coherenceCropProcessor,
    type: 'unified_frame_crop',
    label: 'Coherence Crop — variance-weighted centroid crop; centers on the most complex region; frame excluded naturally with no boundary detection',
    replaces: ['frame_detect', 'aspect_crop'],
    consumesWindow: true,
  },
  // Pre-processor wrappers (frame detection algorithms)
  ...Object.fromEntries(
    Object.entries(PRE_PROCESSOR_WRAPPERS).map(([key, fn]) => [key, {
      fn,
      type: 'frame_detect',
      label: key,
    }])
  ),
};

// ── Pipeline runner ────────────────────────────────────────────────────────────

/**
 * Run a list of pipeline steps against an input buffer.
 *
 * @param {Buffer} buffer - Input image buffer
 * @param {'landscape'|'portrait'} orientation - TV orientation
 * @param {Array<{ key: string, options?: object }>} steps - Ordered processor steps
 * @returns {Promise<{ buffer: Buffer, debug: object }>}
 */
async function runPipeline(buffer, orientation, steps) {
  // Normalise EXIF orientation before anything else. Sharp reads raw pixel rows in
  // storage order; if the EXIF tag says the image is rotated, every downstream step
  // (dimension checks, crop windows, aspect ratio logic) would operate on a rotated
  // image and produce a rotated result. .rotate() with no argument applies the EXIF
  // rotation and strips the tag so the rest of the pipeline sees upright pixels.
  buffer = await sharp(buffer).rotate().toBuffer();

  const meta = await sharp(buffer).metadata();
  const { finalW, finalH } = computeTargetDimensions(meta.width, meta.height, orientation);

  let context = {
    buffer,
    raw: null,
    width: meta.width,
    height: meta.height,
    channels: meta.channels || 3,
    orientation,
    targetW: finalW,
    targetH: finalH,
    focusWindow: null,
    debug: {},
  };

  for (const step of steps) {
    const entry = PROCESSORS[step.key];
    if (!entry) {
      console.warn(`[pipeline] Unknown processor key: '${step.key}', skipping`);
      continue;
    }
    context = await entry.fn(context, step.options || {});
  }

  return { buffer: context.buffer, debug: context.debug };
}

module.exports = {
  runPipeline,
  computeTargetDimensions,
  ensureRaw,
  invalidateRaw,
  PROCESSORS,
};
