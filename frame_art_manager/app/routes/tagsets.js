/**
 * Tagset definitions storage and CRUD API.
 *
 * Tagset definitions (include/exclude tags, weighting type, tag weights) are
 * stored in tagsets.json in FRAME_ART_PATH. Per-TV assignments (selected_tagset,
 * override_tagset) remain in the HA config entry and are managed via HA services.
 *
 * Routes:
 *   GET    /api/tagsets                   List all tagset definitions
 *   POST   /api/tagsets                   Create a tagset
 *   PUT    /api/tagsets/:name             Update (or rename) a tagset
 *   DELETE /api/tagsets/:name             Delete a tagset
 *   POST   /api/tagsets/:name/select      Assign tagset to a TV (proxies HA service)
 *   POST   /api/tagsets/:name/override    Apply temporary override (proxies HA service)
 *   POST   /api/tagsets/clear-override    Clear override on a TV (proxies HA service)
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs').promises;
const axios = require('axios');

// ── HA API helpers ─────────────────────────────────────────────────────────

const SUPERVISOR_TOKEN = process.env.SUPERVISOR_TOKEN;
const HA_API_BASE = process.env.HA_URL || 'http://supervisor/core/api';

async function haRequest(method, endpoint, data = null) {
  const url = `${HA_API_BASE}${endpoint}`;
  const headers = {
    Authorization: `Bearer ${SUPERVISOR_TOKEN}`,
    'Content-Type': 'application/json',
  };
  const config = { method, url, headers };
  if (data) config.data = data;
  const response = await axios(config);
  return response.data;
}

const requireHA = (req, res, next) => {
  if (!SUPERVISOR_TOKEN) {
    if (process.env.NODE_ENV === 'development') return next();
    return res.status(503).json({
      error: 'Home Assistant Supervisor token not found. Are we running as an Add-on?',
    });
  }
  next();
};

// ── Storage helpers ────────────────────────────────────────────────────────

function tagsetsConfigPath(frameArtPath) {
  return path.join(frameArtPath, 'tagsets.json');
}

/**
 * Read tagsets from tagsets.json. Returns `{ version, tagsets }`.
 * If the file does not exist, returns an empty config gracefully.
 */
async function readTagsets(frameArtPath) {
  const configPath = tagsetsConfigPath(frameArtPath);
  try {
    const raw = await fs.readFile(configPath, 'utf8');
    const config = JSON.parse(raw);
    if (!config.tagsets) config.tagsets = {};
    return config;
  } catch {
    return { version: 1, tagsets: {} };
  }
}

/**
 * Write tagsets config to tagsets.json.
 */
async function writeTagsets(frameArtPath, config) {
  const configPath = tagsetsConfigPath(frameArtPath);
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
}

// Export helpers for use in other route files (e.g. shuffle.js, ha.js)
module.exports.readTagsets = readTagsets;
module.exports.writeTagsets = writeTagsets;
module.exports.tagsetsConfigPath = tagsetsConfigPath;

// ── GET /api/tagsets ───────────────────────────────────────────────────────

/**
 * List all tagset definitions.
 * Response: { tagsets: { name: { tags, exclude_tags, weighting_type, tag_weights } } }
 */
router.get('/', async (req, res) => {
  try {
    const config = await readTagsets(req.frameArtPath);
    res.json({ tagsets: config.tagsets });
  } catch (err) {
    console.error('[tagsets] GET /: error reading tagsets:', err.message);
    res.status(500).json({ error: 'Failed to read tagsets' });
  }
});

// ── POST /api/tagsets ──────────────────────────────────────────────────────

/**
 * Create a new tagset definition.
 * Body: { name, tags, exclude_tags?, weighting_type?, tag_weights? }
 */
router.post('/', async (req, res) => {
  const { name, tags, exclude_tags, weighting_type, tag_weights } = req.body;

  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Tagset name is required' });
  }
  if (!tags || !Array.isArray(tags) || tags.length === 0) {
    return res.status(400).json({ error: 'At least one tag is required' });
  }

  const tagsetName = name.trim();

  try {
    const config = await readTagsets(req.frameArtPath);

    if (config.tagsets[tagsetName]) {
      return res.status(409).json({ error: `Tagset '${tagsetName}' already exists` });
    }

    config.tagsets[tagsetName] = _buildTagsetEntry(tags, exclude_tags, weighting_type, tag_weights);
    await writeTagsets(req.frameArtPath, config);

    res.json({ success: true, message: `Tagset '${tagsetName}' created`, tagset: config.tagsets[tagsetName] });
  } catch (err) {
    console.error('[tagsets] POST /: error creating tagset:', err.message);
    res.status(500).json({ error: 'Failed to create tagset' });
  }
});

// ── PUT /api/tagsets/:name ─────────────────────────────────────────────────

/**
 * Update a tagset definition (and optionally rename it).
 * Body: { tags, exclude_tags?, weighting_type?, tag_weights?, newName? }
 */
router.put('/:name', async (req, res) => {
  const oldName = req.params.name;
  const { tags, exclude_tags, weighting_type, tag_weights, newName } = req.body;

  if (!tags || !Array.isArray(tags) || tags.length === 0) {
    return res.status(400).json({ error: 'At least one tag is required' });
  }

  try {
    const config = await readTagsets(req.frameArtPath);

    if (!config.tagsets[oldName]) {
      return res.status(404).json({ error: `Tagset '${oldName}' not found` });
    }

    const finalName = (newName && newName.trim() && newName.trim() !== oldName)
      ? newName.trim()
      : oldName;

    if (finalName !== oldName && config.tagsets[finalName]) {
      return res.status(409).json({ error: `Tagset '${finalName}' already exists` });
    }

    const updated = _buildTagsetEntry(tags, exclude_tags, weighting_type, tag_weights);

    if (finalName !== oldName) {
      // Rename: delete old key, add new key
      delete config.tagsets[oldName];
      config.tagsets[finalName] = updated;
    } else {
      config.tagsets[oldName] = updated;
    }

    await writeTagsets(req.frameArtPath, config);
    res.json({ success: true, message: `Tagset '${finalName}' updated`, tagset: updated });
  } catch (err) {
    console.error('[tagsets] PUT /:name: error updating tagset:', err.message);
    res.status(500).json({ error: 'Failed to update tagset' });
  }
});

// ── DELETE /api/tagsets/:name ──────────────────────────────────────────────

/**
 * Delete a tagset definition.
 * Validates: tagset exists, not the only tagset, not assigned to any TV.
 */
router.delete('/:name', requireHA, async (req, res) => {
  const tagsetName = req.params.name;

  try {
    const config = await readTagsets(req.frameArtPath);

    if (!config.tagsets[tagsetName]) {
      return res.status(404).json({ error: `Tagset '${tagsetName}' not found` });
    }

    if (Object.keys(config.tagsets).length <= 1) {
      return res.status(400).json({ error: 'Cannot delete the only tagset' });
    }

    // Check TV assignments via HA Template API
    if (SUPERVISOR_TOKEN) {
      try {
        const template = `
          {% set ns = namespace(tvs=[]) %}
          {% set devices = integration_entities('frame_art_shuffler') | map('device_id') | unique | list %}
          {% for device_id in devices %}
            {% if device_id and device_id != 'None' %}
              {% set device_name = device_attr(device_id, 'name') %}
              {% set ns.selected = none %}
              {% set ns.override = none %}
              {% for entity in device_entities(device_id) %}
                {% if entity.endswith('_current_artwork') %}
                  {% set sel = state_attr(entity, 'selected_tagset') %}
                  {% if sel %}{% set ns.selected = sel %}{% endif %}
                  {% set ov = state_attr(entity, 'override_tagset') %}
                  {% if ov %}{% set ns.override = ov %}{% endif %}
                {% endif %}
              {% endfor %}
              {% set ns.tvs = ns.tvs + [{'name': device_name, 'selected_tagset': ns.selected, 'override_tagset': ns.override}] %}
            {% endif %}
          {% endfor %}
          {{ ns.tvs | to_json }}
        `;
        const result = await haRequest('POST', '/template', { template });
        const tvs = typeof result === 'string' ? JSON.parse(result) : (result || []);
        for (const tv of tvs) {
          if (tv.selected_tagset === tagsetName) {
            return res.status(400).json({
              error: `Cannot delete tagset '${tagsetName}': selected by ${tv.name}. Select a different tagset first.`,
            });
          }
          if (tv.override_tagset === tagsetName) {
            return res.status(400).json({
              error: `Cannot delete tagset '${tagsetName}': active override on ${tv.name}. Clear the override first.`,
            });
          }
        }
      } catch (haErr) {
        console.warn('[tagsets] DELETE: could not verify TV assignments:', haErr.message);
        // Non-fatal: proceed with deletion if we can't check
      }
    }

    delete config.tagsets[tagsetName];
    await writeTagsets(req.frameArtPath, config);
    res.json({ success: true, message: `Tagset '${tagsetName}' deleted` });
  } catch (err) {
    console.error('[tagsets] DELETE /:name: error deleting tagset:', err.message);
    res.status(500).json({ error: 'Failed to delete tagset' });
  }
});

// ── Assignment proxies (HA service calls) ──────────────────────────────────

/**
 * POST /api/tagsets/:name/select
 * Assign this tagset as the permanent selection for a TV.
 * Body: { device_id }
 */
router.post('/:name/select', requireHA, async (req, res) => {
  const tagsetName = req.params.name;
  const { device_id } = req.body;

  if (!device_id) {
    return res.status(400).json({ error: 'device_id is required' });
  }

  try {
    await haRequest('POST', '/services/frame_art_shuffler/select_tagset', {
      device_id,
      name: tagsetName,
    });
    res.json({ success: true, message: `Tagset '${tagsetName}' selected` });
  } catch (err) {
    console.error('[tagsets] POST /:name/select: error:', err.message);
    res.status(500).json({ error: 'Failed to select tagset', details: err.message });
  }
});

/**
 * POST /api/tagsets/:name/override
 * Apply a temporary tagset override on a TV.
 * Body: { device_id, duration_minutes }
 */
router.post('/:name/override', requireHA, async (req, res) => {
  const tagsetName = req.params.name;
  const { device_id, duration_minutes } = req.body;

  if (!device_id) {
    return res.status(400).json({ error: 'device_id is required' });
  }
  if (!duration_minutes || typeof duration_minutes !== 'number' || duration_minutes <= 0) {
    return res.status(400).json({ error: 'duration_minutes must be a positive number' });
  }

  try {
    await haRequest('POST', '/services/frame_art_shuffler/override_tagset', {
      device_id,
      name: tagsetName,
      duration_minutes,
    });
    res.json({ success: true, message: `Override '${tagsetName}' applied for ${duration_minutes} minutes` });
  } catch (err) {
    console.error('[tagsets] POST /:name/override: error:', err.message);
    res.status(500).json({ error: 'Failed to apply override', details: err.message });
  }
});

/**
 * POST /api/tagsets/clear-override
 * Clear the active tagset override on a TV.
 * Body: { device_id }
 */
router.post('/clear-override', requireHA, async (req, res) => {
  const { device_id } = req.body;

  if (!device_id) {
    return res.status(400).json({ error: 'device_id is required' });
  }

  try {
    await haRequest('POST', '/services/frame_art_shuffler/clear_tagset_override', { device_id });
    res.json({ success: true, message: 'Override cleared' });
  } catch (err) {
    console.error('[tagsets] POST /clear-override: error:', err.message);
    res.status(500).json({ error: 'Failed to clear override', details: err.message });
  }
});

// ── Helpers ────────────────────────────────────────────────────────────────

function _buildTagsetEntry(tags, exclude_tags, weighting_type, tag_weights) {
  const entry = {
    tags: tags.filter(t => t && typeof t === 'string'),
    exclude_tags: (exclude_tags || []).filter(t => t && typeof t === 'string'),
    weighting_type: weighting_type === 'tag' ? 'tag' : 'image',
    tag_weights: {},
  };
  if (tag_weights && typeof tag_weights === 'object') {
    for (const [tag, weight] of Object.entries(tag_weights)) {
      const w = parseFloat(weight);
      if (!isNaN(w) && w >= 0.1 && w <= 10) {
        entry.tag_weights[tag] = w;
      }
    }
  }
  return entry;
}

module.exports = router;
module.exports.readTagsets = readTagsets;
module.exports.writeTagsets = writeTagsets;
module.exports.tagsetsConfigPath = tagsetsConfigPath;
