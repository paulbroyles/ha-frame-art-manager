# Wikimedia Commons

Wikimedia Commons hosts tens of millions of freely licensed media files. This source uses
the Commons API to browse and search art images across a curated set of categories covering
major media types, institutions, subjects, and centuries.

No API key required. Wikimedia policy requires a descriptive User-Agent header on all requests.

---

## API

- **Base URL**: `https://commons.wikimedia.org/w/api.php`
- **Authentication**: None
- **Rate limit**: No published limit; standard polite-crawl behavior (no deliberate throttling
  beyond what axios timeouts enforce)
- **Search engine**: CirrusSearch (Wikimedia's Elasticsearch-based search)
- **Image access**: Direct `upload.wikimedia.org` URLs from `imageinfo[0].url`

---

## Fetch Strategy

The strategy varies based on which filters are active:

| Active filters | Strategy |
|---|---|
| None | Weighted random draw across all `MEDIA_CATEGORIES`; random sort-key prefix browse |
| Media only | CirrusSearch with `deepcat:` on the media category |
| Institution only | Sort-key browse on institution category |
| Subject only | CirrusSearch with `deepcat:` on the subject category |
| Institution + Media, or Subject + Media | CirrusSearch with one `deepcat:` clause (subject or media) + optional institution scope |
| Century (any combination) | CirrusSearch; century × media merged into `incategory:"17th-century paintings"` |
| Artist / Search | CirrusSearch with text term + `deepcat:` scoping from other filters |

**Category browse** uses `generator=categorymembers` with a random uppercase letter A–Z as
`gcmstartsortkeyprefix`, scattering the starting point across the sorted filename list.

**CirrusSearch** uses `generator=search` with `deepcat:` traversal and successive
`gsroffset` increments across rounds. Initial offset is a random value within the
total result count (cache hit) or within `MAX_SEARCH_OFFSET=9500` (cache miss).

Up to `MAX_ROUNDS=5` rounds × `BATCH_SIZE=10` candidates = 50 tries per fetch.

### Why `deepcat:` instead of `incategory:`

`incategory:` matches only *direct* file members of a category. Top-level Commons categories
like `Category:Paintings` or `Category:Landscapes` contain almost no direct files — everything
is organized in deep subcategory trees. Switching from `incategory:` to `deepcat:` is the
difference between 0–5 results and 200,000+ results.

**`deepcat:` costs**: Each CirrusSearch query with `deepcat:` takes ~4 seconds server-side.
This is inherent to Wikimedia's category traversal and cannot be reduced. Each fetch round
is a separate query, so 5 rounds = ~20 seconds worst case (in practice: 1–2 rounds for
common queries).

---

## Filters

### Media Type (`media`)

Maps to a `deepcat:` CirrusSearch clause (always forces search mode).

| Value | Commons category |
|---|---|
| Paintings | `Category:Paintings` |
| Drawings | `Category:Drawings` |
| Prints | `Category:Prints (art)` |
| Photographs | `Category:Photographs` |
| Sculptures | `Category:Sculptures` |
| Illuminated manuscripts | `Category:Illuminated manuscripts` |
| Tapestries | `Category:Tapestries` |

Default weights (for no-filter random draw): Paintings 5, Photographs 3, Drawings/Prints/Sculptures 2, Manuscripts/Tapestries 1.

Modes: **require**, **exclude**

### Institution (`institution`)

Restricts browse to a specific museum/collection category. In search mode, adds an
`incategory:` clause (institution categories have sufficient direct members or are
used in combination with other clauses).

| Institution | Commons category |
|---|---|
| Paris Musées | `Category:Images from Paris Musées` |
| Rijksmuseum | `Category:Images from the Rijksmuseum` |
| Wellcome Collection | `Category:Wellcome Collection` |
| Smithsonian Institution | `Category:Images from Smithsonian Institution` |
| Cleveland Museum of Art | `Category:Cleveland Museum of Art` |
| LACMA | `Category:Los Angeles County Museum of Art` |
| Louvre | `Category:Paintings in the Louvre` |
| Uffizi | `Category:Paintings in the Uffizi` |
| Prado | `Category:Paintings in the Museo del Prado` |
| Hermitage | `Category:Paintings in the Hermitage Museum` |
| National Gallery (London) | `Category:Paintings in the National Gallery, London` |

Modes: **require** only

### Subject (`subject`)

Restricts to a subject/theme category via `deepcat:` (always forces search mode).

**Important limitation**: When a subject filter is active, no media-type clause is added
to the query. Intersecting `deepcat:"Landscapes"` with `deepcat:"Paintings"` returns
~17 results because Commons files are generally not members of *both* independent
subject and media category trees. `deepcat:"Landscapes"` alone returns ~206,000 results.
The subject filter therefore narrows by theme but does not also filter by media type.

| Value | Commons category |
|---|---|
| Portraits | `Category:Portraits` |
| Landscapes | `Category:Landscapes` |
| Still lifes | `Category:Still lifes` |
| Religious art | `Category:Religious art` |
| Mythology | `Category:Mythology in art` |
| Genre scenes | `Category:Genre art` |
| Animals | `Category:Animals in art` |
| Botanical art | `Category:Botanical illustrations` |
| Nude art | `Category:Nude art` |
| Architecture | `Category:Architectural drawings` |
| Maritime art | `Category:Marine art` |
| Battle art | `Category:Battle paintings` |

Modes: **require** only

### Century (`century`)

Always triggers CirrusSearch mode. Combined with a media type, produces a merged
`incategory:"17th-century paintings"` clause for category precision. Without a media
filter, picks a weighted-random media category per round and merges it with the century.

Values: 13th–21st century in `"Nth century"` format.

Modes: **require** only

### License (`license`)

Post-fetch filter against `LicenseShortName` from extmetadata. Cannot be pre-filtered
via the API; may increase rounds needed when filtering strictly.

| Value | Matches LicenseShortName prefixes |
|---|---|
| CC0 | CC0, Public Domain |
| CC BY | CC BY, CC BY 4.0, CC BY 3.0, CC BY 2.0, CC BY 2.5 |
| CC BY-SA | CC BY-SA 4.0, CC BY-SA 3.0, CC BY-SA 2.0, CC BY-SA 2.5 |
| Public Domain | Public Domain, PD-old, PD, PD-Art |

Modes: **require**, **exclude**

### Artist / Search

Both use CirrusSearch with the text term combined with any active `deepcat:` clauses
from other filters. Artist takes priority when both are present.

### Detail Image Filter (`filterDetails`)

Enabled by default (toggle in source settings). Rejects files whose titles match a
regex for common detail-image naming patterns:

```
\b(detail|détail|closeup|close-up|signature|signé|fragment|verso|recto|inscription|label|stamp)\b
|\([2-9]\)|[_ -]0[2-9](?:\.|$)
```

In search mode, also injects `-deepcat:"Details of paintings"` into the query string.

---

## Image Access

`imageinfo[0].url` — direct `upload.wikimedia.org` JPEG/PNG/TIFF links, typically
1500–5000px on the long edge.

`iiprop=size` returns `width` and `height`, enabling pre-download aspect-ratio filtering.
`iiprop=mime` detects and skips SVG and non-raster files. `sharp()` is used as fallback
when dimensions are absent.

---

## Metadata

| Field | Wikimedia extmetadata key | Notes |
|---|---|---|
| `title` | `ObjectName` | HTML-stripped |
| `creator` | `Artist` | HTML-stripped (often contains anchor tags) |
| `dateCreated` | `DateTimeOriginal` | Creation date or period |
| `artworkUrl` | (derived) | `https://commons.wikimedia.org/wiki/File:...` |
| `source` | (constant / override) | `"Wikimedia Commons"`, or institution name for wrappers |

`medium` is always `null` — not available in a structured form from Commons extmetadata.

---

## Thin Wrapper Sources

Institution-specific sources (e.g. `paris_musees.js`) are thin wrappers that:
1. Pre-inject `{ type: 'institution', mode: 'require', values: ['<Institution>'] }` via `preFilters`
2. Override `sourceLabel` so metadata reads as the institution name, not "Wikimedia Commons"
3. Call `getFilterTypes()` and filter out the `institution` type (since it's pre-set)

To add a new institution wrapper, create a new source file following the pattern in
`sources/paris_musees.js` and add a matching entry to `BUILTIN_SOURCES` in `routes/web_sources.js`.

---

## Known Limitations

### Result quality noise

Commons is a general-purpose media repository, not a curated art collection. Even with
media-type and subject filters, results routinely include:

- **Photos of people painting** — e.g. "Artist at work" photos filed under `Category:Paintings`
- **In-situ mural photographs** — photos of murals on walls with surrounding scenery
- **"Own work" uploads** — amateur and hobbyist works uploaded by their creators
- **Metadata-only or reproduction files** — text documents, labels, stamps filed alongside artwork

For use cases requiring curated art, Wikidata SPARQL (`wikidata.js`) offers
structured metadata filtering (movement, genre, P31 type) that avoids most of this noise.

### Category intersection

Commons files are generally members of *either* a subject category tree *or* a media
category tree — not both. Intersecting `deepcat:"Landscapes"` × `deepcat:"Paintings"`
returns ~17 files; each alone returns 200K+. The source works around this by applying
only one `deepcat:` clause per query when subject is active.

### `deepcat:` performance

Every CirrusSearch query with `deepcat:` takes ~4 seconds server-side. This cannot be
reduced. A first fetch (cold count cache) may wait up to 4 seconds before the first
result batch. Subsequent fetches within the 1hr count cache window start immediately.

### `incategory:` depth

For non-deepcat contexts (institution browse, century categories), `incategory:` matches
only direct category members. Files in subcategories won't appear. This is intentional
for institution browse (institution categories tend to have direct file members) but
would be wrong for media/subject filters (hence `deepcat:` there).

### Category name accuracy

Commons category names are hardcoded. If a category is renamed or doesn't exist, the
API returns empty results. Verify at `https://commons.wikimedia.org/wiki/Special:Search`.

### Century category availability

Not all `"17th-century drawings"` style categories exist on Commons. Missing categories
return empty results; the next round picks a different random media type.

### License post-filtering

The license filter cannot be applied before download; each rejected file costs a full
API round-trip.

### No medium field

Commons extmetadata does not include object medium in a structured form.
