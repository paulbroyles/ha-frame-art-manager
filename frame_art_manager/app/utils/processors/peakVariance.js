'use strict';

const sharp = require('sharp');

/**
 * Peak Variance window-setter processor.
 *
 * Finds the most densely complex (high local variance) compact region of the
 * image and writes context.focusWindow to it.
 *
 * Unlike coherence_crop's variance-weighted centroid — which gets pulled toward
 * large areas of moderate complexity (e.g. a detailed torso) — this processor
 * finds the region of a fixed size where variance density is highest. Painted
 * faces have tightly packed brushwork on features (eyes, lips, hair edges)
 * that concentrates variance in a small area; large clothing regions have
 * similar total variance spread over a much larger area and lose on density.
 *
 * Algorithm:
 *   1. Downsample to workSize for analysis.
 *   2. Build local variance proxy map: for each pixel, squared diffs to right
 *      and bottom neighbors (mean of 2). O(workW × workH).
 *   3. Build summed-area table (SAT) over the variance map. O(workW × workH).
 *   4. Search a stride grid of square windows of side (shortDim × windowFrac)
 *      for the one with the highest mean variance. O(1) per query via SAT.
 *   5. Project winner back to original coordinates + expand by padFraction.
 *   6. Write to context.focusWindow.
 *
 * options:
 *   windowFrac   0.25  Side of the search window as a fraction of the shorter
 *                      working-resolution dimension. ~0.25 works for head/face;
 *                      increase (0.35–0.50) for full-figure or wider subjects.
 *   padFraction  0.30  Expand the found window outward by this fraction of the
 *                      window side on each edge, to give context around the subject.
 *   workSize     600   Max dimension for detection downsampling.
 *   stride       4     Search grid stride in working-resolution pixels.
 */
async function peakVarianceProcessor(context, {
  windowFrac  = 0.25,
  padFraction = 0.30,
  workSize    = 600,
  stride      = 4,
} = {}) {
  const t0    = Date.now();
  const origW = context.width;
  const origH = context.height;

  // Step 1: downsample + RGB for analysis.
  const { data: workData, info: workInfo } = await sharp(context.buffer)
    .resize(workSize, workSize, { fit: 'inside', withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width: workW, height: workH, channels } = workInfo;
  const scaleX = origW / workW;
  const scaleY = origH / workH;
  const tDecode = Date.now();

  // BT.601 luminance of a pixel at byte offset `off`.
  function lum(off) {
    return 0.299 * workData[off] + 0.587 * workData[off + 1] + 0.114 * workData[off + 2];
  }

  // Step 2: local variance proxy — squared diffs to right + bottom neighbors.
  const localVar = new Float32Array(workW * workH);
  for (let y = 0; y < workH; y++) {
    for (let x = 0; x < workW; x++) {
      const l = lum((y * workW + x) * channels);
      let d1 = 0, d2 = 0, n = 0;
      if (x + 1 < workW) { d1 = l - lum((y * workW + x + 1) * channels); n++; }
      if (y + 1 < workH) { d2 = l - lum(((y + 1) * workW + x) * channels); n++; }
      localVar[y * workW + x] = n > 0 ? (d1 * d1 + d2 * d2) / n : 0;
    }
  }

  // Step 3: summed-area table (SAT).
  const ss = workW + 1;
  const sat = new Float64Array((workW + 1) * (workH + 1));
  for (let y = 0; y < workH; y++) {
    for (let x = 0; x < workW; x++) {
      sat[(y + 1) * ss + (x + 1)] =
        localVar[y * workW + x]
        + sat[y * ss + (x + 1)]
        + sat[(y + 1) * ss + x]
        - sat[y * ss + x];
    }
  }

  // O(1) mean variance query for any rectangle.
  function rectMean(x, y, w, h) {
    if (w <= 0 || h <= 0) return 0;
    const x0 = Math.max(0, x),       y0 = Math.max(0, y);
    const x1 = Math.min(workW, x+w), y1 = Math.min(workH, y+h);
    const area = (x1-x0) * (y1-y0);
    if (area === 0) return 0;
    return (sat[y1*ss+x1] - sat[y0*ss+x1] - sat[y1*ss+x0] + sat[y0*ss+x0]) / area;
  }

  const tSAT = Date.now();

  // Step 4: search for the peak-density window.
  // Window is square, sized to (shortDim × windowFrac) in working-res pixels.
  const winSide = Math.max(8, Math.round(Math.min(workW, workH) * windowFrac));

  // Compute global mean variance for confidence calibration.
  const globalMean = rectMean(0, 0, workW, workH);

  let bestScore = -Infinity;
  let bestLeft = 0, bestTop = 0;
  let candidateCount = 0;

  for (let top = 0; top + winSide <= workH; top += stride) {
    for (let left = 0; left + winSide <= workW; left += stride) {
      candidateCount++;
      const score = rectMean(left, top, winSide, winSide);
      if (score > bestScore) {
        bestScore = score;
        bestLeft = left;
        bestTop = top;
      }
    }
  }

  const tSearch = Date.now();

  // Confidence: how much better is the peak than the image average?
  // A peak 2× the global mean → full confidence. At or below average → 0.
  const confidence = globalMean > 0
    ? Math.min(1, Math.max(0, (bestScore / globalMean - 1)))
    : 0;

  // Step 5: project to original coordinates and expand by padFraction.
  const padPx = Math.round(winSide * padFraction);
  const wx = Math.max(0,    Math.round((bestLeft - padPx) * scaleX));
  const wy = Math.max(0,    Math.round((bestTop  - padPx) * scaleY));
  const wr = Math.min(origW, Math.round((bestLeft + winSide + padPx) * scaleX));
  const wb = Math.min(origH, Math.round((bestTop  + winSide + padPx) * scaleY));

  // Step 6: set focus window.
  context.focusWindow = {
    x: wx, y: wy, w: wr - wx, h: wb - wy,
    confidence: +confidence.toFixed(3),
    source: 'peak_variance',
  };

  console.log(
    `[peak_variance] candidates=${candidateCount} win=${winSide}px` +
    ` bestScore=${bestScore.toFixed(1)} globalMean=${globalMean.toFixed(1)}` +
    ` conf=${confidence.toFixed(3)}` +
    ` work(${bestLeft},${bestTop})` +
    ` → orig window(${wx},${wy} ${wr-wx}×${wb-wy})`
  );

  context.debug.peak_variance = {
    timing:      { total: tSearch - t0, decode: tDecode - t0, buildSAT: tSAT - tDecode, search: tSearch - tSAT },
    candidates:  candidateCount,
    winSide,
    bestScore,
    globalMean,
    confidence,
    workWin:     { left: bestLeft, top: bestTop, side: winSide },
    window:      { ...context.focusWindow },
  };

  return context;
}

module.exports = { peakVarianceProcessor };
