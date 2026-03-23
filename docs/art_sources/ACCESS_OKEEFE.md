# Access O'Keeffe

Source ID: `access_okeefe`

## Overview

Access O'Keeffe is the Georgia O'Keeffe Museum's online collection browser. The collection contains ~2,000 objects including paintings, drawings, photographs, prints, and personal belongings. The majority are works by Georgia O'Keeffe; the collection also includes photographs of and about O'Keeffe by other photographers.

All metadata is CC0. Images are served via IIIF; rights vary by object (most O'Keeffe works: `© Georgia O'Keeffe Museum`).

## API

**No public REST API.** The source uses two endpoints:

| Endpoint | Purpose |
|----------|---------|
| `GET https://access-ok.okeeffemuseum.org/data/object/{id}.json` | Linked Art JSON-LD record for a single object |
| `GET https://iiif.okeeffemuseum.org/image/iiif/2/{imageId}/info.json` | IIIF image dimensions (pre-download aspect ratio check) |
| `GET https://iiif.okeeffemuseum.org/image/iiif/2/{imageId}/full/max/0/default.jpg` | Full-resolution image |

No authentication required. No published rate limit; be polite.

### Random selection strategy

**Repository number probe**: pick a random integer in `[1, REPO_MAX]` (currently 2000), fetch the JSON-LD record, and retry on:
- HTTP 404 (number not used)
- Missing `representation` (no image available)
- Object type not matching filters (before image download)
- Aspect ratio not matching filters (from IIIF info.json, before image download)

`MAX_ATTEMPTS = 40`. Higher than other sources because the collection contains many non-artwork objects (art supplies, personal belongings) that won't match type filters. The extra headroom ensures type-filtered fetches succeed reliably.

**Note**: Repository IDs (in the URL) are distinct from Catalogue Raisonné numbers (CRN), which are stored in the `identified_by` array under the "catalogue raisonnée number" classification.

## Data Format

Records use the [Linked Art](https://linked.art/) model (CIDOC-CRM based), with Getty AAT URIs for classification. Key parsing paths:

### Image

IIIF service URL:
```
representation[0].digitally_shown_by[0].digitally_available_via[0].access_point[0].id
→ https://iiif.okeeffemuseum.org/image/iiif/2/{imageId}
```

Full-resolution download: `{serviceUrl}/full/max/0/default.jpg`

IIIF Level 2 compliance; typical max resolution ~3800px on the long side. `dezoomify` is not used — IIIF `full/max` already delivers the maximum available resolution.

### Aspect ratio (pre-download)

`GET {serviceUrl}/info.json` → read `width` and `height`. Available before image download.

### Metadata fields

| Field | Source path | Notes |
|-------|-------------|-------|
| `title` | `identified_by[?].content` where `classified_as` = `aat/300404670` (preferred term) | |
| `creator` | `produced_by.carried_out_by[0]._label` | |
| `dateCreated` | `referred_to_by[?].content` where `classified_as` = local `caption_title_date`, with title prefix stripped | e.g. `"ca. 1960"`, `"Apr 1980"` |
| `medium` | `referred_to_by[?].content` where `classified_as` = local `materials_description` | e.g. `"Oil on canvas"` |
| `dimensions` | `referred_to_by[?].content` where `classified_as` = local `measurement_description` | e.g. `"24 x 36 inches"` |
| `creditLine` | `referred_to_by[?].content` where `classified_as` = `aat/300026687` | |
| `accessionNumber` | `identified_by[?].content` where `classified_as` = `aat/300312355` | e.g. `"2006.5.360"` |
| `description` | `referred_to_by[?].content` where `classified_as` = `aat/300435416` | Curatorial note |
| `copyright` | `referred_to_by[?].content` where `classified_as` = local `caption_copyright` | e.g. `"© Georgia O'Keeffe Museum"` |

**Note on date extraction**: The API does not expose a clean date field. Date is extracted from the "Caption - Title and Date" string (e.g. `"Untitled (Abstraction), ca. 1960"`) by stripping the title prefix. This is fragile if the caption format varies.

## Object Type Filter

Objects are filtered by Getty AAT URIs in the top-level `classified_as` array:

| UI label | Getty AAT URI |
|----------|---------------|
| Paintings | `http://vocab.getty.edu/aat/300033618` |
| Drawings | `http://vocab.getty.edu/aat/300033973` |
| Photographs | `http://vocab.getty.edu/aat/300046300` |
| Prints | `http://vocab.getty.edu/aat/300041273` |
| Watercolors | `http://vocab.getty.edu/aat/300078925` |
| Pastels | `http://vocab.getty.edu/aat/300181705` |
| Sculpture | `http://vocab.getty.edu/aat/300047090` |

Type filtering happens after fetching the JSON-LD but before downloading the image. Items with no matching type (e.g. personal belongings, archive materials) are skipped if a type filter is active.

## `fetchByIdentifier`

Accepts:
- Access O'Keeffe object URLs: `https://access-ok.okeeffemuseum.org/object/{id}`
- Bare repository integers: `815`, `50`, etc.

## Known Limitations

- **Small collection**: ~2,000 objects. Random probing with retries is simple and sufficient.
- **Resolution ceiling**: IIIF max resolution is typically ~3800px on the long side. Images will be upscaled by the TV/pipeline for 4K display.
- **Date extraction**: Parsed from "Caption - Title and Date" string by stripping the title prefix. May behave unexpectedly for unusual title formats.
- **No artist filter**: The collection is essentially single-artist (Georgia O'Keeffe); an artist filter is not exposed.
- **Non-artwork items**: Items without images (personal belongings, archive materials) are skipped automatically. With no type filter active, imaged non-artwork items may appear.
- **Copyright**: Unlike fully open-access collections (Met, Tate), most O'Keeffe works carry `© Georgia O'Keeffe Museum`. Acceptable for personal/educational display.
