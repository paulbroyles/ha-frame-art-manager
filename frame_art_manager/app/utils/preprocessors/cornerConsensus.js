'use strict';

const sharp = require('sharp');

/**
 * Corner Consensus pre-processor.
 *
 * Addresses the main failure mode of Region Compare: edge strips that span the
 * full image height/width can mix frame and painting pixels, diluting the frame
 * signal and causing asymmetric detection. Corner samples contain only frame
 * pixels, making the gate more reliable.
 *
 * Algorithm:
 *   1. Sample four corners (cornerFraction × cornerFraction each).
 *   2. Require ALL of:
 *        a. All four corners are uniform (variance < uniformityThreshold)
 *        b. Corner means are consistent with each other (std dev < consistencyThreshold)
 *        c. Corner cluster mean is visually distinct from center interior (> contrastThreshold)
 *   3. If frame is confirmed, set adaptive scan threshold:
 *        max(uniformityThreshold, avgCornerVariance × 4)
 *      The 4× multiplier lets multi-layer frames (solid border + textured gold/wood
 *      inner frame) both be included, while complex painting content stops the scan.
 *   4. Scan all four edges inward using per-row/col variance vs. that threshold.
 *
 * options.cornerFraction (default 0.10): size of each corner sample (each dimension).
 * options.uniformityThreshold (default 400): max corner variance to be "uniform".
 * options.consistencyThreshold (default 30): max std dev of the 4 corner means.
 * options.contrastThreshold (default 15): min luminance difference corners vs. interior.
 * options.maxCropFraction (default 0.25): hard cap per edge (safety guard).
 */
async function cornerConsensusPreProcessor(buffer, {
  cornerFraction       = 0.10,
  uniformityThreshold  = 400,
  consistencyThreshold = 30,
  contrastThreshold    = 15,
  maxCropFraction      = 0.25,
} = {}) {
  const { data, info } = await sharp(buffer)
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;

  function pixelLum(b) {
    return 0.299 * data[b] + 0.587 * data[b + 1] + 0.114 * data[b + 2];
  }

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

  function rowVariance(y) {
    let sum = 0, sumSq = 0;
    for (let x = 0; x < width; x++) {
      const v = pixelLum((y * width + x) * channels);
      sum += v; sumSq += v * v;
    }
    const mean = sum / width;
    return sumSq / width - mean * mean;
  }

  function colVariance(x) {
    let sum = 0, sumSq = 0;
    for (let y = 0; y < height; y++) {
      const v = pixelLum((y * width + x) * channels);
      sum += v; sumSq += v * v;
    }
    const mean = sum / height;
    return sumSq / height - mean * mean;
  }

  const cH = Math.round(height * cornerFraction);
  const cW = Math.round(width  * cornerFraction);

  // Four corner regions: top-left, top-right, bottom-left, bottom-right.
  const corners = [
    regionStats(0,         0,          cW,    cH),
    regionStats(width - cW, 0,         width, cH),
    regionStats(0,         height - cH, cW,   height),
    regionStats(width - cW, height - cH, width, height),
  ];

  // a. All corners must be uniform.
  if (corners.some(c => c.variance >= uniformityThreshold)) return buffer;

  // b. Corner means must be consistent with each other.
  const cornerMeans = corners.map(c => c.mean);
  const avgMean = cornerMeans.reduce((a, b) => a + b, 0) / 4;
  const meanStdDev = Math.sqrt(
    cornerMeans.reduce((sum, m) => sum + (m - avgMean) ** 2, 0) / 4
  );
  if (meanStdDev >= consistencyThreshold) return buffer;

  // c. Corner cluster must be visually distinct from the center interior.
  const iy0 = Math.round(height * 0.25);
  const iy1 = Math.round(height * 0.75);
  const ix0 = Math.round(width  * 0.25);
  const ix1 = Math.round(width  * 0.75);
  const interior = regionStats(ix0, iy0, ix1, iy1);
  if (Math.abs(avgMean - interior.mean) <= contrastThreshold) return buffer;

  // Frame confirmed. Adaptive threshold allows multi-layer frames.
  const avgCornerVariance = corners.reduce((sum, c) => sum + c.variance, 0) / 4;
  const scanThreshold = Math.max(uniformityThreshold, avgCornerVariance * 4);

  const maxRows = Math.floor(height * maxCropFraction);
  const maxCols = Math.floor(width  * maxCropFraction);

  let cropTop = 0;
  for (let y = 0; y < maxRows; y++) {
    if (rowVariance(y) < scanThreshold) cropTop = y + 1; else break;
  }
  let cropBottom = 0;
  for (let y = height - 1; y >= height - maxRows; y--) {
    if (rowVariance(y) < scanThreshold) cropBottom = height - y; else break;
  }
  let cropLeft = 0;
  for (let x = 0; x < maxCols; x++) {
    if (colVariance(x) < scanThreshold) cropLeft = x + 1; else break;
  }
  let cropRight = 0;
  for (let x = width - 1; x >= width - maxCols; x--) {
    if (colVariance(x) < scanThreshold) cropRight = width - x; else break;
  }

  if (cropTop === 0 && cropBottom === 0 && cropLeft === 0 && cropRight === 0) {
    return buffer;
  }

  const extractLeft   = cropLeft;
  const extractTop    = cropTop;
  const extractWidth  = width  - cropLeft - cropRight;
  const extractHeight = height - cropTop  - cropBottom;

  console.log(`[imageProcessor] corner_consensus: removing top=${cropTop}px, bottom=${cropBottom}px, left=${cropLeft}px, right=${cropRight}px`);
  return sharp(buffer)
    .extract({ left: extractLeft, top: extractTop, width: extractWidth, height: extractHeight })
    .toBuffer();
}

module.exports = { cornerConsensusPreProcessor };