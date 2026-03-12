## Future Investigations

### Spatial block coherence for contamination detection (mean_profile pre-processor)

**Problem**: The current `hotFrac` contamination check in `incrementalScan` counts the fraction
of pixels per row that deviate significantly from the row mean. This fails in two ways:
- **False negatives**: A thin strip of painting content (face occupying only 5–8% of row width)
  may have hotFrac below the 0.08 threshold and go undetected.
- **False positives**: Textured frame material (wood grain, rough plaster) has many pixels that
  deviate from the row mean, triggering the check even though they are frame, not painting.

**User insight**: Hot pixels should be defined as "pixels very different from surrounding
content" — i.e., local contrast, not global row deviation. A grain pixel on a dark frame IS
very different from the row average, but NOT different from its immediate neighbors (there
are other similar grain pixels nearby). A face pixel in a dark background IS different from
its immediate neighbors. The key discriminator is **spatial coherence across adjacent rows**:
painting subjects produce edge columns (large horizontal gradient) that appear at the *same
column positions* across many consecutive rows; frame texture produces random edge positions
that vary row to row.

**Proposed implementation** (horizontal gradient + column coherence):

1. **Per-row edge detection**: For each row `y` being scanned, compute the horizontal gradient
   magnitude at each column: `grad[x] = |pixelLum(y, x+1) - pixelLum(y, x-1)|`. Mark column
   `x` as an "edge column" for row `y` if `grad[x] > edgeThreshold` (e.g., 30 lum units).
   No library needed — computed directly from the raw buffer via `pixelLum`.

2. **Cross-row coherence tracking**: Maintain a `colEdgeCount[x]` array (width-sized) counting
   how many of the last N scan rows had an edge at column `x` (within a tolerance window of
   ±W columns). Increment on each newly scanned row; decay or reset when a row has no edge
   at `x`.

3. **Contamination trigger**: If any column `x` has `colEdgeCount[x] >= coherenceN` (e.g., 3
   consecutive rows all had an edge near column `x`) → structural content detected →
   treat as contamination and reject the scan (return 0), same as the current hotFrac trigger.

4. **Apply to both row and column scans**: The row scan (T/B edges) checks horizontal gradients
   per row; the column scan (L/R edges) checks vertical gradients per column (same logic,
   transposed). `cornerColHotFracs` used in the L/R `incrementalScan` can be replaced with
   the analogous column-wise coherence check.

**Advantages over hotFrac**:
- Immune to sparse, random texture (grain positions vary row to row → no coherent column)
- Detects narrow painting subjects (even 5% face width creates a clear edge at both sides)
- Naturally handles all frame luminance levels (no absolute or relative threshold needed —
  it's purely about local gradient, not deviation from row mean)
- Applicable to color channels too: compute gradient on each RGB channel and OR the results

**Key parameters to calibrate**:
- `edgeThreshold`: minimum gradient to count as an edge (start at 30 lum)
- `toleranceW`: column match window (start at ±5px to handle slight row-to-row registration)
- `coherenceN`: consecutive rows required (3, matching current hotHystN)

**Files to modify**: `meanProfilePreProcessor` in `app/utils/imageProcessor.js`.
Replace the `rowHotFracs` array and `rowHotFrac(y)` function with a gradient-based scan
integrated into the `incrementalScan` loop (or as a pre-computed per-row edge-column set).

### Flood-fill / connected-components frame region detection

**Motivation**: Row/column mean-based approaches (meanProfile, tileColor) can't distinguish
frame material from painting content when they share similar color or luminance. A flood-fill
approach finds the frame as a connected color region starting from the image edges, which
naturally handles irregularly-shaped or multi-color frames without needing per-row statistics.

**Known motivating failure (Met 437878)**: Thin black outer border + narrow ornate gold frame.
`symmetric_scan` cannot detect this frame because: (a) the gold frame body shows only 60–65%
cross-sample color agreement (ornate gilding has internal tonal variation) — below the 70%
threshold needed for an anchor; and (b) the warm painting background is also depth-consistent,
so per-sample stability cannot distinguish "still in frame" from "gradually-varying painting."
A flood-fill starting from the image perimeter would naturally include the gold frame region
(connected to the edge, consistent color relative to neighbors) without needing global agreement.

**Algorithm**:
1. Downsample image (400–600px) and decode to raw RGB.
2. Seed the fill from all four edge pixel strips (outermost 1–2px rows/cols).
3. BFS/DFS outward from seeds, accepting pixels within `colorTolerance` (Euclidean RGB
   distance) of the local neighborhood mean. The fill grows the "frame region."
4. Stop when no new pixels can be added — the fill boundary is the frame-painting edge.
5. For each edge, find the deepest filled row/column → that is the crop amount.

**Advantages over tile-color continuity**:
- Naturally 2D: the fill follows actual color regions rather than scanning in a fixed direction.
- Handles irregular frames (scalloped edges, partial gilding) because it follows the actual
  shape of the color region, not just a perpendicular scan.
- Cross-side consistency is implicit: the fill on all four sides uses the same color tolerance
  and will stop at the same frame-painting boundary if the frame color is uniform.

**Key challenges**:
- **Tolerance choice**: too tight → fill stops in frame imperfections; too loose → bleeds into
  painting. May need an adaptive tolerance (e.g., based on edge pixel color variance).
- **Dark-background false positives**: dark painting backgrounds starting from the edge look
  like frame material. Same problem as meanProfile's dark-bg issue. Guard: if fill covers
  >50% of the image area, reject (not a frame).
- **Ornate multi-layer frames**: the fill may stop at an inner bevel layer rather than the
  full frame. Repeated fill passes with different seeds/tolerances might help.
- **Performance**: flood fill at full resolution is expensive. At 600px downsampled, BFS
  over ~360K pixels is fast (<100ms), but border bookkeeping adds overhead.

**Implementation note**: Can borrow the `tileMeanRGB` infrastructure from `tileColorPreProcessor`
for local color estimates. The fill itself needs a visited-pixel bitset and a BFS queue.

**Integration**: Add as `flood_fill` in `PRE_PROCESSORS`. Start with a fixed tolerance of
~20–30 RGB units and the 50%-area guard. Build on top of the existing downsample+raw pattern.

### ML-based frame segmentation (pre-processor Option 3)
The current frame detection pre-processors (`variance_scan` and `trim`) handle solid
and lightly-textured borders well, but struggle with ornate or highly irregular decorative
frames. A more robust approach would use a pre-trained ML model to segment the painting
region from the surrounding frame.

**Candidate approach**: ONNX Runtime (`onnxruntime-node`) with a fine-tuned segmentation
model such as SAM (Segment Anything Model) or SegFormer, trained or prompted on artwork
with frames. The model would output a bounding box or mask for the innermost painting content.

**Cost**: ~50–200 MB model weights bundled with the add-on Docker image; `onnxruntime-node`
dependency (~100 MB); additional startup latency on first inference.

**Integration point**: Add as `ml_segment` in `PRE_PROCESSORS` in
`app/utils/imageProcessor.js`, following the existing pre-processor interface
`async (buffer, options) → Buffer`. Add to `IMAGE_PROCESSING_SCHEMA.preProcessors`
and the `PUT /api/web-sources/image-processing` validation list.

### Virtual TV for test-fetch orientation preview
The test-fetch UI currently accepts a `tvOrientation` to simulate fetching for a
specific TV orientation (used with the `match_tv` filter). However, users without a
portrait-mounted physical TV cannot easily test portrait-mode artwork selection.

Investigate adding a "virtual TV" concept: a named configuration entry with no
physical IP, used purely for test-fetch with a fixed orientation. This would let
users preview how the orientation filter behaves in portrait mode without owning
portrait-mounted hardware.

See the `POST /api/web-sources/test-fetch` route in `routes/web_sources.js` and
the `tvOrientation` parameter.