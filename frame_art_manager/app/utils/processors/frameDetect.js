'use strict';

/**
 * Frame boundary detection — pure synchronous function.
 *
 * Extracted from meanProfilePreProcessor so it can be shared between:
 *   - meanProfile (detects frame bounds, then calls sharp.extract)
 *   - frameAwareCrop (detects frame bounds, then applies AR-aware constrained crop)
 *
 * Algorithm: identical to meanProfilePreProcessor. Per-edge detection via:
 *   1. Full-width row means for top/bottom (incrementalScan with hysteresis)
 *   2. Supplementary color chroma scan for T/B
 *   3. Bevel continuation via columnPercentileScan / rowPercentileScan
 *   4. Corner-band column medians for left/right
 *   5. Color continuity extension
 *   6. Cross-edge inference (infer missing edges from detected pair)
 *   7. Secondary inference (T/B-backed and L/R-mirror)
 *   8. Symmetry guard
 *
 * @param {Buffer|Uint8Array} data     - Raw RGBA/RGB pixel data
 * @param {number}            width
 * @param {number}            height
 * @param {number}            channels
 * @param {object}            [options]
 * @param {number}  [options.consistencyThreshold=35]
 * @param {number}  [options.contrastThreshold=20]
 * @param {number}  [options.refFraction=0.03]
 * @param {number}  [options.maxCropFraction=0.18]
 * @param {string}  [options.detectionMode='combined']  'luminance'|'color'|'combined'
 * @param {string}  [options.label='']                  Source label for log output
 * @param {string}  [options.logPrefix='mean_profile']  Log prefix tag
 *
 * @returns {{
 *   top:        number,
 *   bottom:     number,
 *   left:       number,
 *   right:      number,
 *   confidence: { top: string, bottom: string, left: string, right: string }
 * }}
 * confidence values: 'direct' | 'inferred' | 'none'
 *   direct:   detected directly by luminance or color scan
 *   inferred: estimated via cross-edge inference from a parallel edge pair
 *   none:     no frame detected on this edge
 */
function detectFrameBoundaries(data, width, height, channels, {
  consistencyThreshold = 35,
  contrastThreshold    = 20,
  refFraction          = 0.03,
  maxCropFraction      = 0.18,
  label                = '',
  detectionMode        = 'combined',
  logPrefix            = 'mean_profile',
} = {}) {
  const P = logPrefix;

  function pixelLum(b) {
    return 0.299 * data[b] + 0.587 * data[b + 1] + 0.114 * data[b + 2];
  }

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

  function rowVariance(y, mean) {
    let sumSq = 0;
    for (let x = 0; x < width; x++) {
      const d = pixelLum((y * width + x) * channels) - mean;
      sumSq += d * d;
    }
    return sumSq / width;
  }

  function rowMAD(y) {
    let sum = 0;
    for (let x = 1; x < width; x++) {
      sum += Math.abs(pixelLum((y * width + x) * channels) - pixelLum((y * width + x - 1) * channels));
    }
    return sum / (width - 1);
  }

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

  const rowMeans     = Array.from({ length: height }, (_, y) => rowMean(y));
  const rowVariances = rowMeans.map((m, y) => rowVariance(y, m));
  const rowMADs      = Array.from({ length: height }, (_, y) => rowMAD(y));

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
  const iColorR = channels >= 3 ? iSumR / iN : 128;
  const iColorG = channels >= 3 ? iSumG / iN : 128;
  const iColorB = channels >= 3 ? iSumB / iN : 128;
  const iColorTot = iColorR + iColorG + iColorB + 0.001;
  const interiorChR = iColorR / iColorTot;
  const interiorChG = iColorG / iColorTot;
  const interiorChB = iColorB / iColorTot;
  const rowChromaScores = channels >= 3
    ? Array.from({ length: height }, (_, y) => {
        let sum = 0, n = 0;
        for (let x = 0; x < width; x += 4) { sum += pixelChromaDist((y * width + x) * channels); n++; }
        return n > 0 ? sum / n : 0;
      })
    : null;

  if (label) console.log(`[${P}] source: ${label}`);
  console.log(`[${P}] image ${width}×${height}, interiorMean=${interiorMean.toFixed(1)}, consistencyThreshold=${consistencyThreshold}, contrastThreshold=${contrastThreshold}`);

  function edgesOverlap(a, b, tol) {
    let j = 0;
    for (let i = 0; i < a.length; i++) {
      while (j < b.length && b[j] < a[i] - tol) j++;
      if (j < b.length && b[j] <= a[i] + tol) return true;
    }
    return false;
  }

  function incrementalScan(values, maxN, lbl, thresholdOverride = null, contrastOverride = null, varValues = null, madValues = null, edgeSets = null) {
    if (maxN < 5 || values.length < 5) return 0;
    const initN = Math.min(5, Math.floor(maxN / 2));
    const refMean = values.slice(0, initN).reduce((s, v) => s + v, 0) / initN;
    const hysteresisN = 3;
    const threshold = thresholdOverride ?? consistencyThreshold;
    const varMultiplier = 8;
    const refVar = varValues ? varValues.slice(0, initN).reduce((s, v) => s + v, 0) / initN : 0;
    const varCheckActive = varValues !== null && refVar >= 5;
    const refMAD = madValues ? madValues.slice(0, initN).reduce((s, v) => s + v, 0) / initN : 0;
    const madCheckActive = madValues !== null;
    let edgeCheckActive = edgeSets !== null &&
      !edgeSets.slice(0, initN).some(e => e.length > 0);
    const edgeTolerance = 5;
    const coherenceN    = 3;
    let prevEdges  = null;
    let edgeRunLen = 0;
    if (varValues) console.log(`[${P}] ${lbl}: varProfile(0-${Math.min(24, maxN)-1})=[${varValues.slice(0, Math.min(25, maxN)).map(v => Math.round(v)).join(',')}]`);
    if (madValues) console.log(`[${P}] ${lbl}: madProfile(0-${Math.min(24, maxN)-1})=[${madValues.slice(0, Math.min(25, maxN)).map(v => v.toFixed(1)).join(',')}]`);
    if (edgeSets) console.log(`[${P}] ${lbl}: refEdgeCounts(0-${initN-1})=[${edgeSets.slice(0, initN).map(e => e.length).join(',')}] edgeCheck=${edgeCheckActive}`);
    let lastGoodIdx = initN - 1, consecutiveOutliers = 0;
    let stopIdx = -1;
    for (let i = initN; i < Math.min(maxN, values.length); i++) {
      const dev = Math.abs(values[i] - refMean);
      const varOutlier = varCheckActive && varValues[i] > refVar * varMultiplier;
      const madAbsThreshold = 9;
      const madOutlier = madCheckActive && (
        madValues[i] > madAbsThreshold ||
        (refMAD >= 0.5 && madValues[i] > refMAD * varMultiplier)
      );
      if (dev < threshold && !varOutlier && !madOutlier) {
        consecutiveOutliers = 0;
        lastGoodIdx = i;
        if (edgeCheckActive) {
          const curEdges = edgeSets[i];
          if (curEdges.length > 0 && prevEdges !== null && edgesOverlap(curEdges, prevEdges, edgeTolerance)) {
            edgeRunLen++;
            if (edgeRunLen >= coherenceN) {
              console.log(`[${P}] ${lbl}: coherence contamination — ${edgeRunLen} consecutive frame-apparent positions share edge positions (edgeCount=${curEdges.length}) → painting content — REJECTED`);
              return 0;
            }
          } else {
            edgeRunLen = 0;
          }
          prevEdges = curEdges.length > 0 ? curEdges : null;
        }
      } else {
        consecutiveOutliers++;
        edgeRunLen = 0;
        prevEdges = null;
        if (consecutiveOutliers >= hysteresisN) {
          stopIdx = lastGoodIdx + 1;
          break;
        }
      }
    }
    const crop = lastGoodIdx + 1;
    if (crop < 5) {
      console.log(`[${P}] ${lbl}: scan found only ${crop} rows (need ≥5), refMean=${refMean.toFixed(1)}`);
      return 0;
    }
    if (stopIdx < 0) {
      console.log(`[${P}] ${lbl}: scan ran to cap (${crop}px, refMean=${refMean.toFixed(1)}) — REJECTED (runaway)`);
      return 0;
    }
    const bandMean = values.slice(0, crop).reduce((s, v) => s + v, 0) / crop;
    const contrast = Math.abs(refMean - interiorMean);
    const effectiveContrast = contrastOverride !== null ? contrastOverride : contrast;
    const passed = effectiveContrast > contrastThreshold;
    const bandVar = varCheckActive ? varValues.slice(0, crop).reduce((s, v) => s + v, 0) / crop : null;
    const bandMAD = madCheckActive ? madValues.slice(0, crop).reduce((s, v) => s + v, 0) / crop : null;
    console.log(`[${P}] ${lbl}: crop=${crop}px, refMean=${refMean.toFixed(1)}, bandMean=${bandMean.toFixed(1)}, contrast=${contrast.toFixed(1)}${contrastOverride !== null ? ` chromaContrast=${contrastOverride.toFixed(1)}` : ''}${varCheckActive ? ` refVar=${refVar.toFixed(1)} bandVar=${bandVar.toFixed(1)}` : ''}${madCheckActive ? ` refMAD=${refMAD.toFixed(1)} bandMAD=${bandMAD.toFixed(1)}` : ''} (need >${contrastThreshold}) → ${passed ? 'CROP' : 'REJECTED (low contrast)'}`);
    return passed ? crop : 0;
  }

  function columnPercentileScan(startRow, maxCropN, yStep, lbl, minEdgeLum = 0, adaptiveRef = false) {
    const refRows       = 5;
    const refScanLimit  = 40;
    const columnStep    = 16;
    const tailZone      = 10;
    const pct           = 0.65;
    const boundaries = [];
    for (let x = 0; x < width; x += columnStep) {
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
      let colEdgeMean = 0, refCount = 0;
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
      const maxInteriorRun = Math.max(8, Math.round(height * 0.006));
      let lastFrameSide = refStartDr + refRows - 1;
      let interiorRunLen = 0;
      for (let dr = refStartDr + refRows; dr < maxCropN; dr++) {
        const y = startRow + yStep * dr;
        if (y < 0 || y >= height) break;
        const val = pixelLum((y * width + x) * channels);
        if (edgeBrighter ? val >= midPoint : val <= midPoint) {
          lastFrameSide = dr; interiorRunLen = 0;
        } else {
          interiorRunLen++;
          if (interiorRunLen >= maxInteriorRun) break;
        }
      }
      if (lastFrameSide >= maxCropN - tailZone) continue;
      boundaries.push(lastFrameSide + 1);
    }
    if (boundaries.length < 3) {
      console.log(`[${P}] ${lbl}: column scan — only ${boundaries.length} column(s) gave a boundary (need ≥3)`);
      return 0;
    }
    boundaries.sort((a, b) => a - b);
    const crop = boundaries[Math.min(Math.floor(boundaries.length * pct), boundaries.length - 1)];
    console.log(`[${P}] ${lbl}: column scan — ${boundaries.length} cols, range=[${boundaries[0]}..${boundaries[boundaries.length - 1]}], P${Math.round(pct * 100)}=${crop}px`);
    return crop;
  }

  function rowPercentileScan(startCol, maxCropN, xStep, lbl, minEdgeLum = 0, adaptiveRef = false, startY = 0, endY = height, minParticipation = 0) {
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
      let rowEdgeMean = 0, refCount = 0;
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
      console.log(`[${P}] ${lbl}: row scan — only ${boundaries.length} row(s) gave a boundary (need ≥3)`);
      return 0;
    }
    if (minParticipation > 0 && sampledRows > 0 && boundaries.length / sampledRows < minParticipation) {
      console.log(`[${P}] ${lbl}: row scan rejected — participation ${boundaries.length}/${sampledRows} (${(boundaries.length / sampledRows * 100).toFixed(0)}%) < ${(minParticipation * 100).toFixed(0)}% minimum — painting content`);
      return 0;
    }
    boundaries.sort((a, b) => a - b);
    const crop = boundaries[Math.min(Math.floor(boundaries.length * pct), boundaries.length - 1)];
    console.log(`[${P}] ${lbl}: row scan — ${boundaries.length}/${sampledRows} rows (${(boundaries.length / sampledRows * 100).toFixed(0)}%), range=[${boundaries[0]}..${boundaries[boundaries.length - 1]}], P${Math.round(pct * 100)}=${crop}px`);
    return crop;
  }

  // ── T/B scan ──────────────────────────────────────────────────────────────

  // Track how each edge was detected for confidence output.
  const cropSource = { top: 'none', bottom: 'none', left: 'none', right: 'none' };

  let cropTop    = detectionMode !== 'color' ? incrementalScan(rowMeans, maxRows, 'top', null, null, rowVariances, rowMADs, topEdgeSets) : 0;
  let cropBottom = detectionMode !== 'color' ? incrementalScan([...rowMeans].reverse(), maxRows, 'bottom', null, null, [...rowVariances].reverse(), [...rowMADs].reverse(), botEdgeSets) : 0;
  if (cropTop    > 0) cropSource.top    = 'direct';
  if (cropBottom > 0) cropSource.bottom = 'direct';

  // Supplementary color-based T/B scan.
  if (rowChromaScores && detectionMode !== 'luminance') {
    const chromaInitN = Math.min(5, Math.floor(maxRows / 2));
    const chromaGate = contrastThreshold * 1.5;
    if (cropTop === 0) {
      const topEdgeChroma = rowChromaScores.slice(0, chromaInitN).reduce((s, v) => s + v, 0) / chromaInitN;
      if (topEdgeChroma > chromaGate) {
        const colorCrop = incrementalScan(rowChromaScores, maxRows, 'top-color', 15, topEdgeChroma);
        if (colorCrop > 0) { console.log(`[${P}] top: color scan detected ${colorCrop}px (chromaEdge=${topEdgeChroma.toFixed(1)})`); cropTop = colorCrop; cropSource.top = 'direct'; }
      }
    }
    if (cropBottom === 0) {
      const botChromaRev = [...rowChromaScores].reverse();
      const botEdgeChroma = botChromaRev.slice(0, chromaInitN).reduce((s, v) => s + v, 0) / chromaInitN;
      if (botEdgeChroma > chromaGate) {
        const colorCrop = incrementalScan(botChromaRev, maxRows, 'bottom-color', 15, botEdgeChroma);
        if (colorCrop > 0) { console.log(`[${P}] bottom: color scan detected ${colorCrop}px (chromaEdge=${botEdgeChroma.toFixed(1)})`); cropBottom = colorCrop; cropSource.bottom = 'direct'; }
      }
    }
  }

  // ── Bevel continuation (T/B) ──────────────────────────────────────────────

  const bevelThreshold  = 50;
  const bevelMinEdgeLum = 20;
  const bevelMaxExtFrac = 0.07;
  const initN = Math.min(5, Math.floor(maxRows / 2));
  const bevelExtMADThreshold = 5;

  let cropTopForBand    = cropTop;
  let cropBottomForBand = cropBottom;

  {
    const topRefMean = rowMeans.slice(0, initN).reduce((s, v) => s + v, 0) / initN;
    if (cropTop > 0 && topRefMean < bevelThreshold && detectionMode !== 'color') {
      const maxBevelExt = Math.round(height * 0.12);
      const scanN = Math.min(maxRows - cropTop, maxBevelExt);
      const extSimple = columnPercentileScan(cropTop, scanN, +1, 'top-bevel-cont', bevelMinEdgeLum, false);
      if (extSimple > Math.round(height * bevelMaxExtFrac)) {
        console.log(`[${P}] top: bevel continuation rejected (extSimple=${extSimple}px > ${Math.round(height * bevelMaxExtFrac)}px limit, no clear frame boundary)`);
      } else if (extSimple > 0) {
        const extCheckN = Math.min(5, extSimple);
        const extMADMean = rowMADs.slice(cropTop, cropTop + extCheckN).reduce((s, v) => s + v, 0) / extCheckN;
        if (extMADMean > bevelExtMADThreshold) {
          console.log(`[${P}] top: bevel continuation rejected (extMADMean=${extMADMean.toFixed(1)} > ${bevelExtMADThreshold} — painting content)`);
        } else {
          cropTopForBand = cropTop + extSimple;
          const ext = columnPercentileScan(cropTop, scanN, +1, 'top-bevel-cont-adaptive', bevelMinEdgeLum, true);
          const bevelLimit = Math.round(height * bevelMaxExtFrac);
          const rawBest = Math.max(extSimple, ext);
          const bestExt = (rawBest > extSimple * 4 || rawBest > bevelLimit) ? extSimple : rawBest;
          if (bestExt > 0) { console.log(`[${P}] top: bevel continuation simple=${extSimple}px adaptive=${ext}px → using ${bestExt}px → ${cropTop + bestExt}px total`); cropTop += bestExt; }
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
      if (extSimple > Math.round(height * bevelMaxExtFrac)) {
        console.log(`[${P}] bottom: bevel continuation rejected (extSimple=${extSimple}px > ${Math.round(height * bevelMaxExtFrac)}px limit, no clear frame boundary)`);
      } else if (extSimple > 0) {
        const extCheckN = Math.min(5, extSimple);
        const extStart = height - cropBottom - extSimple;
        const extMADMean = rowMADs.slice(extStart, extStart + extCheckN).reduce((s, v) => s + v, 0) / extCheckN;
        if (extMADMean > bevelExtMADThreshold) {
          console.log(`[${P}] bottom: bevel continuation rejected (extMADMean=${extMADMean.toFixed(1)} > ${bevelExtMADThreshold} — painting content)`);
        } else {
          cropBottomForBand = cropBottom + extSimple;
          const ext = columnPercentileScan(height - 1 - cropBottom, scanN, -1, 'bottom-bevel-cont-adaptive', bevelMinEdgeLum, true);
          const bevelLimit = Math.round(height * bevelMaxExtFrac);
          const rawBest = Math.max(extSimple, ext);
          const bestExt = (rawBest > extSimple * 4 || rawBest > bevelLimit) ? extSimple : rawBest;
          if (bestExt > 0) { console.log(`[${P}] bottom: bevel continuation simple=${extSimple}px adaptive=${ext}px → using ${bestExt}px → ${cropBottom + bestExt}px total`); cropBottom += bestExt; }
        }
      }
    }
  }

  // ── L/R scan ──────────────────────────────────────────────────────────────

  const refRows = Math.max(3, Math.round(height * refFraction));
  const topInner = cropTopForBand    > 0
    ? [cropTopForBand,              Math.min(cropTopForBand    + refRows, Math.floor(height / 2))]
    : [0,                    refRows];
  const botInner = cropBottomForBand > 0
    ? [Math.max(height - cropBottomForBand - refRows, Math.ceil(height / 2)), height - cropBottomForBand]
    : [height - refRows,     height];
  const cornerBands           = [topInner, botInner];
  const cornerColMeans        = Array.from({ length: width }, (_, x) => colMedianInBands(x, cornerBands));
  const cornerColBandMADs     = Array.from({ length: width }, (_, x) => colBandMAD(x, cornerBands));
  const cornerColChromaScores = channels >= 3
    ? Array.from({ length: width }, (_, x) => colChromaMedianInBands(x, cornerBands))
    : null;

  console.log(`[${P}] colMeansProfile(0-${Math.min(24, maxCols)-1})=[${cornerColMeans.slice(0, Math.min(25, maxCols)).map(v => v.toFixed(1)).join(',')}]`);
  console.log(`[${P}] colBandMADProfile(0-${Math.min(24, maxCols)-1})=[${cornerColBandMADs.slice(0, Math.min(25, maxCols)).map(v => v.toFixed(1)).join(',')}]`);

  const colMeansMin = cornerColMeans.reduce((a, v) => Math.min(a, v),  Infinity);
  const colMeansMax = cornerColMeans.reduce((a, v) => Math.max(a, v), -Infinity);
  const colMeansDiscriminating = (colMeansMax - colMeansMin) >= 5;
  console.log(`[${P}] col medians range=${(colMeansMax - colMeansMin).toFixed(1)} (bands top=${JSON.stringify(topInner)}, bot=${JSON.stringify(botInner)})${colMeansDiscriminating ? '' : ' → SKIPPING left/right (non-discriminating)'}`);

  const MIN_RELIABLE_CROP = 10;
  const strictLR = cropTopForBand < MIN_RELIABLE_CROP && cropBottomForBand < MIN_RELIABLE_CROP;
  const lrMaxCrop = strictLR ? Math.round(width * 0.03) : Infinity;
  if (strictLR) console.log(`[${P}] L/R: T/B bands unreliable (top=${cropTopForBand}px, bot=${cropBottomForBand}px < ${MIN_RELIABLE_CROP}px) — strict mode (threshold=45, maxCrop=${lrMaxCrop}px)`);
  const initColRefN = Math.min(5, Math.floor(maxCols / 2));
  const leftEdgeRefMean  = cornerColMeans.slice(0, initColRefN).reduce((s, v) => s + v, 0) / initColRefN;
  const rightEdgeRefMean = cornerColMeans.slice(-initColRefN).reduce((s, v) => s + v, 0) / initColRefN;
  const lrThresholdLeft  = strictLR ? 45 : Math.min(consistencyThreshold, Math.max(15, Math.round(leftEdgeRefMean  * 2)));
  const lrThresholdRight = strictLR ? 45 : Math.min(consistencyThreshold, Math.max(15, Math.round(rightEdgeRefMean * 2)));
  if (!strictLR && (lrThresholdLeft !== consistencyThreshold || lrThresholdRight !== consistencyThreshold)) {
    console.log(`[${P}] L/R: adaptive threshold — left refMean=${leftEdgeRefMean.toFixed(1)} → threshold=${lrThresholdLeft}, right refMean=${rightEdgeRefMean.toFixed(1)} → threshold=${lrThresholdRight}`);
  }

  let cropLeft  = (colMeansDiscriminating && detectionMode !== 'color') ? incrementalScan(cornerColMeans, maxCols, 'left', lrThresholdLeft, null, null, cornerColBandMADs, null) : 0;
  let cropRight = (colMeansDiscriminating && detectionMode !== 'color') ? incrementalScan([...cornerColMeans].reverse(), maxCols, 'right', lrThresholdRight, null, null, [...cornerColBandMADs].reverse(), null) : 0;
  if (cropLeft  > lrMaxCrop) { console.log(`[${P}] left: strict-mode size cap — ${cropLeft}px > ${lrMaxCrop}px limit → 0`);  cropLeft  = 0; }
  if (cropRight > lrMaxCrop) { console.log(`[${P}] right: strict-mode size cap — ${cropRight}px > ${lrMaxCrop}px limit → 0`); cropRight = 0; }
  if (cropLeft  > 0) cropSource.left  = 'direct';
  if (cropRight > 0) cropSource.right = 'direct';

  // Supplementary color-based L/R scan.
  if (cornerColChromaScores && !strictLR && detectionMode !== 'luminance') {
    const chromaColInitN = Math.min(5, Math.floor(maxCols / 2));
    const chromaGateLR = contrastThreshold * 1.5;
    if (cropLeft === 0) {
      const leftEdgeChroma = cornerColChromaScores.slice(0, chromaColInitN).reduce((s, v) => s + v, 0) / chromaColInitN;
      if (leftEdgeChroma > chromaGateLR) {
        const colorCrop = incrementalScan(cornerColChromaScores, maxCols, 'left-color', 15, leftEdgeChroma);
        if (colorCrop > 0) { console.log(`[${P}] left: color scan detected ${colorCrop}px (chromaEdge=${leftEdgeChroma.toFixed(1)})`); cropLeft = colorCrop; cropSource.left = 'direct'; }
      }
    }
    if (cropRight === 0) {
      const rightChromaRev = [...cornerColChromaScores].reverse();
      const rightEdgeChroma = rightChromaRev.slice(0, chromaColInitN).reduce((s, v) => s + v, 0) / chromaColInitN;
      if (rightEdgeChroma > chromaGateLR) {
        const colorCrop = incrementalScan(rightChromaRev, maxCols, 'right-color', 15, rightEdgeChroma);
        if (colorCrop > 0) { console.log(`[${P}] right: color scan detected ${colorCrop}px (chromaEdge=${rightEdgeChroma.toFixed(1)})`); cropRight = colorCrop; cropSource.right = 'direct'; }
      }
    }
  }

  // ── L/R bevel continuation ────────────────────────────────────────────────

  const bevelLimitLR = Math.round(width * bevelMaxExtFrac);
  const initColN = Math.min(5, Math.floor(maxCols / 2));
  const leftRefMean  = cornerColMeans.slice(0, initColN).reduce((s, v) => s + v, 0) / initColN;
  const rightRefMean = cornerColMeans.slice(-initColN).reduce((s, v) => s + v, 0) / initColN;
  if (cropLeft > 0 && leftRefMean < bevelThreshold && !strictLR && detectionMode !== 'color') {
    const maxBevelExtLR = Math.round(width * 0.12);
    const scanN = Math.min(maxCols - cropLeft, maxBevelExtLR);
    const ext = rowPercentileScan(cropLeft, scanN, +1, 'left-bevel-cont', bevelMinEdgeLum, false, 0, height, 0.4);
    if (ext > bevelLimitLR) {
      console.log(`[${P}] left: bevel continuation rejected (ext=${ext}px > ${bevelLimitLR}px limit, no clear frame boundary)`);
    } else if (ext > 0) {
      console.log(`[${P}] left: bevel continuation → +${ext}px → ${cropLeft + ext}px total`);
      cropLeft += ext;
    }
  }
  if (cropRight > 0 && rightRefMean < bevelThreshold && !strictLR && detectionMode !== 'color') {
    const maxBevelExtLR = Math.round(width * 0.12);
    const scanN = Math.min(maxCols - cropRight, maxBevelExtLR);
    const ext = rowPercentileScan(width - 1 - cropRight, scanN, -1, 'right-bevel-cont', bevelMinEdgeLum, false, 0, height, 0.4);
    if (ext > bevelLimitLR) {
      console.log(`[${P}] right: bevel continuation rejected (ext=${ext}px > ${bevelLimitLR}px limit, no clear frame boundary)`);
    } else if (ext > 0) {
      console.log(`[${P}] right: bevel continuation → +${ext}px → ${cropRight + ext}px total`);
      cropRight += ext;
    }
  }

  // ── Chroma continuity extension ───────────────────────────────────────────

  if (detectionMode !== 'luminance') {
    const chromaContGate = contrastThreshold / 2;
    const maxLookahead   = 15;
    const contHyst       = 3;

    function chromaLookahead(chromaArr, cropN, lbl) {
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
      if (ext > 0) console.log(`[${P}] ${lbl}: chroma continuity +${ext}px → ${cropN + ext}px`);
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

  // ── Cross-edge inference ──────────────────────────────────────────────────

  function inferEdge(estimate, getMeans, lbl) {
    const n = Math.min(estimate, maxRows);
    if (n < 1) return 0;
    const bandMean = getMeans(n).reduce((s, v) => s + v, 0) / n;
    const contrast = Math.abs(bandMean - interiorMean);
    const passed = contrast > contrastThreshold;
    console.log(`[${P}] ${lbl} inferred from parallel pair: estimate=${estimate}px, bandMean=${bandMean.toFixed(1)}, contrast=${contrast.toFixed(1)} → ${passed ? 'CROP' : 'REJECTED (low contrast)'}`);
    return passed ? estimate : 0;
  }

  function restrictedRowMean(y, leftCols, rightCols) {
    let sum = 0, count = 0;
    for (let x = 0; x < leftCols; x++) { sum += pixelLum((y * width + x) * channels); count++; }
    for (let x = width - rightCols; x < width; x++) { sum += pixelLum((y * width + x) * channels); count++; }
    return count > 0 ? sum / count : interiorMean;
  }

  if (cropLeft > 0 && cropRight > 0 && cropTop === 0 && cropBottom === 0) {
    const estimate = Math.round((cropLeft + cropRight) / 2);
    const t = inferEdge(estimate, n => Array.from({ length: n }, (_, y) => restrictedRowMean(y, cropLeft, cropRight)),                'top');
    const b = inferEdge(estimate, n => Array.from({ length: n }, (_, i) => restrictedRowMean(height - 1 - i, cropLeft, cropRight)), 'bottom');
    if (t > 0) { cropTop    = t; cropSource.top    = 'inferred'; }
    if (b > 0) { cropBottom = b; cropSource.bottom = 'inferred'; }
  } else if (cropLeft > 0 && cropRight > 0 && cropTop > 0 && cropBottom === 0) {
    const b = inferEdge(cropTop, n => Array.from({ length: n }, (_, i) => restrictedRowMean(height - 1 - i, cropLeft, cropRight)), 'bottom');
    if (b > 0) { cropBottom = b; cropSource.bottom = 'inferred'; }
  } else if (cropLeft > 0 && cropRight > 0 && cropTop === 0 && cropBottom > 0) {
    const t = inferEdge(cropBottom, n => Array.from({ length: n }, (_, y) => restrictedRowMean(y, cropLeft, cropRight)), 'top');
    if (t > 0) { cropTop = t; cropSource.top = 'inferred'; }
  } else if (cropTop > 0 && cropBottom > 0 && cropLeft === 0 && cropRight === 0) {
    const estimate = Math.round((cropTop + cropBottom) / 2);
    const colMeansAll = Array.from({ length: width }, (_, x) => colMeanInBands(x, [[0, height]]));
    const l = inferEdge(estimate, n => colMeansAll.slice(0, n),                   'left');
    const r = inferEdge(estimate, n => colMeansAll.slice(colMeansAll.length - n), 'right');
    if (l > 0) { cropLeft  = l; cropSource.left  = 'inferred'; }
    if (r > 0) { cropRight = r; cropSource.right = 'inferred'; }
  }

  // ── Secondary inference ───────────────────────────────────────────────────

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
      const colChromaAll = channels >= 3
        ? Array.from({ length: width }, (_, x) => colChromaMedianInBands(x, [[0, height]]))
        : null;
      const revChromaAll = colChromaAll ? [...colChromaAll].reverse() : null;

      const inferEdgeLR = (isLeft, detected, est, lbl) => {
        const bandSlice = isLeft ? colMeansAll.slice(0, est) : revMeansAll.slice(0, est);
        const bandMean  = bandSlice.reduce((s, v) => s + v, 0) / est;
        const lumContrast = Math.abs(bandMean - interiorMean);
        const chromaSlice = colChromaAll ? (isLeft ? colChromaAll.slice(0, est) : revChromaAll.slice(0, est)) : null;
        const chromaContrast = chromaSlice ? chromaSlice.reduce((s, v) => s + v, 0) / est : 0;
        const contrast = Math.max(lumContrast, chromaContrast);
        if (contrast <= contrastThreshold) {
          console.log(`[${P}] ${lbl}: est=${est}px REJECTED (lumContrast=${lumContrast.toFixed(1)}, chromaContrast=${chromaContrast.toFixed(1)} ≤ ${contrastThreshold})`);
          return detected;
        }
        console.log(`[${P}] ${lbl}: est=${est}px → ${est}px (bandMean=${bandMean.toFixed(1)}, contrast=${contrast.toFixed(1)})`);
        return est > detected ? est : detected;
      };

      if (tbBackedNeeded) {
        const estimate = Math.round(tbAvg);
        if (origCropLeft  < tbAvg / 2) {
          const v = inferEdgeLR(true,  cropLeft,  estimate, 'left T/B-backed');
          if (v > cropLeft)  { console.log(`[${P}] left: ${cropLeft}px → ${v}px`);   cropLeft  = v; if (cropSource.left  === 'none') cropSource.left  = 'inferred'; }
        }
        if (origCropRight < tbAvg / 2) {
          const v = inferEdgeLR(false, cropRight, estimate, 'right T/B-backed');
          if (v > cropRight) { console.log(`[${P}] right: ${cropRight}px → ${v}px`); cropRight = v; if (cropSource.right === 'none') cropSource.right = 'inferred'; }
        }
      }

      if (lrMirrorNeeded) {
        if (origCropRight < origCropLeft / 2) {
          const v = inferEdgeLR(false, cropRight, origCropLeft, 'right L/R-mirror');
          if (v > cropRight) { console.log(`[${P}] right: ${cropRight}px → ${v}px`); cropRight = v; if (cropSource.right === 'none') cropSource.right = 'inferred'; }
        }
        if (origCropLeft < origCropRight / 2) {
          const v = inferEdgeLR(true, cropLeft, origCropRight, 'left L/R-mirror');
          if (v > cropLeft) { console.log(`[${P}] left: ${cropLeft}px → ${v}px`); cropLeft = v; if (cropSource.left === 'none') cropSource.left = 'inferred'; }
        }
      }
    }
  }

  if (cropLeft > 0 && cropRight > 0) {
    const lrAvg = (cropLeft + cropRight) / 2;
    if (cropTop < lrAvg * 0.6 || cropBottom < lrAvg * 0.6) {
      const estimate = Math.round(lrAvg);
      if (cropTop < lrAvg * 0.6) {
        const inferred = inferEdge(estimate, n => Array.from({ length: n }, (_, y) => restrictedRowMean(y, cropLeft, cropRight)), 'top (L/R-backed)');
        if (inferred > cropTop) { console.log(`[${P}] top: ${cropTop}px → ${inferred}px (L/R-backed)`); cropTop = inferred; if (cropSource.top === 'none') cropSource.top = 'inferred'; }
      }
      if (cropBottom < lrAvg * 0.6) {
        const inferred = inferEdge(estimate, n => Array.from({ length: n }, (_, i) => restrictedRowMean(height - 1 - i, cropLeft, cropRight)), 'bottom (L/R-backed)');
        if (inferred > cropBottom) { console.log(`[${P}] bottom: ${cropBottom}px → ${inferred}px (L/R-backed)`); cropBottom = inferred; if (cropSource.bottom === 'none') cropSource.bottom = 'inferred'; }
      }
    }
  }

  // ── Symmetry guard ────────────────────────────────────────────────────────

  {
    const crops = [cropTop, cropBottom, cropLeft, cropRight].sort((a, b) => a - b);
    const median = (crops[1] + crops[2]) / 2;
    if (median > 0) {
      const maxAllowed = median * 4;
      if (cropTop    > maxAllowed) { console.log(`[${P}] top symmetry-rejected: ${cropTop}px > 4×median(${median.toFixed(0)})`);    cropTop    = 0; cropSource.top    = 'none'; }
      if (cropBottom > maxAllowed) { console.log(`[${P}] bottom symmetry-rejected: ${cropBottom}px > 4×median(${median.toFixed(0)})`); cropBottom = 0; cropSource.bottom = 'none'; }
      if (cropLeft   > maxAllowed) { console.log(`[${P}] left symmetry-rejected: ${cropLeft}px > 4×median(${median.toFixed(0)})`);   cropLeft   = 0; cropSource.left   = 'none'; }
      if (cropRight  > maxAllowed) { console.log(`[${P}] right symmetry-rejected: ${cropRight}px > 4×median(${median.toFixed(0)})`);  cropRight  = 0; cropSource.right  = 'none'; }
    }
  }

  return {
    top:    cropTop,
    bottom: cropBottom,
    left:   cropLeft,
    right:  cropRight,
    confidence: {
      top:    cropSource.top    !== 'none' ? cropSource.top    : 'none',
      bottom: cropSource.bottom !== 'none' ? cropSource.bottom : 'none',
      left:   cropSource.left   !== 'none' ? cropSource.left   : 'none',
      right:  cropSource.right  !== 'none' ? cropSource.right  : 'none',
    },
  };
}

module.exports = { detectFrameBoundaries };
