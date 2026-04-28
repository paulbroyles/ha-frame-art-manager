'use strict';

const sharp = require('sharp');
const path  = require('path');

// Face-api + TF.js are optional: if they fail to load the engine falls back to
// Sharp's built-in attention strategy.  This lets the container boot normally
// even if the packages are not installed or have a runtime compatibility issue.
let faceapi       = null;
let tf            = null;
let modelLoaded   = false;
let loadAttempted = false;

async function ensureFaceApi() {
  if (modelLoaded) return true;
  if (loadAttempted) return false;
  loadAttempted = true;

  try {
    // node-wasm build: uses @tensorflow/tfjs + WASM backend (Alpine/musl compatible).
    require('@tensorflow/tfjs');
    require('@tensorflow/tfjs-backend-wasm');

    // Must require the node-wasm entry point explicitly — the default entry
    // requires @tensorflow/tfjs-node which has native bindings.
    faceapi = require('@vladmandic/face-api/dist/face-api.node-wasm.js');
    tf = faceapi.tf;
    await tf.ready();

    // Model files ship inside the @vladmandic/face-api package.
    const pkgRoot   = path.dirname(require.resolve('@vladmandic/face-api/package.json'));
    const modelPath = path.join(pkgRoot, 'model');
    await faceapi.nets.tinyFaceDetector.loadFromDisk(modelPath);

    modelLoaded = true;
    console.log('[face-aware] TinyFaceDetector loaded from', modelPath);
    return true;
  } catch (err) {
    console.warn('[face-aware] Could not load face-api:', err.message, '— falling back to Sharp attention');
    return false;
  }
}

/**
 * Compute a variance-weighted focal point — the "most visually interesting"
 * region of the image, approximating Sharp's attention strategy.
 *
 * Divides a downscaled greyscale thumbnail into a GRID×GRID cell grid, computes
 * per-cell variance, and returns the variance-weighted centroid in original
 * image coordinates.
 */
async function computeAttentionFocal(buffer, origW, origH) {
  const GRID       = 16;
  const THUMB_SIZE = 256;

  const scale  = Math.min(1.0, THUMB_SIZE / Math.max(origW, origH));
  const thumbW = Math.max(1, Math.round(origW * scale));
  const thumbH = Math.max(1, Math.round(origH * scale));

  const { data: pixels } = await sharp(buffer)
    .resize(thumbW, thumbH, { fit: 'fill', kernel: 'lanczos3' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const cellW = thumbW / GRID;
  const cellH = thumbH / GRID;
  let totalVar = 0, wx = 0, wy = 0;

  for (let gy = 0; gy < GRID; gy++) {
    for (let gx = 0; gx < GRID; gx++) {
      const x0 = Math.floor(gx * cellW);
      const y0 = Math.floor(gy * cellH);
      const x1 = Math.min(thumbW, Math.floor((gx + 1) * cellW));
      const y1 = Math.min(thumbH, Math.floor((gy + 1) * cellH));

      let sum = 0, count = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          sum += pixels[y * thumbW + x];
          count++;
        }
      }
      const mean = sum / count;

      let variance = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const diff = pixels[y * thumbW + x] - mean;
          variance += diff * diff;
        }
      }
      variance /= count;

      const cx = ((gx + 0.5) * cellW) / scale;
      const cy = ((gy + 0.5) * cellH) / scale;
      wx += cx * variance;
      wy += cy * variance;
      totalVar += variance;
    }
  }

  if (totalVar === 0) return { x: origW / 2, y: origH / 2 };
  return { x: wx / totalVar, y: wy / totalVar };
}

/**
 * Detect faces and compute a focal point that tries to accommodate both
 * faces and the most visually interesting region of the image in one crop.
 *
 * Logic:
 *  1. Detect all faces; compute their union bounding box.
 *  2. Compute variance-based attention focal point.
 *  3. Try to fit face-union + attention focal in target crop → center on combined region.
 *  4. If they don't fit together, try face-union alone.
 *  5. Fall back to confidence×area weighted centroid.
 *
 * Returns null if face-api is unavailable or no faces are found.
 *
 * @param {Buffer} buffer
 * @param {number} origW        Original image width
 * @param {number} origH        Original image height
 * @param {number} scoreThreshold
 * @param {number} targetW      Final crop width (used to test fit)
 * @param {number} targetH      Final crop height
 */
async function detectFaceFocal(buffer, origW, origH, scoreThreshold, targetW, targetH) {
  if (!await ensureFaceApi()) return null;

  try {
    const DETECT_SIZE = 416;
    const detScale = Math.min(1.0, DETECT_SIZE / Math.max(origW, origH));
    const detW = Math.max(1, Math.round(origW * detScale));
    const detH = Math.max(1, Math.round(origH * detScale));

    const { data: pixels, info } = await sharp(buffer)
      .resize(detW, detH, { fit: 'fill', kernel: 'lanczos3' })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const tensor = tf.tensor3d(new Uint8Array(pixels), [info.height, info.width, 3]);
    const opts   = new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold });
    const dets   = await faceapi.detectAllFaces(tensor, opts);
    tensor.dispose();

    if (!dets.length) return null;

    // Convert detections to original image coordinates.
    const faces = dets.map(det => {
      const { x, y, width, height } = det.box;
      return {
        x1: x / detScale,
        y1: y / detScale,
        x2: (x + width)  / detScale,
        y2: (y + height) / detScale,
        cx: (x + width  / 2) / detScale,
        cy: (y + height / 2) / detScale,
        score: det.score,
        area: (width / detScale) * (height / detScale),
      };
    });

    // Union bounding box of all detected faces.
    const uX1 = Math.min(...faces.map(f => f.x1));
    const uY1 = Math.min(...faces.map(f => f.y1));
    const uX2 = Math.max(...faces.map(f => f.x2));
    const uY2 = Math.max(...faces.map(f => f.y2));

    // Size of the crop window in original coordinates.
    const coverScale  = Math.max(targetW / origW, targetH / origH);
    const cropW       = targetW / coverScale;
    const cropH       = targetH / coverScale;
    const halfCropW   = cropW / 2;
    const halfCropH   = cropH / 2;

    // Variance-weighted attention focal point.
    const att = await computeAttentionFocal(buffer, origW, origH);

    // Add headroom above the face union: treat the space above the head as part of
    // the region that must stay in frame.  This shifts the valid crop-center range
    // upward so paintings with faces near the top of the composition include a bit
    // of breathing room above the head rather than being pulled down by attention.
    const HEADROOM_FRAC = 0.30; // fraction of face height to pad above the face
    const faceH    = uY2 - uY1;
    const uY1Padded = Math.max(0, uY1 - faceH * HEADROOM_FRAC);

    // Valid range of crop centers that keep all faces (+ headroom) within the crop.
    // minCx: centre must be far enough right that left edge (cx-halfCropW) ≤ uX1
    // maxCx: centre must be far enough left that right edge (cx+halfCropW) ≥ uX2
    const minCx = Math.max(uX2 - halfCropW, halfCropW);
    const maxCx = Math.min(uX1 + halfCropW, origW - halfCropW);
    const minCy = Math.max(uY2 - halfCropH, halfCropH);
    const maxCy = Math.min(uY1Padded + halfCropH, origH - halfCropH);

    if (minCx <= maxCx && minCy <= maxCy) {
      // A valid range exists: snap attention focal toward it as far as possible.
      // This maximises high-entropy coverage while keeping all faces in frame.
      return {
        x: Math.max(minCx, Math.min(maxCx, att.x)),
        y: Math.max(minCy, Math.min(maxCy, att.y)),
        count: faces.length,
        mode: 'face+attention',
      };
    }

    // Face union is larger than the crop window — fall back to weighted centroid.
    let totalW = 0, wx = 0, wy = 0;
    for (const f of faces) {
      const w = f.area * f.score;
      wx += f.cx * w;
      wy += f.cy * w;
      totalW += w;
    }
    return {
      x: wx / totalW,
      y: wy / totalW,
      count: faces.length,
      mode: 'centroid',
    };
  } catch (err) {
    console.warn('[face-aware] Detection error:', err.message);
    return null;
  }
}

/**
 * Cover-fit crop to targetW×targetH, centered on (focalX, focalY) in source coords.
 */
async function focalCrop(buffer, inputW, inputH, targetW, targetH, focalX, focalY) {
  const coverScale = Math.max(targetW / inputW, targetH / inputH);
  const scaledW = Math.round(inputW * coverScale);
  const scaledH = Math.round(inputH * coverScale);

  let left = Math.round(focalX * coverScale - targetW / 2);
  let top  = Math.round(focalY * coverScale - targetH / 2);
  left = Math.max(0, Math.min(left, scaledW - targetW));
  top  = Math.max(0, Math.min(top,  scaledH - targetH));

  return sharp(buffer)
    .resize(scaledW, scaledH, { fit: 'fill', kernel: 'lanczos3' })
    .extract({ left, top, width: targetW, height: targetH })
    .toBuffer();
}

/**
 * Face-aware crop engine.
 *
 * Detects faces using the TinyFaceDetector model (via @vladmandic/face-api with
 * a pure-JS TF.js CPU backend).  When faces are found the crop tries to frame
 * both the detected faces and the most visually interesting region of the image
 * (variance-based attention focal point) within the crop window.  If they don't
 * both fit, faces are prioritised.  Falls back to Sharp attention when no faces
 * are detected.
 *
 * Works best on: portraits, figurative paintings, religious/historical scenes.
 * For abstract or landscape work with no faces, the fallback takes over.
 *
 * Note: artistic/painted faces have lower model confidence than photos; the
 * default scoreThreshold (0.35) is intentionally below the typical photo default
 * (0.5) to catch stylised faces.
 *
 * @param {Buffer} buffer
 * @param {number} inputW
 * @param {number} inputH
 * @param {number} targetW
 * @param {number} targetH
 * @param {object} [options]
 * @param {string} [options.fallbackStrategy='attention']  Sharp strategy if no faces
 * @param {number} [options.scoreThreshold=0.35]           Face confidence threshold
 */
async function faceAwareCropEngine(buffer, inputW, inputH, targetW, targetH, {
  fallbackStrategy = 'attention',
  scoreThreshold   = 0.35,
} = {}) {
  if (targetW === inputW && targetH === inputH) return buffer;

  const focal = await detectFaceFocal(buffer, inputW, inputH, scoreThreshold, targetW, targetH);

  if (focal) {
    console.log(`[face-aware] ${focal.count} face(s) [${focal.mode}] → focal (${Math.round(focal.x)}, ${Math.round(focal.y)})`);
    return focalCrop(buffer, inputW, inputH, targetW, targetH, focal.x, focal.y);
  }

  return sharp(buffer)
    .resize(targetW, targetH, { fit: 'cover', position: fallbackStrategy })
    .toBuffer();
}

module.exports = { faceAwareCropEngine };
