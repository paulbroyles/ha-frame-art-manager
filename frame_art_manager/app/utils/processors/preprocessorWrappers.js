'use strict';

const sharp = require('sharp');
const { PRE_PROCESSORS } = require('../preprocessors');

/**
 * Build a pipeline processor that wraps a legacy pre-processor function.
 *
 * Legacy pre-processors have the signature: async (buffer, options) → Buffer
 * Pipeline processors have the signature: async (context, options) → context
 *
 * The wrapper calls the legacy function, then updates context.buffer,
 * context.width, context.height, and context.raw if the buffer changed.
 */
function wrapPreProcessor(key) {
  const fn = PRE_PROCESSORS[key];
  if (!fn) throw new Error(`No pre-processor registered for key: ${key}`);

  return async function preprocessorProcessor(context, options = {}) {
    const t0 = Date.now();
    const result = await fn(context.buffer, options);
    if (result !== context.buffer) {
      context.buffer = result;
      context.raw = null;
      const meta = await sharp(result).metadata();
      context.width = meta.width;
      context.height = meta.height;
    }
    context.debug[key] = { timing: Date.now() - t0 };
    return context;
  };
}

// Build wrapped processor functions for each registered pre-processor.
const PRE_PROCESSOR_WRAPPERS = Object.fromEntries(
  Object.keys(PRE_PROCESSORS).map(key => [key, wrapPreProcessor(key)])
);

module.exports = { PRE_PROCESSOR_WRAPPERS };
