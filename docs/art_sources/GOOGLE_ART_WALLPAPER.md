# Google Art Wallpaper

This source is backed by a static curated list maintained by Google for use in Chromecast
"Art" ambient mode and related display surfaces. Unlike the Google Arts & Culture API (which
is an undocumented internal BFF API requiring reverse engineering) or the Met API (which is
a fully documented public REST API), this source has no API at all — it is a single static
JSON file fetched directly.

There is no public documentation. The URL was discovered from reference implementations:

- https://github.com/vivalatech/homeassistant-addons/blob/main/homeassistant-samsung-frametv-artchanger/sources/google_art.py
- https://github.com/vitorpy/vitorpy.com/blob/948a246fc1a5208ce4fb9dad2b1512edebf99658/content/blog/2025-12-26-google-arts-wallpaper-hyprland.md?plain=1#L36

---

## Data Source

**List URL**: `https://www.gstatic.com/culturalinstitute/tabext/imax_2_2.json`

- A static JSON array hosted on `gstatic.com`
- Curated by Google; updated infrequently
- Contains approximately 349 entries at time of writing
- Optimized for large widescreen displays (the `imax_2_2` filename suggests IMAX/2:2 aspect ratio targeting)
- No authentication or rate limiting

---

## List Entry Format

Each entry in the JSON array is an object with the following fields (all optional except `image`):

| Field | Type | Description |
|-------|------|-------------|
| `image` | string | Protocol-relative base URL for the image on `lh3.googleusercontent.com` |
| `title` | string | Artwork title |
| `creator` | string | Artist/creator name |
| `attribution` | string | Museum or institution holding the work |
| `link` | string | Relative path on `artsandculture.google.com` (e.g., `asset/...`) |

---

## Image URL Construction

The `image` field is a protocol-relative base URL (e.g., `//lh3.googleusercontent.com/...`).
A sizing suffix must be appended to get a usable URL. This source requests images at 3840×2160
center-cropped:

```
https:{entry.image}=w3840-h2160-c
```

This is the same URL parameter pattern used by the Google Arts & Culture source.

---

## Selection Strategy

Single-step: fetch the list, pick a uniformly random entry. No pagination, no offset tokens,
no classification filtering. The list is small enough (~349 entries) that the entire pool is
always available.

---

## Characteristics

- **Pool size**: ~349 artworks (fixed, curated)
- **Content**: Widescreen-optimized artworks selected for large display use; strong bias toward
  well-known Western paintings (Impressionism, Renaissance, etc.)
- **Aspect ratio**: Entries are pre-selected for landscape display; no portrait works
- **Randomness**: True uniform random across the full pool on every fetch
- **Filtering**: None — no media type or category filtering is supported or needed given the
  small, curated pool
- **No API key, no rate limit, no authentication**