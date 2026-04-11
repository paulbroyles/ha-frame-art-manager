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
 *   tileSize       8           Tile size in working-resolution pixels. Smaller tiles
 *                              give finer centroid resolution; larger tiles are faster
 *                              and more noise-resistant.
 *   strategy       'attention' Sharp resize position for the final output step.
 *   borderWeight   0.2         Weight multiplier (0–1) for tiles inside the border
 *                              band. Lower values suppress frame material attracting
 *                              the centroid. 1.0 disables border downweighting.
 *   borderBandFrac 0.12        Width of the downweighted border band, as a fraction
 *                              of the working-resolution image dimension per side.
 *   attentionWindow 1.0        Extract a region this many times larger than the
 *                              target, then let Sharp's attention strategy find the
 *                              most salient sub-region within it. Values > 1.0 give
 *                              Sharp room to locate faces, subjects, and focal points
 *                              that coherence (variance-only) may miss. Clamped so
 *                              the window never exceeds the full image.
 */
async function coherenceCropProcessor(context, {
  tileSize = 8,
  strategy = 'attention',
  borderWeight = 0.2,
  borderBandFrac = 0.12,
  attentionWindow = 1.0,
  minCoverageFrac = 0.25,
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

  // Step 2+3: variance-weighted centroid, with optional border downweighting.
  //
  // Weight per tile = sqrt(variance) × borderFactor.
  //
  // sqrt(variance) compresses extreme values — a single very sharp edge or
  // artifact won't dominate — while still pulling strongly toward complex
  // painting content (var ~200–2000) over uniform frame material (var ~0–50).
  //
  // borderFactor: tiles within `borderBandFrac` of any edge get their weight
  // multiplied by `borderWeight` (default 0.2). This suppresses frame material
  // (wood, matte, gilding) that sits at the perimeter from attracting the
  // centroid, without needing explicit frame boundary detection. The multiplier
  // ramps linearly from borderWeight at the outermost tile row/column to 1.0
  // at the inner edge of the border band.
  const borderBandX = Math.max(1, Math.round(numTilesX * borderBandFrac));
  const borderBandY = Math.max(1, Math.round(numTilesY * borderBandFrac));
  const bw = Math.min(1, Math.max(0, borderWeight));

  function borderFactor(tx, ty) {
    if (bw >= 1) return 1;
    // Distance from nearest border edge (in tile units), capped at band width.
    const distX = Math.min(tx, numTilesX - 1 - tx);
    const distY = Math.min(ty, numTilesY - 1 - ty);
    const fracX = distX < borderBandX ? distX / borderBandX : 1;
    const fracY = distY < borderBandY ? distY / borderBandY : 1;
    // Use min: a tile in the corner of both bands gets the lowest factor.
    const frac = Math.min(fracX, fracY);
    return bw + (1 - bw) * frac;
  }

  let totalW = 0, cx = 0, cy = 0;
  for (let ty = 0; ty < numTilesY; ty++) {
    for (let tx = 0; tx < numTilesX; tx++) {
      const w = Math.sqrt(tileVar(tx, ty)) * borderFactor(tx, ty);
      totalW += w;
      cx += (tx + 0.5) * w;  // tile center coordinates
      cy += (ty + 0.5) * w;
    }
  }
  if (totalW > 0) { cx /= totalW; cy /= totalW; }
  else { cx = numTilesX / 2; cy = numTilesY / 2; }  // fallback: geometric center

  const tCentroid = Date.now();

  // Step 4: scale centroid from tile-space to original image coordinates.
  let origCx = Math.round(cx * effTile * scaleX);
  let origCy = Math.round(cy * effTile * scaleY);

  // Focus window override: if an upstream processor (e.g. ml_subject) set a
  // focus window, use its center as the crop anchor instead of the variance centroid.
  // When a focus window is provided we also switch to an AR-matched extract (see
  // Step 5) and strategy='centre' to prevent Sharp from sub-cropping away from
  // the focus point.
  let focusSource = null;
  let effectiveWinScale = Math.max(1, attentionWindow);
  let effectiveStrategy = strategy;
  if (context.focusWindow) {
    const fw = context.focusWindow;
    origCx = Math.round(fw.x + fw.w / 2);
    origCy = Math.round(fw.y + fw.h / 2);
    focusSource = fw.source;
    effectiveStrategy = 'centre';
    console.log(`[coherence_crop] focus window from '${fw.source}' overrides centroid → (${origCx},${origCy}) [strategy→centre]`);
  }

  // Step 5: place extraction rectangle centered at centroid, clamped to image bounds.
  //
  // Without a focus window: extract a window scaled by attentionWindow, then let
  // Sharp's attention strategy find the most salient sub-crop within it.
  //
  // With a focus window: use an AR-matched extract — the largest rectangle with the
  // same aspect ratio as the target that fits inside the source image. For a portrait
  // source targeting a landscape TV this is (origW × origW*targetH/targetW). With
  // this extract, fit:'cover' applies the same scale factor to both axes, so no
  // sub-crop occurs in either dimension. strategy='centre' then positions the crop
  // exactly on the focus point with no drift. Without this sizing, a cover resize
  // on an oversized extract would sub-crop heavily in one axis, pushing the focus
  // point to the edge of the output (e.g. face at the very bottom of a landscape TV).
  let windowW, windowH;
  if (context.focusWindow) {
    if (origW * targetH <= origH * targetW) {
      // Portrait source (origAR ≤ targetAR): width-limited — use full source width.
      windowW = origW;
      windowH = Math.min(origH, Math.round(origW * targetH / targetW));
    } else {
      // Landscape source (origAR > targetAR): height-limited — use full source height.
      windowH = origH;
      windowW = Math.min(origW, Math.round(origH * targetW / targetH));
    }
    effectiveWinScale = windowH / targetH; // for logging
  } else {
    windowW = Math.min(origW, Math.round(targetW * effectiveWinScale));
    windowH = Math.min(origH, Math.round(targetH * effectiveWinScale));
  }

  const extractLeft = Math.max(0, Math.min(origW - windowW, Math.round(origCx - windowW / 2)));
  const extractTop  = Math.max(0, Math.min(origH - windowH, Math.round(origCy - windowH / 2)));
  const extractW    = Math.min(windowW, origW - extractLeft);
  const extractH    = Math.min(windowH, origH - extractTop);

  // Centroid offset from geometric center — indicates how far the crop was pulled
  // toward the painting. Zero = symmetric content; nonzero = asymmetric frame.
  const centerOffsetX = origCx - Math.round(origW / 2);
  const centerOffsetY = origCy - Math.round(origH / 2);

  console.log(
    `[coherence_crop] work=${workW}×${workH} tiles=${numTilesX}×${numTilesY}` +
    ` centroid=(${cx.toFixed(1)}t,${cy.toFixed(1)}t) → orig(${origCx},${origCy})` +
    ` offset from center=(${centerOffsetX > 0 ? '+' : ''}${centerOffsetX},${centerOffsetY > 0 ? '+' : ''}${centerOffsetY})` +
    ` borderWeight=${bw} window=${effectiveWinScale.toFixed(2)}x strategy=${effectiveStrategy}` +
    ` → extract(left=${extractLeft},top=${extractTop} ${extractW}×${extractH}) → ${targetW}×${targetH}`
  );

  // Minimum coverage guard.
  //
  // coherenceCrop extracts a window of exactly targetW×targetH pixels from the
  // original image (1:1 scale). For very large source images this can be a tiny
  // fraction of the total area — which magnifies centroid errors catastrophically.
  // Example: Gabrielle d'Estrées (10703×7961) → 3840×2160 target: the extraction
  // covers only 9.7% of the original image. A centroid landing on the empty space
  // between two figures then crops out nearly all painting content.
  //
  // Guard: compare extractW×extractH against what a natural cover-fit would use —
  // the largest rectangle at the target aspect ratio that fits inside the source.
  // If the extraction covers less than minCoverageFrac of the cover-fit area,
  // fall back to a center cover-fit (the same as Sharp's built-in behaviour).
  //
  // coverFitW/H in original coords: scale = max(targetW/origW, targetH/origH);
  //   coverFitW = min(origW, targetW/scale), coverFitH = min(origH, targetH/scale).
  const coverFitScale = Math.max(targetW / origW, targetH / origH);
  const coverFitW     = Math.min(origW, targetW / coverFitScale);
  const coverFitH     = Math.min(origH, targetH / coverFitScale);
  const coverFitArea  = coverFitW * coverFitH;
  const extractArea   = extractW * extractH;
  const coverageRatio = coverFitArea > 0 ? extractArea / coverFitArea : 1;

  let usedFallback = false;
  // Step 6: extract and resize to target.
  let result;
  if (coverageRatio < minCoverageFrac) {
    // Extraction window too small relative to the natural crop size — the centroid
    // is likely wrong. Fall back to a center cover-fit over the full image.
    console.warn(
      `[coherence_crop] coverage ${(coverageRatio * 100).toFixed(1)}% < ${(minCoverageFrac * 100).toFixed(0)}% threshold ` +
      `(extract ${extractW}×${extractH} vs cover-fit ${Math.round(coverFitW)}×${Math.round(coverFitH)}) — falling back to center crop`
    );
    result = await sharp(context.buffer)
      .resize(targetW, targetH, { fit: 'cover', position: 'centre' })
      .toBuffer();
    usedFallback = true;
  } else if (extractLeft === 0 && extractTop === 0 && extractW === origW && extractH === origH) {
    result = await sharp(context.buffer)
      .resize(targetW, targetH, { fit: 'cover', position: effectiveStrategy })
      .toBuffer();
  } else {
    result = await sharp(context.buffer)
      .extract({ left: extractLeft, top: extractTop, width: extractW, height: extractH })
      .resize(targetW, targetH, { fit: 'cover', position: effectiveStrategy })
      .toBuffer();
  }
  const tEnd = Date.now();

  context.buffer = result;
  context.raw    = null;
  context.width  = targetW;
  context.height = targetH;

  context.debug.coherence_crop = {
    timing:        { total: tEnd - t0, decode: tDecode - t0, centroid: tCentroid - tDecode, encode: tEnd - tCentroid },
    centroid:      { tileX: cx, tileY: cy, origX: origCx, origY: origCy, offsetX: centerOffsetX, offsetY: centerOffsetY },
    focusSource:   focusSource || null,
    extract:       { left: extractLeft, top: extractTop, width: extractW, height: extractH },
    coverage:      { ratio: coverageRatio, fallback: usedFallback },
    strategy:      effectiveStrategy,
    borderWeight:  bw,
    borderBandFrac,
    attentionWindow: effectiveWinScale,
  };

  console.log(`[coherence_crop timing] decode=${tDecode-t0}ms centroid=${tCentroid-tDecode}ms encode=${tEnd-tCentroid}ms total=${tEnd-t0}ms`);
  return context;
}

module.exports = { coherenceCropProcessor };
