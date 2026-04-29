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
 * LEFT/RIGHT thin border fallback: per-row local-window scan.
 *
 * Full-column variance mixes mat/frame/painting content at different heights,
 * making it useless for vertical borders.  Instead, sample SAMPLE_ROWS
 * horizontal positions across the image height.  At each sample row, scan
 * inward using a LOCAL 5-pixel horizontal window; find the last depth within
 * maxThinDepth that has low local variance (= frame material).  Take the 25th
 * percentile across sample rows to get a conservative estimate.
 */
function findThinUniformBorderVert(gray, width, height, side, maxThinDepth, localVarThreshold, sampleRows = 20) {
  const depths = [];

  for (let i = 0; i < sampleRows; i++) {
    const y = Math.floor((i + 0.5) * height / sampleRows);
    let lastFrameD = 0;
    let inContiguous = true; // must be a contiguous run from d=1

    for (let d = 1; d <= maxThinDepth && inContiguous; d++) {
      // 5-pixel horizontal window centred at depth d for this row
      let sum = 0, sumSq = 0, count = 0;
      for (let k = -2; k <= 2; k++) {
        const col = side === 'left' ? d + k : width - 1 - d - k;
        if (col < 0 || col >= width) continue;
        const v = gray[y * width + col];
        sum += v; sumSq += v * v; count++;
      }
      const mean     = sum / count;
      const localVar = sumSq / count - mean * mean;

      if (localVar < localVarThreshold) {
        lastFrameD = d;
      } else {
        inContiguous = false; // first non-frame depth ends the contiguous run
      }
    }

    if (lastFrameD >= 2) depths.push(lastFrameD);
  }

  if (depths.length < sampleRows * 0.4) return 0; // too few rows detected anything
  depths.sort((a, b) => a - b);
  return depths[Math.floor(depths.length * 0.25)]; // 25th percentile = conservative
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
    const raw = findThinUniformBorderHoriz(thinGray, thinW, thinH_dim, 'top',    thinV, thinBorderVariance);
    cTop    = Math.round(raw / scaleRatio);
  }
  if (cBottom === 0 && thinGray) {
    const raw = findThinUniformBorderHoriz(thinGray, thinW, thinH_dim, 'bottom', thinV, thinBorderVariance);
    cBottom = Math.round(raw / scaleRatio);
  }
  if (cLeft   === 0 && thinGray) {
    const raw = findThinUniformBorderVert(thinGray, thinW, thinH_dim, 'left',   thinH, thinBorderVariance);
    cLeft   = Math.round(raw / scaleRatio);
  }
  if (cRight  === 0 && thinGray) {
    const raw = findThinUniformBorderVert(thinGray, thinW, thinH_dim, 'right',  thinH, thinBorderVariance);
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
