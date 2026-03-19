'use strict';

const sharp = require('sharp');
const { detectFrameBoundaries } = require('./frameDetect');
const { ensureRaw }             = require('../pipeline');

/**
 * Frame-Aware Constrained Crop processor.
 *
 * Replaces separate frame detection (Phase 2) + aspect-ratio crop (Phase 3)
 * with a single informed pass that knows the target aspect ratio before it
 * makes any cropping decisions.
 *
 * Algorithm:
 *
 *   1. DECODE  — reuse raw pixel data from pipeline context if already present
 *      (avoids a redundant decode if backgroundStrip preceded this step).
 *
 *   2. DETECT FRAME BOUNDARIES  — calls detectFrameBoundaries() (same algorithm
 *      as mean_profile). Returns { top, bottom, left, right, confidence } where
 *      confidence per edge is 'direct' | 'inferred' | 'none'.
 *
 *   3. ASPECT-RATIO AWARENESS  — compare painting aspect ratio to target:
 *      - If painting is wider than target: L/R will be cropped by the resize;
 *        T/B detection is critical; L/R detection can be relaxed.
 *      - If painting is taller than target: T/B will be cropped by the resize;
 *        L/R detection is critical; T/B detection can be relaxed.
 *      For each "non-critical" edge: if it is fully covered by the AR crop
 *      (the resize would remove more than the detected frame depth anyway),
 *      the frame boundary on that edge is treated as confirmed regardless of
 *      confidence, because any error there has zero impact on the final output.
 *
 *   4. SAFETY MARGINS  — for edges that ARE critical (the AR crop will not
 *      remove them) AND have 'inferred' confidence: add a small inward safety
 *      margin (safetyMargin fraction of the relevant dimension) to guarantee
 *      no frame pixels survive even if the detection was imprecise.
 *
 *   5. EXTRACT + RESIZE  — single Sharp pipeline:
 *      sharp(buffer)
 *        .extract({ left, top, width: paintingW, height: paintingH })
 *        .resize(targetW, targetH, { fit: 'cover', position: strategy })
 *        .toBuffer()
 *      The extract removes the frame; the resize crops to the TV aspect ratio
 *      using saliency to position the crop within the available freedom.
 *
 * options:
 *   strategy         'attention'|'entropy'|'centre'  Crop position for the resize step.
 *   safetyMargin     0.01  Extra inward fraction for low-confidence critical edges.
 *   consistencyThreshold, contrastThreshold, refFraction, maxCropFraction, detectionMode
 *     — passed directly to detectFrameBoundaries (same defaults as mean_profile).
 */
async function frameAwareCropProcessor(context, {
  strategy             = 'attention',
  safetyMargin         = 0.01,
  consistencyThreshold = 35,
  contrastThreshold    = 20,
  refFraction          = 0.03,
  maxCropFraction      = 0.18,
  detectionMode        = 'combined',
} = {}) {
  const t0 = Date.now();

  // Step 1: ensure raw pixel data (reuse from context if available).
  await ensureRaw(context);
  const { data } = context.raw;
  const { width, height, channels, targetW, targetH } = context;
  const tDecode = Date.now();

  // Step 2: detect frame boundaries.
  const { top, bottom, left, right, confidence } = detectFrameBoundaries(
    data, width, height, channels, {
      consistencyThreshold,
      contrastThreshold,
      refFraction,
      maxCropFraction,
      detectionMode,
      logPrefix: 'frame_aware_crop',
    }
  );
  const tDetect = Date.now();

  // Step 3: aspect-ratio awareness.
  // Determine painting rectangle assuming detected boundaries.
  let cropTop    = top;
  let cropBottom = bottom;
  let cropLeft   = left;
  let cropRight  = right;

  const paintingW  = width  - cropLeft - cropRight;
  const paintingH  = height - cropTop  - cropBottom;
  const paintingAR = paintingW / paintingH;
  const targetAR   = targetW   / targetH;

  // How much excess does the painting have on the axis that will be cropped by the resize?
  // excessPx: the total pixels the resize will remove from this axis.
  // If an edge's frame depth <= half the excess, the resize covers it entirely → 'covered'.
  const excessW = paintingAR >= targetAR ? paintingW - paintingH * targetAR : 0;
  const excessH = paintingAR <  targetAR ? paintingH - paintingW / targetAR : 0;

  // For each covered edge, frame depth error has zero output impact.
  const topCovered    = excessH > 0 && cropTop    <= excessH / 2;
  const bottomCovered = excessH > 0 && cropBottom <= excessH / 2;
  const leftCovered   = excessW > 0 && cropLeft   <= excessW / 2;
  const rightCovered  = excessW > 0 && cropRight  <= excessW / 2;

  console.log(
    `[frame_aware_crop] painting=${paintingW}×${paintingH} AR=${paintingAR.toFixed(3)} target=${targetW}×${targetH} AR=${targetAR.toFixed(3)}` +
    ` excessW=${excessW.toFixed(0)}px excessH=${excessH.toFixed(0)}px` +
    ` covered=(top:${topCovered} bot:${bottomCovered} left:${leftCovered} right:${rightCovered})`
  );

  // Step 4: apply safety margins for non-covered, inferred-confidence edges.
  // Covered edges: the AR crop removes them regardless of detection accuracy → no margin needed.
  // Direct edges: confident detection → no margin.
  // Inferred + non-covered: uncertain detection on a critical edge → add safety inward.
  const safetyH = Math.round(height * safetyMargin);
  const safetyW = Math.round(width  * safetyMargin);

  function applyMargin(cropPx, covered, conf, dimSafety, edgeName) {
    if (covered) return cropPx;  // covered by AR crop → no effect either way
    if (conf === 'inferred' && cropPx > 0) {
      const withMargin = cropPx + dimSafety;
      console.log(`[frame_aware_crop] ${edgeName}: inferred + non-covered → +${dimSafety}px safety margin → ${withMargin}px`);
      return withMargin;
    }
    if (conf === 'none' && cropPx === 0) {
      // No frame detected on a critical edge. Add a tiny safety strip to guard
      // against undetected thin frames (1-2px sliver scenarios).
      const minSafety = Math.round(dimSafety * 0.5);
      if (minSafety > 0) {
        console.log(`[frame_aware_crop] ${edgeName}: no detection + non-covered → ${minSafety}px min safety strip`);
        return minSafety;
      }
    }
    return cropPx;
  }

  cropTop    = applyMargin(cropTop,    topCovered,    confidence.top,    safetyH, 'top');
  cropBottom = applyMargin(cropBottom, bottomCovered, confidence.bottom, safetyH, 'bottom');
  cropLeft   = applyMargin(cropLeft,   leftCovered,   confidence.left,   safetyW, 'left');
  cropRight  = applyMargin(cropRight,  rightCovered,  confidence.right,  safetyW, 'right');

  // Bounds check: ensure crop region is valid.
  const extractLeft   = Math.max(0, cropLeft);
  const extractTop    = Math.max(0, cropTop);
  const extractWidth  = Math.max(1, width  - cropLeft - cropRight);
  const extractHeight = Math.max(1, height - cropTop  - cropBottom);
  if (extractLeft + extractWidth  > width)  { /* clamp silently */ }
  if (extractTop  + extractHeight > height) { /* clamp silently */ }
  const safeExtW = Math.min(extractWidth,  width  - extractLeft);
  const safeExtH = Math.min(extractHeight, height - extractTop);

  console.log(
    `[frame_aware_crop] extract left=${extractLeft} top=${extractTop} ${safeExtW}×${safeExtH}` +
    ` → resize ${targetW}×${targetH} strategy=${strategy}`
  );

  // Step 5: single extract + resize.
  // If the painting area already matches target dimensions exactly, skip resize.
  let result;
  if (safeExtW === targetW && safeExtH === targetH && extractLeft === 0 && extractTop === 0) {
    result = context.buffer;
  } else if (extractLeft === 0 && extractTop === 0 && safeExtW === width && safeExtH === height) {
    // No frame found — just resize to target.
    result = await sharp(context.buffer)
      .resize(targetW, targetH, { fit: 'cover', position: strategy })
      .toBuffer();
  } else {
    result = await sharp(context.buffer)
      .extract({ left: extractLeft, top: extractTop, width: safeExtW, height: safeExtH })
      .resize(targetW, targetH, { fit: 'cover', position: strategy })
      .toBuffer();
  }
  const tEnd = Date.now();

  context.buffer = result;
  context.raw    = null;
  context.width  = targetW;
  context.height = targetH;

  context.debug.frame_aware_crop = {
    timing:     { total: tEnd - t0, decode: tDecode - t0, detect: tDetect - tDecode, encode: tEnd - tDetect },
    detected:   { top, bottom, left, right },
    confidence: { ...confidence },
    applied:    { top: cropTop, bottom: cropBottom, left: cropLeft, right: cropRight },
    covered:    { top: topCovered, bottom: bottomCovered, left: leftCovered, right: rightCovered },
    extract:    { left: extractLeft, top: extractTop, width: safeExtW, height: safeExtH },
    strategy,
  };

  console.log(`[frame_aware_crop timing] decode=${tDecode-t0}ms detect=${tDetect-tDecode}ms encode=${tEnd-tDetect}ms total=${tEnd-t0}ms`);
  return context;
}

module.exports = { frameAwareCropProcessor };
