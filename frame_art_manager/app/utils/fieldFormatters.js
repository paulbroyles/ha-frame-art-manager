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

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Verbose date handling (month names present, e.g. "08 April 1867")
// ---------------------------------------------------------------------------

// Matches any month name (full or 3-letter abbreviation).
const MONTH_RE = /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i;

/**
 * Expand a 2-digit year to 4 digits.
 *
 * When a contextYear (4-digit integer from the other side of a range) is
 * provided, picks the century that keeps the result >= contextYear — e.g.
 * for a lifespan "1867 - 43", context 1867 → century 1800 → 1843 < 1867,
 * so try 1943 ✓.
 *
 * Without context, uses a cutoff: years > 30 → 1900s, years ≤ 30 → 2000s.
 * (Heuristic only; ambiguous without a reference year.)
 */
function expandTwoDigitYear(yy, contextYear) {
  if (contextYear) {
    const century = Math.floor(contextYear / 100) * 100;
    const sameCentury = century + yy;
    return sameCentury >= contextYear ? sameCentury : century + 100 + yy;
  }
  return yy > 30 ? 1900 + yy : 2000 + yy;
}

/**
 * Extract a year from a single verbose date component containing a month name
 * (e.g. "08 April 1867", "2-Sep-43", "ca. March 1920").
 *
 * Preserves any leading qualifier (ca., before, after).
 * Returns null if no month name is present (caller should treat token as plain text).
 *
 * @param {string} token
 * @param {number|null} contextYear  4-digit year from the other range part (for 2-digit expansion)
 * @returns {string|null}
 */
function extractYearFromVerboseDateComponent(token, contextYear) {
  if (!MONTH_RE.test(token)) return null;

  // Preserve leading qualifiers (ca., before, after)
  const qualMatch = token.match(/^((?:ca\.|before|after)\s+)/i);
  const qualifier = qualMatch ? qualMatch[1] : '';

  // 4-digit year is unambiguous
  const fourDigit = token.match(/\b(\d{4})\b/);
  if (fourDigit) return qualifier + fourDigit[1];

  // 2-digit year: any number > 31 cannot be a day, so it must be the year.
  const yearCandidate = [...token.matchAll(/\b(\d{1,2})\b/g)]
    .map(m => parseInt(m[1], 10))
    .find(n => n > 31);
  if (yearCandidate !== undefined) {
    return qualifier + String(expandTwoDigitYear(yearCandidate, contextYear));
  }

  return null; // Could not extract year
}

/**
 * Normalize a string that contains verbose date components (with month names).
 * Handles single dates and ranges separated by " - " or "/".
 *
 * The spaced dash (" - ") is tried as a range separator before "/" because
 * "-" appears within compact date components like "2-Sep-43".
 *
 * For each range part: if a month name is present, extracts the year
 * (expanding 2-digit years using the left side as context); otherwise falls
 * back to extractYear() for ISO-style dates.
 */
function normalizeVerboseDate(s) {
  let parts = null;

  // Split on spaced dash first (most reliable separator for verbose dates)
  const spacedDash = s.split(/\s+-\s+/);
  if (spacedDash.length === 2) {
    parts = spacedDash;
  } else if (s.includes('/')) {
    const slashParts = s.split('/');
    if (slashParts.length === 2) parts = slashParts;
  }

  if (parts) {
    const [leftRaw, rightRaw] = parts.map(p => p.trim());

    // Context year for 2-digit expansion: use the 4-digit year from the left part
    const leftFourDigit = leftRaw.match(/\b(\d{4})\b/);
    const contextYear = leftFourDigit ? parseInt(leftFourDigit[1], 10) : null;

    const left  = extractYearFromVerboseDateComponent(leftRaw,  null)        ?? extractYear(leftRaw);
    const right = extractYearFromVerboseDateComponent(rightRaw, contextYear) ?? extractYear(rightRaw);
    return `${left}-${right}`;
  }

  // Single verbose date (not a range)
  return extractYearFromVerboseDateComponent(s, null) ?? s;
}

// ---------------------------------------------------------------------------
// Century normalization
// ---------------------------------------------------------------------------

/**
 * Convert a Roman numeral string (e.g. "XIX") to an integer.
 * Returns 0 for invalid input.
 */
function romanToInt(roman) {
  const vals = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
  let result = 0;
  const upper = roman.toUpperCase();
  for (let i = 0; i < upper.length; i++) {
    const curr = vals[upper[i]];
    if (!curr) return 0; // Invalid character
    const next = vals[upper[i + 1]] || 0;
    result += curr < next ? -curr : curr;
  }
  return result;
}

/**
 * Return the ordinal suffix string for an integer (e.g. 19 → "19th", 21 → "21st").
 */
function ordinalSuffix(n) {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  const s = ['th', 'st', 'nd', 'rd'];
  return n + (s[n % 10] || 'th');
}

/**
 * Normalize century references to the form "Nth c." or "Nth-Mth c."
 *
 * Handles:
 *  Roman numerals:   "XX Century" → "20th c."
 *                    "XIX/XX century" → "19th-20th c."
 *  Arabic ordinals:  "20th century" → "20th c."
 *                    "19th/20th century" → "19th-20th c."
 *  Qualifiers preserved: "early 20th century" → "early 20th c."
 *                        "late XIX century" → "late 19th c."
 */
function normalizeCentury(s) {
  // Roman numeral pairs: "XIX/XX century" or "XIX-XX century"
  s = s.replace(
    /\b([IVXivx]+)\s*[\/\-]\s*([IVXivx]+)\s+[Cc]entur(?:y|ies)\b/g,
    (match, r1, r2) => {
      const n1 = romanToInt(r1);
      const n2 = romanToInt(r2);
      return (n1 && n2) ? `${ordinalSuffix(n1)}-${ordinalSuffix(n2)} c.` : match;
    }
  );

  // Single Roman numeral century: "XX Century"
  s = s.replace(
    /\b([IVXivx]+)\s+[Cc]entur(?:y|ies)\b/g,
    (match, roman) => {
      const n = romanToInt(roman);
      return n ? `${ordinalSuffix(n)} c.` : match;
    }
  );

  // Arabic ordinal pairs: "19th/20th century"
  s = s.replace(
    /\b(\d+(?:st|nd|rd|th))\s*\/\s*(\d+(?:st|nd|rd|th))\s+[Cc]entur(?:y|ies)\b/g,
    (_match, o1, o2) => `${o1}-${o2} c.`
  );

  // Single Arabic ordinal century: "20th century"
  s = s.replace(
    /\b(\d+(?:st|nd|rd|th))\s+[Cc]entur(?:y|ies)\b/g,
    (_match, ord) => `${ord} c.`
  );

  return s;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Normalize a date string for display.
 *
 * Rules applied in order:
 *  1. Abbreviate circa/about/approximately modifiers to "ca."
 *  2. Normalize century references ("XX Century" → "20th c.", etc.)
 *  3. If month names present: extract years from verbose components, handling
 *     2-digit year expansion via context from the other range part.
 *     (Short-circuits remaining steps — output is already year-only.)
 *  4. Handle slash-separated ranges (plain years or ISO dates, no month names)
 *  5. Strip month/day from standalone ISO dates
 *  6. Normalize spaced dashes between year tokens
 *  7. Collapse same-year ranges
 *
 * Non-date strings (no digits) pass through unchanged.
 *
 * @param {string} raw
 * @returns {string}
 */
function formatDate(raw) {
  if (typeof raw !== 'string') return String(raw);
  let s = raw.trim();

  // 1. Abbreviate circa/about/approximately
  s = normalizeCircaModifier(s);

  // 2. Normalize century references — must run before the digit check since
  //    Roman numeral centuries (e.g. "XX Century") contain no digits.
  if (/centur/i.test(s)) {
    s = normalizeCentury(s);
    // After normalization the result contains digits (e.g. "20th c."), so the
    // remaining steps are no-ops; let them run for safety.
  }

  // Pass through if no digits present — not a date-like string
  if (!/\d/.test(s)) return s;

  // 3. Verbose date components (month names present)
  if (MONTH_RE.test(s)) {
    s = normalizeVerboseDate(s);
    // Output is year-only; just check for same-year range collapse.
    return collapseIdenticalYearRange(s);
  }

  // 4. Handle slash-separated ranges (e.g. "1872/2015" or "1872-03-07/2015-11-22")
  if (s.includes('/')) {
    const parts = s.split('/');
    if (parts.length === 2) {
      const left  = extractYear(parts[0].trim());
      const right = extractYear(parts[1].trim());
      s = `${left}-${right}`;
    }
  }

  // 5. Strip month/day from standalone ISO dates (no slash present at this point)
  s = extractYear(s);

  // 6. Normalize spaced dashes between year tokens
  s = normalizeRangeSeparator(s);

  // 7. Collapse identical year ranges
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
