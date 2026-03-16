'use strict';

/**
 * layoutEngine.js — Template-driven layout engine for OEL drawcustom payloads.
 *
 * Takes a template (JSON), artwork metadata, display dimensions, and refresh type,
 * and returns a fully-positioned OEL drawcustom `payload` array.
 *
 * Templates define ordered "slots" in three zones:
 *   - "top"    — packed top-to-bottom, skipped if field is empty
 *   - "anchor" — fixed position (QR code bottom-right), reserves space
 *   - "fill"   — expands to fill remaining space (description beside QR)
 */

const { measureText, wrapText, getLineHeight } = require('./fontManager');
const QRCode = require('qrcode');

/**
 * Resolve a font reference (template key → actual filename).
 * @param {string|undefined} fontRef   Slot's font key (e.g. 'heading') or direct filename
 * @param {object} templateFonts       Template's fonts map (e.g. {heading: {file: '...'}})
 * @returns {string}                   Filename to use for measurement and in OEL payload
 */
function resolveFont(fontRef, templateFonts) {
  if (!fontRef) return 'Poppins-Bold.ttf';
  if (templateFonts && templateFonts[fontRef]) {
    return templateFonts[fontRef].file || templateFonts[fontRef].fallback || fontRef;
  }
  // Assume it's already a direct filename.
  return fontRef;
}

/**
 * Apply text transforms defined by the slot (upper, wrap, prepend, append).
 * @param {string} value
 * @param {object} slot
 * @returns {string}
 */
function applyTransforms(value, slot) {
  let text = value;
  if (slot.transform === 'upper') text = text.toUpperCase();
  if (slot.transform === 'lower') text = text.toLowerCase();
  if (slot.wrap) {
    text = slot.wrap.replace('{value}', text);
  } else {
    if (slot.prepend) text = slot.prepend + text;
    if (slot.append)  text = text + slot.append;
  }
  return text;
}

/**
 * Resolve a slot's color, which may be a string or an object keyed by refreshType.
 * @param {string|object|undefined} colorDef
 * @param {string} refreshType  e.g. 'Full', 'Fast'
 * @returns {string}
 */
function resolveColor(colorDef, refreshType) {
  if (!colorDef) return 'black';
  if (typeof colorDef === 'string') return colorDef;
  // Object keyed by refresh type with optional 'default'.
  return colorDef[refreshType] || colorDef['default'] || 'black';
}

/**
 * Check whether a slot should be rendered given current metadata.
 * @param {object} slot
 * @param {object} metadata
 * @returns {boolean}
 */
function isSlotActive(slot, metadata) {
  const value = slot.field ? (metadata[slot.field] || '') : '';
  if (slot.field && !value.trim()) return false;
  if (slot.requires) {
    const dep = metadata[slot.requires] || '';
    if (!dep.trim()) return false;
  }
  return true;
}

/**
 * Main layout function.
 *
 * @param {object} template     Parsed template JSON
 * @param {object} metadata     Artwork metadata (title, creator_name, etc.)
 * @param {{width: number, height: number}} display
 * @param {string} refreshType  'Full' | 'Fast' | 'Partial' | 'Partial2'
 * @returns {Promise<{payload: object[], debug: object}>}
 */
async function layoutPlacard(template, metadata, display, refreshType) {
  const margin = template.margin || 10;
  const contentWidth = display.width - margin * 2;
  const payload = [];
  const debug = {
    template: template.id || template.name,
    slotsRendered: 0,
    slotsSkipped: 0,
    overflow: false,
  };

  // ── 0. Optional display border (thin outline around entire display) ──────
  if (template.displayBorder) {
    payload.push({
      type: 'rectangle',
      x_start: 0,
      y_start: 0,
      x_end:   display.width  - 1,
      y_end:   display.height - 1,
      outline: 'black',
      width:   1,
    });
  }

  // ── 1. Separate slots by zone ────────────────────────────────────────────
  const topSlots    = template.slots.filter(s => (s.zone || 'top') === 'top');
  const anchorSlots = template.slots.filter(s => s.zone === 'anchor');
  const fillSlots   = template.slots.filter(s => s.zone === 'fill');

  // ── 2. Resolve anchor elements (QR code) ────────────────────────────────
  const anchors = [];
  for (const slot of anchorSlots) {
    if (!isSlotActive(slot, metadata)) {
      debug.slotsSkipped++;
      continue;
    }
    const value = metadata[slot.field] || '';
    if (slot.oel_type === 'qrcode' || slot.type === 'qrcode') {
      const qrMargin  = slot.margin || 15;
      const sizePerc  = slot.sizePercent || 0.225;
      const targetSize = Math.floor(display.width * sizePerc);

      // Calculate boxsize using exact module count for this URL.
      // Total pixels = (modules + 2*border) * boxsize
      const border  = slot.border != null ? slot.border : 1;
      let modules = 33; // fallback estimate
      try {
        const qrObj = QRCode.create(value, { errorCorrectionLevel: 'M' });
        modules = qrObj.modules.size;
      } catch (_) { /* use fallback */ }
      const boxsize = Math.max(1, Math.floor(targetSize / (modules + 2 * border)));
      const actualSize = (modules + 2 * border) * boxsize;

      const x = display.width  - actualSize - qrMargin;
      const y = display.height - actualSize - qrMargin;

      anchors.push({ slot, x, y, width: actualSize, height: actualSize });
      // Draw a thin border outline around the QR code.
      const borderGap = 2;
      payload.push({
        type: 'rectangle',
        x_start: x - borderGap,
        y_start: y - borderGap,
        x_end:   x + actualSize + borderGap,
        y_end:   y + actualSize + borderGap,
        outline: resolveColor(slot.color, refreshType),
        fill:    null,
        width:   1,
      });
      payload.push({
        type: 'qrcode',
        data: value,
        x, y,
        boxsize,
        border,
        color: resolveColor(slot.color, refreshType),
        bgcolor: slot.bgcolor || 'white',
      });
      debug.slotsRendered++;
    }
  }

  // ── 3. Pack top zone (top-to-bottom) ────────────────────────────────────
  let cursorY = 0;
  for (const slot of topSlots) {
    if (!isSlotActive(slot, metadata)) {
      debug.slotsSkipped++;
      continue;
    }

    const rawValue  = metadata[slot.field] || '';
    const text      = applyTransforms(rawValue, slot);
    const fontSize  = slot.fontSize || 20;
    const fontFile  = resolveFont(slot.font, template.fonts);
    const color     = resolveColor(slot.color, refreshType);
    const slotContentWidth = slot.maxWidth || contentWidth;

    cursorY += slot.marginTop || 0;

    // Measure text to determine if wrapping is needed.
    const textWidth = await measureText(fontFile, text, fontSize);
    const lineH     = await getLineHeight(fontFile, fontSize);

    if (textWidth <= slotContentWidth) {
      // Single line.
      payload.push({
        type: 'text',
        value: text,
        x: margin,
        y: cursorY,
        size: fontSize,
        font: fontFile,
        color,
      });
      cursorY += lineH;
    } else {
      // Wrapped. Use OEL text with max_width; also word-wrap locally to count lines.
      const lines = await wrapText(fontFile, text, fontSize, slotContentWidth);
      const customLineH = slot.lineHeight || lineH;
      // OEL spacing = extra gap between lines (on top of font's natural height).
      const spacing = Math.max(0, customLineH - lineH);

      payload.push({
        type: 'text',
        value: text,
        x: margin,
        y: cursorY,
        size: fontSize,
        font: fontFile,
        color,
        max_width: slotContentWidth,
        spacing,
      });
      cursorY += lines.length * customLineH;
    }

    debug.slotsRendered++;
  }

  // ── 4. Fill zone (description beside QR) ────────────────────────────────
  for (const slot of fillSlots) {
    if (!isSlotActive(slot, metadata)) {
      debug.slotsSkipped++;
      continue;
    }

    const rawValue = metadata[slot.field] || '';
    const text     = applyTransforms(rawValue, slot);
    const fontSize = slot.fontSize || 13;
    const fontFile = resolveFont(slot.font, template.fonts);
    const color    = resolveColor(slot.color, refreshType);
    const lineH    = slot.lineHeight || (await getLineHeight(fontFile, fontSize));

    // Determine area beside the QR code (or full width if no anchors).
    const qrAnchor = anchors.find(a => a.slot.beside ? a.slot.id === slot.beside : true);
    const fillY  = qrAnchor ? qrAnchor.y : (display.height - 60);
    const fillX  = margin;
    const fillW  = qrAnchor ? qrAnchor.x - margin * 2 : contentWidth;
    const fillH  = display.height - fillY;

    // How many lines fit?
    const maxLines = Math.floor(fillH / lineH);
    if (maxLines < 1) {
      debug.slotsSkipped++;
      continue;
    }

    const wrappedLines = await wrapText(fontFile, text, fontSize, fillW);
    const fitsLines    = wrappedLines.slice(0, maxLines);
    let   displayText  = fitsLines.join(' ');

    // If we truncated, add ellipsis to the last kept line.
    if (fitsLines.length < wrappedLines.length) {
      // Re-join trimmed text and truncate more precisely.
      displayText = fitsLines.slice(0, -1).concat(
        fitsLines[fitsLines.length - 1].replace(/\s*\S+$/, '…')
      ).join(' ');
    }

    const spacing = Math.max(0, lineH - (await getLineHeight(fontFile, fontSize)));

    payload.push({
      type: 'text',
      value: displayText,
      x: fillX,
      y: fillY,
      size: fontSize,
      font: fontFile,
      color,
      max_width: fillW,
      spacing,
    });
    debug.slotsRendered++;

    // Overflow check: did top content push past fill area start?
    if (cursorY > fillY) {
      debug.overflow = true;
    }
  }

  return { payload, debug };
}

module.exports = { layoutPlacard };
