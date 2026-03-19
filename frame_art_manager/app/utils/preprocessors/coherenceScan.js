'use strict';

const sharp = require('sharp');

/**
 * Coherence Scan pre-processor.
 *
 * Detects frame boundaries by building a 2D tile variance map over the image.
 * Frame material (wood, matte, metal) is spatially uniform — tiles within the
 * frame region have low luminance variance. Painting content has high variance.
 *
 * Unlike row/column projection methods (mean_profile, symmetric_scan) which
 * collapse spatial information to 1D, coherence_scan operates in 2D tile space.
 * This makes it more robust to:
 *   - Frames with slight texture or gradients (noise in individual rows is averaged
 *     away across the full tile width)
 *   - Irregular frame widths that vary across the image
 *   - Simple paintings whose rows would otherwise look frame-like in a 1D projection
 *
 * Algorithm:
 *   1. Downsample to ~600px working resolution.
 *   2. Divide into tileSize×tileSize tiles; compute luminance variance per tile.
 *   3. Classify each tile as coherent (low variance ≈ frame material) or
 *      complex (high variance ≈ painting content).
 *   4. Scan inward from each edge: extend the frame band while ≥ minCoherentFrac
 *      of tiles in that row/column are coherent.
 *   5. Corner-band restriction for L/R scanning (same as tile_color): only count
 *      tiles in the top and bottom cornerFrac of the height, to avoid painting
 *      content in the center falsely stopping the scan.
 *   6. Contrast guard: reject any edge whose detected band has insufficient
 *      luminance contrast against the image interior.
 *   7. Symmetry guard: reject outlier edges > symmetryMultiplier × median crop.
 *   8. Scale back to original coordinates and extract.
 *
 * options:
 *   tileSize           8     Tile size in working-resolution pixels.
 *   coherenceThreshold 400   Luminance variance below this = coherent tile (frame material).
 *   minCoherentFrac    0.70  Fraction of tiles in a row/column that must be coherent to
 *                            extend the frame band. 0.70 tolerates up to 30% complex tiles
 *                            in each row (handles frames with slight texture or highlights).
 *   cornerFrac         0.25  Fraction of height used for corner bands in L/R scanning.
 *   maxCropFrac        0.30  Hard cap: maximum fraction of any dimension that can be cropped.
 *   contrastThreshold  20    Min mean luminance difference between frame band and interior.
 *   symmetryMultiplier 4     Reject edges > this × median of detected crop values.
 */
async function coherenceScanPreProcessor(buffer, {
  tileSize           = 8,
  coherenceThreshold = 400,
  minCoherentFrac    = 0.70,
  cornerFrac         = 0.25,
  maxCropFrac        = 0.30,
  contrastThreshold  = 20,
  symmetryMultiplier = 4,
} = {}) {
  const t0 = Date.now();

  const origMeta = await sharp(buffer).metadata();
  const origW = origMeta.width, origH = origMeta.height;

  const SCALE_TARGET = 600;
  const { data, info } = await sharp(buffer)
    .resize(SCALE_TARGET, SCALE_TARGET, { fit: 'inside', withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width: workW, height: workH, channels } = info;
  const scaleX = origW / workW;
  const scaleY = origH / workH;
  const tDecode = Date.now();

  const effTile = Math.max(2, tileSize);
  const numTilesX = Math.floor(workW / effTile);
  const numTilesY = Math.floor(workH / effTile);

  // BT.601 luminance of a single pixel at offset `off`.
  function pixLum(off) {
    return 0.299 * data[off] + 0.587 * data[off + 1] + 0.114 * data[off + 2];
  }

  // Compute luminance variance for the tile at grid position (tx, ty).
  function tileVar(tx, ty) {
    const x0 = tx * effTile, x1 = Math.min(x0 + effTile, workW);
    const y0 = ty * effTile, y1 = Math.min(y0 + effTile, workH);
    let sum = 0, sum2 = 0, n = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const l = pixLum((y * workW + x) * channels);
        sum += l; sum2 += l * l; n++;
      }
    }
    if (n === 0) return 0;
    const mean = sum / n;
    return (sum2 / n) - mean * mean;
  }

  // Build coherence grid: coherent[ty][tx] = true when tileVar < coherenceThreshold.
  const coherent = [];
  for (let ty = 0; ty < numTilesY; ty++) {
    const row = [];
    for (let tx = 0; tx < numTilesX; tx++) {
      row.push(tileVar(tx, ty) < coherenceThreshold);
    }
    coherent.push(row);
  }
  const tVarmap = Date.now();

  // Fraction of tiles in tile-row ty that are coherent (full width).
  function rowCoherentFrac(ty) {
    if (ty < 0 || ty >= numTilesY || numTilesX === 0) return 0;
    let count = 0;
    for (let tx = 0; tx < numTilesX; tx++) if (coherent[ty][tx]) count++;
    return count / numTilesX;
  }

  // Fraction of tiles in tile-column tx that are coherent, restricted to corner bands.
  const cornerTop = Math.max(1, Math.round(numTilesY * cornerFrac));
  const cornerBot = Math.max(1, Math.round(numTilesY * cornerFrac));
  const botStart  = numTilesY - cornerBot;
  function colCoherentFrac(tx) {
    if (tx < 0 || tx >= numTilesX) return 0;
    let count = 0, total = 0;
    for (let ty = 0; ty < cornerTop; ty++) {
      if (coherent[ty][tx]) count++;
      total++;
    }
    for (let ty = Math.max(cornerTop, botStart); ty < numTilesY; ty++) {
      if (coherent[ty][tx]) count++;
      total++;
    }
    return total > 0 ? count / total : 0;
  }

  // Scan inward from an edge; advance while coherent fraction >= minCoherentFrac.
  function scanEdge(maxTiles, fracFn) {
    let depth = 0;
    for (let d = 0; d < maxTiles; d++) {
      if (fracFn(d) >= minCoherentFrac) {
        depth = d + 1;
      } else {
        break;
      }
    }
    return depth;
  }

  const maxTilesV = Math.floor(numTilesY * maxCropFrac);
  const maxTilesH = Math.floor(numTilesX * maxCropFrac);

  const topTiles    = scanEdge(maxTilesV, d => rowCoherentFrac(d));
  const bottomTiles = scanEdge(maxTilesV, d => rowCoherentFrac(numTilesY - 1 - d));
  const leftTiles   = scanEdge(maxTilesH, d => colCoherentFrac(d));
  const rightTiles  = scanEdge(maxTilesH, d => colCoherentFrac(numTilesX - 1 - d));

  // Scale back to original image coordinates and apply hard cap.
  let cropTop    = Math.min(Math.round(topTiles    * effTile * scaleY), Math.floor(origH * maxCropFrac));
  let cropBottom = Math.min(Math.round(bottomTiles * effTile * scaleY), Math.floor(origH * maxCropFrac));
  let cropLeft   = Math.min(Math.round(leftTiles   * effTile * scaleX), Math.floor(origW * maxCropFrac));
  let cropRight  = Math.min(Math.round(rightTiles  * effTile * scaleX), Math.floor(origW * maxCropFrac));

  const tScan = Date.now();

  // Mean luminance over a region of the original image, sampled from working data.
  function regionMeanLum(ox0, oy0, ox1, oy1) {
    const wx0 = Math.max(0, Math.round(ox0 / scaleX));
    const wy0 = Math.max(0, Math.round(oy0 / scaleY));
    const wx1 = Math.min(workW, Math.round(ox1 / scaleX));
    const wy1 = Math.min(workH, Math.round(oy1 / scaleY));
    let sum = 0, n = 0;
    // Sample every other pixel for speed.
    for (let y = wy0; y < wy1; y += 2) {
      for (let x = wx0; x < wx1; x += 2) {
        sum += pixLum((y * workW + x) * channels);
        n++;
      }
    }
    return n > 0 ? sum / n : 128;
  }

  // Interior mean: center 50% of the image.
  const interiorMean = regionMeanLum(origW * 0.25, origH * 0.25, origW * 0.75, origH * 0.75);

  // Contrast guard: reject edges whose band doesn't differ enough from interior.
  function guardContrast(cropPx, label, ox0, oy0, ox1, oy1) {
    if (cropPx === 0) return 0;
    const bandMean = regionMeanLum(ox0, oy0, ox1, oy1);
    const contrast = Math.abs(bandMean - interiorMean);
    if (contrast < contrastThreshold) {
      console.log(`[coherence_scan] ${label}: contrast=${contrast.toFixed(1)} < ${contrastThreshold} — rejecting`);
      return 0;
    }
    return cropPx;
  }

  cropTop    = guardContrast(cropTop,    'top',    0,              0,              origW, cropTop);
  cropBottom = guardContrast(cropBottom, 'bottom', 0,              origH - cropBottom, origW, origH);
  cropLeft   = guardContrast(cropLeft,   'left',   0,              0,              cropLeft,  origH);
  cropRight  = guardContrast(cropRight,  'right',  origW - cropRight, 0,           origW, origH);

  // Symmetry guard: reject any crop value > symmetryMultiplier × median.
  const nonzero = [cropTop, cropBottom, cropLeft, cropRight].filter(v => v > 0);
  if (nonzero.length > 1) {
    const sorted = [...nonzero].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    if (median > 0) {
      const limit = median * symmetryMultiplier;
      const guard = (v, label) => {
        if (v > limit) {
          console.log(`[coherence_scan] ${label}: symmetry guard ${v} > ${limit.toFixed(0)} — reset`);
          return 0;
        }
        return v;
      };
      cropTop    = guard(cropTop,    'top');
      cropBottom = guard(cropBottom, 'bottom');
      cropLeft   = guard(cropLeft,   'left');
      cropRight  = guard(cropRight,  'right');
    }
  }

  console.log(`[coherence_scan] work=${workW}×${workH} tiles=${numTilesX}×${numTilesY} ` +
    `coherenceThreshold=${coherenceThreshold} minCoherentFrac=${minCoherentFrac}`);
  console.log(`[coherence_scan] tileScan: top=${topTiles}t bot=${bottomTiles}t ` +
    `left=${leftTiles}t right=${rightTiles}t`);
  console.log(`[coherence_scan] crop: top=${cropTop}px bot=${cropBottom}px ` +
    `left=${cropLeft}px right=${cropRight}px interiorMean=${interiorMean.toFixed(1)}`);

  if (cropTop === 0 && cropBottom === 0 && cropLeft === 0 && cropRight === 0) return buffer;

  const extractW = origW - cropLeft - cropRight;
  const extractH = origH - cropTop  - cropBottom;
  if (extractW <= 0 || extractH <= 0) return buffer;

  const result = await sharp(buffer)
    .extract({ left: cropLeft, top: cropTop, width: extractW, height: extractH })
    .toBuffer();

  const tEnd = Date.now();
  console.log(`[coherence_scan timing] decode=${tDecode-t0}ms varmap=${tVarmap-tDecode}ms ` +
    `scan=${tScan-tVarmap}ms encode=${tEnd-tScan}ms total=${tEnd-t0}ms`);

  return result;
}

module.exports = { coherenceScanPreProcessor };
