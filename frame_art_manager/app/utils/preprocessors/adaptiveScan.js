'use strict';

const { _symmetricScanCore } = require('./symmetricScan');

/**
 * Adaptive scan: runs symmetric_scan and falls back to a second pre-processor when
 * symmetric_scan cannot find a confident crop.
 *
 * Fallback policy by stop reason:
 *   diversity / agreement → symmetric_scan found a crop; return it directly
 *   entryRun              → frame undetectable by symmetric_scan; invoke fallback
 *   maxDepth              → scan ran wild (likely bright/uniform background); return unchanged
 */
async function adaptiveScanPreProcessor(buffer, {
  fallback          = 'corner_consensus', // pre-processor name to use as fallback
  fallbackOptions   = {},                 // options forwarded to the fallback
  _result           = null,              // optional out-param: caller passes {} to receive { actualProcessor, stopReason }
  // symmetric_scan options (all with same defaults):
  maxCropFrac        = 0.30,
  tileSize           = 8,
  colorThreshold     = 30,
  minAgreeFrac       = 0.70,
  minPaintRun        = 2,
  maxEntryRun        = 5,
  baseSamples        = 5,
  shiftThreshold     = 20,
  minShiftFrac       = 0.50,
  diversityThreshold = 25,
} = {}) {
  const scanOpts = {
    maxCropFrac, tileSize, colorThreshold, minAgreeFrac,
    minPaintRun, maxEntryRun, baseSamples, shiftThreshold,
    minShiftFrac, diversityThreshold,
  };
  const { buffer: result, stopReason } = await _symmetricScanCore(buffer, scanOpts);

  if (stopReason === 'diversity' || stopReason === 'agreement') {
    if (_result) Object.assign(_result, { actualProcessor: 'symmetric_scan', stopReason });
    return result;
  }

  if (stopReason === 'maxDepth') {
    console.log('[adaptive_scan] symmetric_scan hit maxDepth (likely bright/uniform background) — returning unchanged');
    if (_result) Object.assign(_result, { actualProcessor: 'adaptive_scan (no crop)', stopReason });
    return buffer;
  }

  // stop=entryRun: symmetric_scan found no anchor; try fallback
  console.log(`[adaptive_scan] symmetric_scan stop=${stopReason} — invoking fallback: ${fallback}`);
  if (_result) Object.assign(_result, { actualProcessor: `${fallback} (fallback)`, stopReason });
  // Lazy require to avoid circular dependency with ./index (resolved at call-time).
  const { PRE_PROCESSORS } = require('./index');
  const fallbackFn = PRE_PROCESSORS[fallback];
  if (!fallbackFn || fallback === 'adaptive_scan') {
    console.log(`[adaptive_scan] fallback '${fallback}' unavailable or circular — returning unchanged`);
    return buffer;
  }
  return fallbackFn(buffer, fallbackOptions);
}

module.exports = { adaptiveScanPreProcessor };