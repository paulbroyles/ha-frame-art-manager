# Google Arts & Culture API — Reverse-Engineered Notes

This document captures everything learned about the unofficial Google Arts & Culture API through HAR capture and experimentation. The API has no public documentation.

---

## General

- **Base URL**: `https://artsandculture.google.com`
- **Authentication**: None — all endpoints are public GET requests
- **XSSI protection**: Every JSON response is prefixed with `)]}'\n`. Strip this before parsing.
- **Response format**: Deeply nested arrays (not objects). The outer structure is a Google "stella" framework response.
- **Framework**: Google's internal "stella" / BFF (Backend for Frontend) system. Entity IDs come from Google's Knowledge Graph (originally Freebase `/m/` IDs).

### Required headers

```
User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36
Accept-Language: en-US,en;q=0.9
Accept: application/json, text/plain, */*
```

The `rt=j` parameter appears in paginated calls from the browser and may be needed to get JSON (vs HTML) responses on some endpoints.

---

## Endpoints

### `GET /api/search`

Full-text search. Returns a fixed first page of results (~50–150 artworks) with no accessible pagination.

**Parameters:**
| Param | Value | Notes |
|-------|-------|-------|
| `q` | search string | Medium name, artist, subject, style, etc. |
| `hl` | `en` | Language |

**Pagination tokens**: The response contains base64url-encoded protobuf tokens at position `[8]` of each query sub-array. However, **no tested query parameter name causes the search endpoint to honor these tokens** (`token`, `cursor`, `pageToken`, `pt`, `st`, `npt`, etc. all return the same first page). POST requests return HTTP 405. The tokens appear to be intended for an internal pagination mechanism not exposed via the public URL.

**Result count**: Consistently returns the same ~56–144 artworks for any given query regardless of the actual total (which can exceed 66,000 for major mediums).

**Workaround for diversity**: Appending subject/style/period modifiers (e.g., `"oil paint portrait"`, `"watercolor landscape"`) shifts the result set substantially — empirically ~90%+ unique artworks compared to the base query. This is useful but not true randomness.

---

### `GET /api/entity`

Returns the entity page for a medium category — metadata plus the first ~15–30 artworks.

**Parameters:**
| Param | Value | Notes |
|-------|-------|-------|
| `entityId` | `m0jmpt` | Freebase ID with all slashes removed: `/m/0jmpt` → `m0jmpt` |
| `categoryId` | `medium` | Filter to medium category |
| `hl` | `en` | Language |
| `rt` | `j` | Response type (seen in browser HAR) |

This endpoint is mainly useful for verifying that an entity ID exists and corresponds to the expected medium.

---

### `GET /api/entity/assets`

**The key pagination endpoint.** Returns a page of artworks for a medium entity at a specified offset. This is what the browser calls as you scroll through a medium's gallery.

**Parameters:**
| Param | Value | Notes |
|-------|-------|-------|
| `entityId` | `/m/0jmpt` | Full Freebase ID, URL-encoded as `%2Fm%2F0jmpt` |
| `categoryId` | `medium` | |
| `s` | `18` | Page size (browser uses 18) |
| `pt` | `<token>` | Base64url-encoded protobuf pagination token (see below) |
| `hl` | `en` | |
| `rt` | `j` | |

**Offset limit**: The server returns HTTP 500 for offsets ≥ ~5,000, regardless of the entity's actual artwork count (which may be in the hundreds of thousands). The usable range is offset 0–4,800 (conservative safe bound).

---

## Response Structures

All responses begin with the XSSI prefix `)]}'\n` which must be stripped before JSON parsing. The JSON is a nested array — the stella framework uses positional arrays rather than named objects throughout.

### Top-level envelope

Every response is wrapped in an outer single-element array:

```
[
  <page_array>   // [0] The page content
]
```

The `<page_array>` itself is an array whose items depend on the endpoint (see below).

---

### `/api/search` — Search Page Response

```
parsed[0] = [
  [0]  "stella.sp"                          // type tag: search page
  [1]  "Search:<uuid>"                      // server-assigned query session ID
  [2]  "<query string>"                     // echoed query (e.g. "watercolor landscape")
  [3]  <stella.pr AssetsQuery>              // primary artworks (57–144 items typical)
  [4]  <stella.pr ExhibitsQuery>            // exhibits / curated stories (up to 60)
  [5]  null
  [6]  null
  [7]  [<cobject artists>, ...]             // matching artist entities (type 3), bare list
  [8]  [<cobject collections>, ...]         // matching collections/projects (type 16), bare list
  [9]  null
  [10] <stella.pr StreetViewAssetsQuery>    // street view assets (usually empty / null artworks)
  [11] null
  [12] null
  [13] <stella.pr PartnersQuery>            // partner institution results (often empty)
  [14] <stella.pr AssetsQuery>              // secondary assets query (often empty)
  [15] <stella.pr StoriesQuery>             // written stories (often empty)
]
```

---

### `/api/entity` — Entity Page Response

```
parsed[0] = [
  [0]  <stella.ep entity panel>             // entity metadata + first artwork page
  [1]  <status block>                       // response metadata
]
```

#### `stella.ep` Entity Panel (`parsed[0][0]`)

```
[
  [0]  "stella.ep"                          // type tag: entity page
  [1]  "Entity:<uuid>"                      // server-assigned entity instance ID
  [2]  "/m/0jmpt"                           // Freebase Knowledge Graph ID
  [3]  "medium"                             // category filter used in request
  [4]  "Canvas"                             // entity display name
  [5]  "//lh3.googleusercontent.com/..."   // hero image URL (protocol-relative)
  [6]  null
  [7]  [null, "<description text>"]         // short description from Getty/Grove Art
  [8]  ["© Grove Art / OUP", "<url>"]      // description attribution [source, url]
  [9]  <stella.pr EntityAssets>             // first page of artworks (15–30 items)
  [10] null
  [11] null
  [12] [["More mediums", [<cobjects>]]]     // related medium entities
  [13] null
  [14] null
  [15] null
  [16] "/time?em=m0jmpt&categoryId=medium"  // URL for timeline view of this medium
  [17] "/color?em=m0jmpt&categoryId=medium" // URL for color-based browsing of this medium
  [18] <knowledge panel>                    // Wikipedia-sourced description block
  [19] "/asset/<slug>/<id>"                 // featured artwork asset path
  [20] "Dance at Le Moulin de la Galette"   // featured artwork title
  [21] null
  [22] null
  [23] null
  [24] null
  [25] "en"                                 // language code
  [26] "Discover this medium"               // call-to-action label
  [27] "81738,60758,73836,..."              // comma-separated internal artwork ID list
  [28] null
  [29] true                                 // boolean flag (purpose unknown)
  [30] null
  [31] null
  [32] [[[["visual-arts", [<editorial items>]]]]]  // curated editorial highlights
]
```

#### Knowledge Panel (`stella.ep[18]`)

```
[
  [0]  "Canvas"                             // entity name
  [1]  "Canvas is an extremely durable..."  // Wikipedia summary (truncated with "...")
  [2]  "https://artsandculture.google.com/entity/canvas/m0jmpt"  // canonical entity URL
  [3]  ["https://lh3...", "https://lh3..."] // array of representative image URLs (https, not protocol-relative)
  [4]  "en"                                 // content language
  [5]  "Google Arts & Culture"              // source attribution
  [6]  [null×4, "<json-ld string>"]         // structured data; [4] is JSON-LD (schema.org WebPage)
  [7]  [["<url>?hl=en", "en"], ["<url>", "x-default"]]  // hreflang alternate URL list
]
```

---

### `/api/entity/assets` — Paginated Assets Response

```
parsed[0] = [
  [0]  <stella.pr EntityAssets>            // the requested page of artworks
  [1]  <status block>                      // response metadata
]
```

---

### `stella.pr` Query Block

Used in both search and entity responses to wrap a set of results.

```
[
  [0]  "stella.pr"                          // type tag: paginated results
  [1]  "<QueryType>:<uuid>"                 // query type + server-assigned ID
                                            //   e.g. "AssetsQuery:...", "EntityAssets:...",
                                            //        "ExhibitsQuery:...", "StoriesQuery:...",
                                            //        "StreetViewAssetsQuery:...", "PartnersQuery:..."
  [2]  [<cobject>, <cobject>, ...]          // result items (array of cobjects), or null if empty
  [3]  null
  [4]  <total_count>                        // integer: total matching items in the full dataset
                                            //   (not the number returned — e.g. 77966 for canvas)
  [5]  null
  [6]  null
  [7]  [[[[[<layout hints>]]]]]            // nested integer arrays: server-suggested card layout ordering
                                            //   groups of indices indicating display arrangement
  [8]  "<pt token>"                         // next-page pagination token (base64url protobuf),
                                            //   absent or null when no more pages exist
]
```

---

### `stella.common.cobject` — Content Object

The universal content object used for artworks, artists, exhibits, collections, and related entities. All responses use this same type with varying field populations depending on content type.

```
[
  [0]  "stella.common.cobject"              // type tag (always present)
  [1]  "<title>"                            // primary label:
                                            //   artwork: title of the work
                                            //   artist: artist name
                                            //   exhibit/collection: exhibit title or collection name
                                            //   related medium: medium name
  [2]  "<subtitle>"                         // secondary label or null:
                                            //   artwork: artist/creator name
                                            //   artist: null
                                            //   collection: description/tagline
                                            //   related medium: item count string (e.g. "1,119 items")
  [3]  "//lh3.googleusercontent.com/..."   // thumbnail image URL (protocol-relative)
                                            //   append sizing params to construct full URL (see below)
  [4]  "/<type>/<slug>/<id>"               // canonical path; determines content type:
                                            //   "/asset/..."    → artwork
                                            //   "/entity/..."   → artist or medium entity
                                            //   "/story/..."    → exhibit or written story
                                            //   "/project/..."  → themed collection
                                            //   "/streetview/..." → street view location
  [5]  <type_code>                          // integer content type discriminator:
                                            //   1  = unknown/generic
                                            //   3  = artist / person entity
                                            //   8  = artwork asset (main type used here)
                                            //   12 = related medium / material entity
                                            //   16 = themed collection / project
                                            //   29 = exhibit / curated story
                                            //   (other values observed but not fully mapped)
  [6]  null
  [7]  null
  [8]  "#rrggbb"                            // dominant color hex string — artworks only; null otherwise
  [9]  null
  [10] <image metadata>                     // sub-array for artworks (type 8); null for other types
  [11] null
  [12] null                                 // for exhibit cobjects: [null, null, null, null, <microscopeimage>]
  [13] null
  [14] null
  [15] null
  [16] null
  [17] null
  [18] null
  [19] null
  [20] null
  [21] [<ref_type>, "<id>"]                // reference tuple:
                                            //   ref_type 1 = asset (artwork)
                                            //   ref_type 2 = project (collection)
                                            //   ref_type 4 = story (exhibit)
                                            //   id matches the final path segment of [4]
  [22] null                                 // (present on artist and collection cobjects)
  [23] null                                 // (present on artist and collection cobjects)
  [24] ["/m/<freebase_id>"]               // entity ID array — artist and medium cobjects only;
                                            //   null for artwork cobjects
  ...  null×N                              // trailing nulls; total length varies by content type
                                            //   artworks: 22 fields
                                            //   artists: 25 fields
                                            //   collections: 36 fields
]
```

#### Image Metadata Sub-array (`cobject[10]`) — Artworks Only

```
[
  [0]  "<asset_id>"                         // asset ID string, same as the final path segment of cobject[4]
                                            //   e.g. "4AHFtRqeObzoRw" from "/asset/stańczyk-.../4AHFtRqeObzoRw"
  [1]  <aspect_ratio>                       // float: width ÷ height (e.g. 1.348 for a landscape image)
  [2]  null
  [3]  null
  [4]  null
  [5]  null
  [6]  null
  [7]  null
  [8]  null
  [9]  "<crop_coords>"                      // comma-separated integers, or null
                                            //   pairs of pixel coordinates for subject/face regions
                                            //   e.g. "3118,2313,1449,1741,483,822" = (x,y) pairs
  [10] <boolean>                            // false in all observed cases; purpose unknown
  [11] null
  [12] "<institution>"                      // museum or institution name string
                                            //   e.g. "Tate Britain", "The National Museum in Warsaw"
]
```

---

### Status Block (`"e"`)

Appears as the last item in the top-level page array for all endpoints.

```
[
  [0]  "e"                                  // type tag
  [1]  2                                    // protocol/format version (always 2)
  [2]  null
  [3]  null
  [4]  <response_size>                      // integer: total response size in bytes
]
```

---

## Image URL Construction

Thumbnail image URLs in the API are protocol-relative and require a sizing suffix:

```
https:{cobject[3]}=<size_params>
```

**Common size parameter formats:**

| Format | Description |
|--------|-------------|
| `=w3840-h2160-c` | 3840×2160, center-cropped (used in this project) |
| `=w1920-h1080-c` | 1920×1080, center-cropped |
| `=s800` | 800px on longest side, aspect preserved |
| `=w800-h600` | fit within 800×600, aspect preserved |
| `=w800-h600-c` | 800×600, center-cropped |

The image server (`lh3.googleusercontent.com`) accepts arbitrary dimensions. Appending `-c` enables center-cropping to the exact requested dimensions.

---

## Pagination Token (`pt`) Format

The `pt` parameter is a minimal protobuf message, base64url-encoded (no padding).

### Structure

```
field 1 (wire type 2, length-delimited):
  sub-message:
    field 1 (wire type 0, varint): <offset>
```

### Encoding

```
token_bytes = 0x0a                    # tag byte: field 1, wire type 2
            + varint(len(sub_message))
            + 0x08                    # tag byte: field 1, wire type 0
            + varint(offset)

pt = base64url(token_bytes)           # URL-safe base64, no padding (- and _ instead of + and /)
```

### Examples

| Offset | Token |
|--------|-------|
| 0 | `CgIIAA` |
| 15 | `CgIIDw` |
| 100 | `CgIIZA` |
| 500 | `CgMI9AM` |
| 1000 | `CgMI6Ac` |
| 4800 | `CgMIwBU` |

### Full browser-generated token structure

Browser-generated tokens from HAR captures also include a `field 4` sub-message with server cursor state:

```
field 1 (bytes): varint(current_offset)
field 4 (bytes):
  field 1 (bytes):
    field 1 (varint): 1
    field 2 (bytes):
      field 1 (varint): 0
      field 2 (varint): current_offset - 1    // previous position (0-based)
      field 3 (bytes):
        field 2 (varint): <server_value>       // opaque per-page server value, varies
```

This `field 4` is **optional** — the server accepts tokens containing only `field 1`. The minimal single-field token is sufficient for arbitrary offset jumps and was verified working for offsets 0–4,999.

---

## Known Medium Entity IDs

All 203 unique art medium entities accessible on `artsandculture.google.com/category/medium`, identified by Google/Freebase Knowledge Graph IDs. Discovered via BFS through the "related mediums" links (`stella.ep[12]`) returned by `/api/entity` for each medium, seeded from the canvas entity. Item counts reflect the API's `stella.pr[4]` total at time of discovery.

### Entity ID formats by endpoint

- `/api/entity` (initial load): strip all slashes → `m0jmpt`
- `/api/entity/assets` (pagination): full ID, URL-encoded → `%2Fm%2F0jmpt`

### Full medium table

#### Paints & pigments

| Medium | Entity ID | Items |
|--------|-----------|------:|
| oil paint | `/m/031cgw` | 96,746 |
| watercolor painting | `/m/018ktp` | 71,108 |
| pigment | `/m/0d5pz` | 44,089 |
| dye | `/m/028qp` | 21,107 |
| acrylic paint | `/m/011lx` | 25,049 |
| vitreous enamel | `/m/01tp42` | 15,377 |
| gouache | `/m/0j12g` | 14,915 |
| tempera | `/m/07mtr` | 14,818 |
| varnish | `/m/01ffcg` | 9,272 |
| lacquer | `/m/01fn7d` | 6,041 |
| distemper | `/m/027cnnk` | 3,881 |
| oil pastel | `/m/04wbc_` | 2,758 |
| cochineal | `/m/01jq68` | 447 |
| cinnabar | `/m/0f0b7` | 258 |
| encaustic painting | `/m/0cjhq` | 258 |
| spray painting | `/m/02kzxb` | 13,294 |
| azurite | `/m/02by5g` | 102 |

#### Drawing media

| Medium | Entity ID | Items |
|--------|-----------|------:|
| ink | `/m/03yhk` | 193,021 |
| graphite | `/m/037vk` | 111,418 |
| drawing | `/m/02csf` | 47,152 |
| pen | `/m/0k1tl` | 29,798 |
| pencil | `/m/063w2` | 23,690 |
| charcoal | `/m/0c3yk` | 25,403 |
| chalk | `/m/0c5q8` | 10,942 |
| colored pencil | `/m/03q7mr3` | 9,729 |
| crayon | `/m/0ckdv` | 8,262 |
| conté | `/m/03qz2_` | 3,561 |
| sanguine | `/m/03bxb3w` | 3,430 |
| india ink | `/m/03yjs` | 2,915 |

#### Printmaking

| Medium | Entity ID | Items |
|--------|-----------|------:|
| engraving | `/m/0gc80` | 80,512 |
| etching | `/m/03q7qln` | 47,527 |

#### Paper & supports

| Medium | Entity ID | Items |
|--------|-----------|------:|
| photograph | `/m/068jd` | 327,077 |
| canvas | `/m/0jmpt` | 77,966 |
| photographic paper | `/m/01d07t` | 77,402 |
| paper negative | `/m/08bghl` | 19,635 |
| laid paper | `/m/0270pz1` | 18,551 |
| cardboard | `/m/03q7pgh` | 17,455 |
| vellum | `/m/07z2_` | 9,741 |
| rice paper | `/m/025s1d` | 6,492 |
| masonite | `/m/044_hq` | 6,691 |
| tracing paper | `/m/0c676r` | 3,659 |
| calotype | `/m/0kybl` | 1,609 |
| book | `/m/0bt_c3` | 12,563 |

#### Metals

| Medium | Entity ID | Items |
|--------|-----------|------:|
| metal | `/m/04t7l` | 238,338 |
| gold | `/m/025rs2z` | 71,584 |
| silver | `/m/025sf8x` | 56,002 |
| bronze | `/m/01brf` | 35,988 |
| iron | `/m/025rw19` | 26,964 |
| copper | `/m/025rsfk` | 20,485 |
| gold leaf | `/m/03q7p6c` | 21,954 |
| brass | `/m/01504` | 12,299 |
| steel | `/m/06qqb` | 10,636 |
| foil | `/m/02vk7kj` | 8,506 |
| tin | `/m/025sk5n` | 4,373 |
| lead | `/m/025r_0t` | 3,965 |
| sterling silver | `/m/01g8vd` | 3,462 |
| wire | `/m/083kv` | 3,161 |
| aluminium | `/m/027vj2v` | 2,830 |
| neon | `/m/025s4r0` | 2,362 |
| cobalt | `/m/025tkrf` | 2,254 |
| cast iron | `/m/0_1c0` | 1,942 |
| stainless steel | `/m/06qqv` | 1,454 |
| pewter | `/m/0gd79` | 1,432 |
| platinum | `/m/025s7y2` | 1,382 |
| nickel | `/m/025s4r7` | 985 |
| wrought iron | `/m/0pf1p` | 998 |
| sheet metal | `/m/0586q3` | 948 |
| zinc | `/m/025sqz8` | 659 |
| manganese | `/m/025s0zp` | 428 |
| chromium | `/m/025tkr6` | 224 |
| mercury | `/m/025sw5g` | 124 |
| titanium | `/m/025sk56` | 55 |

#### Stone

| Medium | Entity ID | Items |
|--------|-----------|------:|
| rock | `/m/01cbzq` | 164,405 |
| marble | `/m/04tdh` | 23,735 |
| limestone | `/m/04hgv` | 6,063 |
| granite | `/m/03fcm` | 3,485 |
| sandstone | `/m/06xky` | 2,511 |
| soapstone | `/m/0c5l2` | 1,802 |
| alabaster | `/m/0pj6` | 1,461 |
| travertine | `/m/01khnr` | 638 |
| flint | `/m/0byhp` | 544 |
| basalt | `/m/0bxps` | 496 |
| quartzite | `/m/029zr1` | 338 |
| schist | `/m/0bxnh` | 318 |
| slate | `/m/0c1ml` | 321 |
| andesite | `/m/01pxwx` | 193 |
| diorite | `/m/02943b` | 181 |
| obsidian | `/m/05pjv` | 168 |
| carrara marble | `/m/0hzplp5` | 279 |
| parian marble | `/m/05vx0v` | 257 |
| pavonazzo marble | `/m/0b6lgbk` | 15 |
| pebble | `/m/01tp0c` | 91 |

#### Ceramics & clay

| Medium | Entity ID | Items |
|--------|-----------|------:|
| clay | `/m/0975t` | 109,489 |
| ceramic | `/m/01x5q` | 64,105 |
| stoneware | `/m/03q7p08` | 25,284 |
| porcelain | `/m/016f4d` | 26,258 |
| pottery | `/m/064rk` | 14,687 |
| terracotta | `/m/017jcd` | 13,387 |
| plaster | `/m/01w_gm` | 17,906 |
| faience | `/m/02bnj5` | 5,194 |
| stucco | `/m/033nbz` | 5,963 |
| concrete | `/m/01mxf` | 5,391 |
| brick | `/m/01g0g` | 7,616 |
| biscuit porcelain | `/m/06w9k4` | 1,634 |
| lustreware | `/m/05pg1b` | 968 |

#### Glass

| Medium | Entity ID | Items |
|--------|-----------|------:|
| glass | `/m/039jq` | 52,486 |
| stained glass | `/m/011y23` | 4,202 |
| resin | `/m/0g27n` | 5,282 |
| crystal | `/m/01t4h` | 2,863 |
| lead glass | `/m/02x31v` | 2,268 |
| fiberglass | `/m/014qy5` | 1,099 |
| milk glass | `/m/07w219` | 84 |
| murano glass | `/m/0ftc03` | 45 |

#### Textiles

| Medium | Entity ID | Items |
|--------|-----------|------:|
| textile | `/m/0dnr7` | 109,315 |
| silk | `/m/0dl6q` | 45,219 |
| cord | `/m/0b2t53` | 8,990 |
| lace | `/m/0m95s` | 8,974 |
| cotton | `/m/095zt` | 17,446 |
| wool | `/m/09kxp` | 14,334 |
| linen | `/m/0fkqd` | 11,479 |
| yarn | `/m/02kvytt` | 6,913 |
| velvet | `/m/011ljn` | 7,928 |
| satin | `/m/02xhmrh` | 4,304 |
| brocade | `/m/026c1s9` | 2,683 |
| felt | `/m/0158y_` | 2,105 |
| muslin | `/m/01cgyj` | 1,611 |
| hessian fabric | `/m/06w8z_` | 1,119 |
| rope | `/m/01xc8d` | 1,387 |
| twill | `/m/02xhmpq` | 929 |
| taffeta | `/m/080j18` | 904 |
| mohair | `/m/0175vp` | 875 |
| damask | `/m/04m908` | 767 |
| chiffon | `/m/08h11d` | 530 |
| gauze | `/m/0bzzvg` | 480 |
| jute | `/m/01xj7m` | 431 |
| chintz | `/m/06f_6h` | 133 |

#### Wood

| Medium | Entity ID | Items |
|--------|-----------|------:|
| wood | `/m/083vt` | 92,678 |
| walnut | `/m/015_77` | 3,331 |
| oak | `/m/09wzt` | 2,894 |
| pine | `/m/09t57` | 1,679 |
| mahogany | `/m/0c7cd` | 1,573 |
| ebony | `/m/0194pb` | 1,146 |
| beech | `/m/015_vx` | 712 |
| spruce | `/m/016x44` | 697 |
| maple | `/m/0cffdh` | 792 |
| tulipwood | `/m/07_yv6` | 437 |
| olive | `/m/03l9pw` | 338 |
| birch | `/m/0hpx4` | 356 |
| fir | `/m/016x4z` | 235 |
| eucalyptus | `/m/0d7gy` | 213 |
| teak | `/m/01s5tq` | 217 |
| cherry | `/m/0f8sw` | 291 |
| willow | `/m/0mw_6` | 93 |

#### Plastic & synthetic

| Medium | Entity ID | Items |
|--------|-----------|------:|
| plastic | `/m/05z87` | 59,854 |
| polyester | `/m/09hb3s` | 1,964 |
| natural rubber | `/m/09kmv` | 1,924 |
| acrylic resin | `/m/0d665k` | 2,669 |
| epoxy | `/m/01f0y0` | 1,288 |
| polystyrene | `/m/016jr1` | 783 |
| polycarbonate | `/m/02mqs4` | 729 |
| nylon | `/m/05d6r` | 752 |
| polypropylene | `/m/01cnhn` | 336 |
| polyurethane | `/m/0cym6` | 316 |
| bakelite | `/m/01fnt` | 327 |
| celluloid | `/m/0psq1` | 161 |
| polyethylene | `/m/0k8xc` | 124 |
| formica | `/m/02p9fd` | 19 |

#### Gemstones & minerals

| Medium | Entity ID | Items |
|--------|-----------|------:|
| gemstone | `/m/03c4j` | 20,026 |
| jade | `/m/01b5dy` | 7,345 |
| quartz | `/m/069p0` | 3,445 |
| pearl | `/m/05_8m` | 3,322 |
| nacre | `/m/0237xf` | 2,479 |
| nephrite | `/m/025rpbz` | 2,157 |
| turquoise | `/m/0fgkh` | 1,279 |
| diamond | `/m/027_y` | 1,073 |
| agate | `/m/0qjx` | 962 |
| jasper | `/m/0k059` | 590 |
| jadeite | `/m/03w1p7` | 574 |
| lapis lazuli | `/m/0c51n` | 567 |
| emerald | `/m/02qv1` | 488 |
| garnet | `/m/09bz0` | 684 |
| hematite | `/m/03pf1` | 449 |
| amber | `/m/0pbc` | 610 |
| onyx | `/m/01s85q` | 424 |
| amethyst | `/m/0p7h` | 383 |
| sapphire | `/m/0797j` | 267 |
| feldspar | `/m/09ghj` | 206 |
| malachite | `/m/01zn3_` | 203 |
| jet | `/m/02qkkn` | 139 |
| topaz | `/m/07qmk` | 88 |

#### Other natural materials

| Medium | Entity ID | Items |
|--------|-----------|------:|
| ivory | `/m/03xgl` | 8,931 |
| bone | `/m/01b92` | 12,441 |
| leather | `/m/04lbp` | 11,506 |
| wax | `/m/0fy__` | 1,790 |
| bark | `/m/016v85` | 1,423 |
| leaf | `/m/09t49` | 1,724 |
| tooth | `/m/0cnxs6x` | 920 |
| tusk | `/m/01n_j_` | 779 |
| cork | `/m/0k1ps` | 272 |
| beeswax | `/m/0bxq8` | 151 |
| root | `/m/0flg6` | 118 |

#### Other media

| Medium | Entity ID | Items |
|--------|-----------|------:|
| sculpture | `/m/06msq` | 28,774 |
| adhesive | `/m/0z49` | 4,485 |
| rhinestone | `/m/04wy1k` | 950 |
| adobe | `/m/0h_4` | 15 |

### Missing / not found

The following mediums do not appear to have accessible entity pages (return HTTP 404):

- Oil painting (as technique): `/m/05nmd` → 404
- Fresco (no working Freebase ID found)
- Pastel: `/m/0642x` → 404
- Ink wash painting: `/m/01d0jv` → 404
- Panel painting: `/m/06pc6w` → 404

### Discovery method

The category page at `artsandculture.google.com/category/medium/<slug>` is a JavaScript SPA and returns no embedded entity ID in the HTML (~1.6KB shell). The 203 entities above were discovered via BFS through the "related mediums" graph (`stella.ep[12]`) in the `/api/entity` response, seeded from the canvas entity (`/m/0jmpt`). The Wikidata SPARQL endpoint (`query.wikidata.org`, `wdt:P646`) can map Freebase IDs for art medium items, but not all Freebase IDs are indexed in Google Arts & Culture.

---

## What Does Not Work

- **POST requests** to any endpoint → HTTP 405
- **Pagination via search endpoint** → same first page regardless of `token`, `cursor`, `pageToken`, `pt`, `page`, `start`, `offset`, `npt`, or `st` query params
- **Name-based entity lookup** → `/api/entity?entityId=oil-paint` → HTTP 400 (requires Freebase ID)
- **Offsets ≥ 5000** on `/api/entity/assets` → HTTP 500
- **Category page scraping** → SPA, HTML is ~1.6KB shell with no embedded data

---

## Randomness Strategy

Given the above constraints, true uniform randomness is not achievable across an entity's full artwork count (e.g., 96,000+ for oil paint). The accessible window is the first ~5,000 artworks in whatever order the API serves them.

The implemented approach in `sources/google_arts.js`:

1. Pick a random entity from `MEDIUM_ENTITIES` (203 unique entities)
2. Compute `maxOffset = min(ENTITY_MAX_OFFSET, entity.total - 18)` to avoid HTTP 500 on small collections
3. Pick a random integer offset in `[0, maxOffset)`
4. Construct a minimal `pt` token encoding that offset
5. Call `/api/entity/assets` with `s=18` to get up to 18 artworks
6. Pick a random artwork from the page

This gives access to a large and diverse pool of artworks across all 203 medium categories. Mediums with fewer than 18 artworks (e.g., pavonazzo marble with 15, adobe with 15) will always return offset 0 but are still valid. The approach is a significant improvement over the original which always drew from the same fixed ~144-artwork pool returned by `/api/search`.
