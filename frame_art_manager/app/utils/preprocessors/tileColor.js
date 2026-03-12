'use strict';

const sharp = require('sharp');

// TODO (Option 3): ML-based frame segmentation
// Use a pre-trained ONNX model (e.g., fine-tuned SAM or SegFormer) to identify
// painting region vs. decorative frame — handles irregular and ornate frames.
// Cost: ~50–200 MB model weights, onnxruntime-node dependency, startup latency.
// See docs/ROADMAP.md for discussion.

/**
 * Tile Color Continuity pre-processor.
 *
 * Finds frame boundaries by tracking color continuity between tiles as we scan
 * inward from each edge. Frame material is spatially continuous in color — adjacent
 * tile depths look similar. The frame-painting boundary is where the color changes
 * abruptly.
 *
 * Unlike row/column mean approaches (which collapse spatial structure to a single
 * value), this works on a 2D tile grid. Each tile's representative RGB is computed
 * from its pixels, and we measure how much the color changes between one tile depth
 * and the next. Small change = same frame material; large change = boundary.
 *
 * An EMA-updated reference color tracks gradual intra-frame gradients (e.g., the
 * color shift from a dark outer border through a gold bevel to the main frame body)
 * without triggering a false stop. An abrupt change — like the frame-to-painting
 * transition — will exceed the threshold even with EMA tracking.
 *
 * For L/R scanning, only top and bottom corner bands are used (analogous to
 * meanProfile's cornerBands), to exclude painting content in the image center.
 *
 * Algorithm:
 *   1. Downsample image to ~600px on the long axis.
 *   2. Divide into tiles (tileSize × tileSize px).
 *   3. For each tile, compute representative RGB (P45 by luminance across tiles in
 *      that depth row/column — robust central estimate, biased slightly toward darker
 *      tiles to match frame material in the presence of bright painting highlights).
 *   4. Scan inward: compare each depth's representative color to an EMA-updated
 *      reference seeded from the outermost tile. If within colorThreshold, extend
 *      the boundary and update the reference. If outside for minPaintRun consecutive
 *      depths, declare the painting boundary.
 *   5. Scale result back to original image coordinates.
 *
 * Returns 0 on all sides if no abrupt color boundary is found (no frame detected).
 */
async function tileColorPreProcessor(buffer, {
  maxCropFrac    = 0.30,
  tileSize       = 8,
  colorThreshold = 30,  // RGB Euclidean distance gate; within = same material, above = new material
  minPaintRun    = 2,   // consecutive out-of-range depths to confirm boundary (hysteresis)
  cornerFrac     = 0.30,
  emaAlpha       = 0.25, // reference color update rate; low = slow tracking, high = fast tracking
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

  // Mean RGB of pixels in a tile region. Used as the tile's color representative.
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

  // Euclidean RGB distance between two color vectors.
  function rgbDist([r1, g1, b1], [r2, g2, b2]) {
    return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2);
  }

  // Per-tile mean RGBs for all tiles in tile-row ty (full image width).
  function tileRowColors(ty) {
    const y0 = ty * tileSize, y1 = y0 + tileSize;
    const colors = [];
    for (let tx = 0; tx * tileSize < width; tx++)
      colors.push(tileMeanRGB(tx * tileSize, y0, (tx + 1) * tileSize, y1));
    return colors;
  }

  // Per-tile mean RGBs for tile-column tx, restricted to corner bands.
  const cornerH = Math.round(height * cornerFrac);
  const botStart = Math.floor((height - cornerH) / tileSize);
  function tileColColors(tx) {
    const x0 = tx * tileSize, x1 = x0 + tileSize;
    const colors = [];
    for (let ty = 0; ty * tileSize < cornerH; ty++)
      colors.push(tileMeanRGB(x0, ty * tileSize, x1, (ty + 1) * tileSize));
    for (let ty = botStart; ty * tileSize < height; ty++)
      colors.push(tileMeanRGB(x0, ty * tileSize, x1, (ty + 1) * tileSize));
    return colors;
  }

  // P45 color by luminance — robust central estimate, slightly biased toward darker
  // tiles so bright painting highlights don't dominate the representative color.
  function p45Color(colors) {
    if (colors.length === 0) return [128, 128, 128];
    const sorted = [...colors].sort((a, b) =>
      (0.299 * a[0] + 0.587 * a[1] + 0.114 * a[2]) -
      (0.299 * b[0] + 0.587 * b[1] + 0.114 * b[2])
    );
    return sorted[Math.floor(sorted.length * 0.45)];
  }

  // Build color profile: one representative RGB per tile depth from the edge.
  function buildColorProfile(maxDepth, colorsFn) {
    return Array.from({ length: maxDepth }, (_, d) => p45Color(colorsFn(d)));
  }

  // Find frame boundary using EMA color tracking.
  //
  // Seeds the reference from the outermost tile. Extends the boundary as long as
  // each successive depth's color is within colorThreshold of the (slowly updating)
  // reference. Stops when minPaintRun consecutive depths exceed the threshold.
  //
  // The EMA allows gradual color shifts within the frame (bevel gradients) without
  // triggering a false stop. An abrupt change (painting) exceeds the threshold even
  // accounting for recent drift.
  //
  // Returns boundary in tiles (0 = no frame / no confident boundary found).
  function findBoundary(colorProfile, label) {
    if (colorProfile.length === 0) return 0;

    // Seed reference from the outermost tile color.
    let ref = [...colorProfile[0]];
    let boundary = 0, highRun = 0;
    const distLog = [];

    for (let i = 1; i < colorProfile.length; i++) {
      const dist = rgbDist(colorProfile[i], ref);
      distLog.push(Math.round(dist));

      if (dist <= colorThreshold) {
        // Color matches reference — still frame material.
        highRun = 0;
        boundary = i + 1;
        // Slowly track reference toward current tile to follow frame gradients.
        ref = [
          ref[0] * (1 - emaAlpha) + colorProfile[i][0] * emaAlpha,
          ref[1] * (1 - emaAlpha) + colorProfile[i][1] * emaAlpha,
          ref[2] * (1 - emaAlpha) + colorProfile[i][2] * emaAlpha,
        ];
      } else {
        highRun++;
        if (highRun >= minPaintRun) {
          console.log(`[tile_color] ${label}: boundary at tile ${boundary} (dist=[${distLog.join(',')}])`);
          return boundary;
        }
      }
    }

    // Reached end of scan range without finding a boundary.
    // Only return a non-zero boundary if we actually detected frame material
    // (i.e., the profile had some color continuity before running out).
    if (boundary > 0) {
      console.log(`[tile_color] ${label}: no boundary found, returning ${boundary}t (dist=[${distLog.join(',')}])`);
    }
    return 0; // no confident boundary — don't crop
  }

  const maxTilesV = Math.floor(height * maxCropFrac / tileSize);
  const maxTilesH = Math.floor(width  * maxCropFrac / tileSize);
  const nTilesV   = Math.floor(height / tileSize);
  const nTilesH   = Math.floor(width  / tileSize);

  const topColors    = buildColorProfile(maxTilesV, d => tileRowColors(d));
  const bottomColors = buildColorProfile(maxTilesV, d => tileRowColors(nTilesV - 1 - d));
  const leftColors   = buildColorProfile(maxTilesH, d => tileColColors(d));
  const rightColors  = buildColorProfile(maxTilesH, d => tileColColors(nTilesH - 1 - d));

  const cropTopTiles    = findBoundary(topColors, 'top');
  const cropBottomTiles = findBoundary(bottomColors, 'bottom');
  const cropLeftTiles   = findBoundary(leftColors, 'left');
  const cropRightTiles  = findBoundary(rightColors, 'right');

  const cropTop    = Math.round(cropTopTiles    * tileSize * scaleY);
  const cropBottom = Math.round(cropBottomTiles * tileSize * scaleY);
  const cropLeft   = Math.round(cropLeftTiles   * tileSize * scaleX);
  const cropRight  = Math.round(cropRightTiles  * tileSize * scaleX);

  const _tCompute = Date.now();
  console.log(`[tile_color] downsampled=${width}×${height}, tile=${tileSize}px, colorThreshold=${colorThreshold}, emaAlpha=${emaAlpha}`);
  console.log(`[tile_color] crop: top=${cropTop}px (${cropTopTiles}t) bot=${cropBottom}px (${cropBottomTiles}t) left=${cropLeft}px (${cropLeftTiles}t) right=${cropRight}px (${cropRightTiles}t) — compute=${_tCompute - _t0}ms`);

  if (cropTop === 0 && cropBottom === 0 && cropLeft === 0 && cropRight === 0) return buffer;

  const extractW = origW - cropLeft - cropRight;
  const extractH = origH - cropTop  - cropBottom;
  if (extractW <= 0 || extractH <= 0) return buffer;

  return sharp(buffer)
    .extract({ left: cropLeft, top: cropTop, width: extractW, height: extractH })
    .toBuffer();
}

module.exports = { tileColorPreProcessor };