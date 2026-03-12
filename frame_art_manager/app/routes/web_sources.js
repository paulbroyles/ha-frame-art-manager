const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs').promises;
const axios = require('axios');
const sharp = require('sharp');
const { processWebSourceImage, solidBorderStrip, PRE_PROCESSORS, IMAGE_PROCESSING_SCHEMA } = require('../utils/imageProcessor');

// Source modules — each must export fetchRandomArtwork, metadataFields, and defaultMapping.
// Optional: settingsSchema, buildFetcherOptions.
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

// Per-source metadata declarations: fields list + default mapping hints.
// Exposed via GET /config so the UI can render per-source mapping controls.
const SOURCE_METADATA = Object.fromEntries(
  Object.entries(SOURCE_MODULES).map(([id, mod]) => [id, {
    fields: mod.metadataFields || [],
    defaultMapping: mod.defaultMapping || {},
  }])
);

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

function cacheFileFor(frameArtPath, deviceId, ext = 'jpg') {
  return path.join(cacheDirFor(frameArtPath), `${deviceId}.${ext}`);
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
      config.sources[id] = { ...def, enabled: false };
    }
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
    try {
      await fs.unlink(cacheFileFor(frameArtPath, deviceId, ext));
    } catch {
      // File didn't exist – fine
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
 * Convert stored source settings to options for the source fetcher.
 * Delegates to the source module's own buildFetcherOptions if present.
 */
function buildFetcherOptions(sourceId, settings) {
  const mod = SOURCE_MODULES[sourceId];
  if (mod?.buildFetcherOptions) return mod.buildFetcherOptions(settings);
  return {};
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
 * Resolve the effective aspect ratio filter for a fetch operation.
 *
 * 'match_tv' requires the caller to pass tvOrientation ('landscape' or 'portrait').
 * When tvOrientation is not provided (e.g. the integration doesn't yet support
 * orientation detection), falls back to 'all'.
 */
function resolveAspectRatioFilter(webSources, tvOrientation) {
  const setting = webSources.aspectRatioFilter || 'all';
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
  const constraint = BUILTIN_SOURCES[sourceId]?.aspectRatioConstraint;
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
      Object.entries(BUILTIN_SOURCES)
        .filter(([, s]) => s.aspectRatioConstraint)
        .map(([id, s]) => [id, { aspectRatioConstraint: s.aspectRatioConstraint }])
    );
    res.json({
      success: true,
      webSources,
      settingsSchemas: SOURCE_SETTINGS_SCHEMAS,
      sourceConstraints,
      sourceMetadata: SOURCE_METADATA,
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

// PUT /api/web-sources/sources/:sourceId/enable
router.put('/sources/:sourceId/enable', async (req, res) => {
  try {
    const { sourceId } = req.params;
    const { enabled } = req.body;

    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be a boolean' });
    }
    if (!BUILTIN_SOURCES[sourceId]) {
      return res.status(404).json({ error: `Unknown source: ${sourceId}` });
    }

    const webSources = await readWebSourcesConfig(req.frameArtPath);
    webSources.sources[sourceId] = {
      ...(webSources.sources[sourceId] || BUILTIN_SOURCES[sourceId]),
      enabled,
    };
    await writeWebSourcesConfig(req.frameArtPath, webSources);
    res.json({ success: true, source: webSources.sources[sourceId] });
  } catch (error) {
    console.error('Error updating web source:', error);
    res.status(500).json({ error: 'Failed to update web source' });
  }
});

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
// Body: { deviceId, sourceId?, screenOn?, tvOrientation? }
// tvOrientation ('landscape'|'portrait') is used when aspectRatioFilter is 'match_tv'.
router.post('/fetch-and-display', async (req, res) => {
  const { deviceId, sourceId, screenOn = true, tvOrientation } = req.body;

  if (!deviceId) {
    return res.status(400).json({ error: 'deviceId is required' });
  }

  try {
    const webSources = await readWebSourcesConfig(req.frameArtPath);
    const aspectRatio = resolveAspectRatioFilter(webSources, tvOrientation);

    // Determine which source to use
    let chosenSourceId = sourceId;
    if (!chosenSourceId) {
      const enabledSources = Object.entries(webSources.sources)
        .filter(([id, s]) => s.enabled && isSourceCompatible(id, aspectRatio))
        .map(([id]) => id);
      if (enabledSources.length === 0) {
        return res.status(400).json({
          error: 'No web sources are enabled and compatible with the current orientation filter. Enable at least one compatible source in Web Sources settings.',
        });
      }
      chosenSourceId = enabledSources[Math.floor(Math.random() * enabledSources.length)];
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

    const fetcherOpts = buildFetcherOptions(chosenSourceId, webSources.sources[chosenSourceId]?.settings);

    // Fetch, with optional retry when the image is below the minimum resolution threshold.
    // skipLowRes is off by default; when on, images whose short side is < minResolution
    // are discarded and the fetcher is called again (up to MAX_LOW_RES_ATTEMPTS times).
    const { skipLowRes, minResolution = 1080 } = webSources.imageProcessing;
    const MAX_LOW_RES_ATTEMPTS = 3;
    let fetchResult;
    for (let attempt = 0; attempt < MAX_LOW_RES_ATTEMPTS; attempt++) {
      fetchResult = await fetcher(fetcherOpts.mediaFilter, { aspectRatio, excludedTypes: fetcherOpts.excludedTypes || [] });
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
    await clearCacheForDevice(req.frameArtPath, deviceId);
    const cacheFile = cacheFileFor(req.frameArtPath, deviceId, ext);
    await fs.writeFile(cacheFile, processedBuffer);

    const userMapping = webSources.sources[chosenSourceId]?.userMapping || {};
    const effectiveMapping = getEffectiveMapping(chosenSourceId, userMapping);
    const { attributeSnapshot, entitySnapshot } = buildWebSourceSnapshot(artMetadata, effectiveMapping);

    webSources.perTvCache[deviceId] = {
      filename: path.basename(cacheFile),
      sourceId: chosenSourceId,
      artworkUrl: artMetadata.artworkUrl,
      metadata: artMetadata,
      ...(Object.keys(attributeSnapshot).length > 0 && { attributeSnapshot }),
      ...(Object.keys(entitySnapshot).length > 0 && { entitySnapshot }),
      fetchedAt: new Date().toISOString(),
    };
    await writeWebSourcesConfig(req.frameArtPath, webSources);

    await displayImageOnTV(cacheFile, deviceId, {
      screenOn,
      artworkMetadata: Object.keys(attributeSnapshot).length > 0 ? attributeSnapshot : null,
    });

    res.json({
      success: true,
      sourceId: chosenSourceId,
      metadata: artMetadata,
      cacheFile: path.basename(cacheFile),
    });
  } catch (error) {
    console.error('Error in fetch-and-display:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch and display web source image' });
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
 * @returns {{ chosenSourceId, imageBuffer, contentType, artMetadata }}
 */
async function fetchSpecificImage(specificImage, { tvOrientation } = {}) {
  const trimmed = specificImage.trim();

  // Ask each source module if it can handle this identifier. Modules are checked
  // in SOURCE_MODULES definition order, so more-specific patterns (e.g. google_arts
  // before google_art_wallpaper for the shared artsandculture.google.com domain) win.
  for (const [sourceId, mod] of Object.entries(SOURCE_MODULES)) {
    if (mod.canHandleIdentifier?.(trimmed)) {
      const result = await mod.fetchByIdentifier(trimmed, { tvOrientation });
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
// Body: { tvOrientation?: 'landscape'|'portrait', specificImage?: string }
// tvOrientation is used when aspectRatioFilter is 'match_tv'. Pass the orientation
// of the TV being simulated. If omitted and filter is 'match_tv', falls back to 'all'.
// specificImage is a Met Museum object ID, Met Museum collection URL, or any image URL.
//
// TODO (docs/ROADMAP.md): Consider adding "virtual TV" support so users can test
// portrait artwork without a portrait-mounted physical TV.
router.post('/test-fetch', async (req, res) => {
  try {
    const { tvOrientation, specificImage } = req.body || {};
    const webSources = await readWebSourcesConfig(req.frameArtPath);
    const aspectRatio = resolveAspectRatioFilter(webSources, tvOrientation);

    let chosenSourceId, imageBuffer, contentType, artMetadata;

    if (specificImage && specificImage.trim()) {
      // Fetch a specific image rather than a random one from an enabled source.
      ({ chosenSourceId, imageBuffer, contentType, artMetadata } = await fetchSpecificImage(specificImage, { tvOrientation }));
      // If source could not be determined (direct URL), fall back to first enabled source for
      // processing pipeline metadata (alreadyProcessed flag, effectiveMapping).
      if (!chosenSourceId) {
        const enabledSources = Object.entries(webSources.sources)
          .filter(([id, s]) => s.enabled)
          .map(([id]) => id);
        chosenSourceId = enabledSources[0] || Object.keys(SOURCE_MODULES)[0];
      }
    } else {
      const enabledSources = Object.entries(webSources.sources)
        .filter(([id, s]) => s.enabled && isSourceCompatible(id, aspectRatio))
        .map(([id]) => id);
      if (enabledSources.length === 0) {
        return res.status(400).json({
          error: 'No web sources are enabled and compatible with the current orientation filter. Enable at least one compatible source in Web Sources settings.',
        });
      }
      chosenSourceId = enabledSources[Math.floor(Math.random() * enabledSources.length)];

      const fetcher = SOURCE_FETCHERS[chosenSourceId];
      if (!fetcher) {
        return res.status(400).json({ error: `Source "${chosenSourceId}" is not yet implemented` });
      }

      const fetcherOpts = buildFetcherOptions(chosenSourceId, webSources.sources[chosenSourceId]?.settings);
      ({ imageBuffer, contentType, metadata: artMetadata } = await fetcher(fetcherOpts.mediaFilter, { aspectRatio, excludedTypes: fetcherOpts.excludedTypes || [] }));
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