'use strict';

const sharp = require('sharp');

/**
 * Coherence Crop processor.
 *
 * Finds the most visually complex region of the image and centers the target
 * crop there. Frame material is naturally excluded — uniform, low-variance tiles
 * (wood, matte, metal) contribute near-zero weight to the calculation, while
 * complex painting content dominates. No frame boundary detection is performed.
 *
 * The key insight: instead of asking "where does the frame end?", ask "where is
 * the interesting content?". These are the same question answered differently,
 * but the second framing is more robust — it degrades gracefully when frame
 * detection would fail (ornate frames, irregular shapes, textured mattes) and
 * produces sensible output on frameless images too.
 *
 * Algorithm:
 *   1. Downsample to ~600px working resolution.
 *   2. Divide into tileSize×tileSize tiles; compute luminance variance per tile.
 *   3. Compute the variance-weighted centroid of the tile grid.
 *      Weight = sqrt(variance) per tile — sqrt compresses extreme outliers
 *      (a single very bright spot doesn't dominate) while still pulling strongly
 *      toward complex painting content over uniform frame material.
 *   4. Scale centroid to original image coordinates.
 *   5. Place the target crop rectangle (targetW × targetH) centered at the
 *      centroid, clamped to image bounds.
 *   6. Extract and resize to target dimensions.
 *
 * The output is a single extract operation on the original full-resolution image —
 * no separate frame detection pass, no boundary coordinates, no thresholds to tune.
 *
 * options:
 *   tileSize  8           Tile size in working-resolution pixels. Smaller tiles
 *                         give finer centroid resolution; larger tiles are faster
 *                         and more noise-resistant.
 *   strategy  'attention' Sharp resize position for the final output step.
 */
async function coherenceCropProcessor(context, {
  tileSize = 8,
  strategy = 'attention',
} = {}) {
  const t0 = Date.now();

  const { targetW, targetH } = context;
  const origW = context.width;
  const origH = context.height;

  // Step 1: downsample to working resolution.
  const SCALE_TARGET = 600;
  const { data, info } = await sharp(context.buffer)
    .resize(SCALE_TARGET, SCALE_TARGET, { fit: 'inside', withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width: workW, height: workH, channels } = info;
  const scaleX = origW / workW;
  const scaleY = origH / workH;
  const tDecode = Date.now();

  const effTile  = Math.max(2, tileSize);
  const numTilesX = Math.floor(workW / effTile);
  const numTilesY = Math.floor(workH / effTile);

  // BT.601 luminance of a pixel at byte offset `off`.
  function pixLum(off) {
    return 0.299 * data[off] + 0.587 * data[off + 1] + 0.114 * data[off + 2];
  }

  // Luminance variance of a tile at grid position (tx, ty).
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

  // Step 2+3: variance-weighted centroid.
  //
  // Weight per tile = sqrt(variance). sqrt compresses extreme values — a single
  // very sharp edge or artifact won't dominate — while still pulling strongly
  // toward complex painting content (var ~200–2000) over uniform frame material
  // (var ~0–50). No threshold, no classification: the center of mass naturally
  // falls in the painting region.
  let totalW = 0, cx = 0, cy = 0;
  for (let ty = 0; ty < numTilesY; ty++) {
    for (let tx = 0; tx < numTilesX; tx++) {
      const w = Math.sqrt(tileVar(tx, ty));
      totalW += w;
      cx += (tx + 0.5) * w;  // tile center coordinates
      cy += (ty + 0.5) * w;
    }
  }
  if (totalW > 0) { cx /= totalW; cy /= totalW; }
  else { cx = numTilesX / 2; cy = numTilesY / 2; }  // fallback: geometric center

  const tCentroid = Date.now();

  // Step 4: scale centroid from tile-space to original image coordinates.
  const origCx = Math.round(cx * effTile * scaleX);
  const origCy = Math.round(cy * effTile * scaleY);

  // Step 5: place target rectangle centered at centroid, clamped to image bounds.
  const extractLeft = Math.max(0, Math.min(origW - targetW, Math.round(origCx - targetW / 2)));
  const extractTop  = Math.max(0, Math.min(origH - targetH, Math.round(origCy - targetH / 2)));
  const extractW    = Math.min(targetW, origW - extractLeft);
  const extractH    = Math.min(targetH, origH - extractTop);

  // Centroid offset from geometric center — indicates how far the crop was pulled
  // toward the painting. Zero = symmetric content; nonzero = asymmetric frame.
  const centerOffsetX = origCx - Math.round(origW / 2);
  const centerOffsetY = origCy - Math.round(origH / 2);

  console.log(
    `[coherence_crop] work=${workW}×${workH} tiles=${numTilesX}×${numTilesY}` +
    ` centroid=(${cx.toFixed(1)}t,${cy.toFixed(1)}t) → orig(${origCx},${origCy})` +
    ` offset from center=(${centerOffsetX > 0 ? '+' : ''}${centerOffsetX},${centerOffsetY > 0 ? '+' : ''}${centerOffsetY})` +
    ` → extract(left=${extractLeft},top=${extractTop} ${extractW}×${extractH}) → ${targetW}×${targetH}`
  );

  // Step 6: extract and resize to target.
  let result;
  if (extractLeft === 0 && extractTop === 0 && extractW === origW && extractH === origH) {
    result = await sharp(context.buffer)
      .resize(targetW, targetH, { fit: 'cover', position: strategy })
      .toBuffer();
  } else {
    result = await sharp(context.buffer)
      .extract({ left: extractLeft, top: extractTop, width: extractW, height: extractH })
      .resize(targetW, targetH, { fit: 'cover', position: strategy })
      .toBuffer();
  }
  const tEnd = Date.now();

  context.buffer = result;
  context.raw    = null;
  context.width  = targetW;
  context.height = targetH;

  context.debug.coherence_crop = {
    timing:   { total: tEnd - t0, decode: tDecode - t0, centroid: tCentroid - tDecode, encode: tEnd - tCentroid },
    centroid: { tileX: cx, tileY: cy, origX: origCx, origY: origCy, offsetX: centerOffsetX, offsetY: centerOffsetY },
    extract:  { left: extractLeft, top: extractTop, width: extractW, height: extractH },
    strategy,
  };

  console.log(`[coherence_crop timing] decode=${tDecode-t0}ms centroid=${tCentroid-tDecode}ms encode=${tEnd-tCentroid}ms total=${tEnd-t0}ms`);
  return context;
}

module.exports = { coherenceCropProcessor };
