# Harvard Art Museums API

Three museums — the Fogg, the Busch-Reisinger, and the Arthur M. Sackler — share a common collection
of ~250,000 objects, roughly 225,000 of which have accessible images.
Official documentation: **https://docs.harvardartmuseums.org/**

---

## General

- **Base URL**: `https://api.harvardartmuseums.org`
- **Authentication**: Free API key required (UUID format). Request at https://docs.harvardartmuseums.org/
- **Rate limit**: 2,500 calls/day per key
- **Response format**: JSON with a `records` array and an `info` object (`{ totalrecords, pages, next, ... }`)
- **Scope**: ~250,000 objects; ~225,000 with `imagepermission=1`

### API Key

The key is sent as an `apikey` query parameter on every request. It is stored per-source
in the add-on settings (`web_sources → harvard_art_museums → settings.apiKey`) and passed
to the source module via `getExtraOptions`.

---

## Endpoints Used

### `GET /object`

Returns a paginated list of object records matching the given parameters.

**Key parameters:**

| Param | Value | Notes |
|-------|-------|-------|
| `apikey` | UUID string | Required on every request |
| `sort` | `random` | Returns a freshly shuffled page on each call |
| `hasimage` | `1` | Only objects with at least one image |
| `imagepermission` | `1` | Only images that can be displayed freely (open access) |
| `size` | integer | Records per page; our default is 10 (`BATCH_SIZE`) |
| `fields` | comma-separated | Requested fields (see below) |
| `classification` | string | Pipe-separated OR filter; e.g. `Paintings\|Drawings` |
| `culture` | string | Pipe-separated OR filter; e.g. `French\|Dutch` |
| `century` | string | Pipe-separated OR filter; e.g. `17th century\|18th century` |
| `keyword` | string | Full-text search across title, people, and description |

**Fields requested:** `id,title,people,technique,dated,primaryimageurl,width,height,url,classification,culture,century`

### `GET /object/{id}`

Fetch a single object by its numeric ID. Used by `fetchByIdentifier`.

---

## Image Access

`primaryimageurl` is a direct JPEG URL served by Harvard's NRS (Name Resolution Service),
e.g. `https://nrs.harvard.edu/urn-3:HUAM:DDC112459_dynmc`.  
Unlike IIIF servers, the URL does not support size suffix parameters — the full-size image
is always returned. Typical sizes are 1024–3000px on the long edge.

`width` and `height` fields in the API response give the pixel dimensions of the primary image.
These are used for pre-download aspect-ratio filtering (preferred path, avoids downloading
before rejecting). The post-download `sharp().metadata()` path is a fallback for records
where the API omits dimensions.

---

## Filters

### Classification (`media` filter type)

Controlled vocabulary string from the `classification` field. Our curated subset:

```
Paintings, Drawings, Prints, Photographs, Sculpture,
Works on Paper, Vessels, Textiles, Furniture and Woodwork,
Jewelry, Books and Manuscripts
```

The full list of classifications is available from `GET /classification?apikey=KEY`.
Multiple values are OR-combined in the API via the pipe separator.

### Culture (`culture` filter type)

Controlled vocabulary string from the `culture` field. Our curated subset covers major
cultural traditions in the collection:

```
American, British, Dutch, Flemish, French, German, Italian, Spanish,
Greek, Roman, Japanese, Chinese, Indian, Persian, Egyptian, African
```

The full list is available from `GET /culture?apikey=KEY`.

### Century (`century` filter type)

Controlled vocabulary from the `century` field, in the format `"Nth century"` or
`"Nth century BCE/CE"`. Our list spans 1st century BCE through the 21st century.

### Worktype (`worktype` filter type)

The `worktypes` field on each object record is an array of `{worktype, worktypeid}` objects.
`worktype` is more specific than `classification` — "Paintings" (classification) includes
any object with painted decoration, while `worktype: "Painting"` identifies objects that
are paintings in the traditional fine-art sense.

Both **require** and **exclude** are applied post-fetch against the object's `worktypes` array.
The Harvard `/object` endpoint has no `worktype` filter parameter, so this filter cannot be
pre-applied at the API level. With a strict worktype filter (e.g. `require: [Painting]`) the
retry loop may need more rounds to find matching objects.

Curated values (full list at `GET /worktype?apikey=KEY`):

```
Fine Art:        Painting, Drawing, Print, Illumination, Map, Poster
Photography:     Photograph
Sculpture:       Sculpture
Decorative Arts: Vessel, Textile, Furniture, Coin, Jewelry
Other:           Fragment
```

**Common use case**: when browsing the "Paintings" classification, add `worktype: exclude: [Fragment]`
to remove painted pottery shards and architectural fragments, or `worktype: require: [Painting]`
to get only traditional paintings.

### Artist / Search

Both use the `keyword` parameter, which searches across title, people, and description.
Artist takes priority over general search when both are present.
`countArtistArtworks` uses the same approach and returns `info.totalrecords`.

---

## Fetch Strategy

Rather than building an ID list (as the Met Museum source does), the Harvard source
uses `sort=random` to get a fresh random batch of `BATCH_SIZE` (10) objects per API call.
Each object in the batch is tried in shuffled order. If none pass the aspect-ratio filter,
another API call is made. Up to `MAX_ROUNDS` (5) calls are made before giving up —
50 candidates maximum, 5 API calls maximum per fetch.

This is quota-friendly: a normal shuffle costs 1 API call, a filtered shuffle costs
2–3 calls in the worst case. A household doing 10–20 shuffles/day will use <100 calls/day,
well within the 2,500/day limit.

---

## Known Limitations

- **Rate limit**: 2,500 calls/day is generous for personal use but could be tight for
  large households with very frequent shuffles or many test-fetches.
- **No thumbnail URL**: `primaryimageurl` always returns full-size. Search preview results
  use the full URL as the thumbnail (acceptable latency for the preview panel).
- **Rights restrictions**: Objects with `imagepermission` ≠ 1 are excluded by the API
  filter. This removes many 20th–21st century works whose images are rights-restricted.
- **Culture/century vocabulary**: Values must match the Harvard controlled vocabulary
  exactly. If a value doesn't match, the API returns no results for that term.
  The full reference lists are available from `/culture` and `/century` endpoints.
