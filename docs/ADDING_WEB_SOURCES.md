# Adding Web Sources

This document is the authoritative checklist for implementing a new web art source.
**Read this document before creating a new source. Update it when the source contract changes.**

## Overview

A web source is a Node.js module in `frame_art_manager/app/sources/` that fetches a random
artwork image from an external service and returns the image buffer plus metadata.

The route layer (`app/routes/web_sources.js`) handles persistence, caching, and TV display.
Source modules are responsible only for fetching and filtering.

---

## Checklist

1. Create `frame_art_manager/app/sources/<source_id>.js` following the contract below.
2. Add the module to `SOURCE_MODULES` in `web_sources.js`.
3. Add a `BUILTIN_SOURCES` entry in `web_sources.js`.
4. If the source has configurable media categories, export `settingsSchema` and `buildFetcherOptions`.
5. Create `docs/art_sources/<SOURCE>.md` documenting the external API, selection strategy, and any limitations.

---

## Source Module Contract

### Required Export

```js
async function fetchRandomArtwork(mediaFilter = null, options = {})
```

**Parameters:**

| Parameter | Type | Description |
|---|---|---|
| `mediaFilter` | `string[] \| null` | Source-specific filter values (e.g. classification names). `null` or `[]` means no filter. Defined by the source's own vocabulary — the route layer passes through whatever `buildFetcherOptions` returns. |
| `options.aspectRatio` | `'all' \| 'landscape' \| 'portrait'` | Aspect ratio to enforce. Default `'all'`. See _Aspect Ratio_ below. |

**Return value:**

```js
{
  imageBuffer: Buffer,      // Raw image bytes
  contentType: string,      // MIME type, e.g. 'image/jpeg' or 'image/png'
  metadata: {
    title: string | null,
    creator: string | null,
    medium: string | null,       // Material/technique (e.g. "Oil on canvas")
    attribution: string | null,  // Attribution line if different from creator
    dateCreated: string | null,  // Human-readable date (e.g. "1889", "ca. 1880–1890")
    artworkUrl: string | null,   // Canonical URL to the artwork page
    source: string,              // Human-readable source name (e.g. "The Metropolitan Museum of Art")
  }
}
```

Only `title`, `creator`, `medium`, `attribution`, `dateCreated`, and `artworkUrl` are surfaced to
the metadata mapping UI. Include all that are available; omit fields the source doesn't provide.
Always include `source`.

**Errors:** Throw a plain `Error` with a descriptive message on network failure, empty results, or
an unsatisfiable filter (e.g. portrait requested from a landscape-only source). The route layer
catches all errors and returns HTTP 500 with `error.message`.

### Optional Exports

```js
// Schema for the settings dialog (omit if source has no user-configurable options)
const settingsSchema = {
  mediaCategories: [
    { name: 'Category Group', media: ['Type A', 'Type B'] },
  ],
};

// Convert stored settings to fetchRandomArtwork options (omit if not needed)
function buildFetcherOptions(settings) {
  // settings.disabledMedia: string[] of disabled category names
  // Return { mediaFilter: string[] } or {}
}
```

---

## Aspect Ratio

Every source **must** handle `options.aspectRatio`. The route layer resolves `'match_tv'` before
calling the fetcher, so sources only ever receive `'all'`, `'landscape'`, or `'portrait'`.

### Pre-download filtering (preferred)

If the source's API returns aspect ratio or dimensions in the search/listing response, filter before
downloading the image. This avoids unnecessary network traffic.

Example: Google Arts & Culture returns `cobject[10][1]` (a `width/height` float) in the entity
asset list. Filter the candidate list before picking one to download.

```js
if (aspectRatio !== 'all') {
  artworks = artworks.filter(a => {
    if (a.aspectRatio === null) return false;
    if (aspectRatio === 'landscape') return a.aspectRatio > 1;
    if (aspectRatio === 'portrait')  return a.aspectRatio < 1;
    return true;
  });
}
```

### Post-download filtering (fallback)

If dimensions aren't available pre-download, download the image and inspect it with `sharp`:

```js
const sharp = require('sharp');
// ...
const { width, height } = await sharp(imageBuffer).metadata();
const isLandscape = width > height;
if (aspectRatio === 'landscape' && !isLandscape) continue;
if (aspectRatio === 'portrait'  &&  isLandscape) continue;
```

`sharp` is already a project dependency. Use a retry loop (e.g. `MAX_ATTEMPTS = 5`) and
`continue` to skip images that don't match.

### Landscape-only sources

If a source can only ever produce landscape images (e.g. images are fixed-crop at 16:9), it should:

1. Fast-fail when `aspectRatio === 'portrait'`:
   ```js
   if (aspectRatio === 'portrait') {
     throw new Error('This source only provides landscape artworks; portrait filter cannot be satisfied');
   }
   ```
2. Declare `aspectRatioConstraint: 'landscape'` in its `BUILTIN_SOURCES` entry so the route layer
   skips it automatically and the UI grays it out.

Similarly for a portrait-only source: fast-fail on `'landscape'` and set `aspectRatioConstraint: 'portrait'`.

---

## Registering in web_sources.js

### 1. Add to SOURCE_MODULES

```js
const SOURCE_MODULES = {
  // ...existing...
  my_source: require('../sources/my_source'),
};
```

### 2. Add to BUILTIN_SOURCES

```js
const BUILTIN_SOURCES = {
  // ...existing...
  my_source: {
    id: 'my_source',
    name: 'My Source Display Name',
    description: 'One sentence shown to the user in the Web Sources UI',
    type: 'my_source',
    // Only include if orientation-constrained:
    // aspectRatioConstraint: 'landscape',
  },
};
```

The `id` and `type` must match the key in `SOURCE_MODULES`. The `description` appears in the source card.

---

## Documentation

Create `docs/art_sources/<SOURCE>.md` covering:

- External API or data endpoint (URL, auth, rate limits)
- How a random item is selected (search + offset, list + random index, etc.)
- How aspect ratio is determined (pre-download field, post-download, or fixed)
- Metadata fields and where they come from
- Known limitations (landscape-only, small collection, no portrait metadata, etc.)
- Reference implementations or prior art, if any

See existing docs in `docs/art_sources/` as examples.

---

## How the Route Layer Calls a Source

```
POST /api/web-sources/fetch-and-display
  → resolveAspectRatioFilter(webSources, tvOrientation)   // 'match_tv' → concrete value
  → isSourceCompatible(sourceId, aspectRatio)             // skip constrained sources
  → buildFetcherOptions(sourceId, settings)               // source-specific media filter
  → fetcher(mediaFilter, { aspectRatio })                 // your fetchRandomArtwork
  → write image to cache file
  → displayImageOnTV(cachePath, deviceId)
```

The test-fetch path (`POST /api/web-sources/test-fetch`) uses the same filter and fetcher call
but writes to a `_test.<ext>` cache file and does not call `displayImageOnTV`.