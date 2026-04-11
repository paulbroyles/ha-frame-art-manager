'use strict';

/**
 * fontManager.js — Font loading, text measurement, and word-wrapping for the OEL layout engine.
 *
 * Uses opentype.js (pure JS, no native deps) to parse TTF files and measure text width.
 * Manages a cache of loaded Font objects keyed by filename.
 *
 * Font files are bundled in oel/fonts/ for measurement. On first call to
 * ensureFontsInstalled(), they are also copied to /config/www/fonts/ so OEL
 * can find them by filename when rendering drawcustom payloads.
 */

const path = require('path');
const fs   = require('fs').promises;
const os   = require('os');

// Lazy-load opentype.js only when needed.
let opentype = null;
function getOpentype() {
  if (!opentype) opentype = require('opentype.js');
  return opentype;
}

const FONTS_DIR = path.join(__dirname, 'fonts');
const OEL_FONT_DIR = '/config/www/fonts';

// Cache: filename → opentype.Font
const fontCache = new Map();

// Whether we have already attempted to install fonts to OEL's font dir.
let fontsInstalled = false;

/**
 * Load and cache a font by filename.
 * @param {string} filename  e.g. 'PlayfairDisplay-Bold.ttf'
 * @returns {import('opentype.js').Font}
 */
async function loadFont(filename) {
  if (fontCache.has(filename)) return fontCache.get(filename);

  const filePath = path.join(FONTS_DIR, filename);
  const ot = getOpentype();
  const font = await ot.load(filePath);
  fontCache.set(filename, font);
  return font;
}

/**
 * Measure the advance width (in pixels) of a string at a given font size.
 * @param {string} filename   Font filename (must exist in oel/fonts/)
 * @param {string} text       Text to measure
 * @param {number} fontSize   Size in pixels
 * @returns {Promise<number>} Width in pixels
 */
async function measureText(filename, text, fontSize) {
  if (!text) return 0;
  const font = await loadFont(filename);
  return font.getAdvanceWidth(text, fontSize);
}

/**
 * Word-wrap text to fit within maxWidth pixels.
 * Returns an array of line strings.
 *
 * @param {string} filename   Font filename
 * @param {string} text       Text to wrap
 * @param {number} fontSize   Font size in pixels
 * @param {number} maxWidth   Maximum line width in pixels
 * @returns {Promise<string[]>} Array of wrapped lines
 */
async function wrapText(filename, text, fontSize, maxWidth) {
  if (!text) return [];
  const font = await loadFont(filename);
  const words = text.split(' ').filter(w => w.length > 0);
  const lines = [];
  let current = '';

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    const width = font.getAdvanceWidth(candidate, fontSize);
    if (width <= maxWidth) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      // If a single word is wider than maxWidth, push it anyway.
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * Return the line height in pixels for a given font at a given size.
 * Uses the font's ascender + descender metrics scaled to fontSize.
 *
 * @param {string} filename
 * @param {number} fontSize
 * @returns {Promise<number>}
 */
async function getLineHeight(filename, fontSize) {
  const font = await loadFont(filename);
  const scale = fontSize / font.unitsPerEm;
  const ascender  = font.tables.os2 ? font.tables.os2.sTypoAscender  : font.ascender;
  const descender = font.tables.os2 ? font.tables.os2.sTypoDescender : font.descender;
  return Math.ceil((ascender - descender) * scale);
}

/**
 * Pre-load all fonts that exist in the bundled fonts dir.
 * Call this at startup so first-request latency is lower.
 */
async function preloadFonts() {
  try {
    const files = await fs.readdir(FONTS_DIR);
    await Promise.all(
      files.filter(f => f.endsWith('.ttf') || f.endsWith('.otf')).map(f => loadFont(f).catch(() => {}))
    );
  } catch {
    // Non-fatal — fonts load lazily anyway.
  }
}

/**
 * Copy bundled fonts to /config/www/fonts/ if they are not already there.
 * OEL's drawcustom searches that directory for custom fonts.
 *
 * Call once per server lifetime. Safe to call multiple times (no-op after first success).
 */
async function ensureFontsInstalled() {
  if (fontsInstalled) return;

  try {
    await fs.mkdir(OEL_FONT_DIR, { recursive: true });
    const files = await fs.readdir(FONTS_DIR);
    const ttfFiles = files.filter(f => f.endsWith('.ttf') || f.endsWith('.otf'));

    let copied = 0;
    for (const file of ttfFiles) {
      const dest = path.join(OEL_FONT_DIR, file);
      try {
        await fs.access(dest);
        // File already exists — skip.
      } catch {
        await fs.copyFile(path.join(FONTS_DIR, file), dest);
        copied++;
      }
    }

    if (copied > 0) {
      console.log(`[fontManager] Installed ${copied} font(s) to ${OEL_FONT_DIR}`);
    }
    fontsInstalled = true;
  } catch (err) {
    // Non-fatal: OEL may not be present or /config/www may not exist.
    console.warn(`[fontManager] Could not install fonts to ${OEL_FONT_DIR}: ${err.message}`);
    fontsInstalled = true; // Don't retry on every request.
  }
}

module.exports = { loadFont, measureText, wrapText, getLineHeight, preloadFonts, ensureFontsInstalled, FONTS_DIR };
