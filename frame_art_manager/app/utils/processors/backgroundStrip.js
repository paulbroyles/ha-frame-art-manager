'use strict';

const sharp = require('sharp');

/**
 * Solid-border strip — Phase 1 of the image processing pipeline.
 *
 * Strips solid or near-solid border rows/columns from each edge using a
 * per-row/column luminance variance scan with a contrast check. Designed to
 * clear flat backgrounds (black, white, gray) and JPEG-artifact-noisy dark
 * borders before frame detection runs.
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
 * Pipeline processor wrapper: runs solidBorderStrip and updates context dimensions.
 */
async function backgroundStripProcessor(context, _options = {}) {
  const t0 = Date.now();
  const result = await solidBorderStrip(context.buffer);
  if (result !== context.buffer) {
    context.buffer = result;
    context.raw = null;
    const meta = await sharp(result).metadata();
    context.width = meta.width;
    context.height = meta.height;
  }
  context.debug.background_strip = { timing: Date.now() - t0 };
  return context;
}

module.exports = { solidBorderStrip, backgroundStripProcessor };
