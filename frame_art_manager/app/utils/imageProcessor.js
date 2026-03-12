'use strict';

const sharp = require('sharp');
const { PRE_PROCESSORS } = require('./preprocessors');
const { CROP_ENGINES } = require('./cropEngines');

// ── Target dimensions ─────────────────────────────────────────────────────────

const LANDSCAPE_TARGET = { w: 3840, h: 2160 };
const PORTRAIT_TARGET  = { w: 2160, h: 3840 };

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

// ── Schema (for UI) ──────────────────────────────────────────────────────────

const IMAGE_PROCESSING_SCHEMA = {
  preProcessors: [
    { value: 'none',             label: 'None — background strip only; no frame detection' },
    { value: 'mean_profile',     label: 'Mean Profile — detect frames using row/column mean consistency; handles textured and wood frames' },
    { value: 'corner_consensus', label: 'Corner Consensus — detect frames using four-corner sampling; handles multi-layer frames' },
    { value: 'region_compare',   label: 'Region Compare — detect frames by comparing edge strip to painting interior' },
    { value: 'tile_color',       label: 'Tile Color — detect frames using 2D tile color continuity; tracks color along frame material and stops at abrupt changes' },
    { value: 'symmetric_scan',   label: 'Symmetric Scan — detect frames by checking that all four edges agree in color at each depth; handles multi-layer frames naturally' },
    { value: 'adaptive_scan',    label: 'Adaptive Scan — symmetric scan with automatic fallback to a second pre-processor when no confident crop is found' },
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