'use strict';

const sharp = require('sharp');

/**
 * Region Compare pre-processor.
 *
 * Makes a "global" decision per edge by comparing the edge strip to the painting
 * interior before attempting to crop — avoiding the false-positive failure mode of
 * purely local variance checks (e.g. dark painting edges that look like frame rows).
 *
 * Algorithm per edge:
 *   1. Sample the outer edge strip (edgeFraction of that dimension).
 *   2. Sample the center interior block (interiorFraction × interiorFraction).
 *   3. Crop this edge only if BOTH conditions hold:
 *        a. Edge strip variance < uniformityThreshold  (the border is uniform)
 *        b. |edge mean luminance − interior mean luminance| > contrastThreshold
 *           (the border is visually distinct from the painting content)
 *   4. If conditions met, scan inward to find the precise frame boundary: extend
 *      the crop while row/col variance < max(uniformityThreshold, edgeVariance×3).
 *      The adaptive multiplier lets lightly-textured frames (gold/wood with variance
 *      ~50–200) be included in the crop while the painting content stops the scan.
 *
 * This correctly handles the common failure modes of the naive variance scan:
 *   - Dark painting edge + dark interior  → contrastThreshold not met → no crop
 *   - Black/gold frame + bright interior  → both conditions met → crop
 *   - Uniformly-textured painting edge    → uniformityThreshold not met → no crop
 *
 * options.edgeFraction (default 0.10): width of the sampled edge strip.
 * options.interiorFraction (default 0.50): size of the sampled center block.
 * options.uniformityThreshold (default 300): max edge variance to be "uniform".
 * options.contrastThreshold (default 15): min luminance difference edge vs. interior.
 * options.maxCropFraction (default 0.25): hard cap per edge (safety guard).
 */
async function regionComparePreProcessor(buffer, {
  edgeFraction        = 0.10,
  interiorFraction    = 0.50,
  uniformityThreshold = 300,
  contrastThreshold   = 15,
  maxCropFraction     = 0.25,
} = {}) {
  const { data, info } = await sharp(buffer)
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;

  function pixelLum(b) {
    return 0.299 * data[b] + 0.587 * data[b + 1] + 0.114 * data[b + 2];
  }

  // Mean and variance for a rectangular pixel region.
  function regionStats(x0, y0, x1, y1) {
    let sum = 0, sumSq = 0, n = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const v = pixelLum((y * width + x) * channels);
        sum += v; sumSq += v * v; n++;
      }
    }
    const mean = sum / n;
    return { mean, variance: sumSq / n - mean * mean };
  }

  // Per-row luminance variance.
  function rowVariance(y) {
    let sum = 0, sumSq = 0;
    for (let x = 0; x < width; x++) {
      const v = pixelLum((y * width + x) * channels);
      sum += v; sumSq += v * v;
    }
    const mean = sum / width;
    return sumSq / width - mean * mean;
  }

  // Per-column luminance variance.
  function colVariance(x) {
    let sum = 0, sumSq = 0;
    for (let y = 0; y < height; y++) {
      const v = pixelLum((y * width + x) * channels);
      sum += v; sumSq += v * v;
    }
    const mean = sum / height;
    return sumSq / height - mean * mean;
  }

  // Interior reference: center block, away from any frame.
  const iy0 = Math.round(height * (0.5 - interiorFraction / 2));
  const iy1 = Math.round(height * (0.5 + interiorFraction / 2));
  const ix0 = Math.round(width  * (0.5 - interiorFraction / 2));
  const ix1 = Math.round(width  * (0.5 + interiorFraction / 2));
  const interior = regionStats(ix0, iy0, ix1, iy1);

  const edgeH   = Math.round(height * edgeFraction);
  const edgeW   = Math.round(width  * edgeFraction);
  const maxRows = Math.floor(height * maxCropFraction);
  const maxCols = Math.floor(width  * maxCropFraction);

  // Returns true if an edge band looks like a frame (uniform AND different from interior).
  function isFrame(edgeStats) {
    return edgeStats.variance < uniformityThreshold &&
           Math.abs(edgeStats.mean - interior.mean) > contrastThreshold;
  }

  // Adaptive scan threshold: above the frame baseline but not so high we miss
  // lightly-textured frames (e.g. gold/wood) adjacent to a solid outer border.
  function scanThreshold(edgeVariance) {
    return Math.max(uniformityThreshold, edgeVariance * 3);
  }

  let cropTop = 0, cropBottom = 0, cropLeft = 0, cropRight = 0;

  const topEdge = regionStats(0, 0, width, edgeH);
  if (isFrame(topEdge)) {
    const thresh = scanThreshold(topEdge.variance);
    for (let y = 0; y < maxRows; y++) {
      if (rowVariance(y) < thresh) cropTop = y + 1; else break;
    }
  }

  const botEdge = regionStats(0, height - edgeH, width, height);
  if (isFrame(botEdge)) {
    const thresh = scanThreshold(botEdge.variance);
    for (let y = height - 1; y >= height - maxRows; y--) {
      if (rowVariance(y) < thresh) cropBottom = height - y; else break;
    }
  }

  const leftEdge = regionStats(0, 0, edgeW, height);
  if (isFrame(leftEdge)) {
    const thresh = scanThreshold(leftEdge.variance);
    for (let x = 0; x < maxCols; x++) {
      if (colVariance(x) < thresh) cropLeft = x + 1; else break;
    }
  }

  const rightEdge = regionStats(width - edgeW, 0, width, height);
  if (isFrame(rightEdge)) {
    const thresh = scanThreshold(rightEdge.variance);
    for (let x = width - 1; x >= width - maxCols; x--) {
      if (colVariance(x) < thresh) cropRight = width - x; else break;
    }
  }

  if (cropTop === 0 && cropBottom === 0 && cropLeft === 0 && cropRight === 0) {
    return buffer;
  }

  const extractLeft   = cropLeft;
  const extractTop    = cropTop;
  const extractWidth  = width  - cropLeft - cropRight;
  const extractHeight = height - cropTop  - cropBottom;

  console.log(`[imageProcessor] region_compare: removing top=${cropTop}px, bottom=${cropBottom}px, left=${cropLeft}px, right=${cropRight}px`);
  return sharp(buffer)
    .extract({ left: extractLeft, top: extractTop, width: extractWidth, height: extractHeight })
    .toBuffer();
}

module.exports = { regionComparePreProcessor };