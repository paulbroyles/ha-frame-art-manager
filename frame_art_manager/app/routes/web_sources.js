const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs').promises;
const axios = require('axios');
const SOURCE_FETCHERS = {
  google_arts: require('../sources/google_arts').fetchRandomArtwork,
  google_art_wallpaper: require('../sources/google_art_wallpaper').fetchRandomArtwork,
};

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
      tvAssignments: {},
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
 * Call the HA display_image service to show an image on a TV.
 */
async function displayImageOnTV(imagePath, deviceId) {
  if (!SUPERVISOR_TOKEN && process.env.NODE_ENV === 'development') {
    console.log(`[DEV] Would display ${imagePath} on device ${deviceId}`);
    return;
  }

  const payload = {
    device_id: deviceId,
    image_path: imagePath,
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

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /api/web-sources/config
router.get('/config', async (req, res) => {
  try {
    const { webSources } = await readWebSourcesConfig(req.frameArtPath);
    res.json({ success: true, webSources });
  } catch (error) {
    console.error('Error reading web sources config:', error);
    res.status(500).json({ error: 'Failed to read web sources config' });
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

// PUT /api/web-sources/metadata-mapping
router.put('/metadata-mapping', async (req, res) => {
  try {
    const { mapping } = req.body;
    if (!mapping || typeof mapping !== 'object') {
      return res.status(400).json({ error: 'mapping must be an object' });
    }

    const { metadata, webSources } = await readWebSourcesConfig(req.frameArtPath);
    // Only allow known mapping keys
    const allowed = ['title', 'creator', 'medium', 'attribution'];
    const oldMapping = webSources.metadataMapping || {};
    webSources.metadataMapping = {};
    for (const key of allowed) {
      webSources.metadataMapping[key] = mapping[key] !== undefined ? (mapping[key] || null) : (oldMapping[key] || null);
    }
    await writeWebSourcesConfig(req.frameArtPath, metadata);
    res.json({ success: true, metadataMapping: webSources.metadataMapping });
  } catch (error) {
    console.error('Error updating metadata mapping:', error);
    res.status(500).json({ error: 'Failed to update metadata mapping' });
  }
});

// PUT /api/web-sources/tv-assignments/:deviceId
router.put('/tv-assignments/:deviceId', async (req, res) => {
  try {
    const { deviceId } = req.params;
    const { enabled } = req.body;

    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be a boolean' });
    }

    const { metadata, webSources } = await readWebSourcesConfig(req.frameArtPath);
    if (!webSources.tvAssignments[deviceId]) {
      webSources.tvAssignments[deviceId] = { enabled: false };
    }
    webSources.tvAssignments[deviceId].enabled = enabled;
    await writeWebSourcesConfig(req.frameArtPath, metadata);
    res.json({ success: true, assignment: webSources.tvAssignments[deviceId] });
  } catch (error) {
    console.error('Error updating TV assignment:', error);
    res.status(500).json({ error: 'Failed to update TV assignment' });
  }
});

// POST /api/web-sources/fetch-and-display
// Body: { deviceId, sourceId? }
router.post('/fetch-and-display', async (req, res) => {
  const { deviceId, sourceId } = req.body;

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
    const fetchResult = await fetcher();

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

    // Update per-TV cache record in metadata.json
    webSources.perTvCache = webSources.perTvCache || {};
    webSources.perTvCache[deviceId] = {
      filename: path.basename(cacheFile),
      sourceId: chosenSourceId,
      artworkUrl: artMetadata.artworkUrl,
      metadata: artMetadata,
      fetchedAt: new Date().toISOString(),
    };
    await writeWebSourcesConfig(req.frameArtPath, metadata);

    // Display on TV
    await displayImageOnTV(cacheFile, deviceId);

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

module.exports = router;
module.exports.clearCacheForDevice = clearCacheForDevice;
module.exports.readWebSourcesConfig = readWebSourcesConfig;
module.exports.writeWebSourcesConfig = writeWebSourcesConfig;
