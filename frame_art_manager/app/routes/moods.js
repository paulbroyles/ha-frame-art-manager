/**
 * Mood definitions storage and CRUD API.
 *
 * Moods are composable modifiers that layer on top of tagsets at shuffle time.
 * Multiple moods can be active simultaneously (driven by HA sensors/automations),
 * each boosting or suppressing certain tags, injecting web search terms, and
 * providing post-fetch metadata rejection filters.
 *
 * Routes:
 *   GET    /api/moods           List all mood definitions
 *   POST   /api/moods           Create a mood
 *   PUT    /api/moods/:id       Update a mood
 *   DELETE /api/moods/:id       Delete a mood
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs').promises;

// ── Storage helpers ────────────────────────────────────────────────────────

function moodsConfigPath(frameArtPath) {
  return path.join(frameArtPath, 'moods.json');
}

/**
 * Read moods from moods.json. Returns `{ version, moods }`.
 * If the file does not exist, returns an empty config gracefully.
 */
async function readMoods(frameArtPath) {
  const configPath = moodsConfigPath(frameArtPath);
  try {
    const raw = await fs.readFile(configPath, 'utf8');
    const config = JSON.parse(raw);
    if (!config.moods) config.moods = {};
    return config;
  } catch {
    return { version: 1, moods: {} };
  }
}

/**
 * Write moods config to moods.json.
 */
async function writeMoods(frameArtPath, config) {
  const configPath = moodsConfigPath(frameArtPath);
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
}

// Export helpers for use in other route files (e.g. shuffle.js)
module.exports.readMoods = readMoods;
module.exports.writeMoods = writeMoods;
module.exports.moodsConfigPath = moodsConfigPath;

// ── Validation ─────────────────────────────────────────────────────────────

const VALID_ID = /^[a-z0-9_-]+$/;

function validateMoodId(id) {
  if (!id || typeof id !== 'string' || !id.trim()) {
    return 'Mood ID is required';
  }
  if (!VALID_ID.test(id)) {
    return 'Mood ID must contain only lowercase letters, numbers, underscores, or hyphens';
  }
  return null;
}

/**
 * Build a clean, normalized mood entry from raw input.
 */
function _buildMoodEntry(body) {
  const {
    id,
    label,
    boost_tags,
    suppress_tags,
    suppress_mode,
    search_terms,
    search_compose,
    reject_terms,
    filters,
    strength,
    exclusive,
  } = body;

  const cleanStrings = (arr) =>
    (Array.isArray(arr) ? arr : []).filter((t) => t && typeof t === 'string').map((t) => t.trim());

  const cleanFilters = (arr) => {
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (f) => f && typeof f === 'object' && typeof f.type === 'string' && typeof f.mode === 'string'
    );
  };

  const strengthVal = parseFloat(strength);

  return {
    id: typeof id === 'string' ? id.trim() : '',
    label: typeof label === 'string' ? label.trim() : (typeof id === 'string' ? id.trim() : ''),
    boost_tags: cleanStrings(boost_tags),
    suppress_tags: cleanStrings(suppress_tags),
    suppress_mode: suppress_mode === 'exclude' ? 'exclude' : 'penalize',
    search_terms: cleanStrings(search_terms),
    search_compose: search_compose !== false,
    reject_terms: cleanStrings(reject_terms),
    filters: cleanFilters(filters),
    strength: !isNaN(strengthVal) && strengthVal >= 0.1 && strengthVal <= 10 ? strengthVal : 1.0,
    exclusive: exclusive === true,
  };
}

// ── GET /api/moods ─────────────────────────────────────────────────────────

/**
 * List all mood definitions.
 * Response: { moods: { id: { ...moodDef } } }
 */
router.get('/', async (req, res) => {
  try {
    const config = await readMoods(req.frameArtPath);
    res.json({ moods: config.moods });
  } catch (err) {
    console.error('[moods] GET /: error reading moods:', err.message);
    res.status(500).json({ error: 'Failed to read moods' });
  }
});

// ── POST /api/moods ────────────────────────────────────────────────────────

/**
 * Create a new mood definition.
 * Body: { id, label?, boost_tags?, suppress_tags?, suppress_mode?, search_terms?,
 *         search_compose?, reject_terms?, filters?, strength?, exclusive? }
 */
router.post('/', async (req, res) => {
  const idError = validateMoodId(req.body.id);
  if (idError) return res.status(400).json({ error: idError });

  const moodId = req.body.id.trim();

  try {
    const config = await readMoods(req.frameArtPath);

    if (config.moods[moodId]) {
      return res.status(409).json({ error: `Mood '${moodId}' already exists` });
    }

    const entry = _buildMoodEntry(req.body);
    config.moods[moodId] = entry;
    await writeMoods(req.frameArtPath, config);

    res.json({ success: true, message: `Mood '${moodId}' created`, mood: entry });
  } catch (err) {
    console.error('[moods] POST /: error creating mood:', err.message);
    res.status(500).json({ error: 'Failed to create mood' });
  }
});

// ── PUT /api/moods/:id ─────────────────────────────────────────────────────

/**
 * Update a mood definition (and optionally rename it).
 * Body: { label?, boost_tags?, suppress_tags?, suppress_mode?, search_terms?,
 *         search_compose?, reject_terms?, filters?, strength?, exclusive?, newId? }
 */
router.put('/:id', async (req, res) => {
  const oldId = req.params.id;
  const { newId } = req.body;

  try {
    const config = await readMoods(req.frameArtPath);

    if (!config.moods[oldId]) {
      return res.status(404).json({ error: `Mood '${oldId}' not found` });
    }

    let finalId = oldId;
    if (newId && newId.trim() && newId.trim() !== oldId) {
      const idError = validateMoodId(newId.trim());
      if (idError) return res.status(400).json({ error: idError });
      finalId = newId.trim();
      if (config.moods[finalId]) {
        return res.status(409).json({ error: `Mood '${finalId}' already exists` });
      }
    }

    const updated = _buildMoodEntry({ ...req.body, id: finalId });

    if (finalId !== oldId) {
      delete config.moods[oldId];
    }
    config.moods[finalId] = updated;
    await writeMoods(req.frameArtPath, config);

    res.json({ success: true, message: `Mood '${finalId}' updated`, mood: updated });
  } catch (err) {
    console.error('[moods] PUT /:id: error updating mood:', err.message);
    res.status(500).json({ error: 'Failed to update mood' });
  }
});

// ── DELETE /api/moods/:id ──────────────────────────────────────────────────

/**
 * Delete a mood definition.
 */
router.delete('/:id', async (req, res) => {
  const moodId = req.params.id;

  try {
    const config = await readMoods(req.frameArtPath);

    if (!config.moods[moodId]) {
      return res.status(404).json({ error: `Mood '${moodId}' not found` });
    }

    delete config.moods[moodId];
    await writeMoods(req.frameArtPath, config);

    res.json({ success: true, message: `Mood '${moodId}' deleted` });
  } catch (err) {
    console.error('[moods] DELETE /:id: error deleting mood:', err.message);
    res.status(500).json({ error: 'Failed to delete mood' });
  }
});

module.exports = router;
module.exports.readMoods = readMoods;
module.exports.writeMoods = writeMoods;
module.exports.moodsConfigPath = moodsConfigPath;
