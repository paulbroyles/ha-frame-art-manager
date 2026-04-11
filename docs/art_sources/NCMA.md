# North Carolina Museum of Art (NCMA)

Collection browser: https://collection.ncartmuseum.org/advancedsearch

**Status: Not implemented — image resolution too low for 4K display. See Limitations.**

---

## API

The NCMA collection uses **eMuseum** (Gallery Systems), the same platform as Delaware Art Museum.
No API key or authentication required.

### Collection index

```
GET https://collection.ncartmuseum.org/objects/indexjson?start={offset}&rows={count}
```

- `start` — 0-based offset (default 0)
- `rows` — page size; max 100 enforced server-side (requests above 100 silently return 100)
- **Filtering parameters are ignored.** `department=Modern`, `query=monet`, `q=`, `search=`,
  `keyword=` — all return the full unfiltered collection. Filtering must be done client-side.
- No authenticated or undiscovered endpoint for server-side filtering was found.

**Total collection size:** 4,396 objects (as of early 2026). ~6% have no image.

**Response format:**

```json
{
  "count": 4396,
  "objects": [
    {
      "sourceId":      { "label": "Source ID",       "value": "3726" },
      "id":            { "label": "Id",               "value": "100139" },
      "invno":         { "label": "Object number",    "value": "2001.7.2" },
      "title":         { "label": "Title",            "value": "2nd Theme 6th Variation..." },
      "primaryMaker":  { "label": "Primary Maker",    "value": "Henry Pearson" },
      "primaryMakerId":{ "label": "Primary Maker ID", "value": "86183" },
      "people":        { "label": "Maker | Culture",  "value": ["Henry Pearson"] },
      "department":    { "label": "Department",       "value": "Modern" },
      "collections":   { "label": "Collections",      "value": ["20th Century", "The Permanent Collection"] },
      "media":         { "label": "Media",            "value": "2001_7_2" },
      "primaryMedia":  { "label": "PrimaryMedia",     "value": "/internal/media/dispatcher/15250/full" },
      "labelText":     { "label": "Label Text",       "value": "Curatorial description..." },
      "recordLastUpdated": { "label": "Last Updated", "value": "2026-03-14T00:55:34.210" },
      "flags":         { "label": "Flags",            "value": [] }
    }
  ]
}
```

**Fields NOT present in the index** (never observed across all sampled pages):
date, medium, dimensions, culture, nationality, accession number (only in `invno`).

The `labelText` field is the richest metadata — a curatorial paragraph describing the work.
It is the closest thing to a description field and appears on most objects.

### Per-object detail endpoint

No JSON detail endpoint was found. Paths tried:

- `/objects/{id}/detailjson` → 404
- `/objects/{id}.json` → 404
- `/objects/detail.json?id={id}` → 404

The HTML object page (`/objects/{id}`) does not expose machine-readable structured metadata
(no JSON-LD, no schema.org markup for date/medium/dimensions).

**Implication:** Date, medium, and physical dimensions are not retrievable via API.

### Images

```
https://collection.ncartmuseum.org/internal/media/dispatcher/{DISPATCHER_ID}/full
```

The dispatcher ID comes from the `primaryMedia` field value (the path segment between
`/dispatcher/` and `/full`). The suffix after the ID is ignored — all variants (`full`,
`large`, `original`, `max`, etc.) return the same image.

**Content-Type:** `image/jpeg`  
**Cache-Control:** `max-age=86400`

**Observed resolution range** (sample of 5 images):

| Dispatcher ID | Dimensions  | File size |
|---------------|-------------|-----------|
| 15250         | 960 × 956   | 38 KB     |
| 18518         | 1200 × 492  | 157 KB    |
| 11326         | 460 × 768   | 100 KB    |
| 16000         | 719 × 960   | 53 KB     |

**Maximum observed:** 1200px on the long edge. The `/full` endpoint is the ceiling —
no higher-resolution variant exists via any path suffix tried.

### People / artist endpoint

```
GET https://collection.ncartmuseum.org/people/indexjson?rows=100&start=0
```

Returns 404 (as of early 2026). Artist search is not available via API.

### Departments (observed in first 100 objects)

- Modern
- European to 1910
- African
- American to 1910
- Ancient Egyptian
- Ancient Greek, Italian, & Roman
- Oceanic

(Additional departments may exist; only the first 100 objects were sampled for this.)

### Advanced search form

The web UI at `/advancedsearch` posts to:

- `/advancedsearch/index.advancedsearchform.form` — returns an HTML error page when
  called directly with field parameters. Not usable as an API.
- `/advancedsearch/index.quicksearchform.searchform` — same, UI-only.

---

## Implementation Plan (if revisited)

### Strategy

Cache the full 4,396-object index in memory at startup (44 requests × 100 rows each).
Pick randomly, skipping objects without `primaryMedia`. Apply department filtering
client-side from the cached array.

```javascript
// Pseudocode
const index = [];  // filled at startup or first fetch
for (let start = 0; start < total; start += 100) {
  const page = await axios.get(INDEX_URL, { params: { start, rows: 100 } });
  index.push(...page.data.objects.filter(o => o.primaryMedia?.value));
}
```

Re-fetch the index every 7 days (the collection grows slowly).

### Available metadata fields

| Source field    | Suggested mapping | Notes                                      |
|-----------------|-------------------|--------------------------------------------|
| `title`         | `title`           | Always present                             |
| `primaryMaker`  | `artist`          | Always present; `people` has full array    |
| `labelText`     | `description`     | Curatorial paragraph; usually present      |
| `department`    | —                 | For filter only; not a placard field       |
| `invno`         | —                 | Accession number (e.g. "2001.7.2")         |
| hardcoded       | `museum`          | Always "North Carolina Museum of Art"      |

Date, medium, and dimensions: **not available via API.**

### `fetchByIdentifier`

The `id` field (e.g. `100139`) or `invno` (e.g. `2001.7.2`) could serve as identifiers.
Object URLs follow the pattern:

```
https://collection.ncartmuseum.org/objects/{id}
```

### Search / `searchPreview`

No API-level text search. Client-side title + artist substring match against the cached
index is feasible and sufficient.

### Filter types

- `department` — require/exclude by department name; values discovered from the cached index.

---

## Limitations

### Image resolution (primary blocker)

The maximum image resolution is ~1200px on the long edge. A Samsung Frame TV at 3840 × 2160
requires a minimum of ~2160px on the short edge for landscape content. The pipeline would
have to upscale NCMA images approximately 2–3×, which produces visible quality loss on a
large display.

NCMA does not appear to offer higher-resolution image downloads publicly. Their eMuseum
instance does not use IIIF (which would allow requesting arbitrary sizes from a tile server).

**Resolution:** This source should only be implemented if the quality degradation is
acceptable to the user, or if NCMA later exposes higher-resolution images.

### No date, medium, or dimensions

These fields are displayed on the NCMA website but are not available through the
`/objects/indexjson` API. Scraping individual HTML object pages is possible but expensive
(one HTTP request per artwork) and fragile.

### No server-side filtering

All 4,396 objects must be fetched and cached locally; filtering is client-side. This is
manageable (comparable to the NGA CSV), but slows startup by a few seconds.
