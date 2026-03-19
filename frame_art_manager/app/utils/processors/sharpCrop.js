'use strict';

const { sharpCropEngine } = require('../cropEngines/sharpCrop');

/**
 * Pipeline processor wrapper for the Sharp crop engine.
 *
 * Reads targetW/targetH from context (set by the pipeline runner based on
 * input dimensions and TV orientation), calls sharpCropEngine, then updates
 * context dimensions to match.
 *
 * options.strategy: 'attention' | 'entropy' | 'centre' (default: 'attention')
 */
async function sharpCropProcessor(context, options = {}) {
  const t0 = Date.now();
  const result = await sharpCropEngine(
    context.buffer,
    context.width,
    context.height,
    context.targetW,
    context.targetH,
    options,
  );
  if (result !== context.buffer) {
    context.buffer = result;
    context.raw = null;
    context.width = context.targetW;
    context.height = context.targetH;
  }
  context.debug.sharp_crop = { timing: Date.now() - t0, strategy: options.strategy || 'attention' };
  return context;
}

module.exports = { sharpCropProcessor };
