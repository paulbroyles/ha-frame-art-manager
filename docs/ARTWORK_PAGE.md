# Artwork Info Page

Public webpage at `/artwork/:tvId` showing the currently displayed artwork on a Samsung Frame TV. Designed for QR code placards on e-paper displays next to each TV.

## Features

- Per-TV URL using HA device_id or slugified TV name
- No HA login required — public on local network
- Server-rendered HTML with inline CSS (fully self-contained)
- Dark gallery aesthetic, mobile-first
- Full uncropped image with zoomable fullscreen overlay (CSS-only, pinch-to-zoom)
- Metadata rendered via Custom Data system (display roles: primary/secondary/detail)
- Works for both web source and local library images

## URL Stability

- **Device ID** (`/artwork/fbbd5e69...`): Stable across TV renames — use for QR codes
- **Slug** (`/artwork/kitchen-the-frame-32`): Human-readable but breaks if TV is renamed

## Data Flow

### Web Source Shuffle Path

```
frame-art-shuffler                          ha-frame-art-manager
─────────────────                           ────────────────────
async_shuffle_tv
  → _async_fetch_and_display_web_source
      → POST /api/web-sources/fetch-and-display ──→ fetch-and-display handler
                                                     ├─ Fetch image from source
                                                     ├─ Process image (crop/trim)
                                                     ├─ Write processed → _pending file
                                                     ├─ displayImageOnTV ──→ POST /services/.../display_image
  ← display_image service                   ←──────────────────────────────┘
      → set_art_on_tv_deleteothers (TV WebSocket)
      → Update artwork_info sensor
      → Return success
                                                     ├─ [display succeeded]
                                                     ├─ clearCacheForDevice (old files)
                                                     ├─ rename _pending → final
                                                     ├─ Write _original file
                                                     ├─ Update perTvCache
                                                     └─ Return success JSON
```

### Artwork Page Data Sources

- **artwork_info sensor** (via HA template API): Authoritative for what's currently on the TV. Provides `source_type`, `filename` (local), and flattened metadata attributes.
- **perTvCache** (from `web_sources.json`): Structured metadata for web sources — `attributeSnapshot`, `entitySnapshot`, `artworkUrl`, `originalFilename`. Validated against sensor before use.
- **metadata.json**: For local images — `attributes`, `entityRefs` resolved against `entityInstances`. Also provides `customDataOrder` and entity type definitions for both source types.

## Cache Consistency (Pending-File Pattern)

Image files and metadata are only committed to disk after the TV successfully displays the image. This prevents stale cache when a shuffle attempt fails (e.g., TV off during Shuffle Silently).

### How it works

1. Processed image is written to `{deviceId}_pending.{ext}` (old files untouched)
2. `displayImageOnTV` is called with the pending file path
3. **On success**: old files cleared, pending renamed to final (`fs.rename` — atomic), original written, `perTvCache` updated
4. **On failure**: pending file deleted, old cache stays intact

### Consistency guarantees

- **Image files**: Only committed after `displayImageOnTV` returns success
- **perTvCache**: Only updated after files are committed
- **artwork_info sensor**: Updated inside HA's `display_image` service, after `set_art_on_tv_deleteothers` succeeds
- **Artwork page**: Validates perTvCache against sensor (title match); falls back to reconstructing metadata from sensor attributes if stale

### Failure modes

| Step that fails | Image files | perTvCache | Sensor | Artwork page |
|----------------|-------------|------------|--------|--------------|
| Image fetch/processing | Unchanged | Unchanged | Unchanged | Correct |
| `displayImageOnTV` (TV unreachable) | Pending cleaned up, old files intact | Unchanged | Unchanged | Correct |
| Commit block (crash after display) | Old files cleared but new not committed | Unchanged | Updated | Metadata from sensor fallback; image may 404 |
| `writeWebSourcesConfig` (disk full) | New files committed | Unchanged | Updated | Metadata from sensor fallback; image correct |

### Remaining narrow window

If the add-on crashes after `displayImageOnTV` returns but before the commit block completes (~5 fast local I/O operations, no network), the TV has new artwork but cache reflects old. This is unlikely and self-corrects on next successful shuffle. Possible future mitigation: write a pending-display marker before `displayImageOnTV`, reconcile on startup against the sensor state.

## Display Roles

Custom Data entries can have a `displayRole` controlling how they render on the artwork page:

- **`primary`**: Large heading (e.g., title)
- **`secondary`**: Secondary line with optional extra entity attributes (e.g., artist name + dates)
- **`detail`** (default): Labeled rows in a details section

Roles are source-agnostic — work the same for flat attributes and entities. For entities, the first attribute is the display value; additional attributes render inline (secondary) or as comma-separated values (detail).

## Key Files

| File | Role |
|------|------|
| `app/routes/artwork.js` | Page + image routes, metadata resolution, HTML rendering |
| `app/routes/web_sources.js` | Pending-file pattern in fetch-and-display, `perTvCache`, `clearCacheForDevice` |
| `app/metadata_helper.js` | `setDisplayRole()`, `getCustomDataOrder()` |
| `app/routes/entities.js` | Display role API endpoint |
| `app/public/js/app.js` | Display role UI in Custom Data tab |
| `app/routes/ha.js` | Exports `haRequest` for HA template API calls |
| `app/server.js` | Mounts `/artwork` route |
