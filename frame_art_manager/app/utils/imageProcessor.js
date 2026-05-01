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
  recursive = false,
  maxPasses = 3,
} = {}) {
  // Map legacy params to pipeline steps.
  // preProcess = null  → skip phases 1+2; only crop
  // preProcess = 'none' → background strip only (PRE_PROCESSORS['none'] is undefined)
  // preProcess = <key> → background strip + pre-processor + crop
  const steps = [];

  if (preProcess != null) {
    steps.push({ key: 'background_strip' });
    if (preProcess !== 'none' && PROCESSORS[preProcess]) {
      steps.push({ key: preProcess, options: preProcessOptions, recursive, maxPasses });
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
    { value: 'frame_boundary',   label: 'Frame Boundary — detect frame edge using Sobel edge-density analysis; finds the innermost near-continuous line spanning the full image width/height',
      options: [
        { key: 'maxCropFrac', label: 'Max Crop Fraction', type: 'number', default: 0.25,
          description: 'Maximum fraction of each dimension to scan inward from the edge (0.05–0.40). Increase for wide frames, decrease to protect paintings with strong compositional lines near the border.' },
        { key: 'minEdgeDensity', label: 'Min Edge Density', type: 'number', default: 0.40,
          description: 'Fraction of pixels in a row or column that must exceed the edge threshold to be considered a frame boundary line (0–1). Raise (0.5+) to avoid false positives on paintings with prominent horizontal/vertical composition lines.' },
        { key: 'edgeThreshold', label: 'Edge Threshold', type: 'number', default: 20,
          description: 'Sobel magnitude threshold (post Gaussian blur) above which a pixel is counted as an edge (0–255). Lower catches softer frame edges; raise to ignore subtle texture gradients.' },
        { key: 'crossSideValidation', label: 'Cross-Side Validation', type: 'boolean', default: true,
          description: 'When top/bottom detect a border but left/right return nothing (or vice versa), test whether the missing sides have similar border material at the same depth. Helps with thin uniform borders where Sobel finds the horizontal edge line but misses the vertical.' },
        { key: 'crossMeanTolerance', label: 'Cross-Side Mean Tolerance', type: 'number', default: 45,
          description: 'Maximum luminance difference (0–255) between the reference and candidate side for cross-side inference to fire. Lower values are more conservative; raise if similar-colored frames on different sides are being missed.' },
        { key: 'crossVarMax', label: 'Cross-Side Reference Variance Max', type: 'number', default: 800,
          description: 'Maximum pixel variance in the reference side\'s central band. High variance indicates a complex or multi-layer frame that should not be used as a cross-side anchor — defer to recursive stripping instead. Raise cautiously; increasing this risks propagating false detections from ornate outer layers.' },
        { key: 'crossCandVarMax', label: 'Cross-Side Candidate Variance Max', type: 'number', default: 1500,
          description: 'Maximum pixel variance in the candidate (missing) side\'s central band. Higher than the reference threshold to allow textured single-layer materials (e.g. wood grain, ~1300) to be inferred while still blocking complex painting content. Lower to 800 if textured-frame false positives appear.' },
        { key: 'minConfidence', label: 'Min Detection Confidence', type: 'number', default: 0.40,
          description: 'Discard per-side detections below this confidence score (0–1). Higher values are more conservative: non-uniform edges (e.g. a rounded head at the border) are rejected before cropping. Lower values allow thinner or weaker frame detections through.' },
      ] },
    { value: 'variance_scan',    label: 'Variance Scan — detect frames by local edge variance (legacy)' },
    { value: 'trim',             label: 'Sharp Trim — background strip only (same as None; redundant with automatic Stage 1)' },
    // TODO (Option 3): ML Segmentation — handles irregular/ornate frames; see docs/ROADMAP.md
  ],
  windowSetters: [
    { value: 'ml_subject', label: 'ML Subject — detect foreground subject with RMBG-1.4 and set focus window (~11 s; model cached after first use)',
      options: [
        { key: 'threshold', label: 'Mask Threshold', type: 'number', default: 0.5,
          description: 'Mask confidence above which a pixel is considered foreground (0–1).' },
        { key: 'padFraction', label: 'Padding', type: 'number', default: 0.10,
          description: 'Expand the detected bounding box by this fraction of its dimension on each edge.' },
      ] },
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
        { key: 'minCoverageFrac', label: 'Min Coverage Fraction', type: 'number', default: 0.25,
          description: 'Safety threshold (0–1): if the extraction window covers less than this fraction of what a natural cover-fit would use, fall back to center crop. Catches catastrophic crops on large high-res images with a mis-placed centroid. Lower = more permissive; higher = stricter fallback.' },
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
    { value: 'face_aware', label: 'Face-Aware — detect faces and centre the crop on the confidence-weighted face centroid; falls back to Sharp attention (or configurable strategy) when no faces are found',
      options: [
        { key: 'scoreThreshold', label: 'Face Confidence Threshold', type: 'number', default: 0.35,
          description: 'Minimum face detection confidence (0–1). Default 0.35 is intentionally lower than the photo default (0.5) to catch stylised painted faces. Raise to reduce false positives on face-shaped objects in abstract work.' },
        { key: 'fallbackStrategy', label: 'Fallback Strategy', type: 'select', default: 'attention',
          description: 'Sharp crop strategy used when no faces are detected.',
          choices: [
            { value: 'attention', label: 'Attention — saliency-based (default)' },
            { value: 'entropy',   label: 'Entropy — high-detail regions' },
            { value: 'centre',    label: 'Center — geometric center' },
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
