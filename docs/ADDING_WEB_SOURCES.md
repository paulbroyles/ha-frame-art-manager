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
2. Add the module to `SOURCE_MODULES` in `web_sources.js` (order matters — more-specific `canHandleIdentifier` patterns should come first).
3. Add a `BUILTIN_SOURCES` entry in `web_sources.js`.
4. Export `selectMode(filters)` — even if the source has only one mode, this is required.
5. If the source has filterable dimensions (e.g. media categories, object types), export `getFilterTypes()`.
6. If the source has non-filter options derived from settings (e.g. fetchRichMetadata), export `getExtraOptions(settings)`.
7. If the source has stable per-artwork identifiers, export `fetchByIdentifier` and `canHandleIdentifier`.
8. If the source is orientation-constrained, export `aspectRatioConstraint` (see _Landscape-only sources_).
9. Create `docs/art_sources/<SOURCE>.md` documenting the external API, selection strategy, and any limitations.

---

## Source Module Contract

### Required Exports

```js
async function fetchRandomArtwork(filters = [], options = {})
```

**Parameters:**

| Parameter | Type | Description |
|---|---|---|
| `filters` | `Array<{type, mode, values}>` | Generic filter objects. Each has `type` (string matching a declared filter type), `mode` (`'require'` or `'exclude'`), and `values` (string array). Empty array means no filtering. The route layer passes the source's stored filters (and any virtual tag filters layered on top). |
| `options.aspectRatio` | `'all' \| 'landscape' \| 'portrait'` | Aspect ratio to enforce. Default `'all'`. See _Aspect Ratio_ below. |

Sources must handle unknown filter types gracefully (ignore them). The route layer validates
filters against `getFilterTypes()` when storing them, but virtual tag filters may introduce
types the source doesn't know about — these should be silently skipped.

**Return value:**

```js
{
  imageBuffer: Buffer,      // Raw image bytes
  contentType: string,      // MIME type, e.g. 'image/jpeg' or 'image/png'
  metadata: {
    // Include whichever fields this source provides; omit ones it doesn't have.
    // Any field declared in metadataFields (see below) can be mapped by the user.
    title: string | null,
    creator: string | null,
    medium: string | null,         // Material/technique (e.g. "Oil on canvas")
    attribution: string | null,    // Attribution line if different from creator
    dateCreated: string | null,    // Human-readable date (e.g. "1889", "ca. 1880–1890")
    artworkUrl: string | null,     // Canonical URL to artwork page (not in metadataFields)
    source: string,                // Human-readable source name — always include this
    // Additional fields as appropriate for the source:
    // repository, creatorNationality, dimensions, description, color, ...
  }
}
```

`artworkUrl` is used internally (stored in perTvCache) but is not a mappable field.
All other fields returned in `metadata` should be declared in `metadataFields` so users can map them.

**Errors:** Throw a plain `Error` with a descriptive message on network failure, empty results, or
an unsatisfiable filter (e.g. portrait requested from a landscape-only source). The route layer
catches all errors and returns HTTP 500 with `error.message`.

```js
function selectMode(filters = [])
```

Examines the full merged filter set and returns the best API strategy for this source.
Called internally by `fetchRandomArtwork` and also exported for introspection (the test
panel can display which mode was selected).

**Return value:**

```js
{
  mode: string,       // Internal mode identifier (e.g. 'browse_medium', 'search', 'list')
  apiFilters: Array,  // Subset of filters the API can enforce natively
  postFilters: Array, // Subset of filters that must be checked after download
}
```

Sources with only one mode can return a static result. Sources with multiple API strategies
(e.g. search vs. browse) examine the filter set to pick the most efficient approach.
Filter types with `modeDetermining: true` in their schema hint to the UI that configuring
that filter changes the API strategy.

### Required metadata exports

Every source must also export `metadataFields` and `defaultMapping`:

```js
// Declares which metadata fields this source provides.
// Consumed by the UI to render per-source mapping controls.
// Include every field that appears in fetchRandomArtwork's metadata return value
// (except artworkUrl, which is internal-only).
const metadataFields = [
  { key: 'title',  label: 'Title',  description: 'Artwork title' },
  { key: 'source', label: 'Source', description: 'Source collection name (always "My Source")' },
  // ... add all fields this source provides
];

// Default mapping hints: source field key → suggested HA attribute name (or null).
// Hint strings are matched case-insensitively against available HA attributes at render time.
// Fields whose hint matches an existing attribute are auto-selected in the UI (shown as "auto").
// User can override any field; "Reset to Auto-detected" clears overrides.
const defaultMapping = {
  title:  'title',   // look for an HA attribute named 'title' (case-insensitive)
  source: null,      // no good guess — leave unmapped by default
};
```

Both must be included in `module.exports`.

### Recommended Exports: fetchByIdentifier and canHandleIdentifier

Sources should export these two functions to support fetching a specific artwork by URL or ID
from the Test pane. Implement them whenever the source has a stable per-artwork identifier
(object ID, URL slug, etc.).

```js
/**
 * Returns true if this source can fetch the given identifier string.
 * Called by the route layer in declaration order; the first match wins.
 * Keep patterns specific enough to avoid false positives with other sources.
 */
function canHandleIdentifier(identifier) {
  // Example: accept numeric IDs and canonical collection URLs
  const t = identifier.trim();
  return /example\.org\/collection\/\d+/i.test(t) || /^\d+$/.test(t);
}

/**
 * Fetch a specific artwork by URL or source-specific ID.
 * Should return the same shape as fetchRandomArtwork.
 * Throw a descriptive Error if the identifier is inaccessible or the download fails.
 */
async function fetchByIdentifier(identifier) {
  // Parse the ID, call source API, download image, return { imageBuffer, contentType, metadata }
}
```

If the source has no stable per-artwork identifier (e.g. identifiers are opaque or ephemeral),
omit these exports. The Test pane will still work via `fetchRandomArtwork`; the specific-image
field will simply not recognize this source's URLs.

### Optional Exports

```js
// Schema for the settings dialog (omit if source has no user-configurable options)
const settingsSchema = {
  fields: [
    { key: 'myOption', type: 'boolean', default: false, label: '...', description: '...' },
  ],
};

// Declare filterable dimensions for the UI filter builder.
// Return [] if the source has no filterable dimensions.
function getFilterTypes() {
  return [
    {
      type: 'media',                // Unique type ID within this source
      label: 'Medium',             // User-visible label
      description: 'Filter by art medium',
      modes: ['require', 'exclude'],  // Which modes this filter supports
      multiValue: true,               // Can multiple values be selected?
      modeDetermining: false,         // If true, configuring this filter changes the API strategy
      values: [                        // Enumerated possible values
        { value: 'Paintings', label: 'Paintings' },
        { value: 'Sculpture', label: 'Sculpture' },
      ],
      groups: [                        // Optional grouping for the UI
        { name: 'Fine Art', values: ['Paintings', 'Sculpture'] },
      ],
    },
  ];
}

// Return default filters applied when the source is first initialized with no filters.
// Optional — omit if the source has no sensible defaults.
function getDefaultFilters() {
  return [
    { type: 'objectType', mode: 'exclude', values: ['folio', 'codex'] },
  ];
}

// Convert stored source settings to non-filter fetcher options.
// Only needed when the source has settings that affect fetch behavior
// but are not part of the filter system (e.g. fetchRichMetadata).
function getExtraOptions(settings) {
  return { fetchRichMetadata: !!settings?.fetchRichMetadata };
}

// If the source pre-processes images to final display resolution (e.g. fixed 3840×2160 crop),
// export this to skip the image processing pipeline:
const alreadyProcessed = true;

// If metadata fields vary based on settings, export a function instead of the static array:
function getMetadataFields(settings) {
  // Return metadataFields, possibly augmented based on settings
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
2. Export `aspectRatioConstraint = 'landscape'` from the source module so the route layer
   skips it automatically and the UI grays it out. (Also declared in `BUILTIN_SOURCES` for
   backward compatibility during the migration period.)

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
POST /api/web-sources/fetch-and-send
  → fetchAndProcessWebSource(req, { sourceId, virtualTagId, tvOrientation })
      → resolveAspectRatioFilter(webSources, tvOrientation)   // 'match_tv' → concrete value
      → isSourceCompatible(sourceId, aspectRatio)             // skip constrained sources
      → mergeFilterCascade(globalFilters, sourceFilters, tagFilters)  // 3-level cascade
      → fetcher(mergedFilters, { aspectRatio, ...extraOpts }) // your fetchRandomArtwork
      → process image (crop/trim)
      → build metadata snapshots
  → write processed image to pending cache file
  → sendImageToTV(pendingFile, deviceId, { select, screenOn, matte, artworkMetadata })
```

Filters cascade through three levels: **global → per-source → per-virtual-tag**.
The route layer merges them using `mergeFilterCascade()` (require = intersection, exclude = union).
Sources receive the fully merged filter array and should not need to know which level a filter came from.

The test-fetch path (`POST /api/web-sources/test-fetch`) uses the same filter and fetcher call
but writes to a `_test.<ext>` cache file and does not call `sendImageToTV`.