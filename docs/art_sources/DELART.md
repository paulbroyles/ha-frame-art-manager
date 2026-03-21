# Delaware Art Museum (`delart`)

**Source file**: `frame_art_manager/app/sources/delart.js`
**Base URL**: `https://emuseum.delart.org`
**Collection size**: ~12,800 objects (as of 2026-03)

## Overview

The Delaware Art Museum uses **eMuseum** (Gallery Systems), a server-side rendered HTML gallery with no public JSON API. The source scrapes browse pages and detail pages using HTML regex parsing.

The collection is particularly strong in American illustration art (Howard Pyle school), Pre-Raphaelite paintings, and 19th–20th century American works.

## Selection Strategy

**Two-phase fetch**:

1. **Browse page**: `GET /objects/images?page=N[&filter=classifications%3AVALUE]`
   - 12 items per page
   - Returns a grid of result items with `data-emuseum-id` attributes
   - Each item contains the object path (`/objects/{id}/{slug}`) and a thumbnail media_id
   - Page count probed from page 1, cached for 7 days

2. **Detail page**: `GET /objects/{id}/{slug}`
   - Full metadata: title, artist, medium, date, classification
   - Authoritative media_id from `og:image` meta tag
   - Object page URL used as dezoomify target

## Classification Filter

The eMuseum filter parameter restricts results server-side:

| User label  | URL parameter value |
|-------------|---------------------|
| Painting    | `PAINTING`          |
| Drawing     | `DRAWING`           |
| Print       | `PRINT`             |
| Photograph  | `PHOTOGRAPH`        |
| Sculpture   | `SCULPTURE`         |

Filter URL: `?filter=classifications%3APAINTING` (etc.)

When multiple classifications are eligible (require/exclude filters), all are probed in parallel (one page-1 request each, cached for 7 days) to get item counts. One classification is then selected weighted by item count so larger categories are sampled proportionally.

## Image Resolution

**Primary**: dezoomify-rs on the object page URL. eMuseum uses IIPImage/DeepZoom for high-resolution tile serving; dezoomify-rs auto-detects this from the page. Returns up to the maximum zoom level available.

**Fallback** (dezoomify-rs unavailable or no tiles): `/internal/media/dispatcher/{media_id}/full` — serves images up to approximately 1024px on the longest side.

dezoomify-rs is a no-op if the binary isn't installed, so the source degrades gracefully to the fallback in non-Docker environments.

## Page Count Probing

Page 1 of each classification browse is fetched to extract the total count from the result summary text ("Showing 1 - 12 of N objects"). Both `maxPages` and `totalCount` are stored in the cache for 7 days and reused for weighted classification selection.

Default fallback if probe fails: **1,068 pages** (unfiltered as of 2026-03).

## Metadata Fields

| Key            | Description                              |
|----------------|------------------------------------------|
| `title`        | Artwork title (from `<h1>` in titleField) |
| `creator`      | Artist name(s) (from peopleField)        |
| `medium`       | Materials and techniques                 |
| `dateCreated`  | Date or date range                       |
| `classification` | Object type (e.g. "Painting")          |
| `source`       | Always "Delaware Art Museum"             |

Metadata is scraped via regex from `.detailField.{fieldName}` wrappers and `.detailFieldValue` spans. HTML tags are stripped before returning.

## fetchByIdentifier

Accepts eMuseum object URLs:
```
https://emuseum.delart.org/objects/12345/title-slug
```

Fetches the detail page, parses the media_id from `og:image`, and downloads the image via dezoomify (or fallback).

## API Notes

- **No keyword search**: The eMuseum `search=` URL parameter has no observable effect on results.
- **No JSON API**: All data is scraped from HTML responses.
- **Rate limiting**: Not observed, but requests include a `User-Agent` header as courtesy.
- **eMuseum ID**: The numeric `data-emuseum-id` matches the first path segment in `/objects/{id}/{slug}`.
- **og:image** reliably provides the media_id even when thumbnail markup is absent.

## Known Limitations

- HTML scraping is fragile; eMuseum site updates could break parsing.
- Aspect ratio filtering is post-download (no dimension data in browse/detail HTML).
- The fallback dispatcher `/full` URL caps at ~1024px, below the 4K target. dezoomify-rs significantly improves quality when available.
- No artist/keyword search supported.
