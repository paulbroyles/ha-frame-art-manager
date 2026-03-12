'use strict';

const sharp = require('sharp');

/**
 * Symmetric Frame Scan pre-processor.
 *
 * Exploits the defining property of picture frames: the same material appears on
 * all four sides at the same depth. Rather than scanning each side independently,
 * this samples multiple blocks per side and checks whether all sides agree in color
 * at each successive depth. Agreement = still in frame material; disagreement =
 * painting content has appeared on at least one side.
 *
 * Key advantage: multi-layer frames (e.g. dark outer border → gold bevel → main
 * frame body) naturally pass the consensus check at every layer because ALL sides
 * transition between layers simultaneously. A single-side divergence (painting
 * content on one edge) immediately breaks consensus and stops the scan.
 *
 * Sample points per depth:
 *   - Top / Bottom: at 25%, 50%, 75% of width  (3 samples × 2 sides = 6)
 *   - Left / Right: at 15%, 85% of height      (2 corner-biased × 2 sides = 4)
 *   Total: 10 samples per depth.
 *   L/R use corner-biased positions to avoid sampling painting content at the
 *   image center, where the frame never reaches.
 *
 * Consensus criterion: at least minAgreeFrac of the 10 samples must be within
 * colorThreshold (RGB Euclidean distance) of the set's median color.
 *
 * A contrast guard rejects the result if the detected frame region is not
 * meaningfully different from the image interior (i.e. no real frame present).
 *
 * Phase 2 (per-side asymmetric extension) is future work: after the symmetric
 * baseline, each side could independently extend further using color continuity
 * to handle frames that are wider on one side (e.g. heavier bottom frame).
 */
// Internal implementation: returns { buffer, stopReason } so adaptive_scan can act on the result.
async function _symmetricScanCore(buffer, {
  maxCropFrac        = 0.30,
  tileSize           = 8,
  colorThreshold     = 30,   // RGB distance gate for per-sample agreement
  minAgreeFrac       = 0.70, // fraction of samples required to agree at each depth
  minPaintRun        = 2,    // consecutive non-consensus depths to declare boundary (after anchor)
  maxEntryRun        = 5,    // max consecutive failing depths before giving up on finding anchor
  baseSamples        = 5,    // min samples per edge; long edges get more (proportional to aspect)
  shiftThreshold     = 20,   // min per-sample RGB delta (depth-to-depth) to count as shifted
  minShiftFrac       = 0.50, // fraction of total samples that must shift for diversity check
  diversityThreshold = 25,   // avg RGB spread among shifted samples that signals painting boundary
} = {}) {
  const _t0 = Date.now();

  const origMeta = await sharp(buffer).metadata();
  const origW = origMeta.width, origH = origMeta.height;

  const SCALE_TARGET = 600;
  const { data, info } = await sharp(buffer)
    .resize(SCALE_TARGET, SCALE_TARGET, { fit: 'inside', withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  const scaleX = origW / width;
  const scaleY = origH / height;
  const ts = tileSize;

  function tileMeanRGB(x0, y0, x1, y1) {
    const lx0 = Math.max(0, x0), ly0 = Math.max(0, y0);
    const lx1 = Math.min(width, x1), ly1 = Math.min(height, y1);
    let sR = 0, sG = 0, sB = 0, n = 0;
    for (let y = ly0; y < ly1; y++) {
      for (let x = lx0; x < lx1; x++) {
        const off = (y * width + x) * channels;
        sR += data[off]; sG += data[off + 1]; sB += data[off + 2];
        n++;
      }
    }
    return n > 0 ? [sR / n, sG / n, sB / n] : [0, 0, 0];
  }

  function rgbDist([r1, g1, b1], [r2, g2, b2]) {
    return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2);
  }

  // P45 color by luminance: robust central estimate biased toward darker tiles.
  function medianColor(colors) {
    const sorted = [...colors].sort((a, b) =>
      (0.299 * a[0] + 0.587 * a[1] + 0.114 * a[2]) -
      (0.299 * b[0] + 0.587 * b[1] + 0.114 * b[2])
    );
    return sorted[Math.floor(sorted.length * 0.45)];
  }

  // Sample a tile at (edge, depth, posFrac).
  // depth: tile steps inward from that edge.
  // posFrac: fractional position along the edge length.
  function sampleTile(edge, depth, posFrac) {
    const d0 = depth * ts, d1 = d0 + ts;
    switch (edge) {
      case 'top': {
        const cx = Math.round(width * posFrac);
        return tileMeanRGB(cx - ts, d0, cx + ts, d1);
      }
      case 'bottom': {
        const cx = Math.round(width * posFrac);
        return tileMeanRGB(cx - ts, height - d1, cx + ts, height - d0);
      }
      case 'left': {
        const cy = Math.round(height * posFrac);
        return tileMeanRGB(d0, cy - ts, d1, cy + ts);
      }
      case 'right': {
        const cy = Math.round(height * posFrac);
        return tileMeanRGB(width - d1, cy - ts, width - d0, cy + ts);
      }
    }
  }

  // Build evenly-spaced position fracs from 0.15 to 0.85.
  // Staying ≥15% from each adjacent edge prevents T/B samples from landing inside
  // the L/R frame region (and vice versa), which would contaminate the color read.
  function makePosFracs(n) {
    if (n === 1) return [0.5];
    return Array.from({ length: n }, (_, i) => 0.15 + (i / (n - 1)) * 0.70);
  }

  // Sample density: proportional to edge length, minimum baseSamples per edge.
  // T/B positions span width; L/R positions span height.
  const tbN = Math.max(baseSamples, Math.round(baseSamples * width / height));
  const lrN = Math.max(baseSamples, Math.round(baseSamples * height / width));
  const tbPosFracs = makePosFracs(tbN);
  const lrPosFracs = makePosFracs(lrN);

  // All sample points: (edge, posFrac) pairs.
  const samplePoints = [
    ...tbPosFracs.map(f => ({ edge: 'top',    posFrac: f })),
    ...tbPosFracs.map(f => ({ edge: 'bottom', posFrac: f })),
    ...lrPosFracs.map(f => ({ edge: 'left',   posFrac: f })),
    ...lrPosFracs.map(f => ({ edge: 'right',  posFrac: f })),
  ];
  const nSamples = samplePoints.length;
  const minAgree = Math.round(nSamples * minAgreeFrac);
  const minShiftCount = Math.round(nSamples * minShiftFrac);

  const maxDepth = Math.floor(Math.min(width, height) * maxCropFrac / ts);
  let boundaryDepth = 0, highRun = 0;
  const agreeLog = [];
  const deltaLog = []; // consensus color delta depth-to-depth (for analysis)
  let prevColors = null;
  let prevMed = null;
  let stopReason = 'maxDepth';

  for (let d = 0; d < maxDepth; d++) {
    const colors = samplePoints.map(({ edge, posFrac }) => sampleTile(edge, d, posFrac));
    const med = medianColor(colors);
    const agreeing = colors.filter(c => rgbDist(c, med) <= colorThreshold).length;
    const pass = agreeing >= minAgree;
    agreeLog.push(agreeing);

    // Consensus color delta (logged but not used as primary signal; may fail for
    // multi-layer frames where all samples shift to a new uniform frame color).
    const consensusDelta = prevMed ? rgbDist(med, prevMed) : 0;
    deltaLog.push(Math.round(consensusDelta));

    // Diversity check: if many samples shifted from the previous depth AND their
    // new colors are spread out (not all landing on the same new frame color),
    // that is a strong signal we have crossed into painting content.
    if (prevColors) {
      const shiftAmounts = colors.map((c, i) => rgbDist(c, prevColors[i]));
      const shifted = colors.filter((_, i) => shiftAmounts[i] > shiftThreshold);
      if (shifted.length >= minShiftCount) {
        const shiftedMed = medianColor(shifted);
        const spread = shifted.reduce((s, c) => s + rgbDist(c, shiftedMed), 0) / shifted.length;
        if (spread > diversityThreshold && boundaryDepth > 0) {
          console.log(`[symmetric_scan] depth ${d}: diversity boundary — ${shifted.length}/${nSamples} shifted, spread=${spread.toFixed(1)}, consensusDelta=${consensusDelta.toFixed(1)}`);
          stopReason = 'diversity';
          break; // boundaryDepth stays at last passing depth
        } else if (spread > diversityThreshold) {
          console.log(`[symmetric_scan] depth ${d}: diversity spike (no anchor yet, continuing) — ${shifted.length}/${nSamples} shifted, spread=${spread.toFixed(1)}`);
        }
      }
    }

    if (pass) {
      boundaryDepth = d + 1;
      highRun = 0;
    } else {
      highRun++;
      if (boundaryDepth > 0) {
        // After anchor: minPaintRun consecutive failures = painting boundary.
        if (highRun >= minPaintRun) { stopReason = 'agreement'; break; }
      } else {
        // No anchor yet: give up if frame material never shows agreement.
        if (highRun >= maxEntryRun) { stopReason = 'entryRun'; break; }
      }
    }

    prevColors = colors;
    prevMed = med;
  }

  // Contrast guard: reject if the detected frame edge color is not meaningfully
  // different from the image interior. Catches dark-background / no-frame images
  // where all sides agree (same uniform background) but no real frame exists.
  if (boundaryDepth > 0) {
    const interiorColor = tileMeanRGB(
      Math.floor(width * 0.35), Math.floor(height * 0.35),
      Math.floor(width * 0.65), Math.floor(height * 0.65)
    );
    const edgeColors = samplePoints.map(({ edge, posFrac }) => sampleTile(edge, 0, posFrac));
    const edgeColor = medianColor(edgeColors);
    const contrastFromInterior = rgbDist(edgeColor, interiorColor);
    if (contrastFromInterior < colorThreshold * 0.6) {
      console.log(`[symmetric_scan] contrast guard: edge≈interior (dist=${contrastFromInterior.toFixed(1)}) — no frame detected`);
      boundaryDepth = 0;
    }
  }

  const cropPxV = Math.round(boundaryDepth * ts * scaleY);
  const cropPxH = Math.round(boundaryDepth * ts * scaleX);

  const _tCompute = Date.now();
  console.log(`[symmetric_scan] downsampled=${width}×${height}, tile=${ts}px, threshold=${colorThreshold}, minAgree=${minAgree}/${nSamples} (T/B:${tbN} L/R:${lrN})`);
  console.log(`[symmetric_scan] agreement  profile(0-${agreeLog.length - 1})=[${agreeLog.join(',')}]`);
  console.log(`[symmetric_scan] consensusΔ profile(0-${deltaLog.length - 1})=[${deltaLog.join(',')}]`);
  console.log(`[symmetric_scan] boundary=${boundaryDepth}t (stop=${stopReason}) → top=${cropPxV}px bot=${cropPxV}px left=${cropPxH}px right=${cropPxH}px — compute=${_tCompute - _t0}ms`);

  if (boundaryDepth === 0) return { buffer, stopReason };

  const extractW = origW - cropPxH * 2;
  const extractH = origH - cropPxV * 2;
  if (extractW <= 0 || extractH <= 0) return { buffer, stopReason };

  const cropped = await sharp(buffer)
    .extract({ left: cropPxH, top: cropPxV, width: extractW, height: extractH })
    .toBuffer();
  return { buffer: cropped, stopReason };
}

async function symmetricScanPreProcessor(buffer, { _result = null, ...options } = {}) {
  const { buffer: result, stopReason } = await _symmetricScanCore(buffer, options);
  if (_result) Object.assign(_result, { actualProcessor: 'symmetric_scan', stopReason });
  return result;
}

module.exports = { _symmetricScanCore, symmetricScanPreProcessor };