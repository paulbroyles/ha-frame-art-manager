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
    { value: 'coherence_scan',   label: 'Coherence Scan — detect frames using 2D tile variance map; handles irregular frames better than row/column projections',
      options: [
        { key: 'coherenceThreshold', label: 'Coherence Threshold', type: 'number', default: 400,
          description: 'Tile luminance variance below this = frame material. Lower = stricter (misses textured frames). Higher = more permissive (may bleed into flat painting regions).' },
        { key: 'minCoherentFrac', label: 'Min Coherent Fraction', type: 'number', default: 0.70,
          description: 'Fraction of tiles in a row or column that must be coherent to extend the frame band (0.5–1.0). Lower tolerates more noise or texture in frame material.' },
      ] },
    { value: 'variance_scan',    label: 'Variance Scan — detect frames by local edge variance (legacy)' },
    { value: 'trim',             label: 'Sharp Trim — background strip only (same as None; redundant with automatic Stage 1)' },
    // TODO (Option 3): ML Segmentation — handles irregular/ornate frames; see docs/ROADMAP.md
  ],
  windowSetters: [
    { value: 'peak_variance', label: 'Peak Variance — find the most densely complex compact region and set focus window for downstream crop processors',
      options: [
        { key: 'windowFrac', label: 'Window Size', type: 'number', default: 0.25,
          description: 'Search window side as a fraction of the shorter image dimension. ~0.25 for a face/head; increase to 0.35–0.50 for a full figure or wider subject.' },
        { key: 'padFraction', label: 'Padding', type: 'number', default: 0.30,
          description: 'Expand the found window outward by this fraction of its side on each edge, to include context around the subject.' },
      ] },
  ],
  windowModifiers: [
    { value: 'window_clear', label: 'Clear Focus Window — reset any focus window set by upstream processors' },
  ],
  unifiedProcessors: [
    { value: 'scored_crop', label: 'Scored Crop — score candidate crop rectangles for edge uniformity and interior complexity; finds painting without explicit frame detection',
      replaces: ['frame_detect', 'aspect_crop'],
      options: [
        { key: 'edgeVarThreshold', label: 'Edge Variance Threshold', type: 'number', default: 200,
          description: 'Local variance below this = frame-like edge material. Lower = stricter (may miss textured frames). Higher = more permissive.' },
        { key: 'interiorVarTarget', label: 'Interior Complexity Target', type: 'number', default: 800,
          description: 'Local variance level that counts as fully complex painting content. Raise for very flat or minimalist paintings.' },
        { key: 'minSizeFrac', label: 'Min Candidate Size', type: 'number', default: 0.65,
          description: 'Smallest candidate rectangle as fraction of image dimension (0.2–0.9). Lower allows finding paintings inside very wide frames but risks over-zooming. 0.65–0.75 works well for typical museum frames.' },
        { key: 'strategy', label: 'Crop Strategy', type: 'select', default: 'centre',
          description: 'How to position the final resize. Centre is recommended since candidate selection already handles spatial positioning; attention/entropy can cause unintended drift toward frame material.',
          choices: [
            { value: 'centre',    label: 'Center — crop from the geometric center (recommended)' },
            { value: 'attention', label: 'Attention — focus on faces and salient regions' },
            { value: 'entropy',   label: 'Entropy — focus on high-detail, textured regions' },
          ] },
        { key: 'edgeWeight', label: 'Edge Penalty Weight', type: 'number', default: 0.6,
          description: 'How strongly frame-like edges penalize a candidate (0–2). Higher values make the algorithm more repulsed by frame material at the cost of possibly over-zooming.' },
        { key: 'centeringWeightX', label: 'Horizontal Centering Weight', type: 'number', default: 0.15,
          description: 'Penalty for candidates shifted left or right of the image center (0–1). Prevents asymmetric frame from pushing the crop sideways. Set to 0 to disable.' },
        { key: 'centeringWeightY', label: 'Vertical Centering Weight', type: 'number', default: 0.0,
          description: 'Penalty for candidates shifted above or below image center (0–1). Default 0 — vertical position should follow content (face at top of portrait), not be forced to center.' },
      ] },
    { value: 'coherence_crop', label: 'Coherence Crop — variance-weighted centroid; centers crop on the most complex region; frame excluded naturally with no boundary detection',
      replaces: ['frame_detect', 'aspect_crop'],
      options: [
        { key: 'strategy', label: 'Crop Strategy', type: 'select', default: 'attention',
          description: 'How to position the final resize. Minimal effect since the centroid placement drives crop positioning.',
          choices: [
            { value: 'attention', label: 'Attention — focus on faces and salient regions' },
            { value: 'entropy',   label: 'Entropy — focus on high-detail, textured regions' },
            { value: 'centre',    label: 'Center — crop from the geometric center' },
          ] },
        { key: 'borderWeight', label: 'Border Weight', type: 'number', default: 0.2,
          description: 'Weight multiplier (0–1) for tiles in the border band. Lower values suppress frame material from attracting the centroid. 1.0 disables border downweighting.' },
        { key: 'borderBandFrac', label: 'Border Band Width', type: 'number', default: 0.12,
          description: 'Width of the downweighted border band as a fraction of image size per side (0–0.5). Increase if frame material is still attracting the centroid.' },
        { key: 'attentionWindow', label: 'Attention Window', type: 'number', default: 1.0,
          description: 'Extract a region this many times larger than the target, then let Sharp attention find the best sub-crop. Values > 1 (e.g. 1.3–1.5) help locate faces and subjects that low-variance coherence may miss.' },
      ] },
    { value: 'frame_aware_crop', label: 'Frame-Aware Crop — detect frame and fit to TV aspect ratio in one informed pass',
      replaces: ['frame_detect', 'aspect_crop'],
      options: [
        { key: 'strategy', label: 'Crop Strategy', type: 'select', default: 'centre',
          description: 'How to position the crop within the painting area when fitting to the TV aspect ratio. Centre avoids attention drifting toward frame material in the resize step.',
          choices: [
            { value: 'centre',    label: 'Center — crop from the geometric center (recommended)' },
            { value: 'attention', label: 'Attention — focus on faces and salient regions' },
            { value: 'entropy',   label: 'Entropy — focus on high-detail, textured regions' },
          ] },
        { key: 'detectionMode', label: 'Detection Mode', type: 'select', default: 'combined',
          description: 'Whether to use luminance, color (chromaticity), or both for frame detection.',
          choices: [
            { value: 'combined',  label: 'Combined (default) — luminance + color analysis' },
            { value: 'luminance', label: 'Luminance only' },
            { value: 'color',     label: 'Color only' },
          ] },
        { key: 'safetyMargin', label: 'Safety Margin', type: 'number', default: 0.01,
          description: 'Extra inward fraction added on critical edges where frame detection was uncertain (0.0–0.05).' },
      ] },
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
