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
 * Returns { depth, confidence } where depth is pixels to crop (0 = no frame)
 * and confidence is 0..1 based on:
 *   - Coverage uniformity (0.40): thirds check — does the edge span the full width/height?
 *   - Edge density score (0.35): how much the detected density exceeds the minimum
 *   - Peek sparsity score (0.25): how cleanly the interior drops off after the edge
 */
function findInnerEdge(
  edges, width, height, side, maxDepth, minDensity, threshold,
  peekRows = 4, sparseDensity = 0.18,
) {
  const isHoriz = side === 'top' || side === 'bottom';
  const total   = isHoriz ? width : height;
  const scanLimit = Math.min(maxDepth + peekRows, isHoriz ? height - 1 : width - 1);

  // Precompute row/column density for maxDepth + peekRows rows.
  const densities = new Float32Array(scanLimit + 1);
  for (let d = 1; d <= scanLimit; d++) {
    let above = 0;
    if (isHoriz) {
      const row = side === 'top' ? d : height - 1 - d;
      for (let x = 0; x < width; x++) {
        if (edges[row * width + x] >= threshold) above++;
      }
    } else {
      const col = side === 'left' ? d : width - 1 - d;
      for (let y = 0; y < height; y++) {
        if (edges[y * width + col] >= threshold) above++;
      }
    }
    densities[d] = above / total;
  }

  // Accept candidate at depth d only if dense AND the next peekRows indicate sparse
  // interior. Two acceptance modes:
  //   (a) All peek rows strictly sparse (< sparseDensity): existing behaviour.
  //   (b) Dramatic-drop: candidate density ≥ 3× peek average AND peek average
  //       stays below sparseDensity×1.5. Handles ornate/complex frames where a
  //       single transition row slightly exceeds the absolute sparse threshold due
  //       to paint or texture bleed at the exact frame-to-canvas boundary.
  // Keep the innermost (largest d) such candidate.
  let lastValidEdge  = 0;
  let bestDensity    = 0;
  let bestPeekAvg    = 1.0;

  for (let d = 1; d <= maxDepth; d++) {
    if (densities[d] < minDensity) continue;
    let peekSum = 0, peekCount = 0;
    let anyNonSparse = false;
    for (let p = 1; p <= peekRows && d + p <= scanLimit; p++) {
      const pd = densities[d + p];
      peekSum += pd; peekCount++;
      if (pd >= sparseDensity) anyNonSparse = true;
    }
    const peekAvg  = peekCount > 0 ? peekSum / peekCount : 0;
    const allSparse = !anyNonSparse;
    // Secondary criterion: allows ornate frames whose inner boundary row produces
    // one slightly-above-threshold peek value. Requires a sharp drop (candidate
    // density ≥ 4× peek average) so gradual interior patterns don't trigger it.
    const dramaticDrop = !allSparse &&
      peekAvg < sparseDensity * 1.5 &&
      densities[d] >= peekAvg * 4.0;

    if (allSparse || dramaticDrop) {
      lastValidEdge = d;
      bestDensity   = densities[d];
      bestPeekAvg   = peekAvg;
    }
  }

  if (lastValidEdge === 0) return { depth: 0, confidence: 0 };

  // Coverage uniformity: check each third of the row/column independently.
  // A genuine frame edge spans the full width/height; a localized painting feature
  // is concentrated in fewer thirds. Used as a confidence weight (uniformity = thirdsPass/3)
  // rather than a hard gate — the gate caused regressions on textured frames (wood grain)
  // whose boundary row has uneven edge density across thirds.
  const thirdLen = Math.floor(total / 3);
  let thirdsPass = 0;
  for (let t = 0; t < 3; t++) {
    const t0 = t * thirdLen;
    const t1 = (t === 2) ? total : (t + 1) * thirdLen;
    let above = 0;
    if (isHoriz) {
      const row = side === 'top' ? lastValidEdge : height - 1 - lastValidEdge;
      for (let x = t0; x < t1; x++) {
        if (edges[row * width + x] >= threshold) above++;
      }
    } else {
      const col = side === 'left' ? lastValidEdge : width - 1 - lastValidEdge;
      for (let y = t0; y < t1; y++) {
        if (edges[y * width + col] >= threshold) above++;
      }
    }
    if (above / (t1 - t0) >= minDensity * 0.6) thirdsPass++;
  }
  const uniformity = thirdsPass / 3;
  const densityScore  = Math.min(1, (bestDensity - minDensity) / Math.max(0.01, 1.0 - minDensity));
  const sparsityScore = Math.min(1, Math.max(0, (sparseDensity - bestPeekAvg) / Math.max(0.01, sparseDensity)));

  const confidence = 0.40 * uniformity + 0.35 * densityScore + 0.25 * sparsityScore;

  return { depth: lastValidEdge, confidence };
}

/**
 * Sample mean and variance over a depth range along the middle 60% of a side.
 * Using the central band avoids corner effects and vertical lighting gradients.
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
 * Returns { depth, confidence } where confidence reflects:
 *   - Uniformity quality (0.60): how far below threshold the frame rows averaged
 *   - Boundary clarity (0.40): how sharply the first non-frame row exceeds threshold
 * Confidence is capped at 0.85 — thin-border detection is less certain than Sobel.
 */
function findThinUniformBorderHoriz(gray, width, height, side, maxThinDepth, varianceThreshold, minBorderDepth = 2) {
  let uniformCount = 0;
  let sumVariance  = 0;

  // Sample middle 60% of each row. Matches the sampleBandStats range used by cross-side,
  // so thin-border and cross-side agree on what "frame material" looks like at a given row.
  // The outer 20% on each side can include corner-junction mixing (ornate frame corners)
  // or edge wear/chips — excluding them gives a cleaner uniformity reading for the interior
  // of the frame band, which is what we actually want to measure.
  const x0 = Math.floor(width * 0.20);
  const x1 = Math.ceil(width  * 0.80);
  const n  = x1 - x0;

  // Contrast guard: if the edge and interior have similar mean luminance there is no
  // distinct border — skip scanning. Mirrors the guard in findThinUniformBorderVert.
  function rowMean(d) {
    const row = side === 'top' ? d : height - 1 - d;
    let s = 0;
    for (let x = x0; x < x1; x++) s += gray[row * width + x];
    return s / n;
  }
  const edgeRef     = (rowMean(1) + rowMean(2)) / 2;
  const innerD      = Math.min(maxThinDepth + 10, Math.floor(height * 0.12));
  const contrastDiff = Math.abs(edgeRef - rowMean(innerD));
  if (contrastDiff < 10) return { depth: 0, confidence: 0 };

  for (let d = 1; d <= maxThinDepth; d++) {
    const row = side === 'top' ? d : height - 1 - d;
    let sum = 0, sumSq = 0;
    for (let x = x0; x < x1; x++) { const v = gray[row * width + x]; sum += v; sumSq += v * v; }
    const mean     = sum / n;
    const variance = sumSq / n - mean * mean;

    if (variance < varianceThreshold) {
      sumVariance += variance;
      uniformCount++;
    } else {
      if (uniformCount >= minBorderDepth) {
        // Boundary consistency check: only applied when the uniform run is suspiciously
        // long (≥ 10 rows). Short runs are genuine thin frames; long runs may be a dark
        // painting background (which has low variance across many rows). For long runs,
        // require the transition row to be high-variance across ≥ 2 of 3 horizontal thirds
        // — genuine frame boundaries end consistently across the full width, while painting
        // content (e.g. a figure's head emerging from a dark background) produces high
        // variance only in the centre third.
        if (uniformCount >= 30) {
          const bW = Math.floor((x1 - x0) / 3);
          let thirdsHigh = 0;
          for (let b = 0; b < 3; b++) {
            const bx0 = x0 + b * bW;
            const bx1 = (b === 2) ? x1 : (bx0 + bW);
            const bN  = bx1 - bx0;
            let s = 0, sq = 0;
            for (let x = bx0; x < bx1; x++) { const v = gray[row * width + x]; s += v; sq += v * v; }
            const bMean = s / bN;
            if (sq / bN - bMean * bMean >= varianceThreshold) thirdsHigh++;
          }
          if (thirdsHigh < 2) {
            return { depth: 0, confidence: 0 };
          }
        }
        const avgVar          = sumVariance / uniformCount;
        const uniformityQual  = Math.max(0, 1 - avgVar / varianceThreshold);
        const boundaryClarity = Math.min(1, (variance - varianceThreshold) / varianceThreshold);
        const confidence      = Math.min(0.85, 0.60 * uniformityQual + 0.40 * boundaryClarity);
        return { depth: d - 1, confidence };
      }
      // Skip outer rows that are clearly background/transition noise — variance well above
      // threshold (3×) indicates scan artifact or outer-edge mixing, not borderline frame
      // material. This allows an arbitrary-depth background zone to be skipped while still
      // exiting promptly on borderline non-uniform rows once the frame band is reached.
      if (uniformCount === 0 && variance > varianceThreshold * 3) continue;
      return { depth: 0, confidence: 0 };
    }
  }
  return { depth: 0, confidence: 0 };
}

/**
 * LEFT/RIGHT thin border fallback: corner-band mean consistency scan.
 *
 * Returns { depth, confidence } where confidence reflects:
 *   - Consistency quality (0.60): how far below threshold the average deviation stayed
 *   - Contrast score (0.40): how strongly the edge differs from the interior
 * Confidence is capped at 0.80 — vertical thin-border detection is less certain than horizontal.
 */
function findThinUniformBorderVert(gray, width, height, side, maxThinDepth, consistencyThreshold, minBorderDepth = 2) {
  const bandH = Math.max(4, Math.floor(height * 0.20));

  function cornerMean(d) {
    const col = side === 'left' ? d : width - 1 - d;
    let sum = 0, count = 0;
    for (let y = 0; y < bandH; y++) { sum += gray[y * width + col]; count++; }
    for (let y = height - bandH; y < height; y++) { sum += gray[y * width + col]; count++; }
    return sum / count;
  }

  const edgeRef      = (cornerMean(1) + cornerMean(2)) / 2;
  const interiorDepth = Math.min(maxThinDepth + 15, Math.floor(width * 0.12));
  const contrastDiff  = Math.abs(edgeRef - cornerMean(interiorDepth));
  if (contrastDiff < 15) return { depth: 0, confidence: 0 };

  let uniformCount = 0;
  let sumDeviation = 0;

  for (let d = 1; d <= maxThinDepth; d++) {
    const deviation = Math.abs(cornerMean(d) - edgeRef);
    if (deviation < consistencyThreshold) {
      sumDeviation += deviation;
      uniformCount++;
    } else {
      if (uniformCount >= minBorderDepth) {
        const avgDev          = sumDeviation / uniformCount;
        const consistencyQual = Math.max(0, 1 - avgDev / consistencyThreshold);
        const contrastScore   = Math.min(1, contrastDiff / 50);
        const confidence      = Math.min(0.80, 0.60 * consistencyQual + 0.40 * contrastScore);
        return { depth: d - 1, confidence };
      }
      return { depth: 0, confidence: 0 };
    }
  }
  return { depth: 0, confidence: 0 };
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
 * Confidence gating (before Pass 2): Sobel detections below minConfidence are
 * discarded. This means (a) below-gate sides cannot serve as cross-side references —
 * preventing false-positive chains in recursive passes where a newly-exposed painting
 * edge weakly mimics a frame boundary — and (b) below-gate sides are treated as
 * missing and can be filled by Pass 2 or re-inferred by Pass 3.
 *
 * Pass 2 (thin uniform border): per-side fallback for solid-color borders (thin black,
 * gold, or white bands) too thin to survive Sobel's downscale+blur. Runs on sides
 * still zero after gate. Runs BEFORE cross-side so thin-border detections are
 * first-class seeds: a gold border found only on the top can anchor inference of the
 * matching bottom, left, and right via Pass 3.
 *
 * Pass 3 (cross-side validation): for each undetected side, pick the best reference
 * (prefer opposite side) and test whether the candidate has similar border material
 * at the same depth. Iterates until convergence. Variance guard skips inference when
 * the reference is multi-layer (high variance) — let recursion strip layers instead.
 *
 * @param {Buffer} buffer
 * @param {object} options
 * @param {number} [options.maxCropFrac=0.25]         Max fraction of dimension for Sobel scan
 * @param {number} [options.minEdgeDensity=0.40]      Sobel: min fraction of pixels above threshold
 * @param {number} [options.edgeThreshold=20]         Sobel magnitude threshold (post-blur)
 * @param {number} [options.thinBorderVariance=200]   Row-variance threshold for top/bottom thin-border pass
 * @param {number} [options.thinBorderConsistency=40] Corner-band mean consistency threshold for left/right pass
 * @param {number} [options.thinBorderMaxFrac=0.10]   Max fraction of dimension for thin-border scan
 * @param {boolean} [options.crossSideValidation=true] Infer missing sides from detected sides
 * @param {number}  [options.crossMeanTolerance=45]   Max luminance difference for cross-side inference
 * @param {number}  [options.crossVarMax=1240]        Max variance for the REFERENCE band (blocks ornate/multi-layer refs; defer to recursion)
 * @param {number}  [options.crossCandVarMax=2500]    Max variance for the CANDIDATE band (allows textured single-layer like wood grain)
 * @param {number}  [options.minConfidence=0.40]      Discard detections below this confidence (0..1)
 * @param {boolean} [options.isFirstPass=true]        Set false on recursive pass 2+ to block below-gate cross-side fallback refs
 */
async function frameBoundaryPreProcessor(buffer, {
  maxCropFrac           = 0.25,
  minEdgeDensity        = 0.40,
  edgeThreshold         = 20,
  thinBorderVariance    = 200,
  thinBorderConsistency = 40,
  thinBorderMaxFrac     = 0.10,
  crossSideValidation   = true,
  crossMeanTolerance    = 45,
  crossVarMax           = 1240,
  crossCandVarMax       = 2500,
  minConfidence         = 0.40,
  isFirstPass           = true,
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

  // Pass 1: Sobel edge-density scan. Returns {depth, confidence} per side.
  let { depth: cTop,    confidence: confTop    } = findInnerEdge(edges, anaW, anaH, 'top',    maxV, minEdgeDensity, edgeThreshold);
  let { depth: cBottom, confidence: confBottom } = findInnerEdge(edges, anaW, anaH, 'bottom', maxV, minEdgeDensity, edgeThreshold);
  let { depth: cLeft,   confidence: confLeft   } = findInnerEdge(edges, anaW, anaH, 'left',   maxH, minEdgeDensity, edgeThreshold);
  let { depth: cRight,  confidence: confRight  } = findInnerEdge(edges, anaW, anaH, 'right',  maxH, minEdgeDensity, edgeThreshold);

  // Confidence gate: applied to Sobel detections BEFORE thin-border and cross-side run.
  // Below-gate Sobel sides are zeroed so they don't pollute thin-border upgrade logic
  // or cross-side seeding. Pregate depths are saved as first-pass-only fallback refs
  // for the cross-side fallback mechanism (see below).
  //
  // Pregate save: preserve below-gate depths for use as fallback references on the
  // first pass only. When a frame has only one weakly-detected side, that side can
  // still seed cross-side inference even though it won't contribute to the final crop.
  // On recursive passes (isFirstPass=false) the fallback is disabled to prevent
  // painting-content false positives from spawning new inferences.
  const confGate = minConfidence - 1e-6;
  const pregate = {
    top:    { depth: cTop,    conf: confTop    },
    bottom: { depth: cBottom, conf: confBottom },
    left:   { depth: cLeft,   conf: confLeft   },
    right:  { depth: cRight,  conf: confRight  },
  };
  if (cTop    > 0 && confTop    < confGate) { console.log(`[frame-boundary] top    rejected by confidence (${confTop.toFixed(2)} < ${minConfidence})`);    cTop    = 0; confTop    = 0; }
  if (cBottom > 0 && confBottom < confGate) { console.log(`[frame-boundary] bottom rejected by confidence (${confBottom.toFixed(2)} < ${minConfidence})`); cBottom = 0; confBottom = 0; }
  if (cLeft   > 0 && confLeft   < confGate) { console.log(`[frame-boundary] left   rejected by confidence (${confLeft.toFixed(2)} < ${minConfidence})`);   cLeft   = 0; confLeft   = 0; }
  if (cRight  > 0 && confRight  < confGate) { console.log(`[frame-boundary] right  rejected by confidence (${confRight.toFixed(2)} < ${minConfidence})`);  cRight  = 0; confRight  = 0; }

  // Asymmetry guard: if one side of an opposite pair is detected much shallower
  // than the other (< 25% of its depth), it likely fired on an intermediate frame
  // layer rather than the true inner boundary. Zero the shallower detection so
  // cross-side can infer the correct depth from the deeper reference.
  // Pass 2: thin uniform border — runs on sides still zero after Sobel + gate.
  // Runs BEFORE cross-side so thin-border detections are first-class seeds for
  // cross-side inference (e.g. gold top detected by thin-border → infer bottom).
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

  // Cap raised from 50→100: the contrast guard (added in conf14) prevents false positives
  // on frameless images, so we can scan deeper to cover thick gold liners (~149px original
  // that appear as ~70+ thin-scale pixels after outer frame removal in a recursive pass).
  const thinV = Math.min(Math.floor(thinH_dim * thinBorderMaxFrac), 100);
  const thinH = Math.min(Math.floor(thinW     * thinBorderMaxFrac), 100);

  const scaleRatio = thinScale / scale; // convert thin-buffer coords → Sobel-buffer coords

  if (cTop    === 0 && thinGray) {
    const { depth: raw, confidence } = findThinUniformBorderHoriz(thinGray, thinW, thinH_dim, 'top',    thinV, thinBorderVariance);
    const d = Math.round(raw / scaleRatio);
    if (d > 0) { cTop = d; confTop = confidence; }
  }
  if (cBottom === 0 && thinGray) {
    const { depth: raw, confidence } = findThinUniformBorderHoriz(thinGray, thinW, thinH_dim, 'bottom', thinV, thinBorderVariance);
    const d = Math.round(raw / scaleRatio);
    if (d > 0) { cBottom = d; confBottom = confidence; }
  }
  if (cLeft   === 0 && thinGray) {
    const { depth: raw, confidence } = findThinUniformBorderVert(thinGray, thinW, thinH_dim, 'left',   thinH, thinBorderConsistency);
    const d = Math.round(raw / scaleRatio);
    if (d > 0) { cLeft = d; confLeft = confidence; }
  }
  if (cRight  === 0 && thinGray) {
    const { depth: raw, confidence } = findThinUniformBorderVert(thinGray, thinW, thinH_dim, 'right',  thinH, thinBorderConsistency);
    const d = Math.round(raw / scaleRatio);
    if (d > 0) { cRight = d; confRight = confidence; }
  }

  // Asymmetry guard (post-thin-border): if one side of an opposite pair is much shallower
  // than the other (< 25% of its depth), it likely fired on an intermediate frame layer
  // rather than the true inner boundary. Zero the shallower detection so cross-side can
  // infer the correct depth from the deeper reference. Runs after thin-border so that
  // sides detected only by thin-border (not Sobel) participate in the comparison.
  if (cLeft > 0 && cRight > 0 && cRight < cLeft * 0.25) {
    console.log(`[frame-boundary] right zeroed by asymmetry guard (right=${cRight} < left=${cLeft} * 0.25)`);
    cRight = 0; confRight = 0;
  } else if (cLeft > 0 && cRight > 0 && cLeft < cRight * 0.25) {
    console.log(`[frame-boundary] left zeroed by asymmetry guard (left=${cLeft} < right=${cRight} * 0.25)`);
    cLeft = 0; confLeft = 0;
  }
  if (cTop > 0 && cBottom > 0 && cBottom < cTop * 0.25) {
    console.log(`[frame-boundary] bottom zeroed by asymmetry guard (bottom=${cBottom} < top=${cTop} * 0.25)`);
    cBottom = 0; confBottom = 0;
  } else if (cTop > 0 && cBottom > 0 && cTop < cBottom * 0.25) {
    console.log(`[frame-boundary] top zeroed by asymmetry guard (top=${cTop} < bottom=${cBottom} * 0.25)`);
    cTop = 0; confTop = 0;
  }

  // Pass 3: cross-side validation.
  // For each undetected side, pick the best reference (prefer opposite, fall back to
  // any detected side) and test whether the candidate has similar border material at
  // the same depth. We iterate until no new inferences are possible.
  //
  // All sides in `detected` are already above-gate (Sobel or thin-border), so they
  // are safe to use as anchors. Thin-border detections from Pass 2 participate as
  // first-class seeds here — enabling inference of undetected sides from a gold/black
  // border that only thin-border could see.
  //
  // Corroboration boost: each successful inference retroactively boosts the reference
  // side's confidence (0.10 × matchQuality per inference, requires ≥ 2 to apply).
  // This handles the case where a direct Sobel detection is borderline (e.g. ornate
  // frame with uneven thirds) but 3 other sides independently confirm the same material
  // at the same depth — strong evidence the detection was real.
  //
  // The reference variance guard skips inference when the reference is multi-layer
  // (high variance), deferring to the recursive pipeline instead.
  if (crossSideValidation && thinGray) {
    const SIDES    = ['top', 'bottom', 'left', 'right'];
    const OPPOSITE = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };

    const depthByName = {
      top:    () => cTop,    bottom: () => cBottom,
      left:   () => cLeft,   right:  () => cRight,
    };
    const confByName = {
      top:    () => confTop,    bottom: () => confBottom,
      left:   () => confLeft,   right:  () => confRight,
    };
    const setByName = {
      top:    (d, c) => { cTop    = d; confTop    = c; },
      bottom: (d, c) => { cBottom = d; confBottom = c; },
      left:   (d, c) => { cLeft   = d; confLeft   = c; },
      right:  (d, c) => { cRight  = d; confRight  = c; },
    };

    // Track corroboration: matchQualities of inferences spawned by each reference.
    const corroboration = { top: [], bottom: [], left: [], right: [] };

    let changed = true;
    while (changed) {
      changed = false;
      for (const miss of SIDES) {
        if (depthByName[miss]() > 0) continue;

        // Primary refs: above-gate direct detections and previous cross-side inferences.
        let detected = SIDES.filter(s => depthByName[s]() > 0);
        let usingFallback = false;

        if (detected.length === 0 && isFirstPass) {
          // No above-gate refs available. On the first pass only, use below-gate direct
          // detections as fallback seeds — they mark the correct depth even if confidence
          // was insufficient for a direct crop (e.g. a single weakly-detected frame side).
          // Disabled on recursive passes to prevent false-positive chains.
          detected = SIDES.filter(s => s !== miss && pregate[s].depth > 0 && pregate[s].conf < confGate);
          usingFallback = detected.length > 0;
          if (usingFallback) console.log(`[frame-boundary] cross-side: ${miss} using fallback ref(s) [${detected.join(',')}] (first pass, no above-gate primary refs)`);
        }

        if (detected.length === 0) break;

        const opp     = OPPOSITE[miss];
        const refSide = (detected.includes(opp)) ? opp : detected[0];
        const refSobelDepth = usingFallback ? pregate[refSide].depth : depthByName[refSide]();
        const thinDepth     = Math.max(2, Math.round(refSobelDepth * scaleRatio));
        const outerTo       = Math.max(1, Math.round(thinDepth / 2));

        const refStats = sampleBandStats(thinGray, thinW, thinH_dim, refSide, 1, outerTo);

        // Guard: skip if reference is multi-layer (high variance).
        if (refStats.variance > crossVarMax) {
          console.log(`[frame-boundary] cross-side: ${miss} skipped — ref ${refSide} var=${refStats.variance.toFixed(0)} (multi-layer, defer to recursion)`);
          continue;
        }

        const cand = sampleBandStats(thinGray, thinW, thinH_dim, miss, 1, outerTo);

        if (cand.variance < crossCandVarMax && Math.abs(cand.mean - refStats.mean) <= crossMeanTolerance) {
          // Material match passed. Also verify that the candidate side has a real Sobel
          // edge at the inferred depth — not just matching color. A physical frame boundary
          // produces an edge signal everywhere it goes; a head contour or uniform painting
          // background matches in color but has no corresponding edge on other sides.
          const csD     = Math.max(1, Math.min(refSobelDepth,
            (miss === 'top' || miss === 'bottom') ? anaH - 2 : anaW - 2));
          const csIsH   = miss === 'top' || miss === 'bottom';
          const csTotal = csIsH ? anaW : anaH;
          let csAbove = 0;
          if (csIsH) {
            const csRow = miss === 'top' ? csD : anaH - 1 - csD;
            for (let x = 0; x < anaW; x++) if (edges[csRow * anaW + x] >= edgeThreshold) csAbove++;
          } else {
            const csCol = miss === 'left' ? csD : anaW - 1 - csD;
            for (let y = 0; y < anaH; y++) if (edges[y * anaW + csCol] >= edgeThreshold) csAbove++;
          }
          const csEdgeDensity = csAbove / csTotal;
          // 0.05 absolute floor: any real frame material produces at least 5% edge pixels
          // at analysis scale. Truly empty sides (dark background, ~0.00–0.01) are blocked;
          // weak frame edges (0.10+) pass. Well below minEdgeDensity (0.40) since cross-side
          // is a fallback for sides Sobel couldn't directly detect.
          const csMinDensity  = 0.05;

          if (csEdgeDensity < csMinDensity) {
            console.log(`[frame-boundary] cross-side: ${miss} no edge at depth (density=${csEdgeDensity.toFixed(2)} < ${csMinDensity.toFixed(2)})`);
          } else {
            // Profile variance guard: the inferred band should be laterally uniform
            // (frame material), not a defined shape with high contrast between one
            // side and the other (arch, figure silhouette). Computes the variance of
            // column means (for top/bottom) or row means (for left/right) across the
            // full width of the inferred band in the thin buffer.
            if (thinDepth > 1) {
              const profileLen = csIsH ? thinW : thinH_dim;
              let pSum = 0, pSumSq = 0;
              for (let p = 0; p < profileLen; p++) {
                let bandSum = 0;
                for (let d = 0; d < thinDepth; d++) {
                  const px = csIsH
                    ? (miss === 'top' ? d : thinH_dim - 1 - d) * thinW + p
                    : p * thinW + (miss === 'left' ? d : thinW - 1 - d);
                  bandSum += thinGray[px];
                }
                const colMean = bandSum / thinDepth;
                pSum   += colMean;
                pSumSq += colMean * colMean;
              }
              const pMean = pSum / profileLen;
              const profileVar = pSumSq / profileLen - pMean * pMean;
              const maxProfileVar = 600;
              console.log(`[frame-boundary] cross-side: ${miss} profile-var=${profileVar.toFixed(0)} (from ${refSide})`);
              if (profileVar > maxProfileVar) {
                console.log(`[frame-boundary] cross-side: ${miss} blocked — shaped content (profile-var=${profileVar.toFixed(0)} > ${maxProfileVar})`);
                continue;
              }
            }
            const matchQuality    = Math.max(0, 1 - Math.abs(cand.mean - refStats.mean) / crossMeanTolerance);
            const crossConfidence = (0.5 + 0.5 * matchQuality) * 0.85;
            const inferredDepth   = Math.round(thinDepth / scaleRatio);
            setByName[miss](inferredDepth, crossConfidence);
            corroboration[refSide].push(matchQuality);
            console.log(`[frame-boundary] cross-side: inferred ${miss}=${inferredDepth} from ${refSide} conf=${crossConfidence.toFixed(2)} edge=${csEdgeDensity.toFixed(2)} (Δmean=${Math.abs(cand.mean - refStats.mean).toFixed(1)}, var=${cand.variance.toFixed(0)})`);
            changed = true;
          }
        } else {
          console.log(`[frame-boundary] cross-side: ${miss} rejected (Δmean=${Math.abs(cand.mean - refStats.mean).toFixed(1)}, var=${cand.variance.toFixed(0)}, refMean=${refStats.mean.toFixed(1)})`);
        }
      }
    }

    // Apply corroboration boost: if ≥ 2 sides were successfully inferred from a
    // reference, those inferences are votes of confidence in the reference's detection.
    // Boost = Σ(matchQuality × 0.10). Requires ≥ 2 to prevent a single weak inference
    // from lifting a false detection over the gate.
    const CORROBORATION_INCREMENT = 0.10;
    for (const side of SIDES) {
      if (corroboration[side].length < 2) continue;
      const boost   = corroboration[side].reduce((s, mq) => s + mq * CORROBORATION_INCREMENT, 0);
      const oldConf = confByName[side]();
      const newConf = Math.min(1.0, oldConf + boost);
      setByName[side](depthByName[side](), newConf);
      console.log(`[frame-boundary] cross-side: corroboration boosted ${side} ${oldConf.toFixed(2)} → ${newConf.toFixed(2)} (${corroboration[side].length} inferences, boost=${boost.toFixed(2)})`);
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

  console.log(`[frame-boundary] crop t=${t}(${confTop.toFixed(2)}) b=${b}(${confBottom.toFixed(2)}) l=${l}(${confLeft.toFixed(2)}) r=${r}(${confRight.toFixed(2)})`);
  return sharp(buffer)
    .extract({ left: l, top: t, width: newW, height: newH })
    .toBuffer();
}

module.exports = { frameBoundaryPreProcessor };
