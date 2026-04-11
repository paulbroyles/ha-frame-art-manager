# Art Institute of Chicago (AIC)

Collection: https://www.artic.edu/collection  
API docs: https://api.artic.edu/docs/

**Status: Implemented** (`sources/art_institute_chicago.js`)

---

## Overview

The AIC provides a well-documented public REST + Elasticsearch API with no authentication
required. ~58,574 artworks have publicly accessible images (all must have
`is_public_domain: true` — non-public-domain images return HTTP 400 from the IIIF server
regardless of `image_id` presence). High-resolution IIIF images available.

---

## API

### Base URL

```
https://api.artic.edu/api/v1
```

Required header for courtesy identification:
```
AIC-User-Agent: frame-art-manager/1.0 (github.com/paulbroyles/ha-frame-art-manager)
```

### Artwork search (Elasticsearch POST)

```
POST /artworks/search
Content-Type: application/json
```

```json
{
  "query": {
    "bool": {
      "filter": [
        { "term": { "is_public_domain": true } },
        { "exists": { "field": "image_id" } },
        { "term": { "artwork_type_title.keyword": "Painting" } }
      ]
    }
  },
  "size": 100,
  "sort": [{ "id": { "order": "asc" } }],
  "fields": ["id", "title", "image_id"],
  "_source": false
}
```

**Pagination limits:**
- `size` max: 100 (requests > 100 → HTTP 403)
- `from` max: 999 (requests ≥ 1000 → HTTP 403)
- `search_after` works for full deep pagination — pass the `id` of the last result

**Total public-domain artworks with images by type** (early 2026):

| Type | Count |
|------|------:|
| Print | 24,189 |
| Drawing and Watercolor | 7,567 |
| Textile | 5,809 |
| Photograph | 3,778 |
| Ceramics | 2,758 |
| Painting | 1,795 |
| Glass | 1,780 |
| Costume and Accessories | 1,737 |
| Vessel | 1,662 |
| Sculpture | 1,324 |
| Coin | 1,220 |
| Metalwork | 1,082 |
| **All types** | **58,574** |

### Per-artwork GET

```
GET /artworks/{id}?fields=id,title,artist_display,date_display,medium_display,dimensions,image_id,is_public_domain,department_title,artwork_type_title,place_of_origin,description,credit_line
```

**Key fields:**

| Field | Notes |
|-------|-------|
| `id` | Numeric ID |
| `title` | Artwork title |
| `artist_display` | Multi-line: name on line 1, nationality/lifespan on line 2 (e.g. "Claude Monet\nFrench, 1840–1926") |
| `date_display` | Human-readable date (e.g. "1884–86, border added 1888–89") |
| `medium_display` | Materials/technique (e.g. "Oil on canvas") |
| `dimensions` | Physical dimensions string |
| `image_id` | UUID for IIIF image server |
| `is_public_domain` | Boolean — only `true` items have accessible images |
| `department_title` | Curatorial department |
| `artwork_type_title` | Controlled vocabulary type |
| `place_of_origin` | Country/region of origin |
| `description` | HTML curatorial description (strip tags before use) |
| `credit_line` | Acquisition/gift credit |

### Artist search

```
GET /agents/search?q={name}&limit=10&fields=id,title,birth_date,death_date
```

Returns people, organizations, and institutions. Filter client-side to exclude
institutions (check for "museum", "collection", "gallery", etc. in title).

### Artwork keyword search

```
POST /artworks/search
{ "q": "monet", "query": { "bool": { "filter": [...] } }, "size": 12, "fields": [...] }
```

Combines full-text search with structured filters. Returns relevance-ranked results.

---

## Images (IIIF 2.1)

```
https://www.artic.edu/iiif/2/{image_id}/{region}/{size}/{rotation}/{quality}.{format}
```

**IIIF base:** `https://www.artic.edu/iiif/2`

**info.json:** `https://www.artic.edu/iiif/2/{image_id}/info.json`
Returns native `width` and `height` for precise bounding box requests.

**Bounding box for 4K display:**
```
https://www.artic.edu/iiif/2/{image_id}/full/!3840,2160/0/default.jpg
```

**Observed native resolutions** (sample):
- La Grande Jatte: 9310 × 6237 (native scan)
- At the Circus: 4851 × 5134

All tested artworks well exceed 4K resolution at native size. The IIIF `maxArea`
profile limit is 58,066,470 px² — requests larger than this are truncated. A
3840×2160 bounding box (8,294,400 px²) is well within the limit.

**Image access:** Only `is_public_domain: true` artworks have accessible IIIF images.
Non-public-domain `image_id` values return HTTP 400 from the IIIF server.

---

## Selection Strategy

The source uses a Wikidata-style **ID pool cache**:

1. At startup, a background task builds a pool of all public-domain artwork IDs
   for the default (no-filter) query using Elasticsearch `search_after` pagination.
   ~585 requests × 100 items = 58,574 IDs. At ~0.2s/request: ~2 minutes cold.
   The pool is shuffled and cached for 24 hours.

2. On each fetch: pick a random ID from the pool, fetch its metadata via GET,
   download the IIIF image.

3. If the pool isn't yet built (first fetch at startup): fall back to a random
   `from` offset in the first 1000 search results. This guarantees immediate
   availability at the cost of reduced coverage until the pool finishes.

4. Filter-specific pools (e.g. "Painting" only) are built on first request for
   that filter and cached separately.

**Why not random_score?**  
`random_score` in Elasticsearch always returns the highest-scoring documents first
regardless of seed when used with `boost_mode: replace` and no tiebreaker. Every
request returns the same top-N artworks (The Bedroom, La Grande Jatte, etc.).

**Why not GET endpoint with random page?**  
The GET endpoint supports unlimited pagination but cannot filter to public-domain
items — it returns all 131,565 artworks including those with inaccessible images.

---

## Filter Types

### Artwork Type (`type`)

Restrict or exclude by `artwork_type_title.keyword`. Exposed values:

| Value | Label | Count |
|-------|-------|------:|
| `Painting` | Paintings | 1,795 |
| `Print` | Prints | 24,189 |
| `Drawing and Watercolor` | Drawings & Watercolors | 7,567 |
| `Photograph` | Photographs | 3,778 |
| `Sculpture` | Sculpture | 1,324 |
| `Textile` | Textiles | 5,809 |
| `Ceramics` | Ceramics | 2,758 |
| `Miniature Painting` | Miniature Paintings | 228 |

Excludes types likely to produce poor results on a display (coins, armor, vessels,
furniture, etc.) while still exposing the full type list if users want it.

---

## Metadata Fields

| Source field | Suggested mapping | Notes |
|---|---|---|
| `title` | `title` | |
| `artist_display` line 1 | `artist` | Split on `\n` |
| `artist_display` line 2 | `creator_nationality` | "French, 1840–1926" format |
| `date_display` | `date` | Human-readable, may include date ranges |
| `medium_display` | `medium` | |
| `dimensions` | `dimensions` | |
| `credit_line` | `credit_line` | |
| `description` | `description` | HTML — strip tags |
| hardcoded | `museum` | Always "Art Institute of Chicago" |

**Not available:** creator lifespan separately (embedded in `artist_display` line 2),
nationality separately, creator nationality/lifespan as OEL-ready fields without parsing.

---

## Rate Limits & Terms

No documented rate limits. No `X-RateLimit-*` headers observed. The AIC asks that
callers identify themselves via `AIC-User-Agent` header (implemented).

Official API terms: https://api.artic.edu/docs/#licensing
Data is licensed CC0 for public-domain works. Images follow individual artwork rights.
