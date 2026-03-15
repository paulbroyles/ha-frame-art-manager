'use strict';

/**
 * Field value formatters for web source metadata.
 *
 * Each formatter takes a raw string value and returns a normalized string.
 * Fields declare their format type via `format: 'date'` (or other type) in
 * their source FIELD_DEFS. buildWebSourceSnapshot applies formatters during
 * mapping, so raw metadata is never modified.
 *
 * Formatting can be disabled globally via webSources.formatDates = false.
 */

/**
 * Normalize a circa/about modifier to "ca."
 * Handles: circa, about, approximately (case-insensitive)
 * Preserves: before, after, and any other modifiers
 */
function normalizeCircaModifier(str) {
  return str.replace(/\b(circa|about|approximately)\b\.?/gi, 'ca.');
}

/**
 * Extract the year from an ISO-style date string or plain year.
 * "1995-03-07" → "1995"
 * "1920"       → "1920"
 * "ca. 1920"   → "ca. 1920" (preserves modifiers, only strips MM-DD suffix)
 * "1872-2015"  → "1872-2015" (range left intact — not a month)
 *
 * The negative lookahead (?!\d) prevents matching "1872-20" inside "1872-2015"
 * (if the 2-digit group is immediately followed by another digit, it's not a
 * month — it's the start of another year).
 */
function extractYear(str) {
  // Strip -MM-DD or -MM suffix, but only when the 2-digit part is NOT followed
  // by another digit (which would indicate it's part of a year, not a month).
  return str.replace(/(\d{4})-\d{2}(?:-\d{2})?(?!\d)/g, '$1');
}

/**
 * Normalize a date range separator: collapse spaced dashes between year-like
 * tokens to a tight dash.  Only fires when digits appear on both sides of the
 * spaced dash, to avoid collapsing dashes in text like "before 1500 - after".
 * "1452 - 1519"  → "1452-1519"
 * "ca. 1800 - ca. 1900" → "ca. 1800-ca. 1900"  (modifiers preserved)
 */
function normalizeRangeSeparator(str) {
  return str.replace(/(\d)\s+-\s+(\d)/g, '$1-$2');
}

/**
 * If both ends of a dash-separated range are the same year, collapse to one.
 * "1920-1920" → "1920"
 * Does not fire on ranges with different years.
 */
function collapseIdenticalYearRange(str) {
  return str.replace(/^(\d{4})-\1$/, '$1');
}

/**
 * Normalize a date string for display.
 *
 * Rules applied in order:
 *  1. Abbreviate circa/about/approximately modifiers to "ca."
 *  2. Handle slash-separated ranges (ISO or plain year on each side)
 *  3. Strip month/day from standalone ISO dates
 *  4. Normalize spaced dashes between year tokens
 *  5. Collapse same-year ranges
 *
 * Non-date strings (no digits) pass through unchanged.
 *
 * @param {string} raw
 * @returns {string}
 */
function formatDate(raw) {
  if (typeof raw !== 'string') return String(raw);
  let s = raw.trim();

  // Pass through if no digits present — not a date-like string
  if (!/\d/.test(s)) return s;

  // 1. Abbreviate circa/about/approximately
  s = normalizeCircaModifier(s);

  // 2. Handle slash-separated ranges (e.g. "1872/2015" or "1872-03-07/2015-11-22")
  if (s.includes('/')) {
    const parts = s.split('/');
    if (parts.length === 2) {
      const left = extractYear(parts[0].trim());
      const right = extractYear(parts[1].trim());
      s = `${left}-${right}`;
    }
  }

  // 3. Strip month/day from standalone ISO dates (no slash present at this point)
  s = extractYear(s);

  // 4. Normalize spaced dashes between year tokens
  s = normalizeRangeSeparator(s);

  // 5. Collapse identical year ranges
  s = collapseIdenticalYearRange(s);

  return s;
}

/**
 * Registry of formatters keyed by format type string.
 * Add new format types here as needed.
 */
const FORMATTERS = {
  date: formatDate,
};

/**
 * Apply a formatter to a value, given the format type declared for the field.
 * Returns String(value) unchanged if no formatter is registered for the type.
 *
 * @param {*} value
 * @param {string|undefined} formatType
 * @returns {string}
 */
function applyFieldFormat(value, formatType) {
  const formatter = formatType && FORMATTERS[formatType];
  if (formatter) return formatter(String(value));
  return String(value);
}

module.exports = { formatDate, applyFieldFormat, FORMATTERS };
