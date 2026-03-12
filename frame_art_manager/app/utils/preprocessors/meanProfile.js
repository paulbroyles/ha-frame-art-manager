'use strict';

const sharp = require('sharp');

/**
 * Mean Profile pre-processor.
 *
 * Extends the key insight (consistent row means = frame) into an incremental scan
 * that works for any border thickness. The previous version used a fixed edge
 * sampling window that failed when the border was thinner than the window.
 *
 * Key insight: Frames have consistent row/col means across their extent; painting
 * content does not. Scanning incrementally and tracking the running std dev of
 * means lets the algorithm self-terminate at the frame/painting boundary, without
 * needing to know the border width in advance.
 *
 * Algorithm:
 *   1. Compute full-width row means (rowMeans[y]).
 *   2. Top/bottom: scan from each edge inward. For each candidate row, compute the
 *      running std dev of all row means accumulated so far. Stop when including the
 *      next row would push the std dev above consistencyThreshold. Apply a post-scan
 *      contrast check (detected band mean vs. center interior).
 *   3. Left/right: compute col means using a thin strip of rows at the INNER EDGE of
 *      the detected top/bottom frame bands (not the frame rows themselves). Frame rows
 *      are uniform across all columns so they provide no left/right discrimination;
 *      interior-edge rows contain frame material at frame-column positions and painting
 *      content elsewhere. A range guard skips left/right if col means are still flat.
 *
 * Handles any border thickness (1px to wide ornate frames). Works for solid, lightly-
 * textured, and wood/gold-leaf frames. Per-edge independent detection.
 *
 * options.consistencyThreshold (default 35): max allowed deviation of any value from
 *   the reference mean (established from the first few edge values) to continue the scan.
 *   Solid borders: ≈ 5–10. Lightly-textured gold/gilded: ≈ 15–25. Wood grain: ≈ 25–40.
 *   The frame→painting boundary jump is typically 40–80, well above in-frame variation.
 * options.contrastThreshold (default 20): min luminance diff between detected band and interior.
 * options.refFraction (default 0.03): fallback corner-band fraction when no top/bottom frame found.
 * options.maxCropFraction (default 0.18): hard cap per edge (safety guard). Kept at 18%
 *   so that real frames (typically 2–12% of image dimension) are well within the cap, while
 *   scans that reach the cap without a natural stopping point are rejected as runaway false
 *   positives (painting-background regions that look frame-like by row mean alone).
 */
async function meanProfilePreProcessor(buffer, {
  consistencyThreshold = 35,
  contrastThreshold    = 20,
  refFraction          = 0.03,
  maxCropFraction      = 0.18,
  label                = '',
  detectionMode        = 'combined', // 'luminance' | 'color' | 'combined'
} = {}) {
  const _t0 = Date.now();
  const { data, info } = await sharp(buffer)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const _tDecode = Date.now();

  const { width, height, channels } = info;

  function pixelLum(b) {
    return 0.299 * data[b] + 0.587 * data[b + 1] + 0.114 * data[b + 2];
  }

  // Chromaticity distance: how different is this pixel's color (hue) from the interior?
  // Uses normalized RGB so brightness differences don't inflate the score — a dark corner
  // of the same hue as the interior scores near 0, while a gold frame scores 30–60.
  // Scaled by 255 to match the luminance-distance range; contrastThreshold (20) applies.
  // Defined after interiorChR/G/B below; hoisted via function-scoped closure.
  function pixelChromaDist(offset) {
    if (channels < 3) return 0;
    const r = data[offset], g = data[offset + 1], b = data[offset + 2];
    const tot = r + g + b + 0.001;
    const dr = r / tot - interiorChR;
    const dg = g / tot - interiorChG;
    const db = b / tot - interiorChB;
    return Math.sqrt(dr * dr + dg * dg + db * db) * 255;
  }

  function rowMean(y) {
    let sum = 0;
    for (let x = 0; x < width; x++) sum += pixelLum((y * width + x) * channels);
    return sum / width;
  }

  // Within-row luminance variance: mean squared deviation from the row mean.
  function rowVariance(y, mean) {
    let sumSq = 0;
    for (let x = 0; x < width; x++) {
      const d = pixelLum((y * width + x) * channels) - mean;
      sumSq += d * d;
    }
    return sumSq / width;
  }

  // Mean absolute difference between horizontally adjacent pixels (horizontal gradient mean).
  // Captures spatial sharpness: smooth cloudy gradients (frame material) have small
  // pixel-to-pixel differences even when overall variance is high, while structured
  // geometric patterns (rugs, carpets) have large pixel-to-pixel jumps at design boundaries.
  function rowMAD(y) {
    let sum = 0;
    for (let x = 1; x < width; x++) {
      sum += Math.abs(pixelLum((y * width + x) * channels) - pixelLum((y * width + x - 1) * channels));
    }
    return sum / (width - 1);
  }

  // Mean absolute difference between vertically adjacent pixels within the corner bands,
  // for a given column. Measures vertical sharpness/texture within the band.
  function colBandMAD(x, bands) {
    let sum = 0, count = 0;
    for (const [y0, y1] of bands) {
      for (let y = y0 + 1; y < y1; y++) {
        sum += Math.abs(pixelLum((y * width + x) * channels) - pixelLum(((y - 1) * width + x) * channels));
        count++;
      }
    }
    return count > 0 ? sum / count : 0;
  }

  function colMeanInBands(x, bands) {
    let sum = 0, n = 0;
    for (const [y0, y1] of bands) {
      for (let y = y0; y < y1; y++) { sum += pixelLum((y * width + x) * channels); n++; }
    }
    return n > 0 ? sum / n : 0;
  }

  // Median luminance for a column within specified row bands.
  // More robust than mean for wood grain frames: a few bright grain rows within a
  // dark frame column inflate the mean (causing early scan termination) but not the median.
  function colMedianInBands(x, bands) {
    const vals = [];
    for (const [y0, y1] of bands) {
      for (let y = y0; y < y1; y++) { vals.push(pixelLum((y * width + x) * channels)); }
    }
    if (vals.length === 0) return 0;
    vals.sort((a, b) => a - b);
    const mid = Math.floor(vals.length / 2);
    return vals.length % 2 === 0 ? (vals[mid - 1] + vals[mid]) / 2 : vals[mid];
  }

  // Median chromaticity distance (from interior) for a column within specified row bands.
  // Used for color-based L/R detection: detects gold/colored frames with low lum contrast.
  function colChromaMedianInBands(x, bands) {
    const vals = [];
    for (const [y0, y1] of bands) {
      for (let y = y0; y < y1; y++) { vals.push(pixelChromaDist((y * width + x) * channels)); }
    }
    if (vals.length === 0) return 0;
    vals.sort((a, b) => a - b);
    return vals[Math.floor(vals.length / 2)];
  }

  const maxRows = Math.floor(height * maxCropFraction);
  const maxCols = Math.floor(width  * maxCropFraction);

  const rowMeans = Array.from({ length: height }, (_, y) => rowMean(y));
  const rowVariances = rowMeans.map((m, y) => rowVariance(y, m));
  const rowMADs = Array.from({ length: height }, (_, y) => rowMAD(y));

  // Edge column sets for spatial coherence contamination check (T/B scan).
  // For each scanned row, records sorted column positions where the horizontal gradient
  // (|lum(y, x+1) - lum(y, x-1)|) exceeds edgeGradThreshold. Only computed for the
  // scan range (maxRows rows from each edge) to avoid full-image processing.
  //
  // Used in incrementalScan to detect painting content inside frame-apparent rows:
  // a painting subject's vertical boundary (e.g. the edge of a face) creates a consistent
  // horizontal gradient at the same column positions across many consecutive rows.
  // Frame material (uniform colour, random wood grain) produces sparse or inconsistent
  // edge column positions that do not repeat across rows. Three consecutive frame-apparent
  // rows whose edge columns overlap (within ±edgeTolerance px) signal painting content.
  //
  // The same horizontal-gradient formula is reused for L/R coherence (per-column edge
  // row sets), computed after cornerBands is established below.
  // Gradient threshold: only count as an edge if the horizontal luminance change
  // exceeds this value. Grain boundaries in wood frames are subtle (30–60 lum units);
  // painting subject edges against a contrasting background are bold (80–150+ lum units).
  // A higher threshold filters grain while keeping painting content detectable.
  const edgeGradThreshold = 60;
  function rowEdgeCols(y) {
    const cols = [];
    for (let x = 1; x < width - 1; x++) {
      const grad = Math.abs(
        pixelLum((y * width + x + 1) * channels) -
        pixelLum((y * width + x - 1) * channels)
      );
      if (grad > edgeGradThreshold) cols.push(x);
    }
    return cols;
  }
  const topEdgeSets = Array.from({ length: maxRows }, (_, i) => rowEdgeCols(i));
  const botEdgeSets = Array.from({ length: maxRows }, (_, i) => rowEdgeCols(height - 1 - i));

  // Interior reference: center 50% block.
  // Also accumulates R/G/B for a chromaticity color reference used to detect
  // color-distinct frames (e.g. gold) that have low luminance contrast.
  let iSum = 0, iSumR = 0, iSumG = 0, iSumB = 0, iN = 0;
  const iy0 = Math.round(height * 0.25), iy1 = Math.round(height * 0.75);
  const ix0 = Math.round(width  * 0.25), ix1 = Math.round(width  * 0.75);
  for (let y = iy0; y < iy1; y++) {
    for (let x = ix0; x < ix1; x++) {
      const off = (y * width + x) * channels;
      iSum += pixelLum(off);
      if (channels >= 3) { iSumR += data[off]; iSumG += data[off + 1]; iSumB += data[off + 2]; }
      iN++;
    }
  }
  const interiorMean = iSum / iN;
  // Interior chromaticity: normalized RGB removes brightness, leaving hue/color signal.
  // Scaling by 255 puts chromaDist values in the same range as luminance distances so
  // contrastThreshold (20) applies directly to both.
  const iColorR = channels >= 3 ? iSumR / iN : 128;
  const iColorG = channels >= 3 ? iSumG / iN : 128;
  const iColorB = channels >= 3 ? iSumB / iN : 128;
  const iColorTot = iColorR + iColorG + iColorB + 0.001;
  const interiorChR = iColorR / iColorTot;
  const interiorChG = iColorG / iColorTot;
  const interiorChB = iColorB / iColorTot;
  // Color row profile: mean chromaticity distance per row, sampled every 4 columns for speed.
  // Computed after interiorChR/G/B since pixelChromaDist reads those values.
  const rowChromaScores = channels >= 3
    ? Array.from({ length: height }, (_, y) => {
        let sum = 0, n = 0;
        for (let x = 0; x < width; x += 4) { sum += pixelChromaDist((y * width + x) * channels); n++; }
        return n > 0 ? sum / n : 0;
      })
    : null;
  const _tRowMeans = Date.now();

  if (label) console.log(`[mean_profile] source: ${label}`);
  console.log(`[mean_profile] image ${width}×${height}, interiorMean=${interiorMean.toFixed(1)}, consistencyThreshold=${consistencyThreshold}, contrastThreshold=${contrastThreshold}`);

  // Returns true if sorted arrays a and b share at least one value within ±tol.
  // Two-pointer O(m+n) — avoids O(m×n) naive comparison.
  function edgesOverlap(a, b, tol) {
    let j = 0;
    for (let i = 0; i < a.length; i++) {
      while (j < b.length && b[j] < a[i] - tol) j++;
      if (j < b.length && b[j] <= a[i] + tol) return true;
    }
    return false;
  }

  // Scan values[] from index 0 inward. Extends while each new value is within
  // consistencyThreshold of a reference mean established from the first few edge values.
  // This handles frames with internal texture (wood grain ≈ ±20 variation) while
  // stopping at the sharper frame/painting boundary (typically ±40–80 jump).
  // Requires a minimum band size (5), a natural stopping point (runaway guard),
  // and a contrast check against interiorMean.
  function incrementalScan(values, maxN, label, thresholdOverride = null, contrastOverride = null, varValues = null, madValues = null, edgeSets = null) {
    if (maxN < 5 || values.length < 5) return 0;
    // Reference mean from the first few values (outermost edge — always frame material
    // after solidBorderStrip). More robust than running stdDev for wood grain frames.
    const initN = Math.min(5, Math.floor(maxN / 2));
    const refMean = values.slice(0, initN).reduce((s, v) => s + v, 0) / initN;
    // Hysteresis: require 3 consecutive outliers before stopping, so that isolated
    // bright grain columns within a textured frame don't prematurely end the scan.
    // Only a sustained run of high-deviation values (as seen at the frame/painting
    // boundary) triggers a stop.
    const hysteresisN = 3;
    // thresholdOverride allows callers to demand a higher stopping threshold for
    // L/R scans when both T/B bands fell back to edge rows (unreliable band placement).
    // In that situation a stricter threshold reduces false positives from borderline
    // column means whose stopping deviation is just barely above consistencyThreshold.
    const threshold = thresholdOverride ?? consistencyThreshold;
    // Variance-based supplementary stopping condition (relative check).
    // Fires when a row's variance is much higher than the edge reference — catches cases
    // where edge is uniform and painting content is much more varied.
    const varMultiplier = 8;
    const refVar = varValues ? varValues.slice(0, initN).reduce((s, v) => s + v, 0) / initN : 0;
    const varCheckActive = varValues !== null && refVar >= 5;
    // MAD-based supplementary stopping condition.
    // Mean Absolute Difference between adjacent pixels captures spatial sharpness:
    // smooth cloudy gradients (frame material) have low MAD even with high overall variance,
    // while structured geometric patterns (rugs, carpets) have high MAD at design boundaries.
    // This distinguishes "high variance from smooth gradients" (frame) from
    // "high variance from sharp geometric transitions" (painting pattern content).
    const refMAD = madValues ? madValues.slice(0, initN).reduce((s, v) => s + v, 0) / initN : 0;
    const madCheckActive = madValues !== null;
    // Spatial coherence contamination check: detects painting content hiding in
    // frame-apparent rows/columns by checking whether consecutive frame-apparent
    // positions share consistent horizontal-gradient edge positions (within ±edgeTolerance).
    //
    // Frame material (uniform colour, wood grain) produces sparse or randomly varying
    // edge positions — grain boundaries shift row-to-row so overlap across three
    // consecutive rows is extremely rare.
    //
    // Painting subjects create a persistent vertical or horizontal boundary: e.g. the
    // edge of a face appears at the same column positions across many consecutive rows
    // (T/B scan), or at the same row positions across many consecutive columns (L/R scan).
    // Three consecutive frame-apparent positions whose edge sets overlap within ±tolerance
    // signal painting content → reject the crop band.
    //
    // Fires only on positions that pass the main dev/var/mad checks (appear frame-like),
    // so it does NOT interfere with the normal frame/painting boundary stop.
    // Suppress coherence check if any reference position already contains bold edges.
    // Reference-row edges mean the frame material itself is textured (e.g. wood grain,
    // ornate structure). In that case the main mean/MAD/variance checks are sufficient
    // to find the frame/painting boundary, and coherence would fire on the frame's own
    // texture rather than on painting contamination.
    // The check is only meaningful when reference rows are completely smooth (uniform dark
    // background with no edges) — the no-frame contamination case where painting content
    // (e.g. a face against a dark background) would not otherwise stop the scan.
    let edgeCheckActive = edgeSets !== null &&
      !edgeSets.slice(0, initN).some(e => e.length > 0);
    const edgeTolerance = 5; // ± position tolerance for edge match (handles slight shift)
    const coherenceN    = 3; // consecutive overlapping positions to trigger rejection
    let prevEdges  = null;
    let edgeRunLen = 0;
    if (varValues) console.log(`[mean_profile] ${label}: varProfile(0-${Math.min(24, maxN)-1})=[${varValues.slice(0, Math.min(25, maxN)).map(v => Math.round(v)).join(',')}]`);
    if (madValues) console.log(`[mean_profile] ${label}: madProfile(0-${Math.min(24, maxN)-1})=[${madValues.slice(0, Math.min(25, maxN)).map(v => v.toFixed(1)).join(',')}]`);
    if (edgeSets) console.log(`[mean_profile] ${label}: refEdgeCounts(0-${initN-1})=[${edgeSets.slice(0, initN).map(e => e.length).join(',')}] edgeCheck=${edgeCheckActive}`);
    let lastGoodIdx = initN - 1, consecutiveOutliers = 0;
    let stopIdx = -1;
    for (let i = initN; i < Math.min(maxN, values.length); i++) {
      const dev = Math.abs(values[i] - refMean);
      const varOutlier = varCheckActive && varValues[i] > refVar * varMultiplier;
      // MAD outlier: row has sharper pixel-to-pixel transitions than the edge reference or
      // an absolute ceiling, indicating structured painting content rather than frame material.
      //   Relative check (refMAD × 8): catches smooth-edged frames where painting content
      //     has proportionally much higher spatial sharpness (e.g. near-black canvas edge →
      //     dark painting background with moderate texture). Gate at refMAD ≥ 0.5 avoids
      //     applying to truly featureless edges where threshold would be near zero.
      //   Absolute check (madAbsThreshold=9): catches cases where refMAD is already elevated
      //     (frame itself is textured/cloudy) and painting content has clearly higher sharpness
      //     (e.g. gray-brown cloudy frame edge → structured geometric rug pattern). Three
      //     consecutive outliers required (hysteresis) — one or two partial rows as the scan
      //     crosses an uneven frame boundary are tolerated.
      const madAbsThreshold = 9;
      const madOutlier = madCheckActive && (
        madValues[i] > madAbsThreshold ||
        (refMAD >= 0.5 && madValues[i] > refMAD * varMultiplier)
      );
      if (dev < threshold && !varOutlier && !madOutlier) {
        consecutiveOutliers = 0;
        lastGoodIdx = i;
        // Spatial coherence contamination check (frame-apparent branch only).
        if (edgeCheckActive) {
          const curEdges = edgeSets[i];
          if (curEdges.length > 0 && prevEdges !== null && edgesOverlap(curEdges, prevEdges, edgeTolerance)) {
            edgeRunLen++;
            if (edgeRunLen >= coherenceN) {
              console.log(`[mean_profile] ${label}: coherence contamination — ${edgeRunLen} consecutive frame-apparent positions share edge positions (edgeCount=${curEdges.length}) → painting content — REJECTED`);
              return 0;
            }
          } else {
            edgeRunLen = 0;
          }
          prevEdges = curEdges.length > 0 ? curEdges : null;
        }
      } else {
        consecutiveOutliers++;
        edgeRunLen = 0;  // outlier breaks the coherence run
        prevEdges = null;
        if (consecutiveOutliers >= hysteresisN) {
          stopIdx = lastGoodIdx + 1;
          break;
        }
      }
    }
    const crop = lastGoodIdx + 1;
    if (crop < 5) {
      console.log(`[mean_profile] ${label}: scan found only ${crop} rows (need ≥5), refMean=${refMean.toFixed(1)}`);
      return 0;
    }
    // Runaway guard: if the scan ran all the way to the cap with no natural stopping point,
    // the crop is bounded by maxN not by image content — reject.
    if (stopIdx < 0) {
      console.log(`[mean_profile] ${label}: scan ran to cap (${crop}px, refMean=${refMean.toFixed(1)}) — REJECTED (runaway)`);
      return 0;
    }
    // Use refMean (initial edge values, most clearly frame-colored) for the contrast check
    // rather than bandMean. bandMean gets diluted by rows near the frame/painting boundary
    // whose values trend toward interior; refMean reflects the actual frame color.
    const bandMean = values.slice(0, crop).reduce((s, v) => s + v, 0) / crop;
    const contrast = Math.abs(refMean - interiorMean);
    // contrastOverride: for non-luminance profiles (e.g. chroma scans) where refMean
    // is not a luminance value and |refMean - interiorMean| is meaningless. The override
    // supplies a pre-computed contrast scalar (e.g. outer-edge chroma distance) directly.
    const effectiveContrast = contrastOverride !== null ? contrastOverride : contrast;
    const passed = effectiveContrast > contrastThreshold;
    const bandVar = varCheckActive ? varValues.slice(0, crop).reduce((s, v) => s + v, 0) / crop : null;
    const bandMAD = madCheckActive ? madValues.slice(0, crop).reduce((s, v) => s + v, 0) / crop : null;
    console.log(`[mean_profile] ${label}: crop=${crop}px, refMean=${refMean.toFixed(1)}, bandMean=${bandMean.toFixed(1)}, contrast=${contrast.toFixed(1)}${contrastOverride !== null ? ` chromaContrast=${contrastOverride.toFixed(1)}` : ''}${varCheckActive ? ` refVar=${refVar.toFixed(1)} bandVar=${bandVar.toFixed(1)}` : ''}${madCheckActive ? ` refMAD=${refMAD.toFixed(1)} bandMAD=${bandMAD.toFixed(1)}` : ''} (need >${contrastThreshold}) → ${passed ? 'CROP' : 'REJECTED (low contrast)'}`);
    return passed ? crop : 0;
  }

  // Per-column frame boundary scan for bevel-continuation zones.
  //
  // WHY PER-COLUMN: incrementalScan uses row means, which work well for uniform or
  // wood-grain frames but fail for ornate frames (e.g. gold) whose internal luminance
  // variation exceeds the consistency threshold before reaching the actual frame/painting
  // boundary. Per-column analysis avoids this because:
  //
  //   1. "Last frame-side" detection: for each column, scan ALL rows in the zone and
  //      find the LAST row that is on the frame side of the midpoint (closer in luminance
  //      to the per-column edge reference than to interiorMean). Internal dark zones
  //      within an ornate frame (carved crevices, bevels between molding elements) are
  //      interior-side in isolation, but the frame material resumes after them — so the
  //      last frame-side row correctly lands at the actual frame/painting boundary rather
  //      than stopping at the first dark zone encountered.
  //
  //      Example: gold | crevice | gold | crevice | gold | DARK PAINTING
  //               frame  interior  frame  interior  frame   interior (permanent)
  //               last frame-side = last gold row before painting → correct boundary ✓
  //
  //   2. Percentile aggregation: frames are roughly (not strictly) horizontal. Individual
  //      column boundaries vary by a few pixels due to slight frame tilt, ornamentation,
  //      or paint partially covering the frame edge. The median (50th percentile) of all
  //      column boundaries is stable against these outliers.
  //
  //   3. Runaway guard: columns where frame-like material extends to the end of the scan
  //      zone (last frame-side row is within tailZone of the cap) are excluded — they
  //      failed to find a clear boundary and would inflate the result.
  //
  //   4. Direction: yStep=+1 scans downward (top continuation), yStep=-1 scans upward
  //      (bottom continuation). Returns the offset from startRow at which the frame
  //      ends, for the caller to add to cropTop/cropBottom.
  // minEdgeLum: skip columns whose per-column edge reference is below this luminance.
  //
  // adaptiveRef: when true, scan each column forward from startRow to find the first row
  // where |lum - interiorMean| >= contrastThreshold before computing colEdgeMean. This
  // is used by bevel continuation where startRow is still in the transition zone between
  // the near-black outer bevel and the actual frame material (e.g. gold). Without adaptive
  // ref, colEdgeMean is computed from the transition zone (lum 20–80), which sets
  // edgeBrighter=false and misclassifies bright gold as interior-side. With adaptive ref,
  // colEdgeMean is computed from the first solidly frame-material rows per column, so
  // edgeBrighter is set correctly regardless of frame brightness.
  //
  // Columns where no clearly-frame row is found within refScanLimit rows fall back to
  // refStartDr=0 (dark frame path: bevel rows as reference, edgeBrighter=false, works for
  // dark wood frames on bright paintings).
  function columnPercentileScan(startRow, maxCropN, yStep, label, minEdgeLum = 0, adaptiveRef = false) {
    const refRows       = 5;
    const refScanLimit  = 40; // max rows to search for adaptive reference per column
    const columnStep    = 16;
    const tailZone      = 10;
    const pct           = 0.65;

    const boundaries = [];
    for (let x = 0; x < width; x += columnStep) {
      // Determine per-column reference start row.
      // When adaptiveRef=true, scan forward to find the first row in bright frame material
      // (lum >= interiorMean + contrastThreshold). This places colEdgeMean in the solid
      // gold zone so edgeBrighter=true, rather than in the dark transition zone where
      // edgeBrighter=false misclassifies bright gold pixels as interior-side.
      // If no bright row is found within refScanLimit, refStartDr stays 0 — this is the
      // correct fallback for dark frames (bevel rows as reference, edgeBrighter=false).
      let refStartDr = 0;
      if (adaptiveRef) {
        for (let dr = 0; dr < Math.min(maxCropN, refScanLimit); dr++) {
          const y = startRow + yStep * dr;
          if (y < 0 || y >= height) break;
          if (pixelLum((y * width + x) * channels) >= interiorMean + contrastThreshold) {
            refStartDr = dr;
            break;
          }
        }
      }

      // Per-column reference mean from refRows rows starting at refStartDr.
      let colEdgeMean = 0;
      let refCount = 0;
      for (let dr = refStartDr; dr < refStartDr + refRows; dr++) {
        const y = startRow + yStep * dr;
        if (y >= 0 && y < height) { colEdgeMean += pixelLum((y * width + x) * channels); refCount++; }
      }
      if (refCount === 0) continue;
      colEdgeMean /= refCount;
      if (colEdgeMean < minEdgeLum) continue;
      if (Math.abs(colEdgeMean - interiorMean) <= contrastThreshold) continue;

      const midPoint     = (colEdgeMean + interiorMean) / 2;
      const edgeBrighter = colEdgeMean > interiorMean;

      // Scan rows in zone; track the last row on the frame side.
      // Stop updating once a sustained run of interior-side rows is seen: this
      // tolerates short frame crevices without overshooting into painting content.
      const maxInteriorRun = Math.max(8, Math.round(height * 0.006));
      let lastFrameSide = refStartDr + refRows - 1; // reference rows are by definition frame-side
      let interiorRunLen = 0;
      for (let dr = refStartDr + refRows; dr < maxCropN; dr++) {
        const y = startRow + yStep * dr;
        if (y < 0 || y >= height) break;
        const val = pixelLum((y * width + x) * channels);
        if (edgeBrighter ? val >= midPoint : val <= midPoint) {
          lastFrameSide = dr;
          interiorRunLen = 0;
        } else {
          interiorRunLen++;
          if (interiorRunLen >= maxInteriorRun) break;
        }
      }

      // Runaway guard: frame-like material extended to the cap — no clear boundary found.
      if (lastFrameSide >= maxCropN - tailZone) continue;

      boundaries.push(lastFrameSide + 1); // crop starts after the last frame-side row
    }

    if (boundaries.length < 3) {
      console.log(`[mean_profile] ${label}: column scan — only ${boundaries.length} column(s) gave a boundary (need ≥3)`);
      return 0;
    }
    boundaries.sort((a, b) => a - b);
    const crop = boundaries[Math.min(Math.floor(boundaries.length * pct), boundaries.length - 1)];
    console.log(`[mean_profile] ${label}: column scan — ${boundaries.length} cols, range=[${boundaries[0]}..${boundaries[boundaries.length - 1]}], P${Math.round(pct * 100)}=${crop}px`);
    return crop;
  }

  // Per-row frame boundary scan for bevel-continuation zones — horizontal counterpart
  // to columnPercentileScan. Scans each row left-to-right (xStep=+1, left continuation)
  // or right-to-left (xStep=-1, right continuation), tracking the last column on the
  // frame side of the per-row midpoint, then takes the P65 of all row boundaries.
  // adaptiveRef works identically: scans forward per row to find the first column with
  // lum >= interiorMean + contrastThreshold, anchoring the reference in solid frame
  // material rather than a near-black transition bevel.
  function rowPercentileScan(startCol, maxCropN, xStep, label, minEdgeLum = 0, adaptiveRef = false, startY = 0, endY = height, minParticipation = 0) {
    const refCols       = 5;
    const refScanLimit  = 40;
    const rowStep       = 16;
    const tailZone      = 10;
    const pct           = 0.65;

    const boundaries = [];
    let sampledRows = 0;
    for (let y = startY; y < endY; y += rowStep) {
      sampledRows++;
      let refStartDc = 0;
      if (adaptiveRef) {
        for (let dc = 0; dc < Math.min(maxCropN, refScanLimit); dc++) {
          const x = startCol + xStep * dc;
          if (x < 0 || x >= width) break;
          if (pixelLum((y * width + x) * channels) >= interiorMean + contrastThreshold) {
            refStartDc = dc;
            break;
          }
        }
      }

      let rowEdgeMean = 0;
      let refCount = 0;
      for (let dc = refStartDc; dc < refStartDc + refCols; dc++) {
        const x = startCol + xStep * dc;
        if (x >= 0 && x < width) { rowEdgeMean += pixelLum((y * width + x) * channels); refCount++; }
      }
      if (refCount === 0) continue;
      rowEdgeMean /= refCount;
      if (rowEdgeMean < minEdgeLum) continue;
      if (Math.abs(rowEdgeMean - interiorMean) <= contrastThreshold) continue;

      const midPoint     = (rowEdgeMean + interiorMean) / 2;
      const edgeBrighter = rowEdgeMean > interiorMean;

      const maxInteriorRun = Math.max(8, Math.round(width * 0.006));
      let lastFrameSide = refStartDc + refCols - 1;
      let interiorRunLen = 0;
      for (let dc = refStartDc + refCols; dc < maxCropN; dc++) {
        const x = startCol + xStep * dc;
        if (x < 0 || x >= width) break;
        const val = pixelLum((y * width + x) * channels);
        if (edgeBrighter ? val >= midPoint : val <= midPoint) {
          lastFrameSide = dc; interiorRunLen = 0;
        } else {
          interiorRunLen++;
          if (interiorRunLen >= maxInteriorRun) break;
        }
      }

      if (lastFrameSide >= maxCropN - tailZone) continue;
      boundaries.push(lastFrameSide + 1);
    }

    if (boundaries.length < 3) {
      console.log(`[mean_profile] ${label}: row scan — only ${boundaries.length} row(s) gave a boundary (need ≥3)`);
      return 0;
    }
    if (minParticipation > 0 && sampledRows > 0 && boundaries.length / sampledRows < minParticipation) {
      console.log(`[mean_profile] ${label}: row scan rejected — participation ${boundaries.length}/${sampledRows} (${(boundaries.length / sampledRows * 100).toFixed(0)}%) < ${(minParticipation * 100).toFixed(0)}% minimum — painting content`);
      return 0;
    }
    boundaries.sort((a, b) => a - b);
    const crop = boundaries[Math.min(Math.floor(boundaries.length * pct), boundaries.length - 1)];
    console.log(`[mean_profile] ${label}: row scan — ${boundaries.length}/${sampledRows} rows (${(boundaries.length / sampledRows * 100).toFixed(0)}%), range=[${boundaries[0]}..${boundaries[boundaries.length - 1]}], P${Math.round(pct * 100)}=${crop}px`);
    return crop;
  }

  // Top and bottom: scan using full-width row means.
  // Pass rowVariances as supplementary signal: rows with high within-row variance are
  // painting content (structured patterns), not frame material, even if their mean is close
  // to the edge reference. The reversed variance array mirrors the reversed means array.
  let cropTop    = detectionMode !== 'color' ? incrementalScan(rowMeans, maxRows, 'top', null, null, rowVariances, rowMADs, topEdgeSets) : 0;
  let cropBottom = detectionMode !== 'color' ? incrementalScan([...rowMeans].reverse(), maxRows, 'bottom', null, null, [...rowVariances].reverse(), [...rowMADs].reverse(), botEdgeSets) : 0;

  // Supplementary color-based T/B scan: detects frames with distinct color but low
  // luminance contrast (e.g. thin gold frames near interior brightness). Runs only when
  // the luminance scan returned 0. Uses rowChromaScores (mean chromaticity distance per
  // row) with a tighter loop threshold (15, calibrated to the 0-50 chroma range) and a
  // contrastOverride (outer-edge chroma score) for the final acceptance gate.
  // The chroma-distance approach is inherently robust against dark painting edges:
  // those have near-zero chroma distance (same hue as interior) so the acceptance
  // gate (edgeChromaScore > contrastThreshold) naturally rejects them.
  // Supplementary color-based T/B scan. chromaGate is stricter than contrastThreshold
  // to avoid false detections on warm-toned painting edges (chroma 15–25); gold frames
  // typically score 30–60 and comfortably exceed the gate.
  if (rowChromaScores && detectionMode !== 'luminance') {
    const chromaInitN = Math.min(5, Math.floor(maxRows / 2));
    const chromaGate = contrastThreshold * 1.5; // 30 when contrastThreshold=20
    if (cropTop === 0) {
      const topEdgeChroma = rowChromaScores.slice(0, chromaInitN).reduce((s, v) => s + v, 0) / chromaInitN;
      if (topEdgeChroma > chromaGate) {
        const colorCrop = incrementalScan(rowChromaScores, maxRows, 'top-color', 15, topEdgeChroma);
        if (colorCrop > 0) { console.log(`[mean_profile] top: color scan detected ${colorCrop}px (chromaEdge=${topEdgeChroma.toFixed(1)})`); cropTop = colorCrop; }
      }
    }
    if (cropBottom === 0) {
      const botChromaRev = [...rowChromaScores].reverse();
      const botEdgeChroma = botChromaRev.slice(0, chromaInitN).reduce((s, v) => s + v, 0) / chromaInitN;
      if (botEdgeChroma > chromaGate) {
        const colorCrop = incrementalScan(botChromaRev, maxRows, 'bottom-color', 15, botEdgeChroma);
        if (colorCrop > 0) { console.log(`[mean_profile] bottom: color scan detected ${colorCrop}px (chromaEdge=${botEdgeChroma.toFixed(1)})`); cropBottom = colorCrop; }
      }
    }
  }

  // Bevel continuation: if the primary scan stopped because a near-black outer bevel set
  // refMean very low, continue from the bevel end using per-column midpoint classification
  // (columnPercentileScan) rather than incrementalScan. incrementalScan's consistency
  // threshold fails for ornate frames (e.g. gold) whose internal luminance variation
  // exceeds the threshold before reaching the actual frame/painting boundary. Column-
  // level midpoint classification is robust to that variation; see function comment above.
  //
  // Bevel continuation trigger: if the outer frame band's row mean is below this threshold,
  // the initial incrementalScan established refMean in a dark transition zone (outer bevel
  // or dark band) rather than the main frame body. The per-column classifier handles the
  // rest of the frame correctly. Threshold of 50 covers both near-black outer bevels
  // (refMean < 20, e.g. ornate gold frames) and medium-dark outer bands (refMean 20–50,
  // e.g. multi-zone ornate frames where a dark strip precedes a brighter frame body).
  const bevelThreshold  = 50;
  // minEdgeLum for columnPercentileScan: skip columns whose per-column edge reference
  // mean is too dark to give a reliable midpoint. Kept at 20 regardless of bevelThreshold
  // so that the column scan can handle dark-band columns (mean 20–50) correctly.
  const bevelMinEdgeLum = 20;
  // Size guard: reject bevel continuation if extSimple exceeds 7% of image height.
  // This allows genuine large ornate frames (e.g. 133px on a 3039px image = 4.4%) while
  // still rejecting runaway false positives (painting content misclassified as frame).
  // False positives from the column scan tend to be very large (> 10%) because the
  // classifier runs through painting content with no clear frame boundary.
  const bevelMaxExtFrac = 0.07;
  const initN = Math.min(5, Math.floor(maxRows / 2));

  // cropTopForBand / cropBottomForBand: used for L/R band computation and T/B-backed
  // estimate. These are set by the NON-adaptive bevel continuation pass (same ext as
  // the stable "great progress" version), keeping the band boundaries stable regardless
  // of how much the adaptive ref pass adds for the actual crop. Without this separation,
  // the adaptive ref's larger cropTop shifts `estimate` and the band start, which changes
  // refMean for the right ext scan by ~12 units and causes it to miss the frame boundary.
  let cropTopForBand    = cropTop;
  let cropBottomForBand = cropBottom;
  // MAD threshold for bevel continuation: if the extension rows have painting-level
  // within-row MAD, reject the extension. MAD (median absolute deviation) is used instead
  // of variance because textured frames (wood grain) have high variance due to sparse
  // bright outliers, but low MAD because the median pixel is still close to the frame color.
  // Painting content has high MAD (many diverse luminance values). Threshold 5 separates
  // frame material (MAD typically 0.5–4) from painting content (MAD typically 5–20+).
  const bevelExtMADThreshold = 5;
  {
    const topRefMean = rowMeans.slice(0, initN).reduce((s, v) => s + v, 0) / initN;
    if (cropTop > 0 && topRefMean < bevelThreshold && detectionMode !== 'color') {
      const maxBevelExt = Math.round(height * 0.12);
      const scanN = Math.min(maxRows - cropTop, maxBevelExt);
      // Pass 1 (no adaptiveRef): stable result used to anchor the L/R band.
      const extSimple = columnPercentileScan(cropTop, scanN, +1, 'top-bevel-cont', bevelMinEdgeLum, false);
      // Size guard: implausibly large extension means the classifier hit painting content.
      if (extSimple > Math.round(height * bevelMaxExtFrac)) {
        console.log(`[mean_profile] top: bevel continuation rejected (extSimple=${extSimple}px > ${Math.round(height * bevelMaxExtFrac)}px limit, no clear frame boundary)`);
      } else if (extSimple > 0) {
        // Variance gate: check only the first few rows immediately past the current crop
        // boundary. If those rows are painting content (high variance), the bevel extension
        // is wrong. Checking the full extension would be diluted by low-variance rows deeper
        // in a uniform dark background, masking the true boundary signal.
        const extCheckN = Math.min(5, extSimple);
        const extMADMean = rowMADs.slice(cropTop, cropTop + extCheckN).reduce((s, v) => s + v, 0) / extCheckN;
        if (extMADMean > bevelExtMADThreshold) {
          console.log(`[mean_profile] top: bevel continuation rejected (extMADMean=${extMADMean.toFixed(1)} > ${bevelExtMADThreshold} — painting content)`);
        } else {
          cropTopForBand = cropTop + extSimple;
          // Pass 2 (adaptiveRef): finds the actual frame/painting boundary for the crop.
          const ext = columnPercentileScan(cropTop, scanN, +1, 'top-bevel-cont-adaptive', bevelMinEdgeLum, true);
          // Ratio guard + size guard on bestExt: if the adaptive pass returns more than 3×
          // the non-adaptive result, it has likely latched onto painting content rather than
          // the true frame boundary (the adaptive reference search found a bright painting
          // region instead of bright frame material). Fall back to stable extSimple in that
          // case. Also cap by the absolute size limit to catch remaining outliers.
          const bevelLimit = Math.round(height * bevelMaxExtFrac);
          const rawBest = Math.max(extSimple, ext);
          const bestExt = (rawBest > extSimple * 4 || rawBest > bevelLimit) ? extSimple : rawBest;
          if (bestExt > 0) { console.log(`[mean_profile] top: bevel continuation simple=${extSimple}px adaptive=${ext}px → using ${bestExt}px → ${cropTop + bestExt}px total`); cropTop += bestExt; }
        }
      }
    }
  }
  {
    const botRefMean = rowMeans.slice(height - initN).reduce((s, v) => s + v, 0) / initN;
    if (cropBottom > 0 && botRefMean < bevelThreshold && detectionMode !== 'color') {
      const maxBevelExt = Math.round(height * 0.12);
      const scanN = Math.min(maxRows - cropBottom, maxBevelExt);
      const extSimple = columnPercentileScan(height - 1 - cropBottom, scanN, -1, 'bottom-bevel-cont', bevelMinEdgeLum, false);
      // Size guard: implausibly large extension means the classifier hit painting content.
      if (extSimple > Math.round(height * bevelMaxExtFrac)) {
        console.log(`[mean_profile] bottom: bevel continuation rejected (extSimple=${extSimple}px > ${Math.round(height * bevelMaxExtFrac)}px limit, no clear frame boundary)`);
      } else if (extSimple > 0) {
        // Variance gate: reject extension if the extended rows have painting-level variance.
        const extCheckN = Math.min(5, extSimple);
        const extStart = height - cropBottom - extSimple;
        const extMADMean = rowMADs.slice(extStart, extStart + extCheckN).reduce((s, v) => s + v, 0) / extCheckN;
        if (extMADMean > bevelExtMADThreshold) {
          console.log(`[mean_profile] bottom: bevel continuation rejected (extMADMean=${extMADMean.toFixed(1)} > ${bevelExtMADThreshold} — painting content)`);
        } else {
          cropBottomForBand = cropBottom + extSimple;
          const ext = columnPercentileScan(height - 1 - cropBottom, scanN, -1, 'bottom-bevel-cont-adaptive', bevelMinEdgeLum, true);
          const bevelLimit = Math.round(height * bevelMaxExtFrac);
          const rawBest = Math.max(extSimple, ext);
          const bestExt = (rawBest > extSimple * 4 || rawBest > bevelLimit) ? extSimple : rawBest;
          if (bestExt > 0) { console.log(`[mean_profile] bottom: bevel continuation simple=${extSimple}px adaptive=${ext}px → using ${bestExt}px → ${cropBottom + bestExt}px total`); cropBottom += bestExt; }
        }
      }
    }
  }
  const _tTB = Date.now();

  // Left and right: col means restricted to rows at the INNER EDGE of the detected frame
  // bands, not the frame rows themselves. Frame rows are uniform across all columns (all
  // gold, or all black) so col means computed through them cannot distinguish frame columns
  // from painting columns. Interior-edge rows contain frame material at left/right column
  // positions and painting content at center positions — making col means discriminating.
  // Fall back to edge rows when no top/bottom frame was detected.
  const refRows = Math.max(3, Math.round(height * refFraction));
  const topInner = cropTopForBand    > 0
    ? [cropTopForBand,              Math.min(cropTopForBand    + refRows, Math.floor(height / 2))]
    : [0,                    refRows];
  const botInner = cropBottomForBand > 0
    ? [Math.max(height - cropBottomForBand - refRows, Math.ceil(height / 2)), height - cropBottomForBand]
    : [height - refRows,     height];
  const cornerBands    = [topInner, botInner];
  // Use col median (not mean) for L/R detection: robust against isolated bright grain
  // columns within a dark wood frame that inflate the mean and cause early scan termination.
  const cornerColMeans = Array.from({ length: width }, (_, x) => colMedianInBands(x, cornerBands));
  const cornerColBandMADs = Array.from({ length: width }, (_, x) => colBandMAD(x, cornerBands));
  // Parallel chroma profile for color-based L/R detection: median chromaticity distance
  // per column within the same corner bands. Only computed for colour images.
  const cornerColChromaScores = channels >= 3
    ? Array.from({ length: width }, (_, x) => colChromaMedianInBands(x, cornerBands))
    : null;
  const _tColMedians = Date.now();
  console.log(`[mean_profile] colMeansProfile(0-${Math.min(24, maxCols)-1})=[${cornerColMeans.slice(0, Math.min(25, maxCols)).map(v => v.toFixed(1)).join(',')}]`);
  console.log(`[mean_profile] colBandMADProfile(0-${Math.min(24, maxCols)-1})=[${cornerColBandMADs.slice(0, Math.min(25, maxCols)).map(v => v.toFixed(1)).join(',')}]`);

  // Guard: if col medians are nearly flat across all columns the bands are still
  // non-discriminating — skip left/right rather than produce false positives.
  const colMeansMin = cornerColMeans.reduce((a, v) => Math.min(a, v),  Infinity);
  const colMeansMax = cornerColMeans.reduce((a, v) => Math.max(a, v), -Infinity);
  const colMeansDiscriminating = (colMeansMax - colMeansMin) >= 5;
  console.log(`[mean_profile] col medians range=${( colMeansMax - colMeansMin).toFixed(1)} (bands top=${JSON.stringify(topInner)}, bot=${JSON.stringify(botInner)})${colMeansDiscriminating ? '' : ' → SKIPPING left/right (non-discriminating)'}`);

  // When both T/B bands fell back to edge rows (no T/B frame detected), the corner bands
  // use literal image-edge rows rather than the inner-edge of a detected frame. Those edge
  // rows can contain dark painting content (ceiling, wall, floor, dark background) whose
  // column medians look like frame material to incrementalScan. This causes large false-
  // positive L/R crops (e.g. 538px on an image with no left frame) because the dark corner
  // band rows run through painting content with no clear frame/painting boundary.
  //
  // Two-part guard when T/B are both in edge-row fallback:
  //   1. Stricter consistency threshold (45 vs 35): rejects borderline stopping points.
  //   2. Size cap (3% of width): real thin frames detected via edge-row fallback are
  //      typically < 15px. A result of 3%+ is almost always dark painting content. This
  //      mirrors the bevel continuation size guard and is similarly calibrated.
  const MIN_RELIABLE_CROP = 10;
  const strictLR = cropTopForBand < MIN_RELIABLE_CROP && cropBottomForBand < MIN_RELIABLE_CROP;
  const lrMaxCrop = strictLR ? Math.round(width * 0.03) : Infinity;
  if (strictLR) console.log(`[mean_profile] L/R: T/B bands unreliable (top=${cropTopForBand}px, bot=${cropBottomForBand}px < ${MIN_RELIABLE_CROP}px) — strict mode (threshold=45, maxCrop=${lrMaxCrop}px)`);
  // Adaptive consistency threshold for L/R: when the outer frame reference is near-black
  // (refMean < half the default consistencyThreshold), tighten the threshold proportionally.
  // Near-black frames transitioning to even moderately dark painting backgrounds benefit
  // from a narrower band. Gold/bright frames are unaffected (formula hits the 35 cap).
  const initColRefN = Math.min(5, Math.floor(maxCols / 2));
  const leftEdgeRefMean  = cornerColMeans.slice(0, initColRefN).reduce((s, v) => s + v, 0) / initColRefN;
  const rightEdgeRefMean = cornerColMeans.slice(-initColRefN).reduce((s, v) => s + v, 0) / initColRefN;
  const lrThresholdLeft  = strictLR ? 45 : Math.min(consistencyThreshold, Math.max(15, Math.round(leftEdgeRefMean  * 2)));
  const lrThresholdRight = strictLR ? 45 : Math.min(consistencyThreshold, Math.max(15, Math.round(rightEdgeRefMean * 2)));
  if (!strictLR && (lrThresholdLeft !== consistencyThreshold || lrThresholdRight !== consistencyThreshold)) {
    console.log(`[mean_profile] L/R: adaptive threshold — left refMean=${leftEdgeRefMean.toFixed(1)} → threshold=${lrThresholdLeft}, right refMean=${rightEdgeRefMean.toFixed(1)} → threshold=${lrThresholdRight}`);
  }
  // Coherence check (edgeSets) is disabled for L/R: wood grain and similar frame textures
  // produce coherent horizontal edges that incorrectly trigger the coherence rejection,
  // causing the scan to fall back to a small color-only result. The MAD-based outlier
  // detection in incrementalScan is sufficient for L/R without coherence.
  let cropLeft  = (colMeansDiscriminating && detectionMode !== 'color') ? incrementalScan(cornerColMeans, maxCols, 'left', lrThresholdLeft, null, null, cornerColBandMADs, null) : 0;
  let cropRight = (colMeansDiscriminating && detectionMode !== 'color') ? incrementalScan([...cornerColMeans].reverse(), maxCols, 'right', lrThresholdRight, null, null, [...cornerColBandMADs].reverse(), null) : 0;
  if (cropLeft  > lrMaxCrop) { console.log(`[mean_profile] left: strict-mode size cap — ${cropLeft}px > ${lrMaxCrop}px limit → 0`);  cropLeft  = 0; }
  if (cropRight > lrMaxCrop) { console.log(`[mean_profile] right: strict-mode size cap — ${cropRight}px > ${lrMaxCrop}px limit → 0`); cropRight = 0; }

  // Supplementary color-based L/R scan: analogous to the T/B chroma scan above.
  // Runs only when the luminance scan returned 0 (or was suppressed by strictLR).
  // Not applied in strictLR mode: the corner bands are edge-row fallbacks that don't
  // reliably represent frame material, so color distance would be unreliable too.
  if (cornerColChromaScores && !strictLR && detectionMode !== 'luminance') {
    const chromaColInitN = Math.min(5, Math.floor(maxCols / 2));
    const chromaGateLR = contrastThreshold * 1.5; // same stricter gate as T/B color scan
    if (cropLeft === 0) {
      const leftEdgeChroma = cornerColChromaScores.slice(0, chromaColInitN).reduce((s, v) => s + v, 0) / chromaColInitN;
      if (leftEdgeChroma > chromaGateLR) {
        const colorCrop = incrementalScan(cornerColChromaScores, maxCols, 'left-color', 15, leftEdgeChroma);
        if (colorCrop > 0) { console.log(`[mean_profile] left: color scan detected ${colorCrop}px (chromaEdge=${leftEdgeChroma.toFixed(1)})`); cropLeft = colorCrop; }
      }
    }
    if (cropRight === 0) {
      const rightChromaRev = [...cornerColChromaScores].reverse();
      const rightEdgeChroma = rightChromaRev.slice(0, chromaColInitN).reduce((s, v) => s + v, 0) / chromaColInitN;
      if (rightEdgeChroma > chromaGateLR) {
        const colorCrop = incrementalScan(rightChromaRev, maxCols, 'right-color', 15, rightEdgeChroma);
        if (colorCrop > 0) { console.log(`[mean_profile] right: color scan detected ${colorCrop}px (chromaEdge=${rightEdgeChroma.toFixed(1)})`); cropRight = colorCrop; }
      }
    }
  }

  // L/R bevel continuation: analogous to T/B bevel continuation, using rowPercentileScan.
  // Triggered when the initial scan's refMean (outermost column medians in the corner bands)
  // is below bevelThreshold, meaning the scan stopped in a dark outer transition zone rather
  // than the main frame body. Not applied in strictLR mode: that mode is already conservative
  // and bevel extension could amplify false positives from unreliable edge-row bands.
  const bevelLimitLR = Math.round(width * bevelMaxExtFrac);
  const initColN = Math.min(5, Math.floor(maxCols / 2));
  const leftRefMean  = cornerColMeans.slice(0, initColN).reduce((s, v) => s + v, 0) / initColN;
  const rightRefMean = cornerColMeans.slice(-initColN).reduce((s, v) => s + v, 0) / initColN;
  if (cropLeft > 0 && leftRefMean < bevelThreshold && !strictLR && detectionMode !== 'color') {
    const maxBevelExtLR = Math.round(width * 0.12);
    const scanN = Math.min(maxCols - cropLeft, maxBevelExtLR);
    // Non-adaptive only: cropLeft positions us just inside the outer bevel, so the first
    // columns inward are already main frame body — adaptiveRef risks latching onto painting
    // content (which is brighter than interiorMean + contrastThreshold).
    // Participation rate gate: a real frame bevel activates nearly all rows in rowPercentileScan;
    // painting content only appearing in some rows (e.g. a subject against a dark background)
    // activates a small fraction. Threshold 0.5 = at least half of sampled rows must contribute.
    const ext = rowPercentileScan(cropLeft, scanN, +1, 'left-bevel-cont', bevelMinEdgeLum, false, 0, height, 0.4);
    if (ext > bevelLimitLR) {
      console.log(`[mean_profile] left: bevel continuation rejected (ext=${ext}px > ${bevelLimitLR}px limit, no clear frame boundary)`);
    } else if (ext > 0) {
      console.log(`[mean_profile] left: bevel continuation → +${ext}px → ${cropLeft + ext}px total`);
      cropLeft += ext;
    }
  }
  if (cropRight > 0 && rightRefMean < bevelThreshold && !strictLR && detectionMode !== 'color') {
    const maxBevelExtLR = Math.round(width * 0.12);
    const scanN = Math.min(maxCols - cropRight, maxBevelExtLR);
    const ext = rowPercentileScan(width - 1 - cropRight, scanN, -1, 'right-bevel-cont', bevelMinEdgeLum, false, 0, height, 0.4);
    if (ext > bevelLimitLR) {
      console.log(`[mean_profile] right: bevel continuation rejected (ext=${ext}px > ${bevelLimitLR}px limit, no clear frame boundary)`);
    } else if (ext > 0) {
      console.log(`[mean_profile] right: bevel continuation → +${ext}px → ${cropRight + ext}px total`);
      cropRight += ext;
    }
  }

  // Color continuity extension: after any primary scan stops, look ahead in the chroma
  // profile for persisting frame-colored pixels. Addresses undercrop cases where sparse
  // frame material (e.g. a sliver of gold) dilutes the row/col mean below the consistency
  // threshold — the mean stops, but the actual frame hasn't ended yet.
  //
  // The frameBandChroma gate (contrastThreshold/2 = 10) ensures this only runs when the
  // detected frame already has a color signal; dark/neutral frames (chroma ≈ 0) are skipped.
  // The hysteresis of 3 tolerates brief gaps in a gold frame without overshooting.
  // Cap is 5% of the shorter image dimension to accommodate thick ornate frames.
  //
  // Within-row/column chroma variance gate: frame material has UNIFORM color across its
  // hysteresis of 3 and 15px cap are the primary stopping guards.
  if (detectionMode !== 'luminance') {
    const chromaContGate = contrastThreshold / 2; // 10 when contrastThreshold=20
    const maxLookahead   = 15;
    const contHyst       = 3;

    function chromaLookahead(chromaArr, cropN, label) {
      if (cropN === 0 || !chromaArr || chromaArr.length <= cropN) return 0;
      const frameBandChroma = chromaArr.slice(0, cropN).reduce((s, v) => s + v, 0) / cropN;
      if (frameBandChroma <= chromaContGate) return 0;
      let ext = 0, gap = 0;
      const limit = Math.min(maxLookahead, chromaArr.length - cropN);
      for (let i = 0; i < limit; i++) {
        if (chromaArr[cropN + i] > chromaContGate) {
          ext = i + 1; gap = 0;
        } else {
          gap++;
          if (gap >= contHyst) break;
        }
      }
      if (ext > 0) console.log(`[mean_profile] ${label}: chroma continuity +${ext}px → ${cropN + ext}px`);
      return ext;
    }

    if (rowChromaScores) {
      cropTop    += chromaLookahead(rowChromaScores, cropTop, 'top');
      cropBottom += chromaLookahead([...rowChromaScores].reverse(), cropBottom, 'bottom');
    }
    if (cornerColChromaScores && !strictLR) {
      cropLeft   += chromaLookahead(cornerColChromaScores, cropLeft, 'left');
      cropRight  += chromaLookahead([...cornerColChromaScores].reverse(), cropRight, 'right');
    }
  }

  // Cross-edge inference: if a parallel edge pair is detected but the perpendicular pair
  // is not (e.g. L and R detected but T and B = 0), infer the missing pair using the
  // detected pair's average thickness. This handles frames — like wood grain — whose
  // row means vary too much for a direct scan but whose borders are structurally symmetric.
  // A contrast check guards against falsely cropping painting edges.
  function inferEdge(estimate, getMeans, label) {
    const n = Math.min(estimate, maxRows);
    if (n < 1) return 0;
    const bandMean = getMeans(n).reduce((s, v) => s + v, 0) / n;
    const contrast = Math.abs(bandMean - interiorMean);
    const passed = contrast > contrastThreshold;
    console.log(`[mean_profile] ${label} inferred from parallel pair: estimate=${estimate}px, bandMean=${bandMean.toFixed(1)}, contrast=${contrast.toFixed(1)} → ${passed ? 'CROP' : 'REJECTED (low contrast)'}`);
    return passed ? estimate : 0;
  }

  // For inferring T/B from L/R: use restricted row means (only the detected frame-column
  // strips) rather than full-width row means. Full-width means are dominated by painting
  // content when frame columns are thin (<5% of width), causing the contrast check to
  // fail even when the top/bottom frame material IS a different color from the interior.
  function restrictedRowMean(y, leftCols, rightCols) {
    let sum = 0, count = 0;
    for (let x = 0; x < leftCols; x++) { sum += pixelLum((y * width + x) * channels); count++; }
    for (let x = width - rightCols; x < width; x++) { sum += pixelLum((y * width + x) * channels); count++; }
    return count > 0 ? sum / count : interiorMean;
  }

  if (cropLeft > 0 && cropRight > 0 && cropTop === 0 && cropBottom === 0) {
    // Both T and B missing — infer from (L+R)/2 average.
    const estimate = Math.round((cropLeft + cropRight) / 2);
    cropTop    = inferEdge(estimate, n => Array.from({ length: n }, (_, y) => restrictedRowMean(y, cropLeft, cropRight)),                'top');
    cropBottom = inferEdge(estimate, n => Array.from({ length: n }, (_, i) => restrictedRowMean(height - 1 - i, cropLeft, cropRight)), 'bottom');
  } else if (cropLeft > 0 && cropRight > 0 && cropTop > 0 && cropBottom === 0) {
    // T detected but B missing — infer B ≈ T using frame-column strips.
    cropBottom = inferEdge(cropTop, n => Array.from({ length: n }, (_, i) => restrictedRowMean(height - 1 - i, cropLeft, cropRight)), 'bottom');
  } else if (cropLeft > 0 && cropRight > 0 && cropTop === 0 && cropBottom > 0) {
    // B detected but T missing — infer T ≈ B using frame-column strips.
    cropTop = inferEdge(cropBottom, n => Array.from({ length: n }, (_, y) => restrictedRowMean(y, cropLeft, cropRight)), 'top');
  } else if (cropTop > 0 && cropBottom > 0 && cropLeft === 0 && cropRight === 0) {
    // Both L and R missing — infer from (T+B)/2 average.
    const estimate = Math.round((cropTop + cropBottom) / 2);
    const colMeansAll = Array.from({ length: width }, (_, x) => colMeanInBands(x, [[0, height]]));
    cropLeft  = inferEdge(estimate, n => colMeansAll.slice(0, n),                   'left');
    cropRight = inferEdge(estimate, n => colMeansAll.slice(colMeansAll.length - n), 'right');
  }

  // Secondary inference: re-infer underdetected edges using detected parallel/mirror edges.
  //
  //   T/B-backed L/R: if L or R < half the T/B average, estimate from T/B average.
  //     - Uses final cropTop/cropBottom (not cropTopForBand) so that inferred T/B values
  //       (e.g. top inferred from bottom) correctly anchor the L/R estimate.
  //
  //   L/R mirror: if one side of the L/R pair was more than 2× the other, the smaller is
  //     likely underdetected. Use the larger side as estimate for the smaller. Evaluated
  //     against original pre-update values so T/B-backed changes don't suppress triggering.
  //
  //   Both use two steps: (1) validate via full-height col means contrast check, then
  //   (2) extend from x=estimate using restricted-band medians.
  if (cropTop > 0 && cropBottom > 0) {
    const tbAvg         = (cropTop + cropBottom) / 2;
    const origCropLeft  = cropLeft;
    const origCropRight = cropRight;
    const tbBackedNeeded = origCropLeft < tbAvg / 2 || origCropRight < tbAvg / 2;
    const lrMirrorNeeded = origCropLeft > 0 && origCropRight > 0 &&
                           (origCropRight < origCropLeft / 2 || origCropLeft < origCropRight / 2);

    if (tbBackedNeeded || lrMirrorNeeded) {
      const colMeansAll = Array.from({ length: width }, (_, x) => colMeanInBands(x, [[0, height]]));
      const revMeansAll = [...colMeansAll].reverse();
      // Parallel chroma profile for color-augmented inference contrast check.
      // Full-height column chroma medians: since thin frames are diluted in full-height lum
      // means, color may provide a better signal when the frame has a distinct hue.
      const colChromaAll = channels >= 3
        ? Array.from({ length: width }, (_, x) => colChromaMedianInBands(x, [[0, height]]))
        : null;
      const revChromaAll = colChromaAll ? [...colChromaAll].reverse() : null;

      const inferEdgeLR = (isLeft, detected, est, label) => {
        const bandSlice = isLeft ? colMeansAll.slice(0, est) : revMeansAll.slice(0, est);
        const bandMean  = bandSlice.reduce((s, v) => s + v, 0) / est;
        const lumContrast = Math.abs(bandMean - interiorMean);
        // Color contrast: mean chroma distance of the band from interior.
        // For thin frames diluted by full-height means, color may pass where lum fails.
        const chromaSlice = colChromaAll ? (isLeft ? colChromaAll.slice(0, est) : revChromaAll.slice(0, est)) : null;
        const chromaContrast = chromaSlice ? chromaSlice.reduce((s, v) => s + v, 0) / est : 0;
        const contrast = Math.max(lumContrast, chromaContrast);
        if (contrast <= contrastThreshold) {
          console.log(`[mean_profile] ${label}: est=${est}px REJECTED (lumContrast=${lumContrast.toFixed(1)}, chromaContrast=${chromaContrast.toFixed(1)} ≤ ${contrastThreshold})`);
          return detected;
        }
        // Use the estimate directly. A previous extension step was removed because it
        // produced large false positives when dark painting content near the frame edge
        // had the same luminance as actual frame material — the scan ran hundreds of pixels
        // into the painting. In all tested cases where inference produced correct results,
        // the extension contributed 0px. The estimate from a parallel/mirror edge is
        // sufficient; color-based validation (future work) is the correct next step.
        console.log(`[mean_profile] ${label}: est=${est}px → ${est}px (bandMean=${bandMean.toFixed(1)}, contrast=${contrast.toFixed(1)})`);
        return est > detected ? est : detected;
      };

      if (tbBackedNeeded) {
        const estimate = Math.round(tbAvg);
        if (origCropLeft  < tbAvg / 2) { const v = inferEdgeLR(true,  cropLeft,  estimate, 'left T/B-backed');  if (v > cropLeft)  { console.log(`[mean_profile] left: ${cropLeft}px → ${v}px`);   cropLeft  = v; } }
        if (origCropRight < tbAvg / 2) { const v = inferEdgeLR(false, cropRight, estimate, 'right T/B-backed'); if (v > cropRight) { console.log(`[mean_profile] right: ${cropRight}px → ${v}px`); cropRight = v; } }
      }

      if (lrMirrorNeeded) {
        if (origCropRight < origCropLeft / 2) {
          const v = inferEdgeLR(false, cropRight, origCropLeft, 'right L/R-mirror');
          if (v > cropRight) { console.log(`[mean_profile] right: ${cropRight}px → ${v}px`); cropRight = v; }
        }
        if (origCropLeft < origCropRight / 2) {
          const v = inferEdgeLR(true, cropLeft, origCropRight, 'left L/R-mirror');
          if (v > cropLeft) { console.log(`[mean_profile] left: ${cropLeft}px → ${v}px`); cropLeft = v; }
        }
      }
    }
  }
  // Symmetric: if L/R both detected but T and/or B appear underdetected, re-infer from L/R.
  // Trigger at 60% of lrAvg (rather than 50%) to catch mild asymmetries where T/B
  // underdetect relative to L/R by up to 40%. The contrast check in inferEdge is the
  // real safety guard against falsely overcropping genuinely-smaller T/B edges.
  if (cropLeft > 0 && cropRight > 0) {
    const lrAvg = (cropLeft + cropRight) / 2;
    if (cropTop < lrAvg * 0.6 || cropBottom < lrAvg * 0.6) {
      const estimate = Math.round(lrAvg);
      if (cropTop < lrAvg * 0.6) {
        const inferred = inferEdge(estimate, n => Array.from({ length: n }, (_, y) => restrictedRowMean(y, cropLeft, cropRight)), 'top (L/R-backed)');
        if (inferred > cropTop) { console.log(`[mean_profile] top: ${cropTop}px → ${inferred}px (L/R-backed)`); cropTop = inferred; }
      }
      if (cropBottom < lrAvg * 0.6) {
        const inferred = inferEdge(estimate, n => Array.from({ length: n }, (_, i) => restrictedRowMean(height - 1 - i, cropLeft, cropRight)), 'bottom (L/R-backed)');
        if (inferred > cropBottom) { console.log(`[mean_profile] bottom: ${cropBottom}px → ${inferred}px (L/R-backed)`); cropBottom = inferred; }
      }
    }
  }

  // Symmetry guard: applied after all inferences so it sees corrected values. Rejects any
  // edge crop more than 4× the median of all four — catches runaway false detections that
  // survive inference (e.g. one edge scanning deep into the painting while others are 0).
  {
    const crops = [cropTop, cropBottom, cropLeft, cropRight].sort((a, b) => a - b);
    const median = (crops[1] + crops[2]) / 2;
    if (median > 0) {
      const maxAllowed = median * 4;
      if (cropTop    > maxAllowed) { console.log(`[mean_profile] top symmetry-rejected: ${cropTop}px > 4×median(${median.toFixed(0)})`);    cropTop    = 0; }
      if (cropBottom > maxAllowed) { console.log(`[mean_profile] bottom symmetry-rejected: ${cropBottom}px > 4×median(${median.toFixed(0)})`); cropBottom = 0; }
      if (cropLeft   > maxAllowed) { console.log(`[mean_profile] left symmetry-rejected: ${cropLeft}px > 4×median(${median.toFixed(0)})`);   cropLeft   = 0; }
      if (cropRight  > maxAllowed) { console.log(`[mean_profile] right symmetry-rejected: ${cropRight}px > 4×median(${median.toFixed(0)})`);  cropRight  = 0; }
    }
  }

  if (cropTop === 0 && cropBottom === 0 && cropLeft === 0 && cropRight === 0) {
    return buffer;
  }

  const extractLeft   = cropLeft;
  const extractTop    = cropTop;
  const extractWidth  = width  - cropLeft - cropRight;
  const extractHeight = height - cropTop  - cropBottom;

  const _tInference = Date.now();
  console.log(`[imageProcessor] mean_profile: removing top=${cropTop}px, bottom=${cropBottom}px, left=${cropLeft}px, right=${cropRight}px`);
  const _result = await sharp(buffer)
    .extract({ left: extractLeft, top: extractTop, width: extractWidth, height: extractHeight })
    .toBuffer();
  const _tEnd = Date.now();
  console.log(`[mean_profile timing] decode=${_tDecode-_t0}ms rowMeans=${_tRowMeans-_tDecode}ms TB=${_tTB-_tRowMeans}ms colMedians=${_tColMedians-_tTB}ms inference=${_tInference-_tColMedians}ms encode=${_tEnd-_tInference}ms total=${_tEnd-_t0}ms`);
  return _result;
}

module.exports = { meanProfilePreProcessor };