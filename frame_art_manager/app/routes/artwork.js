const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const router = express.Router();

const { haRequest } = require('./ha');
const { readWebSourcesConfig } = require('./web_sources');
const MetadataHelper = require('../metadata_helper');
const ImageEditService = require('../image_edit_service');

// ── Helpers ───────────────────────────────────────────────────────────────────

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Query HA for artwork_info sensors, return map of deviceId → sensor data.
 */
async function getArtworkInfoSensors() {
  const template = `
{% set ns = namespace(result=[]) %}
{% for state in states.sensor %}
  {% if state.entity_id.endswith('_artwork_info') %}
    {% set device_id = device_id(state.entity_id) %}
    {% set device_name = device_attr(device_id, 'name') if device_id else '' %}
    {% set attrs = state.attributes | default({}) %}
    {% set ns.result = ns.result + [dict(
      entity_id=state.entity_id,
      device_id=device_id,
      device_name=device_name,
      state=state.state,
      source_type=attrs.get('source_type', ''),
      filename=attrs.get('filename', ''),
      attributes=attrs
    )] %}
  {% endif %}
{% endfor %}
{{ ns.result | to_json }}`;

  const result = await haRequest('POST', '/template', { template });
  return JSON.parse(typeof result === 'string' ? result : JSON.stringify(result));
}

/**
 * Resolve a tvId param to a sensor entry — match by device_id or slugified device name.
 */
function findTvSensor(sensors, tvId) {
  const slug = slugify(tvId);
  return sensors.find(s =>
    s.device_id === tvId || slugify(s.device_name || '') === slug
  );
}

/**
 * Build display fields from customDataOrder + value sources.
 * Returns array of { label, value, role }.
 */
function buildDisplayFields(customDataOrder, attributeValues, entitySnapshot, entityTypes, entityInstances) {
  const fields = [];
  const entityTypeMap = Object.fromEntries((entityTypes || []).map(e => [e.id, e]));

  for (const entry of customDataOrder) {
    const role = entry.displayRole || 'detail';

    if (entry.type === 'attribute') {
      const value = attributeValues[entry.name];
      if (value !== undefined && value !== null && value !== '') {
        fields.push({ label: entry.name, value: String(value), role });
      }
    } else if (entry.type === 'entity') {
      const et = entityTypeMap[entry.id];
      if (!et) continue;

      // For web sources: entitySnapshot has { entityId: { attrName: value } }
      const snapshotData = entitySnapshot?.[entry.id];
      if (snapshotData) {
        // Use first attribute as primary display value
        const primaryAttr = et.attributes?.[0];
        const primaryValue = primaryAttr ? snapshotData[primaryAttr] : null;
        if (primaryValue) {
          fields.push({
            label: et.name,
            value: String(primaryValue),
            role,
            entityAttrs: et.attributes
              .map(a => ({ name: a, value: snapshotData[a] }))
              .filter(a => a.value !== undefined && a.value !== null && a.value !== '')
          });
        }
        continue;
      }

      // For local images: entityRefs has { entityId: instanceKey }
      // (handled by caller normalizing into entitySnapshot format)
    }
  }
  return fields;
}

/**
 * Reconstruct attributeSnapshot + entitySnapshot from flattened sensor attributes.
 * Used as fallback when perTvCache is stale.
 * buildHaMetadata flattens entities as `entityId_attrName`, so we reverse that.
 */
function reconstructFromSensorAttributes(sensorAttrs, entityTypes) {
  const attributeValues = {};
  const entitySnapshot = {};
  const systemAttrs = new Set(['source_type', 'filename', 'icon', 'friendly_name']);

  // Build entity prefix map: { 'artist_': entityType }
  const prefixMap = new Map();
  for (const et of entityTypes) {
    prefixMap.set(`${et.id}_`, et);
  }

  for (const [key, value] of Object.entries(sensorAttrs || {})) {
    if (systemAttrs.has(key) || value === null || value === undefined || value === '') continue;

    let matched = false;
    for (const [prefix, et] of prefixMap) {
      if (key.startsWith(prefix)) {
        const attrSuffix = key.slice(prefix.length);
        const actualAttr = (et.attributes || []).find(
          a => a.toLowerCase().replace(/\s+/g, '_') === attrSuffix
        );
        if (actualAttr) {
          if (!entitySnapshot[et.id]) entitySnapshot[et.id] = {};
          entitySnapshot[et.id][actualAttr] = value;
          matched = true;
          break;
        }
      }
    }
    if (!matched) {
      attributeValues[key] = value;
    }
  }

  return { attributeValues, entitySnapshot };
}

/**
 * Resolve local image entityRefs into entitySnapshot format.
 */
function resolveEntityRefs(entityRefs, entityInstances) {
  const snapshot = {};
  for (const [entityId, instanceKey] of Object.entries(entityRefs || {})) {
    const instance = entityInstances?.[entityId]?.[instanceKey];
    if (instance) {
      snapshot[entityId] = instance;
    }
  }
  return snapshot;
}

// ── Page Rendering ────────────────────────────────────────────────────────────

function renderArtworkPage(tvName, fields, imageUrl, artworkUrl, sourceId) {
  const primaryFields = fields.filter(f => f.role === 'primary');
  const secondaryFields = fields.filter(f => f.role === 'secondary');
  const detailFields = fields.filter(f => f.role === 'detail');

  const primaryHtml = primaryFields.map(f =>
    `<h1 class="primary-field">${escapeHtml(f.value)}</h1>`
  ).join('');

  const secondaryHtml = secondaryFields.map(f => {
    if (f.entityAttrs && f.entityAttrs.length > 1) {
      const extra = f.entityAttrs.slice(1).map(a => escapeHtml(a.value)).join(', ');
      return `<p class="secondary-field">${escapeHtml(f.value)} <span class="secondary-extra">${extra}</span></p>`;
    }
    return `<p class="secondary-field">${escapeHtml(f.value)}</p>`;
  }).join('');

  const detailHtml = detailFields.map(f => {
    if (f.entityAttrs && f.entityAttrs.length > 1) {
      const allValues = f.entityAttrs.map(a => escapeHtml(a.value)).join(', ');
      return `<div class="detail-row"><span class="detail-label">${escapeHtml(f.label)}</span><span class="detail-value">${allValues}</span></div>`;
    }
    return `<div class="detail-row"><span class="detail-label">${escapeHtml(f.label)}</span><span class="detail-value">${escapeHtml(f.value)}</span></div>`;
  }).join('');

  const sourceLinkHtml = artworkUrl
    ? `<a href="${escapeHtml(artworkUrl)}" target="_blank" rel="noopener" class="source-link">View on source &rarr;</a>`
    : '';

  const heading = primaryHtml || `<h1 class="primary-field">${escapeHtml(tvName)}</h1>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>${escapeHtml(primaryFields[0]?.value || tvName)} — Artwork Info</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #1a1a1a;
      color: #e8e8e8;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      min-height: 100dvh;
      -webkit-font-smoothing: antialiased;
    }
    .artwork-page { max-width: 600px; margin: 0 auto; padding-bottom: env(safe-area-inset-bottom, 20px); }

    /* Image */
    .image-container { position: relative; width: 100%; background: #111; }
    .image-container img {
      display: block; width: 100%; height: auto; cursor: zoom-in;
    }

    /* Fullscreen overlay */
    .overlay {
      display: none; position: fixed; inset: 0; z-index: 100;
      background: rgba(0,0,0,0.95);
      overflow: auto;
      -webkit-overflow-scrolling: touch;
    }
    .overlay.active { display: flex; align-items: center; justify-content: center; }
    .overlay img {
      max-width: none; max-height: none;
      width: auto; height: auto;
      min-width: 100vw; min-height: 100vh;
      object-fit: contain;
      touch-action: pinch-zoom;
    }
    .overlay .close-btn {
      position: fixed; top: 12px; right: 12px; z-index: 101;
      background: rgba(0,0,0,0.6); color: #fff; border: none;
      width: 36px; height: 36px; border-radius: 50%;
      font-size: 20px; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
    }

    /* Metadata */
    .metadata { padding: 20px 16px; }
    .primary-field {
      font-size: 24px; font-weight: 600; line-height: 1.2;
      margin-bottom: 4px; color: #fff;
    }
    .secondary-field {
      font-size: 17px; color: #b0b0b0; margin-bottom: 12px;
    }
    .secondary-extra { color: #888; }
    .details { margin-top: 16px; }
    .detail-row {
      display: flex; justify-content: space-between; align-items: baseline;
      padding: 8px 0; border-bottom: 1px solid #2a2a2a;
    }
    .detail-label { color: #888; font-size: 13px; text-transform: uppercase; letter-spacing: 0.5px; flex-shrink: 0; margin-right: 16px; }
    .detail-value { color: #d0d0d0; font-size: 15px; text-align: right; }

    .source-link {
      display: inline-block; margin-top: 20px; padding: 10px 20px;
      background: #2a2a2a; color: #8ab4f8; border-radius: 8px;
      text-decoration: none; font-size: 14px; transition: background 0.15s;
    }
    .source-link:hover { background: #333; }

    .footer {
      margin-top: 32px; padding: 16px 0; border-top: 1px solid #2a2a2a;
      color: #555; font-size: 12px; text-align: center;
    }
  </style>
</head>
<body>
  <div class="artwork-page">
    <div class="image-container">
      <img src="${escapeHtml(imageUrl)}" alt="Artwork" loading="eager" id="artwork-img">
    </div>
    <div class="metadata">
      ${heading}
      ${secondaryHtml}
      ${detailHtml ? `<div class="details">${detailHtml}</div>` : ''}
      ${sourceLinkHtml}
      <div class="footer">${escapeHtml(tvName)}</div>
    </div>
  </div>

  <div class="overlay" id="overlay">
    <button class="close-btn" id="close-overlay">&times;</button>
    <img src="${escapeHtml(imageUrl)}" alt="Full artwork">
  </div>

  <script>
    const img = document.getElementById('artwork-img');
    const overlay = document.getElementById('overlay');
    const closeBtn = document.getElementById('close-overlay');
    img.addEventListener('click', () => overlay.classList.add('active'));
    closeBtn.addEventListener('click', () => overlay.classList.remove('active'));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.classList.remove('active');
    });
  </script>
</body>
</html>`;
}

function renderErrorPage(title, message) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    body { background: #1a1a1a; color: #e8e8e8; font-family: -apple-system, BlinkMacSystemFont, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .error { text-align: center; padding: 40px 20px; }
    h1 { font-size: 20px; margin-bottom: 12px; color: #fff; }
    p { color: #888; font-size: 15px; }
  </style>
</head>
<body><div class="error"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></div></body>
</html>`;
}

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * GET /:tvId — Artwork info page
 */
router.get('/:tvId', async (req, res) => {
  try {
    // Fetch artwork_info sensors from HA
    let sensors;
    try {
      sensors = await getArtworkInfoSensors();
    } catch (err) {
      console.error('[artwork] Failed to query HA:', err.message);
      return res.status(503).send(renderErrorPage('Unavailable', 'Could not connect to Home Assistant.'));
    }

    const sensor = findTvSensor(sensors, req.params.tvId);
    if (!sensor) {
      return res.status(404).send(renderErrorPage('TV Not Found', `No TV found matching "${req.params.tvId}".`));
    }

    const sourceType = sensor.source_type || sensor.attributes?.source_type || '';
    const tvName = sensor.device_name || req.params.tvId;
    const deviceId = sensor.device_id;
    if (!sensor.state || sensor.state === 'unknown' || sensor.state === 'unavailable') {
      return res.status(200).send(renderErrorPage('No Artwork', `${tvName} is not currently displaying any artwork.`));
    }

    // Load custom data order
    const metadataHelper = new MetadataHelper(req.frameArtPath);
    const customDataOrder = await metadataHelper.getCustomDataOrder();
    const metadata = await metadataHelper.readMetadata();
    const entityTypes = metadata.entityTypes || [];
    const entityInstances = metadata.entityInstances || {};

    // Build attribute values and entity snapshot based on source type
    let attributeValues = {};
    let entitySnapshot = {};
    let artworkUrl = null;
    let sourceId = null;

    if (sourceType === 'web-source' || sourceType === 'web_source') {
      // Web source: prefer perTvCache (structured data), but validate against sensor
      const webConfig = await readWebSourcesConfig(req.frameArtPath);
      const tvCache = webConfig?.perTvCache?.[deviceId];

      // Check if cache matches what's currently displayed by comparing a known field
      const cacheTitle = tvCache?.attributeSnapshot?.title;
      const sensorTitle = sensor.attributes?.title;
      const cacheIsCurrent = tvCache && cacheTitle && cacheTitle === sensorTitle;

      if (cacheIsCurrent) {
        attributeValues = tvCache.attributeSnapshot || {};
        entitySnapshot = tvCache.entitySnapshot || {};
        artworkUrl = tvCache.artworkUrl || null;
        sourceId = tvCache.sourceId || null;
      } else {
        // Cache stale or missing — reconstruct from sensor attributes
        const reconstructed = reconstructFromSensorAttributes(sensor.attributes, entityTypes);
        attributeValues = reconstructed.attributeValues;
        entitySnapshot = reconstructed.entitySnapshot;
      }
    } else if (sourceType === 'local') {
      // Local image: read from metadata.json
      const filename = sensor.filename || sensor.attributes?.filename;
      if (filename && metadata.images?.[filename]) {
        const imageMeta = metadata.images[filename];
        attributeValues = imageMeta.attributes || {};
        entitySnapshot = resolveEntityRefs(imageMeta.entityRefs, entityInstances);
      }
    }

    const fields = buildDisplayFields(customDataOrder, attributeValues, entitySnapshot, entityTypes, entityInstances);
    const imageUrl = `/${req.params.tvId}/image`;

    const html = renderArtworkPage(tvName, fields, `/artwork${imageUrl}`, artworkUrl, sourceId);
    res.send(html);
  } catch (error) {
    console.error('[artwork] Error rendering artwork page:', error);
    res.status(500).send(renderErrorPage('Error', 'An unexpected error occurred.'));
  }
});

/**
 * GET /:tvId/image — Serve the full uncropped image
 */
router.get('/:tvId/image', async (req, res) => {
  try {
    // Resolve TV
    let sensors;
    try {
      sensors = await getArtworkInfoSensors();
    } catch (err) {
      return res.status(503).json({ error: 'Could not connect to Home Assistant' });
    }

    const sensor = findTvSensor(sensors, req.params.tvId);
    if (!sensor) return res.status(404).json({ error: 'TV not found' });

    const sourceType = sensor.source_type || sensor.attributes?.source_type || '';
    const deviceId = sensor.device_id;

    if (sourceType === 'web-source' || sourceType === 'web_source') {
      // Serve original uncropped image from web_source_cache
      const webConfig = await readWebSourcesConfig(req.frameArtPath);
      const tvCache = webConfig?.perTvCache?.[deviceId];
      const originalFilename = tvCache?.originalFilename;
      if (!originalFilename) return res.status(404).json({ error: 'No cached image' });

      const cachePath = path.join(req.frameArtPath, 'web_source_cache', originalFilename);
      try {
        await fs.access(cachePath);
      } catch {
        return res.status(404).json({ error: 'Cached image file not found' });
      }

      const ext = path.extname(originalFilename).toLowerCase();
      const contentType = ext === '.png' ? 'image/png' : 'image/jpeg';
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'no-cache');
      const buffer = await fs.readFile(cachePath);
      res.send(buffer);
    } else if (sourceType === 'local') {
      // Serve original (unedited) or library image
      const filename = sensor.filename || sensor.attributes?.filename;
      if (!filename) return res.status(404).json({ error: 'No filename' });

      const editService = new ImageEditService(req.frameArtPath);
      const { hasBackup } = await editService.getEditState(filename);

      let imagePath;
      if (hasBackup) {
        // Serve the unedited original
        const ext = path.extname(filename);
        const nameWithoutExt = filename.slice(0, filename.length - ext.length);
        const backupFilename = `${nameWithoutExt}_original${ext}`;
        imagePath = path.join(req.frameArtPath, 'originals', backupFilename);
      } else {
        imagePath = path.join(req.frameArtPath, 'library', filename);
      }

      try {
        await fs.access(imagePath);
      } catch {
        return res.status(404).json({ error: 'Image file not found' });
      }

      const ext = path.extname(imagePath).toLowerCase();
      const contentType = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'no-cache');
      const buffer = await fs.readFile(imagePath);
      res.send(buffer);
    } else {
      return res.status(404).json({ error: 'No image available for this source type' });
    }
  } catch (error) {
    console.error('[artwork] Error serving image:', error);
    res.status(500).json({ error: 'Failed to serve image' });
  }
});

module.exports = router;
