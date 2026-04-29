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
 * Fallback for sides where Sobel finds nothing: scan for a thin strip of
 * uniformly low-variance pixels (solid black or gold border).  Stops at the
 * first high-variance row (painting content) and returns that depth.
 *
 * Guards:
 *  - maxThinDepth caps how deep we'll look (prevents confusing a large uniform
 *    background with a frame border).
 *  - minBorderDepth: requires at least this many low-variance rows before we
 *    accept the detection (filters single-row noise).
 *  - Must actually hit a high-variance row within maxThinDepth; if the
 *    uniform region extends all the way to the cap we return 0 (too ambiguous).
 */
function findThinUniformBorder(gray, width, height, side, maxThinDepth, varianceThreshold, minBorderDepth = 2) {
  let uniformCount = 0;

  for (let d = 1; d <= maxThinDepth; d++) {
    let sum = 0, sumSq = 0, total;
    if (side === 'top' || side === 'bottom') {
      const row = side === 'top' ? d : height - 1 - d;
      total = width;
      for (let x = 0; x < width; x++) { const v = gray[row * width + x]; sum += v; sumSq += v * v; }
    } else {
      const col = side === 'left' ? d : width - 1 - d;
      total = height;
      for (let y = 0; y < height; y++) { const v = gray[y * width + col]; sum += v; sumSq += v * v; }
    }
    const mean     = sum / total;
    const variance = sumSq / total - mean * mean;

    if (d <= 30) console.log(`[frame-boundary] thin ${side} d=${d}: mean=${mean.toFixed(1)} var=${variance.toFixed(0)}`);

    if (variance < varianceThreshold) {
      uniformCount++;
    } else {
      // First high-variance row — this is the painting content.
      if (uniformCount >= minBorderDepth) return d - 1;
      return 0; // variance rose immediately, no clean uniform border
    }
  }

  return 0; // never hit painting content within cap — too ambiguous to crop
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
 * @param {number} [options.thinBorderVariance=200] Variance threshold for uniform border pass
 * @param {number} [options.thinBorderMaxFrac=0.06] Max fraction of dimension for thin-border scan
 */
async function frameBoundaryPreProcessor(buffer, {
  maxCropFrac        = 0.25,
  minEdgeDensity     = 0.40,
  edgeThreshold      = 20,
  thinBorderVariance = 200,
  thinBorderMaxFrac  = 0.06,
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
    const raw = findThinUniformBorder(thinGray, thinW, thinH_dim, 'top',    thinV, thinBorderVariance);
    console.log(`[frame-boundary] thin-pass top: raw=${raw} → ${Math.round(raw/thinScale)}px orig`);
    cTop    = Math.round(raw / scaleRatio);
  }
  if (cBottom === 0 && thinGray) {
    const raw = findThinUniformBorder(thinGray, thinW, thinH_dim, 'bottom', thinV, thinBorderVariance);
    console.log(`[frame-boundary] thin-pass bottom: raw=${raw} → ${Math.round(raw/thinScale)}px orig`);
    cBottom = Math.round(raw / scaleRatio);
  }
  if (cLeft   === 0 && thinGray) {
    const raw = findThinUniformBorder(thinGray, thinW, thinH_dim, 'left',   thinH, thinBorderVariance);
    console.log(`[frame-boundary] thin-pass left: raw=${raw} → ${Math.round(raw/thinScale)}px orig`);
    cLeft   = Math.round(raw / scaleRatio);
  }
  if (cRight  === 0 && thinGray) {
    const raw = findThinUniformBorder(thinGray, thinW, thinH_dim, 'right',  thinH, thinBorderVariance);
    console.log(`[frame-boundary] thin-pass right: raw=${raw} → ${Math.round(raw/thinScale)}px orig`);
    cRight  = Math.round(raw / scaleRatio);
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
