const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs').promises;
const axios = require('axios');

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
    try {
      await fs.unlink(path.join(cacheDirFor(frameArtPath), `_test.${ext}`));
    } catch {
      // File didn't exist – fine
    }
  }
}

/**
 * Call the HA display_image service to show an image on a TV.
 */
async function displayImageOnTV(imagePath, deviceId, { screenOn = true } = {}) {
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
    data: { device_id: deviceId, image_path: imagePath, screen_on: screenOn },
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
    const { webSources } = await readWebSourcesConfig(req.frameArtPath);
    // Expose per-source constraints so the UI can react (e.g. disable landscape-only
    // sources when portrait filter is active).
    const sourceConstraints = Object.fromEntries(
      Object.entries(BUILTIN_SOURCES)
        .filter(([, s]) => s.aspectRatioConstraint)
        .map(([id, s]) => [id, { aspectRatioConstraint: s.aspectRatioConstraint }])
    );
    res.json({ success: true, webSources, settingsSchemas: SOURCE_SETTINGS_SCHEMAS, sourceConstraints });
  } catch (error) {
    console.error('Error reading web sources config:', error);
    res.status(500).json({ error: 'Failed to read web sources config' });
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

/**
 * Validate and normalize a single metadata mapping target value.
 * Returns the normalized value, or throws an error string if invalid.
 *
 * Valid values:
 *   null / ''           → null (disabled)
 *   string              → plain attribute name
 *   { entity, attribute } → entity type attribute reference (dummy snapshot only)
 */
function normalizeMapTarget(val) {
  if (val == null || val === '') return null;
  if (typeof val === 'string') return val;
  if (typeof val === 'object' && typeof val.entity === 'string' && typeof val.attribute === 'string') {
    return { entity: val.entity, attribute: val.attribute };
  }
  throw new Error('must be null, a string, or { entity, attribute }');
}

/**
 * Apply metadataMapping to web source artwork metadata, producing static snapshots
 * that mirror the library image attribute/entityRef structure without modifying any
 * real library data.
 *
 * Returns:
 *   attributeSnapshot — { attrName: value } for plain-attribute targets
 *   entitySnapshot    — { entityId: { attrName: value } } for entity-attribute targets
 */
function buildWebSourceSnapshot(artMetadata, mapping) {
  const attributeSnapshot = {};
  const entitySnapshot = {};

  for (const [sourceField, target] of Object.entries(mapping || {})) {
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

// PUT /api/web-sources/metadata-mapping
router.put('/metadata-mapping', async (req, res) => {
  try {
    const { mapping } = req.body;
    if (!mapping || typeof mapping !== 'object') {
      return res.status(400).json({ error: 'mapping must be an object' });
    }

    const { metadata, webSources } = await readWebSourcesConfig(req.frameArtPath);
    const allowed = ['title', 'creator', 'medium', 'attribution', 'repository', 'dateCreated'];
    const oldMapping = webSources.metadataMapping || {};
    webSources.metadataMapping = {};
    for (const key of allowed) {
      const raw = mapping[key] !== undefined ? mapping[key] : (oldMapping[key] ?? null);
      try {
        webSources.metadataMapping[key] = normalizeMapTarget(raw);
      } catch (err) {
        return res.status(400).json({ error: `Invalid mapping value for "${key}": ${err.message}` });
      }
    }
    await writeWebSourcesConfig(req.frameArtPath, metadata);
    res.json({ success: true, metadataMapping: webSources.metadataMapping });
  } catch (error) {
    console.error('Error updating metadata mapping:', error);
    res.status(500).json({ error: 'Failed to update metadata mapping' });
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
    const { metadata, webSources } = await readWebSourcesConfig(req.frameArtPath);

    const aspectRatio = resolveAspectRatioFilter(webSources, tvOrientation);

    // Determine which source to use
    let chosenSourceId = sourceId;
    if (!chosenSourceId) {
      // Pick an enabled source compatible with the current aspect ratio filter
      const enabledSources = Object.entries(webSources.sources)
        .filter(([id, s]) => s.enabled && isSourceCompatible(id, aspectRatio))
        .map(([id]) => id);
      if (enabledSources.length === 0) {
        return res.status(400).json({ error: 'No web sources are enabled and compatible with the current orientation filter. Enable at least one compatible source in Web Sources settings.' });
      }
      chosenSourceId = enabledSources[Math.floor(Math.random() * enabledSources.length)];
    } else if (!isSourceCompatible(chosenSourceId, aspectRatio)) {
      return res.status(400).json({ error: `Source "${chosenSourceId}" is not compatible with the current orientation filter (${aspectRatio})` });
    }

    if (!BUILTIN_SOURCES[chosenSourceId]) {
      return res.status(400).json({ error: `Unknown source: ${chosenSourceId}` });
    }

    // Fetch artwork from the chosen source
    const fetcher = SOURCE_FETCHERS[chosenSourceId];
    if (!fetcher) {
      return res.status(400).json({ error: `Source "${chosenSourceId}" is not yet implemented` });
    }
    const fetcherOpts = buildFetcherOptions(chosenSourceId, webSources.sources[chosenSourceId]?.settings);
    const fetchResult = await fetcher(fetcherOpts.mediaFilter, { aspectRatio });

    const { imageBuffer, contentType, metadata: artMetadata } = fetchResult;

    // Determine file extension
    const ext = contentType.includes('png') ? 'png' : 'jpg';

    // Ensure cache dir exists
    const cacheDir = cacheDirFor(req.frameArtPath);
    await fs.mkdir(cacheDir, { recursive: true });

    // Clear any previous cache for this device
    await clearCacheForDevice(req.frameArtPath, deviceId);

    // Save new image to cache
    const cacheFile = cacheFileFor(req.frameArtPath, deviceId, ext);
    await fs.writeFile(cacheFile, imageBuffer);

    // Build static attribute/entity snapshots from metadata mapping
    const { attributeSnapshot, entitySnapshot } = buildWebSourceSnapshot(
      artMetadata, webSources.metadataMapping
    );

    // Update per-TV cache record in metadata.json
    webSources.perTvCache = webSources.perTvCache || {};
    webSources.perTvCache[deviceId] = {
      filename: path.basename(cacheFile),
      sourceId: chosenSourceId,
      artworkUrl: artMetadata.artworkUrl,
      metadata: artMetadata,
      ...(Object.keys(attributeSnapshot).length > 0 && { attributeSnapshot }),
      ...(Object.keys(entitySnapshot).length > 0 && { entitySnapshot }),
      fetchedAt: new Date().toISOString(),
    };
    await writeWebSourcesConfig(req.frameArtPath, metadata);

    // Display on TV
    await displayImageOnTV(cacheFile, deviceId, { screenOn });

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

// POST /api/web-sources/test-fetch
// Fetch a test image from an enabled web source without sending it to any TV.
// Stores the result in webSources.testCache (same structure as perTvCache entries).
//
// Body: { tvOrientation?: 'landscape'|'portrait' }
// tvOrientation is used when aspectRatioFilter is 'match_tv'. Pass the orientation
// of the TV being simulated. If omitted and filter is 'match_tv', falls back to 'all'.
//
// TODO (docs/ROADMAP.md): Consider adding "virtual TV" support so users can test
// portrait artwork without a portrait-mounted physical TV.
router.post('/test-fetch', async (req, res) => {
  try {
    const { tvOrientation } = req.body || {};
    const webSources = await readWebSourcesConfig(req.frameArtPath);
    const aspectRatio = resolveAspectRatioFilter(webSources, tvOrientation);

    const enabledSources = Object.entries(webSources.sources)
      .filter(([id, s]) => s.enabled && isSourceCompatible(id, aspectRatio))
      .map(([id]) => id);
    if (enabledSources.length === 0) {
      return res.status(400).json({
        error: 'No web sources are enabled and compatible with the current orientation filter. Enable at least one compatible source in Web Sources settings.',
      });
    }
    const chosenSourceId = enabledSources[Math.floor(Math.random() * enabledSources.length)];

    const fetcher = SOURCE_FETCHERS[chosenSourceId];
    if (!fetcher) {
      return res.status(400).json({ error: `Source "${chosenSourceId}" is not yet implemented` });
    }

    const fetcherOpts = buildFetcherOptions(chosenSourceId, webSources.sources[chosenSourceId]?.settings);
    const { imageBuffer, contentType, metadata: artMetadata } = await fetcher(fetcherOpts.mediaFilter, { aspectRatio });

    const ext = contentType.includes('png') ? 'png' : 'jpg';
    const cacheDir = cacheDirFor(req.frameArtPath);
    await fs.mkdir(cacheDir, { recursive: true });
    await clearTestCacheFile(req.frameArtPath);
    const testFilename = `_test.${ext}`;
    const testFile = path.join(cacheDir, testFilename);
    await fs.writeFile(testFile, imageBuffer);

    const userMapping = webSources.sources[chosenSourceId]?.userMapping || {};
    const effectiveMapping = getEffectiveMapping(chosenSourceId, userMapping);
    const { attributeSnapshot, entitySnapshot } = buildWebSourceSnapshot(artMetadata, effectiveMapping);

    webSources.testCache = {
      filename: testFilename,
      sourceId: chosenSourceId,
      artworkUrl: artMetadata.artworkUrl,
      metadata: artMetadata,
      ...(Object.keys(attributeSnapshot).length > 0 && { attributeSnapshot }),
      ...(Object.keys(entitySnapshot).length > 0 && { entitySnapshot }),
      fetchedAt: new Date().toISOString(),
    };
    await writeWebSourcesConfig(req.frameArtPath, metadata);

    res.json({
      success: true,
      testCache: webSources.testCache,
    });
  } catch (error) {
    console.error('Error in test-fetch:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch test image' });
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