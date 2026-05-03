'use strict';

const { faceAwareCropEngine } = require('../cropEngines/faceAware');

/**
 * Pipeline processor wrapper for the face-aware crop engine.
 * Reads targetW/targetH from context, delegates to faceAwareCropEngine,
 * then updates context dimensions.
 */
async function faceAwareCropProcessor(context, options = {}) {
  const t0 = Date.now();
  const result = await faceAwareCropEngine(
    context.buffer,
    context.width,
    context.height,
    context.targetW,
    context.targetH,
    options,
  );
  if (result !== context.buffer) {
    context.buffer  = result;
    context.raw     = null;
    context.width   = context.targetW;
    context.height  = context.targetH;
  }
  context.debug.face_aware_crop = {
    timing:           Date.now() - t0,
    fallbackStrategy: options.fallbackStrategy || 'attention',
    scoreThreshold:   options.scoreThreshold   ?? 0.35,
  };
  return context;
}

module.exports = { faceAwareCropProcessor };
