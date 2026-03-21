# Museum of Modern Art (MoMA) — Collection Dataset

MoMA does not offer a public-facing API for collection browsing. This source uses two complementary
data sources: the MoMA **GitHub dataset** for the bulk artwork index, and the **Sanity CMS API**
for the optional "curated works only" filter.

---

## Data Sources

### 1. GitHub Dataset (primary index)

**Repository**: `https://github.com/MuseumofModernArt/collection`
**File**: `Artworks.json`
**Raw URL**: `https://media.githubusercontent.com/media/MuseumofModernArt/collection/main/Artworks.json`
(Note: the file is stored in Git LFS. `raw.githubusercontent.com` returns only the LFS pointer;
`media.githubusercontent.com` serves the actual file content. The default branch is `main`.)

MoMA publishes a regularly-updated snapshot of their full collection as a GitHub repository.
`Artworks.json` is a JSON array of ~160,000 objects. Each object with an `ImageURL` field has a
publicly accessible image. As of early 2026, approximately 93,000 records have images.

**File size**: ~144 MB (raw). Trimmed cache stored on disk: ~15–20 MB.

**Fields used:**

| GitHub field | Cache field | Notes |
|---|---|---|
| `ObjectID` | `id` | Numeric identifier; used in artwork URL |
| `Title` | `t` | Artwork title |
| `Artist` | `a` | Array of artist names |
| `ArtistBio` | `b` | Array of biographical notes (e.g. "French, 1869–1954") |
| `Nationality` | `n` | Array of nationalities |
| `Date` | `d` | Free-text date string (e.g. "1929", "1928–29") |
| `Medium` | `med` | Free-text materials description |
| `Dimensions` | `dim` | Physical dimensions string |
| `Classification` | `cls` | Object type (e.g. "Painting", "Photograph") |
| `Department` | `dpt` | MoMA curatorial department |
| `URL` | `url` | Canonical MoMA collection URL |
| `ImageURL` | `fid` | Parsed to Dragonfly file ID; see _Image Access_ |
| `Width (cm)` | `w` | Used for pre-download aspect ratio filter |
| `Height (cm)` | `h` | Used for pre-download aspect ratio filter |
| `On View` | `ov` | Whether the work is currently on display |

Fields not kept: `ArtistBio` (only first kept), `AccessionNumber`, `CreditLine`, `DateAcquired`,
`Cataloged`, `ThumbnailURL`, and all measurement fields not directly used (Circumference, Depth,
Diameter, etc.).

---

### 2. Sanity CMS (curated set)

**Endpoint**: `https://476nwnl9.api.sanity.io/v2021-10-21/data/query/production`
**Query**: `*[_type == "artwork" && defined(tmsId)]{tmsId}` (GROQ)
**Authentication**: None required (project is publicly readable)

MoMA uses Sanity as a CMS for their collection website (`moma.org/collection`). Works that appear
on the website have been editorially highlighted with rich gallery label text. As of early 2026,
approximately 8,665 works have a Sanity entry with a `tmsId` field matching the GitHub `ObjectID`.

The Sanity curated set is fetched during cache build and stored as an array of ObjectIDs. When the
**Curated Works Only** setting is enabled, random selection is restricted to this set.

The Sanity CMS does not provide high-resolution images or additional metadata beyond the GitHub
dataset. Its only role here is as a curated-works filter.

---

## Image Access

### Dragonfly URL Construction

MoMA uses a custom image CDN called **Dragonfly** for all collection images. Image URLs are
Base64-encoded JSON instruction arrays passed as path components to `www.moma.org/media/`.

The `ImageURL` field in the GitHub dataset contains a 1024×1024 Dragonfly URL, e.g.:
```
https://www.moma.org/media/W1siZiIsIjYxOTIyMiJdLFsicCIsImNvbnZlcnQiLCItcXVhbGl0eSA5MCAtcmVzaXplIDEwMjR4MTAyNFx1MDAzZSJdXQ.jpg?sha=...
```

The base64 path decodes to:
```json
[["f","619222"],["p","convert","-quality 90 -resize 1024x1024\u003e"]]
```

Where:
- `["f","619222"]` — "fetch file ID 619222"
- `["p","convert","..."]` — "process with ImageMagick" (the `convert` instruction)
- **`\u003e`** — literal 6-character sequence `\`, `u`, `0`, `0`, `3`, `e` (NOT the `>` character).
  This is the ImageMagick `>` flag meaning "only shrink, never enlarge". Dragonfly requires this
  literal JSON Unicode escape encoding; using the bare `>` character causes a 400 error.

To construct a 2000×2000 URL (the maximum supported), the source:
1. Decodes the base64 from the `ImageURL` to extract the file ID.
2. Builds the instruction string `[["f","<fileId>"],["p","convert","-quality 90 -resize 2000x2000\u003e"]]` with literal `\u003e` bytes.
3. Re-encodes as standard Base64 (no URL-safe variant, no padding).

In JavaScript: `"\\u003e"` in a string literal gives the literal 6-character sequence `\u003e`.
When encoded via `Buffer.from(raw, 'ascii').toString('base64')`, the output matches Dragonfly's
expectations without the sha parameter (sha validation is not enforced).

**Maximum image size**: 2000×2000 px. Requesting dimensions above 2000 on either axis returns HTTP 400.

### Image Format

All Dragonfly images are served as JPEG regardless of original file format.

---

## Randomness Strategy

1. On first request (or after the 7-day TTL), the source downloads the GitHub `Artworks.json`
   (~144 MB), trims records to fields needed for filtering, and writes a compressed cache to
   `/data/moma_cache.json` (~15–20 MB). The Sanity curated set is fetched simultaneously.
2. The cache is loaded into memory as a JavaScript array once per process lifetime (with a 7-day
   in-memory TTL), and filters are applied in-process — no API calls during selection.
3. A random record is selected from the filtered pool.
4. The 2000×2000 Dragonfly URL is constructed from the cached file ID and the image is downloaded.
5. Up to 10 attempts are made per request in case of network failures.

This approach means no per-artwork API calls and no rate limiting concerns during random selection.
The one downside is a ~1–3 second delay on the first request after a cache rebuild (plus up to ~2
minutes to download the GitHub dataset on first install or after the 7-day TTL).

---

## Filtering

### Keyword search (`type: 'search'`, `mode: 'require'`)

MoMA has no search API — all filtering happens in-process against the in-memory artwork index.
A keyword search filters the pool to records where the term appears (case-insensitive substring)
in any of:
- `t` (title)
- `a` (artists array — any element)
- `med` (medium)

The filtered pool is then subject to any classification, department, curated, or aspect ratio
filters, and a random record is selected from the result. No additional API calls are needed.

**Limitation**: Only title, artist, and medium are searchable. Department, date, nationality, and
description text are not. MoMA's dataset does not include gallery label text in the GitHub export.

### Classification filter

Values come from the `Classification` field in the GitHub dataset. Common values:

| Classification | Notes |
|---|---|
| Painting | Oil, acrylic, etc. |
| Drawing | Works on paper, not prints |
| Print | Screenprints, etchings, etc. |
| Photograph | All photographic processes |
| Sculpture | 3D works |
| Design | Industrial and graphic design objects |
| Architecture | Architectural models and drawings |
| Film | Film works |
| Video | Video works |
| Illustrated Book | Artists' books |
| Textile | Fabric and fiber works |
| Collage | Collage and assemblage |
| Installation | Site-specific and installation works |
| Performance | Documentation of performance works |
| Multiple | Edition multiples |
| Work on Paper | Catch-all for non-print, non-drawing paper works |

Note: MoMA's classification vocabulary is not exhaustive — some records have unusual or missing
values. The list above covers the most common values as of early 2026.

### Department filter

Values from the `Department` field:
- Painting & Sculpture
- Drawings & Prints
- Photography
- Architecture & Design
- Film
- Media and Performance
- Library

### Aspect ratio (pre-download)

The `Width (cm)` and `Height (cm)` fields from the GitHub dataset are used for pre-download
aspect ratio filtering. This is accurate for 2D works (paintings, prints, photographs).
For 3D objects and installations, the physical dimensions may not reflect the image aspect ratio;
records without both dimension values are excluded when an aspect ratio filter is active.

### Curated Works Only (setting)

Restricts selection to the ~8,600 works in MoMA's Sanity CMS. These works appear on
`moma.org/collection` with editorial gallery label text. This is a curated "best of" subset — the
remaining ~85,000 works in the GitHub dataset are uncatalogued or catalogued but not editorially
featured. The curated set is fetched once per cache build cycle (7 days).

### On View Only (setting)

Restricts to artworks where the GitHub dataset `On View` field is true (currently on display in
the museum). This is a small fraction of the collection.

---

## Metadata Fields

| Source field | Cache key | Metadata key | Notes |
|---|---|---|---|
| `Title` | `t` | `title` | Artwork title |
| `Artist` | `a` | `creator` | Artist names, joined with ", " |
| `ArtistBio` | `b` | `creatorBio` | First artist's bio note |
| `Nationality` | `n` | `creatorNationality` | Nationalities, joined with ", " |
| `Medium` | `med` | `medium` | Materials description |
| `Dimensions` | `dim` | `dimensions` | Physical dimensions string |
| `Date` | `d` | `dateCreated` | Free-text date |
| `Classification` | `cls` | `classification` | Object type |
| `Department` | `dpt` | `department` | Curatorial department |
| `URL` | `url` | `artworkUrl` | `moma.org/collection/works/{id}` |
| — | — | `source` | Always "The Museum of Modern Art (MoMA)" |

---

## Known Limitations

- **No rich description text in the index**: The GitHub dataset does not include gallery label
  text. The Sanity CMS has this text, but fetching it per-artwork at selection time would require
  a separate API call. Not currently implemented.
- **Aspect ratio heuristic for 3D objects**: Physical dimensions for sculptures and installations
  do not reflect image crop. The pre-download aspect ratio filter may miss-classify these.
- **Classification vocabulary gaps**: Some records have unusual, empty, or non-standard
  classification values not covered by the filter UI's enumerated list. These records remain
  selectable when no classification filter is active; they are simply excluded by a require filter.
- **Cache initialization delay**: First request after a cache rebuild downloads the ~144 MB
  GitHub dataset, which may take 30–120 seconds depending on network speed. Subsequent requests
  within the 7-day TTL serve from the on-disk cache.
- **Dataset freshness**: The GitHub dataset is a periodic snapshot by MoMA. Acquisitions,
  deaccessions, and image changes between snapshots will not be reflected until the next
  cache rebuild.
- **No staff API access**: MoMA's staff API (`api.moma.org`) is restricted and not used here.

---

## Artwork URL Pattern

`https://www.moma.org/collection/works/{ObjectID}`

The `canHandleIdentifier` pattern accepts bare 4–6 digit numbers and MoMA collection URLs.
