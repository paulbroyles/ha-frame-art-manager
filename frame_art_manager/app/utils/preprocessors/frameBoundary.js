'use strict';

const sharp = require('sharp');

// Downscale long side to this for edge analysis (speed vs. accuracy trade-off).
const ANALYSIS_LONG_SIDE = 600;

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
 * Scan inward from one image edge looking for the innermost row/column
 * where the fraction of pixels with edge magnitude ≥ threshold exceeds minDensity.
 *
 * The innermost such row/column is the inner boundary of the picture frame.
 * Returns the number of pixels to crop from that side (0 = no frame found).
 */
function findInnerEdge(edges, width, height, side, maxDepth, minDensity, threshold) {
  let lastDense = 0;

  for (let d = 1; d <= maxDepth; d++) {
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

    if (above / total >= minDensity) lastDense = d;
  }

  return lastDense;
}

/**
 * Frame boundary pre-processor.
 *
 * Detects the inner edge of a picture frame using Sobel edge density analysis.
 * The frame-to-canvas boundary produces a nearly continuous horizontal/vertical
 * line of strong edges spanning the full image width or height. Scans inward
 * from each edge within maxCropFrac and finds the innermost such dense-edge line.
 *
 * Works best on: ornate gilt frames, simple wooden frames, multi-profile frames.
 * Tuning: increase minEdgeDensity (0.5+) to avoid false positives on paintings
 * with strong compositional lines near the border.
 *
 * @param {Buffer} buffer
 * @param {object} options
 * @param {number} [options.maxCropFrac=0.25]   Max fraction of each dimension to crop
 * @param {number} [options.minEdgeDensity=0.40] Min fraction of row/col pixels above threshold
 * @param {number} [options.edgeThreshold=20]    Sobel magnitude threshold (post-blur)
 */
async function frameBoundaryPreProcessor(buffer, {
  maxCropFrac = 0.25,
  minEdgeDensity = 0.40,
  edgeThreshold = 20,
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

  const cTop    = findInnerEdge(edges, anaW, anaH, 'top',    maxV, minEdgeDensity, edgeThreshold);
  const cBottom = findInnerEdge(edges, anaW, anaH, 'bottom', maxV, minEdgeDensity, edgeThreshold);
  const cLeft   = findInnerEdge(edges, anaW, anaH, 'left',   maxH, minEdgeDensity, edgeThreshold);
  const cRight  = findInnerEdge(edges, anaW, anaH, 'right',  maxH, minEdgeDensity, edgeThreshold);

  if (cTop === 0 && cBottom === 0 && cLeft === 0 && cRight === 0) return buffer;

  const t = Math.round(cTop    / scale);
  const b = Math.round(cBottom / scale);
  const l = Math.round(cLeft   / scale);
  const r = Math.round(cRight  / scale);

  const newW = origW - l - r;
  const newH = origH - t - b;
  if (newW < 64 || newH < 64) return buffer;

  console.log(`[frame-boundary] crop t=${t} b=${b} l=${l} r=${r} (density≥${minEdgeDensity}, thresh=${edgeThreshold})`);
  return sharp(buffer)
    .extract({ left: l, top: t, width: newW, height: newH })
    .toBuffer();
}

module.exports = { frameBoundaryPreProcessor };
