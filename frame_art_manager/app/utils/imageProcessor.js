'use strict';

const { PRE_PROCESSORS } = require('./preprocessors');
const { CROP_ENGINES }   = require('./cropEngines');
const { runPipeline, computeTargetDimensions, ensureRaw, invalidateRaw, PROCESSORS } = require('./pipeline');
const { solidBorderStrip } = require('./processors/backgroundStrip');

// ── Main pipeline ─────────────────────────────────────────────────────────────

/**
 * Process a web source image for display on the TV.
 *
 * This is the legacy entry point. Internally it builds a pipeline from the
 * preProcess / cropEngine params and runs it through runPipeline().
 *
 * Phase 1 (automatic): strip solid-color borders (solidBorderStrip — variance
 * scan + contrast check). Runs whenever preProcess is non-null, even 'none'.
 *
 * Phase 2 (user-selected): detect and remove decorative frames/borders.
 *
 * Phase 3: fit to TV — scale down if needed, then crop to 16:9 or 9:16.
 *
 * @param {Buffer} buffer
 * @param {'landscape'|'portrait'} orientation
 * @param {object}  [options]
 * @param {string}  [options.preProcess]        Pre-processor key or null to skip phases 1+2
 * @param {object}  [options.preProcessOptions] Passed to the Phase 2 pre-processor
 * @param {string}  [options.cropEngine='sharp'] Crop engine key
 * @param {object}  [options.cropEngineOptions] Passed to the crop engine
 * @returns {Promise<Buffer>}
 */
async function processWebSourceImage(buffer, orientation = 'landscape', {
  preProcess = null,
  preProcessOptions = {},
  cropEngine = 'sharp',
  cropEngineOptions = {},
} = {}) {
  // Map legacy params to pipeline steps.
  // preProcess = null  → skip phases 1+2; only crop
  // preProcess = 'none' → background strip only (PRE_PROCESSORS['none'] is undefined)
  // preProcess = <key> → background strip + pre-processor + crop
  const steps = [];

  if (preProcess != null) {
    steps.push({ key: 'background_strip' });
    if (preProcess !== 'none' && PROCESSORS[preProcess]) {
      steps.push({ key: preProcess, options: preProcessOptions });
    }
  }

  // Map cropEngine key to pipeline step key ('sharp' → 'sharp_crop').
  const cropStepKey = cropEngine === 'sharp' ? 'sharp_crop' : `${cropEngine}_crop`;
  steps.push({ key: cropStepKey, options: cropEngineOptions });

  const { buffer: result } = await runPipeline(buffer, orientation, steps);
  return result;
}

// ── Schema (for UI) ──────────────────────────────────────────────────────────

const IMAGE_PROCESSING_SCHEMA = {
  preProcessors: [
    { value: 'none',             label: 'None — background strip only; no frame detection' },
    { value: 'mean_profile',     label: 'Mean Profile — detect frames using row/column mean consistency; handles textured and wood frames',
      options: [
        { key: 'detectionMode', label: 'Detection Mode', type: 'select', default: 'combined',
          description: 'Whether to use luminance, color (chromaticity), or both for frame detection. Color helps identify gold and colored frames with low luminance contrast.',
          choices: [
            { value: 'combined',  label: 'Combined (default) — luminance + color analysis' },
            { value: 'luminance', label: 'Luminance only — row/column mean brightness; no color scans' },
            { value: 'color',     label: 'Color only — chromaticity distance; no luminance scans' },
          ] },
      ] },
    { value: 'corner_consensus', label: 'Corner Consensus — detect frames using four-corner sampling; handles multi-layer frames' },
    { value: 'region_compare',   label: 'Region Compare — detect frames by comparing edge strip to painting interior' },
    { value: 'tile_color',       label: 'Tile Color — detect frames using 2D tile color continuity; tracks color along frame material and stops at abrupt changes' },
    { value: 'symmetric_scan',   label: 'Symmetric Scan — detect frames by checking that all four edges agree in color at each depth; handles multi-layer frames naturally' },
    { value: 'adaptive_scan',    label: 'Adaptive Scan — symmetric scan with automatic fallback to a second pre-processor when no confident crop is found',
      options: [
        { key: 'fallback', label: 'Fallback Pre-processor', type: 'preProcessor',
          description: 'Pre-processor to use when Adaptive Scan cannot find a confident crop (no frame anchor found). Its own options appear below.',
          excludeValues: ['adaptive_scan', 'none'], default: 'corner_consensus' },
      ] },
    { value: 'variance_scan',    label: 'Variance Scan — detect frames by local edge variance (legacy)' },
    { value: 'trim',             label: 'Sharp Trim — background strip only (same as None; redundant with automatic Stage 1)' },
    // TODO (Option 3): ML Segmentation — handles irregular/ornate frames; see docs/ROADMAP.md
  ],
  cropEngines: [
    { value: 'sharp', label: 'Sharp (built-in)',
      options: [
        { key: 'strategy', label: 'Crop Strategy', type: 'select', default: 'attention',
          description: 'How to select which portion of an image to keep when cropping to fit the TV\'s 16:9 aspect ratio.',
          choices: [
            { value: 'attention', label: 'Attention — focus on faces and salient regions (recommended for paintings)' },
            { value: 'entropy',   label: 'Entropy — focus on high-detail, textured regions' },
            { value: 'centre',    label: 'Center — crop from the geometric center' },
          ] },
      ] },
  ],
};

module.exports = {
  processWebSourceImage,
  solidBorderStrip,         // re-exported for backward compat (web_sources.js uses it directly)
  computeTargetDimensions,  // re-exported for backward compat
  runPipeline,              // new public API
  ensureRaw,                // new public API
  invalidateRaw,            // new public API
  PROCESSORS,               // new public API
  CROP_ENGINES,
  PRE_PROCESSORS,
  IMAGE_PROCESSING_SCHEMA,
};
