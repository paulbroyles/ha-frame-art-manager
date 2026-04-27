# Pre-fetch Pipeline Workplan

## Goal
Always have the next web-source image fetched and processed before the TV needs it, eliminating the ~9s fetch+process overhead from the tight screen-off window.

## Architecture

- **Pre-fetch slot**: one image per device, stored in `web_source_cache/prefetch/`
- **Fingerprint**: SHA-256 of config fields that affect source selection (sources, virtualTags, globalFilters, aspectRatioFilter, imageProcessing)
- **Stored alongside fingerprint**: `virtualTagId` (so a tagset change invalidates the cache)
- **Trigger**: after each successful `fetch-and-send`, fire-and-forget replenish using same virtualTagId
- **Tagset-change refetch**: shuffler invalidates + calls `shuffle/select` for new virtualTagId + triggers fresh prefetch
- **Moods**: skip prefetch when `activeMoods` non-empty (transient, hard to fingerprint)

## Files

### ha-frame-art-manager (this repo)
- [x] `app/utils/prefetchCache.js` — NEW: fingerprint, read/write/delete prefetch
- [ ] `app/routes/web_sources.js` — modify fetch-and-send + add prefetch endpoints

### frame-art-shuffler
- [ ] `custom_components/frame_art_shuffler/shuffle.py` — trigger prefetch after successful web send
- [ ] `custom_components/frame_art_shuffler/__init__.py` — invalidate+refetch on tagset change

## API surface

### Add-on endpoints (new)
- `POST /api/web-sources/prefetch/:deviceId` — body: `{virtualTagId, tvOrientation?}` → queues background prefetch, returns `{queued: true}`
- `DELETE /api/web-sources/prefetch/:deviceId` — invalidate one device
- `DELETE /api/web-sources/prefetch` — invalidate all
- `GET /api/web-sources/prefetch/status` — returns `{deviceId: {fingerprint, virtualTagId, fetchedAt, ext}}`

### Config-change invalidation
Routes that write config trigger `deleteAllPrefetches`: image-processing, aspect-ratio-filter, global-filters, sources/:id/settings, sources/:id/filters, virtual-tags POST/PUT/DELETE.

## Status
- [x] `prefetchCache.js` written
- [x] web_sources.js modified (fetch-and-send, replenishPrefetch, new endpoints, writeWebSourcesConfig auto-invalidation)
- [x] shuffle.py modified (_async_trigger_prefetch, trigger after successful send)
- [x] __init__.py modified (_async_invalidate_and_prefetch_for_tv, tagset handlers)
- [ ] Both repos committed and deployed
