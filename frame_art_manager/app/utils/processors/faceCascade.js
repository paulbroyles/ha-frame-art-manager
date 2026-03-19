'use strict';

const sharp = require('sharp');
const path  = require('path');
const fs    = require('fs');

/**
 * Face Cascade window-setter processor.
 *
 * Detects faces in the image using the OpenCV Viola-Jones Haar cascade
 * (haarcascade_frontalface_default.xml) and writes context.focusWindow to the
 * bounding box of the largest detected face, padded outward by padFraction.
 *
 * Downstream window-consumer processors (coherence_crop, scored_crop,
 * frame_aware_crop) will use this window to center or bias their crop toward
 * the detected face rather than relying solely on variance/scoring heuristics.
 *
 * If no face is detected, context.focusWindow is left unchanged (null or a
 * previously set value). The processor degrades gracefully — no error, no
 * effect on the image.
 *
 * Algorithm:
 *   1. Downsample to workSize for detection (face detection is scale-invariant;
 *      smaller resolution is faster).
 *   2. Convert to grayscale and equalizeHist for contrast normalization.
 *   3. Run detectMultiScale (Viola-Jones). Select the largest face.
 *   4. Project bounding box back to original image coordinates.
 *   5. Pad the bounding box outward by padFraction of the face dimension.
 *   6. Write to context.focusWindow.
 *
 * Requires @techstark/opencv-js (pure WASM, Alpine-safe).
 *
 * options:
 *   scaleFactor  1.1    Scale step between detection passes.
 *   minNeighbors 2      Minimum neighbor confirmations to accept a face. Lower
 *                       = more detections (including stylized painting faces)
 *                       at the cost of more false positives.
 *   minSizeRel   0.04   Minimum face dimension as a fraction of the shorter
 *                       working-resolution dimension.
 *   workSize     600    Max dimension for detection downsampling.
 *   padFraction  0.35   Padding added around the detected face, as a fraction
 *                       of the face bounding-box dimension. Gives context around
 *                       the face so crop processors don't clip it tightly.
 */

// ── OpenCV singleton ──────────────────────────────────────────────────────────

let _cvPromise = null;

function getCV() {
  if (!_cvPromise) {
    _cvPromise = new Promise((resolve, reject) => {
      let cvModule;
      try {
        cvModule = require('@techstark/opencv-js');
      } catch (e) {
        return reject(new Error(`@techstark/opencv-js not available: ${e.message}`));
      }
      // Already initialized (e.g., second require in same process)
      if (cvModule.Mat) {
        return resolve(cvModule);
      }
      // Wait for WASM runtime initialization
      cvModule.onRuntimeInitialized = () => resolve(cvModule);
      // Guard: if promise-like, unwrap
      if (typeof cvModule.then === 'function') {
        cvModule.then(cv => resolve(cv)).catch(reject);
      }
    });
  }
  return _cvPromise;
}

// ── Cascade loader (once per process) ────────────────────────────────────────

const CASCADE_PATH = path.join(__dirname, '../cascades/haarcascade_frontalface_default.xml');
const CASCADE_KEY  = 'haarcascade_frontalface_default.xml';

function ensureCascadeLoaded(cv) {
  if (cv._faceCascadeLoaded) return;
  const data = fs.readFileSync(CASCADE_PATH);
  // Write into OpenCV WASM virtual filesystem
  try {
    cv.FS_createDataFile('/', CASCADE_KEY, data, true, false, false);
  } catch (e) {
    // Already exists (hot-reload scenario)
    if (!String(e).includes('already exists')) throw e;
  }
  cv._faceCascadeLoaded = true;
}

// ── Processor ─────────────────────────────────────────────────────────────────

async function faceCascadeProcessor(context, {
  scaleFactor  = 1.1,
  minNeighbors = 2,
  minSizeRel   = 0.04,
  workSize     = 600,
  padFraction  = 0.35,
} = {}) {
  const t0    = Date.now();
  const origW = context.width;
  const origH = context.height;

  // Step 1: downsample + grayscale for detection
  const { data: workData, info: workInfo } = await sharp(context.buffer)
    .resize(workSize, workSize, { fit: 'inside', withoutEnlargement: true })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width: workW, height: workH } = workInfo;
  const scaleX  = origW / workW;
  const scaleY  = origH / workH;
  const minDim  = Math.min(workW, workH);
  const tDecode = Date.now();

  // Step 2: initialize OpenCV
  let cv;
  try {
    cv = await getCV();
  } catch (e) {
    console.warn(`[face_cascade] OpenCV unavailable: ${e.message} — skipping`);
    context.debug.face_cascade = { error: e.message, timing: { total: Date.now() - t0 } };
    return context;
  }

  try {
    ensureCascadeLoaded(cv);
  } catch (e) {
    console.warn(`[face_cascade] cascade load failed: ${e.message} — skipping`);
    context.debug.face_cascade = { error: e.message, timing: { total: Date.now() - t0 } };
    return context;
  }

  // Step 3: build grayscale Mat, equalize histogram, detect
  const mat = new cv.Mat(workH, workW, cv.CV_8UC1);
  mat.data.set(workData);
  cv.equalizeHist(mat, mat);

  const classifier = new cv.CascadeClassifier();
  classifier.load(CASCADE_KEY);

  const faces    = new cv.RectVector();
  const minSz    = new cv.Size(Math.round(minDim * minSizeRel), Math.round(minDim * minSizeRel));
  const maxSz    = new cv.Size(0, 0);
  classifier.detectMultiScale(mat, faces, scaleFactor, minNeighbors, 0, minSz, maxSz);

  const faceCount = faces.size();
  const tDetect   = Date.now();

  mat.delete();
  classifier.delete();

  if (faceCount === 0) {
    faces.delete();
    console.log(`[face_cascade] no faces detected (${workW}×${workH} work res) — focusWindow unchanged`);
    context.debug.face_cascade = {
      timing:   { total: tDetect - t0, decode: tDecode - t0, detect: tDetect - tDecode },
      detected: 0,
    };
    return context;
  }

  // Step 4: select largest face
  let bestFace = null;
  let bestArea = 0;
  for (let i = 0; i < faceCount; i++) {
    const r    = faces.get(i);
    const area = r.width * r.height;
    if (area > bestArea) { bestArea = area; bestFace = { x: r.x, y: r.y, w: r.width, h: r.height }; }
  }
  faces.delete();

  // Step 5: project to original coordinates + add padding
  const pad = Math.round(Math.max(bestFace.w, bestFace.h) * padFraction);
  const wx  = Math.max(0,    Math.round((bestFace.x - pad)              * scaleX));
  const wy  = Math.max(0,    Math.round((bestFace.y - pad)              * scaleY));
  const wr  = Math.min(origW, Math.round((bestFace.x + bestFace.w + pad) * scaleX));
  const wb  = Math.min(origH, Math.round((bestFace.y + bestFace.h + pad) * scaleY));

  // Step 6: set focus window
  context.focusWindow = {
    x: wx, y: wy, w: wr - wx, h: wb - wy,
    confidence: Math.min(1, faceCount >= 3 ? 0.9 : faceCount >= 1 ? 0.7 : 0.4),
    source: 'face_cascade',
  };

  console.log(
    `[face_cascade] detected ${faceCount} face(s), largest: work(${bestFace.x},${bestFace.y} ${bestFace.w}×${bestFace.h})` +
    ` → orig window(${wx},${wy} ${wr-wx}×${wb-wy}) conf=${context.focusWindow.confidence}`
  );

  context.debug.face_cascade = {
    timing:   { total: tDetect - t0, decode: tDecode - t0, detect: tDetect - tDecode },
    detected: faceCount,
    largest:  { ...bestFace },
    window:   { ...context.focusWindow },
  };

  return context;
}

module.exports = { faceCascadeProcessor };
