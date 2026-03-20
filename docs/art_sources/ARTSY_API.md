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

### Keyword (`type: 'keyword'`, `mode: 'require'`)

Maps to the `keyword` parameter. First value is used. Combinable with medium and collection.

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

## fetchByIdentifier

Accepts `https://www.artsy.net/artwork/{slug}` URLs. Extracts the slug and queries the `artwork(id: slug)` GraphQL field.

## Notes

- All queries use `forSale: true` — only for-sale works are returned.
- `aspectRatioConstraint`: none — source returns both landscape and portrait works.
- The collection IDs in this file were verified March 2026. If a collection is removed by Artsy, queries against it will return 0 results (gracefully handled by retry logic).
