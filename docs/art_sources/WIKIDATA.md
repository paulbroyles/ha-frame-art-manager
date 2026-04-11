# Wikidata

Wikidata is a free, collaborative knowledge base maintained by the Wikimedia Foundation. It holds
structured metadata for hundreds of thousands of artworks, with references to image files hosted
on Wikimedia Commons (via the P18 property). This source uses the Wikidata SPARQL endpoint to
fetch artworks by structured attributes — art movement, genre, collection, century, and creator —
rather than by filename or category membership.

The result quality is significantly better than Wikimedia Commons: Wikidata records describe
*specific artworks* with well-typed properties, so there is no noise from photos of people
painting, in-situ mural photographs, or amateur uploads.

No API key required. Wikidata and Wikimedia Commons policy requires a descriptive User-Agent
header on all requests.

---

## API

- **SPARQL endpoint**: `https://query.wikidata.org/sparql`
- **Entity search**: `https://www.wikidata.org/w/api.php?action=wbsearchentities`
- **Authentication**: None
- **Rate limit**: No published rate limit; Wikidata requests a max query timeout of 60s per query
- **Image access**: P18 value is a `Special:FilePath` URL that redirects to `upload.wikimedia.org`

---

## Fetch Strategy: QID Pool Caching

Wikidata SPARQL's `OFFSET` operator scales linearly with offset size — at offset 50,000, queries
take 12–33 seconds. This makes offset-based random access unusable for large result sets.

Instead, the source uses a **QID pool caching** approach:

1. **Pool query**: Fetch up to 10,000 item QIDs matching the current filter combination. Store in
   memory. Query selects `?item` only (no labels) for maximum throughput.
   - Pool TTL: 6 hours
   - Pool size: up to `POOL_MAX_SIZE=10000`
   - Small filtered pools (e.g. Impressionism: ~466 items) fetch all items in ~0.6s
   - Large unfiltered pool (all paintings: ~400K items, 10K returned): fetches in ~10s

2. **Random selection**: Pick a random QID from the cached pool on each fetch request.

3. **Detail query**: Fast single-item SPARQL lookup (~0.07s) for the selected QID, fetching
   title, creator, date, movement, genre, collection, and image URL.

4. **Image download**: Direct download from the P18 `Special:FilePath` URL (follows redirect
   to `upload.wikimedia.org`).

### Pool warmup

The module warms up the default pool (all paintings, no filters) at startup. The first fetch
after a cold start pays the ~10s pool query cost; subsequent fetches hit the cache.

---

## Filters

All filters are applied server-side in the SPARQL pool query, not post-fetch.

### Media Type (`media`)

Maps to P31 (instance of). Defaults to paintings when unset.

| Value | Wikidata QID |
|---|---|
| Paintings | Q3305213 |
| Drawings | Q93184 |
| Prints | Q11060274 |
| Photographs | Q125191 |
| Sculptures | Q860861 |
| Watercolors | Q18761202 |
| Miniature paintings | Q2647254 |

Modes: **require**

### Art Movement (`movement`)

Maps to P135 (movement). Requires exact movement membership in Wikidata — works must
have this property set. Less comprehensive than genre but very precise.

| Value | QID |
|---|---|
| Baroque | Q37853 |
| Romanticism | Q37068 |
| Realism | Q578597 |
| Impressionism | Q40415 |
| Post-Impressionism | Q207280 |
| Dutch Golden Age | Q1380327 |
| Renaissance | Q4692 |
| Rococo | Q39979 |
| Neoclassicism | Q33216 |
| Mannerism | Q1640824 |
| Symbolism | Q42196 |
| Art Nouveau | Q34636 |
| Expressionism | Q80113 |
| Fauvism | Q153178 |
| Cubism | Q36534 |
| Futurism | Q47041 |
| Surrealism | Q39427 |
| Abstract art | Q128115 |
| Pre-Raphaelitism | Q182719 |
| Japonisme | Q130277 |

Modes: **require**

**Approximate pool sizes** (paintings with P18, verified 2026-04-10):
- Impressionism: ~466 items
- Baroque: ~2,100 items
- Dutch Golden Age: ~3,800 items
- Romanticism: ~800 items

Movement coverage in Wikidata is incomplete — many paintings have no P135 value. For broader
coverage use genre (P136) or combine movement with institution filters.

### Genre (`genre`)

Maps to P136 (genre). Genre is more broadly assigned than movement.

| Value | QID | Approx size |
|---|---|---|
| Portrait | Q134307 | ~50K |
| Self-portrait | Q192110 | ~5K |
| Landscape | Q191163 | ~25K |
| Still life | Q170571 | ~8K |
| History painting | Q1057740 | ~15K |
| Genre painting | Q1047337 | ~10K |
| Religious art | Q2864737 | ~8K |
| Mythological | Q3375868 | ~3K |
| Nude | Q40446 | ~4K |
| Animal painting | Q16878234 | ~3K |
| Marine art | Q158607 | ~2K |

Modes: **require**

### Collection (`institution`)

Maps to P195 (collection) — the museum or institution that holds the work.

| Value | QID |
|---|---|
| Rijksmuseum | Q190804 |
| Louvre | Q19675 |
| Hermitage Museum | Q132783 |
| Metropolitan Museum of Art | Q160236 |
| Uffizi | Q51252 |
| Prado | Q160112 |
| National Gallery (London) | Q180788 |
| Getty Museum | Q731126 |
| Art Institute of Chicago | Q239303 |
| British Museum | Q6373 |
| Museum of Fine Arts Boston | Q49133 |
| Victoria and Albert Museum | Q213322 |
| National Gallery of Art | Q214867 |
| Musée d'Orsay | Q23402 |
| Tate | Q193375 |
| Smithsonian Institution | Q131626 |

Modes: **require**

### Century (`century`)

Filters by P571 (inception) year range. Unlike Wikimedia Commons, this applies to any item
with a known inception date — not limited to a named century category.

Values: 13th–21st century.

Modes: **require**

Note: Items without P571 are excluded when this filter is active.

### Artist (`artist`)

Text input resolved to a Wikidata QID via `wbsearchentities`. The resolved QID is used as
a P170 (creator) filter in the pool query. Results are cached for 24 hours.

The name resolution takes the first result whose description contains a creator keyword
(painter, artist, sculptor, etc.). For well-known artists this is reliable; for ambiguous
names it may pick the wrong entity.

---

## Image Access

P18 values in Wikidata SPARQL results are `Special:FilePath` URLs of the form:
```
http://commons.wikimedia.org/wiki/Special:FilePath/FileName.jpg
```

These redirect to the actual image at `upload.wikimedia.org`. `axios` follows the redirect
automatically. Images are typically 1500–8000px on the long edge.

Aspect ratio is checked post-download via `sharp().metadata()` (no pre-download dimensions
available from Wikidata).

---

## Metadata

| Field | Source | Notes |
|---|---|---|
| `title` | Wikidata item label (`?itemLabel`) | English label preferred |
| `creator` | P170 label (`?creatorLabel`) | First creator if multiple |
| `dateCreated` | P571 year (`?date`) | Extracted as 4-digit year |
| `movement` | P135 label (`?movementLabel`) | First movement if multiple |
| `genre` | P136 label (`?genreLabel`) | First genre if multiple |
| `collection` | P195 / P276 label (`?collectionLabel`) | First collection if multiple |
| `artworkUrl` | `https://www.wikidata.org/wiki/{QID}` | Direct link to the Wikidata item |
| `source` | `"Wikidata"` | Constant |

---

## Comparison with Wikimedia Commons

| | Wikidata | Wikimedia Commons |
|---|---|---|
| Result quality | Curated, noise-free | Noisy (photos of paintings, amateurs) |
| Movement filter | Yes (P135) | No |
| Genre filter | Yes (P136) | Subject categories (approximate) |
| Media diversity | Narrower (paintings dominant) | Broader |
| Fetch latency | ~0.07s detail + pool hit | ~4s (deepcat:) per round |
| Pool size | 10K random per filter combo | Up to 9,500 via CirrusSearch |
| Category depth | Not applicable | Full subcategory traversal via deepcat: |
| License filter | Not available | Post-fetch via extmetadata |

---

## Known Limitations

- **P135/P136 coverage is incomplete**: Many paintings have no movement or genre property
  set on Wikidata. These are excluded when those filters are active.
- **10K pool cap with shard rotation**: The pool query returns at most 10,000 QIDs. For large
  unfiltered queries (no movement/genre/institution/century/artist filter), a random shard
  (`QID % 40 = N`) is selected on each pool rebuild, rotating through different slices of the
  corpus every 6 hours. Over ~10 days (40 × 6h) the full ~400K corpus is reachable. Filtered
  queries (where the pool is small enough to return fully) do not apply sharding.
- **No media exclude mode**: The media filter supports require only (Wikidata's property
  structure doesn't lend itself to efficient exclusion queries without subqueries).
- **Artist resolution ambiguity**: `wbsearchentities` returns the most prominent match for
  a name; less-famous artists or common names may resolve incorrectly.
- **Pool staleness**: New works added to Wikidata won't appear until the pool TTL expires
  (6 hours).
- **No license pre-filter**: Wikidata does not carry license metadata directly. Images come
  from Wikimedia Commons and are generally freely licensed, but this cannot be pre-filtered.
