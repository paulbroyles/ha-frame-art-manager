const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const QRCode = require('qrcode');
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

// Human-readable names for built-in source IDs.
const SOURCE_DISPLAY_NAMES = {
  google_arts:         'Google Arts & Culture',
  google_art_wallpaper:'Google Arts & Culture',
  met_museum:          'Metropolitan Museum of Art',
  moma:                'MoMA',
};

function renderArtworkPage(tvName, fields, imageUrl, artworkUrl, sourceId, rawAttributes, { deviceId = null, sourceType = '', filename = null, addonHome = '' } = {}) {
  const primaryFields  = fields.filter(f => f.role === 'primary');
  const secondaryFields = fields.filter(f => f.role === 'secondary');
  const detailFields   = fields.filter(f => f.role === 'detail');

  // Artist / primary heading — scale font based on name length
  const artistField = primaryFields[0];
  const artistNameLen = (artistField?.value || '').length;
  const artistNameClass = artistNameLen > 40 ? 'name-xxl'
    : artistNameLen > 30 ? 'name-xl'
    : artistNameLen > 22 ? 'name-long'
    : '';
  const artistHtml = artistField
    ? `<h1 class="artist-name${artistNameClass ? ' ' + artistNameClass : ''}">${escapeHtml(artistField.value)}</h1>`
    : '';

  // Byline: extra attrs on the primary entity (lifespan, nationality) + any secondary fields.
  // The creator entity stores [name, lifespan, nationality] — slice(1) gives the bio part.
  const primaryExtraAttrs = (artistField?.entityAttrs || []).slice(1).filter(a => a.value);
  const bylineParts = [
    ...primaryExtraAttrs.map(a => escapeHtml(a.value)),
    ...secondaryFields.map(f => {
      if (f.entityAttrs && f.entityAttrs.length > 1) {
        const extra = f.entityAttrs.slice(1).filter(a => a.value).map(a => escapeHtml(a.value)).join(', ');
        return `${escapeHtml(f.value)}, ${extra}`;
      }
      return escapeHtml(f.value);
    }),
  ];
  const secondaryHtml = bylineParts.join('<span class="bio-sep"> · </span>');

  // Detail rows — skip fields that have dedicated display areas
  const titleValue = rawAttributes?.title ? String(rawAttributes.title) : null;
  const dateValue  = rawAttributes?.date  ? String(rawAttributes.date)  : null;
  const skipLabels = new Set(['description']);
  if (titleValue) skipLabels.add('title');
  if (dateValue)  skipLabels.add('date');
  const filteredDetailFields = detailFields.filter(
    f => !skipLabels.has(f.label?.toLowerCase())
  );
  const detailHtml = filteredDetailFields.map(f => {
    const val = f.entityAttrs && f.entityAttrs.length > 1
      ? f.entityAttrs.map(a => escapeHtml(a.value)).join(', ')
      : escapeHtml(f.value);
    return `<div class="detail-row">
      <dt class="detail-label">${escapeHtml(f.label)}</dt>
      <dd class="detail-value">${val}</dd>
    </div>`;
  }).join('');

  // Description — from fields or raw attributes
  const descFromFields = detailFields.find(f => f.label?.toLowerCase() === 'description')?.value;
  const description = descFromFields
    || (rawAttributes?.description ? String(rawAttributes.description) : '');
  const descriptionHtml = description
    ? `<p class="description">${escapeHtml(description)}</p>`
    : '';

  const sourceName  = (sourceId && SOURCE_DISPLAY_NAMES[sourceId]) || null;
  const sourceLinkHtml = artworkUrl
    ? `<a href="${escapeHtml(artworkUrl)}" target="_blank" rel="noopener" class="ext-link">
        View on ${escapeHtml(sourceName || 'source')} &rarr;
       </a>`
    : '';

  const pageTitle = titleValue || primaryFields[0]?.value || tvName;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>${escapeHtml(pageTitle)} — Artwork</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      background: #141414;
      color: #e0e0e0;
      font-family: Georgia, 'Times New Roman', serif;
      min-height: 100dvh;
      -webkit-font-smoothing: antialiased;
    }

    .page { max-width: 640px; margin: 0 auto; padding-bottom: calc(env(safe-area-inset-bottom, 0px) + 40px); }

    /* ── Image ── */
    .image-wrap {
      position: relative; width: 100%; background: #0a0a0a;
      border-bottom: 1px solid #222;
    }
    .image-wrap img {
      display: block; width: 100%; height: auto;
      cursor: zoom-in; transition: opacity 0.2s;
    }
    .image-wrap img:hover { opacity: 0.92; }

    /* ── Fullscreen overlay ── */
    .overlay {
      display: none; position: fixed; inset: 0; z-index: 100;
      background: rgba(0,0,0,0.96); overflow: auto;
      -webkit-overflow-scrolling: touch;
    }
    .overlay.active { display: flex; align-items: center; justify-content: center; }
    .overlay img {
      max-width: none; max-height: none; width: auto; height: auto;
      min-width: 100vw; min-height: 100vh; object-fit: contain;
      touch-action: pinch-zoom;
    }
    .close-btn {
      position: fixed; top: 14px; right: 14px; z-index: 101;
      background: rgba(0,0,0,0.65); color: #fff; border: 1px solid rgba(255,255,255,0.2);
      width: 36px; height: 36px; border-radius: 50%; font-size: 18px;
      cursor: pointer; display: flex; align-items: center; justify-content: center;
    }

    /* ── Content ── */
    .content { padding: 28px 20px 0; }

    /* Artist block */
    .artist-name {
      font-size: 22px; font-weight: 700; letter-spacing: 0.08em;
      text-transform: uppercase; color: #fff; line-height: 1.3;
      overflow-wrap: break-word; word-break: break-word;
    }
    /* Scale down long names — letter-spacing shrinks proportionally to avoid excessive width */
    .artist-name.name-long { font-size: 18px; letter-spacing: 0.05em; }
    .artist-name.name-xl   { font-size: 15px; letter-spacing: 0.04em; }
    .artist-name.name-xxl  { font-size: 13px; letter-spacing: 0.03em; }
    .artist-byline {
      margin-top: 6px; font-size: 14px; color: #888;
      font-style: italic; letter-spacing: 0.02em;
      overflow-wrap: break-word;
    }
    .bio-extra { color: #666; }
    .bio-sep   { color: #555; margin: 0 2px; }

    /* Title block */
    .title-block { margin-top: 20px; padding-top: 20px; border-top: 1px solid #262626; }
    .artwork-title {
      font-size: 26px; font-weight: 400; font-style: italic;
      color: #fff; line-height: 1.3;
      overflow-wrap: break-word; word-break: break-word;
    }
    .artwork-date {
      display: inline-block; margin-top: 6px;
      font-size: 14px; color: #666; font-style: normal; letter-spacing: 0.03em;
    }

    /* Details table */
    .details { margin-top: 24px; }
    .detail-row {
      display: flex; justify-content: space-between; align-items: baseline;
      flex-wrap: wrap; gap: 4px 16px; padding: 9px 0; border-bottom: 1px solid #1f1f1f;
    }
    .detail-label {
      flex-shrink: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 11px; text-transform: uppercase; letter-spacing: 0.07em; color: #555;
    }
    .detail-value {
      font-size: 15px; color: #c8c8c8; text-align: right; font-family: Georgia, serif;
      min-width: 0; overflow-wrap: break-word; word-break: break-word;
    }

    /* Description */
    .description {
      margin-top: 28px; padding-top: 24px; border-top: 1px solid #262626;
      font-size: 15px; line-height: 1.75; color: #a0a0a0;
    }

    /* Links */
    .links { margin-top: 32px; display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
    .ext-link {
      display: inline-flex; align-items: center;
      padding: 9px 18px; border: 1px solid #333;
      color: #9ab8e8; border-radius: 6px;
      text-decoration: none; font-family: -apple-system, BlinkMacSystemFont, sans-serif;
      font-size: 13px; transition: border-color 0.15s, color 0.15s;
    }
    .ext-link:hover { border-color: #555; color: #bcd0f0; }

    /* Footer */
    .footer {
      margin-top: 48px; padding: 14px 20px;
      border-top: 1px solid #1c1c1c;
      font-family: -apple-system, BlinkMacSystemFont, sans-serif;
      font-size: 11px; color: #3a3a3a; text-align: center; letter-spacing: 0.05em;
    }

    /* Action buttons */
    .actions { margin-top: 28px; display: flex; flex-wrap: wrap; gap: 10px; }
    .action-btn {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 9px 16px; border-radius: 6px; cursor: pointer;
      font-family: -apple-system, BlinkMacSystemFont, sans-serif;
      font-size: 13px; transition: background 0.15s, border-color 0.15s, opacity 0.15s;
      border: none; outline: none;
    }
    .action-btn:disabled { opacity: 0.45; cursor: default; }
    .btn-blacklist {
      background: transparent; color: #c0604a; border: 1px solid #5a2e25;
    }
    .btn-blacklist:hover:not(:disabled) { background: #2a1510; border-color: #8a3e2e; }
    .btn-blacklist.done { color: #888; border-color: #333; }
    .btn-add-library {
      background: transparent; color: #5ca87a; border: 1px solid #2a5538;
    }
    .btn-add-library:hover:not(:disabled) { background: #0f2a1a; border-color: #3d7a54; }
    .btn-add-library.done { color: #888; border-color: #333; }
  </style>
</head>
<body>
  <div class="page">

    <div class="image-wrap">
      <img src="${escapeHtml(imageUrl)}" alt="${escapeHtml(pageTitle)}" loading="eager" id="artwork-img">
    </div>

    <div class="content">

      ${artistHtml ? `
      <div class="artist-block">
        ${artistHtml}
        ${secondaryHtml ? `<p class="artist-byline">${secondaryHtml}</p>` : ''}
      </div>` : ''}

      ${titleValue ? `
      <div class="title-block">
        <h2 class="artwork-title">${escapeHtml(titleValue)}</h2>
        ${dateValue ? `<span class="artwork-date">${escapeHtml(dateValue)}</span>` : ''}
      </div>` : !artistHtml ? `<div class="title-block"><h2 class="artwork-title">${escapeHtml(pageTitle)}</h2></div>` : ''}

      ${detailHtml ? `<dl class="details">${detailHtml}</dl>` : ''}

      ${descriptionHtml}

      ${sourceLinkHtml ? `<div class="links">${sourceLinkHtml}</div>` : ''}

      <div class="actions" id="actions"></div>

    </div>

    <div class="footer">Currently on ${escapeHtml(tvName)}</div>

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
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') overlay.classList.remove('active');
    });

    // Action buttons
    const BASE = ${JSON.stringify(addonHome)};
    const SOURCE_TYPE = ${JSON.stringify(sourceType)};
    const DEVICE_ID   = ${JSON.stringify(deviceId)};
    const ARTWORK_URL = ${JSON.stringify(artworkUrl)};
    const FILENAME    = ${JSON.stringify(filename)};

    const actionsEl = document.getElementById('actions');

    function makeBtn(cls, label, onClick) {
      const btn = document.createElement('button');
      btn.className = 'action-btn ' + cls;
      btn.textContent = label;
      btn.addEventListener('click', () => onClick(btn));
      return btn;
    }

    async function apiPost(path, body) {
      const r = await fetch(BASE + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || r.statusText); }
      return r.json();
    }

    // Blacklist button — always shown
    const isWebSource = SOURCE_TYPE === 'web-source' || SOURCE_TYPE === 'web_source';
    const blacklistType = isWebSource ? 'web' : 'local';
    const blacklistId   = isWebSource ? ARTWORK_URL : FILENAME;

    if (blacklistId) {
      const blBtn = makeBtn('btn-blacklist', '✕ Blacklist', async (btn) => {
        btn.disabled = true;
        btn.textContent = 'Adding to blacklist…';
        try {
          await apiPost('/api/blacklist', { type: blacklistType, identifier: blacklistId });
          btn.textContent = 'Blacklisted';
          btn.classList.add('done');
        } catch (e) {
          btn.disabled = false;
          btn.textContent = '✕ Blacklist';
          alert('Failed: ' + e.message);
        }
      });
      actionsEl.appendChild(blBtn);
    }

    // Add to Library button — web sources only
    if (isWebSource && DEVICE_ID) {
      const libBtn = makeBtn('btn-add-library', '+ Add to Library', async (btn) => {
        btn.disabled = true;
        btn.textContent = 'Adding to library…';
        try {
          await apiPost('/api/web-sources/cache/' + encodeURIComponent(DEVICE_ID) + '/add-to-library', {});
          btn.textContent = 'Added to library';
          btn.classList.add('done');
        } catch (e) {
          btn.disabled = false;
          btn.textContent = '+ Add to Library';
          alert('Failed: ' + e.message);
        }
      });
      actionsEl.appendChild(libBtn);
    }
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

    // Collect local filename for blacklist (local source only)
    const localFilename = (sourceType === 'local')
      ? (sensor.filename || sensor.attributes?.filename || null)
      : null;

    const fields = buildDisplayFields(customDataOrder, attributeValues, entitySnapshot, entityTypes, entityInstances);
    const imageUrl = `/${req.params.tvId}/image`;

    const html = renderArtworkPage(
      tvName, fields, `/artwork${imageUrl}`, artworkUrl, sourceId, attributeValues,
      { deviceId, sourceType, filename: localFilename, addonHome: req.app.locals.addonHome || '' }
    );
    res.send(html);
  } catch (error) {
    console.error('[artwork] Error rendering artwork page:', error);
    res.status(500).send(renderErrorPage('Error', 'An unexpected error occurred.'));
  }
});

/**
 * GET /:tvId/qr — QR code PNG for the TV's artwork page URL
 *
 * ?url= — absolute URL to encode; if omitted, best-effort from request headers.
 */
router.get('/:tvId/qr', async (req, res) => {
  try {
    let url = req.query.url;
    if (!url) {
      const proto = req.headers['x-forwarded-proto'] || req.protocol;
      const host = req.headers['x-forwarded-host'] || req.get('host') || 'homeassistant.local:8123';
      url = `${proto}://${host}/artwork/${req.params.tvId}`;
    }

    const qrBuffer = await QRCode.toBuffer(url, {
      type: 'png',
      errorCorrectionLevel: 'M',
      width: 256,
      margin: 2,
    });

    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(qrBuffer);
  } catch (error) {
    console.error('[artwork] Error generating QR code:', error);
    res.status(500).json({ error: 'Failed to generate QR code' });
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

      // If the source stored a bare CDN URL (e.g. Google Art Wallpaper), redirect to
      // an uncropped version at 2560px wide — much better for the web view than the
      // TV-optimised center-crop.
      if (tvCache?.imageBaseUrl) {
        return res.redirect(302, `${tvCache.imageBaseUrl}=w2560`);
      }

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
