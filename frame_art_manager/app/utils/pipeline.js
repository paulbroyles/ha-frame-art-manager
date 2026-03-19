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
 *   debug:       {},                  // timing and diagnostic info per processor
 * }
 *
 * Processor interface:
 *   async (context, options) → context
 *
 * If a processor modifies the image it must update context.buffer,
 * context.width, context.height, and set context.raw = null.
 */

const sharp = require('sharp');
const { backgroundStripProcessor } = require('./processors/backgroundStrip');
const { sharpCropProcessor }       = require('./processors/sharpCrop');
const { PRE_PROCESSOR_WRAPPERS }   = require('./processors/preprocessorWrappers');

// ── Target dimensions ─────────────────────────────────────────────────────────

const LANDSCAPE_TARGET = { w: 3840, h: 2160 };
const PORTRAIT_TARGET  = { w: 2160, h: 3840 };

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
  const target = orientation === 'portrait' ? PORTRAIT_TARGET : LANDSCAPE_TARGET;
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

// ── Raw data helpers ───────────────────────────────────────────────────────────

/**
 * Ensure context.raw is populated with decoded pixel data.
 * If already decoded, reuses the cached data. Call this before any
 * processor that needs pixel-level access.
 */
async function ensureRaw(context) {
  if (!context.raw) {
    const { data, info } = await sharp(context.buffer).raw().toBuffer({ resolveWithObject: true });
    context.raw = { data, info };
    context.width = info.width;
    context.height = info.height;
    context.channels = info.channels;
  }
  return context;
}

/**
 * Invalidate cached raw pixel data after modifying context.buffer.
 * The next ensureRaw() call will re-decode the new buffer.
 */
function invalidateRaw(context) {
  context.raw = null;
}

// ── Processor registry ─────────────────────────────────────────────────────────

/**
 * PROCESSORS maps step keys to processor descriptors.
 *
 * Each descriptor has:
 *   fn:    async (context, options) → context
 *   type:  category string ('background_strip' | 'frame_detect' | 'aspect_crop' | 'unified_frame_crop')
 *   label: human-readable description
 *   auto:  true if this processor runs automatically (not user-selectable)
 */
const PROCESSORS = {
  background_strip: {
    fn: backgroundStripProcessor,
    type: 'background_strip',
    label: 'Background Strip — remove solid-color borders',
    auto: true,
  },
  sharp_crop: {
    fn: sharpCropProcessor,
    type: 'aspect_crop',
    label: 'Sharp Crop — scale and crop to TV aspect ratio',
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
