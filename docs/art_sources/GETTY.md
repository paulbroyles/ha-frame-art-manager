# J. Paul Getty Museum

**Source ID**: `getty`
**Website**: https://www.getty.edu/art/collection/
**Open Content Program**: https://www.getty.edu/projects/open-content-program/

## Overview

The J. Paul Getty Museum (Los Angeles) publishes ~91,500 artworks under CC0 (public domain) through its Open Content Program. The collection spans painting, sculpture, decorative arts, illuminated manuscripts, drawings, prints, and an exceptionally large photography archive (~77% of open-access items).

## API

**Endpoint**: `https://www.getty.edu/art/collection/api/search`

| Parameter | Description |
|-----------|-------------|
| `open_content=true` | Restrict to CC0 public-domain items |
| `from={n}` | Pagination offset (0-based, max ~91,524) |
| `size={n}` | Results per page |
| `q={term}` | Full-text search across title, artist, materials, culture, provenance, etc. |

The API is unauthenticated with no documented rate limits. CORS is enabled.

## Selection Strategy

**Browse mode** (no text filters): Pick a random offset in `[0, _knownBrowseTotal)`, fetch a page of 10, shuffle the page, then download the first image that matches aspect ratio. The browse total is updated from each API response.

**Search mode** (artist or keyword filter): First fetch `size=0` to get the filtered total, then pick a random offset within it.

## Image Access

Images are served via IIIF:

```
https://media.getty.edu/iiif/image/{thumbUuid}/full/!4800,4800/0/default.jpg
```

Where `thumbUuid` comes from `manifest.thumbUuid` in the search response. The `!4800,4800` constraint fits within 4800px while preserving aspect ratio.

Supported formats: JPEG, PNG, WebP. Max resolution: 30,000 × 30,000 px.

## Aspect Ratio

Dimensions are **not** included in the search response. Aspect ratio is determined **post-download** via `sharp(imageBuffer).metadata()`. Non-matching images are skipped and retried.

## Artwork URLs

```
https://www.getty.edu/art/collection{slug_with_path}
```

e.g. `https://www.getty.edu/art/collection/object/103QTM`

## Metadata Fields

| Field | Source | Notes |
|-------|--------|-------|
| `title` | `primary_name` | |
| `creator` | `producers[0].primary_name` | Artist or photographer name |
| `dateCreated` | `date_created` | Human-readable string |
| `culture` | `culture[0]` | e.g. "American", "French" |
| `accessionNumber` | `object_number` | Museum accession number |
| `source` | — | Always "J. Paul Getty Museum" |

Medium/materials are not included in the search response. They are available via the Linked Art API (`https://data.getty.edu/museum/collection/object/{uuid}`) as a future enrichment option.

## Filters

The Getty API only supports text search (`q=`). Object type, time period, and medium facets are read-only aggregations — not filter parameters.

### Artist (`artist`)
Require mode only. Searches `q={artistName}`, which matches against all indexed fields. The artist facet from the response powers `suggestArtists()`.

### Search (`search`)
Require mode only. Searches `q={term}` across title, artist, materials, culture, provenance, and other text fields.

Both filter types are `modeDetermining: true` — configuring either switches to search mode (fetches total first, then random offset).

## fetchByIdentifier

Accepts Getty collection URLs (`https://www.getty.edu/art/collection/object/{slug}`) or bare slugs (e.g. `103QTM`). Uses `q={slug}` text search and matches `id_manager_slug` in the result set. May not find the object if the slug is not indexed as a search term.

## Notes

- The collection is photography-heavy: ~77% of open-access items are photographs (Brassaï, Carleton Watkins, Louis Fleckenstein, etc.). Use the `search` filter with terms like "painting" or "sculpture" to narrow to specific types.
- `culture` reflects the origin of the artwork, not the artist nationality.
- The Getty Search Gateway (`search.getty.edu`) retires April 15, 2026 — this source uses the collection API (`/art/collection/api/search`), not the gateway.
