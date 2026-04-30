'use strict';

const sharp = require('sharp');

// Downscale long side to this for Sobel edge analysis (speed vs. accuracy trade-off).
const ANALYSIS_LONG_SIDE = 600;
// Higher resolution for the thin uniform border pass — needs more pixels to
// distinguish a 20–80px border that Sobel loses after blur + downscale.
const THIN_ANALYSIS_LONG_SIDE = 1500;

/**
 * Compute per-pixel Sobel edge magnitude on a grayscale buffer.
 * Returns a Float32Array of magnitudes (0..~1440) same size as input.
 */
function computeSobel(gray, width, height) {
  const edges = new Float32Array(width * height);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const g = (r, c) => gray[r * width + c];
      const sx =
        -g(y - 1, x - 1) + g(y - 1, x + 1)
        - 2 * g(y, x - 1) + 2 * g(y, x + 1)
        - g(y + 1, x - 1) + g(y + 1, x + 1);
      const sy =
        -g(y - 1, x - 1) - 2 * g(y - 1, x) - g(y - 1, x + 1)
        + g(y + 1, x - 1) + 2 * g(y + 1, x) + g(y + 1, x + 1);
      edges[y * width + x] = Math.sqrt(sx * sx + sy * sy);
    }
  }
  return edges;
}

/**
 * Scan inward from one image edge looking for the frame-to-canvas boundary.
 *
 * A valid boundary is a dense-edge row/column (≥ minDensity fraction of pixels
 * above threshold) that is immediately followed by sparse rows (< sparseDensity
 * fraction for the next peekRows rows).  This distinguishes the innermost frame
 * edge from ornate-frame interior lines that have dense edges throughout.
 *
 * Returns the number of pixels to crop from that side (0 = no frame found).
 */
function findInnerEdge(
  edges, width, height, side, maxDepth, minDensity, threshold,
  peekRows = 4, sparseDensity = 0.18,
) {
  // Precompute row/column density for maxDepth + peekRows rows.
  const scanLimit = Math.min(maxDepth + peekRows, side === 'top' || side === 'bottom' ? height - 1 : width - 1);
  const densities = new Float32Array(scanLimit + 1);

  for (let d = 1; d <= scanLimit; d++) {
    let above = 0;
    let total;
    if (side === 'top' || side === 'bottom') {
      const row = side === 'top' ? d : height - 1 - d;
      total = width;
      for (let x = 0; x < width; x++) {
        if (edges[row * width + x] >= threshold) above++;
      }
    } else {
      const col = side === 'left' ? d : width - 1 - d;
      total = height;
      for (let y = 0; y < height; y++) {
        if (edges[y * width + col] >= threshold) above++;
      }
    }
    densities[d] = above / total;
  }

  // Accept candidate at depth d only if it is dense AND the next peekRows are sparse.
  // Keep the innermost (largest d) such candidate.
  let lastValidEdge = 0;
  for (let d = 1; d <= maxDepth; d++) {
    if (densities[d] < minDensity) continue;
    let allSparse = true;
    for (let p = 1; p <= peekRows && d + p <= scanLimit; p++) {
      if (densities[d + p] >= sparseDensity) { allSparse = false; break; }
    }
    if (allSparse) lastValidEdge = d;
  }

  return lastValidEdge;
}

/**
 * Sample mean and variance over a depth range along the middle 60% of a side.
 * Using the central band avoids corner effects and vertical lighting gradients.
 * Using a depth range (rather than a single row/column) gives a more stable estimate
 * of the frame material color and avoids painting-adjacent fringe pixels.
 *
 * @param {Uint8Array} thinGray
 * @param {number} thinW
 * @param {number} thinH
 * @param {'top'|'bottom'|'left'|'right'} side
 * @param {number} fromDepth  first depth to sample (≥ 1)
 * @param {number} toDepth    last depth to sample (inclusive)
 */
function sampleBandStats(thinGray, thinW, thinH, side, fromDepth, toDepth) {
  const maxD = (side === 'top' || side === 'bottom') ? thinH - 2 : thinW - 2;
  const d0 = Math.max(1, fromDepth);
  const d1 = Math.min(toDepth, maxD);
  if (d0 > d1) return { mean: 0, variance: 0 };

  const samples = [];
  for (let d = d0; d <= d1; d++) {
    if (side === 'top' || side === 'bottom') {
      const row = side === 'top' ? d : thinH - 1 - d;
      const x0 = Math.floor(thinW * 0.20);
      const x1 = Math.ceil(thinW * 0.80);
      for (let x = x0; x < x1; x++) samples.push(thinGray[row * thinW + x]);
    } else {
      const col = side === 'left' ? d : thinW - 1 - d;
      const y0 = Math.floor(thinH * 0.20);
      const y1 = Math.ceil(thinH * 0.80);
      for (let y = y0; y < y1; y++) samples.push(thinGray[y * thinW + col]);
    }
  }

  const n = samples.length;
  if (n === 0) return { mean: 0, variance: 0 };
  const mean = samples.reduce((a, b) => a + b, 0) / n;
  const variance = samples.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  return { mean, variance };
}

/**
 * TOP/BOTTOM thin border fallback: full-row variance scan.
 *
 * Works because each row at a given depth is homogeneous content (all mat,
 * all frame, or all painting).  Stops at the first high-variance row and
 * returns the depth of the last low-variance (frame material) row before it.
 */
function findThinUniformBorderHoriz(gray, width, height, side, maxThinDepth, varianceThreshold, minBorderDepth = 2) {
  let uniformCount = 0;
  for (let d = 1; d <= maxThinDepth; d++) {
    const row = side === 'top' ? d : height - 1 - d;
    let sum = 0, sumSq = 0;
    for (let x = 0; x < width; x++) { const v = gray[row * width + x]; sum += v; sumSq += v * v; }
    const mean     = sum / width;
    const variance = sumSq / width - mean * mean;
    if (variance < varianceThreshold) {
      uniformCount++;
    } else {
      if (uniformCount >= minBorderDepth) return d - 1;
      return 0;
    }
  }
  return 0;
}

/**
 * LEFT/RIGHT thin border fallback: corner-band mean consistency scan.
 *
 * Full-column variance fails for vertical borders because museum photo lighting
 * gradients along the column height inflate variance even for uniform frame
 * material.  Instead, sample only the TOP and BOTTOM 20% of each column
 * (corner bands).  These bands:
 *  - Are all frame material when a border exists
 *  - Have a relatively stable mean within a single column (short vertical span)
 *  - Allow a direct interior reference comparison at depth ≥ maxThinDepth + 15
 *
 * Scans inward while each column's corner-band mean stays within
 * `consistencyThreshold` of the initial edge reference.  The first column that
 * deviates signals the frame-to-canvas boundary.  A contrast guard rejects
 * images where the edge material is indistinguishable from the interior
 * (painting extends to the edge, no real border).
 */
function findThinUniformBorderVert(gray, width, height, side, maxThinDepth, consistencyThreshold, minBorderDepth = 2) {
  const bandH = Math.max(4, Math.floor(height * 0.20));

  function cornerMean(d) {
    const col = side === 'left' ? d : width - 1 - d;
    let sum = 0, count = 0;
    for (let y = 0; y < bandH; y++) {
      sum += gray[y * width + col]; count++;
    }
    for (let y = height - bandH; y < height; y++) {
      sum += gray[y * width + col]; count++;
    }
    return sum / count;
  }

  // Establish edge reference from the outermost two columns.
  const edgeRef = (cornerMean(1) + cornerMean(2)) / 2;

  // Contrast guard: only proceed if edge is noticeably different from interior.
  const interiorDepth = Math.min(maxThinDepth + 15, Math.floor(width * 0.12));
  if (Math.abs(edgeRef - cornerMean(interiorDepth)) < 15) return 0;

  let uniformCount = 0;
  for (let d = 1; d <= maxThinDepth; d++) {
    if (Math.abs(cornerMean(d) - edgeRef) < consistencyThreshold) {
      uniformCount++;
    } else {
      if (uniformCount >= minBorderDepth) return d - 1;
      return 0;
    }
  }
  return 0;
}

/**
 * Frame boundary pre-processor.
 *
 * Two-pass detection:
 *
 * Pass 1 (Sobel): finds the innermost row/column with high edge density followed
 * by sparse interior — the characteristic signature of a frame-to-canvas boundary.
 * Works well for ornate, multi-profile, and wooden frames.
 *
 * Pass 2 (thin uniform border): fallback per-side for solid-color borders
 * (thin black, gold, or white bands) that are too thin to survive downscale+blur.
 * Only runs on sides where Sobel found nothing. Scans for a uniformly low-variance
 * strip within a tight depth cap and stops at the first high-variance painting row.
 *
 * @param {Buffer} buffer
 * @param {object} options
 * @param {number} [options.maxCropFrac=0.25]       Max fraction of dimension for Sobel scan
 * @param {number} [options.minEdgeDensity=0.40]    Sobel: min fraction of pixels above threshold
 * @param {number} [options.edgeThreshold=20]       Sobel magnitude threshold (post-blur)
 * @param {number}  [options.thinBorderVariance=200]    Row-variance threshold for top/bottom thin-border pass
 * @param {number}  [options.thinBorderConsistency=40]  Corner-band mean consistency threshold for left/right pass (max deviation from edge reference; ~35 for mean_profile, ~40 here)
 * @param {number}  [options.thinBorderMaxFrac=0.06]    Max fraction of dimension for thin-border scan
 * @param {boolean} [options.crossSideValidation=true]  When T/B detect a border but L/R return 0 (or vice versa),
 *                                                       test whether the missing sides have similar border material
 *                                                       at the same depth. If color matches and material is uniform,
 *                                                       infer that depth for the missing side.
 * @param {number}  [options.crossMeanTolerance=30]     Max luminance difference (0–255) between reference and
 *                                                       candidate side for cross-side inference to fire
 * @param {number}  [options.crossVarMax=600]           Max pixel variance in candidate side's central band;
 *                                                       high variance means painting content, not frame material
 */
async function frameBoundaryPreProcessor(buffer, {
  maxCropFrac           = 0.25,
  minEdgeDensity        = 0.40,
  edgeThreshold         = 20,
  thinBorderVariance    = 200,
  thinBorderConsistency = 40,
  thinBorderMaxFrac     = 0.06,
  crossSideValidation   = true,
  crossMeanTolerance    = 45,
  crossVarMax           = 800,
} = {}) {
  const meta = await sharp(buffer).metadata();
  const { width: origW, height: origH } = meta;

  const scale = Math.min(1.0, ANALYSIS_LONG_SIDE / Math.max(origW, origH));
  const anaW  = Math.max(2, Math.round(origW * scale));
  const anaH  = Math.max(2, Math.round(origH * scale));

  // Blur before Sobel to suppress texture noise while preserving hard frame edges.
  const gray = await sharp(buffer)
    .resize(anaW, anaH, { fit: 'fill', kernel: 'lanczos3' })
    .greyscale()
    .blur(1.5)
    .raw()
    .toBuffer();

  const edges = computeSobel(gray, anaW, anaH);

  const maxV = Math.floor(anaH * maxCropFrac);
  const maxH = Math.floor(anaW * maxCropFrac);

  // Pass 1: Sobel edge-density scan.
  let cTop    = findInnerEdge(edges, anaW, anaH, 'top',    maxV, minEdgeDensity, edgeThreshold);
  let cBottom = findInnerEdge(edges, anaW, anaH, 'bottom', maxV, minEdgeDensity, edgeThreshold);
  let cLeft   = findInnerEdge(edges, anaW, anaH, 'left',   maxH, minEdgeDensity, edgeThreshold);
  let cRight  = findInnerEdge(edges, anaW, anaH, 'right',  maxH, minEdgeDensity, edgeThreshold);

  // Pass 2: thin uniform border fallback on sides Sobel missed.
  // Uses a separate higher-res unblurred buffer so thin borders (20–80px original)
  // aren't averaged away before the variance calculation.
  const thinScale = Math.min(1.0, THIN_ANALYSIS_LONG_SIDE / Math.max(origW, origH));
  const thinW     = Math.max(2, Math.round(origW * thinScale));
  const thinH_dim = Math.max(2, Math.round(origH * thinScale));

  const needsThinPass = cTop === 0 || cBottom === 0 || cLeft === 0 || cRight === 0;
  let thinGray = null;
  if (needsThinPass) {
    thinGray = await sharp(buffer)
      .resize(thinW, thinH_dim, { fit: 'fill', kernel: 'lanczos3' })
      .greyscale()
      .raw()
      .toBuffer();
  }

  const thinV = Math.min(Math.floor(thinH_dim * thinBorderMaxFrac), 50);
  const thinH = Math.min(Math.floor(thinW     * thinBorderMaxFrac), 50);

  const scaleRatio = thinScale / scale; // convert thin-buffer coords → Sobel-buffer coords

  if (cTop    === 0 && thinGray) {
    const raw = findThinUniformBorderHoriz(thinGray, thinW, thinH_dim, 'top',    thinV, thinBorderVariance);
    cTop    = Math.round(raw / scaleRatio);
  }
  if (cBottom === 0 && thinGray) {
    const raw = findThinUniformBorderHoriz(thinGray, thinW, thinH_dim, 'bottom', thinV, thinBorderVariance);
    cBottom = Math.round(raw / scaleRatio);
  }
  if (cLeft   === 0 && thinGray) {
    const raw = findThinUniformBorderVert(thinGray, thinW, thinH_dim, 'left',   thinH, thinBorderConsistency);
    cLeft   = Math.round(raw / scaleRatio);
  }
  if (cRight  === 0 && thinGray) {
    const raw = findThinUniformBorderVert(thinGray, thinW, thinH_dim, 'right',  thinH, thinBorderConsistency);
    cRight  = Math.round(raw / scaleRatio);
  }

  // Pass 3: cross-side validation.
  // For each undetected side, pick the best reference (prefer opposite, fall back to
  // any detected side) and test whether the candidate has similar border material at
  // the same depth. We iterate until no new inferences are possible.
  //
  // The reference variance guard is the key safety check: if the reference side's
  // material is itself high-variance (multi-layer frame), we skip inference and let
  // the recursive pipeline strip layers one at a time. Cross-side only fires when the
  // reference is confirmed uniform (single-layer), where the depth transfer is safe.
  //
  // Sampling range: depth 1..thinDepth/2. Wide enough to characterize variance
  // (distinguish single- vs multi-layer), shallow enough to avoid painting bleed.
  if (crossSideValidation && thinGray) {
    const SIDES    = ['top', 'bottom', 'left', 'right'];
    const OPPOSITE = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };
    const cByName   = { top: () => cTop, bottom: () => cBottom, left: () => cLeft, right: () => cRight };
    const setByName = { top: v => { cTop = v; }, bottom: v => { cBottom = v; },
                        left: v => { cLeft = v; }, right:  v => { cRight  = v; } };

    let changed = true;
    while (changed) {
      changed = false;
      for (const miss of SIDES) {
        if (cByName[miss]() > 0) continue;

        const detected = SIDES.filter(s => cByName[s]() > 0);
        if (detected.length === 0) break;

        const opp           = OPPOSITE[miss];
        const refSide       = (cByName[opp]() > 0) ? opp : detected[0];
        const refSobelDepth = cByName[refSide]();
        const thinDepth     = Math.max(2, Math.round(refSobelDepth * scaleRatio));
        const outerTo       = Math.max(1, Math.round(thinDepth / 2));

        const refStats = sampleBandStats(thinGray, thinW, thinH_dim, refSide, 1, outerTo);

        // Guard: skip if reference is multi-layer (high variance). Let recursion
        // strip layers until a uniform single-layer reference is exposed.
        if (refStats.variance > crossVarMax) {
          console.log(`[frame-boundary] cross-side: ${miss} skipped — ref ${refSide} var=${refStats.variance.toFixed(0)} (multi-layer, defer to recursion)`);
          continue;
        }

        const cand = sampleBandStats(thinGray, thinW, thinH_dim, miss, 1, outerTo);

        if (cand.variance < crossVarMax && Math.abs(cand.mean - refStats.mean) <= crossMeanTolerance) {
          setByName[miss](Math.round(thinDepth / scaleRatio));
          console.log(`[frame-boundary] cross-side: inferred ${miss}=${cByName[miss]()} from ${refSide} (Δmean=${Math.abs(cand.mean - refStats.mean).toFixed(1)}, var=${cand.variance.toFixed(0)})`);
          changed = true;
        } else {
          console.log(`[frame-boundary] cross-side: ${miss} rejected (Δmean=${Math.abs(cand.mean - refStats.mean).toFixed(1)}, var=${cand.variance.toFixed(0)}, refMean=${refStats.mean.toFixed(1)})`);
        }
      }
    }
  }

  if (cTop === 0 && cBottom === 0 && cLeft === 0 && cRight === 0) return buffer;

  const t = Math.round(cTop    / scale);
  const b = Math.round(cBottom / scale);
  const l = Math.round(cLeft   / scale);
  const r = Math.round(cRight  / scale);

  const newW = origW - l - r;
  const newH = origH - t - b;
  if (newW < 64 || newH < 64) return buffer;

  console.log(`[frame-boundary] crop t=${t} b=${b} l=${l} r=${r}`);
  return sharp(buffer)
    .extract({ left: l, top: t, width: newW, height: newH })
    .toBuffer();
}

module.exports = { frameBoundaryPreProcessor };
