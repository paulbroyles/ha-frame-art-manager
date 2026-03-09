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

/**
 * Mean Profile pre-processor.
 *
 * Extends the key insight (consistent row means = frame) into an incremental scan
 * that works for any border thickness. The previous version used a fixed edge
 * sampling window that failed when the border was thinner than the window.
 *
 * Key insight: Frames have consistent row/col means across their extent; painting
 * content does not. Scanning incrementally and tracking the running std dev of
 * means lets the algorithm self-terminate at the frame/painting boundary, without
 * needing to know the border width in advance.
 *
 * Algorithm:
 *   1. Compute full-width row means (rowMeans[y]).
 *   2. Top/bottom: scan from each edge inward. For each candidate row, compute the
 *      running std dev of all row means accumulated so far. Stop when including the
 *      next row would push the std dev above consistencyThreshold. Apply a post-scan
 *      contrast check (detected band mean vs. center interior).
 *   3. Left/right: compute col means using a thin strip of rows at the INNER EDGE of
 *      the detected top/bottom frame bands (not the frame rows themselves). Frame rows
 *      are uniform across all columns so they provide no left/right discrimination;
 *      interior-edge rows contain frame material at frame-column positions and painting
 *      content elsewhere. A range guard skips left/right if col means are still flat.
 *
 * Handles any border thickness (1px to wide ornate frames). Works for solid, lightly-
 * textured, and wood/gold-leaf frames. Per-edge independent detection.
 *
 * options.consistencyThreshold (default 20): max running std dev of means to continue scan.
 *   Solid borders: ≈ 1. Lightly-textured: ≈ 5–12. Moderate wood grain: ≈ 15–20.
 * options.contrastThreshold (default 20): min luminance diff between detected band and interior.
 * options.refFraction (default 0.03): fallback corner-band fraction when no top/bottom frame found.
 * options.maxCropFraction (default 0.25): hard cap per edge (safety guard).
 */
async function meanProfilePreProcessor(buffer, {
  consistencyThreshold = 20,
  contrastThreshold    = 20,
  refFraction          = 0.03,
  maxCropFraction      = 0.25,
} = {}) {
  const { data, info } = await sharp(buffer)
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;

  function pixelLum(b) {
    return 0.299 * data[b] + 0.587 * data[b + 1] + 0.114 * data[b + 2];
  }

  function rowMean(y) {
    let sum = 0;
    for (let x = 0; x < width; x++) sum += pixelLum((y * width + x) * channels);
    return sum / width;
  }

  function colMeanInBands(x, bands) {
    let sum = 0, n = 0;
    for (const [y0, y1] of bands) {
      for (let y = y0; y < y1; y++) { sum += pixelLum((y * width + x) * channels); n++; }
    }
    return n > 0 ? sum / n : 0;
  }

  const maxRows = Math.floor(height * maxCropFraction);
  const maxCols = Math.floor(width  * maxCropFraction);

  const rowMeans = Array.from({ length: height }, (_, y) => rowMean(y));

  // Interior reference: center 50% block.
  let iSum = 0, iN = 0;
  const iy0 = Math.round(height * 0.25), iy1 = Math.round(height * 0.75);
  const ix0 = Math.round(width  * 0.25), ix1 = Math.round(width  * 0.75);
  for (let y = iy0; y < iy1; y++) {
    for (let x = ix0; x < ix1; x++) { iSum += pixelLum((y * width + x) * channels); iN++; }
  }
  const interiorMean = iSum / iN;

  // Scan values[] from index 0 inward. Extend while including the next value keeps
  // the running std dev < consistencyThreshold. Require a minimum band size (5) and
  // a contrast check against interiorMean. Returns crop count (0 = no crop).
  function incrementalScan(values, maxN) {
    if (maxN < 5 || values.length < 5) return 0;
    let sum = values[0], sumSq = values[0] ** 2, n = 1, crop = 1;
    for (let i = 1; i < Math.min(maxN, values.length); i++) {
      const v = values[i];
      const newN = n + 1, newSum = sum + v, newSumSq = sumSq + v * v;
      const newMean = newSum / newN;
      const newStdDev = Math.sqrt(Math.max(0, newSumSq / newN - newMean ** 2));
      if (newStdDev < consistencyThreshold) {
        crop = i + 1;
        sum = newSum; sumSq = newSumSq; n = newN;
      } else {
        break;
      }
    }
    if (crop < 5) return 0;
    const bandMean = sum / n;
    return Math.abs(bandMean - interiorMean) > contrastThreshold ? crop : 0;
  }

  // Top and bottom: scan using full-width row means.
  const cropTop    = incrementalScan(rowMeans, maxRows);
  const cropBottom = incrementalScan([...rowMeans].reverse(), maxRows);

  // Left and right: col means restricted to rows at the INNER EDGE of the detected frame
  // bands, not the frame rows themselves. Frame rows are uniform across all columns (all
  // gold, or all black) so col means computed through them cannot distinguish frame columns
  // from painting columns. Interior-edge rows contain frame material at left/right column
  // positions and painting content at center positions — making col means discriminating.
  // Fall back to edge rows when no top/bottom frame was detected.
  const refRows = Math.max(3, Math.round(height * refFraction));
  const topInner = cropTop    > 0
    ? [cropTop,              Math.min(cropTop    + refRows, Math.floor(height / 2))]
    : [0,                    refRows];
  const botInner = cropBottom > 0
    ? [Math.max(height - cropBottom - refRows, Math.ceil(height / 2)), height - cropBottom]
    : [height - refRows,     height];
  const cornerBands    = [topInner, botInner];
  const cornerColMeans = Array.from({ length: width }, (_, x) => colMeanInBands(x, cornerBands));

  // Guard: if col means are nearly flat across all columns the bands are still
  // non-discriminating — skip left/right rather than produce false positives.
  const colMeansMin = cornerColMeans.reduce((a, v) => Math.min(a, v),  Infinity);
  const colMeansMax = cornerColMeans.reduce((a, v) => Math.max(a, v), -Infinity);
  const colMeansDiscriminating = (colMeansMax - colMeansMin) >= 5;

  const cropLeft  = colMeansDiscriminating ? incrementalScan(cornerColMeans, maxCols) : 0;
  const cropRight = colMeansDiscriminating ? incrementalScan([...cornerColMeans].reverse(), maxCols) : 0;

  if (cropTop === 0 && cropBottom === 0 && cropLeft === 0 && cropRight === 0) {
    return buffer;
  }

  const extractLeft   = cropLeft;
  const extractTop    = cropTop;
  const extractWidth  = width  - cropLeft - cropRight;
  const extractHeight = height - cropTop  - cropBottom;

  console.log(`[imageProcessor] mean_profile: removing top=${cropTop}px, bottom=${cropBottom}px, left=${cropLeft}px, right=${cropRight}px`);
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
  trim:              trimPreProcessor,
  variance_scan:     varianceScanPreProcessor,
  region_compare:    regionComparePreProcessor,
  corner_consensus:  cornerConsensusPreProcessor,
  mean_profile:      meanProfilePreProcessor,
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

// TODO (Option 1 — advanced mode): Allow preProcess to be an array of pre-processor keys
// applied in sequence, letting users build custom pipelines (e.g. ['trim', 'corner_consensus',
// 'mean_profile']). The current approach hard-codes trim as Stage 1 and a single user-selected
// algorithm as Stage 2. An array pipeline would make both stages fully configurable and support
// multi-matte scenarios (solid background → frame → inner matte).

/**
 * Process a web source image for display on the TV.
 *
 * Phase 1 (automatic): strip solid-color borders (Sharp Trim, threshold 10). This runs
 * whenever a pre-processor is configured, even 'none'. Removing the solid background first
 * lets Phase 2 algorithms see the actual frame in the corners rather than featureless
 * background pixels that confuse column-mean and corner-variance sampling.
 *
 * Phase 2 (user-selected): detect and remove decorative frames/borders.
 *
 * Phase 3: fit to TV — scale down if needed, then crop to 16:9 or 9:16.
 *
 * @param {Buffer} buffer
 * @param {'landscape'|'portrait'} orientation
 * @param {object}  [options]
 * @param {string}  [options.preProcess]                       Pre-processor key ('mean_profile'|'corner_consensus'|'region_compare'|'variance_scan'|'trim'|'none'|null)
 * @param {object}  [options.preProcessOptions]                Passed through to the Phase 2 pre-processor
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

  if (preProcess != null) {
    // Phase 1 (automatic): strip solid-color borders before frame detection.
    processed = await trimPreProcessor(processed);

    // Phase 2 (user-selected): detect and remove decorative frames/borders.
    if (PRE_PROCESSORS[preProcess]) {
      processed = await PRE_PROCESSORS[preProcess](processed, preProcessOptions);
    }
  }

  // Phase 3: fit to TV
  const { width, height } = await sharp(processed).metadata();
  const { finalW, finalH } = computeTargetDimensions(width, height, orientation);

  const engine = CROP_ENGINES[cropEngine] || CROP_ENGINES.sharp;
  return engine(processed, width, height, finalW, finalH, cropEngineOptions);
}

// ── Schema (for UI) ───────────────────────────────────────────────────────────

const IMAGE_PROCESSING_SCHEMA = {
  preProcessors: [
    { value: 'none',             label: 'None — background strip only; no frame detection' },
    { value: 'mean_profile',     label: 'Mean Profile — detect frames using row/column mean consistency; handles textured and wood frames' },
    { value: 'corner_consensus', label: 'Corner Consensus — detect frames using four-corner sampling; handles multi-layer frames' },
    { value: 'region_compare',   label: 'Region Compare — detect frames by comparing edge strip to painting interior' },
    { value: 'variance_scan',    label: 'Variance Scan — detect frames by local edge variance (legacy)' },
    { value: 'trim',             label: 'Sharp Trim — background strip only (same as None; redundant with automatic Stage 1)' },
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