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
 * options.maxCropFraction (default 0.25): hard cap per edge (safety guard).
 */
async function meanProfilePreProcessor(buffer, {
  consistencyThreshold = 35,
  contrastThreshold    = 20,
  refFraction          = 0.03,
  maxCropFraction      = 0.25,
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
  const _tRowMeans = Date.now();

  console.log(`[mean_profile] image ${width}×${height}, interiorMean=${interiorMean.toFixed(1)}, consistencyThreshold=${consistencyThreshold}, contrastThreshold=${contrastThreshold}`);

  // Scan values[] from index 0 inward. Extends while each new value is within
  // consistencyThreshold of a reference mean established from the first few edge values.
  // This handles frames with internal texture (wood grain ≈ ±20 variation) while
  // stopping at the sharper frame/painting boundary (typically ±40–80 jump).
  // Requires a minimum band size (5), a natural stopping point (runaway guard),
  // and a contrast check against interiorMean.
  function incrementalScan(values, maxN, label) {
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
    let lastGoodIdx = initN - 1, consecutiveOutliers = 0;
    let stopIdx = -1, stopDev = 0;
    for (let i = initN; i < Math.min(maxN, values.length); i++) {
      const dev = Math.abs(values[i] - refMean);
      if (dev < consistencyThreshold) {
        consecutiveOutliers = 0;
        lastGoodIdx = i;
      } else {
        consecutiveOutliers++;
        if (consecutiveOutliers >= hysteresisN) {
          stopIdx = lastGoodIdx + 1;
          stopDev = dev;
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
    const passed = contrast > contrastThreshold;
    console.log(`[mean_profile] ${label}: crop=${crop}px, refMean=${refMean.toFixed(1)}, bandMean=${bandMean.toFixed(1)}, contrast(refMean)=${contrast.toFixed(1)} (need >${contrastThreshold}), stopped at ${stopIdx} dev=${stopDev.toFixed(1)} → ${passed ? 'CROP' : 'REJECTED (low contrast)'}`);
    return passed ? crop : 0;
  }

  // Top and bottom: scan using full-width row means.
  let cropTop    = incrementalScan(rowMeans, maxRows, 'top');
  let cropBottom = incrementalScan([...rowMeans].reverse(), maxRows, 'bottom');
  const _tTB = Date.now();

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
  // Use col median (not mean) for L/R detection: robust against isolated bright grain
  // columns within a dark wood frame that inflate the mean and cause early scan termination.
  const cornerColMeans = Array.from({ length: width }, (_, x) => colMedianInBands(x, cornerBands));
  const _tColMedians = Date.now();

  // Guard: if col medians are nearly flat across all columns the bands are still
  // non-discriminating — skip left/right rather than produce false positives.
  const colMeansMin = cornerColMeans.reduce((a, v) => Math.min(a, v),  Infinity);
  const colMeansMax = cornerColMeans.reduce((a, v) => Math.max(a, v), -Infinity);
  const colMeansDiscriminating = (colMeansMax - colMeansMin) >= 5;
  console.log(`[mean_profile] col medians range=${( colMeansMax - colMeansMin).toFixed(1)} (bands top=${JSON.stringify(topInner)}, bot=${JSON.stringify(botInner)})${colMeansDiscriminating ? '' : ' → SKIPPING left/right (non-discriminating)'}`);

  let cropLeft  = colMeansDiscriminating ? incrementalScan(cornerColMeans, maxCols, 'left') : 0;
  let cropRight = colMeansDiscriminating ? incrementalScan([...cornerColMeans].reverse(), maxCols, 'right') : 0;

  // Symmetry guard: frame borders should be roughly comparable in thickness across all
  // four edges. Use the median of all four values as a reference; reject any edge whose
  // crop is more than 4× the median (catches cases where one edge runs far into the
  // painting while the others correctly detect nothing or a modest border).
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

  // Secondary inference: if T/B are both detected but L and/or R appear underdetected
  // (less than half the T/B average), re-infer using a two-step approach:
  //
  //   Step 1 (validate): confirm the T/B estimate covers actual frame material using
  //   full-height col means — painting dominates full height so frame columns reliably
  //   average darker than the painting interior.
  //
  //   Step 2 (extend): scan outward from x=estimate using restricted-band col medians.
  //   Starting from x=estimate avoids the near-black outer bevel (x=0..9, median≈1–7)
  //   that contaminates refMean when scanning from x=0. From x=estimate the refMean is
  //   established from the mid-frame wood grain zone (median≈50), which clearly differs
  //   from the painting edge (median≈87+). The scan stops at the frame/painting boundary.
  if (cropTop > 0 && cropBottom > 0) {
    const tbAvg = (cropTop + cropBottom) / 2;
    if (cropLeft < tbAvg / 2 || cropRight < tbAvg / 2) {
      const estimate = Math.round(tbAvg);
      const colMeansAll = Array.from({ length: width }, (_, x) => colMeanInBands(x, [[0, height]]));
      const revMeansAll = [...colMeansAll].reverse();
      const revMedians  = [...cornerColMeans].reverse();

      function tbBackedInfer(isLeft, detected) {
        const bandSlice = isLeft ? colMeansAll.slice(0, estimate) : revMeansAll.slice(0, estimate);
        const bandMean  = bandSlice.reduce((s, v) => s + v, 0) / estimate;
        const contrast  = Math.abs(bandMean - interiorMean);
        if (contrast <= contrastThreshold) {
          console.log(`[mean_profile] ${isLeft ? 'left' : 'right'} T/B-backed: est=${estimate}px REJECTED (contrast=${contrast.toFixed(1)} ≤ ${contrastThreshold})`);
          return detected;
        }
        // Extend outward from x=estimate using restricted-band medians.
        const extVals = (isLeft ? cornerColMeans : revMedians).slice(estimate, maxCols);
        const ext     = extVals.length >= 5 ? incrementalScan(extVals, extVals.length, `${isLeft ? 'left' : 'right'} ext`) : 0;
        const total   = estimate + ext;
        console.log(`[mean_profile] ${isLeft ? 'left' : 'right'} T/B-backed: est=${estimate}px + ext=${ext}px → ${total}px (bandMean=${bandMean.toFixed(1)}, contrast=${contrast.toFixed(1)})`);
        return total > detected ? total : detected;
      }

      if (cropLeft  < tbAvg / 2) { const v = tbBackedInfer(true,  cropLeft);  if (v > cropLeft)  { console.log(`[mean_profile] left: ${cropLeft}px → ${v}px`);   cropLeft  = v; } }
      if (cropRight < tbAvg / 2) { const v = tbBackedInfer(false, cropRight); if (v > cropRight) { console.log(`[mean_profile] right: ${cropRight}px → ${v}px`); cropRight = v; } }
    }
  }
  // Symmetric: if L/R both detected but T and/or B appear underdetected, re-infer from L/R.
  if (cropLeft > 0 && cropRight > 0) {
    const lrAvg = (cropLeft + cropRight) / 2;
    if (cropTop < lrAvg / 2 || cropBottom < lrAvg / 2) {
      const estimate = Math.round(lrAvg);
      if (cropTop < lrAvg / 2) {
        const inferred = inferEdge(estimate, n => Array.from({ length: n }, (_, y) => restrictedRowMean(y, cropLeft, cropRight)), 'top (L/R-backed)');
        if (inferred > cropTop) { console.log(`[mean_profile] top: ${cropTop}px → ${inferred}px (L/R-backed)`); cropTop = inferred; }
      }
      if (cropBottom < lrAvg / 2) {
        const inferred = inferEdge(estimate, n => Array.from({ length: n }, (_, i) => restrictedRowMean(height - 1 - i, cropLeft, cropRight)), 'bottom (L/R-backed)');
        if (inferred > cropBottom) { console.log(`[mean_profile] bottom: ${cropBottom}px → ${inferred}px (L/R-backed)`); cropBottom = inferred; }
      }
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
  solidBorderStrip,
  computeTargetDimensions,
  CROP_ENGINES,
  PRE_PROCESSORS,
  IMAGE_PROCESSING_SCHEMA,
};