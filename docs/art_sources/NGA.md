# National Gallery of Art

**Source ID**: `nga`
**Website**: https://www.nga.gov/
**Open Data**: https://github.com/NationalGalleryOfArt/opendata

## Overview

The National Gallery of Art (Washington, D.C.) publishes its open-access collection data as CSV files on GitHub. This source downloads and caches those CSVs to provide fast, filter-capable artwork selection from ~35,000 open-access works with IIIF images.

## Data Source

Two CSV files are downloaded from the NGA opendata GitHub repository and joined in memory:

| File | URL | Key columns used |
|------|-----|-----------------|
| `objects.csv` | `raw.githubusercontent.com/NationalGalleryOfArt/opendata/main/data/objects.csv` | `objectid`, `title`, `attribution`, `classification`, `medium`, `dimensions`, `displaydate`, `creditline`, `isvirtual` |
| `published_images.csv` | `raw.githubusercontent.com/NationalGalleryOfArt/opendata/main/data/published_images.csv` | `depictstmsobjectid`, `iiifurl`, `width`, `height`, `openaccess`, `viewtype` |

**Join key**: `objects.objectid` = `published_images.depictstmsobjectid`

**Eligibility criteria**:
- `published_images.openaccess = 1` (public domain)
- `published_images.viewtype` is `primary` or `front` (one image per object)
- `objects.isvirtual != 1` (no virtual/group records)

## Cache

The joined record array is held in memory with a 24-hour TTL. The cache is populated lazily on the first `fetchRandomArtwork` call. Concurrent requests share a single in-flight build promise.

**Build time**: ~5–15 seconds (depends on GitHub raw CDN speed)
**Cache size**: ~35,000 records in memory
**Dynamic filter values**: unique `visualbrowsertimespan` and `subclassification` values are extracted during cache build and stored in `_discoveredValues`. The filter-types route calls `getFilterTypes()` dynamically (not the startup-cached version) so discovered values are always current.

## Image Access

Images are served via IIIF at:

```
{iiifUrl}/full/!4800,4800/0/default.jpg
```

Where `iiifUrl` comes from the `published_images.csv` `iiifurl` column (NGA IIIF service at `api.nga.gov/iiif/{uuid}/`).

The `!4800,4800` constraint requests a fit-within-4800px image while preserving aspect ratio. NGA images typically range from 2000–4500px natively; no dezoomify needed.

**Native dimensions** are available in the CSV (`width`, `height` columns), enabling pre-download aspect ratio filtering without an extra `info.json` round-trip.

## Artwork URLs

```
https://www.nga.gov/collection/art-object-page.{objectid}.html
```

## Metadata Fields

| Field | Source column | Notes |
|-------|--------------|-------|
| `title` | `objects.title` | |
| `creator` | `objects.attribution` | Display name (e.g. "Joseph Mallord William Turner") |
| `dateCreated` | `objects.displaydate` | Human-readable string (e.g. "1844", "c. 1820–25") |
| `medium` | `objects.medium` | Free-text materials description |
| `dimensions` | `objects.dimensions` | Physical dimensions string |
| `creditLine` | `objects.creditline` | Acquisition credit / collection name |
| `source` | — | Always "National Gallery of Art" |

## Filters

All filters are applied in-memory against the cached records. Multiple filters of the same type intersect (AND); multiple filter entries of different types also intersect.

### Object Type (`objectType`)
Maps to `objects.classification`. Supported values (case-insensitive):
- Painting, Drawing, Print, Photograph, Sculpture, Decorative Art, Textile/Fashion, Portfolio

Any classification value not in this list is accessible via random shuffle (no filter) but cannot be targeted by the objectType filter.

### Sub-type (`subclassification`)
Maps to `objects.subclassification`. More granular than objectType — e.g., "etching", "lithograph", "oil", "daguerreotype", "chalk". Values are **discovered dynamically** from the CSV when the cache loads; the filter UI shows the full list from actual data. Useful for focusing on a specific print technique, photographic process, etc.

### Time Period (`timePeriod`)
Maps to `objects.visualbrowsertimespan`. Uses the NGA's standard date-range buckets (e.g., "1600 to 1700", "1850 to 1900"). Values are discovered from the CSV. Before the cache loads, the UI shows pre-defined defaults matching the NGA's Browse-by-Date periods.

### Artist (`artist`)
Require mode only. Filters pool to records where `attribution` contains the search string (case-insensitive). `suggestArtists()` returns matching attribution values ranked by artwork count.

### Search (`search`)
Require mode only. Filters pool to records where `title` or `attribution` contains the search term (case-insensitive).

## Aspect Ratio

Uses `width` and `height` from `published_images.csv` for pre-download aspect ratio filtering. No `info.json` request needed.

## Notes

- The NGA attribution field sometimes includes qualifiers like "Attributed to", "Circle of", "Workshop of", or "After". These are preserved as-is in metadata and included in artist search matching.
- Virtual objects (`isvirtual = 1`) are excluded — these are group records that don't have their own images.
- Only primary/front viewtype images are included; alternate views and detail photographs are excluded to avoid duplication.
