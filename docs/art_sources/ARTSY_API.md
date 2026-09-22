# Artsy API

## Overview

Source ID: `artsy`

Fetches for-sale artworks from Artsy's gallery marketplace. Uses the Artsy Metaphysics v2 GraphQL API — the same internal API powering artsy.net. No authentication required.

**Collection size**: ~1.2M for-sale artworks (March 2026)

## API Endpoint

```
POST https://metaphysics-production.artsy.net/v2
Content-Type: application/json
```

GraphQL body: `{ "query": "{ artworksConnection(...) { ... } }" }`

This is Artsy's open-source Metaphysics layer: https://github.com/artsy/metaphysics

## Randomization

The API limits pagination to 100 pages × 100 items = 10,000 positions per filter combination. To expand the accessible pool, the source randomly picks among 6 sort orders on each fetch:

- `-published_at` (newest first)
- `published_at` (oldest first)
- `-merchandisability`
- `merchandisability`
- `-created_at`
- `created_at`

This gives **60,000 accessible positions per filter combo** — enough variety that an hourly shuffle would take ~6.8 years before exhausting unique works.

Count totals are cached per `medium_collection_sort` key (6-hour TTL) and populated from the `counts.total` field in every response, so no extra API calls are needed.

## Filters

### Medium (`type: 'medium'`, `mode: 'require'`)

Maps to the `medium` parameter on `artworksConnection`. When multiple values are selected, one is chosen randomly on each fetch.

| API value | Label | ~Count (Mar 2026) |
|-----------|-------|-------------------|
| `painting` | Painting | 498K |
| `photography` | Photography | 218K |
| `prints` | Prints & Multiples | 160K |
| `mixed-media` | Mixed Media | 151K |
| `sculpture` | Sculpture | 127K |
| `drawing` | Drawing | 48K |
| `design` | Design / Decorative Art | 15K |
| `textile-arts` | Textile Arts | 13K |
| `books-and-portfolios` | Books & Portfolios | 2.5K |
| `jewelry` | Jewelry | 1K |

### Collection (`type: 'collection'`, `mode: 'require'`)

Maps to `marketingCollectionID` on `artworksConnection`. When multiple values are selected, one is chosen randomly on each fetch. Medium and collection can be combined in a single query.

**Movements & Eras**: `contemporary`, `emerging-art`, `old-masters`, `fauvism`, `bauhaus`, `de-stijl`

**Curated**: `curators-picks`, `feminist-art`, `natural-abstraction`, `black-abstraction`, `contemporary-japanese-art`, `photojournalism`, `emerging-street-art`, `pioneers-of-street-art`

**By Color**: `black-and-white-artworks`, `blue-artworks`, `red-artworks`, `orange-artworks`, `yellow-artworks`, `neutral-artworks`

**By Region**: `american-artists`, `chinese-artists`, `german-artists`

### Search (`type: 'search'`, `mode: 'require'`)

Maps to the `keyword` parameter on `artworksConnection`. First value is used. Combinable with medium and collection filters.

Unlike the Google Arts `/api/search` endpoint, this filter is applied server-side by Artsy and returns works matching the keyword in title, artist name, or description. Pagination across sort orders still applies, so the accessible result pool is the full 60,000 positions (not a fixed result set).

### Artist (`type: 'artist'`, `mode: 'require'`)

Single-value (`inputStyle: 'search'`). The artist **name** is resolved to an Artsy slug via `resolveArtistSlug()` and passed as `artistID` on `artworksConnection`. Combinable with medium, collection, and search filters.

If the name cannot be resolved to a slug, the source logs a warning and **proceeds without the artist filter** rather than failing — an unresolvable name therefore silently widens results instead of returning none.

## Metadata Fields

| Key | Description |
|-----|-------------|
| `title` | Artwork title |
| `creator` | Artist name |
| `medium` | Material/technique (e.g. "Acrylic on Paper") |
| `dateCreated` | Date or year |
| `artworkUrl` | `https://www.artsy.net` + href |
| `partner` | Gallery or institution presenting the work |
| `price` | Listing price (e.g. "$6,600" or "Price on request") |
| `source` | Always "Artsy" |

## Image URLs

Images are served from Artsy's CloudFront CDN: `https://d32dm0rphc51dk.cloudfront.net/{hash}/normalized.jpg`

The `normalized` version is used (~1831×2048px). Other available versions (tested March 2026):
- `large`: ~572×640px
- `larger`: ~916×1024px
- `normalized`: ~1831×2048px ← used by this source

Aspect ratio is available from the API (`image.aspectRatio` float) — no post-download `sharp.metadata()` call needed.

## Artist search and metadata

### What this source implements

`suggestArtists(query, limit)` is exported and feeds the shared artist autocomplete in `utils/artistResolver.js`:

```graphql
{ searchConnection(query: "<query>", first: <n>, entities: [ARTIST]) {
    edges { node { displayLabel ... on Artist { slug } } } } }
```

It returns `{ name: displayLabel, slug, source: 'artsy' }` and seeds the slug cache as a side effect.

`resolveArtistSlug(name)` (internal, not exported) backs the artist filter. It prefers an exact case-insensitive `displayLabel` match and falls back to the first result.

| Cache | Key | TTL |
|-------|-----|-----|
| `_artistSuggestCache` | lowercased query | 1 hour |
| `_artistSlugCache` | lowercased artist name | 24 hours |

Artsy does **not** export `countArtistArtworks`, so it contributes no artwork counts to the artist counts breakdown.

**Gotcha:** `artistsConnection(keyword:)` returns HTTP 400. `searchConnection(entities: [ARTIST])` is the only working path for name→slug resolution.

### Available but unused: `artist(id:)`

Artsy exposes a full artist record this source never reads. Verified September 2026 against `artist(id: "pablo-picasso")`:

| Field | Example |
|-------|---------|
| `name` / `slug` | `Pablo Picasso` / `pablo-picasso` |
| `internalID` | `4d8b928b4eb68a1b2c0001f2` (Mongo hex) |
| `id` | base64 GraphQL global ID |
| `gender` | `male` |
| `birthday` / `deathday` | `1881` / `1973` |
| `nationality` | `Spanish` |
| `hometown` / `location` | `Malaga, Spain` / `Paris, France; Mougins, France` |
| `formattedNationalityAndBirthday` | `Spanish, 1881–1973` |
| `alternateNames` | often `null` |
| `blurb`, `biographyBlurb { text credit }` | editorial prose (markdown) |
| `counts { artworks forSaleArtworks follows articles partnerShows }` | `7261 / 1972 / 247661 / 91 / 857` |
| `genes { name }` | `Cubism`, `Spain`, `Painting`, … |

**Artist enrichment does not use Artsy.** Lifespan, nationality and description are sourced from Wikidata Q-IDs — see `docs/ENRICHMENT.md`.

Caveats before reaching for it:

- **No external identifiers.** No VIAF, ULAN, or Wikidata Q-ID, so cross-system linking still requires Wikidata.
- **Bios are Artsy editorial prose** with Artsy-relative markdown links (`[Cubism](/artist-series/...)`) — needs cleaning before reuse.
- **Marketplace-biased.** Strong on contemporary and for-sale artists, thinner on historical figures.
- GraphQL is all-or-nothing: one unknown field fails the whole query. (`similarArtists` does not exist; it is `partnerArtists`.)

### Disambiguation headroom

`searchConnection(entities: [ARTIST])` will also return `nationality`, `birthday`, `deathday` and `internalID` inline in the same request, but `suggestArtists` currently asks only for `displayLabel` and `slug`. Querying `monet`:

| displayLabel | nationality | dates |
|--------------|-------------|-------|
| Claude Monet | French | 1840–1926 |
| André Monet | Canadian | 1965– |
| Diane Monet | *(blank)* | — |

That is free, same-call disambiguation data for the shared-name problem described in `docs/ENRICHMENT.md`. Not yet wired up.

## fetchByIdentifier

Accepts `https://www.artsy.net/artwork/{slug}` URLs. Extracts the slug and queries the `artwork(id: slug)` GraphQL field.

## Notes

- All queries use `forSale: true` — only for-sale works are returned.
- `aspectRatioConstraint`: none — source returns both landscape and portrait works.
- The collection IDs in this file were verified March 2026. If a collection is removed by Artsy, queries against it will return 0 results (gracefully handled by retry logic).
