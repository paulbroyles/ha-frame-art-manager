# Image Processing Debug Notes

Working notes from test sessions ~2026-03-11 through ~2026-03-12. Not permanent documentation — for reference when implementing fixes.

## Primary test images (four-image regression suite)

These four Met Museum images are used together as a balanced regression suite. They cover a range of frame types and edge cases that have proven difficult to get right simultaneously.

| ID     | Frame type | Key challenge |
|--------|------------|---------------|
| **435765** | Thick ornate gilded frame, multi-layer with bevel | Outer edge is very dark (near-black border before gold bevel begins), so primary luminance scan only gets 5–16px. Bevel continuation extends left well (+89px via rowPercentileScan), but T/B must be inferred via cross-side cascading, causing mild overcrop there. Right bevel fails (only 10% participation). Actual frame is ~100–150px. Representative of museum masterwork portraits in heavy period frames. |
| **436103** | Extremely thin white/light border, barely visible | Opposite extreme: almost no frame. Tests that the algorithm doesn't overcrop when there is essentially nothing to remove. StrictLR mode fires (T/B < 10px → threshold=45, maxCrop=92px). Chroma continuity brings all sides to ~20px. Key regression test — if this image overcropping it means extension logic is too aggressive. |
| **437878** | Thin black outer border + narrow gold inner frame | Frame body only reaches 60–65% cross-sample agreement (ornate gilding has internal tonal variation). 70% threshold never met → `symmetric_scan` returns 0px. Painting background is warm-toned and gradually-varying, so depth-consistency is not a discriminating signal either (painting also shows 86%+ stability). Known limitation: requires flood-fill or edge-detection to distinguish the frame region from painting content. |
| **437936** | Dark-stained wood frame, warm-toned brown | Wood grain creates coherent horizontal edges that defeated spatial coherence check (now disabled for L/R). Frame color (warm brown) overlaps with some painting content colors. Bevel-cont fails (only 10–15% participation). Primary scan gets 12–20px; chroma continuity adds 15px; some frame still remains after processing. Representative of carved/stained wood museum frames. |

**Coverage gaps to fill:** larger/deeper ornate frames (multi-layer gilding going 200px+), dark frames against dark paintings, frames with strong color contrast (red lacquer, black), no-frame paintings, and paintings with heavy varnish yellowing that mimics gold frame color.

## Known edge cases — expected crop = 0 on one or more sides

Artworks where the preprocessors must *not* crop a given side. Use these to guard against overcropping regressions.

| Source | ID | URL | Expected | Notes |
|--------|----|-----|----------|-------|
| AIC | 68433 | https://www.artic.edu/artworks/68433 | left=0, right=0 | Henri Rousseau, "Sawmill, Outskirts of Paris". Native scan 19601×10528 (1.86:1). Painting content extends to horizontal edges — no left/right frame or margin. |

## Earlier test image set (2026-03-11)

| ID     | Expected | Actual result | Notes |
|--------|----------|---------------|-------|
| 437173 | Thin frame, small crop | Top overcropped | Warm painting edge triggers color scan |
| 436838 | Frame, moderate crop | Left overcropped | Same root cause as 437173 |
| 437422 | Gold frame | Gold persistence L/R near top + bottom-left | Partial frame dilutes col mean; top fixed by color scan |
| 435848 | Wide ornate frame (bevel) | Slight right overcrop | Chroma continuity extending slightly past correct boundary |
| 435837 | Dark background, NO frame | Significantly overcropped all sides | Dark bg false positive — major regression |
| 437030 | Arch painting on dark bg, NO frame | Significantly overcropped all sides | Arch corners look like frame; catastrophic cascade |
| 436793 | Outer black border + inner border (partial paint) | Outer removed correctly, inner not cropped | Expected; inner unfixable without smarter logic |
| 435896 | Multi-layer frame | Severely undercropped | Multi-layer: bevel continuation doesn't reach deep enough |
| 437013 | No frame (frame-like edge composition) | Slight overcrop | Excusable; painting edge looks like frame material |
| 438779 | Bad photo, non-uniform bg | Right+bottom undercropped, slight left overcrop | Hard case; non-uniform bg confuses detection |
| 769297 | Unknown | Overcrop at top | Excusable |
| 436102 | Dark frame | Right undercropped; top blown up | Cascading inference failure (see below) |
| 442488 | No frame / simple bg | Correct — no crop | Runaway guards all fired correctly |

## Root cause analysis (from logs)

### 1. Chroma continuity hitting cap = unreliable extension (HIGH PRIORITY)

Every overcrop in the logs shows chroma continuity hitting the 15px max on one or more sides.
Good crops either don't trigger continuity or stop naturally at 3–8px.

**Fix**: In `chromaLookahead()`, return 0 if `ext === maxLookahead` (cap hit = no clean boundary found).

### 2. Bevel continuation minimum column/row count too low (HIGH PRIORITY)

437030: top bevel continuation used only 3 columns (the minimum before rejection) to compute P65.
Three data points = [73, 115, 296], P65 = 115px. Not a reliable sample.

**Fix**: Raise minimum from 3 to 8–10 in `columnPercentileScan` and `rowPercentileScan`.
Currently: `if (boundaries.length < 3)` → change to `if (boundaries.length < 8)`.

### 3. Dark-background / arch-shaped images are fundamentally ambiguous (DESIGN ISSUE)

437030 (arch painting): black corners at top/sides created by the arch shape are
indistinguishable from a dark frame to any edge-based detector. The luminance scan
correctly detects "dark edge, lighter interior" — it just can't tell that this is artwork shape
rather than a border.

Potential future guard: if ALL four edges have refMean < threshold and ALL four get detected,
this is more likely a dark canvas than four separate frames. Could back off the crop entirely.

### 4. Inference cascades amplify bad detections (DESIGN ISSUE)

436102 case:
- Right: correctly rejected by runaway guard
- Left: 13px → bevel +109px → chroma continuity capped at +15px = 137px (BAD)
- T/B-backed: estimate = (137+42)/2 = 90px → top blown up from 28px to 90px
- The inflated left (from capped continuity) poisoned the inference chain for top

437030 case:
- Right: 276px + bevel +128px = 404px (actually detecting dark arch corners)
- L/R mirror: left gets bumped to 404px
- L/R-backed: top and bottom get bumped to 404px
- Result: all four sides at 404px — catastrophic

Potential fix: inference steps should check whether the "estimate" itself came from a
reliable source (not already inflated by inference/continuity).

### 5. Color scan gate still too permissive for warm paintings (MEDIUM)

437173 top, 436838 left: painting edges with warm/gold tones have chroma score > 30
(the raised gate from contrastThreshold * 1.5). The color scan can't distinguish "thin gold
frame" from "warm-toned painting edge" without spatial context.

The color scan fires standalone (when luminance returns 0), so it's detecting painting content
as frame on images where the luminance scan correctly returned 0.

Potential approaches:
- Require corner agreement: all four corners must have elevated chroma (not just one edge)
- Use chroma variance along the edge: a frame has consistent chroma, a painting edge doesn't
- Tighter threshold (contrastThreshold * 2 = 40) — risks missing genuine thin gold frames

## Log evidence for 437030

```
[mean_profile] top: crop=153px, refMean=6.8, bandMean=26.1, contrast=58.1 → CROP
[mean_profile] top-bevel-cont: column scan — 3 cols, range=[73..296], P65=115px     ← only 3 cols!
[mean_profile] top: bevel continuation simple=115px → using 115px → 268px total
[mean_profile] right: crop=276px, refMean=7.2 → bevel +128px → 404px total
[mean_profile] top: chroma continuity +15px → 283px                                 ← capped
[mean_profile] bottom: chroma continuity +15px → 35px                               ← capped
[mean_profile] left: chroma continuity +15px → 175px                                ← capped
[mean_profile] left L/R-mirror: est=404px → 404px
[mean_profile] bottom (L/R-backed): estimate=404px → 404px
[imageProcessor] mean_profile: removing top=283px, bottom=404px, left=404px, right=404px
```

## Planned fixes (implement when returning to image processing)

**Fix A (low risk, high impact)**: Reject capped chroma continuity extensions.
In `chromaLookahead()`: `if (ext >= maxLookahead) return 0;`

**Fix B (low risk, high impact)**: Raise bevel continuation minimum column/row count to 8.
In `columnPercentileScan` and `rowPercentileScan`: `if (boundaries.length < 8)`

**Fix C (medium risk)**: Cascading inference guard — do not apply T/B-backed or L/R-mirror
inference if the estimate source was itself derived from inference or continuity extension.
Track a "reliability" flag per edge.

**Fix D (lower priority)**: Color scan corner agreement gate — require that at least 3 of 4
corners have elevated chroma before firing the supplementary color scan.