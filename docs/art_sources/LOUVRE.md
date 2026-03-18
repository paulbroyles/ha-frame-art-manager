# Musée du Louvre — Collections API

The Louvre collections website provides JSON access to individual records by ARK identifier.
There is no JSON search/batch API; selection uses the HTML search results pages.

---

## General

- **Base URL**: `https://collections.louvre.fr`
- **Authentication**: None required
- **Rate limit**: Not documented; requests include a User-Agent header to identify the client
- **Collection size**: ~478,000 objects across 25,078 pages of 20 results each
- **Image rights**: © Musée du Louvre per image; for personal home automation display use

---

## Selection Strategy

1. Determine the effective department list from any `require`/`exclude` filters.
2. If departments are constrained, build `collection[]=<code>` URL parameters for the
   eligible departments (one per department). Get the page count for this filtered search
   by probing page 1 (cached in-memory for 24h; falls back to stale value on network failure).
3. Pick a random page from 1 to the (filtered) page count.
4. Fetch `https://collections.louvre.fr/en/recherche?q=&collection[]=...&page={N}` (HTML).
5. Extract ARK IDs matching `/ark:/53355/(cl\d{9})/` from the HTML.
6. Retry loop (up to 20 attempts total):
   - Pick a random ARK from the current page batch.
   - Fetch `https://collections.louvre.fr/ark:/53355/{arkId}.json`.
   - Skip records with no `image` entries.
   - If pre-filtered, validate `collection` field against expected substrings.
   - Download `image[].urlImage`.
   - Check aspect ratio via sharp if filtering is active.
   - On batch exhausted, fetch a new random page.

**Why pre-filter via URL**: Without department pre-filtering, random pages from the full
25,078-page collection would hit any of 9 departments. For Paintings (536 pages out of 25,078),
~98% of random page fetches would need to be discarded — making the retry loop much less
efficient. Pre-filtering at URL level gives the correct page count for the selected departments
and ensures every fetched page actually contains matching items.

---

## JSON Record Endpoint

**Pattern**: `https://collections.louvre.fr/ark:/53355/{arkId}.json`

**ARK ID format**: `cl` followed by 9 digits (e.g., `cl010277627`)

**Key fields used**:

| Field | Type | Notes |
|-------|------|-------|
| `title` | string | Artwork title (French) |
| `creator` | array | `[{name, role, ...}]`; empty for anonymous/archaeological items |
| `materialsAndTechniques` | string | Free-text materials description |
| `dateCreated` | array | `[{startYear, endYear, text, ...}]`; may be empty |
| `displayDateCreated` | string | Human-readable date with French label prefix |
| `collection` | string | Department name (French), e.g., `"Département des Peintures"` |
| `url` | string | Canonical URL to the artwork page |
| `image` | array | `[{urlImage, urlThumbnail, copyright, type, position}]`; may be empty |

**Image URL**: `image[].urlImage` is a full absolute HTTPS URL (no base URL needed).
Example: `https://collections.louvre.fr/media/cache/large/0000000021/0000001001/0000584982_OG.JPG`

---

## Department Filtering

Each department maps to a `collection[]` URL parameter code (for pre-filtering the search) and
validation substrings (matched against the JSON record's `collection` field as a guard):

| UI Label | URL code | Validation substrings |
|----------|----------|-----------------------|
| Paintings | `peintures` | `peintures` |
| Drawings & Prints | `arts-graphiques` | `arts graphiques` |
| Sculptures | `sculptures` | `sculptures` |
| Decorative Arts | `objets-art` | `objets d'art` |
| Egyptian Antiquities | `antiquites-egyptiennes` | `antiquités égyptiennes` |
| Greek & Roman Antiquities | `antiquites-grecques-etrusques-et-romaines` | `antiquités grecques`, `antiquités romaines`, `antiquités étrusques` |
| Near Eastern Antiquities | `antiquites-orientales` | `antiquités orientales` |
| Islamic Art | `arts-de-l-islam` | `arts de l'islam` |
| Byzantine Art | `arts-de-byzance` | `byzance` |

**require filters** → included departments are passed as `collection[]` URL params (pre-filtered
at search time; correct page count cached for 24h).

**exclude filters** → all non-excluded departments are passed as `collection[]` URL params
(same pre-filter approach; excluded departments simply aren't included in the URL params).

The JSON `collection` field is validated against expected substrings after fetching the record,
as a guard against stale HTML or Louvre site changes returning unexpected items.

---

## Aspect Ratio

No aspect ratio metadata is available before downloading the image. Filtering is done
post-download via `sharp(imageBuffer).metadata()`. The retry loop handles skipped items.

The Louvre collection contains a mix of landscape and portrait artwork; neither orientation
is dominant, so aspect ratio filtering may require additional retry attempts.

---

## Metadata Fields

| Key | Source | Notes |
|-----|--------|-------|
| `title` | `record.title` | May be in French |
| `creator` | `record.creator[].name` joined by `'; '` | Empty for archaeological items |
| `medium` | `record.materialsAndTechniques` | May be in French |
| `dateCreated` | `record.dateCreated[0].startYear`–`endYear`, or `text` | Constructed from structured data |
| `collection` | `record.collection` | French department name |
| `attribution` | `record.image[0].copyright` | e.g., `"© 2014 Musée du Louvre / Département des Peintures"` |
| `source` | hardcoded | Always `"Musée du Louvre"` |

---

## fetchByIdentifier

Accepts:
- Full Louvre ARK URLs: `https://collections.louvre.fr/ark:/53355/cl010277627`
  or `https://collections.louvre.fr/en/ark:/53355/cl010277627`
- Bare ARK IDs: `cl010277627`

---

## Known Limitations

- **Image resolution ~1500px**: The Louvre's `/media/cache/large/` images max out at approximately
  1500px on the long side. No higher-resolution tier exists (`/xlarge/`, `/original/` both 404).
  This is upscaled ~2.5× to fill a 3840×2160 TV. Acceptable at typical viewing distance but not
  ideal for close inspection. Dezoomify is not applicable (these are pre-rendered JPEGs, not tiled
  IIIF images).
- **No JSON search API**: Random selection requires fetching and parsing HTML search pages,
  which adds latency (~1 page fetch + 1 JSON fetch + 1 image download per artwork).
- **Many items without images**: Archaeological and archival items frequently have no `image`
  entries; the retry loop may need several attempts, especially with department filters.
- **French text**: Titles, media descriptions, and department names are in French.
- **Copyright**: Images are © Musée du Louvre, not public domain (unlike Met or Google Arts).
  Suitable for personal display use.
- **Page count cache**: The filtered page count is cached for 24h per department combination.
  On process restart (deploy/HA restart) the cache is cleared and re-probed on first use.
