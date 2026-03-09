const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs').promises;
const axios = require('axios');
// Source modules — each may optionally export settingsSchema and buildFetcherOptions.
// web_sources.js delegates source-specific logic to these modules generically.
const SOURCE_MODULES = {
  google_arts: require('../sources/google_arts'),
  google_art_wallpaper: require('../sources/google_art_wallpaper'),
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
  },
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function cacheDirFor(frameArtPath) {
  return path.join(frameArtPath, 'web_source_cache');
}

function cacheFileFor(frameArtPath, deviceId, ext = 'jpg') {
  return path.join(cacheDirFor(frameArtPath), `${deviceId}.${ext}`);
}

/**
 * Read the webSources section from metadata.json.
 * Returns a default structure if not present.
 */
async function readWebSourcesConfig(frameArtPath) {
  const metadataPath = path.join(frameArtPath, 'metadata.json');
  let metadata = {};
  try {
    const raw = await fs.readFile(metadataPath, 'utf8');
    metadata = JSON.parse(raw);
  } catch {
    // ignore – will write defaults
  }

  if (!metadata.webSources) {
    metadata.webSources = {
      sources: { google_arts: { ...BUILTIN_SOURCES.google_arts, enabled: false } },
      metadataMapping: { title: null, creator: null, medium: null, attribution: null },
      perTvCache: {},
    };
  }

  // Ensure all builtin sources are present (add any missing ones)
  for (const [id, def] of Object.entries(BUILTIN_SOURCES)) {
    if (!metadata.webSources.sources[id]) {
      metadata.webSources.sources[id] = { ...def, enabled: false };
    }
  }

  return { metadata, webSources: metadata.webSources };
}

/**
 * Write updated webSources back to metadata.json.
 */
async function writeWebSourcesConfig(frameArtPath, metadata) {
  const metadataPath = path.join(frameArtPath, 'metadata.json');
  await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));
}

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

  const payload = {
    device_id: deviceId,
    image_path: imagePath,
    screen_on: screenOn,
  };

  await axios({
    method: 'POST',
    url: `${HA_API_BASE}/services/frame_art_shuffler/display_image`,
    headers: {
      Authorization: `Bearer ${SUPERVISOR_TOKEN}`,
      'Content-Type': 'application/json',
    },
    data: payload,
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

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /api/web-sources/config
router.get('/config', async (req, res) => {
  try {
    const { webSources } = await readWebSourcesConfig(req.frameArtPath);
    res.json({ success: true, webSources, settingsSchemas: SOURCE_SETTINGS_SCHEMAS });
  } catch (error) {
    console.error('Error reading web sources config:', error);
    res.status(500).json({ error: 'Failed to read web sources config' });
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

    const { metadata, webSources } = await readWebSourcesConfig(req.frameArtPath);
    webSources.sources[sourceId] = {
      ...(webSources.sources[sourceId] || BUILTIN_SOURCES[sourceId]),
      settings,
    };
    await writeWebSourcesConfig(req.frameArtPath, metadata);
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

    const { metadata, webSources } = await readWebSourcesConfig(req.frameArtPath);
    webSources.sources[sourceId] = {
      ...(webSources.sources[sourceId] || BUILTIN_SOURCES[sourceId]),
      enabled,
    };
    await writeWebSourcesConfig(req.frameArtPath, metadata);
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
// Body: { deviceId, sourceId? }
router.post('/fetch-and-display', async (req, res) => {
  const { deviceId, sourceId, screenOn = true } = req.body;

  if (!deviceId) {
    return res.status(400).json({ error: 'deviceId is required' });
  }

  try {
    const { metadata, webSources } = await readWebSourcesConfig(req.frameArtPath);

    // Determine which source to use
    let chosenSourceId = sourceId;
    if (!chosenSourceId) {
      // Pick an enabled source
      const enabledSources = Object.entries(webSources.sources)
        .filter(([, s]) => s.enabled)
        .map(([id]) => id);
      if (enabledSources.length === 0) {
        return res.status(400).json({ error: 'No web sources are enabled. Enable at least one source in Web Sources settings.' });
      }
      chosenSourceId = enabledSources[Math.floor(Math.random() * enabledSources.length)];
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
    const fetchResult = await fetcher(fetcherOpts.mediaFilter);

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
    const { metadata, webSources } = await readWebSourcesConfig(req.frameArtPath);

    await clearCacheForDevice(req.frameArtPath, deviceId);

    if (webSources.perTvCache && webSources.perTvCache[deviceId]) {
      delete webSources.perTvCache[deviceId];
      await writeWebSourcesConfig(req.frameArtPath, metadata);
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error clearing web source cache:', error);
    res.status(500).json({ error: 'Failed to clear cache' });
  }
});

// POST /api/web-sources/test-fetch
// Fetch a test image from an enabled web source without sending it to any TV.
// Stores the result in webSources.testCache (same structure as perTvCache entries)
// so it can later be promoted to a queued or pending dispatch.
router.post('/test-fetch', async (req, res) => {
  try {
    const { metadata, webSources } = await readWebSourcesConfig(req.frameArtPath);

    // Pick an enabled source
    const enabledSources = Object.entries(webSources.sources)
      .filter(([, s]) => s.enabled)
      .map(([id]) => id);
    if (enabledSources.length === 0) {
      return res.status(400).json({ error: 'No web sources are enabled. Enable at least one source in Web Sources settings.' });
    }
    const chosenSourceId = enabledSources[Math.floor(Math.random() * enabledSources.length)];

    const fetcher = SOURCE_FETCHERS[chosenSourceId];
    if (!fetcher) {
      return res.status(400).json({ error: `Source "${chosenSourceId}" is not yet implemented` });
    }
    const fetcherOpts = buildFetcherOptions(chosenSourceId, webSources.sources[chosenSourceId]?.settings);
    const { imageBuffer, contentType, metadata: artMetadata } = await fetcher(fetcherOpts.mediaFilter);

    const ext = contentType.includes('png') ? 'png' : 'jpg';
    const cacheDir = cacheDirFor(req.frameArtPath);
    await fs.mkdir(cacheDir, { recursive: true });

    // Remove any previous test image and write the new one
    await clearTestCacheFile(req.frameArtPath);
    const testFilename = `_test.${ext}`;
    const testFile = path.join(cacheDir, testFilename);
    await fs.writeFile(testFile, imageBuffer);

    const { attributeSnapshot, entitySnapshot } = buildWebSourceSnapshot(
      artMetadata, webSources.metadataMapping
    );

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
    const { webSources } = await readWebSourcesConfig(req.frameArtPath);
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
    const { metadata, webSources } = await readWebSourcesConfig(req.frameArtPath);
    await clearTestCacheFile(req.frameArtPath);
    delete webSources.testCache;
    await writeWebSourcesConfig(req.frameArtPath, metadata);
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
