# Image Processing Pipeline

Web source images go through a three-phase pipeline before being sent to the TV:

1. **Background strip** (automatic) — remove solid-color borders using Sharp Trim
2. **Frame detector** (user-selected) — detect and remove decorative frames or borders
3. **Crop engine** — scale and crop to the TV's 4K aspect ratio (16:9 landscape or 9:16 portrait)

Phase 1 runs automatically whenever a frame detector is configured (including "None"). Stripping the solid background first ensures Phase 2 algorithms see the actual frame material in the corners, rather than featureless solid pixels that corrupt column-mean and corner-variance sampling. Phases 2 and 3 are pluggable. The user selects them in the Web Sources → Settings tab.

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

1. Compute full-width row means (`rowMeans[y]`).
2. **Top/bottom — incremental scan**: Starting from the outermost row, accumulate a running mean and std dev of row means. Extend the "frame band" as long as including the next row keeps the running std dev below `consistencyThreshold`. Stop on the first row that would break consistency. No fixed pre-gate window — works for any border thickness.
3. **Post-scan contrast check**: The detected band mean must differ from the center interior by more than `contrastThreshold`. Discards false positives on uniform-colored painting edges. Also requires a minimum band size of 5 rows/cols.
4. **Left/right — interior-edge col means**: Column means are computed using a thin strip of rows at the *inner boundary* of the detected top/bottom frame bands (not the frame rows themselves). Frame rows are uniform across all columns (all gold, all black) and provide no left/right discrimination. Interior-edge rows contain frame material at frame-column positions and painting content at center positions, making col means discriminating. A range guard skips left/right detection if col means are still flat across all columns. Falls back to near-edge rows when no top/bottom frame was detected.

**Handles**:
- Any border thickness (1px to wide frames) — no fixed sampling window
- Solid uniform borders
- Textured frames: wood grain, gold leaf, canvas — row means are consistent across the frame even when each row is internally varied
- Per-edge independent detection

**Failure modes**:
- Ornate or highly variable frames where the frame's own row means vary by more than `consistencyThreshold` (e.g., a gilded frame with complex shadows or color variation across height)
- Paintings with a consistent-colored band at the edge whose mean differs from the interior — contrast check provides protection but isn't perfect
- Multi-layer frames where outer and inner layers have very different mean luminance (scan stops at the first layer boundary)

**Parameters**:

| Parameter | Default | Description |
|---|---|---|
| `consistencyThreshold` | 20 | Max running std dev of row/col means to continue scan. Solid: ≈ 1. Light texture: ≈ 5–12. Moderate wood grain: ≈ 15–20. |
| `contrastThreshold` | 20 | Min luminance difference between detected band and interior |
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

## Crop Engines

Crop engines run after Phase 2. They receive a clean image buffer and fit it to the TV's 4K resolution.

### Interface

```js
async (buffer, inputW, inputH, targetW, targetH, options) → Buffer
```

The engine must scale down if needed and crop to the target dimensions. It must never upscale — `computeTargetDimensions()` in `imageProcessor.js` guarantees `targetW ≤ inputW` and `targetH ≤ inputH`.

---

### Sharp (`sharp`) — the only current engine

Uses Sharp's `resize()` with `fit: 'cover'`. The `position` option controls where the crop anchor lands.

**Strategies**:

| Value | Description |
|---|---|
| `attention` | Saliency-based — favors faces and high-contrast subjects. Best for paintings, especially portraits and figurative work. **(recommended)** |
| `entropy` | Maximizes Shannon entropy — favors complex, textured regions |
| `centre` | Crops from the geometric center — predictable, no analysis |

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

## Future Work

**Option 3 — ML segmentation**: See `docs/ROADMAP.md`. Using ONNX Runtime + a fine-tuned segmentation model (SAM or SegFormer) to handle irregular and ornate frames that defeat variance-based approaches.