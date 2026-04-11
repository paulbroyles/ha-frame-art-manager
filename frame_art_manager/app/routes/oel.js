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
 *
 * GET /api/oel/calibrate
 *   TEMPORARY — compares opentype.js vs PIL text measurements.
 *   Remove once MEASURE_SLACK in layoutEngine.js is confirmed correct.
 */

const express        = require('express');
const path           = require('path');
const fs             = require('fs').promises;
const { execFile }   = require('child_process');
const router         = express.Router();

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

/**
 * GET /api/oel/calibrate
 *
 * TEMPORARY calibration endpoint. Runs calibrate_measurements.py inside the
 * container (PIL measurements), then compares against opentype.js measurements
 * for the same test cases. Returns per-case ratio and offset data.
 *
 * Remove this route once MEASURE_SLACK in layoutEngine.js is confirmed.
 */
router.get('/calibrate', async (req, res) => {
  const { measureText } = require('../oel/fontManager');
  const scriptPath = path.join(__dirname, '..', 'oel', 'calibrate_measurements.py');

  // Run the Python script and parse its JSON output.
  let pilResults;
  try {
    pilResults = await new Promise((resolve, reject) => {
      execFile('python3', [scriptPath], { timeout: 15000 }, (err, stdout, stderr) => {
        if (err) return reject(new Error(`python3 failed: ${err.message}\n${stderr}`));
        try { resolve(JSON.parse(stdout)); }
        catch (e) { reject(new Error(`Failed to parse Python output: ${stdout}`)); }
      });
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  // Measure the same cases with opentype.js and compare against draw.textlength()
  // (which is what OEL actually uses for word-wrap decisions).
  const mean = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
  const max  = arr => Math.max(...arr);
  const min  = arr => Math.min(...arr);

  const comparison = [];
  for (const tc of pilResults) {
    if (tc.error) { comparison.push(tc); continue; }
    const otWidth   = await measureText(tc.font, tc.text, tc.size);
    const oelWidth  = tc.draw_textlength;  // OEL's actual measurement
    const diff      = otWidth - oelWidth;
    const ratio     = oelWidth > 0 ? otWidth / oelWidth : null;
    comparison.push({
      font:              tc.font,
      text:              tc.text,
      size:              tc.size,
      ot_width:          Math.round(otWidth  * 100) / 100,
      oel_width:         oelWidth,
      font_getlength:    tc.font_getlength,
      diff_ot_vs_oel:    Math.round(diff  * 100) / 100,
      ratio_ot_vs_oel:   ratio !== null ? Math.round(ratio * 10000) / 10000 : null,
    });
  }

  const diffs  = comparison.filter(c => c.diff_ot_vs_oel  != null).map(c => c.diff_ot_vs_oel);
  const ratios = comparison.filter(c => c.ratio_ot_vs_oel != null).map(c => c.ratio_ot_vs_oel);

  return res.json({
    summary: {
      mean_diff:  Math.round(mean(diffs)  * 100) / 100,
      max_diff:   Math.round(max(diffs)   * 100) / 100,
      min_diff:   Math.round(min(diffs)   * 100) / 100,
      mean_ratio: Math.round(mean(ratios) * 10000) / 10000,
      max_ratio:  Math.round(max(ratios)  * 10000) / 10000,
      min_ratio:  Math.round(min(ratios)  * 10000) / 10000,
      note: 'diff = opentype.js minus PIL draw.textlength (OEL actual); positive = ot wider',
    },
    cases: comparison,
  });
});

module.exports = router;
