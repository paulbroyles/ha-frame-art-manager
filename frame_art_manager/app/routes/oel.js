'use strict';

/**
 * routes/oel.js — OEL placard layout endpoint.
 *
 * POST /api/oel
 *   Body: { metadata, display, refresh_type, template }
 *   Returns: { payload, debug }
 *
 * GET /api/oel/templates
 *   Returns list of available template IDs and names.
 *
 * GET /api/oel/templates/:id
 *   Returns the full template definition.
 */

const express  = require('express');
const path     = require('path');
const fs       = require('fs').promises;
const router   = express.Router();

const { layoutPlacard }        = require('../oel/layoutEngine');
const { ensureFontsInstalled } = require('../oel/fontManager');

const TEMPLATES_DIR = path.join(__dirname, '..', 'oel', 'templates');

// Template cache.
const templateCache = new Map();

async function loadTemplate(id) {
  if (templateCache.has(id)) return templateCache.get(id);
  const filePath = path.join(TEMPLATES_DIR, `${id}.json`);
  const raw = await fs.readFile(filePath, 'utf8');
  const tpl = JSON.parse(raw);
  templateCache.set(id, tpl);
  return tpl;
}

async function listTemplates() {
  const files = await fs.readdir(TEMPLATES_DIR);
  const templates = [];
  for (const file of files.filter(f => f.endsWith('.json'))) {
    const id = path.basename(file, '.json');
    try {
      const tpl = await loadTemplate(id);
      templates.push({ id: tpl.id || id, name: tpl.name || id, description: tpl.description || '' });
    } catch {
      // Skip malformed templates.
    }
  }
  return templates;
}

/**
 * POST /api/oel
 *
 * Generate an OEL drawcustom payload from artwork metadata.
 *
 * Body:
 *   metadata    {object}  Artwork fields: creator_name, creator_nationality,
 *                         creator_lifespan, title, date, medium, dimensions,
 *                         museum, description, artwork_url
 *   display     {object}  { width: number, height: number } — defaults to 400×300
 *   refresh_type {string} 'Full'|'Fast'|'Partial'|'Partial2' — defaults to 'Full'
 *   template    {string}  Template ID — defaults to 'museum_placard'
 *
 * Response: { payload: [...], debug: {...} }
 */
router.post('/', async (req, res) => {
  try {
    await ensureFontsInstalled();

    const {
      metadata    = {},
      display     = {},
      refresh_type = 'Full',
      template    : templateId = 'museum_placard',
    } = req.body;

    const displayDims = {
      width:  display.width  || 400,
      height: display.height || 300,
    };

    let template;
    try {
      template = await loadTemplate(templateId);
    } catch {
      return res.status(400).json({ error: `Template '${templateId}' not found` });
    }

    const { payload, debug } = await layoutPlacard(template, metadata, displayDims, refresh_type);

    return res.json({ payload, debug });
  } catch (err) {
    console.error('[oel] Layout error:', err);
    return res.status(500).json({ error: 'Layout generation failed', detail: err.message });
  }
});

/**
 * GET /api/oel/templates
 * List available templates.
 */
router.get('/templates', async (req, res) => {
  try {
    const templates = await listTemplates();
    return res.json({ templates });
  } catch (err) {
    console.error('[oel] List templates error:', err);
    return res.status(500).json({ error: 'Failed to list templates' });
  }
});

/**
 * GET /api/oel/templates/:id
 * Return a specific template definition.
 */
router.get('/templates/:id', async (req, res) => {
  try {
    const template = await loadTemplate(req.params.id);
    return res.json(template);
  } catch {
    return res.status(404).json({ error: `Template '${req.params.id}' not found` });
  }
});

module.exports = router;
