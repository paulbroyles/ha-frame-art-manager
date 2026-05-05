## Future Investigations

### Calendar Events UI polish

The Events tab (manager UI) has several known gaps noted after initial testing (2026-05-02):

**Time entry UX** (`index.html` / `app.js`):
- `datetime-local` inputs require clicking the calendar before typing works; entering hours/minutes is more awkward than necessary. Consider a custom time-picker or at minimum ensure the input handles direct keyboard entry cleanly.
- No validation that end time is after start time — should be enforced client-side on form submit.

**Event management / HA calendar sync** (`routes/calendar_events.js` + `app.js`):
- Delete in the manager UI does not currently delete from the HA calendar. The delete route calls `deleteHaCalendarEvent` but that function silently does nothing if `uid` is null (which it often is, since the UID lookup in `createHaCalendarEvent` uses `e.start?.dateTime` — a dict-access pattern that won't match the flat string format returned by `calendar.get_events`). Fix the UID lookup first, then verify delete propagates to HA.
- Edit support: allow changing label, tagset, times, and suppress_moods on existing events. Edits to in-progress events need extra care (the override is already active; an edit to the end time should update the running timer).
- Browse/view expired events: the current GET endpoint only returns events as stored locally; add a way to surface past events in the UI (e.g., a "show past" toggle, with events fetched from HA calendar for a wider time window).
- Duplicate event: one-click copy with times shifted by one year (for recurring annual events like Star Wars Day or Christmas).
- Auto-delete old events: optional setting to automatically remove HA calendar events (and local config entries) that ended more than N days ago.

### Recurring calendar events

The calendar events system should support recurring overrides so annual events like Star Wars Day (May 4) or Christmas can be set-and-forget.

**Fixed-date annual events** (May 4, Dec 25, etc.):
- HA's local calendar supports `RRULE` in `create_event`; `FREQ=YEARLY` on a May 4 all-day event recurs every year.
- `calendar.get_events` expands recurring events into individual occurrences, so the HA integration calendar monitor already handles these correctly with no code changes.
- Use **all-day events** (`start_date`/`end_date`) rather than timed events for recurring annual overrides — no timezone ambiguity, and no multi-day display splitting quirk in the HA Calendar UI.
- Manager UI change: add a "Repeat yearly" toggle that sets `FREQ=YEARLY` and switches the form to all-day date pickers.

**Moveable holidays** (Easter, Thanksgiving, etc.):
- RRULE cannot express moveable holidays.
- Cleanest solution: the linked-calendar sync feature (already roadmapped). User links the Frame Art event to their external calendar (Google, Apple) which already has Easter computed. On tab load, manager syncs the times from the linked event.
- A future enhancement could auto-advance a recurring Frame Art event by one year after it expires, pulling the new date from the linked calendar.

**HA integration impact**: none required — the monitor already processes whatever `get_events` returns, including expanded recurrence occurrences.

### Server-side OEL placard rendering (frame-art-manager endpoint)

**Idea**: Instead of constructing the OEL `drawcustom` payload in a Jinja2 blueprint template with hardcoded pixel positions, expose a `/api/oel-placard` endpoint in frame-art-manager that accepts artwork metadata and returns a fully-positioned OEL JSON payload.

**Motivation**: Jinja2 templates can't measure actual font metrics, so multi-line title wrapping is estimated via a chars-per-pixel heuristic. The heuristic is fundamentally limited: titles that visually fit in one line are being wrapped because OEL's bitmap font has wider characters than the estimate, and there is no way to know the exact per-character widths without actually measuring. Even with tuning, the estimate will be wrong for different title lengths and character mixes. A server-side renderer is the only clean solution.

**How it would work**:
- Blueprint (or automation) POSTs artwork metadata (title, artist, date, medium, dimensions, museum, description, creator fields) + display dimensions + refresh_type to the endpoint, via the manager's Ingress proxy URL
- Endpoint runs a real layout pass:
  1. Measure each text field using actual font metrics (`canvas.measureText` or a glyph-width lookup table for OEL's built-in font)
  2. Determine how many lines each multiline field will occupy
  3. Pack fields top-to-bottom with fixed spacing, skipping absent fields
  4. Place QR code bottom-right with a guaranteed margin
  5. Fit description in remaining space bottom-left beside QR, as many lines as fit
- Endpoint returns the complete `payload` array (OEL JSON) ready to pass to `open_epaper_link.drawcustom`
- Blueprint uses a `rest_command` (or inline `rest` action) to POST to the endpoint, then passes the response body directly as `payload`

**Font metrics options** (pick one):
- `canvas` npm package: full `measureText()` support, native binary, similar Alpine/glibc compat concerns as onnxruntime — would need `gcompat`. Most accurate.
- OEL glyph-width lookup table: measure OEL's built-in font once (render known strings, read pixel widths), store as a JSON table keyed by `{char, size}`. No extra dependency, slightly less accurate for unusual characters. Likely good enough.
- `opentype.js` / `fontkit`: parse the actual font file OEL uses (if it's accessible/documented). Pure JS, no native dep.

**Blueprint changes needed**:
- Add `manager_url` input (the manager's Ingress base URL, e.g. `http://homeassistant.local:8123/api/hassio_ingress/<token>`)
- Replace the entire `payload: >` Jinja2 block with a `rest_command` call + pass response as payload
- Graceful fallback: if the endpoint is unreachable, fall back to the current static layout

**Considerations**:
- The Ingress token in the URL changes if the add-on is reinstalled — may need a sensor that exposes the stable URL, or the user configures it once as a blueprint input
- The endpoint should accept a `?dry_run=true` param for testing without sending to OEL
- Response should include a `debug_svg` field (optional) for visualizing the layout during development



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

### Unified frame removal + crop (replacing separate Phase 2 / Phase 3)

The current pipeline treats frame removal (Phase 2) and aspect-ratio cropping (Phase 3) as
independent operations. Phase 2 doesn't know the target aspect ratio, so it can't make
informed tradeoffs (e.g., "the aspect ratio crop will remove the left/right edges anyway, so
frame detection on those edges barely matters"). Phase 3 doesn't know where the frame is, so
it can accidentally keep frame slivers or crop away painting content that Phase 2 preserved.

Three candidate approaches for unifying them:

#### Approach 1 — Frame-Aware Constrained Crop

Detect frame boundaries per-edge (reuse mean_profile-style transition detection), define the
"painting rectangle" inside the frame, then find the largest rectangle of the target aspect
ratio that fits entirely within the painting rectangle. Position using Sharp's attention/saliency
within the available freedom. Single extract + resize, no intermediate encode/decode.

Key advantage: the algorithm knows the target aspect ratio upfront and can make informed
tradeoffs — if a 16:9 crop will remove 200px off each side anyway, frame detection on the
sides barely matters; focus confidence on top/bottom instead.

**Status: planned for implementation first.** See plan file for details.

#### Approach 2 — Per-Row/Per-Column Safe Zone (irregular frames)

Instead of a single rectangular painting boundary, build a per-row safe zone: for each row,
scan inward from left and right to find painting pixels; for each column, scan inward from
top and bottom. This yields an irregular painting boundary that handles arched tops, ornate
corners, and non-rectangular frames. Find the maximum inscribed rectangle of the target
aspect ratio within this boundary, positioned by saliency.

More robust for ornate frames but significantly more complex (maximum inscribed rectangle in
an irregular polygon is a non-trivial optimization problem).

#### Approach 3 — Edge Confidence Weighting

A hybrid that adds confidence awareness: run frame detection outputting a confidence score
per edge (how sure are we this is frame?). For high-confidence edges, crop to inside the
frame. For low-confidence edges, add a small safety margin inward but don't aggressively
crop. Apply the aspect ratio crop constrained so no pixel outside the safe boundary is
included. This avoids false-positive overcropping on paintings with frame-like edges while
still removing obvious frames.

### Modular pipeline architecture (imageProcessor refactor)

The current `processWebSourceImage` hard-codes a 3-phase pipeline: (1) solidBorderStrip,
(2) single user-selected pre-processor, (3) single crop engine. The TODO in the code
mentions allowing an array of pre-processors, but the real goal is a general-purpose
pipeline where multiple processors — labeled with type/function — can be added and chained
ad hoc.

Design goals:
- Each processor has a declared type (e.g., `background_strip`, `frame_detect`,
  `aspect_crop`, `unified_frame_crop`) and a human-readable label
- The pipeline is an ordered list of processor entries, each with a key + options
- The UI exposes the pipeline as an ordered list that users can add to, remove from,
  and reorder
- Processors can declare incompatibilities (e.g., `unified_frame_crop` replaces both
  `frame_detect` and `aspect_crop`)
- Raw pixel buffer passing between processors (eliminating encode/decode overhead)

This refactor is a prerequisite for cleanly integrating Approach 1 (unified frame+crop)
as a single pipeline step rather than shoehorning it into the current Phase 2 or Phase 3
slot.

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

### Web source recency: cross-TV and local recency migration

**Current state**: `webSourceRecency[deviceId]` in `web_sources.json` tracks the last 30 displayed
web source artworks per TV. This is per-TV only — no cross-TV dimension.

**Parity gap vs. local recency**: Local recency builds two sets — `same_tv_recent` (images on this TV,
last 120h) and `cross_tv_recent` (images on *any* TV, last 72h) — then unions them before filtering.
Web source recency only does the same-TV half. Adding cross-TV is straightforward: union all entries
in `webSourceRecency` when building the exclusion set in `fetchAndProcessWebSource`. Deferred until
multiple web-source TVs are in use.

**Cross-source gap**: If two virtual tags in the same tagset point to different sources (e.g. Google
Art Wallpaper + a Google Arts filter), the same underlying painting could appear from both. The
recency check compares `artworkUrl` strings, which differ between sources even for the same artwork.
No fix planned — the overlap is rare and the consequence is just an occasional near-repeat.

**Local recency migration**: The display log and recency window logic currently lives in the HA
integration (Python), which reads `events.json`, builds a `recentImages` set, and passes it to the
add-on's `/api/shuffle/select` as a parameter on every call. The goal is for the integration's only
job to be "trigger a shuffle" — all library selection logic should live in the add-on.

Migration would require the add-on to persist recency itself. The blocker: `/api/shuffle/select`
only picks a candidate; the actual TV send happens in the integration and can fail. The add-on
needs a `POST /api/shuffle/confirm` (or equivalent) that the integration calls after a successful
send, so the add-on can record what was actually displayed. Once that exists, the integration can
stop passing `recentImages` and the display log query can move to the add-on side.

### Multi-pass dezoomify for zoomable image sources

**Idea**: For sources that deliver zoomable images (currently Google Arts & Culture via dezoomify),
compute frame boundaries on a low-resolution first-pass image, then request exactly the resolution
needed for the cropped painting area to be 3840×2160 — eliminating unnecessary over-downloading
and avoiding any post-dezoomify downscaling.

**Current approach**: Download at whatever dezoomify resolves (often 8K+), then pipeline downsamples
for frame detection and crops the full-res image.

**Proposed approach**:
1. Download a low-res version (e.g., 1200px longest edge) for frame detection
2. Run frame-aware crop processor → outputs painting region as a fraction of original image
3. Compute what dezoomify output resolution is needed so the painting subregion == 3840×2160
4. Re-request via dezoomify at that exact resolution
5. Extract painting region from the result → exactly 4K, no further scaling needed

**Dependencies**:
- Requires frame-aware crop (Part B) to expose painting region bounds, not just final buffer
- Requires verification that dezoomify's `--max-width`/`--max-height` flags deliver reliable
  output at the requested resolution (IIIF server behavior varies)
- Pipeline and source fetcher would need to cooperate (two-phase fetch model)

**When to implement**: After frame-aware crop is complete and its output shape (painting bounds
as fractions) is defined. Target as a dezoomify utility enhancement in `utils/dezoomify.js` +
source-level coordination in `google_arts.js`.

### Consolidate SOURCE_DISPLAY_NAMES with BUILTIN_SOURCES

`artwork.js` has a hardcoded 3-entry `SOURCE_DISPLAY_NAMES` map for the "View on →" link. This
duplicates display names already present as `name` in `BUILTIN_SOURCES` in `web_sources.js`.

**Why it's not a pure consolidation**: `google_art_wallpaper` needs to map to `'Google Arts & Culture'`
(the site the user lands on), but its `BUILTIN_SOURCES.name` is `'Google Art Wallpaper'`. So the
route handler would need to either: (a) add a separate `siteName` field to `BUILTIN_SOURCES`, or
(b) keep the override in `artwork.js`. Low priority — 3 entries, rare additions, soft failure mode
(falls back to `'source'`).

**If a new source is added**: Update `SOURCE_DISPLAY_NAMES` in `artwork.js` at the same time as
`BUILTIN_SOURCES` in `web_sources.js`.

### Dual-mode filters (include + exclude on the same type at one level)

Some filter types could benefit from allowing both an include and an exclude filter
at the same cascade level. For example, a tag-like field (e.g., Object Type) might
need: "include books, exclude manuscripts" — narrowing to objects that ARE books but
ARE NOT manuscripts. This requires two filter entries of the same type with different
modes.

**Backend support**: Already present. `mergeFilterCascade` keys on
`${filter.type}:${filter.mode}`, so `objectType:require` and `objectType:exclude`
are tracked and merged independently. The data model (`[{type, mode, values}]`)
allows multiple entries with the same `type` but different `mode`. Sources receive
the full merged filter array and can apply both constraints.

**UI gap**: The current `renderFilterList` allows one filter entry per type at a
given level (the "Add filter" list excludes types already active). Supporting
dual-mode would require either:
1. Two separate entries (one include, one exclude) for the same type — would need
   the `addableTypes` logic to allow adding a second entry if the existing one has
   a different mode.
2. A split UI within one entry — e.g., an include section and an exclude section
   side by side or stacked.

**Validation**: Values selected in one mode should be excluded from the other mode's
picker at the same level (an item can't be both included and excluded).

**Cascade interaction**: A parent's include filter defines the available universe; a
child's exclude filter removes from that universe. This already works via
`isAvailable` / `isLocked` semantics. The new case is both modes at the *same* level,
which the backend handles but the UI does not yet expose.

**When to implement**: When a concrete use case arises (e.g., a source with a
tag-like field where users need fine-grained include+exclude at one level). The
current single-mode-per-type UI is sufficient for medium/category/orientation.

---

## OEL Text Measurement: HarfBuzz for Exact PIL Matching

**Problem**: opentype.js cannot read GPOS Extension lookups (type 9), which is how
PlayfairDisplay-Bold stores its kern table. PIL uses FreeType via RAQM/HarfBuzz,
which handles these lookups. For all-caps artist names at fontSize 30, this causes
opentype.js to measure ~5 px wider than PIL ("VINCENT VAN GOGH": JS=302.4 vs
PIL=297.6), leading to incorrect line-wrapping decisions in the layout engine.

**Current mitigation**: `MEASURE_SLACK = 6` in `layoutEngine.js` — a fixed tolerance
applied to all single-line fit checks, covering the empirically observed worst case.

**Better fix**: Replace opentype.js advance-width measurement with `harfbuzzjs`
(pure WASM, no native deps, works on Alpine). Testing confirmed it matches PIL to
within 0.04 px. The `HB_TINY` build includes GPOS kern support.

**Implementation sketch**:
1. `npm install harfbuzzjs` (~3.3 MB WASM binary)
2. Initialize `hb` singleton in `fontManager.js` `preloadFonts()` (async WASM load)
3. Maintain a HarfBuzz font cache (`filename → {blob, face, hbFont}`) alongside
   the existing opentype.js cache (opentype.js still needed for `getLineHeight`)
4. Replace `measureText` and `wrapText` inner measurement with HarfBuzz shaping:
   `hb.shape(hbFont, buf)` → sum `g.ax` for each glyph → scale by `fontSize/upem`
5. Explicit `.destroy()` calls on buffer after each measurement; face/font cached
6. Remove `MEASURE_SLACK` once HarfBuzz is wired in

**When to implement**: If placard wrapping bugs persist for specific artist names
despite MEASURE_SLACK, or if we add fonts with heavy GPOS kerning.
