# OEL Placard Layout Engine

## Overview

A template-driven system for generating pixel-accurate artwork metadata displays on e-paper tags using the OEL (OpenEPaperLink) `drawcustom` service. It replaces the Jinja2 heuristic approach (fixed pixel positions, chars-per-pixel wrapping estimates) with layout calculations based on actual font metrics via opentype.js.

The engine generates `drawcustom` payload arrays — positioned text elements, rectangles, and QR codes — which the frame-art-shuffler blueprint sends to OEL via Home Assistant.

**Why not Jinja2:** Jinja2 has no access to font metrics. A chars-per-pixel heuristic (e.g., 13px/char at size 22) fails for proportional fonts and variable-length strings. A four-word title wrapped across three lines cannot be distinguished from a nine-word title without actually measuring it. The layout engine solves this by running real `getAdvanceWidth()` calls against the same TTF files OEL uses for rendering.

---

## Architecture

### Core modules

| File | Responsibility |
|------|---------------|
| `app/oel/fontManager.js` | Load and cache `opentype.Font` objects; expose `measureText`, `wrapText`, `getLineHeight`, `ensureFontsInstalled` |
| `app/oel/layoutEngine.js` | `layoutPlacard(template, metadata, display, refreshType)` → `{ payload, debug }` |
| `app/oel/templates/*.json` | JSON template definitions; loaded by ID at request time |
| `app/routes/oel.js` | Express routes: `POST /api/oel`, `GET /api/oel/templates`, `GET /api/oel/templates/:id` |

### Font file locations

- **Measurement:** `app/oel/fonts/*.ttf` — bundled in the Docker image, used by fontManager for layout calculations
- **Rendering:** `/config/www/fonts/*.ttf` — OEL's drawcustom searches this directory; populated on first placard request by `ensureFontsInstalled()`

---

## API

### POST /api/oel

Generate an OEL drawcustom payload from artwork metadata.

**Request body:**
```json
{
  "metadata": {
    "creator_name": "Vincent van Gogh",
    "creator_nationality": "Dutch",
    "creator_lifespan": "1853–1890",
    "title": "The Starry Night",
    "date": "June 1889",
    "medium": "Oil on canvas",
    "dimensions": "73.7 × 92.1 cm",
    "museum": "Museum of Modern Art, New York",
    "description": "A swirling night sky over a village...",
    "artwork_url": "http://192.168.1.227:8099/artwork/fbbd5e69..."
  },
  "display": { "width": 400, "height": 300 },
  "refresh_type": "Full",
  "template": "museum_placard"
}
```

Defaults: `display` = `{width:400, height:300}`, `refresh_type` = `'Full'`, `template` = `'museum_placard'`.

**Response:**
```json
{
  "payload": [
    { "type": "rectangle", "x_start": 0, "y_start": 0, "x_end": 399, "y_end": 299, "outline": "black", "width": 1 },
    { "type": "text", "value": "VINCENT VAN GOGH", "x": 10, "y": 10, "size": 30, "font": "PlayfairDisplay-Bold.ttf", "color": "black" },
    { "type": "qrcode", "data": "http://...", "x": 275, "y": 175, "boxsize": 2, "border": 1, "color": "black", "bgcolor": "white" }
  ],
  "debug": {
    "template": "museum_placard",
    "slotsRendered": 9,
    "slotsSkipped": 0,
    "overflow": false
  }
}
```

**Example:**
```bash
curl -X POST http://192.168.1.227:8099/api/oel \
  -H 'Content-Type: application/json' \
  -d '{"metadata":{"creator_name":"Monet","title":"Haystacks"},"display":{"width":400,"height":300}}'
```

### GET /api/oel/templates

List available templates (id, name, description).

### GET /api/oel/templates/:id

Return the full JSON template definition.

---

## Template Format

Templates are JSON files in `app/oel/templates/`. The `id` field must match the filename (without `.json`).

### Root fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `id` | string | — | Template identifier; must match filename |
| `name` | string | `id` | Human-readable name |
| `description` | string | `''` | Purpose description |
| `margin` | number | `10` | Left/right outer margin (px) |
| `displayBorder` | boolean | `false` | Draw 1px outline around full display |
| `fonts` | object | `{}` | Font catalog: key → `{file, fallback}` |
| `slots` | array | `[]` | Content slots (see below) |

### Font catalog entry

```json
"heading": { "file": "PlayfairDisplay-Bold.ttf", "fallback": "Poppins-Bold.ttf" }
```

Slot `font` fields reference keys in this map (e.g., `"font": "heading"`). If the key is absent, the value is treated as a direct filename.

### Slot fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `id` | string | — | Unique slot ID within template (used by `beside`) |
| `field` | string | — | Metadata key to display; slot skipped if value is empty |
| `type` | string | `'text'` | `'text'` or `'qrcode'` |
| `oel_type` | string | — | Alias for `type`; takes precedence if set |
| `zone` | string | `'top'` | Layout zone: `'top'`, `'anchor'`, or `'fill'` |
| `font` | string | `'Poppins-Bold.ttf'` | Font reference or direct filename |
| `fontSize` | number | `20` | Text size in pixels |
| `lineHeight` | number | auto | Explicit line height; auto-calculated from font metrics if omitted |
| `color` | string \| object | `'black'` | Color string or `{refreshType: color}` object (see Color System) |
| `marginTop` | number | `0` | Vertical gap above slot (px) |
| `transform` | string | — | `'upper'` or `'lower'` |
| `wrap` | string | — | Template string with `{value}` placeholder, e.g. `"({value})"` |
| `prepend` | string | — | Prepended to value; ignored if `wrap` is set |
| `append` | string | — | Appended to value; ignored if `wrap` is set |
| `requires` | string | — | Metadata field that must be non-empty for this slot to render |
| `sizePercent` | number | `0.225` | (anchor/qrcode) QR size as fraction of display width |
| `margin` | number | `15` | (anchor/qrcode) Inset from display edges (px) |
| `border` | number | `1` | (anchor/qrcode) Quiet zone in QR modules |
| `bgcolor` | string | `'white'` | (anchor/qrcode) QR background color |
| `beside` | string | — | (fill) ID of anchor slot to lay beside; defaults to first anchor |

---

## Layout Algorithm

### Pass 0 — Display border

If `template.displayBorder` is `true`, push a 1px rectangle from `(0,0)` to `(width-1, height-1)`.

### Pass 1 — Anchor zone (QR code)

For each `zone: 'anchor'` slot that should render:

1. Compute target size: `floor(display.width × sizePercent)`
2. Generate the QR object at `ERROR_CORRECT_H` to get exact module count
3. Compute boxsize: `max(1, round(targetSize / (modules + 2×border)))`
4. Compute actual size: `(modules + 2×border) × boxsize`
5. Position at bottom-right: `x = width - actualSize - margin`, `y = height - actualSize - margin`
6. Push a 1px border rectangle (2px gap around QR)
7. Push the QR element
8. Record anchor `{ slot, x, y, width: actualSize, height: actualSize }`

**Why `Math.round` not `Math.floor`:** Floor can undercount by one boxsize step at rounding boundaries, producing a QR that's smaller than intended and potentially unscannably small. Round gives the closest integer, matching intent.

**Why `ERROR_CORRECT_H`:** OEL's Python `qrcode` library uses `ERROR_CORRECT_H` (30% damage tolerance). Using a different level during boxsize calculation would give different module counts and wrong positioning.

### Pass 2 — Top zone (top-to-bottom packing)

`cursor_y` starts at `0`. For each `zone: 'top'` slot (in order):

1. Skip if field is empty or `requires` dependency is unmet
2. Apply transforms and wrap/prepend/append to get display text
3. Resolve color by `refreshType`
4. Measure text width: `font.getAdvanceWidth(text, fontSize)`
5. If text fits within `contentWidth` (`display.width - 2×margin`): single-line text element
6. If text exceeds `contentWidth`: `text` element with `max_width = contentWidth` and `spacing = max(0, lineHeight - naturalLineHeight)`; advance cursor by `numLines × lineHeight`
7. `cursor_y += marginTop` before placing each slot

### Pass 3 — Fill zone (description)

For each `zone: 'fill'` slot:

1. Skip if field is empty
2. Find anchor by `beside` ID, or use first anchor
3. `fillY = anchor.y + (slot.marginTop || 6)` — small gap below top content
4. `fillX = margin`, `fillW = anchor.x - 2×margin` — space left of QR
5. `fillH = display.height - fillY`
6. `maxLines = floor(fillH / lineHeight)`
7. Wrap text to `fillW`; truncate to `maxLines` lines (last line gets `…`)
8. Push text element with `max_width` and `spacing`
9. If `cursor_y > fillY`: set `debug.overflow = true`

---

## Font System

### opentype.js

Pure JavaScript TrueType/OpenType parser. No native binaries, no Alpine/musl compatibility issues.

**Key calls:**
- `font.getAdvanceWidth(text, fontSize)` → pixel width of string
- `font.tables.os2.sTypoAscender/sTypoDescender` → line height metrics
- `font.unitsPerEm` → scale factor

### Line height calculation

```
ascender  = font.tables.os2.sTypoAscender  || font.ascender
descender = font.tables.os2.sTypoDescender || font.descender
lineHeight = ceil((ascender - descender) * fontSize / font.unitsPerEm)
```

### Font auto-install (`ensureFontsInstalled`)

Called once on first placard request. Copies all `*.ttf`/`*.otf` files from `app/oel/fonts/` to `/config/www/fonts/` if not already present. Failure is non-fatal (logs warning). OEL's drawcustom searches `/config/www/fonts/` for custom fonts.

---

## Color System

The `color` slot field accepts a string or a `refresh_type`-keyed object:

```json
"color": "black"
"color": { "Full": "red", "default": "black" }
```

Resolution: `color[refreshType] || color['default'] || 'black'`

This allows title text to render red on `Full` refreshes (where the e-paper can display color) and black on `Fast`/`Partial` refreshes.

---

## museum_placard Template

The default template, designed for e-paper artwork placards next to Samsung Frame TVs.

**Top zone (top-to-bottom):**
1. `creator_name` — uppercase, Playfair Display Bold 30px
2. `creator_nationality` — Roboto Medium 16px
3. `creator_lifespan` — wrapped as `(value)`, requires nationality, Roboto Regular 14px
4. `title` — Playfair Display Bold 26px; red on Full refresh
5. `date` — wrapped as `(value)`, Roboto Regular 15px
6. `medium` — Roboto Medium 15px
7. `dimensions` — Roboto Regular 13px
8. `museum` — Roboto Medium 15px

**Anchor zone (bottom-right):**
- `artwork_url` as QR code, 26% of display width, 15px margin, 1-module border

**Fill zone (beside QR):**
- `description`, Roboto Regular 13px, 15px line height, fills space left of QR code

**Display border:** Enabled (`displayBorder: true`).

---

## Blueprint Integration

The frame-art-shuffler `epaper_placard` blueprint calls `POST /api/oel` via HA's `rest_command` or direct REST call:

1. Blueprint reads artwork metadata from the `artwork_info` sensor
2. Calls `frame_art_shuffler.generate_oel_payload` service (in `__init__.py`) which POSTs to the manager
3. The service handler decodes HTML entities, constructs `artwork_url` from the manager's direct port URL, sends to `/api/oel`
4. Blueprint receives the `payload` list and passes it directly to `open_epaper_link.drawcustom`

**Critical:** The payload must be passed as a native Python list (not JSON string). In Jinja2: `{{ oel_response.payload }}` — NOT `{{ oel_response.payload | to_json }}`. The `| to_json` filter serializes to a string, causing OEL to iterate over characters instead of dict elements.

---

## Key Files

| Path | Purpose |
|------|---------|
| `app/oel/layoutEngine.js` | Core layout algorithm |
| `app/oel/fontManager.js` | Font loading, measurement, word-wrap |
| `app/oel/fonts/` | Bundled TTF files for measurement |
| `app/oel/templates/museum_placard.json` | Default museum placard template |
| `app/routes/oel.js` | Express route handlers |
| `app/server.js` | Mounts `/api/oel`; calls `ensureFontsInstalled()` on startup |
| `/config/www/fonts/` | Runtime font location searched by OEL |
| `blueprints/.../epaper_placard.yaml` | HA blueprint that calls this endpoint |
| `custom_components/frame_art_shuffler/__init__.py` | `generate_oel_payload` service handler |
