# Metropolitan Museum of Art — Open Access API

The Met provides a fully documented, publicly accessible REST API with no authentication required. Official documentation: **https://metmuseum.github.io/**

---

## General

- **Base URL**: `https://collectionapi.metmuseum.org/public/collection/v1`
- **Authentication**: None required
- **Rate limit**: 80 requests/second
- **Response format**: Standard JSON objects with named fields (unlike Google Arts & Culture's positional arrays)
- **Scope**: 470,000+ objects total; ~3,260 with publicly accessible, public-domain images

---

## Endpoints Used

### `GET /search`

Full-text search over the Met's collection. Returns a list of matching object IDs.

**Parameters:**

| Param | Value | Notes |
|-------|-------|-------|
| `q` | search string | `*` acts as a wildcard matching all objects |
| `hasImages` | `true` | Restricts to objects with an accessible image |
| `medium` | classification string | Filters by `classification` field (see below) |

**Response:**

```json
{
  "total": 3261,
  "objectIDs": [436524, 437984, ...]
}
```

- `total` — count of matching objects
- `objectIDs` — array of integer object IDs; may be `null` if no results

**Important distinctions — `medium` vs `classification`:**

The `medium=` query parameter filters by the object's `classification` field, not by its `medium`
field. These are different:

- `classification` — a controlled vocabulary term for the object's type (e.g., `"Paintings"`,
  `"Prints"`, `"Ceramics-Porcelain"`). This is what `medium=` filters on.
- `medium` — a free-text description of the physical materials used (e.g., `"Oil on canvas"`,
  `"Etching and aquatint"`). This field is returned in the object detail response for display
  purposes.

**Multi-value `medium=` behavior:**

Pipe-delimited values in `medium=` act as AND (intersection), not OR. To select objects matching
any one of several classifications, each classification must be queried separately and the results
unioned. This is what `fetchRandomArtwork` does when called with a `mediaFilter` array.

**`q=*` wildcard:**

`q=*` matches all objects. With `hasImages=true`, this returns the ~3,260 public-domain objects
that have accessible images. Without `hasImages=true`, it returns 530,000+ objects — the vast
majority of which have no accessible image, making random selection impractical (the retry loop
would need hundreds of attempts on average to find a valid image).

---

### `GET /objects/{objectId}`

Returns full metadata for a single object by its integer ID.

**Response (selected fields):**

| Field | Type | Description |
|-------|------|-------------|
| `objectID` | integer | Unique identifier |
| `title` | string | Artwork title |
| `artistDisplayName` | string | Primary creator's display name (empty string if unknown) |
| `medium` | string | Free-text materials description (e.g., `"Oil on canvas"`) |
| `objectDate` | string | Free-text date (e.g., `"1881"`, `"ca. 1650–1660"`) |
| `classification` | string | Controlled vocabulary type (e.g., `"Paintings"`) |
| `isPublicDomain` | boolean | Whether the object's image is in the public domain |
| `primaryImage` | string | Direct URL to the primary image (JPEG, typically high-res); empty string if unavailable |
| `primaryImageSmall` | string | URL to a smaller version of the primary image |
| `objectURL` | string | Canonical URL on metmuseum.org for the object page |
| `department` | string | Curatorial department (e.g., `"European Paintings"`) |
| `culture` | string | Culture of origin (e.g., `"French"`, `"Chinese"`) |
| `period` | string | Historical period (e.g., `"Edo period"`) |

Full field reference: https://metmuseum.github.io/#object

---

## Classification System

The Met's controlled vocabulary uses a hierarchical naming scheme with hyphens (e.g.,
`"Ceramics-Porcelain"`, `"Textiles-Woven"`). Sub-classifications nest under their parent with a
hyphen delimiter. The user-visible category names in this project's settings dialog map to groups
of these classification values:

| User category | Classification values passed to `medium=` |
|---------------|------------------------------------------|
| Paintings | `Paintings` |
| Drawings | `Drawings` |
| Prints | `Prints` |
| Watercolors | `Watercolors` |
| Miniatures | `Miniatures` |
| Photographs | `Photographs` |
| Sculpture | `Sculpture`, `Sculpture-Wood`, `Sculpture-Architectural`, `Stone-Sculpture`, `Wood-Sculpture`, `Bronzes`, `Terracottas` |
| Ceramics | `Ceramics`, `Ceramics-Porcelain`, `Ceramics-Pottery`, `Vases` |
| Glass | `Glass`, `Glass-Stained`, `Glass-Vessels` |
| Textiles | `Textiles`, `Textiles-Woven`, `Textiles-Embroidered`, `Textiles-Printed`, `Textiles-Velvets`, `Textiles-Laces`, `Tapestries` |
| Metalwork | `Metalwork`, `Metalwork-Silver`, `Metalwork-Copper alloy`, `Metalwork-Iron`, `Metalwork-Gilt Bronze`, `Gold and Silver`, `Medals and Plaquettes` |
| Jewelry | `Jewelry`, `Gems` |

These mappings are defined in `CLASSIFICATION_EXPANSIONS` in `sources/met_museum.js`. Multiple
classifications per category are necessary because the Met's data uses both parent-level and
sub-classification values inconsistently across objects.

---

## Randomness Strategy

Unlike the Google Arts & Culture API, the Met's `/search` endpoint returns the **full list of
matching object IDs** in a single response — not a page. This makes uniform random selection
straightforward:

1. Call `/search?q=*&hasImages=true` (with optional `medium=` filters)
2. Receive the complete set of matching object IDs (a few hundred to ~3,260)
3. Pick a random ID from the list
4. Fetch the full object via `/objects/{objectId}`
5. Verify `isPublicDomain=true` and `primaryImage` is non-empty (belt-and-suspenders; `hasImages=true` should already ensure this)
6. Download the image from `primaryImage` directly

Up to 5 attempts are made per fetch in case a randomly selected object fails validation or its
image URL is unreachable.

This is simpler than the Google Arts strategy (which requires offset-based pagination token
construction) because the Met API provides a complete, enumerable result set per query.

**Result set sizes (approximate, all with `hasImages=true`):**

| Filter | Approx. results |
|--------|----------------|
| No filter (`q=*`) | ~3,260 |
| Paintings only | ~1,800 |
| Photographs only | ~400 |
| Sculpture | ~200–400 (across all sub-classifications) |
| Decorative Arts (all) | ~500 |

---

## Image Access

`primaryImage` is a direct JPEG URL hosted by the Met (typically on `images.metmuseum.org`). No
additional URL construction is required — unlike the Google Arts API where thumbnail URLs need a
sizing suffix appended.

Images are typically high-resolution (2,000–5,000px on the long axis). The Met provides them
under a Creative Commons Zero (CC0) license for public-domain objects.

---

## What Does Not Work

- **`medium=` with pipe-delimited values** — treated as AND (intersection), not OR. Use separate
  requests and union the results.
- **Pagination of `/search` results** — the full result set is returned in one response; there is
  no page-based pagination for search results (the `objectIDs` array is complete).
- **Objects with `isPublicDomain=false`** — `primaryImage` is an empty string for these even if
  the object exists; they are unusable.