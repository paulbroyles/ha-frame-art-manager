# Image Processing Pipeline

Web source images go through a three-phase pipeline before being sent to the TV:

1. **Background strip** (automatic) — remove solid-color borders using variance scan + contrast check (`solidBorderStrip`)
2. **Frame detector** (user-selected) — detect and remove decorative frames or borders
3. **Crop engine** — scale and crop to the TV's 4K aspect ratio (16:9 landscape or 9:16 portrait)

Phase 1 runs automatically whenever a frame detector is configured (including "None"). Stripping the solid background first ensures Phase 2 algorithms see the actual frame material in the corners, rather than featureless solid pixels that corrupt column-mean and corner-variance sampling. `solidBorderStrip` uses a per-row/column variance scan (not corner pixel matching) so it handles JPEG-artifact-noisy dark borders that Sharp Trim misses. Phases 2 and 3 are pluggable. The user selects them in the Web Sources → Settings tab.

> **TODO (advanced mode)**: Allow the frame detector field to accept an ordered list of pre-processors, enabling fully custom pipelines (e.g., background strip → frame detection → inner matte removal). See `imageProcessor.js` for details.

---

## Pre-processors

Frame detectors run as Phase 2 — after the automatic solid-border strip and before the TV-fit step. Their job is to identify and remove decorative picture frames, mattes, and borders from artwork images so the crop engine sees only painting content. Because Phase 1 has already removed solid-color backgrounds, these algorithms operate on images where the corners contain only frame material.

### Interface

```js
async (buffer, options) → Buffer
```

Each pre-processor receives the raw image buffer and an options object. It returns either a cropped buffer (frame removed) or the original buffer unchanged (no frame detected).

---

### None

Skips frame detection (Phase 2) entirely. The automatic solid-border strip (Phase 1) still runs. Use this for sources that are known to provide clean images with no decorative frames, or when you want to isolate the effect of the background strip alone.

---

### Mean Profile (`mean_profile`)

**Problem it solves**: All variance-based algorithms (Corner Consensus, Region Compare, Variance Scan) test whether frame pixels are *internally uniform* — low variance within each row or region. Textured frames (wood grain, gold leaf, canvas) fail this test: each row has high internal variance due to texture, even though all rows look similar to each other. Mean Profile uses a fundamentally different metric.

**Key insight**: A textured frame has high variance *within* each row but consistent *means* across rows — the texture averages out over the full width. Complex painting content has wildly varying row means. Testing the consistency of row means discriminates frame from painting better than testing per-pixel uniformity.

**Algorithm**:

1. **Decode and compute row means**: Compute full-width row means (`rowMeans[y]`) and a center-interior luminance reference (`interiorMean` from the center 50% block).

2. **Top/bottom — incremental scan** (`incrementalScan`): Starting from the outermost row, establish a reference mean (`refMean`) from the first 5 edge values (always pure frame material after Phase 1). Extend the "frame band" as long as each new row's luminance deviation from `refMean` stays below `consistencyThreshold`. Requires N=3 consecutive outliers before stopping (hysteresis guard — prevents isolated bright grain rows from prematurely terminating the scan). A runaway guard rejects the result if the scan reaches the cap with no natural stopping point (meaning the content never diverges from frame-like material). A contrast check (`refMean` vs `interiorMean`) rejects false positives. Minimum band size: 5 rows/cols.

   *Why refMean rather than running std dev*: Running std dev accumulates every row's mean and becomes less sensitive as the band grows. Deviation from a fixed refMean stays sharp at any band depth, which matters for wide frames.

   **Supplementary T/B stopping signals** (in addition to the main deviation check):

   - **`rowVariance` check**: For each row, compute within-row luminance variance (mean squared deviation from the row mean). Establish a reference variance from the first 5 frame rows. If `refVar ≥ 5` (non-trivial), fire when the current row's variance exceeds `refVar × 8`. Catches rows with abnormally high internal variation relative to the outer frame band.

   - **`rowMAD` check** *(primary supplementary signal)*: For each row, compute the mean absolute difference between horizontally adjacent pixels — `mean |pix(x,y) - pix(x+1,y)|`. This measures horizontal sharpness. Fires when row MAD exceeds `madAbsThreshold = 9` **or** (when `refMAD ≥ 0.5`) when row MAD exceeds `refMAD × 8`.

     *Key discriminating property*: Smooth cloudy gradients — including textured frame material with spatial color variation — have low pixel-to-pixel differences even when overall row variance is high. Geometric patterns (rugs, carpets, patterned floors) have sharp pixel-to-pixel jumps at design boundaries, producing high MAD. This signal correctly identifies structured painting content even when its row mean happens to be near the frame reference.

     *Example*: "The Alling Children" (Eddy, 1839) has a bottom rug whose row means are close to the frame reference (`refMean ≈ 43`), causing the luminance scan to underdetect. But the rug's geometric design produces `rowMAD ≈ 10–13` (above threshold) while the frame material has `rowMAD ≈ 2–7`. The MAD check correctly stops the scan at the frame/rug boundary.

   **T/B bevel continuation variance gate**: After the bevel continuation classifier (`columnPercentileScan`) proposes an extension, check the within-row variance of the rows at the immediate extension boundary before accepting it. Check only `extCheckN = min(5, extSimple)` rows (the first rows after the current crop boundary), not the full extension. If their mean variance exceeds `bevelExtVarThreshold = 1000`, reject the extension.

   *Why check only the first 5 rows*: The extension often includes both a transition zone (high-variance painting content at the boundary) and deeper background rows that may be uniformly dark (low variance). Averaging the full extension dilutes the boundary signal, causing genuinely wrong extensions to pass. Checking only the 5 rows immediately adjacent to the crop boundary isolates the transition zone and gives a reliable detection.

3. **Left/right — col medians in corner bands**: Column medians are computed using thin strips of rows at the *inner boundary* of the detected top/bottom frame bands (not the frame rows themselves). Frame rows are uniform across all columns (all wood, all gold) and provide no left/right discrimination. Interior-edge rows contain frame material at left/right column positions and painting content at center positions, making the signal discriminating.

   *Why median instead of mean*: Wood grain frames contain occasional bright grain rows that inflate the mean luminance of a column, causing the incremental scan to see them as outliers and stopping prematurely. The median is robust to these isolated bright rows. A range guard skips left/right detection if the column medians are flat across all columns (non-discriminating).

   **Supplementary L/R stopping signal — `colBandMAD`**: For each column, compute the mean absolute difference between vertically adjacent pixels within the corner band rows. Passed to the L/R incrementalScan as a supplementary stopping signal, using the same MAD check logic as for T/B.

   **Adaptive consistency threshold for near-black frames**: When the outermost edge columns have a very dark reference mean, the default `consistencyThreshold = 35` extends the consistent range up to `refMean + 35`, which can encompass moderately dark painting backgrounds (luminance 20–45) and cause the scan to overshoot by hundreds of pixels. The threshold is adaptively tightened: `threshold = min(consistencyThreshold, max(15, refMean × 2))`. For near-black references (e.g., `refMean = 9`), this gives `threshold ≈ 18`, keeping the consistent range within the true frame material and stopping the scan when the painting background first diverges. Unaffected for normal frames: `refMean ≥ 18` produces a threshold of `min(35, 36+) = 35` — no change.

   *Material-consistency rationale*: All four sides of a picture frame are made from the same material. When the T/B scan establishes that the frame is near-black (e.g., a dark stained wood frame), the L/R scan should apply the same tighter band when scanning the same material. A near-black frame that transitions to even moderately dark painting content represents a real frame/painting boundary — the adaptive threshold catches it.

4. **Symmetry guard**: After all four edges are scanned, compute the median of the four crop values. Reject any edge whose crop exceeds 4× that median. This catches runaway detections on one edge while the others correctly stop short.

5. **Cross-edge inference (primary)**: If one pair of edges is detected but the perpendicular pair is not, infer the missing pair using the detected pair's average thickness:
   - *L+R detected, T+B both missing*: infer from (L+R)/2 average using full-height col means
   - *L+R detected, T detected, B missing*: infer B ≈ T using `restrictedRowMean`
   - *L+R detected, B detected, T missing*: infer T ≈ B using `restrictedRowMean`
   - *T+B detected, L+R both missing*: infer from (T+B)/2 using full-height col means

   `restrictedRowMean(y, leftCols, rightCols)` computes row mean using only the detected frame-column strips (left + right edges), not the full row width. When frame columns are narrow, a full-width row mean is dominated by painting content and the contrast check fails even though the top/bottom frame material is clearly different from the interior. Restricting to the detected frame columns isolates the frame signal.

6. **Secondary inference — T/B-backed (for underdetected L/R)**: After primary detection and inference, if T and B are both detected but L and/or R appear underdetected (less than half the T/B average), re-infer using a two-step approach:

   *Step 1 (validate)*: Compute full-height col means for the estimated L/R band width. Frame columns reliably average darker than the painting interior over the full height because painting rows dilute but can't eliminate the frame signal. Reject if contrast is insufficient.

   *Step 2 (extend)*: Run `incrementalScan` on the corner-band col medians starting from `x=estimate` (the T/B average width), scanning outward toward the detected boundary. Starting at `x=estimate` instead of `x=0` avoids the **dark outer bevel problem** (see below). The scan can extend beyond the T/B estimate if additional frame material exists.

   **The dark outer bevel problem**: Some wood frames have a near-black outer bevel strip (median luminance ≈ 1–7) after Phase 1 strips the solid background. When scanning from `x=0`, this bevel establishes `refMean ≈ 1–7`. Normal wood grain at `x=10+` (median ≈ 35–85) deviates far from this refMean, so the scan stops immediately. The true frame/painting boundary at `x=90+` is never reached. By starting the extension scan at `x=estimate` (mid-frame wood grain zone, median ≈ 50), `refMean` is representative of actual frame material, and the painting edge (median ≈ 87+) produces a clear deviation that correctly stops the scan.

7. **Secondary inference — L/R-backed (for underdetected T/B)**: Symmetric to the above. If L and R are both detected but T and/or B appear underdetected (less than half the L/R average), re-infer T/B from the L/R estimate using `restrictedRowMean`.

**Handles**:
- Any border thickness (1px to wide frames) — no fixed sampling window
- Solid uniform borders
- Textured frames: wood grain, gold leaf, canvas — row means are consistent across the frame even when each row is internally varied
- Wood frames with dark outer bevels — T/B-backed secondary inference avoids the bevel contamination problem
- Dark frames meeting structured painting content (rugs, geometric floors) — rowMAD supplementary signal catches boundary even when row means are similar
- Near-black frames meeting dark painting backgrounds — adaptive L/R threshold tightens the consistent range proportionally to the reference, stopping at the true boundary
- Asymmetric detection — missing edges are inferred from detected perpendicular edges
- Per-edge independent detection with cross-edge consistency checks

**Failure modes**:
- Ornate or highly variable frames where the frame's own row means vary by more than `consistencyThreshold` across height (e.g., a gilded frame with complex shadows or color variation). Increasing `consistencyThreshold` may help but risks false positives.
- Paintings with a consistent-colored band at the edge whose mean differs from the interior — contrast check provides protection but isn't perfect
- Multi-layer frames where outer and inner layers have very different mean luminance (scan stops at the first layer boundary)
- Frames with a very narrow outer bevel at a completely different luminance than the main frame body — the bevel sets `refMean` and the main frame appears as outliers, stopping the scan prematurely. The T/B-backed secondary inference addresses this for L/R detection (see above). A future fix for T/B detection would be analogous.
- Paintings with near-black frames AND near-black painting backgrounds where the background is also below the adaptive threshold — the adaptive threshold cannot distinguish frame from painting if both have luminance < `refMean × 2`. The `colBandMAD` signal provides a secondary check but only helps when there is measurable vertical texture difference between frame and painting content.

**Parameters**:

| Parameter | Default | Description |
|---|---|---|
| `consistencyThreshold` | 35 | Max deviation from `refMean` for a row/col to continue the incremental scan. Solid borders: ≈ 5–10. Light texture (gold/gilded): ≈ 15–25. Moderate wood grain: ≈ 25–40. The frame→painting boundary jump is typically 40–80. |
| `contrastThreshold` | 20 | Min luminance difference between detected band (`refMean`) and `interiorMean` |
| `refFraction` | 0.03 | Fallback corner-band fraction when no top/bottom frame detected |
| `maxCropFraction` | 0.25 | Hard cap per edge |

---

### Corner Consensus (`corner_consensus`)

**Problem it solves**: Edge-strip sampling algorithms (like Region Compare) are diluted by painting content — a left/right strip spanning the full image height picks up the painting as well as the frame. The frame signal gets averaged away.

**Key insight**: The four corners of a framed image contain only frame pixels — no painting content reaches into the corners. This makes corners a clean, reliable sample.

**Algorithm**:

1. Sample four small corners — each `cornerFraction` (default 10%) of the image dimensions. These are guaranteed to be pure frame if a frame exists.
2. Require **all three** gate conditions before any cropping occurs:
   - **Uniformity**: All four corners have luminance variance < `uniformityThreshold` (default 400). Ensures corners are actually frame-like (solid or lightly textured), not painting content.
   - **Consistency**: Std dev of the four corner mean luminances < `consistencyThreshold` (default 30). Ensures all four corners look like the *same* material — consistent with a single frame.
   - **Contrast**: The average corner luminance differs from the center interior by > `contrastThreshold` (default 15). Ensures the frame is visually distinguishable from the painting.
3. If the gate passes, compute an **adaptive scan threshold**: `max(uniformityThreshold, avgCornerVariance × 4)`. The 4× multiplier is key for multi-layer frames (e.g., solid black outer border + textured gold/wood inner frame): if the inner frame's per-row variance is below the adaptive threshold, the scan continues through it.
4. Scan all four edges inward using per-row and per-column variance. Extend the crop while variance stays below the adaptive threshold; stop at the first row/column that exceeds it (painting content).
5. Apply `maxCropFraction` (default 25%) as a hard safety cap per edge.

**Handles**:
- Solid uniform borders (black, white, gray)
- Multi-layer frames (solid outer + textured inner)
- Asymmetric frames (detects each edge independently via per-row/col scan)
- No false positives on paintings whose edges are dark or simple — the contrast and consistency gates prevent this

**Failure modes**:
- Paintings where the corners genuinely look like frames (very simple, uniform corner content). The contrast gate usually protects against this.
- Frames that match the painting in luminance (e.g., a sand-colored frame around a sandy landscape). Uncommon in practice.
- Textured frames whose corner variance exceeds `uniformityThreshold` — the gate rejects the frame entirely and no cropping occurs.

**Parameters**:

| Parameter | Default | Description |
|---|---|---|
| `cornerFraction` | 0.10 | Size of each corner sample (each dimension, as fraction of image size) |
| `uniformityThreshold` | 400 | Max corner luminance variance to be treated as "uniform frame material" |
| `consistencyThreshold` | 30 | Max std dev of the four corner means — guards against coincidentally uniform painting corners |
| `contrastThreshold` | 15 | Min luminance difference between corner cluster and center interior |
| `maxCropFraction` | 0.25 | Hard cap on how much of any single edge may be cropped |

---

### Region Compare (`region_compare`)

**Problem it solves**: Pure variance checks (like Variance Scan) can't distinguish a dark painting edge from a dark frame — both have low variance. Region Compare adds a global decision gate using a comparison between the edge and the painting interior.

**Algorithm**:

Per edge (top, bottom, left, right):
1. Sample the outer edge strip (`edgeFraction`, default 10% of that dimension).
2. Sample the center interior block (`interiorFraction`, default 50% of both dimensions).
3. Crop only if **both** conditions hold:
   - Edge strip variance < `uniformityThreshold` (the border is uniform)
   - |edge mean − interior mean| > `contrastThreshold` (the border is visually distinct)
4. If conditions met, scan inward using an adaptive threshold: `max(uniformityThreshold, edgeVariance × 3)`.

**Key limitation**: Left/right edge strips sample the full image height, which mixes frame and painting pixels. This dilutes the frame signal and can cause asymmetric cropping — top/bottom detected but sides missed. Corner Consensus was designed to fix this.

**Parameters**:

| Parameter | Default | Description |
|---|---|---|
| `edgeFraction` | 0.10 | Width of the sampled edge strip |
| `interiorFraction` | 0.50 | Size of the sampled center block |
| `uniformityThreshold` | 300 | Max edge variance to be "uniform" |
| `contrastThreshold` | 15 | Min luminance difference edge vs. interior |
| `maxCropFraction` | 0.25 | Hard cap per edge |

---

### Variance Scan (`variance_scan`) — legacy

Scans inward from each edge. Rows/columns with luminance variance below `varianceThreshold` are considered frame material; scanning stops at the first high-variance row/column.

**Fundamental limitation**: Makes only a local decision — cannot distinguish dark painting edges from dark frames. Prone to false positives (removes painting content) and false negatives (misses frames that blend with the painting). Superseded by Region Compare and Corner Consensus.

**Parameters**:

| Parameter | Default | Description |
|---|---|---|
| `varianceThreshold` | 400 | Min variance to be treated as painting content |
| `maxCropFraction` | 0.25 | Hard cap per edge |

---

### Sharp Trim (`trim`)

Delegates to Sharp's built-in `trim()`. Removes edge pixels that match the corner pixel color within a tolerance. Works only for solid, perfectly uniform borders — any textured or multi-colored frame is ignored.

**Note**: Sharp Trim is also the automatic Phase 1 background strip (threshold 10). Selecting `trim` as the Phase 2 detector is redundant — Phase 1 will have already handled the solid border. Equivalent to selecting `None`.

**Parameters**:

| Parameter | Default | Description |
|---|---|---|
| `threshold` | 10 | Color similarity tolerance (0–255) |

---

### Frame Boundary (`frame_boundary`)

Detects the inner edge of a picture frame using per-row/column Sobel edge-density analysis. The frame-to-canvas boundary creates a nearly continuous horizontal or vertical line of strong edges spanning the full image width or height. The pre-processor scans inward from each edge within `maxCropFrac` and crops to the innermost row/column where the fraction of above-threshold edge pixels exceeds `minEdgeDensity`.

**Best for**: Ornate gilt frames, carved wood frames, multi-profile gilded frames — any frame where the inner canvas edge creates a clean, strong line.

**Algorithm**:
1. Downscale to 600 px (long side) for analysis speed.
2. Greyscale + Gaussian blur σ=1.5 to suppress texture noise while preserving hard frame edges.
3. Compute Sobel edge magnitude at each pixel.
4. Scan each edge inward up to `maxCropFrac`; find the innermost row/column where edge density ≥ `minEdgeDensity`.
5. Extract original image inside the detected boundary.

**Tuning**:
- If the crop is eating into the painting, raise `minEdgeDensity` (→ 0.50+) or lower `maxCropFrac`.
- If the frame is not being removed, lower `edgeThreshold` or raise `maxCropFrac`.
- The Gaussian pre-blur (σ=1.5) is fixed; strong ornament detail in the frame may still produce high magnitude values, but individual pixels in the painting interior won't typically form a full-width dense line.

**Parameters**:

| Parameter | Default | Description |
|---|---|---|
| `maxCropFrac` | 0.25 | Maximum fraction of each dimension to scan inward |
| `minEdgeDensity` | 0.40 | Fraction of row/col pixels above threshold that defines a frame boundary line |
| `edgeThreshold` | 20 | Sobel magnitude threshold (post-blur) |

---

## Crop Engines

Crop engines run after Phase 2. They receive a clean image buffer and fit it to the TV's 4K resolution.

### Interface

```js
async (buffer, inputW, inputH, targetW, targetH, options) → Buffer
```

The engine must scale down if needed and crop to the target dimensions. It must never upscale — `computeTargetDimensions()` in `imageProcessor.js` guarantees `targetW ≤ inputW` and `targetH ≤ inputH`.

---

### Sharp (`sharp`)

Uses Sharp's `resize()` with `fit: 'cover'`. The `position` option controls where the crop anchor lands.

**Strategies**:

| Value | Description |
|---|---|
| `attention` | Saliency-based — favors faces and high-contrast subjects. Best for paintings, especially portraits and figurative work. **(recommended)** |
| `entropy` | Maximizes Shannon entropy — favors complex, textured regions |
| `centre` | Crops from the geometric center — predictable, no analysis |

---

### Face-Aware (`face_aware`)

Detects faces using `@vladmandic/face-api` (TinyFaceDetector model, ~190 KB weights, bundled in the package). Runs inference on a pure-JS TF.js CPU backend — no native deps, Alpine/musl compatible.

**Algorithm**:
1. Downscale to 416 px (max dimension) for detection.
2. Build a `tf.Tensor3D` from Sharp raw pixels (bypasses the browser canvas API).
3. Run TinyFaceDetector with `scoreThreshold` (default 0.35 — lower than the photo default of 0.5 to catch stylised/painted faces).
4. Compute a confidence×area-weighted centroid over all detected face bounding boxes.
5. Perform a cover-fit crop centred on the focal point (Sharp resize + extract).
6. If no faces are detected (or face-api fails to load), falls back to Sharp's `fallbackStrategy`.

**Best for**: Portraits, figurative and religious paintings, historical group scenes.  
**Fallback behaviour**: Abstract, landscape, and still-life paintings with no detectable faces automatically use Sharp attention/entropy/centre (configurable via `fallbackStrategy`).

**Performance**: Model loads once at first call (~1–2 s). Subsequent calls: ~0.5–1 s for detection + crop. First boot may be slower if the model is not yet cached.

**Parameters**:

| Parameter | Default | Description |
|---|---|---|
| `scoreThreshold` | 0.35 | Minimum face confidence (0–1). Lower catches more stylised faces; raise to reduce false positives. |
| `fallbackStrategy` | `'attention'` | Sharp strategy to use when no faces are found (`'attention'`, `'entropy'`, `'centre'`). |

---

## Dimension Computation

`computeTargetDimensions(inputW, inputH, orientation)` in `imageProcessor.js` determines the output dimensions before passing to the crop engine.

Rules:
- If the input is wider than the target aspect ratio, height is the anchor (full height preserved, width cropped).
- If the input is taller, width is the anchor.
- If the anchor dimension exceeds 4K, scale down to fit exactly. Otherwise, preserve original resolution (no upscaling).
- The output is always at or below 4K in both dimensions.

Target resolutions: 3840×2160 (landscape) and 2160×3840 (portrait).

---

## Known Limitations

### Angled frame boundaries

The col median scan operates on fixed horizontal bands. If a frame boundary is not perfectly vertical (e.g., slight perspective causes the right frame edge to angle inward toward the bottom), the median-based detection gives an average position across the full height rather than the true boundary at each point. This results in slight under-cropping on the angled side — the detected boundary is a compromise between where the frame starts at the top and where it starts at the bottom.

**Verified on**: Met Museum #435765 (wood-grain frame, right side). The right boundary was detected at 89px while the left (more uniform) was 98px. The right frame edge visibly angles inward toward the bottom, so 89px was the averaged position rather than the true outermost boundary.

**Strategy for future fix**: Run the col median scan over multiple independent horizontal bands (e.g., top third, middle third, bottom third) and take the minimum result across bands. The minimum represents the most conservative detection — the point where the frame is narrowest (where it enters furthest into the image). This would give a crop that is correct at all heights, though it will under-crop slightly at heights where the frame is widest. Alternative: detect the frame boundary as a line rather than a single value (using a per-row col scan and fitting a line through the detected boundary positions).

---

## Test Images

Images used to develop and validate the pipeline. Useful for regression testing.

| Image | Source | URL | Frame type | Notes |
|---|---|---|---|---|
| #435765 | Met Museum | https://www.metmuseum.org/art/collection/search/435765 | Wide wood-grain frame with dark outer bevel | Used to develop T/B-backed secondary inference and the dark outer bevel fix. Expected: T=56px, B=56px, L≈98px, R≈89px (right slightly under due to angled frame boundary). |
| #435766 | Met Museum | https://www.metmuseum.org/art/collection/search/435766 | Gold/gilded frame | Confirmed working correctly with mean_profile prior to #435765 work. |
| The Alling Children (Eddy, 1839) | Google Arts & Culture | https://artsandculture.google.com/asset/the-alling-children-oliver-tarbell-eddy/JwH5kBlpDwKbBA | Thin dark wood frame, trapezoidal (wider at top), painting has dark interior background | Stress test: bottom frame has high row variance (frame material has tonal variation) but low rowMAD (cloudy gradient), while the rug below has high rowMAD (geometric pattern). L/R frame is near-black (refMean≈9) meeting a dark painting interior — without adaptive threshold, the right scan would overshoot to 821px. Used to develop rowMAD supplementary signal, T/B bevel continuation variance gate, and adaptive L/R threshold. Expected: T≈16px, B≈19px, L≈64px, R≈35–45px. |
| Summer Evening on Skagen's Beach (Krøyer, 1899) | Wikimedia Commons | https://commons.wikimedia.org/wiki/File:P_S_Krøyer_1899_-_Sommeraften_ved_Skagens_strand._Kunstneren_og_hans_hustru.jpg | No frame (clean scan) | **Known failure** with `coherence_scan`: atmospheric gradient sky (top) and flat sandy beach (bottom) both have very low tile variance, indistinguishable from frame material. Scanner reaches `maxCropFrac` on both edges, catastrophically destroying the composition. Root cause: `maxCropFrac` cap accepted rather than rejected — see Future Work. Expected: 0px crop on all edges. |

---

## Performance

Measured on Met Museum #435765 (~4MB JPEG, 3000×2385px), using `mean_profile` + `sharp` crop engine.

| Phase | Breakdown | Total |
|---|---|---|
| Phase 1 — solidBorderStrip | decode 112ms, scan 33ms, encode 161ms | **306ms** |
| Phase 2 — mean_profile | decode 82ms, rowMeans 57ms, T/B scan 0ms, colMedians 113ms, inference 50ms, encode 142ms | **444ms** |
| Phase 3 — sharp crop | 137ms | **137ms** |
| **Pipeline total** | | **~887ms** |

Notable observations:
- **Encode/decode round-trips dominate**: Phase 1 encodes (161ms) and Phase 2 immediately decodes (82ms) the same pixel data — 243ms of pure overhead. Passing a raw pixel buffer between phases would eliminate this.
- **colMedians is the most expensive compute step** (113ms) — sorting pixel values for every column across the corner bands.
- **T/B row-mean scan is nearly free** (0ms) — simple running mean over pre-computed rowMeans.

---

## Code Organization

The image processing pipeline lives in `frame_art_manager/app/utils/`:

```
utils/
  imageProcessor.js          — pipeline orchestrator: solidBorderStrip, computeTargetDimensions,
                               processWebSourceImage, IMAGE_PROCESSING_SCHEMA, module.exports
  preprocessors/
    trim.js                  — trimPreProcessor
    varianceScan.js          — varianceScanPreProcessor
    regionCompare.js         — regionComparePreProcessor
    cornerConsensus.js       — cornerConsensusPreProcessor
    meanProfile.js           — meanProfilePreProcessor
    tileColor.js             — tileColorPreProcessor
    symmetricScan.js         — _symmetricScanCore, symmetricScanPreProcessor
    adaptiveScan.js          — adaptiveScanPreProcessor (imports _symmetricScanCore from symmetricScan.js;
                               lazy-requires ./index for fallback lookup to avoid circular dependency)
    index.js                 — PRE_PROCESSORS registry; re-exports all pre-processor functions
  cropEngines/
    sharpCrop.js             — sharpCropEngine
    index.js                 — CROP_ENGINES registry; re-exports all crop engine functions
```

`imageProcessor.js` is the public API — callers import from it and it re-exports `PRE_PROCESSORS`, `CROP_ENGINES`, and `IMAGE_PROCESSING_SCHEMA` from the sub-directories. Adding a new pre-processor or crop engine means: (1) create its file in the appropriate sub-directory, (2) register it in the sub-directory's `index.js`, (3) add it to the schema in `imageProcessor.js`, and (4) update this document.

---

## Future Work

## Known Crop Failures

A running list of real images that exposed crop algorithm weaknesses, kept as ground-truth test cases for future improvements.

| Image | Source | Failure mode | Root cause | Status |
|---|---|---|---|---|
| [P.S. Krøyer — Summer Evening on Skagen's Beach (1899)](https://commons.wikimedia.org/wiki/File:P_S_Kr%C3%B8yer_1899_-_Sommeraften_ved_Skagens_strand._Kunstneren_og_hans_hustru.jpg) | Wikimedia Commons | Catastrophic vertical overcrop | Smooth sky+sand, both low-variance → coherence scan hit `maxCropFrac` on top+bottom and accepted the cap as a crop result | Unresolved; tracked under `maxCropFrac as failure signal` below |
| [Gabrielle d'Estrées et une de ses sœurs (c.1594)](https://www.wikidata.org/wiki/Q542066) | Wikidata | Crop centered on blank space between two figures | coherenceCrop centroid attracted to low-contrast skin/background region between figures; tiny 1:1-pixel extraction window (9.7% of image) magnified the error | Partially mitigated by `minCoverageFrac` guard (falls back to center crop when extraction < 25% of cover-fit area) |
| [George Bellows — Nude with Fan (1920)](https://www.wikidata.org/wiki/Q132133824) | Wikidata | Figure's head cropped out; side-clipping loses subject | coherenceCrop extracts 1:1-pixel window (3840×2160) from full-res portrait image; this clips the figure horizontally and the centroid (drawn to torso) clips the head vertically. Preserving width and cropping only from the bottom would be acceptable. | Unresolved; tracked under `coherenceCrop extraction scale` below |

---

## Future Work

**`maxCropFrac` as failure signal**: Every variance-based preprocessor has a hard cap (`maxCropFrac`, default 0.25–0.30) that limits how much can be cropped per edge. Currently, reaching the cap is treated as a successful crop result. It should instead be treated as a failure: the scanner was still seeing "frame material" at the cap boundary, meaning it never found a genuine interior-to-frame transition — it was probably scanning into painting content. The correct response when the cap is hit is to reject the crop on that edge (return 0 for that edge, not the cap value), or to discard the preprocessor's output entirely and return the original buffer. This change would have prevented the catastrophic overcrop of low-variance paintings like Krøyer's *Summer Evening on Skagen's Beach* (P.S. Krøyer, 1899 — atmospheric sky + sand, both very low variance, scan hit cap on top and bottom). Apply to all preprocessors that use `maxCropFrac`: `coherence_scan`, `variance_scan`, `region_compare`, `corner_consensus`, `mean_profile`, `tile_color`, `symmetric_scan`, `adaptive_scan`.

**Per-source pipeline configuration**: Currently image processing settings (preprocessor, crop engine, options) are global. Sources that never serve framed images (e.g. Wikimedia Commons, institutional uploads) should be able to specify more conservative preprocessing options or a different preprocessor without affecting sources where frame detection is valuable. Implementation note: cannot skip preprocessing entirely even for frameless sources — the pipeline still needs to crop to the target 4K resolution. The per-source config should allow overriding `preProcessorOptions` (e.g. lower `coherenceThreshold`, lower `maxCropFrac`) or selecting a different preprocessor, not suppressing the crop-to-target step. Likely implementation: add an optional `imageProcessingOverrides` object to each BUILTIN_SOURCES entry that gets merged into the global config at fetch time.

**Raw buffer pipeline**: Pass raw pixel data (`{ data, info }`) between phases instead of encoding/decoding between each phase. This would save ~240ms per image (the Phase 1 encode + Phase 2 decode round-trip). The pre-processor interface would need a parallel raw-buffer path while keeping the current `async (buffer, options) → Buffer` interface for compatibility.

**coherenceCrop centroid quality for symmetric/multi-subject compositions**: The variance-weighted centroid works well for single-subject paintings but fails on symmetric compositions (two figures side by side, bilateral symmetry) and paintings where the most visually complex region is not the intended focal point. When two subjects have equal variance, the centroid lands between them. Possible improvements: (1) face/saliency detection to anchor the centroid to a detected subject region; (2) multi-centroid sampling (find the N highest-variance peaks and pick the one furthest from blank regions); (3) require the centroid to fall within a minimum-variance region (reject centroids that land in low-variance zones like skin or sky). The `minCoverageFrac` guard (fallback to center crop) is a conservative safety net but does not fix the centroid — it just prevents catastrophic crops on very large images.

**coherenceCrop extraction scale for large images**: coherenceCrop extracts exactly `targetW × targetH` pixels from the original at 1:1 scale. For high-res images (e.g. 10000×7500 → 3840×2160 target), this means using only ~10% of the image area. Any centroid error is magnified in proportion to how much the image exceeds the target size. The correct behavior for a large image with no frame to remove would be to scale down first and then crop (cover-fit style), not to extract a tiny 1:1 patch. Consider making the extraction window scale-aware: use the cover-fit extraction area as the minimum window size, and only zoom in further when a focus window (from `ml_subject` or `peak_variance`) specifically requests it.

**Option 3 — ML segmentation**: See `docs/ROADMAP.md`. Using ONNX Runtime + a fine-tuned segmentation model (SAM or SegFormer) to handle irregular and ornate frames that defeat variance-based approaches.