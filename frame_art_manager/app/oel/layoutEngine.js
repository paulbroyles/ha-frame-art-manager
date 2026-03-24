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
      let modules = 53; // fallback estimate (H correction, ~80-char URL)
      try {
        // Use ERROR_CORRECT_H to match OEL's qrcode rendering level.
        const qrObj = QRCode.create(value, { errorCorrectionLevel: 'H' });
        modules = qrObj.modules.size;
      } catch (_) { /* use fallback */ }
      // Round (not floor) so we don't undercount by one boxsize step.
      const boxsize = Math.max(1, Math.round(targetSize / (modules + 2 * border)));
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

  // ── 3. Pack top zone (top-to-bottom, wrapping around anchor) ────────────
  //
  // Text flows in two regions:
  //   Full-width region:  y ∈ [0, qrFloor),  x-width = contentWidth
  //   Narrow region:      y ∈ [qrFloor, ∞),  x-width = qrLeft - margin*2
  //
  // Slots that overflow the full-width region wrap continuously into the
  // narrow region (to the left of the QR code) rather than being cut off.
  // Slots that are narrower than qrLeft are never affected.

  const qrFloor     = anchors.length > 0 ? anchors.reduce((min, a) => Math.min(min, a.y), Infinity) : Infinity;
  const qrLeft      = anchors.length > 0 ? anchors.reduce((min, a) => Math.min(min, a.x), Infinity) : Infinity;
  const narrowWidth = isFinite(qrLeft) ? Math.max(0, qrLeft - margin * 2) : 0;

  // Emit a text segment into the payload. Uses max_width only for multi-line text.
  function emitTextSegment(segLines, renderWidth, startY, fontSize, fontFile, color, spacing) {
    if (segLines.length === 0) return;
    const value = segLines.join(' ');
    const entry = { type: 'text', value, x: margin, y: startY, size: fontSize, font: fontFile, color };
    if (segLines.length > 1) { entry.max_width = renderWidth; entry.spacing = spacing; }
    payload.push(entry);
  }

  let cursorY = 0;
  for (const slot of topSlots) {
    if (!isSlotActive(slot, metadata)) {
      debug.slotsSkipped++;
      continue;
    }

    const rawValue         = metadata[slot.field] || '';
    const text             = applyTransforms(rawValue, slot);
    const fontFile         = resolveFont(slot.font, template.fonts);
    const color            = resolveColor(slot.color, refreshType);
    const slotContentWidth = slot.maxWidth || contentWidth;
    const maxLines         = slot.maxLines || Infinity;

    cursorY += slot.marginTop || 0;

    // Whether this slot can reach the QR column.
    const overlapsQrColumn = (margin + slotContentWidth) > qrLeft && isFinite(qrFloor) && narrowWidth > 0;

    // Effective width for this slot at the current cursor position.
    const effectiveWidth = (overlapsQrColumn && cursorY >= qrFloor)
      ? Math.min(slotContentWidth, narrowWidth)
      : slotContentWidth;

    // Compute wrapped lines at the effective starting width.
    let fontSize = slot.fontSize || 20;
    let lines    = null;

    if (isFinite(maxLines)) {
      const minFontSize = slot.minFontSize || Math.max(10, Math.floor(fontSize * 0.55));
      for (let fs = fontSize; fs >= minFontSize; fs -= 2) {
        const w = await measureText(fontFile, text, fs);
        if (w <= effectiveWidth) { fontSize = fs; lines = [text]; break; }
        const wrapped = await wrapText(fontFile, text, fs, effectiveWidth);
        if (wrapped.length <= maxLines) { fontSize = fs; lines = wrapped; break; }
        if (fs - 2 < minFontSize) {
          fontSize = minFontSize;
          const capped = wrapped.slice(0, maxLines);
          const lastLine = capped[capped.length - 1].replace(/\s*\S+$/, '…');
          lines = [...capped.slice(0, -1), lastLine];
          break;
        }
      }
    }

    if (lines === null) {
      const textWidth = await measureText(fontFile, text, fontSize);
      lines = textWidth <= effectiveWidth ? [text] : await wrapText(fontFile, text, fontSize, effectiveWidth);
    }

    const lineH       = await getLineHeight(fontFile, fontSize);
    const customLineH = slot.lineHeight || lineH;
    const spacing     = Math.max(0, customLineH - lineH);

    // ── Flow around anchor zone ───────────────────────────────────────────
    // If the slot overlaps the QR column and is currently in the full-width
    // region, check whether it overflows into the narrow region.
    if (overlapsQrColumn && cursorY < qrFloor) {
      const availableAbove = qrFloor - cursorY;
      const linesAbove     = Math.floor(availableAbove / customLineH);

      if (linesAbove >= lines.length) {
        // Entire slot fits above the floor — normal emit.
        emitTextSegment(lines, slotContentWidth, cursorY, fontSize, fontFile, color, spacing);
        cursorY += lines.length * customLineH;
      } else {
        // Slot straddles the floor. Render above portion at full width, then
        // re-wrap the remainder at narrow width and continue below qrFloor.
        if (linesAbove > 0) {
          emitTextSegment(lines.slice(0, linesAbove), slotContentWidth, cursorY, fontSize, fontFile, color, spacing);
          cursorY += linesAbove * customLineH;
        }
        // Reconstruct remaining text from the un-rendered lines and re-wrap narrow.
        // Continue from cursorY directly — no snap to qrFloor, since narrow content
        // sits left of the QR code and won't overlap it regardless of Y position.
        const remainingText  = lines.slice(linesAbove).join(' ');
        const narrowLines    = await wrapText(fontFile, remainingText, fontSize, narrowWidth);
        const maxNarrowLines = Math.floor((display.height - cursorY) / customLineH);
        const fittedNarrow   = narrowLines.slice(0, maxNarrowLines);
        if (fittedNarrow.length > 0) {
          emitTextSegment(fittedNarrow, narrowWidth, cursorY, fontSize, fontFile, color, spacing);
          cursorY += fittedNarrow.length * customLineH;
        }
        if (narrowLines.length > maxNarrowLines) debug.overflow = true;
      }
    } else {
      // Normal emit (either slot doesn't reach QR column, or already in narrow zone).
      emitTextSegment(lines, effectiveWidth, cursorY, fontSize, fontFile, color, spacing);
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
    const descGap = slot.marginTop || 6;   // small top gap before description
    // Start below the anchor top — but also below wherever the top zone left off
    // in the narrow column, so fill content never collides with top zone overflow.
    const fillY  = qrAnchor
      ? Math.max(qrAnchor.y + descGap, cursorY > qrFloor ? cursorY : qrAnchor.y + descGap)
      : (display.height - 60);
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
  }

  return { payload, debug };
}

module.exports = { layoutPlacard };
