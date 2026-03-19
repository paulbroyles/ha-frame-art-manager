'use strict';

const sharp = require('sharp');

/**
 * Shared pipeline context helpers.
 *
 * Extracted here to avoid a circular dependency between pipeline.js
 * (which imports processor modules) and processor modules that need
 * these helpers (e.g. frameAwareCrop.js).
 *
 * pipeline.js re-exports these for callers that import from there.
 */

/**
 * Ensure context.raw is populated with decoded pixel data.
 * If already decoded, reuses the cached data. Call this before any
 * processor that needs pixel-level access.
 */
async function ensureRaw(context) {
  if (!context.raw) {
    const { data, info } = await sharp(context.buffer).raw().toBuffer({ resolveWithObject: true });
    context.raw = { data, info };
    context.width    = info.width;
    context.height   = info.height;
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

module.exports = { ensureRaw, invalidateRaw };
