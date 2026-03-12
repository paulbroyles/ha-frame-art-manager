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
 * Solid-border strip — Phase 1 of the image processing pipeline.
 *
 * Strips solid or near-solid border rows/columns from each edge using a
 * per-row/column luminance variance scan with a contrast check. Designed to
 * clear flat backgrounds (black, white, gray) and JPEG-artifact-noisy dark
 * borders before Phase 2 frame detection runs.
 *
 * Unlike Sharp Trim, this does not depend on the corner pixel color, so it
 * handles JPEG noise in what visually looks like a solid black border.
 *
 * Algorithm per edge:
 *   1. Scan inward: extend the crop while per-row (or per-col) luminance
 *      variance is below solidThreshold. Stop at the first high-variance
 *      row/col (frame or painting content).
 *   2. Contrast check: the scanned band's mean luminance must differ from
 *      the center interior by more than contrastThreshold. Guards against
 *      falsely stripping dark or light painting edges.
 */
async function solidBorderStrip(buffer) {
  const _t0 = Date.now();
  const { data, info } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
  const _tDecode = Date.now();
  const { width, height, channels } = info;

  function pixelLum(b) {
    return 0.299 * data[b] + 0.587 * data[b + 1] + 0.114 * data[b + 2];
  }

  function rowStats(y) {
    let sum = 0, sumSq = 0;
    for (let x = 0; x < width; x++) {
      const v = pixelLum((y * width + x) * channels);
      sum += v; sumSq += v * v;
    }
    const mean = sum / width;
    return { mean, variance: sumSq / width - mean * mean };
  }

  function colStats(x) {
    let sum = 0, sumSq = 0;
    for (let y = 0; y < height; y++) {
      const v = pixelLum((y * width + x) * channels);
      sum += v; sumSq += v * v;
    }
    const mean = sum / height;
    return { mean, variance: sumSq / height - mean * mean };
  }

  // Interior reference: center 50% block.
  let iSum = 0, iN = 0;
  const iy0 = Math.round(height * 0.25), iy1 = Math.round(height * 0.75);
  const ix0 = Math.round(width  * 0.25), ix1 = Math.round(width  * 0.75);
  for (let y = iy0; y < iy1; y++) {
    for (let x = ix0; x < ix1; x++) { iSum += pixelLum((y * width + x) * channels); iN++; }
  }
  const interiorMean = iSum / iN;

  // Max per-row/col variance to qualify as "solid". Solid black ≈ 0–20;
  // JPEG-noisy near-black ≈ 20–150; lightly textured frames ≈ 500+.
  const solidThreshold    = 150;
  // Min luminance diff between detected band and interior to apply the crop.
  const contrastThreshold = 20;
  const maxCropFraction   = 0.25;
  const maxRows = Math.floor(height * maxCropFraction);
  const maxCols = Math.floor(width  * maxCropFraction);

  // Scan from one edge inward using a stats function indexed 0 = outermost.
  function scanEdge(statsFn, maxN) {
    let crop = 0, bandSum = 0;
    for (let i = 0; i < maxN; i++) {
      const { mean, variance } = statsFn(i);
      if (variance < solidThreshold) { crop = i + 1; bandSum += mean; }
      else break;
    }
    if (crop === 0) return 0;
    return Math.abs(bandSum / crop - interiorMean) > contrastThreshold ? crop : 0;
  }

  // Diagnostic: log variance of first 3 rows and first 3 cols to help tune solidThreshold.
  {
    const r0 = rowStats(0), r1 = rowStats(1), r2 = rowStats(2);
    const c0 = colStats(0), c1 = colStats(1), c2 = colStats(2);
    console.log(`[solidBorderStrip] interiorMean=${interiorMean.toFixed(1)}, solidThreshold=${solidThreshold}`);
    console.log(`[solidBorderStrip] row[0] mean=${r0.mean.toFixed(1)} var=${r0.variance.toFixed(0)}, row[1] mean=${r1.mean.toFixed(1)} var=${r1.variance.toFixed(0)}, row[2] mean=${r2.mean.toFixed(1)} var=${r2.variance.toFixed(0)}`);
    console.log(`[solidBorderStrip] col[0] mean=${c0.mean.toFixed(1)} var=${c0.variance.toFixed(0)}, col[1] mean=${c1.mean.toFixed(1)} var=${c1.variance.toFixed(0)}, col[2] mean=${c2.mean.toFixed(1)} var=${c2.variance.toFixed(0)}`);
  }

  const cropTop    = scanEdge(y => rowStats(y),                maxRows);
  const cropBottom = scanEdge(y => rowStats(height - 1 - y),   maxRows);
  const cropLeft   = scanEdge(x => colStats(x),                maxCols);
  const cropRight  = scanEdge(x => colStats(width  - 1 - x),   maxCols);
  const _tScan = Date.now();

  if (cropTop === 0 && cropBottom === 0 && cropLeft === 0 && cropRight === 0) {
    console.log(`[solidBorderStrip] no border found — decode=${_tDecode - _t0}ms scan=${_tScan - _tDecode}ms total=${_tScan - _t0}ms`);
    return buffer;
  }

  const extractLeft   = cropLeft;
  const extractTop    = cropTop;
  const extractWidth  = width  - cropLeft - cropRight;
  const extractHeight = height - cropTop  - cropBottom;

  if (extractWidth <= 0 || extractHeight <= 0) return buffer;

  console.log(`[solidBorderStrip] removing top=${cropTop}px, bottom=${cropBottom}px, left=${cropLeft}px, right=${cropRight}px (interiorMean=${interiorMean.toFixed(1)})`);
  const result = await sharp(buffer)
    .extract({ left: extractLeft, top: extractTop, width: extractWidth, height: extractHeight })
    .toBuffer();
  console.log(`[solidBorderStrip timing] decode=${_tDecode - _t0}ms scan=${_tScan - _tDecode}ms encode=${Date.now() - _tScan}ms total=${Date.now() - _t0}ms`);
  return result;
}

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
 * options.consistencyThreshold (default 35): max allowed deviation of any value from
 *   the reference mean (established from the first few edge values) to continue the scan.
 *   Solid borders: ≈ 5–10. Lightly-textured gold/gilded: ≈ 15–25. Wood grain: ≈ 25–40.
 *   The frame→painting boundary jump is typically 40–80, well above in-frame variation.
 * options.contrastThreshold (default 20): min luminance diff between detected band and interior.
 * options.refFraction (default 0.03): fallback corner-band fraction when no top/bottom frame found.
 * options.maxCropFraction (default 0.18): hard cap per edge (safety guard). Kept at 18%
 *   so that real frames (typically 2–12% of image dimension) are well within the cap, while
 *   scans that reach the cap without a natural stopping point are rejected as runaway false
 *   positives (painting-background regions that look frame-like by row mean alone).
 */
async function meanProfilePreProcessor(buffer, {
  consistencyThreshold = 35,
  contrastThreshold    = 20,
  refFraction          = 0.03,
  maxCropFraction      = 0.18,
  label                = '',
  detectionMode        = 'combined', // 'luminance' | 'color' | 'combined'
} = {}) {
  const _t0 = Date.now();
  const { data, info } = await sharp(buffer)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const _tDecode = Date.now();

  const { width, height, channels } = info;

  function pixelLum(b) {
    return 0.299 * data[b] + 0.587 * data[b + 1] + 0.114 * data[b + 2];
  }

  // Chromaticity distance: how different is this pixel's color (hue) from the interior?
  // Uses normalized RGB so brightness differences don't inflate the score — a dark corner
  // of the same hue as the interior scores near 0, while a gold frame scores 30–60.
  // Scaled by 255 to match the luminance-distance range; contrastThreshold (20) applies.
  // Defined after interiorChR/G/B below; hoisted via function-scoped closure.
  function pixelChromaDist(offset) {
    if (channels < 3) return 0;
    const r = data[offset], g = data[offset + 1], b = data[offset + 2];
    const tot = r + g + b + 0.001;
    const dr = r / tot - interiorChR;
    const dg = g / tot - interiorChG;
    const db = b / tot - interiorChB;
    return Math.sqrt(dr * dr + dg * dg + db * db) * 255;
  }

  function rowMean(y) {
    let sum = 0;
    for (let x = 0; x < width; x++) sum += pixelLum((y * width + x) * channels);
    return sum / width;
  }

  // Within-row luminance variance: mean squared deviation from the row mean.
  function rowVariance(y, mean) {
    let sumSq = 0;
    for (let x = 0; x < width; x++) {
      const d = pixelLum((y * width + x) * channels) - mean;
      sumSq += d * d;
    }
    return sumSq / width;
  }

  // Mean absolute difference between horizontally adjacent pixels (horizontal gradient mean).
  // Captures spatial sharpness: smooth cloudy gradients (frame material) have small
  // pixel-to-pixel differences even when overall variance is high, while structured
  // geometric patterns (rugs, carpets) have large pixel-to-pixel jumps at design boundaries.
  function rowMAD(y) {
    let sum = 0;
    for (let x = 1; x < width; x++) {
      sum += Math.abs(pixelLum((y * width + x) * channels) - pixelLum((y * width + x - 1) * channels));
    }
    return sum / (width - 1);
  }

  // Mean absolute difference between vertically adjacent pixels within the corner bands,
  // for a given column. Measures vertical sharpness/texture within the band.
  function colBandMAD(x, bands) {
    let sum = 0, count = 0;
    for (const [y0, y1] of bands) {
      for (let y = y0 + 1; y < y1; y++) {
        sum += Math.abs(pixelLum((y * width + x) * channels) - pixelLum(((y - 1) * width + x) * channels));
        count++;
      }
    }
    return count > 0 ? sum / count : 0;
  }

  function colMeanInBands(x, bands) {
    let sum = 0, n = 0;
    for (const [y0, y1] of bands) {
      for (let y = y0; y < y1; y++) { sum += pixelLum((y * width + x) * channels); n++; }
    }
    return n > 0 ? sum / n : 0;
  }

  // Median luminance for a column within specified row bands.
  // More robust than mean for wood grain frames: a few bright grain rows within a
  // dark frame column inflate the mean (causing early scan termination) but not the median.
  function colMedianInBands(x, bands) {
    const vals = [];
    for (const [y0, y1] of bands) {
      for (let y = y0; y < y1; y++) { vals.push(pixelLum((y * width + x) * channels)); }
    }
    if (vals.length === 0) return 0;
    vals.sort((a, b) => a - b);
    const mid = Math.floor(vals.length / 2);
    return vals.length % 2 === 0 ? (vals[mid - 1] + vals[mid]) / 2 : vals[mid];
  }

  // Median chromaticity distance (from interior) for a column within specified row bands.
  // Used for color-based L/R detection: detects gold/colored frames with low lum contrast.
  function colChromaMedianInBands(x, bands) {
    const vals = [];
    for (const [y0, y1] of bands) {
      for (let y = y0; y < y1; y++) { vals.push(pixelChromaDist((y * width + x) * channels)); }
    }
    if (vals.length === 0) return 0;
    vals.sort((a, b) => a - b);
    return vals[Math.floor(vals.length / 2)];
  }

  const maxRows = Math.floor(height * maxCropFraction);
  const maxCols = Math.floor(width  * maxCropFraction);

  const rowMeans = Array.from({ length: height }, (_, y) => rowMean(y));
  const rowVariances = rowMeans.map((m, y) => rowVariance(y, m));
  const rowMADs = Array.from({ length: height }, (_, y) => rowMAD(y));

  // Edge column sets for spatial coherence contamination check (T/B scan).
  // For each scanned row, records sorted column positions where the horizontal gradient
  // (|lum(y, x+1) - lum(y, x-1)|) exceeds edgeGradThreshold. Only computed for the
  // scan range (maxRows rows from each edge) to avoid full-image processing.
  //
  // Used in incrementalScan to detect painting content inside frame-apparent rows:
  // a painting subject's vertical boundary (e.g. the edge of a face) creates a consistent
  // horizontal gradient at the same column positions across many consecutive rows.
  // Frame material (uniform colour, random wood grain) produces sparse or inconsistent
  // edge column positions that do not repeat across rows. Three consecutive frame-apparent
  // rows whose edge columns overlap (within ±edgeTolerance px) signal painting content.
  //
  // The same horizontal-gradient formula is reused for L/R coherence (per-column edge
  // row sets), computed after cornerBands is established below.
  // Gradient threshold: only count as an edge if the horizontal luminance change
  // exceeds this value. Grain boundaries in wood frames are subtle (30–60 lum units);
  // painting subject edges against a contrasting background are bold (80–150+ lum units).
  // A higher threshold filters grain while keeping painting content detectable.
  const edgeGradThreshold = 60;
  function rowEdgeCols(y) {
    const cols = [];
    for (let x = 1; x < width - 1; x++) {
      const grad = Math.abs(
        pixelLum((y * width + x + 1) * channels) -
        pixelLum((y * width + x - 1) * channels)
      );
      if (grad > edgeGradThreshold) cols.push(x);
    }
    return cols;
  }
  const topEdgeSets = Array.from({ length: maxRows }, (_, i) => rowEdgeCols(i));
  const botEdgeSets = Array.from({ length: maxRows }, (_, i) => rowEdgeCols(height - 1 - i));

  // Interior reference: center 50% block.
  // Also accumulates R/G/B for a chromaticity color reference used to detect
  // color-distinct frames (e.g. gold) that have low luminance contrast.
  let iSum = 0, iSumR = 0, iSumG = 0, iSumB = 0, iN = 0;
  const iy0 = Math.round(height * 0.25), iy1 = Math.round(height * 0.75);
  const ix0 = Math.round(width  * 0.25), ix1 = Math.round(width  * 0.75);
  for (let y = iy0; y < iy1; y++) {
    for (let x = ix0; x < ix1; x++) {
      const off = (y * width + x) * channels;
      iSum += pixelLum(off);
      if (channels >= 3) { iSumR += data[off]; iSumG += data[off + 1]; iSumB += data[off + 2]; }
      iN++;
    }
  }
  const interiorMean = iSum / iN;
  // Interior chromaticity: normalized RGB removes brightness, leaving hue/color signal.
  // Scaling by 255 puts chromaDist values in the same range as luminance distances so
  // contrastThreshold (20) applies directly to both.
  const iColorR = channels >= 3 ? iSumR / iN : 128;
  const iColorG = channels >= 3 ? iSumG / iN : 128;
  const iColorB = channels >= 3 ? iSumB / iN : 128;
  const iColorTot = iColorR + iColorG + iColorB + 0.001;
  const interiorChR = iColorR / iColorTot;
  const interiorChG = iColorG / iColorTot;
  const interiorChB = iColorB / iColorTot;
  // Color row profile: mean chromaticity distance per row, sampled every 4 columns for speed.
  // Computed after interiorChR/G/B since pixelChromaDist reads those values.
  const rowChromaScores = channels >= 3
    ? Array.from({ length: height }, (_, y) => {
        let sum = 0, n = 0;
        for (let x = 0; x < width; x += 4) { sum += pixelChromaDist((y * width + x) * channels); n++; }
        return n > 0 ? sum / n : 0;
      })
    : null;
  const _tRowMeans = Date.now();

  if (label) console.log(`[mean_profile] source: ${label}`);
  console.log(`[mean_profile] image ${width}×${height}, interiorMean=${interiorMean.toFixed(1)}, consistencyThreshold=${consistencyThreshold}, contrastThreshold=${contrastThreshold}`);

  // Returns true if sorted arrays a and b share at least one value within ±tol.
  // Two-pointer O(m+n) — avoids O(m×n) naive comparison.
  function edgesOverlap(a, b, tol) {
    let j = 0;
    for (let i = 0; i < a.length; i++) {
      while (j < b.length && b[j] < a[i] - tol) j++;
      if (j < b.length && b[j] <= a[i] + tol) return true;
    }
    return false;
  }

  // Scan values[] from index 0 inward. Extends while each new value is within
  // consistencyThreshold of a reference mean established from the first few edge values.
  // This handles frames with internal texture (wood grain ≈ ±20 variation) while
  // stopping at the sharper frame/painting boundary (typically ±40–80 jump).
  // Requires a minimum band size (5), a natural stopping point (runaway guard),
  // and a contrast check against interiorMean.
  function incrementalScan(values, maxN, label, thresholdOverride = null, contrastOverride = null, varValues = null, madValues = null, edgeSets = null) {
    if (maxN < 5 || values.length < 5) return 0;
    // Reference mean from the first few values (outermost edge — always frame material
    // after solidBorderStrip). More robust than running stdDev for wood grain frames.
    const initN = Math.min(5, Math.floor(maxN / 2));
    const refMean = values.slice(0, initN).reduce((s, v) => s + v, 0) / initN;
    // Hysteresis: require 3 consecutive outliers before stopping, so that isolated
    // bright grain columns within a textured frame don't prematurely end the scan.
    // Only a sustained run of high-deviation values (as seen at the frame/painting
    // boundary) triggers a stop.
    const hysteresisN = 3;
    // thresholdOverride allows callers to demand a higher stopping threshold for
    // L/R scans when both T/B bands fell back to edge rows (unreliable band placement).
    // In that situation a stricter threshold reduces false positives from borderline
    // column means whose stopping deviation is just barely above consistencyThreshold.
    const threshold = thresholdOverride ?? consistencyThreshold;
    // Variance-based supplementary stopping condition (relative check).
    // Fires when a row's variance is much higher than the edge reference — catches cases
    // where edge is uniform and painting content is much more varied.
    const varMultiplier = 8;
    const refVar = varValues ? varValues.slice(0, initN).reduce((s, v) => s + v, 0) / initN : 0;
    const varCheckActive = varValues !== null && refVar >= 5;
    // MAD-based supplementary stopping condition.
    // Mean Absolute Difference between adjacent pixels captures spatial sharpness:
    // smooth cloudy gradients (frame material) have low MAD even with high overall variance,
    // while structured geometric patterns (rugs, carpets) have high MAD at design boundaries.
    // This distinguishes "high variance from smooth gradients" (frame) from
    // "high variance from sharp geometric transitions" (painting pattern content).
    const refMAD = madValues ? madValues.slice(0, initN).reduce((s, v) => s + v, 0) / initN : 0;
    const madCheckActive = madValues !== null;
    // Spatial coherence contamination check: detects painting content hiding in
    // frame-apparent rows/columns by checking whether consecutive frame-apparent
    // positions share consistent horizontal-gradient edge positions (within ±edgeTolerance).
    //
    // Frame material (uniform colour, wood grain) produces sparse or randomly varying
    // edge positions — grain boundaries shift row-to-row so overlap across three
    // consecutive rows is extremely rare.
    //
    // Painting subjects create a persistent vertical or horizontal boundary: e.g. the
    // edge of a face appears at the same column positions across many consecutive rows
    // (T/B scan), or at the same row positions across many consecutive columns (L/R scan).
    // Three consecutive frame-apparent positions whose edge sets overlap within ±tolerance
    // signal painting content → reject the crop band.
    //
    // Fires only on positions that pass the main dev/var/mad checks (appear frame-like),
    // so it does NOT interfere with the normal frame/painting boundary stop.
    // Suppress coherence check if any reference position already contains bold edges.
    // Reference-row edges mean the frame material itself is textured (e.g. wood grain,
    // ornate structure). In that case the main mean/MAD/variance checks are sufficient
    // to find the frame/painting boundary, and coherence would fire on the frame's own
    // texture rather than on painting contamination.
    // The check is only meaningful when reference rows are completely smooth (uniform dark
    // background with no edges) — the no-frame contamination case where painting content
    // (e.g. a face against a dark background) would not otherwise stop the scan.
    let edgeCheckActive = edgeSets !== null &&
      !edgeSets.slice(0, initN).some(e => e.length > 0);
    const edgeTolerance = 5; // ± position tolerance for edge match (handles slight shift)
    const coherenceN    = 3; // consecutive overlapping positions to trigger rejection
    let prevEdges  = null;
    let edgeRunLen = 0;
    if (varValues) console.log(`[mean_profile] ${label}: varProfile(0-${Math.min(24, maxN)-1})=[${varValues.slice(0, Math.min(25, maxN)).map(v => Math.round(v)).join(',')}]`);
    if (madValues) console.log(`[mean_profile] ${label}: madProfile(0-${Math.min(24, maxN)-1})=[${madValues.slice(0, Math.min(25, maxN)).map(v => v.toFixed(1)).join(',')}]`);
    if (edgeSets) console.log(`[mean_profile] ${label}: refEdgeCounts(0-${initN-1})=[${edgeSets.slice(0, initN).map(e => e.length).join(',')}] edgeCheck=${edgeCheckActive}`);
    let lastGoodIdx = initN - 1, consecutiveOutliers = 0;
    let stopIdx = -1;
    for (let i = initN; i < Math.min(maxN, values.length); i++) {
      const dev = Math.abs(values[i] - refMean);
      const varOutlier = varCheckActive && varValues[i] > refVar * varMultiplier;
      // MAD outlier: row has sharper pixel-to-pixel transitions than the edge reference or
      // an absolute ceiling, indicating structured painting content rather than frame material.
      //   Relative check (refMAD × 8): catches smooth-edged frames where painting content
      //     has proportionally much higher spatial sharpness (e.g. near-black canvas edge →
      //     dark painting background with moderate texture). Gate at refMAD ≥ 0.5 avoids
      //     applying to truly featureless edges where threshold would be near zero.
      //   Absolute check (madAbsThreshold=9): catches cases where refMAD is already elevated
      //     (frame itself is textured/cloudy) and painting content has clearly higher sharpness
      //     (e.g. gray-brown cloudy frame edge → structured geometric rug pattern). Three
      //     consecutive outliers required (hysteresis) — one or two partial rows as the scan
      //     crosses an uneven frame boundary are tolerated.
      const madAbsThreshold = 9;
      const madOutlier = madCheckActive && (
        madValues[i] > madAbsThreshold ||
        (refMAD >= 0.5 && madValues[i] > refMAD * varMultiplier)
      );
      if (dev < threshold && !varOutlier && !madOutlier) {
        consecutiveOutliers = 0;
        lastGoodIdx = i;
        // Spatial coherence contamination check (frame-apparent branch only).
        if (edgeCheckActive) {
          const curEdges = edgeSets[i];
          if (curEdges.length > 0 && prevEdges !== null && edgesOverlap(curEdges, prevEdges, edgeTolerance)) {
            edgeRunLen++;
            if (edgeRunLen >= coherenceN) {
              console.log(`[mean_profile] ${label}: coherence contamination — ${edgeRunLen} consecutive frame-apparent positions share edge positions (edgeCount=${curEdges.length}) → painting content — REJECTED`);
              return 0;
            }
          } else {
            edgeRunLen = 0;
          }
          prevEdges = curEdges.length > 0 ? curEdges : null;
        }
      } else {
        consecutiveOutliers++;
        edgeRunLen = 0;  // outlier breaks the coherence run
        prevEdges = null;
        if (consecutiveOutliers >= hysteresisN) {
          stopIdx = lastGoodIdx + 1;
          break;
        }
      }
    }
    const crop = lastGoodIdx + 1;
    if (crop < 5) {
      console.log(`[mean_profile] ${label}: scan found only ${crop} rows (need ≥5), refMean=${refMean.toFixed(1)}`);
      return 0;
    }
    // Runaway guard: if the scan ran all the way to the cap with no natural stopping point,
    // the crop is bounded by maxN not by image content — reject.
    if (stopIdx < 0) {
      console.log(`[mean_profile] ${label}: scan ran to cap (${crop}px, refMean=${refMean.toFixed(1)}) — REJECTED (runaway)`);
      return 0;
    }
    // Use refMean (initial edge values, most clearly frame-colored) for the contrast check
    // rather than bandMean. bandMean gets diluted by rows near the frame/painting boundary
    // whose values trend toward interior; refMean reflects the actual frame color.
    const bandMean = values.slice(0, crop).reduce((s, v) => s + v, 0) / crop;
    const contrast = Math.abs(refMean - interiorMean);
    // contrastOverride: for non-luminance profiles (e.g. chroma scans) where refMean
    // is not a luminance value and |refMean - interiorMean| is meaningless. The override
    // supplies a pre-computed contrast scalar (e.g. outer-edge chroma distance) directly.
    const effectiveContrast = contrastOverride !== null ? contrastOverride : contrast;
    const passed = effectiveContrast > contrastThreshold;
    const bandVar = varCheckActive ? varValues.slice(0, crop).reduce((s, v) => s + v, 0) / crop : null;
    const bandMAD = madCheckActive ? madValues.slice(0, crop).reduce((s, v) => s + v, 0) / crop : null;
    console.log(`[mean_profile] ${label}: crop=${crop}px, refMean=${refMean.toFixed(1)}, bandMean=${bandMean.toFixed(1)}, contrast=${contrast.toFixed(1)}${contrastOverride !== null ? ` chromaContrast=${contrastOverride.toFixed(1)}` : ''}${varCheckActive ? ` refVar=${refVar.toFixed(1)} bandVar=${bandVar.toFixed(1)}` : ''}${madCheckActive ? ` refMAD=${refMAD.toFixed(1)} bandMAD=${bandMAD.toFixed(1)}` : ''} (need >${contrastThreshold}) → ${passed ? 'CROP' : 'REJECTED (low contrast)'}`);
    return passed ? crop : 0;
  }

  // Per-column frame boundary scan for bevel-continuation zones.
  //
  // WHY PER-COLUMN: incrementalScan uses row means, which work well for uniform or
  // wood-grain frames but fail for ornate frames (e.g. gold) whose internal luminance
  // variation exceeds the consistency threshold before reaching the actual frame/painting
  // boundary. Per-column analysis avoids this because:
  //
  //   1. "Last frame-side" detection: for each column, scan ALL rows in the zone and
  //      find the LAST row that is on the frame side of the midpoint (closer in luminance
  //      to the per-column edge reference than to interiorMean). Internal dark zones
  //      within an ornate frame (carved crevices, bevels between molding elements) are
  //      interior-side in isolation, but the frame material resumes after them — so the
  //      last frame-side row correctly lands at the actual frame/painting boundary rather
  //      than stopping at the first dark zone encountered.
  //
  //      Example: gold | crevice | gold | crevice | gold | DARK PAINTING
  //               frame  interior  frame  interior  frame   interior (permanent)
  //               last frame-side = last gold row before painting → correct boundary ✓
  //
  //   2. Percentile aggregation: frames are roughly (not strictly) horizontal. Individual
  //      column boundaries vary by a few pixels due to slight frame tilt, ornamentation,
  //      or paint partially covering the frame edge. The median (50th percentile) of all
  //      column boundaries is stable against these outliers.
  //
  //   3. Runaway guard: columns where frame-like material extends to the end of the scan
  //      zone (last frame-side row is within tailZone of the cap) are excluded — they
  //      failed to find a clear boundary and would inflate the result.
  //
  //   4. Direction: yStep=+1 scans downward (top continuation), yStep=-1 scans upward
  //      (bottom continuation). Returns the offset from startRow at which the frame
  //      ends, for the caller to add to cropTop/cropBottom.
  // minEdgeLum: skip columns whose per-column edge reference is below this luminance.
  //
  // adaptiveRef: when true, scan each column forward from startRow to find the first row
  // where |lum - interiorMean| >= contrastThreshold before computing colEdgeMean. This
  // is used by bevel continuation where startRow is still in the transition zone between
  // the near-black outer bevel and the actual frame material (e.g. gold). Without adaptive
  // ref, colEdgeMean is computed from the transition zone (lum 20–80), which sets
  // edgeBrighter=false and misclassifies bright gold as interior-side. With adaptive ref,
  // colEdgeMean is computed from the first solidly frame-material rows per column, so
  // edgeBrighter is set correctly regardless of frame brightness.
  //
  // Columns where no clearly-frame row is found within refScanLimit rows fall back to
  // refStartDr=0 (dark frame path: bevel rows as reference, edgeBrighter=false, works for
  // dark wood frames on bright paintings).
  function columnPercentileScan(startRow, maxCropN, yStep, label, minEdgeLum = 0, adaptiveRef = false) {
    const refRows       = 5;
    const refScanLimit  = 40; // max rows to search for adaptive reference per column
    const columnStep    = 16;
    const tailZone      = 10;
    const pct           = 0.65;

    const boundaries = [];
    for (let x = 0; x < width; x += columnStep) {
      // Determine per-column reference start row.
      // When adaptiveRef=true, scan forward to find the first row in bright frame material
      // (lum >= interiorMean + contrastThreshold). This places colEdgeMean in the solid
      // gold zone so edgeBrighter=true, rather than in the dark transition zone where
      // edgeBrighter=false misclassifies bright gold pixels as interior-side.
      // If no bright row is found within refScanLimit, refStartDr stays 0 — this is the
      // correct fallback for dark frames (bevel rows as reference, edgeBrighter=false).
      let refStartDr = 0;
      if (adaptiveRef) {
        for (let dr = 0; dr < Math.min(maxCropN, refScanLimit); dr++) {
          const y = startRow + yStep * dr;
          if (y < 0 || y >= height) break;
          if (pixelLum((y * width + x) * channels) >= interiorMean + contrastThreshold) {
            refStartDr = dr;
            break;
          }
        }
      }

      // Per-column reference mean from refRows rows starting at refStartDr.
      let colEdgeMean = 0;
      let refCount = 0;
      for (let dr = refStartDr; dr < refStartDr + refRows; dr++) {
        const y = startRow + yStep * dr;
        if (y >= 0 && y < height) { colEdgeMean += pixelLum((y * width + x) * channels); refCount++; }
      }
      if (refCount === 0) continue;
      colEdgeMean /= refCount;
      if (colEdgeMean < minEdgeLum) continue;
      if (Math.abs(colEdgeMean - interiorMean) <= contrastThreshold) continue;

      const midPoint     = (colEdgeMean + interiorMean) / 2;
      const edgeBrighter = colEdgeMean > interiorMean;

      // Scan rows in zone; track the last row on the frame side.
      // Stop updating once a sustained run of interior-side rows is seen: this
      // tolerates short frame crevices without overshooting into painting content.
      const maxInteriorRun = Math.max(8, Math.round(height * 0.006));
      let lastFrameSide = refStartDr + refRows - 1; // reference rows are by definition frame-side
      let interiorRunLen = 0;
      for (let dr = refStartDr + refRows; dr < maxCropN; dr++) {
        const y = startRow + yStep * dr;
        if (y < 0 || y >= height) break;
        const val = pixelLum((y * width + x) * channels);
        if (edgeBrighter ? val >= midPoint : val <= midPoint) {
          lastFrameSide = dr;
          interiorRunLen = 0;
        } else {
          interiorRunLen++;
          if (interiorRunLen >= maxInteriorRun) break;
        }
      }

      // Runaway guard: frame-like material extended to the cap — no clear boundary found.
      if (lastFrameSide >= maxCropN - tailZone) continue;

      boundaries.push(lastFrameSide + 1); // crop starts after the last frame-side row
    }

    if (boundaries.length < 3) {
      console.log(`[mean_profile] ${label}: column scan — only ${boundaries.length} column(s) gave a boundary (need ≥3)`);
      return 0;
    }
    boundaries.sort((a, b) => a - b);
    const crop = boundaries[Math.min(Math.floor(boundaries.length * pct), boundaries.length - 1)];
    console.log(`[mean_profile] ${label}: column scan — ${boundaries.length} cols, range=[${boundaries[0]}..${boundaries[boundaries.length - 1]}], P${Math.round(pct * 100)}=${crop}px`);
    return crop;
  }

  // Per-row frame boundary scan for bevel-continuation zones — horizontal counterpart
  // to columnPercentileScan. Scans each row left-to-right (xStep=+1, left continuation)
  // or right-to-left (xStep=-1, right continuation), tracking the last column on the
  // frame side of the per-row midpoint, then takes the P65 of all row boundaries.
  // adaptiveRef works identically: scans forward per row to find the first column with
  // lum >= interiorMean + contrastThreshold, anchoring the reference in solid frame
  // material rather than a near-black transition bevel.
  function rowPercentileScan(startCol, maxCropN, xStep, label, minEdgeLum = 0, adaptiveRef = false, startY = 0, endY = height, minParticipation = 0) {
    const refCols       = 5;
    const refScanLimit  = 40;
    const rowStep       = 16;
    const tailZone      = 10;
    const pct           = 0.65;

    const boundaries = [];
    let sampledRows = 0;
    for (let y = startY; y < endY; y += rowStep) {
      sampledRows++;
      let refStartDc = 0;
      if (adaptiveRef) {
        for (let dc = 0; dc < Math.min(maxCropN, refScanLimit); dc++) {
          const x = startCol + xStep * dc;
          if (x < 0 || x >= width) break;
          if (pixelLum((y * width + x) * channels) >= interiorMean + contrastThreshold) {
            refStartDc = dc;
            break;
          }
        }
      }

      let rowEdgeMean = 0;
      let refCount = 0;
      for (let dc = refStartDc; dc < refStartDc + refCols; dc++) {
        const x = startCol + xStep * dc;
        if (x >= 0 && x < width) { rowEdgeMean += pixelLum((y * width + x) * channels); refCount++; }
      }
      if (refCount === 0) continue;
      rowEdgeMean /= refCount;
      if (rowEdgeMean < minEdgeLum) continue;
      if (Math.abs(rowEdgeMean - interiorMean) <= contrastThreshold) continue;

      const midPoint     = (rowEdgeMean + interiorMean) / 2;
      const edgeBrighter = rowEdgeMean > interiorMean;

      const maxInteriorRun = Math.max(8, Math.round(width * 0.006));
      let lastFrameSide = refStartDc + refCols - 1;
      let interiorRunLen = 0;
      for (let dc = refStartDc + refCols; dc < maxCropN; dc++) {
        const x = startCol + xStep * dc;
        if (x < 0 || x >= width) break;
        const val = pixelLum((y * width + x) * channels);
        if (edgeBrighter ? val >= midPoint : val <= midPoint) {
          lastFrameSide = dc; interiorRunLen = 0;
        } else {
          interiorRunLen++;
          if (interiorRunLen >= maxInteriorRun) break;
        }
      }

      if (lastFrameSide >= maxCropN - tailZone) continue;
      boundaries.push(lastFrameSide + 1);
    }

    if (boundaries.length < 3) {
      console.log(`[mean_profile] ${label}: row scan — only ${boundaries.length} row(s) gave a boundary (need ≥3)`);
      return 0;
    }
    if (minParticipation > 0 && sampledRows > 0 && boundaries.length / sampledRows < minParticipation) {
      console.log(`[mean_profile] ${label}: row scan rejected — participation ${boundaries.length}/${sampledRows} (${(boundaries.length / sampledRows * 100).toFixed(0)}%) < ${(minParticipation * 100).toFixed(0)}% minimum — painting content`);
      return 0;
    }
    boundaries.sort((a, b) => a - b);
    const crop = boundaries[Math.min(Math.floor(boundaries.length * pct), boundaries.length - 1)];
    console.log(`[mean_profile] ${label}: row scan — ${boundaries.length}/${sampledRows} rows (${(boundaries.length / sampledRows * 100).toFixed(0)}%), range=[${boundaries[0]}..${boundaries[boundaries.length - 1]}], P${Math.round(pct * 100)}=${crop}px`);
    return crop;
  }

  // Top and bottom: scan using full-width row means.
  // Pass rowVariances as supplementary signal: rows with high within-row variance are
  // painting content (structured patterns), not frame material, even if their mean is close
  // to the edge reference. The reversed variance array mirrors the reversed means array.
  let cropTop    = detectionMode !== 'color' ? incrementalScan(rowMeans, maxRows, 'top', null, null, rowVariances, rowMADs, topEdgeSets) : 0;
  let cropBottom = detectionMode !== 'color' ? incrementalScan([...rowMeans].reverse(), maxRows, 'bottom', null, null, [...rowVariances].reverse(), [...rowMADs].reverse(), botEdgeSets) : 0;

  // Supplementary color-based T/B scan: detects frames with distinct color but low
  // luminance contrast (e.g. thin gold frames near interior brightness). Runs only when
  // the luminance scan returned 0. Uses rowChromaScores (mean chromaticity distance per
  // row) with a tighter loop threshold (15, calibrated to the 0-50 chroma range) and a
  // contrastOverride (outer-edge chroma score) for the final acceptance gate.
  // The chroma-distance approach is inherently robust against dark painting edges:
  // those have near-zero chroma distance (same hue as interior) so the acceptance
  // gate (edgeChromaScore > contrastThreshold) naturally rejects them.
  // Supplementary color-based T/B scan. chromaGate is stricter than contrastThreshold
  // to avoid false detections on warm-toned painting edges (chroma 15–25); gold frames
  // typically score 30–60 and comfortably exceed the gate.
  if (rowChromaScores && detectionMode !== 'luminance') {
    const chromaInitN = Math.min(5, Math.floor(maxRows / 2));
    const chromaGate = contrastThreshold * 1.5; // 30 when contrastThreshold=20
    if (cropTop === 0) {
      const topEdgeChroma = rowChromaScores.slice(0, chromaInitN).reduce((s, v) => s + v, 0) / chromaInitN;
      if (topEdgeChroma > chromaGate) {
        const colorCrop = incrementalScan(rowChromaScores, maxRows, 'top-color', 15, topEdgeChroma);
        if (colorCrop > 0) { console.log(`[mean_profile] top: color scan detected ${colorCrop}px (chromaEdge=${topEdgeChroma.toFixed(1)})`); cropTop = colorCrop; }
      }
    }
    if (cropBottom === 0) {
      const botChromaRev = [...rowChromaScores].reverse();
      const botEdgeChroma = botChromaRev.slice(0, chromaInitN).reduce((s, v) => s + v, 0) / chromaInitN;
      if (botEdgeChroma > chromaGate) {
        const colorCrop = incrementalScan(botChromaRev, maxRows, 'bottom-color', 15, botEdgeChroma);
        if (colorCrop > 0) { console.log(`[mean_profile] bottom: color scan detected ${colorCrop}px (chromaEdge=${botEdgeChroma.toFixed(1)})`); cropBottom = colorCrop; }
      }
    }
  }

  // Bevel continuation: if the primary scan stopped because a near-black outer bevel set
  // refMean very low, continue from the bevel end using per-column midpoint classification
  // (columnPercentileScan) rather than incrementalScan. incrementalScan's consistency
  // threshold fails for ornate frames (e.g. gold) whose internal luminance variation
  // exceeds the threshold before reaching the actual frame/painting boundary. Column-
  // level midpoint classification is robust to that variation; see function comment above.
  //
  // Bevel continuation trigger: if the outer frame band's row mean is below this threshold,
  // the initial incrementalScan established refMean in a dark transition zone (outer bevel
  // or dark band) rather than the main frame body. The per-column classifier handles the
  // rest of the frame correctly. Threshold of 50 covers both near-black outer bevels
  // (refMean < 20, e.g. ornate gold frames) and medium-dark outer bands (refMean 20–50,
  // e.g. multi-zone ornate frames where a dark strip precedes a brighter frame body).
  const bevelThreshold  = 50;
  // minEdgeLum for columnPercentileScan: skip columns whose per-column edge reference
  // mean is too dark to give a reliable midpoint. Kept at 20 regardless of bevelThreshold
  // so that the column scan can handle dark-band columns (mean 20–50) correctly.
  const bevelMinEdgeLum = 20;
  // Size guard: reject bevel continuation if extSimple exceeds 7% of image height.
  // This allows genuine large ornate frames (e.g. 133px on a 3039px image = 4.4%) while
  // still rejecting runaway false positives (painting content misclassified as frame).
  // False positives from the column scan tend to be very large (> 10%) because the
  // classifier runs through painting content with no clear frame boundary.
  const bevelMaxExtFrac = 0.07;
  const initN = Math.min(5, Math.floor(maxRows / 2));

  // cropTopForBand / cropBottomForBand: used for L/R band computation and T/B-backed
  // estimate. These are set by the NON-adaptive bevel continuation pass (same ext as
  // the stable "great progress" version), keeping the band boundaries stable regardless
  // of how much the adaptive ref pass adds for the actual crop. Without this separation,
  // the adaptive ref's larger cropTop shifts `estimate` and the band start, which changes
  // refMean for the right ext scan by ~12 units and causes it to miss the frame boundary.
  let cropTopForBand    = cropTop;
  let cropBottomForBand = cropBottom;
  // MAD threshold for bevel continuation: if the extension rows have painting-level
  // within-row MAD, reject the extension. MAD (median absolute deviation) is used instead
  // of variance because textured frames (wood grain) have high variance due to sparse
  // bright outliers, but low MAD because the median pixel is still close to the frame color.
  // Painting content has high MAD (many diverse luminance values). Threshold 5 separates
  // frame material (MAD typically 0.5–4) from painting content (MAD typically 5–20+).
  const bevelExtMADThreshold = 5;
  {
    const topRefMean = rowMeans.slice(0, initN).reduce((s, v) => s + v, 0) / initN;
    if (cropTop > 0 && topRefMean < bevelThreshold && detectionMode !== 'color') {
      const maxBevelExt = Math.round(height * 0.12);
      const scanN = Math.min(maxRows - cropTop, maxBevelExt);
      // Pass 1 (no adaptiveRef): stable result used to anchor the L/R band.
      const extSimple = columnPercentileScan(cropTop, scanN, +1, 'top-bevel-cont', bevelMinEdgeLum, false);
      // Size guard: implausibly large extension means the classifier hit painting content.
      if (extSimple > Math.round(height * bevelMaxExtFrac)) {
        console.log(`[mean_profile] top: bevel continuation rejected (extSimple=${extSimple}px > ${Math.round(height * bevelMaxExtFrac)}px limit, no clear frame boundary)`);
      } else if (extSimple > 0) {
        // Variance gate: check only the first few rows immediately past the current crop
        // boundary. If those rows are painting content (high variance), the bevel extension
        // is wrong. Checking the full extension would be diluted by low-variance rows deeper
        // in a uniform dark background, masking the true boundary signal.
        const extCheckN = Math.min(5, extSimple);
        const extMADMean = rowMADs.slice(cropTop, cropTop + extCheckN).reduce((s, v) => s + v, 0) / extCheckN;
        if (extMADMean > bevelExtMADThreshold) {
          console.log(`[mean_profile] top: bevel continuation rejected (extMADMean=${extMADMean.toFixed(1)} > ${bevelExtMADThreshold} — painting content)`);
        } else {
          cropTopForBand = cropTop + extSimple;
          // Pass 2 (adaptiveRef): finds the actual frame/painting boundary for the crop.
          const ext = columnPercentileScan(cropTop, scanN, +1, 'top-bevel-cont-adaptive', bevelMinEdgeLum, true);
          // Ratio guard + size guard on bestExt: if the adaptive pass returns more than 3×
          // the non-adaptive result, it has likely latched onto painting content rather than
          // the true frame boundary (the adaptive reference search found a bright painting
          // region instead of bright frame material). Fall back to stable extSimple in that
          // case. Also cap by the absolute size limit to catch remaining outliers.
          const bevelLimit = Math.round(height * bevelMaxExtFrac);
          const rawBest = Math.max(extSimple, ext);
          const bestExt = (rawBest > extSimple * 4 || rawBest > bevelLimit) ? extSimple : rawBest;
          if (bestExt > 0) { console.log(`[mean_profile] top: bevel continuation simple=${extSimple}px adaptive=${ext}px → using ${bestExt}px → ${cropTop + bestExt}px total`); cropTop += bestExt; }
        }
      }
    }
  }
  {
    const botRefMean = rowMeans.slice(height - initN).reduce((s, v) => s + v, 0) / initN;
    if (cropBottom > 0 && botRefMean < bevelThreshold && detectionMode !== 'color') {
      const maxBevelExt = Math.round(height * 0.12);
      const scanN = Math.min(maxRows - cropBottom, maxBevelExt);
      const extSimple = columnPercentileScan(height - 1 - cropBottom, scanN, -1, 'bottom-bevel-cont', bevelMinEdgeLum, false);
      // Size guard: implausibly large extension means the classifier hit painting content.
      if (extSimple > Math.round(height * bevelMaxExtFrac)) {
        console.log(`[mean_profile] bottom: bevel continuation rejected (extSimple=${extSimple}px > ${Math.round(height * bevelMaxExtFrac)}px limit, no clear frame boundary)`);
      } else if (extSimple > 0) {
        // Variance gate: reject extension if the extended rows have painting-level variance.
        const extCheckN = Math.min(5, extSimple);
        const extStart = height - cropBottom - extSimple;
        const extMADMean = rowMADs.slice(extStart, extStart + extCheckN).reduce((s, v) => s + v, 0) / extCheckN;
        if (extMADMean > bevelExtMADThreshold) {
          console.log(`[mean_profile] bottom: bevel continuation rejected (extMADMean=${extMADMean.toFixed(1)} > ${bevelExtMADThreshold} — painting content)`);
        } else {
          cropBottomForBand = cropBottom + extSimple;
          const ext = columnPercentileScan(height - 1 - cropBottom, scanN, -1, 'bottom-bevel-cont-adaptive', bevelMinEdgeLum, true);
          const bevelLimit = Math.round(height * bevelMaxExtFrac);
          const rawBest = Math.max(extSimple, ext);
          const bestExt = (rawBest > extSimple * 4 || rawBest > bevelLimit) ? extSimple : rawBest;
          if (bestExt > 0) { console.log(`[mean_profile] bottom: bevel continuation simple=${extSimple}px adaptive=${ext}px → using ${bestExt}px → ${cropBottom + bestExt}px total`); cropBottom += bestExt; }
        }
      }
    }
  }
  const _tTB = Date.now();

  // Left and right: col means restricted to rows at the INNER EDGE of the detected frame
  // bands, not the frame rows themselves. Frame rows are uniform across all columns (all
  // gold, or all black) so col means computed through them cannot distinguish frame columns
  // from painting columns. Interior-edge rows contain frame material at left/right column
  // positions and painting content at center positions — making col means discriminating.
  // Fall back to edge rows when no top/bottom frame was detected.
  const refRows = Math.max(3, Math.round(height * refFraction));
  const topInner = cropTopForBand    > 0
    ? [cropTopForBand,              Math.min(cropTopForBand    + refRows, Math.floor(height / 2))]
    : [0,                    refRows];
  const botInner = cropBottomForBand > 0
    ? [Math.max(height - cropBottomForBand - refRows, Math.ceil(height / 2)), height - cropBottomForBand]
    : [height - refRows,     height];
  const cornerBands    = [topInner, botInner];
  // Use col median (not mean) for L/R detection: robust against isolated bright grain
  // columns within a dark wood frame that inflate the mean and cause early scan termination.
  const cornerColMeans = Array.from({ length: width }, (_, x) => colMedianInBands(x, cornerBands));
  const cornerColBandMADs = Array.from({ length: width }, (_, x) => colBandMAD(x, cornerBands));
  // Parallel chroma profile for color-based L/R detection: median chromaticity distance
  // per column within the same corner bands. Only computed for colour images.
  const cornerColChromaScores = channels >= 3
    ? Array.from({ length: width }, (_, x) => colChromaMedianInBands(x, cornerBands))
    : null;
  const _tColMedians = Date.now();
  console.log(`[mean_profile] colMeansProfile(0-${Math.min(24, maxCols)-1})=[${cornerColMeans.slice(0, Math.min(25, maxCols)).map(v => v.toFixed(1)).join(',')}]`);
  console.log(`[mean_profile] colBandMADProfile(0-${Math.min(24, maxCols)-1})=[${cornerColBandMADs.slice(0, Math.min(25, maxCols)).map(v => v.toFixed(1)).join(',')}]`);

  // Guard: if col medians are nearly flat across all columns the bands are still
  // non-discriminating — skip left/right rather than produce false positives.
  const colMeansMin = cornerColMeans.reduce((a, v) => Math.min(a, v),  Infinity);
  const colMeansMax = cornerColMeans.reduce((a, v) => Math.max(a, v), -Infinity);
  const colMeansDiscriminating = (colMeansMax - colMeansMin) >= 5;
  console.log(`[mean_profile] col medians range=${( colMeansMax - colMeansMin).toFixed(1)} (bands top=${JSON.stringify(topInner)}, bot=${JSON.stringify(botInner)})${colMeansDiscriminating ? '' : ' → SKIPPING left/right (non-discriminating)'}`);

  // When both T/B bands fell back to edge rows (no T/B frame detected), the corner bands
  // use literal image-edge rows rather than the inner-edge of a detected frame. Those edge
  // rows can contain dark painting content (ceiling, wall, floor, dark background) whose
  // column medians look like frame material to incrementalScan. This causes large false-
  // positive L/R crops (e.g. 538px on an image with no left frame) because the dark corner
  // band rows run through painting content with no clear frame/painting boundary.
  //
  // Two-part guard when T/B are both in edge-row fallback:
  //   1. Stricter consistency threshold (45 vs 35): rejects borderline stopping points.
  //   2. Size cap (3% of width): real thin frames detected via edge-row fallback are
  //      typically < 15px. A result of 3%+ is almost always dark painting content. This
  //      mirrors the bevel continuation size guard and is similarly calibrated.
  const MIN_RELIABLE_CROP = 10;
  const strictLR = cropTopForBand < MIN_RELIABLE_CROP && cropBottomForBand < MIN_RELIABLE_CROP;
  const lrMaxCrop = strictLR ? Math.round(width * 0.03) : Infinity;
  if (strictLR) console.log(`[mean_profile] L/R: T/B bands unreliable (top=${cropTopForBand}px, bot=${cropBottomForBand}px < ${MIN_RELIABLE_CROP}px) — strict mode (threshold=45, maxCrop=${lrMaxCrop}px)`);
  // Adaptive consistency threshold for L/R: when the outer frame reference is near-black
  // (refMean < half the default consistencyThreshold), tighten the threshold proportionally.
  // Near-black frames transitioning to even moderately dark painting backgrounds benefit
  // from a narrower band. Gold/bright frames are unaffected (formula hits the 35 cap).
  const initColRefN = Math.min(5, Math.floor(maxCols / 2));
  const leftEdgeRefMean  = cornerColMeans.slice(0, initColRefN).reduce((s, v) => s + v, 0) / initColRefN;
  const rightEdgeRefMean = cornerColMeans.slice(-initColRefN).reduce((s, v) => s + v, 0) / initColRefN;
  const lrThresholdLeft  = strictLR ? 45 : Math.min(consistencyThreshold, Math.max(15, Math.round(leftEdgeRefMean  * 2)));
  const lrThresholdRight = strictLR ? 45 : Math.min(consistencyThreshold, Math.max(15, Math.round(rightEdgeRefMean * 2)));
  if (!strictLR && (lrThresholdLeft !== consistencyThreshold || lrThresholdRight !== consistencyThreshold)) {
    console.log(`[mean_profile] L/R: adaptive threshold — left refMean=${leftEdgeRefMean.toFixed(1)} → threshold=${lrThresholdLeft}, right refMean=${rightEdgeRefMean.toFixed(1)} → threshold=${lrThresholdRight}`);
  }
  // Coherence check (edgeSets) is disabled for L/R: wood grain and similar frame textures
  // produce coherent horizontal edges that incorrectly trigger the coherence rejection,
  // causing the scan to fall back to a small color-only result. The MAD-based outlier
  // detection in incrementalScan is sufficient for L/R without coherence.
  let cropLeft  = (colMeansDiscriminating && detectionMode !== 'color') ? incrementalScan(cornerColMeans, maxCols, 'left', lrThresholdLeft, null, null, cornerColBandMADs, null) : 0;
  let cropRight = (colMeansDiscriminating && detectionMode !== 'color') ? incrementalScan([...cornerColMeans].reverse(), maxCols, 'right', lrThresholdRight, null, null, [...cornerColBandMADs].reverse(), null) : 0;
  if (cropLeft  > lrMaxCrop) { console.log(`[mean_profile] left: strict-mode size cap — ${cropLeft}px > ${lrMaxCrop}px limit → 0`);  cropLeft  = 0; }
  if (cropRight > lrMaxCrop) { console.log(`[mean_profile] right: strict-mode size cap — ${cropRight}px > ${lrMaxCrop}px limit → 0`); cropRight = 0; }

  // Supplementary color-based L/R scan: analogous to the T/B chroma scan above.
  // Runs only when the luminance scan returned 0 (or was suppressed by strictLR).
  // Not applied in strictLR mode: the corner bands are edge-row fallbacks that don't
  // reliably represent frame material, so color distance would be unreliable too.
  if (cornerColChromaScores && !strictLR && detectionMode !== 'luminance') {
    const chromaColInitN = Math.min(5, Math.floor(maxCols / 2));
    const chromaGateLR = contrastThreshold * 1.5; // same stricter gate as T/B color scan
    if (cropLeft === 0) {
      const leftEdgeChroma = cornerColChromaScores.slice(0, chromaColInitN).reduce((s, v) => s + v, 0) / chromaColInitN;
      if (leftEdgeChroma > chromaGateLR) {
        const colorCrop = incrementalScan(cornerColChromaScores, maxCols, 'left-color', 15, leftEdgeChroma);
        if (colorCrop > 0) { console.log(`[mean_profile] left: color scan detected ${colorCrop}px (chromaEdge=${leftEdgeChroma.toFixed(1)})`); cropLeft = colorCrop; }
      }
    }
    if (cropRight === 0) {
      const rightChromaRev = [...cornerColChromaScores].reverse();
      const rightEdgeChroma = rightChromaRev.slice(0, chromaColInitN).reduce((s, v) => s + v, 0) / chromaColInitN;
      if (rightEdgeChroma > chromaGateLR) {
        const colorCrop = incrementalScan(rightChromaRev, maxCols, 'right-color', 15, rightEdgeChroma);
        if (colorCrop > 0) { console.log(`[mean_profile] right: color scan detected ${colorCrop}px (chromaEdge=${rightEdgeChroma.toFixed(1)})`); cropRight = colorCrop; }
      }
    }
  }

  // L/R bevel continuation: analogous to T/B bevel continuation, using rowPercentileScan.
  // Triggered when the initial scan's refMean (outermost column medians in the corner bands)
  // is below bevelThreshold, meaning the scan stopped in a dark outer transition zone rather
  // than the main frame body. Not applied in strictLR mode: that mode is already conservative
  // and bevel extension could amplify false positives from unreliable edge-row bands.
  const bevelLimitLR = Math.round(width * bevelMaxExtFrac);
  const initColN = Math.min(5, Math.floor(maxCols / 2));
  const leftRefMean  = cornerColMeans.slice(0, initColN).reduce((s, v) => s + v, 0) / initColN;
  const rightRefMean = cornerColMeans.slice(-initColN).reduce((s, v) => s + v, 0) / initColN;
  if (cropLeft > 0 && leftRefMean < bevelThreshold && !strictLR && detectionMode !== 'color') {
    const maxBevelExtLR = Math.round(width * 0.12);
    const scanN = Math.min(maxCols - cropLeft, maxBevelExtLR);
    // Non-adaptive only: cropLeft positions us just inside the outer bevel, so the first
    // columns inward are already main frame body — adaptiveRef risks latching onto painting
    // content (which is brighter than interiorMean + contrastThreshold).
    // Participation rate gate: a real frame bevel activates nearly all rows in rowPercentileScan;
    // painting content only appearing in some rows (e.g. a subject against a dark background)
    // activates a small fraction. Threshold 0.5 = at least half of sampled rows must contribute.
    const ext = rowPercentileScan(cropLeft, scanN, +1, 'left-bevel-cont', bevelMinEdgeLum, false, 0, height, 0.4);
    if (ext > bevelLimitLR) {
      console.log(`[mean_profile] left: bevel continuation rejected (ext=${ext}px > ${bevelLimitLR}px limit, no clear frame boundary)`);
    } else if (ext > 0) {
      console.log(`[mean_profile] left: bevel continuation → +${ext}px → ${cropLeft + ext}px total`);
      cropLeft += ext;
    }
  }
  if (cropRight > 0 && rightRefMean < bevelThreshold && !strictLR && detectionMode !== 'color') {
    const maxBevelExtLR = Math.round(width * 0.12);
    const scanN = Math.min(maxCols - cropRight, maxBevelExtLR);
    const ext = rowPercentileScan(width - 1 - cropRight, scanN, -1, 'right-bevel-cont', bevelMinEdgeLum, false, 0, height, 0.4);
    if (ext > bevelLimitLR) {
      console.log(`[mean_profile] right: bevel continuation rejected (ext=${ext}px > ${bevelLimitLR}px limit, no clear frame boundary)`);
    } else if (ext > 0) {
      console.log(`[mean_profile] right: bevel continuation → +${ext}px → ${cropRight + ext}px total`);
      cropRight += ext;
    }
  }

  // Color continuity extension: after any primary scan stops, look ahead in the chroma
  // profile for persisting frame-colored pixels. Addresses undercrop cases where sparse
  // frame material (e.g. a sliver of gold) dilutes the row/col mean below the consistency
  // threshold — the mean stops, but the actual frame hasn't ended yet.
  //
  // The frameBandChroma gate (contrastThreshold/2 = 10) ensures this only runs when the
  // detected frame already has a color signal; dark/neutral frames (chroma ≈ 0) are skipped.
  // The hysteresis of 3 tolerates brief gaps in a gold frame without overshooting.
  // Cap is 5% of the shorter image dimension to accommodate thick ornate frames.
  //
  // Within-row/column chroma variance gate: frame material has UNIFORM color across its
  // hysteresis of 3 and 15px cap are the primary stopping guards.
  if (detectionMode !== 'luminance') {
    const chromaContGate = contrastThreshold / 2; // 10 when contrastThreshold=20
    const maxLookahead   = 15;
    const contHyst       = 3;

    function chromaLookahead(chromaArr, cropN, label) {
      if (cropN === 0 || !chromaArr || chromaArr.length <= cropN) return 0;
      const frameBandChroma = chromaArr.slice(0, cropN).reduce((s, v) => s + v, 0) / cropN;
      if (frameBandChroma <= chromaContGate) return 0;
      let ext = 0, gap = 0;
      const limit = Math.min(maxLookahead, chromaArr.length - cropN);
      for (let i = 0; i < limit; i++) {
        if (chromaArr[cropN + i] > chromaContGate) {
          ext = i + 1; gap = 0;
        } else {
          gap++;
          if (gap >= contHyst) break;
        }
      }
      if (ext > 0) console.log(`[mean_profile] ${label}: chroma continuity +${ext}px → ${cropN + ext}px`);
      return ext;
    }

    if (rowChromaScores) {
      cropTop    += chromaLookahead(rowChromaScores, cropTop, 'top');
      cropBottom += chromaLookahead([...rowChromaScores].reverse(), cropBottom, 'bottom');
    }
    if (cornerColChromaScores && !strictLR) {
      cropLeft   += chromaLookahead(cornerColChromaScores, cropLeft, 'left');
      cropRight  += chromaLookahead([...cornerColChromaScores].reverse(), cropRight, 'right');
    }
  }

  // Cross-edge inference: if a parallel edge pair is detected but the perpendicular pair
  // is not (e.g. L and R detected but T and B = 0), infer the missing pair using the
  // detected pair's average thickness. This handles frames — like wood grain — whose
  // row means vary too much for a direct scan but whose borders are structurally symmetric.
  // A contrast check guards against falsely cropping painting edges.
  function inferEdge(estimate, getMeans, label) {
    const n = Math.min(estimate, maxRows);
    if (n < 1) return 0;
    const bandMean = getMeans(n).reduce((s, v) => s + v, 0) / n;
    const contrast = Math.abs(bandMean - interiorMean);
    const passed = contrast > contrastThreshold;
    console.log(`[mean_profile] ${label} inferred from parallel pair: estimate=${estimate}px, bandMean=${bandMean.toFixed(1)}, contrast=${contrast.toFixed(1)} → ${passed ? 'CROP' : 'REJECTED (low contrast)'}`);
    return passed ? estimate : 0;
  }

  // For inferring T/B from L/R: use restricted row means (only the detected frame-column
  // strips) rather than full-width row means. Full-width means are dominated by painting
  // content when frame columns are thin (<5% of width), causing the contrast check to
  // fail even when the top/bottom frame material IS a different color from the interior.
  function restrictedRowMean(y, leftCols, rightCols) {
    let sum = 0, count = 0;
    for (let x = 0; x < leftCols; x++) { sum += pixelLum((y * width + x) * channels); count++; }
    for (let x = width - rightCols; x < width; x++) { sum += pixelLum((y * width + x) * channels); count++; }
    return count > 0 ? sum / count : interiorMean;
  }

  if (cropLeft > 0 && cropRight > 0 && cropTop === 0 && cropBottom === 0) {
    // Both T and B missing — infer from (L+R)/2 average.
    const estimate = Math.round((cropLeft + cropRight) / 2);
    cropTop    = inferEdge(estimate, n => Array.from({ length: n }, (_, y) => restrictedRowMean(y, cropLeft, cropRight)),                'top');
    cropBottom = inferEdge(estimate, n => Array.from({ length: n }, (_, i) => restrictedRowMean(height - 1 - i, cropLeft, cropRight)), 'bottom');
  } else if (cropLeft > 0 && cropRight > 0 && cropTop > 0 && cropBottom === 0) {
    // T detected but B missing — infer B ≈ T using frame-column strips.
    cropBottom = inferEdge(cropTop, n => Array.from({ length: n }, (_, i) => restrictedRowMean(height - 1 - i, cropLeft, cropRight)), 'bottom');
  } else if (cropLeft > 0 && cropRight > 0 && cropTop === 0 && cropBottom > 0) {
    // B detected but T missing — infer T ≈ B using frame-column strips.
    cropTop = inferEdge(cropBottom, n => Array.from({ length: n }, (_, y) => restrictedRowMean(y, cropLeft, cropRight)), 'top');
  } else if (cropTop > 0 && cropBottom > 0 && cropLeft === 0 && cropRight === 0) {
    // Both L and R missing — infer from (T+B)/2 average.
    const estimate = Math.round((cropTop + cropBottom) / 2);
    const colMeansAll = Array.from({ length: width }, (_, x) => colMeanInBands(x, [[0, height]]));
    cropLeft  = inferEdge(estimate, n => colMeansAll.slice(0, n),                   'left');
    cropRight = inferEdge(estimate, n => colMeansAll.slice(colMeansAll.length - n), 'right');
  }

  // Secondary inference: re-infer underdetected edges using detected parallel/mirror edges.
  //
  //   T/B-backed L/R: if L or R < half the T/B average, estimate from T/B average.
  //     - Uses final cropTop/cropBottom (not cropTopForBand) so that inferred T/B values
  //       (e.g. top inferred from bottom) correctly anchor the L/R estimate.
  //
  //   L/R mirror: if one side of the L/R pair was more than 2× the other, the smaller is
  //     likely underdetected. Use the larger side as estimate for the smaller. Evaluated
  //     against original pre-update values so T/B-backed changes don't suppress triggering.
  //
  //   Both use two steps: (1) validate via full-height col means contrast check, then
  //   (2) extend from x=estimate using restricted-band medians.
  if (cropTop > 0 && cropBottom > 0) {
    const tbAvg         = (cropTop + cropBottom) / 2;
    const origCropLeft  = cropLeft;
    const origCropRight = cropRight;
    const tbBackedNeeded = origCropLeft < tbAvg / 2 || origCropRight < tbAvg / 2;
    const lrMirrorNeeded = origCropLeft > 0 && origCropRight > 0 &&
                           (origCropRight < origCropLeft / 2 || origCropLeft < origCropRight / 2);

    if (tbBackedNeeded || lrMirrorNeeded) {
      const colMeansAll = Array.from({ length: width }, (_, x) => colMeanInBands(x, [[0, height]]));
      const revMeansAll = [...colMeansAll].reverse();
      // Parallel chroma profile for color-augmented inference contrast check.
      // Full-height column chroma medians: since thin frames are diluted in full-height lum
      // means, color may provide a better signal when the frame has a distinct hue.
      const colChromaAll = channels >= 3
        ? Array.from({ length: width }, (_, x) => colChromaMedianInBands(x, [[0, height]]))
        : null;
      const revChromaAll = colChromaAll ? [...colChromaAll].reverse() : null;

      const inferEdgeLR = (isLeft, detected, est, label) => {
        const bandSlice = isLeft ? colMeansAll.slice(0, est) : revMeansAll.slice(0, est);
        const bandMean  = bandSlice.reduce((s, v) => s + v, 0) / est;
        const lumContrast = Math.abs(bandMean - interiorMean);
        // Color contrast: mean chroma distance of the band from interior.
        // For thin frames diluted by full-height means, color may pass where lum fails.
        const chromaSlice = colChromaAll ? (isLeft ? colChromaAll.slice(0, est) : revChromaAll.slice(0, est)) : null;
        const chromaContrast = chromaSlice ? chromaSlice.reduce((s, v) => s + v, 0) / est : 0;
        const contrast = Math.max(lumContrast, chromaContrast);
        if (contrast <= contrastThreshold) {
          console.log(`[mean_profile] ${label}: est=${est}px REJECTED (lumContrast=${lumContrast.toFixed(1)}, chromaContrast=${chromaContrast.toFixed(1)} ≤ ${contrastThreshold})`);
          return detected;
        }
        // Use the estimate directly. A previous extension step was removed because it
        // produced large false positives when dark painting content near the frame edge
        // had the same luminance as actual frame material — the scan ran hundreds of pixels
        // into the painting. In all tested cases where inference produced correct results,
        // the extension contributed 0px. The estimate from a parallel/mirror edge is
        // sufficient; color-based validation (future work) is the correct next step.
        console.log(`[mean_profile] ${label}: est=${est}px → ${est}px (bandMean=${bandMean.toFixed(1)}, contrast=${contrast.toFixed(1)})`);
        return est > detected ? est : detected;
      };

      if (tbBackedNeeded) {
        const estimate = Math.round(tbAvg);
        if (origCropLeft  < tbAvg / 2) { const v = inferEdgeLR(true,  cropLeft,  estimate, 'left T/B-backed');  if (v > cropLeft)  { console.log(`[mean_profile] left: ${cropLeft}px → ${v}px`);   cropLeft  = v; } }
        if (origCropRight < tbAvg / 2) { const v = inferEdgeLR(false, cropRight, estimate, 'right T/B-backed'); if (v > cropRight) { console.log(`[mean_profile] right: ${cropRight}px → ${v}px`); cropRight = v; } }
      }

      if (lrMirrorNeeded) {
        if (origCropRight < origCropLeft / 2) {
          const v = inferEdgeLR(false, cropRight, origCropLeft, 'right L/R-mirror');
          if (v > cropRight) { console.log(`[mean_profile] right: ${cropRight}px → ${v}px`); cropRight = v; }
        }
        if (origCropLeft < origCropRight / 2) {
          const v = inferEdgeLR(true, cropLeft, origCropRight, 'left L/R-mirror');
          if (v > cropLeft) { console.log(`[mean_profile] left: ${cropLeft}px → ${v}px`); cropLeft = v; }
        }
      }
    }
  }
  // Symmetric: if L/R both detected but T and/or B appear underdetected, re-infer from L/R.
  // Trigger at 60% of lrAvg (rather than 50%) to catch mild asymmetries where T/B
  // underdetect relative to L/R by up to 40%. The contrast check in inferEdge is the
  // real safety guard against falsely overcropping genuinely-smaller T/B edges.
  if (cropLeft > 0 && cropRight > 0) {
    const lrAvg = (cropLeft + cropRight) / 2;
    if (cropTop < lrAvg * 0.6 || cropBottom < lrAvg * 0.6) {
      const estimate = Math.round(lrAvg);
      if (cropTop < lrAvg * 0.6) {
        const inferred = inferEdge(estimate, n => Array.from({ length: n }, (_, y) => restrictedRowMean(y, cropLeft, cropRight)), 'top (L/R-backed)');
        if (inferred > cropTop) { console.log(`[mean_profile] top: ${cropTop}px → ${inferred}px (L/R-backed)`); cropTop = inferred; }
      }
      if (cropBottom < lrAvg * 0.6) {
        const inferred = inferEdge(estimate, n => Array.from({ length: n }, (_, i) => restrictedRowMean(height - 1 - i, cropLeft, cropRight)), 'bottom (L/R-backed)');
        if (inferred > cropBottom) { console.log(`[mean_profile] bottom: ${cropBottom}px → ${inferred}px (L/R-backed)`); cropBottom = inferred; }
      }
    }
  }

  // Symmetry guard: applied after all inferences so it sees corrected values. Rejects any
  // edge crop more than 4× the median of all four — catches runaway false detections that
  // survive inference (e.g. one edge scanning deep into the painting while others are 0).
  {
    const crops = [cropTop, cropBottom, cropLeft, cropRight].sort((a, b) => a - b);
    const median = (crops[1] + crops[2]) / 2;
    if (median > 0) {
      const maxAllowed = median * 4;
      if (cropTop    > maxAllowed) { console.log(`[mean_profile] top symmetry-rejected: ${cropTop}px > 4×median(${median.toFixed(0)})`);    cropTop    = 0; }
      if (cropBottom > maxAllowed) { console.log(`[mean_profile] bottom symmetry-rejected: ${cropBottom}px > 4×median(${median.toFixed(0)})`); cropBottom = 0; }
      if (cropLeft   > maxAllowed) { console.log(`[mean_profile] left symmetry-rejected: ${cropLeft}px > 4×median(${median.toFixed(0)})`);   cropLeft   = 0; }
      if (cropRight  > maxAllowed) { console.log(`[mean_profile] right symmetry-rejected: ${cropRight}px > 4×median(${median.toFixed(0)})`);  cropRight  = 0; }
    }
  }

  if (cropTop === 0 && cropBottom === 0 && cropLeft === 0 && cropRight === 0) {
    return buffer;
  }

  const extractLeft   = cropLeft;
  const extractTop    = cropTop;
  const extractWidth  = width  - cropLeft - cropRight;
  const extractHeight = height - cropTop  - cropBottom;

  const _tInference = Date.now();
  console.log(`[imageProcessor] mean_profile: removing top=${cropTop}px, bottom=${cropBottom}px, left=${cropLeft}px, right=${cropRight}px`);
  const _result = await sharp(buffer)
    .extract({ left: extractLeft, top: extractTop, width: extractWidth, height: extractHeight })
    .toBuffer();
  const _tEnd = Date.now();
  console.log(`[mean_profile timing] decode=${_tDecode-_t0}ms rowMeans=${_tRowMeans-_tDecode}ms TB=${_tTB-_tRowMeans}ms colMedians=${_tColMedians-_tTB}ms inference=${_tInference-_tColMedians}ms encode=${_tEnd-_tInference}ms total=${_tEnd-_t0}ms`);
  return _result;
}

// TODO (Option 3): ML-based frame segmentation
// Use a pre-trained ONNX model (e.g., fine-tuned SAM or SegFormer) to identify
// painting region vs. decorative frame — handles irregular and ornate frames.
// Cost: ~50–200 MB model weights, onnxruntime-node dependency, startup latency.
// See docs/ROADMAP.md for discussion.

/**
 * Tile Color Continuity pre-processor.
 *
 * Finds frame boundaries by tracking color continuity between tiles as we scan
 * inward from each edge. Frame material is spatially continuous in color — adjacent
 * tile depths look similar. The frame-painting boundary is where the color changes
 * abruptly.
 *
 * Unlike row/column mean approaches (which collapse spatial structure to a single
 * value), this works on a 2D tile grid. Each tile's representative RGB is computed
 * from its pixels, and we measure how much the color changes between one tile depth
 * and the next. Small change = same frame material; large change = boundary.
 *
 * An EMA-updated reference color tracks gradual intra-frame gradients (e.g., the
 * color shift from a dark outer border through a gold bevel to the main frame body)
 * without triggering a false stop. An abrupt change — like the frame-to-painting
 * transition — will exceed the threshold even with EMA tracking.
 *
 * For L/R scanning, only top and bottom corner bands are used (analogous to
 * meanProfile's cornerBands), to exclude painting content in the image center.
 *
 * Algorithm:
 *   1. Downsample image to ~600px on the long axis.
 *   2. Divide into tiles (tileSize × tileSize px).
 *   3. For each tile, compute representative RGB (P45 by luminance across tiles in
 *      that depth row/column — robust central estimate, biased slightly toward darker
 *      tiles to match frame material in the presence of bright painting highlights).
 *   4. Scan inward: compare each depth's representative color to an EMA-updated
 *      reference seeded from the outermost tile. If within colorThreshold, extend
 *      the boundary and update the reference. If outside for minPaintRun consecutive
 *      depths, declare the painting boundary.
 *   5. Scale result back to original image coordinates.
 *
 * Returns 0 on all sides if no abrupt color boundary is found (no frame detected).
 */
async function tileColorPreProcessor(buffer, {
  maxCropFrac    = 0.30,
  tileSize       = 8,
  colorThreshold = 30,  // RGB Euclidean distance gate; within = same material, above = new material
  minPaintRun    = 2,   // consecutive out-of-range depths to confirm boundary (hysteresis)
  cornerFrac     = 0.30,
  emaAlpha       = 0.25, // reference color update rate; low = slow tracking, high = fast tracking
} = {}) {
  const _t0 = Date.now();

  const origMeta = await sharp(buffer).metadata();
  const origW = origMeta.width, origH = origMeta.height;

  const SCALE_TARGET = 600;
  const { data, info } = await sharp(buffer)
    .resize(SCALE_TARGET, SCALE_TARGET, { fit: 'inside', withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  const scaleX = origW / width;
  const scaleY = origH / height;

  // Mean RGB of pixels in a tile region. Used as the tile's color representative.
  function tileMeanRGB(x0, y0, x1, y1) {
    const lx0 = Math.max(0, x0), ly0 = Math.max(0, y0);
    const lx1 = Math.min(width, x1), ly1 = Math.min(height, y1);
    let sR = 0, sG = 0, sB = 0, n = 0;
    for (let y = ly0; y < ly1; y++) {
      for (let x = lx0; x < lx1; x++) {
        const off = (y * width + x) * channels;
        sR += data[off]; sG += data[off + 1]; sB += data[off + 2];
        n++;
      }
    }
    return n > 0 ? [sR / n, sG / n, sB / n] : [0, 0, 0];
  }

  // Euclidean RGB distance between two color vectors.
  function rgbDist([r1, g1, b1], [r2, g2, b2]) {
    return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2);
  }

  // Per-tile mean RGBs for all tiles in tile-row ty (full image width).
  function tileRowColors(ty) {
    const y0 = ty * tileSize, y1 = y0 + tileSize;
    const colors = [];
    for (let tx = 0; tx * tileSize < width; tx++)
      colors.push(tileMeanRGB(tx * tileSize, y0, (tx + 1) * tileSize, y1));
    return colors;
  }

  // Per-tile mean RGBs for tile-column tx, restricted to corner bands.
  const cornerH = Math.round(height * cornerFrac);
  const botStart = Math.floor((height - cornerH) / tileSize);
  function tileColColors(tx) {
    const x0 = tx * tileSize, x1 = x0 + tileSize;
    const colors = [];
    for (let ty = 0; ty * tileSize < cornerH; ty++)
      colors.push(tileMeanRGB(x0, ty * tileSize, x1, (ty + 1) * tileSize));
    for (let ty = botStart; ty * tileSize < height; ty++)
      colors.push(tileMeanRGB(x0, ty * tileSize, x1, (ty + 1) * tileSize));
    return colors;
  }

  // P45 color by luminance — robust central estimate, slightly biased toward darker
  // tiles so bright painting highlights don't dominate the representative color.
  function p45Color(colors) {
    if (colors.length === 0) return [128, 128, 128];
    const sorted = [...colors].sort((a, b) =>
      (0.299 * a[0] + 0.587 * a[1] + 0.114 * a[2]) -
      (0.299 * b[0] + 0.587 * b[1] + 0.114 * b[2])
    );
    return sorted[Math.floor(sorted.length * 0.45)];
  }

  // Build color profile: one representative RGB per tile depth from the edge.
  function buildColorProfile(maxDepth, colorsFn) {
    return Array.from({ length: maxDepth }, (_, d) => p45Color(colorsFn(d)));
  }

  // Find frame boundary using EMA color tracking.
  //
  // Seeds the reference from the outermost tile. Extends the boundary as long as
  // each successive depth's color is within colorThreshold of the (slowly updating)
  // reference. Stops when minPaintRun consecutive depths exceed the threshold.
  //
  // The EMA allows gradual color shifts within the frame (bevel gradients) without
  // triggering a false stop. An abrupt change (painting) exceeds the threshold even
  // accounting for recent drift.
  //
  // Returns boundary in tiles (0 = no frame / no confident boundary found).
  function findBoundary(colorProfile, label) {
    if (colorProfile.length === 0) return 0;

    // Seed reference from the outermost tile color.
    let ref = [...colorProfile[0]];
    let boundary = 0, highRun = 0;
    const distLog = [];

    for (let i = 1; i < colorProfile.length; i++) {
      const dist = rgbDist(colorProfile[i], ref);
      distLog.push(Math.round(dist));

      if (dist <= colorThreshold) {
        // Color matches reference — still frame material.
        highRun = 0;
        boundary = i + 1;
        // Slowly track reference toward current tile to follow frame gradients.
        ref = [
          ref[0] * (1 - emaAlpha) + colorProfile[i][0] * emaAlpha,
          ref[1] * (1 - emaAlpha) + colorProfile[i][1] * emaAlpha,
          ref[2] * (1 - emaAlpha) + colorProfile[i][2] * emaAlpha,
        ];
      } else {
        highRun++;
        if (highRun >= minPaintRun) {
          console.log(`[tile_color] ${label}: boundary at tile ${boundary} (dist=[${distLog.join(',')}])`);
          return boundary;
        }
      }
    }

    // Reached end of scan range without finding a boundary.
    // Only return a non-zero boundary if we actually detected frame material
    // (i.e., the profile had some color continuity before running out).
    if (boundary > 0) {
      console.log(`[tile_color] ${label}: no boundary found, returning ${boundary}t (dist=[${distLog.join(',')}])`);
    }
    return 0; // no confident boundary — don't crop
  }

  const maxTilesV = Math.floor(height * maxCropFrac / tileSize);
  const maxTilesH = Math.floor(width  * maxCropFrac / tileSize);
  const nTilesV   = Math.floor(height / tileSize);
  const nTilesH   = Math.floor(width  / tileSize);

  const topColors    = buildColorProfile(maxTilesV, d => tileRowColors(d));
  const bottomColors = buildColorProfile(maxTilesV, d => tileRowColors(nTilesV - 1 - d));
  const leftColors   = buildColorProfile(maxTilesH, d => tileColColors(d));
  const rightColors  = buildColorProfile(maxTilesH, d => tileColColors(nTilesH - 1 - d));

  const cropTopTiles    = findBoundary(topColors, 'top');
  const cropBottomTiles = findBoundary(bottomColors, 'bottom');
  const cropLeftTiles   = findBoundary(leftColors, 'left');
  const cropRightTiles  = findBoundary(rightColors, 'right');

  const cropTop    = Math.round(cropTopTiles    * tileSize * scaleY);
  const cropBottom = Math.round(cropBottomTiles * tileSize * scaleY);
  const cropLeft   = Math.round(cropLeftTiles   * tileSize * scaleX);
  const cropRight  = Math.round(cropRightTiles  * tileSize * scaleX);

  const _tCompute = Date.now();
  console.log(`[tile_color] downsampled=${width}×${height}, tile=${tileSize}px, colorThreshold=${colorThreshold}, emaAlpha=${emaAlpha}`);
  console.log(`[tile_color] crop: top=${cropTop}px (${cropTopTiles}t) bot=${cropBottom}px (${cropBottomTiles}t) left=${cropLeft}px (${cropLeftTiles}t) right=${cropRight}px (${cropRightTiles}t) — compute=${_tCompute - _t0}ms`);

  if (cropTop === 0 && cropBottom === 0 && cropLeft === 0 && cropRight === 0) return buffer;

  const extractW = origW - cropLeft - cropRight;
  const extractH = origH - cropTop  - cropBottom;
  if (extractW <= 0 || extractH <= 0) return buffer;

  return sharp(buffer)
    .extract({ left: cropLeft, top: cropTop, width: extractW, height: extractH })
    .toBuffer();
}

/**
 * Symmetric Frame Scan pre-processor.
 *
 * Exploits the defining property of picture frames: the same material appears on
 * all four sides at the same depth. Rather than scanning each side independently,
 * this samples multiple blocks per side and checks whether all sides agree in color
 * at each successive depth. Agreement = still in frame material; disagreement =
 * painting content has appeared on at least one side.
 *
 * Key advantage: multi-layer frames (e.g. dark outer border → gold bevel → main
 * frame body) naturally pass the consensus check at every layer because ALL sides
 * transition between layers simultaneously. A single-side divergence (painting
 * content on one edge) immediately breaks consensus and stops the scan.
 *
 * Sample points per depth:
 *   - Top / Bottom: at 25%, 50%, 75% of width  (3 samples × 2 sides = 6)
 *   - Left / Right: at 15%, 85% of height      (2 corner-biased × 2 sides = 4)
 *   Total: 10 samples per depth.
 *   L/R use corner-biased positions to avoid sampling painting content at the
 *   image center, where the frame never reaches.
 *
 * Consensus criterion: at least minAgreeFrac of the 10 samples must be within
 * colorThreshold (RGB Euclidean distance) of the set's median color.
 *
 * A contrast guard rejects the result if the detected frame region is not
 * meaningfully different from the image interior (i.e. no real frame present).
 *
 * Phase 2 (per-side asymmetric extension) is future work: after the symmetric
 * baseline, each side could independently extend further using color continuity
 * to handle frames that are wider on one side (e.g. heavier bottom frame).
 */
async function symmetricScanPreProcessor(buffer, {
  maxCropFrac        = 0.30,
  tileSize           = 8,
  colorThreshold     = 30,   // RGB distance gate for per-sample agreement
  minAgreeFrac       = 0.70, // fraction of samples required to agree at each depth
  minPaintRun        = 2,    // consecutive non-consensus depths to declare boundary (after anchor)
  maxEntryRun        = 5,    // max consecutive failing depths before giving up on finding anchor
  baseSamples        = 5,    // min samples per edge; long edges get more (proportional to aspect)
  shiftThreshold     = 20,   // min per-sample RGB delta (depth-to-depth) to count as shifted
  minShiftFrac       = 0.50, // fraction of total samples that must shift for diversity check
  diversityThreshold = 25,   // avg RGB spread among shifted samples that signals painting boundary
} = {}) {
  const _t0 = Date.now();

  const origMeta = await sharp(buffer).metadata();
  const origW = origMeta.width, origH = origMeta.height;

  const SCALE_TARGET = 600;
  const { data, info } = await sharp(buffer)
    .resize(SCALE_TARGET, SCALE_TARGET, { fit: 'inside', withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  const scaleX = origW / width;
  const scaleY = origH / height;
  const ts = tileSize;

  function tileMeanRGB(x0, y0, x1, y1) {
    const lx0 = Math.max(0, x0), ly0 = Math.max(0, y0);
    const lx1 = Math.min(width, x1), ly1 = Math.min(height, y1);
    let sR = 0, sG = 0, sB = 0, n = 0;
    for (let y = ly0; y < ly1; y++) {
      for (let x = lx0; x < lx1; x++) {
        const off = (y * width + x) * channels;
        sR += data[off]; sG += data[off + 1]; sB += data[off + 2];
        n++;
      }
    }
    return n > 0 ? [sR / n, sG / n, sB / n] : [0, 0, 0];
  }

  function rgbDist([r1, g1, b1], [r2, g2, b2]) {
    return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2);
  }

  // P45 color by luminance: robust central estimate biased toward darker tiles.
  function medianColor(colors) {
    const sorted = [...colors].sort((a, b) =>
      (0.299 * a[0] + 0.587 * a[1] + 0.114 * a[2]) -
      (0.299 * b[0] + 0.587 * b[1] + 0.114 * b[2])
    );
    return sorted[Math.floor(sorted.length * 0.45)];
  }

  // Sample a tile at (edge, depth, posFrac).
  // depth: tile steps inward from that edge.
  // posFrac: fractional position along the edge length.
  function sampleTile(edge, depth, posFrac) {
    const d0 = depth * ts, d1 = d0 + ts;
    switch (edge) {
      case 'top': {
        const cx = Math.round(width * posFrac);
        return tileMeanRGB(cx - ts, d0, cx + ts, d1);
      }
      case 'bottom': {
        const cx = Math.round(width * posFrac);
        return tileMeanRGB(cx - ts, height - d1, cx + ts, height - d0);
      }
      case 'left': {
        const cy = Math.round(height * posFrac);
        return tileMeanRGB(d0, cy - ts, d1, cy + ts);
      }
      case 'right': {
        const cy = Math.round(height * posFrac);
        return tileMeanRGB(width - d1, cy - ts, width - d0, cy + ts);
      }
    }
  }

  // Build evenly-spaced position fracs from 0.15 to 0.85.
  // Staying ≥15% from each adjacent edge prevents T/B samples from landing inside
  // the L/R frame region (and vice versa), which would contaminate the color read.
  function makePosFracs(n) {
    if (n === 1) return [0.5];
    return Array.from({ length: n }, (_, i) => 0.15 + (i / (n - 1)) * 0.70);
  }

  // Sample density: proportional to edge length, minimum baseSamples per edge.
  // T/B positions span width; L/R positions span height.
  const tbN = Math.max(baseSamples, Math.round(baseSamples * width / height));
  const lrN = Math.max(baseSamples, Math.round(baseSamples * height / width));
  const tbPosFracs = makePosFracs(tbN);
  const lrPosFracs = makePosFracs(lrN);

  // All sample points: (edge, posFrac) pairs.
  const samplePoints = [
    ...tbPosFracs.map(f => ({ edge: 'top',    posFrac: f })),
    ...tbPosFracs.map(f => ({ edge: 'bottom', posFrac: f })),
    ...lrPosFracs.map(f => ({ edge: 'left',   posFrac: f })),
    ...lrPosFracs.map(f => ({ edge: 'right',  posFrac: f })),
  ];
  const nSamples = samplePoints.length;
  const minAgree = Math.round(nSamples * minAgreeFrac);
  const minShiftCount = Math.round(nSamples * minShiftFrac);

  const maxDepth = Math.floor(Math.min(width, height) * maxCropFrac / ts);
  let boundaryDepth = 0, highRun = 0;
  const agreeLog = [];
  const deltaLog = []; // consensus color delta depth-to-depth (for analysis)
  let prevColors = null;
  let prevMed = null;
  let stopReason = 'maxDepth';

  for (let d = 0; d < maxDepth; d++) {
    const colors = samplePoints.map(({ edge, posFrac }) => sampleTile(edge, d, posFrac));
    const med = medianColor(colors);
    const agreeing = colors.filter(c => rgbDist(c, med) <= colorThreshold).length;
    const pass = agreeing >= minAgree;
    agreeLog.push(agreeing);

    // Consensus color delta (logged but not used as primary signal; may fail for
    // multi-layer frames where all samples shift to a new uniform frame color).
    const consensusDelta = prevMed ? rgbDist(med, prevMed) : 0;
    deltaLog.push(Math.round(consensusDelta));

    // Diversity check: if many samples shifted from the previous depth AND their
    // new colors are spread out (not all landing on the same new frame color),
    // that is a strong signal we have crossed into painting content.
    if (prevColors) {
      const shiftAmounts = colors.map((c, i) => rgbDist(c, prevColors[i]));
      const shifted = colors.filter((_, i) => shiftAmounts[i] > shiftThreshold);
      if (shifted.length >= minShiftCount) {
        const shiftedMed = medianColor(shifted);
        const spread = shifted.reduce((s, c) => s + rgbDist(c, shiftedMed), 0) / shifted.length;
        if (spread > diversityThreshold && boundaryDepth > 0) {
          console.log(`[symmetric_scan] depth ${d}: diversity boundary — ${shifted.length}/${nSamples} shifted, spread=${spread.toFixed(1)}, consensusDelta=${consensusDelta.toFixed(1)}`);
          stopReason = 'diversity';
          break; // boundaryDepth stays at last passing depth
        } else if (spread > diversityThreshold) {
          console.log(`[symmetric_scan] depth ${d}: diversity spike (no anchor yet, continuing) — ${shifted.length}/${nSamples} shifted, spread=${spread.toFixed(1)}`);
        }
      }
    }

    if (pass) {
      boundaryDepth = d + 1;
      highRun = 0;
    } else {
      highRun++;
      if (boundaryDepth > 0) {
        // After anchor: minPaintRun consecutive failures = painting boundary.
        if (highRun >= minPaintRun) { stopReason = 'agreement'; break; }
      } else {
        // No anchor yet: give up if frame material never shows agreement.
        if (highRun >= maxEntryRun) { stopReason = 'entryRun'; break; }
      }
    }

    prevColors = colors;
    prevMed = med;
  }

  // Contrast guard: reject if the detected frame edge color is not meaningfully
  // different from the image interior. Catches dark-background / no-frame images
  // where all sides agree (same uniform background) but no real frame exists.
  if (boundaryDepth > 0) {
    const interiorColor = tileMeanRGB(
      Math.floor(width * 0.35), Math.floor(height * 0.35),
      Math.floor(width * 0.65), Math.floor(height * 0.65)
    );
    const edgeColors = samplePoints.map(({ edge, posFrac }) => sampleTile(edge, 0, posFrac));
    const edgeColor = medianColor(edgeColors);
    const contrastFromInterior = rgbDist(edgeColor, interiorColor);
    if (contrastFromInterior < colorThreshold * 0.6) {
      console.log(`[symmetric_scan] contrast guard: edge≈interior (dist=${contrastFromInterior.toFixed(1)}) — no frame detected`);
      boundaryDepth = 0;
    }
  }

  const cropPxV = Math.round(boundaryDepth * ts * scaleY);
  const cropPxH = Math.round(boundaryDepth * ts * scaleX);

  const _tCompute = Date.now();
  console.log(`[symmetric_scan] downsampled=${width}×${height}, tile=${ts}px, threshold=${colorThreshold}, minAgree=${minAgree}/${nSamples} (T/B:${tbN} L/R:${lrN})`);
  console.log(`[symmetric_scan] agreement  profile(0-${agreeLog.length - 1})=[${agreeLog.join(',')}]`);
  console.log(`[symmetric_scan] consensusΔ profile(0-${deltaLog.length - 1})=[${deltaLog.join(',')}]`);
  console.log(`[symmetric_scan] boundary=${boundaryDepth}t (stop=${stopReason}) → top=${cropPxV}px bot=${cropPxV}px left=${cropPxH}px right=${cropPxH}px — compute=${_tCompute - _t0}ms`);

  if (boundaryDepth === 0) return buffer;

  const extractW = origW - cropPxH * 2;
  const extractH = origH - cropPxV * 2;
  if (extractW <= 0 || extractH <= 0) return buffer;

  return sharp(buffer)
    .extract({ left: cropPxH, top: cropPxV, width: extractW, height: extractH })
    .toBuffer();
}

const PRE_PROCESSORS = {
  trim:              trimPreProcessor,
  variance_scan:     varianceScanPreProcessor,
  region_compare:    regionComparePreProcessor,
  corner_consensus:  cornerConsensusPreProcessor,
  mean_profile:      meanProfilePreProcessor,
  tile_color:        tileColorPreProcessor,
  symmetric_scan:    symmetricScanPreProcessor,
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
 * Phase 1 (automatic): strip solid-color borders (solidBorderStrip — variance scan +
 * contrast check). This runs whenever a pre-processor is configured, even 'none'.
 * Removing the solid background first lets Phase 2 algorithms see the actual frame
 * in the corners rather than featureless background pixels that confuse column-mean
 * and corner-variance sampling. Unlike Sharp Trim, solidBorderStrip does not depend
 * on the corner pixel color, so it handles JPEG-artifact-noisy dark borders correctly.
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
  const _t0 = Date.now();
  let processed = buffer;

  if (preProcess != null) {
    // Phase 1 (automatic): strip solid-color borders before frame detection.
    processed = await solidBorderStrip(processed);
    const _t1 = Date.now();

    // Phase 2 (user-selected): detect and remove decorative frames/borders.
    if (PRE_PROCESSORS[preProcess]) {
      processed = await PRE_PROCESSORS[preProcess](processed, preProcessOptions);
    }
    const _t2 = Date.now();
    console.log(`[imageProcessor timing] phase1(solidBorderStrip)=${_t1-_t0}ms phase2(${preProcess})=${_t2-_t1}ms`);
  }

  // Phase 3: fit to TV
  const { width, height } = await sharp(processed).metadata();
  const { finalW, finalH } = computeTargetDimensions(width, height, orientation);

  const _tCrop = Date.now();
  const engine = CROP_ENGINES[cropEngine] || CROP_ENGINES.sharp;
  const result = await engine(processed, width, height, finalW, finalH, cropEngineOptions);
  const _tEnd = Date.now();
  console.log(`[imageProcessor timing] phase3(${cropEngine} crop)=${_tEnd-_tCrop}ms total=${_tEnd-_t0}ms`);
  return result;
}

// ── Schema (for UI) ──────────────────────────��────────────────────────────────

const IMAGE_PROCESSING_SCHEMA = {
  preProcessors: [
    { value: 'none',             label: 'None — background strip only; no frame detection' },
    { value: 'mean_profile',     label: 'Mean Profile — detect frames using row/column mean consistency; handles textured and wood frames' },
    { value: 'corner_consensus', label: 'Corner Consensus — detect frames using four-corner sampling; handles multi-layer frames' },
    { value: 'region_compare',   label: 'Region Compare — detect frames by comparing edge strip to painting interior' },
    { value: 'tile_color',       label: 'Tile Color — detect frames using 2D tile color continuity; tracks color along frame material and stops at abrupt changes' },
    { value: 'symmetric_scan',   label: 'Symmetric Scan — detect frames by checking that all four edges agree in color at each depth; handles multi-layer frames naturally' },
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
  detectionModes: [
    { value: 'combined',  label: 'Combined (default) — luminance + color analysis' },
    { value: 'luminance', label: 'Luminance only — row/column mean brightness; no color scans' },
    { value: 'color',     label: 'Color only — chromaticity distance; no luminance scans' },
  ],
};

module.exports = {
  processWebSourceImage,
  solidBorderStrip,
  computeTargetDimensions,
  CROP_ENGINES,
  PRE_PROCESSORS,
  IMAGE_PROCESSING_SCHEMA,
};