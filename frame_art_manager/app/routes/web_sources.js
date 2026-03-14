const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs').promises;
const axios = require('axios');
const sharp = require('sharp');
const { processWebSourceImage, solidBorderStrip, PRE_PROCESSORS, IMAGE_PROCESSING_SCHEMA } = require('../utils/imageProcessor');

// Source modules — each must export fetchRandomArtwork, selectMode, metadataFields, and defaultMapping.
// Optional: settingsSchema, getExtraOptions, getFilterTypes, getMetadataFields, alreadyProcessed.
// web_sources.js delegates source-specific logic to these modules generically.
const SOURCE_MODULES = {
  google_arts: require('../sources/google_arts'),
  google_art_wallpaper: require('../sources/google_art_wallpaper'),
  met_museum: require('../sources/met_museum'),
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
      return [id, { fields, defaultMapping: mod.defaultMapping || {} }];
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
 * Delete any existing cache file(s) for a device.
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
 * Call the HA display_image service to show an image on a TV.
 */
async function displayImageOnTV(imagePath, deviceId, { screenOn = true, artworkMetadata = null } = {}) {
  if (!SUPERVISOR_TOKEN && process.env.NODE_ENV === 'development') {
    console.log(`[DEV] Would display ${imagePath} on device ${deviceId} (screenOn=${screenOn})`);
    return;
  }

  await axios({
    method: 'POST',
    url: `${HA_API_BASE}/services/frame_art_shuffler/display_image`,
    headers: {
      Authorization: `Bearer ${SUPERVISOR_TOKEN}`,
      'Content-Type': 'application/json',
    },
    data: {
      device_id: deviceId,
      image_path: imagePath,
      screen_on: screenOn,
      ...(artworkMetadata && { artwork_metadata: artworkMetadata }),
    },
    timeout: 60000,
  });
}

/**
 * Call the HA upload_image service to upload an image to a TV without displaying it.
 * Returns the content_id from the service response.
 */
async function uploadImageToTV(imagePath, deviceId, { matte = null } = {}) {
  if (!SUPERVISOR_TOKEN && process.env.NODE_ENV === 'development') {
    console.log(`[DEV] Would upload ${imagePath} to device ${deviceId}`);
    return 'DEV_CONTENT_ID';
  }

  const response = await axios({
    method: 'POST',
    url: `${HA_API_BASE}/services/frame_art_shuffler/upload_image`,
    headers: {
      Authorization: `Bearer ${SUPERVISOR_TOKEN}`,
      'Content-Type': 'application/json',
    },
    data: {
      device_id: deviceId,
      image_path: imagePath,
      ...(matte && { matte }),
      return_response: true,
    },
    timeout: 120000,
  });

  // HA returns service response data under response.data.response or response.data
  const serviceResponse = response.data?.response || response.data;
  const contentId = serviceResponse?.content_id;
  if (!contentId) {
    throw new Error('upload_image service did not return a content_id');
  }
  return contentId;
}

/**
 * Compute the effective metadata mapping for a source.
 *
 * Effective = source module's defaultMapping hints (as plain attribute name strings)
 * overridden by any per-source userMapping stored in config.
 *
 * The defaultMapping hints are bare attribute name strings (e.g. 'title', 'artist').
 * The userMapping values are the full stored format: null | string | {entity, attribute}.
 *
 * @param {string} sourceId
 * @param {object} userMapping - Stored user overrides from config.sources[id].userMapping
 * @returns {object} Merged mapping: { fieldKey: null|string|{entity,attribute} }
 */
function getEffectiveMapping(sourceId, userMapping) {
  const defaultMapping = SOURCE_MODULES[sourceId]?.defaultMapping || {};
  const effective = {};

  // Apply source defaults (hints are bare attribute name strings)
  for (const [key, hint] of Object.entries(defaultMapping)) {
    effective[key] = hint || null;
  }

  // Apply user overrides
  for (const [key, target] of Object.entries(userMapping || {})) {
    effective[key] = target;
  }

  return effective;
}

/**
 * Apply an effective metadata mapping to artwork metadata, producing HA attribute snapshots.
 *
 * @param {object} artMetadata - Raw metadata from the source fetcher
 * @param {object} effectiveMapping - { fieldKey: null|string|{entity,attribute} }
 * @returns {{ attributeSnapshot, entitySnapshot }}
 */
function buildWebSourceSnapshot(artMetadata, effectiveMapping) {
  const attributeSnapshot = {};
  const entitySnapshot = {};

  for (const [sourceField, target] of Object.entries(effectiveMapping || {})) {
    const value = artMetadata[sourceField];
    if (value == null || target == null) continue;

    if (typeof target === 'string') {
      attributeSnapshot[target] = String(value);
    } else if (target.entity && target.attribute) {
      if (!entitySnapshot[target.entity]) entitySnapshot[target.entity] = {};
      entitySnapshot[target.entity][target.attribute] = String(value);
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
    const { preProcessor, cropEngine, preProcessorOptions, cropEngineOptions, skipLowRes, minResolution } = req.body;
    const validPreProcessors = IMAGE_PROCESSING_SCHEMA.preProcessors.map(p => p.value);
    const validEngines       = IMAGE_PROCESSING_SCHEMA.cropEngines.map(e => e.value);
    if (preProcessor && !validPreProcessors.includes(preProcessor)) {
      return res.status(400).json({ error: `preProcessor must be one of: ${validPreProcessors.join(', ')}` });
    }
    if (cropEngine && !validEngines.includes(cropEngine)) {
      return res.status(400).json({ error: `cropEngine must be one of: ${validEngines.join(', ')}` });
    }
    if (preProcessorOptions !== undefined && (typeof preProcessorOptions !== 'object' || Array.isArray(preProcessorOptions))) {
      return res.status(400).json({ error: 'preProcessorOptions must be an object' });
    }
    if (cropEngineOptions !== undefined && (typeof cropEngineOptions !== 'object' || Array.isArray(cropEngineOptions))) {
      return res.status(400).json({ error: 'cropEngineOptions must be an object' });
    }
    if (skipLowRes !== undefined && typeof skipLowRes !== 'boolean') {
      return res.status(400).json({ error: 'skipLowRes must be a boolean' });
    }
    if (minResolution !== undefined && (typeof minResolution !== 'number' || minResolution < 1 || !Number.isFinite(minResolution))) {
      return res.status(400).json({ error: 'minResolution must be a positive number' });
    }
    const webSources = await readWebSourcesConfig(req.frameArtPath);
    if (preProcessor        !== undefined) webSources.imageProcessing.preProcessor        = preProcessor;
    if (cropEngine          !== undefined) webSources.imageProcessing.cropEngine          = cropEngine;
    if (preProcessorOptions !== undefined) webSources.imageProcessing.preProcessorOptions = preProcessorOptions;
    if (cropEngineOptions   !== undefined) webSources.imageProcessing.cropEngineOptions   = cropEngineOptions;
    if (skipLowRes          !== undefined) webSources.imageProcessing.skipLowRes          = skipLowRes;
    if (minResolution       !== undefined) webSources.imageProcessing.minResolution       = minResolution;
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
    if (!BUILTIN_SOURCES[sourceId]) {
      return res.status(400).json({ error: `Unknown source: ${sourceId}` });
    }
    if (!['random'].includes(queryMode)) {
      return res.status(400).json({ error: `queryMode must be one of: random` });
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
    if (sourceId !== undefined && !BUILTIN_SOURCES[sourceId]) {
      return res.status(400).json({ error: `Unknown source: ${sourceId}` });
    }
    if (queryMode !== undefined && !['random'].includes(queryMode)) {
      return res.status(400).json({ error: `queryMode must be one of: random` });
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
// Clears all user mapping overrides, restoring auto-detected defaults.
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

// POST /api/web-sources/fetch-and-display
// Body: { deviceId, sourceId?, virtualTagId?, screenOn?, tvOrientation? }
// virtualTagId: if provided, uses the virtual tag's sourceId and merges its filters
//   on top of the source-level filters. Takes precedence over sourceId.
// tvOrientation ('landscape'|'portrait') is used when aspectRatioFilter is 'match_tv'.
router.post('/fetch-and-display', async (req, res) => {
  const { deviceId, sourceId, virtualTagId, screenOn = true, tvOrientation } = req.body;

  if (!deviceId) {
    return res.status(400).json({ error: 'deviceId is required' });
  }

  try {
    const webSources = await readWebSourcesConfig(req.frameArtPath);
    const aspectRatio = resolveAspectRatioFilter(webSources, tvOrientation);

    // Resolve virtual tag → sourceId + extra filters
    let virtualTag = null;
    let chosenSourceId = sourceId;
    if (virtualTagId) {
      virtualTag = webSources.virtualTags[virtualTagId];
      if (!virtualTag) {
        return res.status(404).json({ error: `Virtual tag "${virtualTagId}" not found` });
      }
      chosenSourceId = virtualTag.sourceId;
    }

    // Determine which source to use.
    if (!chosenSourceId) {
      return res.status(400).json({
        error: 'Either virtualTagId or sourceId is required.',
      });
    } else if (!isSourceCompatible(chosenSourceId, aspectRatio)) {
      return res.status(400).json({
        error: `Source "${chosenSourceId}" is not compatible with the current orientation filter (${aspectRatio})`,
      });
    }

    if (!BUILTIN_SOURCES[chosenSourceId]) {
      return res.status(400).json({ error: `Unknown source: ${chosenSourceId}` });
    }

    const fetcher = SOURCE_FETCHERS[chosenSourceId];
    if (!fetcher) {
      return res.status(400).json({ error: `Source "${chosenSourceId}" is not yet implemented` });
    }

    // Merge filters across cascade levels: global → source → virtual tag.
    const globalFilters = webSources.globalFilters || [];
    const sourceFilters = webSources.sources[chosenSourceId]?.filters || [];
    const tagFilters = virtualTag?.filters || [];
    const mergedFilters = mergeFilterCascade(globalFilters, sourceFilters, tagFilters);
    const extraOpts = SOURCE_MODULES[chosenSourceId]?.getExtraOptions?.(webSources.sources[chosenSourceId]?.settings) || {};

    // Fetch, with optional retry when the image is below the minimum resolution threshold.
    // skipLowRes is off by default; when on, images whose short side is < minResolution
    // are discarded and the fetcher is called again (up to MAX_LOW_RES_ATTEMPTS times).
    const { skipLowRes, minResolution = 1080 } = webSources.imageProcessing;
    const MAX_LOW_RES_ATTEMPTS = 3;
    let fetchResult;
    for (let attempt = 0; attempt < MAX_LOW_RES_ATTEMPTS; attempt++) {
      fetchResult = await fetcher(mergedFilters, { aspectRatio, ...extraOpts });
      if (!skipLowRes) break;
      const { width, height } = await sharp(fetchResult.imageBuffer).metadata();
      const shortSide = Math.min(width, height);
      if (shortSide >= minResolution) break;
      console.warn(`[web_sources] Skipping low-res image (${width}×${height}, short side ${shortSide} < ${minResolution}); retrying (attempt ${attempt + 1}/${MAX_LOW_RES_ATTEMPTS})`);
      if (attempt === MAX_LOW_RES_ATTEMPTS - 1) {
        console.warn(`[web_sources] All ${MAX_LOW_RES_ATTEMPTS} attempts returned low-res images; using last result`);
      }
    }
    const { imageBuffer, contentType, metadata: artMetadata } = fetchResult;

    const orientation = tvOrientation || 'landscape';
    const { preProcessor, cropEngine, preProcessorOptions = {}, cropEngineOptions = {} } = webSources.imageProcessing;
    const processedBuffer = SOURCE_MODULES[chosenSourceId]?.alreadyProcessed
      ? imageBuffer
      : await processWebSourceImage(imageBuffer, orientation, {
          preProcess: preProcessor !== 'none' ? preProcessor : null,
          preProcessOptions: { label: artMetadata?.artworkUrl, ...preProcessorOptions },
          cropEngine,
          cropEngineOptions,
        });

    const ext = contentType.includes('png') ? 'png' : 'jpg';
    const cacheDir = cacheDirFor(req.frameArtPath);
    await fs.mkdir(cacheDir, { recursive: true });

    // Write processed image to pending path — old cache files stay intact
    // so the artwork page continues serving the previous (correct) image
    // if display fails
    const pendingFile = cacheFileFor(req.frameArtPath, deviceId, ext, '_pending');
    await fs.writeFile(pendingFile, processedBuffer);

    const userMapping = webSources.sources[chosenSourceId]?.userMapping || {};
    const effectiveMapping = getEffectiveMapping(chosenSourceId, userMapping);
    const { attributeSnapshot, entitySnapshot } = buildWebSourceSnapshot(artMetadata, effectiveMapping);

    // Display on TV using the pending file
    try {
      await displayImageOnTV(pendingFile, deviceId, {
        screenOn,
        artworkMetadata: buildHaMetadata(attributeSnapshot, entitySnapshot),
      });
    } catch (displayError) {
      // Display failed — clean up pending file, leave old cache intact
      await fs.unlink(pendingFile).catch(() => {});
      throw displayError;
    }

    // Display succeeded — commit: clear old files, promote pending to final
    await clearCacheForDevice(req.frameArtPath, deviceId);
    const cacheFile = cacheFileFor(req.frameArtPath, deviceId, ext);
    await fs.rename(pendingFile, cacheFile);
    await fs.writeFile(
      cacheFileFor(req.frameArtPath, deviceId, ext, '_original'), imageBuffer
    );

    webSources.perTvCache[deviceId] = {
      filename: path.basename(cacheFile),
      originalFilename: `${deviceId}_original.${ext}`,
      sourceId: chosenSourceId,
      ...(virtualTagId && { virtualTagId }),
      artworkUrl: artMetadata.artworkUrl,
      metadata: artMetadata,
      ...(Object.keys(attributeSnapshot).length > 0 && { attributeSnapshot }),
      ...(Object.keys(entitySnapshot).length > 0 && { entitySnapshot }),
      fetchedAt: new Date().toISOString(),
    };
    await writeWebSourcesConfig(req.frameArtPath, webSources);

    res.json({
      success: true,
      sourceId: chosenSourceId,
      ...(virtualTagId && { virtualTagId }),
      metadata: artMetadata,
      cacheFile: path.basename(cacheFile),
    });
  } catch (error) {
    console.error('Error in fetch-and-display:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch and display web source image' });
  }
});

// POST /api/web-sources/fetch-and-upload
// Like fetch-and-display but uploads without selecting/displaying.
// Returns { success, contentId, sourceId, virtualTagId?, metadata, cacheFile }.
// Used by the pre-upload pipeline: stage the next image in the background.
router.post('/fetch-and-upload', async (req, res) => {
  const { deviceId, sourceId, virtualTagId, matte, tvOrientation } = req.body;

  if (!deviceId) {
    return res.status(400).json({ error: 'deviceId is required' });
  }

  try {
    const webSources = await readWebSourcesConfig(req.frameArtPath);
    const aspectRatio = resolveAspectRatioFilter(webSources, tvOrientation);

    // Resolve virtual tag → sourceId + extra filters
    let virtualTag = null;
    let chosenSourceId = sourceId;
    if (virtualTagId) {
      virtualTag = webSources.virtualTags[virtualTagId];
      if (!virtualTag) {
        return res.status(404).json({ error: `Virtual tag "${virtualTagId}" not found` });
      }
      chosenSourceId = virtualTag.sourceId;
    }

    if (!chosenSourceId) {
      return res.status(400).json({
        error: 'Either virtualTagId or sourceId is required.',
      });
    } else if (!isSourceCompatible(chosenSourceId, aspectRatio)) {
      return res.status(400).json({
        error: `Source "${chosenSourceId}" is not compatible with the current orientation filter (${aspectRatio})`,
      });
    }

    if (!BUILTIN_SOURCES[chosenSourceId]) {
      return res.status(400).json({ error: `Unknown source: ${chosenSourceId}` });
    }

    const fetcher = SOURCE_FETCHERS[chosenSourceId];
    if (!fetcher) {
      return res.status(400).json({ error: `Source "${chosenSourceId}" is not yet implemented` });
    }

    // Merge filters across cascade levels: global → source → virtual tag.
    const globalFilters = webSources.globalFilters || [];
    const sourceFilters = webSources.sources[chosenSourceId]?.filters || [];
    const tagFilters = virtualTag?.filters || [];
    const mergedFilters = mergeFilterCascade(globalFilters, sourceFilters, tagFilters);
    const extraOpts = SOURCE_MODULES[chosenSourceId]?.getExtraOptions?.(webSources.sources[chosenSourceId]?.settings) || {};

    // Fetch with optional low-res retry (same as fetch-and-display)
    const { skipLowRes, minResolution = 1080 } = webSources.imageProcessing;
    const MAX_LOW_RES_ATTEMPTS = 3;
    let fetchResult;
    for (let attempt = 0; attempt < MAX_LOW_RES_ATTEMPTS; attempt++) {
      fetchResult = await fetcher(mergedFilters, { aspectRatio, ...extraOpts });
      if (!skipLowRes) break;
      const { width, height } = await sharp(fetchResult.imageBuffer).metadata();
      const shortSide = Math.min(width, height);
      if (shortSide >= minResolution) break;
      console.warn(`[web_sources] Skipping low-res image (${width}×${height}, short side ${shortSide} < ${minResolution}); retrying (attempt ${attempt + 1}/${MAX_LOW_RES_ATTEMPTS})`);
      if (attempt === MAX_LOW_RES_ATTEMPTS - 1) {
        console.warn(`[web_sources] All ${MAX_LOW_RES_ATTEMPTS} attempts returned low-res images; using last result`);
      }
    }
    const { imageBuffer, contentType, metadata: artMetadata } = fetchResult;

    const orientation = tvOrientation || 'landscape';
    const { preProcessor, cropEngine, preProcessorOptions = {}, cropEngineOptions = {} } = webSources.imageProcessing;
    const processedBuffer = SOURCE_MODULES[chosenSourceId]?.alreadyProcessed
      ? imageBuffer
      : await processWebSourceImage(imageBuffer, orientation, {
          preProcess: preProcessor !== 'none' ? preProcessor : null,
          preProcessOptions: { label: artMetadata?.artworkUrl, ...preProcessorOptions },
          cropEngine,
          cropEngineOptions,
        });

    const ext = contentType.includes('png') ? 'png' : 'jpg';
    const cacheDir = cacheDirFor(req.frameArtPath);
    await fs.mkdir(cacheDir, { recursive: true });

    // Write to pending path (same pattern as fetch-and-display)
    const pendingFile = cacheFileFor(req.frameArtPath, deviceId, ext, '_pending');
    await fs.writeFile(pendingFile, processedBuffer);

    const userMapping = webSources.sources[chosenSourceId]?.userMapping || {};
    const effectiveMapping = getEffectiveMapping(chosenSourceId, userMapping);
    const { attributeSnapshot, entitySnapshot } = buildWebSourceSnapshot(artMetadata, effectiveMapping);

    // Upload to TV without displaying
    let contentId;
    try {
      contentId = await uploadImageToTV(pendingFile, deviceId, { matte });
    } catch (uploadError) {
      await fs.unlink(pendingFile).catch(() => {});
      throw uploadError;
    }

    // Upload succeeded — commit cache
    await clearCacheForDevice(req.frameArtPath, deviceId);
    const cacheFile = cacheFileFor(req.frameArtPath, deviceId, ext);
    await fs.rename(pendingFile, cacheFile);
    await fs.writeFile(
      cacheFileFor(req.frameArtPath, deviceId, ext, '_original'), imageBuffer
    );

    webSources.perTvCache[deviceId] = {
      filename: path.basename(cacheFile),
      originalFilename: `${deviceId}_original.${ext}`,
      sourceId: chosenSourceId,
      ...(virtualTagId && { virtualTagId }),
      artworkUrl: artMetadata.artworkUrl,
      metadata: artMetadata,
      ...(Object.keys(attributeSnapshot).length > 0 && { attributeSnapshot }),
      ...(Object.keys(entitySnapshot).length > 0 && { entitySnapshot }),
      fetchedAt: new Date().toISOString(),
    };
    await writeWebSourcesConfig(req.frameArtPath, webSources);

    res.json({
      success: true,
      contentId,
      sourceId: chosenSourceId,
      ...(virtualTagId && { virtualTagId }),
      metadata: artMetadata,
      cacheFile: path.basename(cacheFile),
    });
  } catch (error) {
    console.error('Error in fetch-and-upload:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch and upload web source image' });
  }
});

// DELETE /api/web-sources/cache/:deviceId
// Called when a library image is displayed, to clean up the web source cache.
router.delete('/cache/:deviceId', async (req, res) => {
  try {
    const { deviceId } = req.params;
    const webSources = await readWebSourcesConfig(req.frameArtPath);

    await clearCacheForDevice(req.frameArtPath, deviceId);

    if (webSources.perTvCache?.[deviceId]) {
      delete webSources.perTvCache[deviceId];
      await writeWebSourcesConfig(req.frameArtPath, webSources);
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error clearing web source cache:', error);
    res.status(500).json({ error: 'Failed to clear cache' });
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
      // Virtual tag determines source.
      chosenSourceId = virtualTag?.sourceId || null;
      if (!chosenSourceId) {
        return res.status(400).json({
          error: 'Select a virtual tag or source for random test fetches.',
        });
      }

      const fetcher = SOURCE_FETCHERS[chosenSourceId];
      if (!fetcher) {
        return res.status(400).json({ error: `Source "${chosenSourceId}" is not yet implemented` });
      }

      // Merge filters across cascade levels: global → source → virtual tag.
      const globalFilters = webSources.globalFilters || [];
      const sourceFilters = webSources.sources[chosenSourceId]?.filters || [];
      const tagFilters = virtualTag?.filters || [];
      const mergedFilters = mergeFilterCascade(globalFilters, sourceFilters, tagFilters);
      const sourceModule = SOURCE_MODULES[chosenSourceId];
      const modeInfo = sourceModule?.selectMode?.(mergedFilters) || { mode: 'unknown' };
      fetchTrace.path = 'virtual-tag';
      fetchTrace.virtualTagId = virtualTagId;
      fetchTrace.mode = modeInfo.mode;
      fetchTrace.globalFilters = globalFilters;
      fetchTrace.sourceFilters = sourceFilters;
      fetchTrace.tagFilters = tagFilters;
      fetchTrace.mergedFilters = mergedFilters;
      const extraOpts = sourceModule?.getExtraOptions?.(webSources.sources[chosenSourceId]?.settings) || {};
      ({ imageBuffer, contentType, metadata: artMetadata } = await fetcher(mergedFilters, { aspectRatio, ...extraOpts }));
    }

    const orientation = tvOrientation || 'landscape';
    const { preProcessor, cropEngine, preProcessorOptions = {}, cropEngineOptions = {} } = webSources.imageProcessing;
    const alreadyProcessed = !!SOURCE_MODULES[chosenSourceId]?.alreadyProcessed;
    const activePreProcessor = (!alreadyProcessed && preProcessor !== 'none') ? preProcessor : null;

    // Run Phase 1 + Phase 2 pre-processors separately so the output can be saved for visual comparison.
    let preprocessedBuffer = !alreadyProcessed ? await solidBorderStrip(imageBuffer) : imageBuffer;
    const processingResult = {};
    if (activePreProcessor && PRE_PROCESSORS[activePreProcessor]) {
      preprocessedBuffer = await PRE_PROCESSORS[activePreProcessor](preprocessedBuffer, { label: artMetadata?.artworkUrl, ...preProcessorOptions, _result: processingResult });
    }

    // Run the crop engine on the pre-processed buffer (pre-process already applied).
    const processedBuffer = alreadyProcessed
      ? imageBuffer
      : await processWebSourceImage(preprocessedBuffer, orientation, {
          preProcess: null,
          cropEngine,
          cropEngineOptions,
        });

    const ext = contentType.includes('png') ? 'png' : 'jpg';
    const cacheDir = cacheDirFor(req.frameArtPath);
    await fs.mkdir(cacheDir, { recursive: true });
    await clearTestCacheFile(req.frameArtPath);
    const rawFilename = `_test_raw.${ext}`;
    const preprocessedFilename = activePreProcessor ? `_test_preprocessed.${ext}` : null;
    const testFilename = `_test.${ext}`;
    await fs.writeFile(path.join(cacheDir, rawFilename), imageBuffer);
    if (preprocessedFilename) {
      await fs.writeFile(path.join(cacheDir, preprocessedFilename), preprocessedBuffer);
    }
    await fs.writeFile(path.join(cacheDir, testFilename), processedBuffer);

    const userMapping = webSources.sources[chosenSourceId]?.userMapping || {};
    const effectiveMapping = getEffectiveMapping(chosenSourceId, userMapping);
    const { attributeSnapshot, entitySnapshot } = buildWebSourceSnapshot(artMetadata, effectiveMapping);

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
      ...(activePreProcessor && { processingInfo: { configured: activePreProcessor, ...processingResult, preProcessorOptions, cropEngineOptions } }),
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

    const { preProcessor, cropEngine, preProcessorOptions = {}, cropEngineOptions = {} } = webSources.imageProcessing;
    const alreadyProcessed = !!SOURCE_MODULES[testCache.sourceId]?.alreadyProcessed;
    const activePreProcessor = (!alreadyProcessed && preProcessor !== 'none') ? preProcessor : null;
    const orientation = testCache.orientation || 'landscape';

    let preprocessedBuffer = !alreadyProcessed ? await solidBorderStrip(imageBuffer) : imageBuffer;
    const processingResult = {};
    if (activePreProcessor && PRE_PROCESSORS[activePreProcessor]) {
      preprocessedBuffer = await PRE_PROCESSORS[activePreProcessor](preprocessedBuffer, { label: testCache.metadata?.artworkUrl, ...preProcessorOptions, _result: processingResult });
    }

    const processedBuffer = alreadyProcessed
      ? imageBuffer
      : await processWebSourceImage(preprocessedBuffer, orientation, {
          preProcess: null,
          cropEngine,
          cropEngineOptions,
        });

    const preprocessedFilename = activePreProcessor ? `_test_preprocessed.${ext}` : null;
    const testFilename = `_test.${ext}`;

    // Remove old preprocessed file if the current settings don't produce one.
    if (!preprocessedFilename && testCache.preprocessedFilename) {
      try { await fs.unlink(path.join(cacheDir, testCache.preprocessedFilename)); } catch {}
    }
    if (preprocessedFilename) {
      await fs.writeFile(path.join(cacheDir, preprocessedFilename), preprocessedBuffer);
    }
    await fs.writeFile(path.join(cacheDir, testFilename), processedBuffer);

    webSources.testCache = { ...testCache, filename: testFilename };
    if (preprocessedFilename) {
      webSources.testCache.preprocessedFilename = preprocessedFilename;
    } else {
      delete webSources.testCache.preprocessedFilename;
    }
    if (activePreProcessor) {
      webSources.testCache.processingInfo = { configured: activePreProcessor, ...processingResult, preProcessorOptions, cropEngineOptions };
    } else {
      delete webSources.testCache.processingInfo;
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