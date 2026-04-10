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
| Media only | Weighted random draw among required media categories; sort-key browse |
| Institution only | Sort-key browse on institution category |
| Subject only | Sort-key browse on subject category |
| Institution + Media, or Subject + Media | CirrusSearch with `incategory:` for each |
| Century (any combination) | CirrusSearch; century × media merged into one `incategory:"17th-century paintings"` |
| Artist / Search | CirrusSearch with text term + `incategory:` scoping from other filters |

**Category browse** uses `generator=categorymembers` with a random uppercase letter A–Z as
`gcmstartsortkeyprefix`, scattering the starting point across the sorted filename list.

**CirrusSearch** uses `generator=search` with successive `gsroffset` increments across rounds.

Up to `MAX_ROUNDS=5` rounds × `BATCH_SIZE=10` candidates = 50 tries per fetch.

---

## Filters

### Media Type (`media`)

Maps to Wikimedia Commons category browse or `incategory:` search clause.

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

Restricts browse to a specific museum/collection category. When combined with a media or
subject filter, switches to CirrusSearch mode with multiple `incategory:` clauses.

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

Restricts browse to a subject/theme category. Single active subject uses direct category
browse; combined with other category filters uses `incategory:` search.

| Value | Commons category |
|---|---|
| Portraits | `Category:Portraits` |
| Landscapes | `Category:Landscapes` |
| Still lifes | `Category:Still lifes` |
| Religious art | `Category:Religious art` |
| Mythology | `Category:Mythological art` |
| Genre scenes | `Category:Genre art` |
| Animals | `Category:Animals in art` |
| Botanical art | `Category:Botanical illustration` |
| Nude art | `Category:Nude art` |
| Architecture | `Category:Architecture in art` |
| Maritime art | `Category:Maritime art` |
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

Both use CirrusSearch with the text term combined with any active `incategory:` clauses
from other filters. Artist takes priority when both are present.

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

- **Category name accuracy**: Commons category names are hardcoded in `MEDIA_CATEGORIES`,
  `INSTITUTIONS`, and `SUBJECT_CATEGORIES`. If a category is renamed or doesn't exist, the
  API returns empty results. Verify at `https://commons.wikimedia.org/wiki/Special:Search`.
- **`incategory:` depth**: CirrusSearch's `incategory:` matches direct category membership
  only. Files in subcategories won't appear in search results; category browse is unaffected.
- **Century category availability**: Not all `"17th-century drawings"` style categories exist
  on Commons. Missing categories return empty results; the next round picks a different random
  media type.
- **License post-filtering**: The license filter cannot be applied before download; each
  rejected file costs a full API round-trip.
- **No medium field**: Commons extmetadata does not include object medium in a structured form.
