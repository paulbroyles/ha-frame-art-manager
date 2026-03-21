# Work Plan: Query Modes, Filter Cascade & Source Architecture

## Goal
Evolve the web sources system to support multiple query modes per source, cascading filters (global → per-source → per-virtual-tag), and orientation as a standard filter. Remove the global "web_sources" concept in favor of virtual tags only.

## Status Key: [ ] todo, [x] done, [~] in progress, [-] skipped

---

## Design Notes & API Research

### Google Arts & Culture API Findings
- **Medium browse** (`/api/entity/assets?categoryId=medium`): Only confirmed working browse mode. 203 medium entities, paginated up to offset ~4800.
- **Search** (`/api/search?q=...`): Returns ~50-150 fixed results, NO pagination. Query modifiers shift results ~90% uniquely. Limited but usable for keyword-based queries.
- **Timeline/Color browse**: Response hints at `/time?em=...` and `/color?em=...` URLs, but these are client-side route fragments, NOT API endpoints. Would need reverse-engineering to verify.
- **Artist browse**: Artist cobjects appear in search results with Freebase IDs (`cobject[24]`), but no documented way to browse artist's works via `/api/entity/assets`. Would need testing with `categoryId=artist` or similar.
- **Rate limiting**: Aggressive. Fetching totals for all 203 entities triggers HTTP 429. Hardcoded totals used as workaround.
- **Conclusion**: At minimum 2 confirmed modes (medium browse, search). Others (artist, timeline, color) need API probing before we can confirm.

### Europeana API Findings
- **Free API**, no key required (key recommended for higher rate limits)
- **Search mode**: Full-text + Boolean operators + Solr syntax
- **Faceted browse**: TYPE, YEAR, COUNTRY, PROVIDER, LANGUAGE, RIGHTS
- **Technical metadata filters**: IMAGE_SIZE (large=1-4MP, extra_large=>4MP), COLOURPALETTE (hex values), dimensions
- **Pagination**: `start` param for first 1000 results; cursor-based for beyond 1000
- **Artist/Medium**: Not built-in facets, but queryable via `dc:creator:"Picasso"` or in search strings; requires post-fetch filtering for refinement
- **IIIF support**: High-res zoomable images from some providers
- **Conclusion**: Rich multi-mode support. Search + browse + color + media properties all viable. Strong candidate for second source.

### Art UK
- **No public API**. Web-only discovery platform. Not viable for integration.

---

## Key Design Decisions

### 1. Filters vs Modes (Option 2: Everything is a filter)
- No separate "mode" concept in the UI. Everything is a filter.
- Source implements `selectMode(filters) → {mode, apiFilters, postFilters}` to infer the best API strategy from the filter set.
- Some filters may be "mode-determining" (e.g., a search string implies search mode).

### 2. Filter Cascade: Global → Per-Source → Per-Virtual-Tag
- Global filters apply to ALL sources (e.g., orientation)
- Per-source filters apply to all virtual tags for that source
- Per-virtual-tag filters are the most specific
- **Locking**: Parent defines available universe, child can only narrow
  - Parent exclude → excluded items locked out at child
  - Parent require → only required items available at child
- "No filter" = no restriction (passthrough)

### 3. Orientation as a Standard Filter
- `orientation` core filter type, values: `landscape`, `portrait`, `match_tv`
- Cascades like any other filter
- Sources declare `aspectRatioConstraint` (incompatible sources auto-excluded)

### 4. Virtual Tags Replace Global Web Sources
- No "pick random enabled source" fallback — removed
- No auto-generated default virtual tags — virtual tags only matter when referenced by tagsets
- HA tagsets reference `ws:<virtualTagId>` — unchanged
- Enable/disable toggle removed

### 5. Test Panel Rework (Phase 4)
- Test by: selecting a virtual tag, OR constructing an ad-hoc filter set
- Ad-hoc = pick source + build filters inline (same UI as virtual tag editor)
- Can also test with a tagset (picks random virtual tag from tagset)

---

## Implementation Phases

### Phase 1: Backend filter infrastructure [x] DONE
- Added `mergeFilterCascade()` to web_sources.js (intersection for require, union for exclude)
- Added `CORE_FILTER_TYPES` with `orientation` filter type
- Added `globalFilters` to config schema and `PUT /api/web-sources/global-filters` route
- Added `selectMode()` to all 3 sources (google_arts, met_museum, google_art_wallpaper)
- Updated `ADDING_WEB_SOURCES.md` with new contract
- Both fetch-and-send and test-fetch now use `mergeFilterCascade(globalFilters, sourceFilters, tagFilters)`

### Phase 2: Config migration + orientation filter + remove enable/disable [x] DONE
- Config v1→v2 migration: aspectRatioFilter → globalFilters orientation entry
- Removed `enabled` field from source configs (migration deletes it)
- Migration persisted to disk via `writeWebSourcesConfig` (runs once)
- `resolveAspectRatioFilter` reads from globalFilters first, fallback to legacy field
- `isSourceCompatible` reads from source modules first, fallback to BUILTIN_SOURCES
- `aspectRatioConstraint` exported from google_art_wallpaper.js source module
- Removed enable/disable route entirely
- Removed random-enabled-source fallback from fetch-and-send and test-fetch
- Frontend: orientation uses globalFilters API, no more enable/disable toggle
- Stored `coreFilterTypes` from config response in frontend state

### Phase 3: Filter cascade UI + locking [x] DONE

#### Done:
- **Unified `renderFilterList` component** used at all 3 levels (global, source, virtual tag)
  - Starts empty; "Add filter..." dropdown to add filter types
  - Each active filter: entry with value picker + remove button
  - Locked (parent) filters: shown with 🔒, not editable or removable
- **Locking semantics** (backend logic correct):
  - `isAvailable(value)`: parent exclude → `!parentValues.has(v)`, parent require → `parentValues.has(v)`
  - `isChecked(value)`: new include filter = all available checked; new exclude filter = none checked
  - `isLocked(value)`: `hasParent && !isAvailable(value)`
  - Category checkboxes: disabled when all items in group are locked; only count available items
  - Select All/None, mode-switch inversion, category toggle: all skip `:disabled` checkboxes
- `readFiltersFromUI` / `readVirtualTagFiltersFromUI` skip locked values
- Default filter mode changed from exclude to **include (require)**

#### Known Issues (user feedback):
1. **[x] Locked filter type blocks adding child filter of same type**: Fixed — removed `if (lockedTypes.has(ft.type) && !ft.multiValue) continue` guard and simplified `usedModes` to only track child-level modes. Child can now always add a filter of the same type as a parent locked filter, with lock state shown visually on checkboxes.
2. **[x] No dedicated "Filters" section**: Source settings modal already has `ws-filters-section` wrapper with `ws-section-label` "Filters". Global settings has "Global Filters" label. Implemented during Phase 3.
3. **[x] Filters should be collapsible**: Implemented — `data-collapsed="true"` default, CSS hides body when collapsed, click on header toggles. New filters start expanded via `expandedTypes` param passed in `onAdd` callbacks.
4. **[x] "Add Filter" button issues**: Implemented — full-width dashed button, dropdown appears after click, type selection in dropdown. Button only hidden when all available filter types for that source are already active (correct behavior).
5. **[x] Core filter select needs padding**: CSS rule `.ws-filter-entry-body > .ws-filter-core-value { margin: 12px 16px; display: block; }` already applied.

### Phase 4: Test panel rework [x] DONE
### Phase 5: Google Arts search mode [ ] TODO

---

## Current State of Files

### Backend (routes/web_sources.js)
- `CORE_FILTER_TYPES` at line ~57-71
- `mergeFilterCascade()` at line ~84-112
- `readWebSourcesConfig()` with v2 migration at line ~193-312
- `writeWebSourcesConfig()` at line ~318
- `PUT /api/web-sources/global-filters` route
- `POST /fetch-and-send` requires virtualTagId or sourceId (no random fallback)
- `POST /test-fetch` requires virtualTagId for random (no fallback)

### Frontend (public/js/app.js) — key functions
- `renderWebSourcesGlobalSettings()` — uses `renderFilterList` for global filters + `saveGlobalFilters` helper + `initFilterListInteractions` for add/remove/value-change
- `renderFilterList({containerId, availableFilterTypes, currentFilters, lockedFilters, sourceId})` — unified component
- `renderLockedFilterEntry(filterType, filter)` — summary-only locked entry with 🔒
- `renderActiveFilterEntry(sourceId, filterType, currentFilter, parentFilter)` — entry with value picker + remove
- `renderCheckboxFilterSection(sourceId, filterType, currentFilter, lockedFilter)` — checkbox groups with lock semantics
- `renderTextFilterSection(sourceId, filterType, currentFilter, lockedFilter)` — text input with locked tags
- `readFiltersFromUI(sourceId)` — reads from source settings modal
- `readVirtualTagFiltersFromUI()` — reads from virtual tag modal
- `initFilterSectionInteractions(body)` — expand/collapse, checkbox cascades, mode switching
- `initFilterListInteractions(container, callbacks)` — add/remove/core-value handlers
- `reRenderSourceFilters(sourceId, currentFilters)` — re-render + re-init for source settings
- `initVirtualTagFilterList(container, sourceId, currentFilters, skipRender)` — render + init for VT modal
- `renderSourceFilters(sourceId, currentFilters, lockedFilters)` — delegates to `renderFilterList`
- `renderVirtualTagFilters(sourceId, currentFilters)` — delegates to `renderFilterList` with source filters as locked

### Frontend (public/css/style.css) — filter-related classes
- `.ws-filter-list`, `.ws-filter-entry`, `.ws-filter-entry-header`, `.ws-filter-entry-title`, `.ws-filter-entry-summary`, `.ws-filter-entry-remove`, `.ws-filter-entry-body`, `.ws-filter-entry-locked`, `.ws-filter-add-row`
- `.ws-filter-locked`, `.ws-filter-locked-icon`, `.ws-type-tag-locked`
- `.ws-filter-section`, `.ws-media-categories`, `.ws-media-category`, `.ws-media-category-header`, `.ws-media-category-items`

### Config on HA box
- File: `/config/www/frame_art/web_sources.json`
- **WARNING**: User's filter exclusion lists were lost (file zeroed by failed SSH pipe). User needs to reconfigure through UI.
- Currently has default config with `configVersion: 2`, empty filters on all sources

---

## Open Questions (Resolved)
- ~~Should auto-generated default virtual tags be visible/editable in the UI?~~ → No auto-generated virtual tags. Virtual tags only matter via tagsets.
- ~~match_tv orientation~~ → Kept as filter value, resolved at fetch time
- ~~API probing for more Google Arts modes~~ → Deferred to Phase 5+

## Open Questions (Still Open)
- How does include mode work for text filters? (e.g., objectType has `modes: ['exclude']` only currently)
- Should core filter types (orientation) appear in source-level and virtual-tag-level filter lists?
