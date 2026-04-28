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
    // Pure-JS CPU backend — Alpine/musl compatible, no native deps.
    tf = require('@tensorflow/tfjs-core');
    require('@tensorflow/tfjs-backend-cpu');
    await tf.setBackend('cpu');
    await tf.ready();

    faceapi = require('@vladmandic/face-api');

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
 * Detect faces and return a weighted centroid in original image coordinates.
 * Returns null if face-api is unavailable or no faces are found.
 */
async function detectFaceCentroid(buffer, origW, origH, scoreThreshold) {
  if (!await ensureFaceApi()) return null;

  try {
    // Face detection works well at 416 px; keep aspect ratio.
    const DETECT_SIZE = 416;
    const detScale = Math.min(1.0, DETECT_SIZE / Math.max(origW, origH));
    const detW = Math.max(1, Math.round(origW * detScale));
    const detH = Math.max(1, Math.round(origH * detScale));

    const { data: pixels, info } = await sharp(buffer)
      .resize(detW, detH, { fit: 'fill', kernel: 'lanczos3' })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    // Build a tensor directly from raw pixels — avoids the browser canvas API.
    const tensor = tf.tensor3d(new Uint8Array(pixels), [info.height, info.width, 3]);
    const opts   = new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold });
    const dets   = await faceapi.detectAllFaces(tensor, opts);
    tensor.dispose();

    if (!dets.length) return null;

    // Weighted centroid: weight = face area × confidence score.
    let totalW = 0, wx = 0, wy = 0;
    for (const det of dets) {
      const { x, y, width, height } = det.box;
      const w = width * height * det.score;
      wx += (x + width  / 2) / detScale * w;
      wy += (y + height / 2) / detScale * w;
      totalW += w;
    }

    return { x: wx / totalW, y: wy / totalW, count: dets.length };
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
 * a pure-JS TF.js CPU backend).  When faces are found the crop is centred on
 * the confidence×area-weighted face centroid; otherwise falls back to Sharp's
 * built-in 'attention' (or a caller-supplied fallback) strategy.
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

  const focal = await detectFaceCentroid(buffer, inputW, inputH, scoreThreshold);

  if (focal) {
    console.log(`[face-aware] ${focal.count} face(s) → focal (${Math.round(focal.x)}, ${Math.round(focal.y)})`);
    return focalCrop(buffer, inputW, inputH, targetW, targetH, focal.x, focal.y);
  }

  return sharp(buffer)
    .resize(targetW, targetH, { fit: 'cover', position: fallbackStrategy })
    .toBuffer();
}

module.exports = { faceAwareCropEngine };
