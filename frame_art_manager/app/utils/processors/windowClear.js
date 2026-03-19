'use strict';

/**
 * Window Clear processor.
 *
 * Resets context.focusWindow to null, cancelling any focus window set by a
 * preceding window-setter processor (e.g., face_cascade).
 *
 * Useful in pipelines where a window setter should only influence specific
 * downstream steps and not propagate further.
 */
async function windowClearProcessor(context) {
  context.focusWindow = null;
  context.debug.window_clear = { cleared: true };
  return context;
}

module.exports = { windowClearProcessor };
