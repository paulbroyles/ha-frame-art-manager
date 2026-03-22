# Tate Collection API

Source ID: `tate`

## Overview

The Tate source fetches artworks from the Tate collection (Tate Britain, Tate Modern, Tate Liverpool, Tate St Ives) via the Tate's undocumented Wagtail REST API. The collection has ~83,600 artworks; ~66,700 have cleared images accessible at `media.tate.org.uk`.

"Cleared" means the Tate has resolved rights to display the image on their website. Images are publicly accessible regardless of copyright status. Most historical works have empty copyright (public domain); contemporary works carry `© Artist Name` or `© reserved`.

## API

**Base URL:** `https://www.tate.org.uk/api/v2/`

No API key or authentication required. No published rate limit; be polite (minimal requests, appropriate timeouts).

### Key endpoints

| Endpoint | Purpose |
|----------|---------|
| `GET /api/v2/artworks/` | Paginated artwork list; supports count + offset fetch |
| `GET /api/v2/artists/` | Full artist list (6,201 artists); used to build autocomplete index |
| `GET /api/v2/pages/?type=artists.ArtistPage&search=...` | Wagtail full-text artist search (whole-word only — not used; index used instead) |

### Random selection strategy

Two-step offset approach (same as Met Museum):

1. `GET /api/v2/artworks/?masterImageStatus=CLEARED&classificationId=N&limit=1&fields=acno` → read `meta.total_count`
2. Pick `offset = randint(0, total_count - 1)`
3. `GET /api/v2/artworks/?...&limit=1&offset=N&fields=...` → fetch the artwork

Counts are cached in memory for 6 hours per filter combination.

### Filter parameters

| Param | Values | Notes |
|-------|--------|-------|
| `masterImageStatus` | `CLEARED` | Always applied |
| `classificationId` | Integer (see table below) | One value per request |
| `onDisplayAtTate` | `true` | Currently on display |
| `mltArtists` | CIS ID integer | Filter by artist |
| `acno` | Accession number | Direct lookup (e.g. `T16514`) |

### Classification IDs

| ID | User-visible name | Cleared count (approx.) |
|----|-------------------|------------------------|
| 6  | Paintings         | ~5,300                 |
| 4  | Prints & Graphics | ~17,300                |
| 5  | Works on Paper    | ~41,100                |
| 8  | Sculpture         | ~1,900                 |
| 3  | Installation      | ~650                   |

**Note on Works on Paper (ID 5):** This is the largest category (~62% of all cleared images) and is heavily skewed toward J.M.W. Turner's bequest of sketchbooks — thousands of small-format portrait-orientation drawings. When the aspect ratio filter is `landscape`, expect more retries when this category is in the eligible pool. `MAX_ATTEMPTS` is set to 15 to compensate.

## Images

Images are served from Azure Blob Storage at `media.tate.org.uk`:

```
https://media.tate.org.uk/art/images/work/{L1}/{L1+digits}/{ACNO}_{N}.jpg
```

**Always use `master_images.sizes[-1][2]`** (last entry in the sizes array) — do not assume the `_10` suffix exists. Some works have only 3 size variants; the largest may be `_9` (~730px).

Maximum resolution is ~1536px wide for most works. The Frame TV target is 3840px, so images will be upscaled; this is handled by the TV/pipeline. Dezoomify is not applicable (Tate does not expose tiled/zoomable images).

### Aspect ratio (pre-download)

`master_images.height_ratio` = `(height / width) × 100`:
- `> 100` → portrait
- `< 100` → landscape
- `= 100` → square (treated as landscape)

This field is available in the listing response (no extra request needed), enabling pre-download aspect ratio filtering.

## Artist index

All 6,201 artists are fetched from `/api/v2/artists/` at first use (63 paginated requests at 100/page) and held in memory for 24 hours. The index stores `{ name, cisId, totalWorks }` sorted by `totalWorks` descending.

Artist suggestions (`suggestArtists`) do prefix-first then substring matching over this index. Artwork filtering uses `mltArtists={cisId}`.

The `cisId` is the numeric suffix in artist page URLs:
```
https://www.tate.org.uk/art/artists/joseph-mallord-william-turner-558
                                                                     ^^^
                                                                     cisId = 558
```

## Artist enrichment

The `contributors` array on each artwork response includes a `url` field ending in `-{cisId}` and a `date` field (artist lifespan, e.g. `"born 1775, died 1851"`). This lifespan is resolved from the artist cache (no extra API call) and returned as `creatorLifespan` in the metadata, suitable for the OEL placard's `creator_lifespan` field.

## `fetchByIdentifier`

Accepts:
- Tate artwork URLs: `https://www.tate.org.uk/art/artworks/{slug}`
  Accession number is the last hyphen-separated segment of the slug: `...-n00530` → `N00530`
- Bare accession numbers: `N00530`, `T16514`, `AR00153` (1–2 letters + 4+ digits)

Lookups use `?acno={ACNO}` directly — no HTML scraping needed.

## Metadata fields

| Field | API source | Notes |
|-------|-----------|-------|
| `title` | `title` | |
| `creator` | `allArtists` | Flat string; multiple artists joined by Tate |
| `creatorLifespan` | `contributors[0].date` via artist cache | e.g. `"born 1775, died 1851"` |
| `medium` | `medium` | Free-text (e.g. "Oil paint on canvas") |
| `dateCreated` | `dateText` | Human-readable (e.g. "c.1850", "1960–65") |
| `dimensions` | `dimensions` | Physical dimensions string |
| `creditLine` | `creditLine` | Acquisition credit |
| `gallery` | `display_gallery_name` | Gallery within Tate |
| `artworkUrl` | `url` (prepend `https://www.tate.org.uk`) | Canonical page URL |
| `source` | — | Always `"Tate"` |

## Known limitations

- **Resolution ceiling:** ~1536px max. Images will be upscaled by the TV.
- **Works on Paper portrait skew:** Turner sketchbooks dominate category 5; landscape filter + Works on Paper requires more retry attempts.
- **`allArtists` is a flat string:** No structured nationality data from the artwork response. Nationality is not available via the artists API either (only `date`, `birthYear`, `gender`).
- **No IIIF:** Tate does not expose IIIF manifests for most works; dezoomify is not applicable.

## Future work

- **Artist nationality:** Not available in the Tate API. Could potentially be scraped from individual artist pages but likely not worth the complexity.
- **Subject tags:** The `subject_tags` array is available in the API response but not currently exposed as a filter.
