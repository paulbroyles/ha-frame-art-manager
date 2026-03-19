'use strict';

const sharp = require('sharp');
const { detectFrameBoundaries } = require('../processors/frameDetect');

/**
 * Mean Profile pre-processor.
 *
 * Detects and removes decorative frames/borders by scanning row and column
 * mean profiles. See utils/processors/frameDetect.js for the full algorithm.
 *
 * options.consistencyThreshold (default 35): max allowed deviation of any value from
 *   the reference mean (established from the first few edge values) to continue the scan.
 *   Solid borders: ≈ 5–10. Lightly-textured gold/gilded: ≈ 15–25. Wood grain: ≈ 25–40.
 *   The frame→painting boundary jump is typically 40–80, well above in-frame variation.
 * options.contrastThreshold (default 20): min luminance diff between detected band and interior.
 * options.refFraction (default 0.03): fallback corner-band fraction when no top/bottom frame found.
 * options.maxCropFraction (default 0.18): hard cap per edge (safety guard).
 * options.detectionMode (default 'combined'): 'luminance' | 'color' | 'combined'
 */
async function meanProfilePreProcessor(buffer, {
  consistencyThreshold = 35,
  contrastThreshold    = 20,
  refFraction          = 0.03,
  maxCropFraction      = 0.18,
  label                = '',
  detectionMode        = 'combined',
  _result              = null,
} = {}) {
  const _t0 = Date.now();
  const { data, info } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
  const _tDecode = Date.now();

  const { width, height, channels } = info;

  const { top, bottom, left, right } = detectFrameBoundaries(data, width, height, channels, {
    consistencyThreshold,
    contrastThreshold,
    refFraction,
    maxCropFraction,
    label,
    detectionMode,
    logPrefix: 'mean_profile',
  });

  if (top === 0 && bottom === 0 && left === 0 && right === 0) {
    console.log(`[mean_profile timing] decode=${_tDecode-_t0}ms detect=${Date.now()-_tDecode}ms total=${Date.now()-_t0}ms`);
    return buffer;
  }

  const extractWidth  = width  - left - right;
  const extractHeight = height - top  - bottom;
  if (extractWidth <= 0 || extractHeight <= 0) return buffer;

  const _tDetect = Date.now();
  console.log(`[imageProcessor] mean_profile: removing top=${top}px, bottom=${bottom}px, left=${left}px, right=${right}px`);
  const result = await sharp(buffer)
    .extract({ left, top, width: extractWidth, height: extractHeight })
    .toBuffer();
  console.log(`[mean_profile timing] decode=${_tDecode-_t0}ms detect=${_tDetect-_tDecode}ms encode=${Date.now()-_tDetect}ms total=${Date.now()-_t0}ms`);
  return result;
}

module.exports = { meanProfilePreProcessor };
