'use strict';

const sharp = require('sharp');

/**
 * Scored Crop processor.
 *
 * A unified frame detection + aspect-ratio crop that works by scoring candidate
 * crop rectangles rather than explicitly detecting frame boundaries.
 *
 * Each candidate rectangle (forced to the target aspect ratio) is scored by:
 *   - Penalizing edges that look like frame material (low local variance)
 *   - Rewarding interior regions that look like painting content (high variance)
 *
 * The highest-scoring candidate is selected and used as the extract + resize region.
 *
 * Key advantage over separate detect-then-crop: the algorithm never needs to find
 * the frame boundary at all — it just finds the rectangle with the most "complex
 * content inside, uniform material at edges", which is the painting region.
 * Frame irregularities, ornate borders, and tricky lighting don't confuse it
 * because no boundary-finding is required.
 *
 * Performance: all scoring is done at ~800px working resolution using summed-area
 * tables (integral images), making each rectangle query O(1). Expected: 80–150ms.
 *
 * Algorithm:
 *   1. Downsample to ~800px on the long axis.
 *   2. Build a local variance proxy map: for each pixel, squared diff to right +
 *      bottom neighbors (mean of 2). O(workW × workH).
 *   3. Build a summed-area table (SAT) over the variance map. O(workW × workH).
 *   4. Generate candidate rectangles (all at target AR) across a size × position
 *      grid. Score each with O(1) SAT queries:
 *        edgePenalty    = max(0, 1 - meanEdgeVar / edgeVarThreshold)
 *        interiorReward = min(1, meanInteriorVar / interiorVarTarget)
 *        score = interiorWeight * interiorReward - edgeWeight * edgePenalty
 *   5. Project winner back to original resolution. Extract + resize.
 *   6. If no candidate beats minScoreThreshold, fall back to a centered crop.
 *
 * options:
 *   numSizes          8      Number of candidate size steps (minSizeFrac → full size).
 *   minSizeFrac       0.40   Smallest candidate as fraction of max fitting dimension.
 *   tileStride        8      Position grid stride in working-resolution pixels.
 *   edgeVarThreshold  200    Local variance below this = "frame-like" edge material.
 *   interiorVarTarget 800    Local variance level that counts as fully complex content.
 *   edgeWeight        0.4    Weight of edge penalty in the combined score.
 *   interiorWeight    0.6    Weight of interior reward in the combined score.
 *   centeringWeightX  0.15   Horizontal centering penalty. Penalizes candidates
 *                            whose horizontal center is far from the image center.
 *                            Prevents the scorer from drifting left/right when both
 *                            sides have similar frame material. Set to 0 to disable.
 *   centeringWeightY  0.0    Vertical centering penalty. Default 0 — vertical content
 *                            position (e.g. face at top of portrait) should be driven
 *                            by interior reward, not forced to center.
 *   minScoreThreshold -0.1   Fall back to centered crop if no candidate beats this.
 *   strategy          'attention'  Sharp resize position: attention | entropy | centre.
 */
async function scoredCropProcessor(context, {
  numSizes          = 8,
  minSizeFrac       = 0.65,
  tileStride        = 8,
  edgeVarThreshold  = 200,
  interiorVarTarget = 800,
  edgeWeight        = 0.6,
  interiorWeight    = 0.6,
  centeringWeightX  = 0.15,
  centeringWeightY  = 0.0,
  minScoreThreshold = -0.1,
  strategy          = 'centre',
} = {}) {
  const t0 = Date.now();

  const { targetW, targetH } = context;
  const targetAR = targetW / targetH;
  const origW = context.width;
  const origH = context.height;

  // Step 1: downsample to working resolution for all analysis.
  const WORK_TARGET = 800;
  const { data: workData, info: workInfo } = await sharp(context.buffer)
    .resize(WORK_TARGET, WORK_TARGET, { fit: 'inside', withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width: workW, height: workH, channels } = workInfo;
  const scaleX = origW / workW;
  const scaleY = origH / workH;
  const tDecode = Date.now();

  // BT.601 luminance of a pixel at byte offset `off`.
  function lum(off) {
    return 0.299 * workData[off] + 0.587 * workData[off + 1] + 0.114 * workData[off + 2];
  }

  // Step 2: local variance proxy map.
  // For each pixel: squared differences to right + bottom neighbor (mean of 2).
  // O(workW × workH) — lightweight estimate of local texture/complexity.
  const localVar = new Float32Array(workW * workH);
  for (let y = 0; y < workH; y++) {
    for (let x = 0; x < workW; x++) {
      const l = lum((y * workW + x) * channels);
      let d1 = 0, d2 = 0, n = 0;
      if (x + 1 < workW) { d1 = l - lum((y * workW + x + 1) * channels); n++; }
      if (y + 1 < workH) { d2 = l - lum(((y + 1) * workW + x) * channels); n++; }
      localVar[y * workW + x] = n > 0 ? (d1 * d1 + d2 * d2) / n : 0;
    }
  }

  // Step 3: build summed-area table (integral image) over localVar.
  // SAT[(y+1)*(workW+1)+(x+1)] = sum of localVar values in [0..x] × [0..y].
  const stride = workW + 1;
  const sat    = new Float64Array((workW + 1) * (workH + 1));
  for (let y = 0; y < workH; y++) {
    for (let x = 0; x < workW; x++) {
      sat[(y + 1) * stride + (x + 1)] =
        localVar[y * workW + x]
        + sat[y * stride + (x + 1)]
        + sat[(y + 1) * stride + x]
        - sat[y * stride + x];
    }
  }

  // O(1) sum query for any rectangle.
  function rectMean(x, y, w, h) {
    if (w <= 0 || h <= 0) return 0;
    const x0 = Math.max(0, x),      y0 = Math.max(0, y);
    const x1 = Math.min(workW, x+w), y1 = Math.min(workH, y+h);
    const area = (x1 - x0) * (y1 - y0);
    if (area === 0) return 0;
    return (sat[y1 * stride + x1] - sat[y0 * stride + x1]
          - sat[y1 * stride + x0] + sat[y0 * stride + x0]) / area;
  }

  const tSAT = Date.now();

  // Focus window: project to working-resolution coordinates for use in scoring.
  // When set, candidates are biased toward the focus point using both X and Y
  // centering terms (instead of the image center), ensuring faces/subjects are
  // preferentially included over the geometric center.
  let focusWorkCx = workW / 2;
  let focusWorkCy = workH / 2;
  let focusActive = false;
  if (context.focusWindow) {
    const fw = context.focusWindow;
    focusWorkCx = (fw.x + fw.w / 2) / scaleX;
    focusWorkCy = (fw.y + fw.h / 2) / scaleY;
    focusActive = true;
    console.log(`[scored_crop] focus window from '${fw.source}' → work center (${focusWorkCx.toFixed(1)},${focusWorkCy.toFixed(1)})`);
  }

  // Step 4: generate candidates and score them.
  // Compute max-fitting rectangle in working resolution at target AR.
  let baseW, baseH;
  if (targetAR >= 1) {
    baseH = workH;
    baseW = Math.round(baseH * targetAR);
    if (baseW > workW) { baseW = workW; baseH = Math.round(baseW / targetAR); }
  } else {
    baseW = workW;
    baseH = Math.round(baseW / targetAR);
    if (baseH > workH) { baseH = workH; baseW = Math.round(baseH * targetAR); }
  }

  const BORDER = 3; // edge strip width in working-resolution pixels

  let bestScore     = -Infinity;
  let bestCandidate = null;
  let candidateCount = 0;

  for (let si = 0; si < numSizes; si++) {
    const frac = numSizes > 1
      ? minSizeFrac + (1 - minSizeFrac) * (si / (numSizes - 1))
      : 1;
    const cH = Math.max(BORDER * 4, Math.round(baseH * frac));
    const cW = Math.max(BORDER * 4, Math.round(cH * targetAR));
    if (cW > workW || cH > workH) continue;

    for (let top = 0; top + cH <= workH; top += tileStride) {
      for (let left = 0; left + cW <= workW; left += tileStride) {
        candidateCount++;

        // Mean local variance along each of the 4 edge strips (BORDER px wide).
        const topMean   = rectMean(left,            top,            cW,     BORDER);
        const botMean   = rectMean(left,            top + cH-BORDER, cW,    BORDER);
        const leftMean  = rectMean(left,            top,            BORDER, cH);
        const rightMean = rectMean(left + cW-BORDER, top,           BORDER, cH);
        const meanEdgeVar = (topMean + botMean + leftMean + rightMean) / 4;

        // Mean local variance in the interior (inset by BORDER on all sides).
        const interiorMeanVar = rectMean(left+BORDER, top+BORDER, cW-2*BORDER, cH-2*BORDER);

        // Linear frame-likeness fraction (0 = complex, 1 = pure frame material).
        const edgeFrac       = Math.max(0, 1 - meanEdgeVar / edgeVarThreshold);
        // Squared penalty: makes very uniform (frame-like) edges far more costly
        // than moderately-low-variance edges. Ornate frames with some variation
        // are penalized less; true uniform wood/gilding is penalized heavily.
        const edgePenalty    = edgeFrac * edgeFrac;
        const interiorReward = Math.min(1, interiorMeanVar / interiorVarTarget);

        // Centering preference: penalize candidates whose center is far from the
        // reference point. When a focus window is active the reference is the
        // focus center (face, etc.) so both X and Y prefer the focus; otherwise
        // the reference is the image center (prevents frame drift).
        const refCx = focusActive ? focusWorkCx : workW / 2;
        const refCy = focusActive ? focusWorkCy : workH / 2;
        const centerDx = (left + cW / 2 - refCx) / workW;
        const centerDy = (top  + cH / 2 - refCy) / workH;

        // When focus is active use the same weight for both axes so the
        // crop is pulled toward the face regardless of orientation.
        const wX = focusActive ? Math.max(centeringWeightX, centeringWeightY, 0.3) : centeringWeightX;
        const wY = focusActive ? Math.max(centeringWeightX, centeringWeightY, 0.3) : centeringWeightY;

        const score = interiorWeight * interiorReward
                    - edgeWeight       * edgePenalty
                    - wX               * Math.abs(centerDx)
                    - wY               * Math.abs(centerDy);

        if (score > bestScore) {
          bestScore = score;
          bestCandidate = { left, top, w: cW, h: cH, score, edgePenalty, interiorReward, centerDx, centerDy };
        }
      }
    }
  }

  const tScore = Date.now();

  // Step 5: select winner; fall back to centered crop if score too low.
  let winner   = bestCandidate;
  let fallback = false;
  if (!winner || bestScore < minScoreThreshold) {
    fallback = true;
    const cLeft = Math.max(0, Math.round((workW - baseW) / 2));
    const cTop  = Math.max(0, Math.round((workH - baseH) / 2));
    winner = { left: cLeft, top: cTop, w: baseW, h: baseH, score: 0, edgePenalty: 0, interiorReward: 0 };
    console.log(`[scored_crop] no candidate beat threshold ${minScoreThreshold} — centered fallback`);
  }

  // Step 6: project winner back to original image coordinates.
  const origLeft   = Math.max(0,    Math.round(winner.left * scaleX));
  const origTop    = Math.max(0,    Math.round(winner.top  * scaleY));
  const origRight  = Math.min(origW, Math.round((winner.left + winner.w) * scaleX));
  const origBottom = Math.min(origH, Math.round((winner.top  + winner.h) * scaleY));
  const extractW   = Math.max(1, origRight  - origLeft);
  const extractH   = Math.max(1, origBottom - origTop);

  console.log(
    `[scored_crop] candidates=${candidateCount} best score=${bestScore.toFixed(3)}` +
    ` edgePenalty=${winner.edgePenalty.toFixed(3)} interiorReward=${winner.interiorReward.toFixed(3)}` +
    ` work(${winner.left},${winner.top} ${winner.w}×${winner.h})` +
    ` → extract(${origLeft},${origTop} ${extractW}×${extractH}) → ${targetW}×${targetH} strategy=${strategy}`
  );

  // Step 7: extract painting region and resize to target.
  let result;
  if (extractW === origW && extractH === origH) {
    result = await sharp(context.buffer)
      .resize(targetW, targetH, { fit: 'cover', position: strategy })
      .toBuffer();
  } else {
    result = await sharp(context.buffer)
      .extract({ left: origLeft, top: origTop, width: extractW, height: extractH })
      .resize(targetW, targetH, { fit: 'cover', position: strategy })
      .toBuffer();
  }
  const tEnd = Date.now();

  context.buffer = result;
  context.raw    = null;
  context.width  = targetW;
  context.height = targetH;

  context.debug.scored_crop = {
    timing:      { total: tEnd - t0, downsample: tDecode - t0, buildSAT: tSAT - tDecode, score: tScore - tSAT, encode: tEnd - tScore },
    candidates:  { total: candidateCount },
    winner:      { ...winner },
    fallback,
    focusSource: focusActive ? context.focusWindow.source : null,
    extract:     { left: origLeft, top: origTop, width: extractW, height: extractH },
    strategy,
  };

  console.log(`[scored_crop timing] downsample=${tDecode-t0}ms buildSAT=${tSAT-tDecode}ms score=${tScore-tSAT}ms encode=${tEnd-tScore}ms total=${tEnd-t0}ms`);
  return context;
}

module.exports = { scoredCropProcessor };
