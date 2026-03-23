const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');
const axios = require('axios');
const sharp = require('sharp');
const { processWebSourceImage, solidBorderStrip, runPipeline, PRE_PROCESSORS, IMAGE_PROCESSING_SCHEMA, PROCESSORS } = require('../utils/imageProcessor');
const { applyFieldFormat } = require('../utils/fieldFormatters');
const MetadataHelper = require('../metadata_helper');
const { autoLinkArtistFromWebSource } = require('../utils/enrichers');

// Source modules — each must export fetchRandomArtwork, selectMode, metadataFields, and defaultMapping.
// Optional: settingsSchema, getExtraOptions, getFilterTypes, getMetadataFields, alreadyProcessed.
// web_sources.js delegates source-specific logic to these modules generically.
const SOURCE_MODULES = {
  google_arts: require('../sources/google_arts'),
  google_art_wallpaper: require('../sources/google_art_wallpaper'),
  met_museum: require('../sources/met_museum'),
  moma: require('../sources/moma'),
  louvre: require('../sources/louvre'),
  artsy: require('../sources/artsy'),
  delart:         require('../sources/delart'),
  tate:           require('../sources/tate'),
  access_okeefe:  require('../sources/access_okeefe'),
};

const SOURCE_FETCHERS = Object.fromEntries(
  Object.entries(SOURCE_MODULES).map(([id, mod]) => [id, mod.fetchRandomArtwork])
);

// Settings schemas collected from source modules (only sources that define one are included).
const SOURCE_SETTINGS_SCHEMAS = Object.fromEntries(
  Object.entries(SOURCE_MODULES)
    .filter(([, mod]) => mod.settingsSchema)
    .map(([id, mod]) => [id, mod.settingsSchema])
);

// Filter type definitions per source, as returned by getFilterTypes().
// Used by GET /api/web-sources/sources/:sourceId/filter-types and the config endpoint.
const SOURCE_FILTER_TYPES = Object.fromEntries(
  Object.entries(SOURCE_MODULES).map(([id, mod]) => [id, mod.getFilterTypes ? mod.getFilterTypes() : []])
);

/**
 * Returns the IDs of sources that support keyword search (type: 'search' filter).
 * Dynamic — automatically includes any source that adds a 'search' filter type.
 */
function getSearchCapableSources() {
  return Object.keys(SOURCE_MODULES).filter(id => {
    const filterTypes = SOURCE_FILTER_TYPES[id] || [];
    return filterTypes.some(ft => ft.type === 'search');
  });
}

function getArtistCapableSources() {
  return Object.keys(SOURCE_MODULES).filter(id => {
    const filterTypes = SOURCE_FILTER_TYPES[id] || [];
    return filterTypes.some(ft => ft.type === 'artist');
  });
}

/**
 * Fetch per-source artwork counts for a given artist name.
 * All artist-capable sources are probed in parallel using their cached count functions.
 * Cache hits are instant; misses probe the source API (usually <500ms).
 *
 * Portable: local gallery count is injected via `localCountFn` so this function
 * has no direct dependency on MetadataHelper or the local gallery.
 *
 * @param {string} artistName
 * @param {object} [options]
 * @param {string} [options.aspectRatio='all']  Filter pool by aspect ratio compatibility
 * @param {Function} [options.localCountFn]     async (artistName) => string[] of local filenames
 * @returns {Promise<{ counts: Record<string, number|null>, localImages: string[] }>}
 */
async function getArtistCounts(artistName, { aspectRatio = 'all', localCountFn } = {}) {
  const pool = getArtistCapableSources()
    .filter(id => BUILTIN_SOURCES[id])
    .filter(id => isSourceCompatible(id, aspectRatio));

  const [sourceCounts, localImages] = await Promise.all([
    Promise.all(pool.map(id =>
      (SOURCE_MODULES[id].countArtistArtworks
        ? SOURCE_MODULES[id].countArtistArtworks(artistName).catch(() => null)
        : Promise.resolve(null))
    )),
    localCountFn ? localCountFn(artistName).catch(() => []) : Promise.resolve([]),
  ]);

  const counts = { local: localImages.length };
  pool.forEach((id, i) => { counts[id] = sourceCounts[i]; });

  return { counts, localImages };
}

/**
 * Compute per-source metadata declarations (fields + default mapping) given stored source settings.
 * Sources that export getMetadataFields(settings) receive their stored settings so the field list
 * can vary at runtime (e.g. google_art_wallpaper appends rich fields when fetchRichMetadata is on).
 * Falls back to the static metadataFields export for sources that don't implement getMetadataFields.
 */
function buildSourceMetadata(webSources) {
  return Object.fromEntries(
    Object.entries(SOURCE_MODULES).map(([id, mod]) => {
      const settings = webSources?.sources?.[id]?.settings;
      const fields = mod.getMetadataFields
        ? mod.getMetadataFields(settings)
        : (mod.metadataFields || []);
      const dm = mod.getDefaultMapping
        ? mod.getDefaultMapping(settings)
        : (mod.defaultMapping || {});
      return [id, { fields, defaultMapping: dm }];
    })
  );
}

// ── Core filter types (framework-level, not per-source) ───────────────────────
// These filter types apply across all sources and are merged with per-source
// filter types in the config response. Sources don't declare these — the
// framework manages them.
const CORE_FILTER_TYPES = [
  {
    type: 'orientation',
    label: 'Orientation',
    description: 'Filter by image aspect ratio (landscape or portrait)',
    modes: ['require'],
    multiValue: false,
    core: true,
    values: [
      { value: 'landscape', label: 'Landscape' },
      { value: 'portrait', label: 'Portrait' },
      { value: 'match_tv', label: 'Match TV' },
    ],
  },
];

/**
 * Merge filters from multiple cascade levels (global → source → virtual tag).
 *
 * Semantics:
 *   - Same type + require: intersection of value sets (lower levels narrow).
 *   - Same type + exclude: union of value sets (lower levels add exclusions).
 *   - Different types coexist independently.
 *
 * @param {...Array<{type, mode, values}>} filterLevels - Filter arrays in cascade order.
 * @returns {Array<{type, mode, values}>} Merged filter array.
 */
function mergeFilterCascade(...filterLevels) {
  const merged = {};

  for (const filters of filterLevels) {
    for (const filter of (filters || [])) {
      if (!filter.type || !filter.mode || !Array.isArray(filter.values) || filter.values.length === 0) continue;
      const key = `${filter.type}:${filter.mode}`;
      if (!merged[key]) {
        merged[key] = { type: filter.type, mode: filter.mode, values: [...filter.values] };
      } else if (filter.mode === 'require') {
        // Intersection: only keep values present in BOTH sets
        const existing = new Set(merged[key].values.map(v => v.toLowerCase()));
        merged[key].values = filter.values.filter(v => existing.has(v.toLowerCase()));
      } else {
        // Union (exclude): add all new values
        const existing = new Set(merged[key].values.map(v => v.toLowerCase()));
        for (const v of filter.values) {
          if (!existing.has(v.toLowerCase())) {
            merged[key].values.push(v);
            existing.add(v.toLowerCase());
          }
        }
      }
    }
  }

  return Object.values(merged).filter(f => f.values.length > 0);
}

const SUPERVISOR_TOKEN = process.env.SUPERVISOR_TOKEN;
const HA_API_BASE = process.env.HA_URL || 'http://supervisor/core/api';

// Available built-in web source definitions
const BUILTIN_SOURCES = {
  google_arts: {
    id: 'google_arts',
    name: 'Google Arts & Culture',
    description: 'Random paintings from the Google Arts & Culture collection',
    type: 'google_arts',
  },
  google_art_wallpaper: {
    id: 'google_art_wallpaper',
    name: 'Google Art Wallpaper',
    description: 'Curated widescreen artworks from the Google Art Wallpaper collection (~349 works), pre-formatted for large displays',
    type: 'google_art_wallpaper',
    // All entries are center-cropped to 3840×2160 — landscape only.
    // This source is automatically skipped when the aspect ratio filter is 'portrait'.
    aspectRatioConstraint: 'landscape',
  },
  met_museum: {
    id: 'met_museum',
    name: 'The Metropolitan Museum of Art',
    description: 'Public-domain artworks from the Met\'s Open Access collection of 500,000+ objects',
    type: 'met_museum',
  },
  moma: {
    id: 'moma',
    name: 'The Museum of Modern Art (MoMA)',
    description: 'Artworks from MoMA\'s collection dataset (~93,000 works with images), including paintings, photography, design, film, and more',
    type: 'moma',
  },
  louvre: {
    id: 'louvre',
    name: 'Musée du Louvre',
    description: 'Artworks from the Louvre\'s collection of ~478,000 objects, spanning paintings, sculptures, antiquities, decorative arts, and more. Note: images are low resolution (~1500px) for a 4K display.',
    type: 'louvre',
  },
  artsy: {
    id: 'artsy',
    name: 'Artsy',
    description: 'For-sale artworks from galleries worldwide via Artsy\'s marketplace',
    type: 'artsy',
  },
  delart: {
    id: 'delart',
    name: 'Delaware Art Museum',
    description: 'American paintings, Pre-Raphaelite works, illustrations, and more from the Delaware Art Museum\'s collection of ~12,800 objects',
    type: 'delart',
  },
  tate: {
    id: 'tate',
    name: 'Tate',
    description: 'British and international artworks from the Tate collection (~66,700 works with cleared images), including Turner\'s bequest, modern and contemporary works',
    type: 'tate',
  },
  access_okeefe: {
    id: 'access_okeefe',
    name: "Access O'Keeffe",
    description: "Artworks and photographs from the Georgia O'Keeffe Museum collection (~2,000 objects), primarily works by Georgia O'Keeffe with high-resolution IIIF images",
    type: 'access_okeefe',
  },
};

// ── Config file helpers ───────────────────────────────────────────────────────

function cacheDirFor(frameArtPath) {
  return path.join(frameArtPath, 'web_source_cache');
}

function cacheFileFor(frameArtPath, deviceId, ext = 'jpg', suffix = '') {
  return path.join(cacheDirFor(frameArtPath), `${deviceId}${suffix}.${ext}`);
}

function webSourcesConfigPath(frameArtPath) {
  return path.join(frameArtPath, 'web_sources.json');
}

/**
 * Migrate web sources config out of metadata.json into web_sources.json.
 * Called automatically on first read when web_sources.json does not exist.
 * The old global metadataMapping is dropped — per-source userMapping replaces it.
 * Returns the migrated config object, or null if nothing to migrate.
 *
 * Note: metadata.json itself is replaced by gallery.json + custom_metadata.json
 * (see MetadataHelper._migrateFromLegacy). If that migration ran first, this
 * function will find no metadata.json and return null gracefully.
 */
async function migrateFromMetadata(frameArtPath) {
  const metadataPath = path.join(frameArtPath, 'metadata.json');
  let metadata = {};
  try {
    const raw = await fs.readFile(metadataPath, 'utf8');
    metadata = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!metadata.webSources) return null;

  // Extract webSources, dropping the old global metadataMapping (per-source now)
  const { metadataMapping: _dropped, ...wsConfig } = metadata.webSources;

  // Write metadata.json without the webSources key
  const { webSources: _ws, ...metadataRest } = metadata;
  try {
    await fs.writeFile(metadataPath, JSON.stringify(metadataRest, null, 2));
  } catch (err) {
    console.warn('[web_sources] Failed to clean up metadata.json during migration:', err.message);
  }

  console.log('[web_sources] Migrated web sources config from metadata.json to web_sources.json');
  return wsConfig;
}

/**
 * Read web sources config from web_sources.json.
 * On first access, migrates automatically from metadata.json if present.
 * Returns the config object directly.
 */
async function readWebSourcesConfig(frameArtPath) {
  const configPath = webSourcesConfigPath(frameArtPath);
  let config = null;

  try {
    const raw = await fs.readFile(configPath, 'utf8');
    config = JSON.parse(raw);
  } catch {
    // Not found — try migrating from the old location
    const migrated = await migrateFromMetadata(frameArtPath);
    if (migrated) config = migrated;
  }

  if (!config) {
    config = {
      aspectRatioFilter: 'all',
      sources: {},
      perTvCache: {},
    };
  }

  // Guard: fill in any missing top-level fields
  if (!config.aspectRatioFilter) config.aspectRatioFilter = 'all';
  if (!config.sources) config.sources = {};
  if (!config.perTvCache) config.perTvCache = {};
  if (!config.imageProcessing) config.imageProcessing = {};
  if (!config.virtualTags) config.virtualTags = {};
  if (!config.globalFilters) config.globalFilters = [];
  const ip = config.imageProcessing;
  if (!ip.preProcessor)       ip.preProcessor       = 'corner_consensus';
  if (!ip.cropEngine)         ip.cropEngine         = 'sharp';
  if (!ip.preProcessorOptions) ip.preProcessorOptions = {};
  if (!ip.cropEngineOptions)  ip.cropEngineOptions  = {};
  if (!ip.cropEngineOptions.strategy) ip.cropEngineOptions.strategy = 'attention';
  if (!Object.prototype.hasOwnProperty.call(ip, 'skipLowRes')) ip.skipLowRes = false;
  if (!ip.minResolution)      ip.minResolution      = 1080;
  if (!Object.prototype.hasOwnProperty.call(ip, 'unifiedProcessor')) ip.unifiedProcessor = null;
  if (!ip.unifiedProcessorOptions) ip.unifiedProcessorOptions = {};
  if (!Object.prototype.hasOwnProperty.call(ip, 'pipeline')) ip.pipeline = null;

  // Ensure all builtin sources are present (add any missing ones with defaults)
  for (const [id, def] of Object.entries(BUILTIN_SOURCES)) {
    if (!config.sources[id]) {
      config.sources[id] = { ...def };
    }
  }

  // ── Filter migration ──────────────────────────────────────────────────────
  // Migrate legacy settings.disabledMedia / settings.excludedTypes → filters array.
  // These were the old per-source settings keys before the generic filter system.
  // Only runs when old keys are still present; harmless on already-migrated configs.
  for (const [id, sourceConfig] of Object.entries(config.sources)) {
    if (!sourceConfig.filters) sourceConfig.filters = [];
    const mod = SOURCE_MODULES[id];

    // Migrate settings.disabledMedia → { type: 'media', mode: 'exclude', values }
    if (sourceConfig.settings?.disabledMedia?.length > 0) {
      if (!sourceConfig.filters.some(f => f.type === 'media')) {
        sourceConfig.filters.push({ type: 'media', mode: 'exclude', values: sourceConfig.settings.disabledMedia });
      }
      delete sourceConfig.settings.disabledMedia;
    }

    // Migrate settings.excludedTypes → filter (for sources that declared an objectType filter type)
    if (Object.prototype.hasOwnProperty.call(sourceConfig.settings || {}, 'excludedTypes')) {
      const hasObjectTypeFilter = (mod?.getFilterTypes?.() || []).some(ft => ft.type === 'objectType');
      if (hasObjectTypeFilter && !sourceConfig.filters.some(f => f.type === 'objectType')) {
        sourceConfig.filters.push({ type: 'objectType', mode: 'exclude', values: sourceConfig.settings.excludedTypes ?? [] });
      }
      delete sourceConfig.settings.excludedTypes;
    }

    // Apply default filters from the source module for new/empty configs.
    // Sources export getDefaultFilters() to declare filters that should be present
    // out of the box (e.g. excluding unwanted object types).
    if (mod?.getDefaultFilters) {
      for (const defaultFilter of mod.getDefaultFilters()) {
        if (!sourceConfig.filters.some(f => f.type === defaultFilter.type)) {
          sourceConfig.filters.push(defaultFilter);
        }
      }
    }
  }

  // ── Seed default userMapping ──────────────────────────────────────────────
  // For any source that has no userMapping yet, initialize it from the source
  // module's defaultMapping so defaults become explicit, editable entries.
  // Sources without a defaultMapping are left as-is.
  for (const [id, sourceConfig] of Object.entries(config.sources)) {
    if (!Object.prototype.hasOwnProperty.call(sourceConfig, 'userMapping')) {
      const mod = SOURCE_MODULES[id];
      const settings = sourceConfig.settings;
      const defaultMapping = mod?.getDefaultMapping
        ? mod.getDefaultMapping(settings)
        : mod?.defaultMapping;
      if (defaultMapping) {
        sourceConfig.userMapping = { ...defaultMapping };
      }
    }
  }

  // ── Config v2 migration ────────────────────────────────────────────────────
  // Migrate from v1 (aspectRatioFilter + enabled sources) to v2
  // (globalFilters + virtual tags replace source selection).
  if (!config.configVersion || config.configVersion < 2) {
    // Migrate aspectRatioFilter → globalFilters orientation entry
    if (config.aspectRatioFilter && config.aspectRatioFilter !== 'all') {
      if (!config.globalFilters.some(f => f.type === 'orientation')) {
        config.globalFilters.push({
          type: 'orientation',
          mode: 'require',
          values: [config.aspectRatioFilter],
        });
      }
    }

    // Remove the legacy enabled field from all sources.
    // Sources are now active when referenced by virtual tags in tagsets.
    for (const sourceConfig of Object.values(config.sources)) {
      delete sourceConfig.enabled;
    }

    config.configVersion = 2;
    // Persist migration so it only runs once
    await writeWebSourcesConfig(frameArtPath, config);
    console.log('[web_sources] Migrated config to v2 (globalFilters, removed enabled field)');
  }

  return config;
}

/**
 * Write web sources config to web_sources.json.
 */
async function writeWebSourcesConfig(frameArtPath, config) {
  const configPath = webSourcesConfigPath(frameArtPath);
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Delete any existing display cache file(s) for a device.
 */
async function clearCacheForDevice(frameArtPath, deviceId) {
  for (const ext of ['jpg', 'jpeg', 'png', 'webp']) {
    for (const suffix of ['', '_original']) {
      try {
        await fs.unlink(cacheFileFor(frameArtPath, deviceId, ext, suffix));
      } catch {
        // File didn't exist – fine
      }
    }
  }
}

/**
 * Delete any existing staged cache file(s) for a device.
 */
async function clearStagedForDevice(frameArtPath, deviceId) {
  for (const ext of ['jpg', 'jpeg', 'png', 'webp']) {
    for (const suffix of ['_staged', '_staged_original']) {
      try {
        await fs.unlink(cacheFileFor(frameArtPath, deviceId, ext, suffix));
      } catch {
        // File didn't exist – fine
      }
    }
  }
}

/**
 * Delete the test cache image file (all extensions).
 */
async function clearTestCacheFile(frameArtPath) {
  for (const ext of ['jpg', 'jpeg', 'png', 'webp']) {
    for (const prefix of ['_test', '_test_raw', '_test_preprocessed']) {
      try {
        await fs.unlink(path.join(cacheDirFor(frameArtPath), `${prefix}.${ext}`));
      } catch {
        // File didn't exist – fine
      }
    }
  }
}

/**
 * Call the HA send_image service to upload an image to a TV.
 *
 * When select=true (default): uploads and selects the image as current artwork.
 * When select=false: uploads only (pre-upload pipeline).
 *
 * Always returns the content_id from the service response.
 */
async function sendImageToTV(imagePath, deviceId, {
  select = true,
  screenOn = true,
  matte = null,
  artworkMetadata = null,
} = {}) {
  if (!SUPERVISOR_TOKEN && process.env.NODE_ENV === 'development') {
    console.log(`[DEV] Would send ${imagePath} to device ${deviceId} (select=${select}, screenOn=${screenOn})`);
    return 'DEV_CONTENT_ID';
  }

  const response = await axios({
    method: 'POST',
    url: `${HA_API_BASE}/services/frame_art_shuffler/send_image?return_response`,
    headers: {
      Authorization: `Bearer ${SUPERVISOR_TOKEN}`,
      'Content-Type': 'application/json',
    },
    data: {
      device_id: deviceId,
      image_path: imagePath,
      select,
      ...(select && { screen_on: screenOn }),
      ...(matte && { matte }),
      ...(artworkMetadata && { artwork_metadata: artworkMetadata }),
    },
    timeout: select ? 60000 : 120000,
  });

  const serviceResponse = response.data?.service_response || response.data?.response || response.data;
  const contentId = serviceResponse?.content_id;
  if (!contentId) {
    throw new Error(`send_image service did not return a content_id. Response: ${JSON.stringify(response.data)}`);
  }
  return contentId;
}

/**
 * Compute the effective metadata mapping for a source.
 *
 * Effective = source module's defaultMapping (adjusted for current settings) merged
 * with any per-source userMapping stored in config. userMapping overrides defaults;
 * fields absent from userMapping fall back to the module's current defaults.
 *
 * This ensures that settings-dependent fields (e.g. google_art_wallpaper's rich fields
 * added when fetchRichMetadata is enabled) are included in the effective mapping even
 * if they were added after the initial userMapping was seeded.
 *
 * @param {string} sourceId
 * @param {object} userMapping - Stored user overrides from config.sources[id].userMapping
 * @param {object} [settings]  - Stored source settings (passed to getDefaultMapping if present)
 * @returns {object} Merged mapping: { fieldKey: null|string|{entity,attribute} }
 */
function getEffectiveMapping(sourceId, userMapping, settings) {
  const mod = SOURCE_MODULES[sourceId];
  const defaults = mod?.getDefaultMapping
    ? mod.getDefaultMapping(settings)
    : (mod?.defaultMapping || {});
  return { ...defaults, ...(userMapping || {}) };
}

/**
 * Apply an effective metadata mapping to artwork metadata, producing HA attribute snapshots.
 *
 * @param {object} artMetadata - Raw metadata from the source fetcher
 * @param {object} effectiveMapping - { fieldKey: null|string|{entity,attribute} }
 * @param {object} [options]
 * @param {Array}  [options.fieldDefs=[]] - Source field definitions (used to look up format types)
 * @param {boolean} [options.applyFormatting=true] - Whether to apply field formatters
 * @returns {{ attributeSnapshot, entitySnapshot }}
 */
function buildWebSourceSnapshot(artMetadata, effectiveMapping, { fieldDefs = [], applyFormatting = true } = {}) {
  const attributeSnapshot = {};
  const entitySnapshot = {};

  // Build a lookup from field key to format type (e.g. 'date') for quick access
  const formatMap = Object.fromEntries(
    fieldDefs.filter(f => f.format).map(f => [f.key, f.format])
  );

  for (const [sourceField, target] of Object.entries(effectiveMapping || {})) {
    const value = artMetadata[sourceField];
    if (value == null || target == null) continue;

    const formatted = applyFormatting
      ? applyFieldFormat(value, formatMap[sourceField])
      : String(value);

    if (typeof target === 'string') {
      attributeSnapshot[target] = formatted;
    } else if (target.entity && target.attribute) {
      if (!entitySnapshot[target.entity]) entitySnapshot[target.entity] = {};
      entitySnapshot[target.entity][target.attribute] = formatted;
    }
  }

  return { attributeSnapshot, entitySnapshot };
}

/**
 * Merge attributeSnapshot and entitySnapshot into a single flat metadata dict
 * suitable for passing to HA. Entity attributes are prefixed with the entity
 * type id: e.g. entitySnapshot.artist.Name → artist_name.
 */
function buildHaMetadata(attributeSnapshot, entitySnapshot) {
  const metadata = { ...attributeSnapshot };
  for (const [entityId, attrs] of Object.entries(entitySnapshot || {})) {
    for (const [attrName, value] of Object.entries(attrs)) {
      const key = `${entityId}_${attrName.toLowerCase().replace(/\s+/g, '_')}`;
      metadata[key] = value;
    }
  }
  return Object.keys(metadata).length > 0 ? metadata : null;
}

/**
 * Resolve the effective aspect ratio filter for a fetch operation.
 *
 * Reads from globalFilters (v2 config) first, falling back to the legacy
 * aspectRatioFilter field (v1 compat — should be gone after migration).
 *
 * 'match_tv' requires the caller to pass tvOrientation ('landscape' or 'portrait').
 * When tvOrientation is not provided (e.g. the integration doesn't yet support
 * orientation detection), falls back to 'all'.
 */
function resolveAspectRatioFilter(webSources, tvOrientation) {
  // v2: read from globalFilters orientation entry
  const orientationFilter = (webSources.globalFilters || []).find(
    f => f.type === 'orientation' && f.mode === 'require'
  );
  const setting = orientationFilter?.values?.[0] || webSources.aspectRatioFilter || 'all';

  if (setting === 'match_tv') {
    if (tvOrientation === 'landscape' || tvOrientation === 'portrait') return tvOrientation;
    console.warn('[web_sources] match_tv selected but tvOrientation not provided; falling back to "all"');
    return 'all';
  }
  return setting;
}

/**
 * Returns true if a source is compatible with the given aspect ratio filter.
 * A source with an aspectRatioConstraint is incompatible with the opposite filter:
 *   'landscape' constraint → incompatible with 'portrait' filter
 *   'portrait'  constraint → incompatible with 'landscape' filter
 */
function isSourceCompatible(sourceId, aspectRatio) {
  // Check source module first (v2), fall back to BUILTIN_SOURCES (v1 compat)
  const constraint = SOURCE_MODULES[sourceId]?.aspectRatioConstraint
    || BUILTIN_SOURCES[sourceId]?.aspectRatioConstraint;
  if (!constraint) return true;
  if (constraint === 'landscape' && aspectRatio === 'portrait') return false;
  if (constraint === 'portrait'  && aspectRatio === 'landscape') return false;
  return true;
}

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /api/web-sources/config
router.get('/config', async (req, res) => {
  try {
    const webSources = await readWebSourcesConfig(req.frameArtPath);
    const sourceConstraints = Object.fromEntries(
      Object.entries(SOURCE_MODULES)
        .filter(([id, mod]) => mod.aspectRatioConstraint || BUILTIN_SOURCES[id]?.aspectRatioConstraint)
        .map(([id, mod]) => [id, { aspectRatioConstraint: mod.aspectRatioConstraint || BUILTIN_SOURCES[id].aspectRatioConstraint }])
    );
    const sourceCapabilities = Object.fromEntries(
      Object.entries(SOURCE_MODULES).map(([id, mod]) => [id, {
        hasCookies: typeof mod.clearCookies === 'function',
      }])
    );
    res.json({
      success: true,
      webSources,
      settingsSchemas: SOURCE_SETTINGS_SCHEMAS,
      filterTypes: SOURCE_FILTER_TYPES,
      coreFilterTypes: CORE_FILTER_TYPES,
      sourceConstraints,
      sourceCapabilities,
      sourceMetadata: buildSourceMetadata(webSources),
      searchCapableSources: getSearchCapableSources(),
      artistCapableSources: getArtistCapableSources(),
      imageProcessingSchema: IMAGE_PROCESSING_SCHEMA,
    });
  } catch (error) {
    console.error('Error reading web sources config:', error);
    res.status(500).json({ error: 'Failed to read web sources config' });
  }
});

// PUT /api/web-sources/image-processing
router.put('/image-processing', async (req, res) => {
  try {
    const { preProcessor, cropEngine, preProcessorOptions, cropEngineOptions, skipLowRes, minResolution,
            unifiedProcessor, unifiedProcessorOptions, pipeline } = req.body;
    const validPreProcessors  = IMAGE_PROCESSING_SCHEMA.preProcessors.map(p => p.value);
    const validEngines        = IMAGE_PROCESSING_SCHEMA.cropEngines.map(e => e.value);
    const validUnified        = IMAGE_PROCESSING_SCHEMA.unifiedProcessors.map(p => p.value);
    if (preProcessor && !validPreProcessors.includes(preProcessor)) {
      return res.status(400).json({ error: `preProcessor must be one of: ${validPreProcessors.join(', ')}` });
    }
    if (cropEngine && !validEngines.includes(cropEngine)) {
      return res.status(400).json({ error: `cropEngine must be one of: ${validEngines.join(', ')}` });
    }
    if (unifiedProcessor !== undefined && unifiedProcessor !== null && !validUnified.includes(unifiedProcessor)) {
      return res.status(400).json({ error: `unifiedProcessor must be null or one of: ${validUnified.join(', ')}` });
    }
    if (pipeline !== undefined && pipeline !== null) {
      if (!Array.isArray(pipeline)) return res.status(400).json({ error: 'pipeline must be an array' });
      for (const step of pipeline) {
        if (!step?.key || !PROCESSORS[step.key]) {
          return res.status(400).json({ error: `Unknown pipeline step key: '${step?.key}'` });
        }
        if (step.options !== undefined && (typeof step.options !== 'object' || Array.isArray(step.options))) {
          return res.status(400).json({ error: `pipeline step '${step.key}' options must be an object` });
        }
      }
    }
    if (preProcessorOptions !== undefined && (typeof preProcessorOptions !== 'object' || Array.isArray(preProcessorOptions))) {
      return res.status(400).json({ error: 'preProcessorOptions must be an object' });
    }
    if (cropEngineOptions !== undefined && (typeof cropEngineOptions !== 'object' || Array.isArray(cropEngineOptions))) {
      return res.status(400).json({ error: 'cropEngineOptions must be an object' });
    }
    if (unifiedProcessorOptions !== undefined && (typeof unifiedProcessorOptions !== 'object' || Array.isArray(unifiedProcessorOptions))) {
      return res.status(400).json({ error: 'unifiedProcessorOptions must be an object' });
    }
    if (skipLowRes !== undefined && typeof skipLowRes !== 'boolean') {
      return res.status(400).json({ error: 'skipLowRes must be a boolean' });
    }
    if (minResolution !== undefined && (typeof minResolution !== 'number' || minResolution < 1 || !Number.isFinite(minResolution))) {
      return res.status(400).json({ error: 'minResolution must be a positive number' });
    }
    const webSources = await readWebSourcesConfig(req.frameArtPath);
    if (preProcessor           !== undefined) webSources.imageProcessing.preProcessor           = preProcessor;
    if (cropEngine             !== undefined) webSources.imageProcessing.cropEngine             = cropEngine;
    if (preProcessorOptions    !== undefined) webSources.imageProcessing.preProcessorOptions    = preProcessorOptions;
    if (cropEngineOptions      !== undefined) webSources.imageProcessing.cropEngineOptions      = cropEngineOptions;
    if (skipLowRes             !== undefined) webSources.imageProcessing.skipLowRes             = skipLowRes;
    if (minResolution          !== undefined) webSources.imageProcessing.minResolution          = minResolution;
    if (unifiedProcessor       !== undefined) webSources.imageProcessing.unifiedProcessor       = unifiedProcessor;
    if (unifiedProcessorOptions !== undefined) webSources.imageProcessing.unifiedProcessorOptions = unifiedProcessorOptions;
    if (pipeline               !== undefined) webSources.imageProcessing.pipeline               = pipeline;
    // Discard legacy flat option fields to avoid config cruft.
    delete webSources.imageProcessing.sharpStrategy;
    delete webSources.imageProcessing.detectionMode;
    delete webSources.imageProcessing.adaptiveFallback;
    await writeWebSourcesConfig(req.frameArtPath, webSources);
    res.json({ success: true, imageProcessing: webSources.imageProcessing });
  } catch (error) {
    console.error('Error updating image processing settings:', error);
    res.status(500).json({ error: 'Failed to update image processing settings' });
  }
});

// PUT /api/web-sources/aspect-ratio-filter
router.put('/aspect-ratio-filter', async (req, res) => {
  try {
    const { aspectRatioFilter } = req.body;
    const valid = ['all', 'landscape', 'portrait', 'match_tv'];
    if (!valid.includes(aspectRatioFilter)) {
      return res.status(400).json({ error: `aspectRatioFilter must be one of: ${valid.join(', ')}` });
    }
    const webSources = await readWebSourcesConfig(req.frameArtPath);
    webSources.aspectRatioFilter = aspectRatioFilter;
    await writeWebSourcesConfig(req.frameArtPath, webSources);
    res.json({ success: true, aspectRatioFilter });
  } catch (error) {
    console.error('Error updating aspect ratio filter:', error);
    res.status(500).json({ error: 'Failed to update aspect ratio filter' });
  }
});

// PUT /api/web-sources/format-dates
// Body: { enabled: boolean }
// Controls whether date fields are normalized on mapping (formatDates setting).
router.put('/format-dates', async (req, res) => {
  try {
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be a boolean' });
    }
    const webSources = await readWebSourcesConfig(req.frameArtPath);
    webSources.formatDates = enabled;
    await writeWebSourcesConfig(req.frameArtPath, webSources);
    res.json({ success: true, formatDates: enabled });
  } catch (error) {
    console.error('Error updating format-dates setting:', error);
    res.status(500).json({ error: 'Failed to update format-dates setting' });
  }
});

// PUT /api/web-sources/global-filters
// Body: { filters: [{type, mode, values}] }
// Replaces the stored global filter array. Each filter is validated against CORE_FILTER_TYPES.
// Global filters apply to ALL sources and cascade into per-source and virtual tag filters.
router.put('/global-filters', async (req, res) => {
  try {
    const { filters } = req.body;
    if (!Array.isArray(filters)) {
      return res.status(400).json({ error: 'filters must be an array' });
    }

    for (const filter of filters) {
      if (!filter.type || !filter.mode || !Array.isArray(filter.values)) {
        return res.status(400).json({ error: 'Each filter must have type (string), mode (string), and values (array)' });
      }
      const typeDef = CORE_FILTER_TYPES.find(ct => ct.type === filter.type);
      if (!typeDef) {
        return res.status(400).json({ error: `Filter type "${filter.type}" is not a recognized global filter type` });
      }
      if (!typeDef.modes.includes(filter.mode)) {
        return res.status(400).json({ error: `Mode "${filter.mode}" is not valid for global filter type "${filter.type}"` });
      }
    }

    const webSources = await readWebSourcesConfig(req.frameArtPath);
    webSources.globalFilters = filters;
    await writeWebSourcesConfig(req.frameArtPath, webSources);
    res.json({ success: true, globalFilters: filters });
  } catch (error) {
    console.error('Error updating global filters:', error);
    res.status(500).json({ error: 'Failed to update global filters' });
  }
});

// PUT /api/web-sources/sources/:sourceId/settings
router.put('/sources/:sourceId/settings', async (req, res) => {
  try {
    const { sourceId } = req.params;
    const { settings } = req.body;

    if (!BUILTIN_SOURCES[sourceId]) {
      return res.status(404).json({ error: `Unknown source: ${sourceId}` });
    }
    if (settings == null || typeof settings !== 'object' || Array.isArray(settings)) {
      return res.status(400).json({ error: 'settings must be an object' });
    }

    const webSources = await readWebSourcesConfig(req.frameArtPath);
    webSources.sources[sourceId] = {
      ...(webSources.sources[sourceId] || BUILTIN_SOURCES[sourceId]),
      settings,
    };
    await writeWebSourcesConfig(req.frameArtPath, webSources);
    res.json({ success: true, source: webSources.sources[sourceId] });
  } catch (error) {
    console.error('Error updating web source settings:', error);
    res.status(500).json({ error: 'Failed to update web source settings' });
  }
});

// GET /api/web-sources/sources/:sourceId/filter-types
// Returns the filter type definitions for a source — used by the UI filter builder.
router.get('/sources/:sourceId/filter-types', (req, res) => {
  const { sourceId } = req.params;
  if (!BUILTIN_SOURCES[sourceId]) {
    return res.status(404).json({ error: `Unknown source: ${sourceId}` });
  }
  res.json({ success: true, filterTypes: SOURCE_FILTER_TYPES[sourceId] || [] });
});

// PUT /api/web-sources/sources/:sourceId/filters
// Body: { filters: [{type, mode, values}] }
// Replaces the stored filter array for a source. Each filter is validated against
// the source's declared filter types. Source-level filters apply to all fetches
// from this source, including virtual tag fetches that target it.
router.put('/sources/:sourceId/filters', async (req, res) => {
  try {
    const { sourceId } = req.params;
    const { filters } = req.body;

    if (!BUILTIN_SOURCES[sourceId]) {
      return res.status(404).json({ error: `Unknown source: ${sourceId}` });
    }
    if (!Array.isArray(filters)) {
      return res.status(400).json({ error: 'filters must be an array' });
    }

    const filterTypes = SOURCE_FILTER_TYPES[sourceId] || [];
    for (const filter of filters) {
      if (!filter.type || !filter.mode || !Array.isArray(filter.values)) {
        return res.status(400).json({ error: 'Each filter must have type (string), mode (string), and values (array)' });
      }
      const typeDef = filterTypes.find(ft => ft.type === filter.type);
      if (!typeDef) {
        return res.status(400).json({ error: `Filter type "${filter.type}" is not supported for source "${sourceId}"` });
      }
      if (!typeDef.modes.includes(filter.mode)) {
        return res.status(400).json({ error: `Mode "${filter.mode}" is not valid for filter type "${filter.type}" on source "${sourceId}"` });
      }
    }

    const webSources = await readWebSourcesConfig(req.frameArtPath);
    webSources.sources[sourceId] = {
      ...(webSources.sources[sourceId] || BUILTIN_SOURCES[sourceId]),
      filters,
    };
    await writeWebSourcesConfig(req.frameArtPath, webSources);
    res.json({ success: true, filters });
  } catch (error) {
    console.error('Error updating source filters:', error);
    res.status(500).json({ error: 'Failed to update source filters' });
  }
});

// ── Virtual tag routes ────────────────────────────────────────────────────────

// GET /api/web-sources/virtual-tags
router.get('/virtual-tags', async (req, res) => {
  try {
    const webSources = await readWebSourcesConfig(req.frameArtPath);
    res.json({ success: true, virtualTags: webSources.virtualTags || {} });
  } catch (error) {
    console.error('Error reading virtual tags:', error);
    res.status(500).json({ error: 'Failed to read virtual tags' });
  }
});

// POST /api/web-sources/virtual-tags
// Body: { id, label, sourceId, queryMode?, queryParams?, filters? }
// Creates a new virtual tag. id must be a unique lowercase slug (a-z, 0-9, _, -).
// queryMode defaults to 'random'. filters are applied on top of the source's own filters.
router.post('/virtual-tags', async (req, res) => {
  try {
    const { id, label, sourceId, queryMode = 'random', queryParams = {}, filters = [] } = req.body;

    if (!id || typeof id !== 'string' || !/^[a-z0-9_-]+$/.test(id)) {
      return res.status(400).json({ error: 'id must be a non-empty lowercase slug (a-z, 0-9, _, -)' });
    }
    if (!label || typeof label !== 'string' || !label.trim()) {
      return res.status(400).json({ error: 'label is required' });
    }
    if (sourceId !== null && !BUILTIN_SOURCES[sourceId]) {
      return res.status(400).json({ error: `Unknown source: ${sourceId}` });
    }
    if (sourceId === null && !['search', 'artist'].includes(queryMode)) {
      return res.status(400).json({ error: 'sourceId: null requires queryMode: "search" or "artist"' });
    }
    if (!['random', 'search', 'artist'].includes(queryMode)) {
      return res.status(400).json({ error: 'queryMode must be one of: random, search, artist' });
    }
    if (!Array.isArray(filters)) {
      return res.status(400).json({ error: 'filters must be an array' });
    }

    const webSources = await readWebSourcesConfig(req.frameArtPath);
    if (webSources.virtualTags[id]) {
      return res.status(409).json({ error: `Virtual tag "${id}" already exists` });
    }

    const tag = { id, label: label.trim(), sourceId, queryMode, queryParams, filters };
    webSources.virtualTags[id] = tag;
    await writeWebSourcesConfig(req.frameArtPath, webSources);
    res.status(201).json({ success: true, virtualTag: tag });
  } catch (error) {
    console.error('Error creating virtual tag:', error);
    res.status(500).json({ error: 'Failed to create virtual tag' });
  }
});

// PUT /api/web-sources/virtual-tags/:id
// Body: { label?, sourceId?, queryMode?, queryParams?, filters? }
// Partial update — only provided fields are changed.
router.put('/virtual-tags/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { label, sourceId, queryMode, queryParams, filters } = req.body;

    const webSources = await readWebSourcesConfig(req.frameArtPath);
    if (!webSources.virtualTags[id]) {
      return res.status(404).json({ error: `Virtual tag "${id}" not found` });
    }
    if (sourceId !== undefined && sourceId !== null && !BUILTIN_SOURCES[sourceId]) {
      return res.status(400).json({ error: `Unknown source: ${sourceId}` });
    }
    if (queryMode !== undefined && !['random', 'search', 'artist'].includes(queryMode)) {
      return res.status(400).json({ error: 'queryMode must be one of: random, search, artist' });
    }
    if (filters !== undefined && !Array.isArray(filters)) {
      return res.status(400).json({ error: 'filters must be an array' });
    }

    const updated = {
      ...webSources.virtualTags[id],
      ...(label !== undefined && { label: label.trim() }),
      ...(sourceId !== undefined && { sourceId }),
      ...(queryMode !== undefined && { queryMode }),
      ...(queryParams !== undefined && { queryParams }),
      ...(filters !== undefined && { filters }),
    };
    webSources.virtualTags[id] = updated;
    await writeWebSourcesConfig(req.frameArtPath, webSources);
    res.json({ success: true, virtualTag: updated });
  } catch (error) {
    console.error('Error updating virtual tag:', error);
    res.status(500).json({ error: 'Failed to update virtual tag' });
  }
});

// DELETE /api/web-sources/virtual-tags/:id
router.delete('/virtual-tags/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const webSources = await readWebSourcesConfig(req.frameArtPath);
    if (!webSources.virtualTags[id]) {
      return res.status(404).json({ error: `Virtual tag "${id}" not found` });
    }
    delete webSources.virtualTags[id];
    await writeWebSourcesConfig(req.frameArtPath, webSources);
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting virtual tag:', error);
    res.status(500).json({ error: 'Failed to delete virtual tag' });
  }
});

// PUT /api/web-sources/sources/:sourceId/enable — REMOVED
// Sources are now active via virtual tags (no enable/disable toggle).
// The frontend manages default virtual tags directly via the virtual tag CRUD routes.

// PUT /api/web-sources/sources/:sourceId/metadata-mapping
// Body: { userMapping: { fieldKey: null|string|{entity,attribute} } }
// Saves per-source user overrides. Fields absent from userMapping fall back to
// auto-detected defaults (source module's defaultMapping hints).
router.put('/sources/:sourceId/metadata-mapping', async (req, res) => {
  try {
    const { sourceId } = req.params;
    const { userMapping } = req.body;

    if (!BUILTIN_SOURCES[sourceId]) {
      return res.status(404).json({ error: `Unknown source: ${sourceId}` });
    }
    if (userMapping == null || typeof userMapping !== 'object' || Array.isArray(userMapping)) {
      return res.status(400).json({ error: 'userMapping must be an object' });
    }

    // Validate each value: null, string, or { entity, attribute }
    for (const [key, val] of Object.entries(userMapping)) {
      if (
        val !== null &&
        typeof val !== 'string' &&
        !(typeof val === 'object' && typeof val.entity === 'string' && typeof val.attribute === 'string')
      ) {
        return res.status(400).json({
          error: `Invalid mapping value for "${key}": must be null, a string, or { entity, attribute }`,
        });
      }
    }

    const webSources = await readWebSourcesConfig(req.frameArtPath);
    webSources.sources[sourceId] = {
      ...(webSources.sources[sourceId] || BUILTIN_SOURCES[sourceId]),
      userMapping,
    };
    await writeWebSourcesConfig(req.frameArtPath, webSources);
    res.json({ success: true, userMapping });
  } catch (error) {
    console.error('Error updating metadata mapping:', error);
    res.status(500).json({ error: 'Failed to update metadata mapping' });
  }
});

// DELETE /api/web-sources/sources/:sourceId/metadata-mapping
// Clears all user mapping overrides. On next config read, defaults from the
// source module's defaultMapping are re-seeded into userMapping.
router.delete('/sources/:sourceId/metadata-mapping', async (req, res) => {
  try {
    const { sourceId } = req.params;
    if (!BUILTIN_SOURCES[sourceId]) {
      return res.status(404).json({ error: `Unknown source: ${sourceId}` });
    }

    const webSources = await readWebSourcesConfig(req.frameArtPath);
    if (webSources.sources[sourceId]) {
      delete webSources.sources[sourceId].userMapping;
    }
    await writeWebSourcesConfig(req.frameArtPath, webSources);
    res.json({ success: true });
  } catch (error) {
    console.error('Error resetting metadata mapping:', error);
    res.status(500).json({ error: 'Failed to reset metadata mapping' });
  }
});

// POST /api/web-sources/sources/:sourceId/clear-cookies
// Clears the source's cookie jar and allows re-seeding on the next fetch.
// Only available for sources that export a clearCookies() function.
router.post('/sources/:sourceId/clear-cookies', async (req, res) => {
  try {
    const { sourceId } = req.params;
    const mod = SOURCE_MODULES[sourceId];
    if (!mod) {
      return res.status(404).json({ error: `Unknown source: ${sourceId}` });
    }
    if (typeof mod.clearCookies !== 'function') {
      return res.status(400).json({ error: `Source "${sourceId}" does not use cookies` });
    }
    await mod.clearCookies();
    res.json({ success: true });
  } catch (error) {
    console.error('Error clearing source cookies:', error);
    res.status(500).json({ error: 'Failed to clear cookies' });
  }
});

/**
 * Shared setup for fetch-and-send: config read, virtual tag resolution, source
 * validation, filter cascade, fetch with low-res retry, image processing,
 * metadata mapping, and snapshot creation.
 *
 * Returns everything the endpoint needs to send to TV and commit cache.
 */
const MAX_RECENT_WEB_ARTWORKS = 30; // ring-buffer size for per-TV web source recency tracking

/**
 * Given a resolved virtual tag, fetch one artwork from the appropriate source.
 *
 * Handles two cases:
 *   - Regular tag (virtualTag.sourceId is set): validate source, merge filter cascade, fetch.
 *   - Unified search (virtualTag.sourceId is null, queryMode: 'search'): fan out to all
 *     search-capable sources in random order, return result from the first that succeeds.
 *
 * @param {object} webSources  - Loaded web sources config
 * @param {object} virtualTag  - The resolved virtual tag object
 * @param {string} aspectRatio - Resolved aspect ratio ('all', 'landscape', 'portrait')
 * @returns {{ chosenSourceId, fetchResult, mergedFilters, extraOpts }}
 * @throws Errors annotated with .statusCode (400/503)
 */
async function fetchFromVirtualTag(webSources, virtualTag, aspectRatio) {
  let chosenSourceId = virtualTag.sourceId;
  let mergedFilters, extraOpts, fetchResult;

  if (!chosenSourceId && virtualTag.queryMode === 'search') {
    // ── Unified keyword search ───────────────────────────────────────────────
    const keyword = virtualTag.queryParams?.keyword;
    if (!keyword) {
      throw Object.assign(new Error('Unified search virtual tag requires queryParams.keyword'), { statusCode: 400 });
    }

    const pool = getSearchCapableSources()
      .filter(id => BUILTIN_SOURCES[id])
      .filter(id => isSourceCompatible(id, aspectRatio));

    if (pool.length === 0) {
      throw Object.assign(
        new Error(`No search-capable sources available for aspect ratio "${aspectRatio}"`),
        { statusCode: 503 }
      );
    }

    // Draw sources one at a time using equal-weight random selection (splice from pool).
    // This guarantees each source has the same probability of being selected regardless
    // of response time or reliability — unlike shuffle+first-wins which biases toward
    // faster/more-reliable sources.
    let lastErr;
    const remaining = pool.slice();
    while (remaining.length > 0) {
      const idx = Math.floor(Math.random() * remaining.length);
      const candidateId = remaining.splice(idx, 1)[0];
      try {
        const searchFilter = { type: 'search', mode: 'require', values: [keyword] };
        const cFilters = mergeFilterCascade(
          webSources.globalFilters || [],
          webSources.sources[candidateId]?.filters || [],
          virtualTag.filters || []
        );
        cFilters.push(searchFilter);
        const cExtraOpts = SOURCE_MODULES[candidateId]?.getExtraOptions?.(
          webSources.sources[candidateId]?.settings
        ) || {};
        fetchResult    = await SOURCE_FETCHERS[candidateId](cFilters, { aspectRatio, ...cExtraOpts });
        chosenSourceId = candidateId;
        mergedFilters  = cFilters;
        extraOpts      = cExtraOpts;
        break;
      } catch (err) {
        console.warn(`[web_sources] Unified search "${keyword}": ${candidateId} failed — ${err.message}`);
        lastErr = err;
      }
    }

    if (!chosenSourceId) {
      throw Object.assign(
        new Error(`Unified search for "${keyword}": no source returned results. Last error: ${lastErr?.message}`),
        { statusCode: 503 }
      );
    }
  } else if (!chosenSourceId && virtualTag.queryMode === 'artist') {
    // ── Unified artist query ─────────────────────────────────────────────────
    const artist = virtualTag.queryParams?.artist;
    if (!artist) {
      throw Object.assign(new Error('Unified artist virtual tag requires queryParams.artist'), { statusCode: 400 });
    }

    const pool = getArtistCapableSources()
      .filter(id => BUILTIN_SOURCES[id])
      .filter(id => isSourceCompatible(id, aspectRatio));

    if (pool.length === 0) {
      throw Object.assign(
        new Error(`No artist-capable sources available for aspect ratio "${aspectRatio}"`),
        { statusCode: 503 }
      );
    }

    // If a preferred source was chosen upstream (count-weighted in shuffle.js), try it first.
    // Fall back to the remaining pool in random order if the preferred source fails.
    const preferred = virtualTag.preferredSourceId;
    const others = pool.filter(id => id !== preferred);
    const ordered = (preferred && pool.includes(preferred)) ? [preferred, ...others] : pool.slice();

    let lastErr;
    let tried = 0;
    for (const candidateId of ordered) {
      tried++;
      try {
        const artistFilter = { type: 'artist', mode: 'require', values: [artist] };
        const cFilters = mergeFilterCascade(
          webSources.globalFilters || [],
          webSources.sources[candidateId]?.filters || [],
          virtualTag.filters || []
        );
        cFilters.push(artistFilter);
        const cExtraOpts = SOURCE_MODULES[candidateId]?.getExtraOptions?.(
          webSources.sources[candidateId]?.settings
        ) || {};
        fetchResult    = await SOURCE_FETCHERS[candidateId](cFilters, { aspectRatio, ...cExtraOpts });
        chosenSourceId = candidateId;
        mergedFilters  = cFilters;
        extraOpts      = cExtraOpts;
        break;
      } catch (err) {
        console.warn(`[web_sources] Unified artist "${artist}": ${candidateId} failed — ${err.message}`);
        lastErr = err;
        // After preferred source fails, shuffle the remaining candidates for equal fallback probability
        if (tried === 1 && preferred) {
          for (let i = ordered.length - 1; i > 1; i--) {
            const j = 1 + Math.floor(Math.random() * i);
            [ordered[i], ordered[j]] = [ordered[j], ordered[i]];
          }
        }
      }
    }

    if (!chosenSourceId) {
      throw Object.assign(
        new Error(`Unified artist "${artist}": no source returned results. Last error: ${lastErr?.message}`),
        { statusCode: 503 }
      );
    }
  } else {
    // ── Regular virtual tag (fixed sourceId) ────────────────────────────────
    if (!chosenSourceId) {
      throw Object.assign(new Error('Virtual tag has no sourceId'), { statusCode: 400 });
    }
    if (!isSourceCompatible(chosenSourceId, aspectRatio)) {
      throw Object.assign(
        new Error(`Source "${chosenSourceId}" is not compatible with the current orientation filter (${aspectRatio})`),
        { statusCode: 400 }
      );
    }
    if (!BUILTIN_SOURCES[chosenSourceId]) {
      throw Object.assign(new Error(`Unknown source: ${chosenSourceId}`), { statusCode: 400 });
    }
    const fetcher = SOURCE_FETCHERS[chosenSourceId];
    if (!fetcher) {
      throw Object.assign(new Error(`Source "${chosenSourceId}" is not yet implemented`), { statusCode: 400 });
    }

    const globalFilters = webSources.globalFilters || [];
    const sourceFilters = webSources.sources[chosenSourceId]?.filters || [];
    const tagFilters    = virtualTag.filters || [];
    mergedFilters = mergeFilterCascade(globalFilters, sourceFilters, tagFilters);
    extraOpts     = SOURCE_MODULES[chosenSourceId]?.getExtraOptions?.(webSources.sources[chosenSourceId]?.settings) || {};
    fetchResult   = await fetcher(mergedFilters, { aspectRatio, ...extraOpts });
  }

  return { chosenSourceId, fetchResult, mergedFilters, extraOpts };
}

async function fetchAndProcessWebSource(req, { sourceId, virtualTagId, tvOrientation, deviceId }) {
  const webSources = await readWebSourcesConfig(req.frameArtPath);
  const aspectRatio = resolveAspectRatioFilter(webSources, tvOrientation);

  // Resolve virtual tag → sourceId + extra filters
  let virtualTag = null;
  let chosenSourceId = sourceId;
  if (virtualTagId) {
    virtualTag = webSources.virtualTags[virtualTagId];
    if (!virtualTag) {
      const err = new Error(`Virtual tag "${virtualTagId}" not found`);
      err.statusCode = 404;
      throw err;
    }
    chosenSourceId = virtualTag.sourceId;
  }

  let prefetchedResult = null;
  let mergedFilters, extraOpts;

  if (virtualTagId) {
    // Virtual tag dispatch — handles both regular and unified-search tags.
    ({ chosenSourceId, fetchResult: prefetchedResult, mergedFilters, extraOpts }
      = await fetchFromVirtualTag(webSources, virtualTag, aspectRatio));
  } else {
    // Direct source selection (no virtual tag).
    if (!chosenSourceId) {
      const err = new Error('Either virtualTagId or sourceId is required.');
      err.statusCode = 400;
      throw err;
    }
    if (!isSourceCompatible(chosenSourceId, aspectRatio)) {
      const err = new Error(`Source "${chosenSourceId}" is not compatible with the current orientation filter (${aspectRatio})`);
      err.statusCode = 400;
      throw err;
    }
    if (!BUILTIN_SOURCES[chosenSourceId]) {
      const err = new Error(`Unknown source: ${chosenSourceId}`);
      err.statusCode = 400;
      throw err;
    }
    if (!SOURCE_FETCHERS[chosenSourceId]) {
      const err = new Error(`Source "${chosenSourceId}" is not yet implemented`);
      err.statusCode = 400;
      throw err;
    }
    mergedFilters = mergeFilterCascade(
      webSources.globalFilters || [],
      webSources.sources[chosenSourceId]?.filters || [],
      []
    );
    extraOpts = SOURCE_MODULES[chosenSourceId]?.getExtraOptions?.(webSources.sources[chosenSourceId]?.settings) || {};
  }

  const fetcher = SOURCE_FETCHERS[chosenSourceId];

  // Fetch, with optional retry when the image is below the minimum resolution threshold
  // or has been recently shown on this TV (recency deduplication).
  const { skipLowRes, minResolution = 1080 } = webSources.imageProcessing;
  const recentArtworkIds = new Set(webSources.webSourceRecency?.[deviceId] || []);
  const MAX_FETCH_ATTEMPTS = 5;
  let fetchResult;
  for (let attempt = 0; attempt < MAX_FETCH_ATTEMPTS; attempt++) {
    // On the first attempt for a virtual tag, reuse the result already fetched
    // by fetchFromVirtualTag to avoid a redundant round-trip to the source.
    fetchResult = (attempt === 0 && prefetchedResult) ? prefetchedResult : await fetcher(mergedFilters, { aspectRatio, ...extraOpts });
    const isLast = attempt === MAX_FETCH_ATTEMPTS - 1;

    if (skipLowRes) {
      const { width, height } = await sharp(fetchResult.imageBuffer).metadata();
      const shortSide = Math.min(width, height);
      if (shortSide < minResolution) {
        if (!isLast) {
          console.warn(`[web_sources] Low-res image (${width}×${height}, short side ${shortSide} < ${minResolution}); retrying (attempt ${attempt + 1}/${MAX_FETCH_ATTEMPTS})`);
          continue;
        }
        console.warn(`[web_sources] All ${MAX_FETCH_ATTEMPTS} attempts returned low-res images; using last result`);
      }
    }

    if (recentArtworkIds.size > 0) {
      const artworkId = fetchResult.metadata?.artworkUrl;
      if (artworkId && recentArtworkIds.has(artworkId)) {
        if (!isLast) {
          console.log(`[web_sources] Recently shown artwork; retrying (attempt ${attempt + 1}/${MAX_FETCH_ATTEMPTS})`);
          continue;
        }
        console.log(`[web_sources] All ${MAX_FETCH_ATTEMPTS} attempts returned recently shown artwork; using last result`);
      }
    }

    break;
  }
  const { imageBuffer, contentType, metadata: artMetadata } = fetchResult;

  const orientation = tvOrientation || 'landscape';
  const { pipeline, unifiedProcessor, unifiedProcessorOptions = {},
          preProcessor, cropEngine, preProcessorOptions = {}, cropEngineOptions = {} } = webSources.imageProcessing;
  const alreadyProcessed = !!SOURCE_MODULES[chosenSourceId]?.alreadyProcessed;
  let processedBuffer;
  if (alreadyProcessed) {
    processedBuffer = imageBuffer;
  } else if (pipeline) {
    const label = artMetadata?.artworkUrl;
    ({ buffer: processedBuffer } = await runPipeline(imageBuffer, orientation,
      pipeline.map(s => s.key === 'background_strip' ? s : { ...s, options: { label, ...s.options } })
    ));
  } else if (unifiedProcessor) {
    ({ buffer: processedBuffer } = await runPipeline(imageBuffer, orientation, [
      { key: 'background_strip' },
      { key: unifiedProcessor, options: { label: artMetadata?.artworkUrl, ...unifiedProcessorOptions } },
    ]));
  } else {
    processedBuffer = await processWebSourceImage(imageBuffer, orientation, {
      preProcess: preProcessor !== 'none' ? preProcessor : null,
      preProcessOptions: { label: artMetadata?.artworkUrl, ...preProcessorOptions },
      cropEngine,
      cropEngineOptions,
    });
  }

  const ext = contentType.includes('png') ? 'png' : 'jpg';

  const userMapping = webSources.sources[chosenSourceId]?.userMapping || {};
  const sourceSettings = webSources.sources?.[chosenSourceId]?.settings;
  const effectiveMapping = getEffectiveMapping(chosenSourceId, userMapping, sourceSettings);
  const sourceMod = SOURCE_MODULES[chosenSourceId];
  const fieldDefs = sourceMod?.getMetadataFields
    ? sourceMod.getMetadataFields(sourceSettings)
    : (sourceMod?.metadataFields || []);
  const { attributeSnapshot, entitySnapshot } = buildWebSourceSnapshot(artMetadata, effectiveMapping, {
    fieldDefs,
    applyFormatting: webSources.formatDates !== false,
  });

  return {
    processedBuffer, imageBuffer, ext, artMetadata,
    attributeSnapshot, entitySnapshot, chosenSourceId,
    virtualTagId, webSources,
  };
}

// POST /api/web-sources/fetch-and-send
// Body: { deviceId, select: true|false, screenOn?, matte?, virtualTagId?, sourceId?, tvOrientation? }
//
// select=true (default): fetch, process, upload+select on TV, commit cache.
// select=false: fetch, process, upload only (pre-upload pipeline), commit cache.
//
// Always returns { success, contentId, sourceId, virtualTagId?, metadata,
//   artworkMetadata, cacheFile }.
router.post('/fetch-and-send', async (req, res) => {
  const { deviceId, select = true, sourceId, virtualTagId, screenOn = true, matte, tvOrientation } = req.body;

  if (!deviceId) {
    return res.status(400).json({ error: 'deviceId is required' });
  }

  try {
    const MAX_BLACKLIST_RETRIES = 5;
    let fetchResult;
    const helper = new MetadataHelper(req.frameArtPath);
    for (let attempt = 0; attempt < MAX_BLACKLIST_RETRIES; attempt++) {
      fetchResult = await fetchAndProcessWebSource(req, { sourceId, virtualTagId, tvOrientation, deviceId });
      const artworkUrl = fetchResult.artMetadata?.artworkUrl;
      if (!artworkUrl || !(await helper.isBlacklisted('web', artworkUrl))) break;
      console.log(`[fetch-and-send] Skipping blacklisted artwork (attempt ${attempt + 1}): ${artworkUrl}`);
      if (attempt === MAX_BLACKLIST_RETRIES - 1) {
        return res.status(503).json({ error: 'All fetched artworks are blacklisted; try again later' });
      }
    }
    const {
      processedBuffer, imageBuffer, ext, artMetadata,
      attributeSnapshot, entitySnapshot, chosenSourceId,
      virtualTagId: resolvedVirtualTagId, webSources,
    } = fetchResult;

    const cacheDir = cacheDirFor(req.frameArtPath);
    await fs.mkdir(cacheDir, { recursive: true });

    // Use different pending suffixes to avoid race conditions when
    // pre-upload (select=false) and shuffle (select=true) run concurrently
    const pendingSuffix = select ? '_pending' : '_staged_pending';
    const pendingFile = cacheFileFor(req.frameArtPath, deviceId, ext, pendingSuffix);
    await fs.writeFile(pendingFile, processedBuffer);

    const artworkMetadata = buildHaMetadata(attributeSnapshot, entitySnapshot);

    // Send to TV
    let contentId;
    try {
      contentId = await sendImageToTV(pendingFile, deviceId, {
        select,
        screenOn,
        matte,
        artworkMetadata,
      });
    } catch (sendError) {
      await fs.unlink(pendingFile).catch(() => {});
      throw sendError;
    }

    // Send succeeded — commit cache.
    // select=true: commit to display cache (perTvCache + main files).
    // select=false: commit to staging area (stagedCache + _staged files).
    //   The staged cache is promoted to display cache when the fast-path
    //   shuffle selects the image via POST /cache/:deviceId/promote.
    const cacheEntry = {
      filename: `${deviceId}.${ext}`,
      originalFilename: `${deviceId}_original.${ext}`,
      sourceId: chosenSourceId,
      ...(resolvedVirtualTagId && { virtualTagId: resolvedVirtualTagId }),
      artworkUrl: artMetadata.artworkUrl,
      // imageBaseUrl: bare CDN URL (before size/crop suffix), if the source provides one.
      // Used by the artwork web view to serve an uncropped version of the image.
      ...(artMetadata.imageBaseUrl && { imageBaseUrl: artMetadata.imageBaseUrl }),
      metadata: artMetadata,
      ...(Object.keys(attributeSnapshot).length > 0 && { attributeSnapshot }),
      ...(Object.keys(entitySnapshot).length > 0 && { entitySnapshot }),
      fetchedAt: new Date().toISOString(),
    };

    let cacheFile;
    if (select) {
      await clearCacheForDevice(req.frameArtPath, deviceId);
      await clearStagedForDevice(req.frameArtPath, deviceId);
      cacheFile = cacheFileFor(req.frameArtPath, deviceId, ext);
      await fs.rename(pendingFile, cacheFile);
      await fs.writeFile(
        cacheFileFor(req.frameArtPath, deviceId, ext, '_original'), imageBuffer
      );
      webSources.perTvCache[deviceId] = cacheEntry;
      delete webSources.stagedCache?.[deviceId];
      // Update recency ring buffer (tracks what has actually been displayed)
      const artworkId = artMetadata.artworkUrl;
      if (artworkId) {
        if (!webSources.webSourceRecency) webSources.webSourceRecency = {};
        const prev = webSources.webSourceRecency[deviceId] || [];
        webSources.webSourceRecency[deviceId] = [
          ...prev.filter(id => id !== artworkId), artworkId,
        ].slice(-MAX_RECENT_WEB_ARTWORKS);
      }
    } else {
      await clearStagedForDevice(req.frameArtPath, deviceId);
      cacheFile = cacheFileFor(req.frameArtPath, deviceId, ext, '_staged');
      await fs.rename(pendingFile, cacheFile);
      await fs.writeFile(
        cacheFileFor(req.frameArtPath, deviceId, ext, '_staged_original'), imageBuffer
      );
      if (!webSources.stagedCache) webSources.stagedCache = {};
      webSources.stagedCache[deviceId] = cacheEntry;
    }
    await writeWebSourcesConfig(req.frameArtPath, webSources);

    // Best-effort: enrich entity instances with data from the web source.
    // Existing instances: patch empty fields only (content wins).
    // Unknown artists: fire-and-forget Wikidata auto-link with lifespan validation.
    // All failures are non-fatal.
    if (Object.keys(entitySnapshot).length > 0) {
      try {
        const metadata = await helper.readMetadata();
        for (const [entityId, snapshotAttrs] of Object.entries(entitySnapshot)) {
          const entityType = (metadata.entityTypes || []).find(e => e.id === entityId);
          if (!entityType || !entityType.attributes.length) continue;
          const keyAttr = entityType.attributes[0];
          const keyValue = String(snapshotAttrs[keyAttr] || '').trim();
          if (!keyValue) continue;
          const key = helper.slugify(keyValue);
          if ((metadata.entityInstances?.[entityId] || {})[key]) {
            await helper.patchEntityInstance(entityId, key, snapshotAttrs);
          } else if (entityType.kind === 'artist') {
            autoLinkArtistFromWebSource(helper, entityId, entityType, snapshotAttrs)
              .catch(err => console.warn('[fetch-and-send] Auto-link failed (non-fatal):', err.message));
          }
        }
      } catch (err) {
        console.warn('[fetch-and-send] Entity enrichment failed (non-fatal):', err.message);
      }
    }

    res.json({
      success: true,
      contentId,
      sourceId: chosenSourceId,
      ...(resolvedVirtualTagId && { virtualTagId: resolvedVirtualTagId }),
      metadata: artMetadata,
      artworkMetadata,
      cacheFile: path.basename(cacheFile),
    });
  } catch (error) {
    const status = error.statusCode || 500;
    console.error('Error in fetch-and-send:', error.message || error);
    res.status(status).json({ error: error.message || 'Failed to fetch and send web source image' });
  }
});

// DELETE /api/web-sources/cache/:deviceId
// Called when a library image is displayed, to clean up the web source cache.
router.delete('/cache/:deviceId', async (req, res) => {
  try {
    const { deviceId } = req.params;
    const webSources = await readWebSourcesConfig(req.frameArtPath);

    await clearCacheForDevice(req.frameArtPath, deviceId);
    await clearStagedForDevice(req.frameArtPath, deviceId);

    let dirty = false;
    if (webSources.perTvCache?.[deviceId]) {
      delete webSources.perTvCache[deviceId];
      dirty = true;
    }
    if (webSources.stagedCache?.[deviceId]) {
      delete webSources.stagedCache[deviceId];
      dirty = true;
    }
    if (dirty) await writeWebSourcesConfig(req.frameArtPath, webSources);

    res.json({ success: true });
  } catch (error) {
    console.error('Error clearing web source cache:', error);
    res.status(500).json({ error: 'Failed to clear cache' });
  }
});

// POST /api/web-sources/cache/:deviceId/promote
// Promotes a staged pre-upload cache entry to the display cache.
// Called by the fast-path shuffle after select_and_cleanup succeeds.
router.post('/cache/:deviceId/promote', async (req, res) => {
  try {
    const { deviceId } = req.params;
    const webSources = await readWebSourcesConfig(req.frameArtPath);

    const staged = webSources.stagedCache?.[deviceId];
    if (!staged) {
      return res.status(404).json({ error: 'No staged cache for this device' });
    }

    // Determine extension from staged filename
    const ext = path.extname(staged.filename).slice(1) || 'jpg';
    const stagedFile = cacheFileFor(req.frameArtPath, deviceId, ext, '_staged');
    const stagedOriginal = cacheFileFor(req.frameArtPath, deviceId, ext, '_staged_original');

    // Move staged files to display cache
    await clearCacheForDevice(req.frameArtPath, deviceId);
    try {
      await fs.rename(stagedFile, cacheFileFor(req.frameArtPath, deviceId, ext));
    } catch {
      // Staged file missing — metadata-only promote is still useful
    }
    try {
      await fs.rename(stagedOriginal, cacheFileFor(req.frameArtPath, deviceId, ext, '_original'));
    } catch {
      // Original file missing — not fatal
    }

    // Promote metadata and update recency ring buffer
    webSources.perTvCache[deviceId] = staged;
    delete webSources.stagedCache[deviceId];
    const artworkId = staged.artworkUrl;
    if (artworkId) {
      if (!webSources.webSourceRecency) webSources.webSourceRecency = {};
      const prev = webSources.webSourceRecency[deviceId] || [];
      webSources.webSourceRecency[deviceId] = [
        ...prev.filter(id => id !== artworkId), artworkId,
      ].slice(-MAX_RECENT_WEB_ARTWORKS);
    }
    await writeWebSourcesConfig(req.frameArtPath, webSources);

    const displayCacheFile = path.basename(cacheFileFor(req.frameArtPath, deviceId, ext));
    res.json({ success: true, cacheFile: displayCacheFile });
  } catch (error) {
    console.error('Error promoting staged cache:', error);
    res.status(500).json({ error: 'Failed to promote staged cache' });
  }
});

// POST /api/web-sources/cache/:deviceId/add-to-library
// Copies the current web source cache entry (cropped + original) into the local library.
// Body: { title? } — optional custom title for the filename base.
router.post('/cache/:deviceId/add-to-library', async (req, res) => {
  const { deviceId } = req.params;
  const { title } = req.body || {};

  try {
    const webSources = await readWebSourcesConfig(req.frameArtPath);
    const cacheEntry = webSources.perTvCache?.[deviceId] || webSources.stagedCache?.[deviceId];

    if (!cacheEntry) {
      return res.status(404).json({ error: 'No cached web source image for this device' });
    }

    const ext = path.extname(cacheEntry.filename).slice(1) || 'jpg';
    const croppedSrc = cacheFileFor(req.frameArtPath, deviceId, ext);
    const originalSrc = cacheFileFor(req.frameArtPath, deviceId, ext, '_original');

    // Build a filesystem-safe base name from the title or a fallback
    const rawBase = (title || cacheEntry.metadata?.title || 'web-source')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'web-source';
    const uuid = crypto.randomUUID().split('-')[0];
    const filename = `${rawBase}-${uuid}.${ext}`;

    const libraryPath = path.join(req.frameArtPath, 'library');
    const originalsPath = path.join(req.frameArtPath, 'originals');
    await fs.mkdir(libraryPath, { recursive: true });
    await fs.mkdir(originalsPath, { recursive: true });

    await fs.copyFile(croppedSrc, path.join(libraryPath, filename));
    // Original may not exist (e.g. no processing applied) — non-fatal
    await fs.copyFile(originalSrc, path.join(originalsPath, filename)).catch(() => {});

    const helper = new MetadataHelper(req.frameArtPath);
    const imageData = await helper.addImage(filename);

    // Apply attribute snapshot
    if (cacheEntry.attributeSnapshot && Object.keys(cacheEntry.attributeSnapshot).length > 0) {
      const attrs = Object.fromEntries(
        Object.entries(cacheEntry.attributeSnapshot).map(([k, v]) => [k, String(v ?? '')])
      );
      await helper.updateImage(filename, { attributes: attrs });
      imageData.attributes = { ...(imageData.attributes || {}), ...attrs };
    }

    // Preserve artwork URL as a first-class field for future provenance
    if (cacheEntry.artworkUrl) {
      await helper.updateImage(filename, { artworkUrl: cacheEntry.artworkUrl });
      imageData.artworkUrl = cacheEntry.artworkUrl;
    }

    // Apply entity snapshot — upsert instances and link to the image
    if (cacheEntry.entitySnapshot && Object.keys(cacheEntry.entitySnapshot).length > 0) {
      const entityRefs = {};
      for (const [entityId, snapshotAttrs] of Object.entries(cacheEntry.entitySnapshot)) {
        try {
          const result = await helper.upsertEntityInstance(entityId, snapshotAttrs);
          entityRefs[entityId] = result.key;
        } catch (e) {
          // skip invalid entity data
        }
      }
      if (Object.keys(entityRefs).length > 0) {
        await helper.updateImage(filename, { entityRefs });
        imageData.entityRefs = { ...(imageData.entityRefs || {}), ...entityRefs };
      }
    }

    // Generate thumbnail (best-effort)
    await helper.generateThumbnail(filename).catch(err => {
      console.warn('[add-to-library] Thumbnail generation failed:', err.message);
    });

    res.json({ success: true, filename, data: imageData });
  } catch (error) {
    console.error('[add-to-library] Error:', error.message);
    res.status(500).json({ error: 'Failed to add image to library' });
  }
});

/**
 * Resolve a specific image request (URL or ID) to a source ID and fetch result.
 * Supports:
 *   - Met Museum collection URL (metmuseum.org/art/collection/search/<id>)
 *   - Numeric string (assumed to be a Met Museum object ID)
 *   - Any other HTTP(S) URL (downloaded directly; metadata is minimal)
 *
 * @param {string} specificImage
 * @param {object} [options]
 * @param {'landscape'|'portrait'} [options.tvOrientation] - TV orientation, passed to source
 *   modules that need it for resolution decisions (e.g. dezoomify threshold selection).
 * @param {object} [options.webSources] - Web sources config; passed to source modules so
 *   fetchByIdentifier can respect per-source settings (e.g. fetchRichMetadata).
 * @returns {{ chosenSourceId, imageBuffer, contentType, artMetadata }}
 */
async function fetchSpecificImage(specificImage, { tvOrientation, webSources } = {}) {
  const trimmed = specificImage.trim();

  // Ask each source module if it can handle this identifier. Modules are checked
  // in SOURCE_MODULES definition order, so more-specific patterns (e.g. google_arts
  // before google_art_wallpaper for the shared artsandculture.google.com domain) win.
  for (const [sourceId, mod] of Object.entries(SOURCE_MODULES)) {
    if (mod.canHandleIdentifier?.(trimmed)) {
      const sourceSettings = webSources?.sources?.[sourceId]?.settings;
      const result = await mod.fetchByIdentifier(trimmed, { tvOrientation, settings: sourceSettings });
      return { chosenSourceId: sourceId, ...result, artMetadata: result.metadata };
    }
  }

  // Fallback: arbitrary HTTP(S) URL → download directly, no source-specific processing.
  if (/^https?:\/\//i.test(trimmed)) {
    const imageResponse = await axios.get(trimmed, { responseType: 'arraybuffer', timeout: 30000 });
    const imageBuffer = Buffer.from(imageResponse.data);
    const contentType = imageResponse.headers['content-type'] || 'image/jpeg';
    return {
      chosenSourceId: null,
      imageBuffer,
      contentType,
      artMetadata: { artworkUrl: trimmed, source: 'Direct URL' },
    };
  }

  throw new Error(`Cannot interpret "${specificImage}" as a known source identifier or image URL`);
}

// POST /api/web-sources/test-fetch
// Fetch a test image from an enabled web source without sending it to any TV.
// Stores the result in webSources.testCache (same structure as perTvCache entries).
//
// Body: { tvOrientation?, specificImage?, virtualTagId?, sourceId?, filters? }
// - virtualTagId: use the virtual tag's sourceId and merge its filters through the cascade.
// - sourceId + filters: ad-hoc mode — use the given source with the provided filters
//   (merged with global + source-level filters). No virtual tag needed.
// - specificImage: fetch a specific image (Met Museum ID, URL, etc.) — ignores source selection.
// - tvOrientation: used when orientation filter is 'match_tv'. Defaults to 'landscape'.
router.post('/test-fetch', async (req, res) => {
  try {
    const { tvOrientation, specificImage, virtualTagId, sourceId: adHocSourceId, filters: adHocFilters } = req.body || {};
    const webSources = await readWebSourcesConfig(req.frameArtPath);
    const aspectRatio = resolveAspectRatioFilter(webSources, tvOrientation);

    // Resolve virtual tag if provided
    let virtualTag = null;
    if (virtualTagId) {
      virtualTag = webSources.virtualTags[virtualTagId];
      if (!virtualTag) {
        return res.status(404).json({ error: `Virtual tag "${virtualTagId}" not found` });
      }
    }

    let chosenSourceId, imageBuffer, contentType, artMetadata;
    const fetchTrace = { aspectRatio };

    if (specificImage && specificImage.trim()) {
      // Fetch a specific image rather than a random one.
      fetchTrace.path = 'specific';
      fetchTrace.specificImage = specificImage;
      ({ chosenSourceId, imageBuffer, contentType, artMetadata } = await fetchSpecificImage(specificImage, { tvOrientation, webSources }));
      // If source could not be determined (direct URL), fall back to first source with
      // a virtual tag for processing pipeline metadata (alreadyProcessed flag, effectiveMapping).
      if (!chosenSourceId) {
        const firstTagSource = Object.values(webSources.virtualTags)[0]?.sourceId;
        chosenSourceId = firstTagSource || Object.keys(SOURCE_MODULES)[0];
      }
    } else if (adHocSourceId) {
      // Ad-hoc mode: source + inline filters, no virtual tag needed.
      chosenSourceId = adHocSourceId;
      const fetcher = SOURCE_FETCHERS[chosenSourceId];
      if (!fetcher) {
        return res.status(400).json({ error: `Source "${chosenSourceId}" is not yet implemented` });
      }
      const globalFilters = webSources.globalFilters || [];
      const sourceFilters = webSources.sources[chosenSourceId]?.filters || [];
      const mergedFilters = mergeFilterCascade(globalFilters, sourceFilters, adHocFilters || []);
      const sourceModule = SOURCE_MODULES[chosenSourceId];
      const modeInfo = sourceModule?.selectMode?.(mergedFilters) || { mode: 'unknown' };
      fetchTrace.path = 'ad-hoc';
      fetchTrace.mode = modeInfo.mode;
      fetchTrace.globalFilters = globalFilters;
      fetchTrace.sourceFilters = sourceFilters;
      fetchTrace.adHocFilters = adHocFilters || [];
      fetchTrace.mergedFilters = mergedFilters;
      const extraOpts = sourceModule?.getExtraOptions?.(webSources.sources[chosenSourceId]?.settings) || {};
      ({ imageBuffer, contentType, metadata: artMetadata } = await fetcher(mergedFilters, { aspectRatio, ...extraOpts }));
    } else {
      // Virtual tag determines source — delegate to shared dispatch helper.
      let vtFetch;
      try {
        vtFetch = await fetchFromVirtualTag(webSources, virtualTag, aspectRatio);
      } catch (err) {
        return res.status(err.statusCode || 500).json({ error: err.message });
      }
      chosenSourceId = vtFetch.chosenSourceId;
      imageBuffer    = vtFetch.fetchResult.imageBuffer;
      contentType    = vtFetch.fetchResult.contentType;
      artMetadata    = vtFetch.fetchResult.metadata;
      const modeInfo = SOURCE_MODULES[chosenSourceId]?.selectMode?.(vtFetch.mergedFilters) || { mode: 'unknown' };
      fetchTrace.virtualTagId = virtualTagId;
      fetchTrace.mode = modeInfo.mode;
      if (!virtualTag.sourceId && virtualTag.queryMode === 'search') {
        fetchTrace.path = 'unified-search';
        fetchTrace.keyword = virtualTag.queryParams?.keyword;
        fetchTrace.sourceId = chosenSourceId;
        fetchTrace.mergedFilters = vtFetch.mergedFilters;
      } else {
        fetchTrace.path = 'virtual-tag';
        fetchTrace.globalFilters = webSources.globalFilters || [];
        fetchTrace.sourceFilters = webSources.sources[chosenSourceId]?.filters || [];
        fetchTrace.tagFilters = virtualTag?.filters || [];
        fetchTrace.mergedFilters = vtFetch.mergedFilters;
      }
    }

    const orientation = tvOrientation || 'landscape';
    const { pipeline, unifiedProcessor, unifiedProcessorOptions = {},
            preProcessor, cropEngine, preProcessorOptions = {}, cropEngineOptions = {} } = webSources.imageProcessing;
    const alreadyProcessed = !!SOURCE_MODULES[chosenSourceId]?.alreadyProcessed;

    let processedBuffer;
    let preprocessedBuffer = null;
    let preprocessedFilename = null;
    let processingInfo = null;

    if (alreadyProcessed) {
      processedBuffer = imageBuffer;
    } else if (pipeline) {
      // Pipeline mode: single runPipeline call (no separate intermediate).
      const label = artMetadata?.artworkUrl;
      const pipelineResult = await runPipeline(imageBuffer, orientation,
        pipeline.map(s => s.key === 'background_strip' ? s : { ...s, options: { label, ...s.options } })
      );
      processedBuffer = pipelineResult.buffer;
      processingInfo = { mode: 'pipeline', pipeline, debug: pipelineResult.debug };
    } else if (unifiedProcessor) {
      // Unified mode: single pipeline pass (no separate Phase 2 intermediate).
      const pipelineResult = await runPipeline(imageBuffer, orientation, [
        { key: 'background_strip' },
        { key: unifiedProcessor, options: { label: artMetadata?.artworkUrl, ...unifiedProcessorOptions } },
      ]);
      processedBuffer = pipelineResult.buffer;
      processingInfo = { configured: unifiedProcessor, unifiedProcessorOptions, debug: pipelineResult.debug };
    } else {
      // Classic mode: run Phase 1 + Phase 2 pre-processors separately for visual comparison.
      const activePreProcessor = preProcessor !== 'none' ? preProcessor : null;
      preprocessedBuffer = await solidBorderStrip(imageBuffer);
      const processingResult = {};
      if (activePreProcessor && PRE_PROCESSORS[activePreProcessor]) {
        preprocessedBuffer = await PRE_PROCESSORS[activePreProcessor](preprocessedBuffer, { label: artMetadata?.artworkUrl, ...preProcessorOptions, _result: processingResult });
      }
      processedBuffer = await processWebSourceImage(preprocessedBuffer, orientation, {
        preProcess: null,
        cropEngine,
        cropEngineOptions,
      });
      if (activePreProcessor) {
        preprocessedFilename = `_test_preprocessed.`;
        processingInfo = { configured: activePreProcessor, ...processingResult, preProcessorOptions, cropEngineOptions };
      }
    }

    const ext = contentType.includes('png') ? 'png' : 'jpg';
    const cacheDir = cacheDirFor(req.frameArtPath);
    await fs.mkdir(cacheDir, { recursive: true });
    await clearTestCacheFile(req.frameArtPath);
    const rawFilename = `_test_raw.${ext}`;
    if (preprocessedFilename) preprocessedFilename = `_test_preprocessed.${ext}`;
    const testFilename = `_test.${ext}`;
    await fs.writeFile(path.join(cacheDir, rawFilename), imageBuffer);
    if (preprocessedFilename && preprocessedBuffer) {
      await fs.writeFile(path.join(cacheDir, preprocessedFilename), preprocessedBuffer);
    }
    await fs.writeFile(path.join(cacheDir, testFilename), processedBuffer);

    const userMapping = webSources.sources[chosenSourceId]?.userMapping || {};
    const testSourceSettings = webSources.sources?.[chosenSourceId]?.settings;
    const effectiveMapping = getEffectiveMapping(chosenSourceId, userMapping, testSourceSettings);
    const testSourceMod = SOURCE_MODULES[chosenSourceId];
    const testFieldDefs = testSourceMod?.getMetadataFields
      ? testSourceMod.getMetadataFields(testSourceSettings)
      : (testSourceMod?.metadataFields || []);
    const { attributeSnapshot, entitySnapshot } = buildWebSourceSnapshot(artMetadata, effectiveMapping, {
      fieldDefs: testFieldDefs,
      applyFormatting: webSources.formatDates !== false,
    });

    webSources.testCache = {
      filename: testFilename,
      rawFilename,
      ...(preprocessedFilename && { preprocessedFilename }),
      sourceId: chosenSourceId,
      orientation,
      artworkUrl: artMetadata.artworkUrl,
      metadata: artMetadata,
      ...(Object.keys(attributeSnapshot).length > 0 && { attributeSnapshot }),
      ...(Object.keys(entitySnapshot).length > 0 && { entitySnapshot }),
      fetchedAt: new Date().toISOString(),
      ...(processingInfo && { processingInfo }),
      fetchTrace,
    };
    await writeWebSourcesConfig(req.frameArtPath, webSources);

    res.json({ success: true, testCache: webSources.testCache });
  } catch (error) {
    console.error('Error in test-fetch:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch test image' });
  }
});

// POST /api/web-sources/test-reprocess
// Re-run the pre-processor and crop engine on the cached raw test image without
// fetching a new one. Useful for comparing how different algorithms handle the same image.
router.post('/test-reprocess', async (req, res) => {
  try {
    const webSources = await readWebSourcesConfig(req.frameArtPath);
    const { testCache } = webSources;
    if (!testCache?.rawFilename) {
      return res.status(400).json({ error: 'No cached image to reprocess. Fetch a test image first.' });
    }

    const cacheDir = cacheDirFor(req.frameArtPath);
    const imageBuffer = await fs.readFile(path.join(cacheDir, testCache.rawFilename));
    const ext = path.extname(testCache.rawFilename).slice(1);

    const { pipeline, unifiedProcessor, unifiedProcessorOptions = {},
            preProcessor, cropEngine, preProcessorOptions = {}, cropEngineOptions = {} } = webSources.imageProcessing;
    const alreadyProcessed = !!SOURCE_MODULES[testCache.sourceId]?.alreadyProcessed;
    const orientation = testCache.orientation || 'landscape';

    let processedBuffer;
    let preprocessedBuffer = null;
    let preprocessedFilename = null;
    let processingInfo = null;

    if (alreadyProcessed) {
      processedBuffer = imageBuffer;
    } else if (pipeline) {
      const label = testCache.metadata?.artworkUrl;
      const pipelineResult = await runPipeline(imageBuffer, orientation,
        pipeline.map(s => s.key === 'background_strip' ? s : { ...s, options: { label, ...s.options } })
      );
      processedBuffer = pipelineResult.buffer;
      processingInfo = { mode: 'pipeline', pipeline, debug: pipelineResult.debug };
    } else if (unifiedProcessor) {
      const pipelineResult = await runPipeline(imageBuffer, orientation, [
        { key: 'background_strip' },
        { key: unifiedProcessor, options: { label: testCache.metadata?.artworkUrl, ...unifiedProcessorOptions } },
      ]);
      processedBuffer = pipelineResult.buffer;
      processingInfo = { configured: unifiedProcessor, unifiedProcessorOptions, debug: pipelineResult.debug };
    } else {
      const activePreProcessor = preProcessor !== 'none' ? preProcessor : null;
      preprocessedBuffer = await solidBorderStrip(imageBuffer);
      const processingResult = {};
      if (activePreProcessor && PRE_PROCESSORS[activePreProcessor]) {
        preprocessedBuffer = await PRE_PROCESSORS[activePreProcessor](preprocessedBuffer, { label: testCache.metadata?.artworkUrl, ...preProcessorOptions, _result: processingResult });
      }
      processedBuffer = await processWebSourceImage(preprocessedBuffer, orientation, {
        preProcess: null,
        cropEngine,
        cropEngineOptions,
      });
      if (activePreProcessor) {
        preprocessedFilename = `_test_preprocessed.${ext}`;
        processingInfo = { configured: activePreProcessor, ...processingResult, preProcessorOptions, cropEngineOptions };
      }
    }

    const testFilename = `_test.${ext}`;

    // Remove old preprocessed file if the current settings don't produce one.
    if (!preprocessedFilename && testCache.preprocessedFilename) {
      try { await fs.unlink(path.join(cacheDir, testCache.preprocessedFilename)); } catch {}
    }
    if (preprocessedFilename && preprocessedBuffer) {
      await fs.writeFile(path.join(cacheDir, preprocessedFilename), preprocessedBuffer);
    }
    await fs.writeFile(path.join(cacheDir, testFilename), processedBuffer);

    // Remap metadata using current settings (formatDates may have changed since last fetch).
    const remapSourceSettings = webSources.sources?.[testCache.sourceId]?.settings;
    const remapSourceMod = SOURCE_MODULES[testCache.sourceId];
    const remapFieldDefs = remapSourceMod?.getMetadataFields
      ? remapSourceMod.getMetadataFields(remapSourceSettings)
      : (remapSourceMod?.metadataFields || []);
    const remapUserMapping = webSources.sources[testCache.sourceId]?.userMapping || {};
    const remapEffectiveMapping = getEffectiveMapping(testCache.sourceId, remapUserMapping, remapSourceSettings);
    const { attributeSnapshot: newAttrSnapshot, entitySnapshot: newEntitySnapshot } = buildWebSourceSnapshot(
      testCache.metadata || {}, remapEffectiveMapping,
      { fieldDefs: remapFieldDefs, applyFormatting: webSources.formatDates !== false }
    );

    webSources.testCache = { ...testCache, filename: testFilename };
    if (preprocessedFilename) {
      webSources.testCache.preprocessedFilename = preprocessedFilename;
    } else {
      delete webSources.testCache.preprocessedFilename;
    }
    if (processingInfo) {
      webSources.testCache.processingInfo = processingInfo;
    } else {
      delete webSources.testCache.processingInfo;
    }
    if (Object.keys(newAttrSnapshot).length > 0) {
      webSources.testCache.attributeSnapshot = newAttrSnapshot;
    } else {
      delete webSources.testCache.attributeSnapshot;
    }
    if (Object.keys(newEntitySnapshot).length > 0) {
      webSources.testCache.entitySnapshot = newEntitySnapshot;
    } else {
      delete webSources.testCache.entitySnapshot;
    }
    await writeWebSourcesConfig(req.frameArtPath, webSources);

    res.json({ success: true, testCache: webSources.testCache });
  } catch (error) {
    console.error('Error in test-reprocess:', error);
    res.status(500).json({ error: error.message || 'Failed to reprocess test image' });
  }
});

// GET /api/web-sources/test-cache/image
// Serve the current test image file.
router.get('/test-cache/image', async (req, res) => {
  try {
    const webSources = await readWebSourcesConfig(req.frameArtPath);
    if (!webSources.testCache?.filename) {
      return res.status(404).json({ error: 'No test image available' });
    }
    const filePath = path.join(cacheDirFor(req.frameArtPath), webSources.testCache.filename);
    const ext = path.extname(webSources.testCache.filename).slice(1);
    const contentType = ext === 'png' ? 'image/png' : 'image/jpeg';
    res.setHeader('Content-Type', contentType);
    res.sendFile(filePath);
  } catch (error) {
    console.error('Error serving test cache image:', error);
    res.status(500).json({ error: 'Failed to serve test image' });
  }
});

// GET /api/web-sources/test-cache/raw-image
// Serve the original (unprocessed) test image.
router.get('/test-cache/raw-image', async (req, res) => {
  try {
    const webSources = await readWebSourcesConfig(req.frameArtPath);
    if (!webSources.testCache?.rawFilename) {
      return res.status(404).json({ error: 'No raw test image available' });
    }
    const filePath = path.join(cacheDirFor(req.frameArtPath), webSources.testCache.rawFilename);
    const ext = path.extname(webSources.testCache.rawFilename).slice(1);
    const contentType = ext === 'png' ? 'image/png' : 'image/jpeg';
    res.setHeader('Content-Type', contentType);
    res.sendFile(filePath);
  } catch (error) {
    console.error('Error serving raw test cache image:', error);
    res.status(500).json({ error: 'Failed to serve raw test image' });
  }
});

// GET /api/web-sources/test-cache/preprocessed-image
// Serve the pre-processed test image (after frame detection, before crop engine).
router.get('/test-cache/preprocessed-image', async (req, res) => {
  try {
    const webSources = await readWebSourcesConfig(req.frameArtPath);
    if (!webSources.testCache?.preprocessedFilename) {
      return res.status(404).json({ error: 'No preprocessed test image available' });
    }
    const filePath = path.join(cacheDirFor(req.frameArtPath), webSources.testCache.preprocessedFilename);
    const ext = path.extname(webSources.testCache.preprocessedFilename).slice(1);
    const contentType = ext === 'png' ? 'image/png' : 'image/jpeg';
    res.setHeader('Content-Type', contentType);
    res.sendFile(filePath);
  } catch (error) {
    console.error('Error serving preprocessed test cache image:', error);
    res.status(500).json({ error: 'Failed to serve preprocessed test image' });
  }
});

// DELETE /api/web-sources/test-cache
// Clear the test cache image and record.
router.delete('/test-cache', async (req, res) => {
  try {
    const webSources = await readWebSourcesConfig(req.frameArtPath);
    await clearTestCacheFile(req.frameArtPath);
    delete webSources.testCache;
    await writeWebSourcesConfig(req.frameArtPath, webSources);
    res.json({ success: true });
  } catch (error) {
    console.error('Error clearing test cache:', error);
    res.status(500).json({ error: 'Failed to clear test cache' });
  }
});

module.exports = router;
module.exports.clearCacheForDevice = clearCacheForDevice;
module.exports.readWebSourcesConfig = readWebSourcesConfig;
module.exports.writeWebSourcesConfig = writeWebSourcesConfig;
module.exports.getArtistCounts = getArtistCounts;