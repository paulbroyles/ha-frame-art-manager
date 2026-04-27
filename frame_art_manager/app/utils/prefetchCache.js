const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');

function prefetchDir(frameArtPath) {
  return path.join(frameArtPath, 'web_source_cache', 'prefetch');
}

function metaPath(frameArtPath, deviceId) {
  return path.join(prefetchDir(frameArtPath), `${deviceId}.json`);
}

function imagePath(frameArtPath, deviceId, ext) {
  return path.join(prefetchDir(frameArtPath), `${deviceId}.${ext}`);
}

/**
 * Hash of the config fields that determine which images get fetched.
 * If any of these change the stored pre-fetch is stale.
 */
function computeConfigFingerprint(webSources) {
  const relevant = {
    sources: webSources.sources || {},
    virtualTags: webSources.virtualTags || {},
    globalFilters: webSources.globalFilters || [],
    aspectRatioFilter: webSources.aspectRatioFilter || 'all',
    imageProcessing: webSources.imageProcessing || {},
  };
  return crypto.createHash('sha256')
    .update(JSON.stringify(relevant))
    .digest('hex')
    .slice(0, 16);
}

/**
 * Read the pre-fetched entry for a device.
 * Returns null if no entry exists or the image file is missing.
 */
async function readPrefetch(frameArtPath, deviceId) {
  try {
    const raw = await fs.readFile(metaPath(frameArtPath, deviceId), 'utf8');
    const meta = JSON.parse(raw);
    const img = imagePath(frameArtPath, deviceId, meta.ext);
    await fs.access(img);
    return { ...meta, imagePath: img };
  } catch {
    return null;
  }
}

/**
 * Write the pre-fetched image and its metadata for a device.
 * @param {object} data
 * @param {string} data.fingerprint
 * @param {string|null} data.virtualTagId
 * @param {string[]} [data.activeMoods]  - Mood IDs active when image was fetched
 * @param {string} data.ext
 * @param {Buffer} data.buffer          - The processed image buffer
 * @param {object} data.artMetadata
 * @param {object} [data.attributeSnapshot]
 * @param {object} [data.entitySnapshot]
 */
async function writePrefetch(frameArtPath, deviceId, { fingerprint, virtualTagId, activeMoods = [], ext, buffer, artMetadata, attributeSnapshot = {}, entitySnapshot = {} }) {
  const dir = prefetchDir(frameArtPath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(imagePath(frameArtPath, deviceId, ext), buffer);
  const meta = {
    fingerprint,
    virtualTagId: virtualTagId || null,
    activeMoods: [...activeMoods].sort(),
    ext,
    artMetadata,
    attributeSnapshot,
    entitySnapshot,
    fetchedAt: new Date().toISOString(),
  };
  await fs.writeFile(metaPath(frameArtPath, deviceId), JSON.stringify(meta, null, 2));
}

/**
 * Delete the pre-fetched image for a device.
 */
async function deletePrefetch(frameArtPath, deviceId) {
  let ext;
  try {
    const raw = await fs.readFile(metaPath(frameArtPath, deviceId), 'utf8');
    ext = JSON.parse(raw).ext;
  } catch { /* meta missing — image may still be here in an unknown ext */ }

  await fs.unlink(metaPath(frameArtPath, deviceId)).catch(() => {});
  if (ext) {
    await fs.unlink(imagePath(frameArtPath, deviceId, ext)).catch(() => {});
  }
}

/**
 * Delete all pre-fetched images (e.g. after a config change).
 */
async function deleteAllPrefetches(frameArtPath) {
  const dir = prefetchDir(frameArtPath);
  try {
    const files = await fs.readdir(dir);
    await Promise.all(files.map(f => fs.unlink(path.join(dir, f)).catch(() => {})));
  } catch { /* directory may not exist */ }
}

/**
 * Return a map of deviceId → meta for all stored pre-fetches.
 */
async function listPrefetches(frameArtPath) {
  const dir = prefetchDir(frameArtPath);
  const result = {};
  try {
    const files = await fs.readdir(dir);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const deviceId = file.slice(0, -5);
      try {
        const raw = await fs.readFile(path.join(dir, file), 'utf8');
        result[deviceId] = JSON.parse(raw);
      } catch { /* skip corrupt entry */ }
    }
  } catch { /* directory may not exist */ }
  return result;
}

module.exports = {
  computeConfigFingerprint,
  readPrefetch,
  writePrefetch,
  deletePrefetch,
  deleteAllPrefetches,
  listPrefetches,
};
