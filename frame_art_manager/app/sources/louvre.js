'use strict';

const axios = require('axios');
const sharp = require('sharp');

// Louvre collections website — https://collections.louvre.fr
//
// The Louvre does not provide a JSON search API. Individual records are accessible as JSON
// by ARK identifier: https://collections.louvre.fr/ark:/53355/{arkId}.json
//
// Selection strategy: pick a random page from the search results HTML (1–maxPages), extract
// ARK IDs from the markup, then fetch the JSON record for one of those ARKs.
//
// When department filters are active, the search URL includes collection[] query parameters
// that pre-filter results server-side. The page count for a filtered search is probed once
// (from page 1) and cached in-memory for the process lifetime. This avoids the ~2% hit rate
// that would result from picking random pages out of 25,078 when only ~536 match Paintings.
//
// Total unfiltered collection: ~478,000 objects across 25,078 pages of 20 results each.

const BASE_URL   = 'https://collections.louvre.fr';
const MAX_PAGES  = 25078; // Observed maximum page (unfiltered)

const HEADERS = { 'User-Agent': 'frame-art-manager/1.0 (home automation art display)' };

// Departments: user-visible label → { code: URL collection[] value, substrings: [...] }
// `code` is used for pre-filtering via the search URL.
// `substrings` are fallback substrings in the `collection` field for post-JSON-fetch validation
// (guards against the URL filter returning unexpected items due to Louvre site changes).
const DEPARTMENTS = {
  Paintings:                   { code: 'peintures',                                 substrings: ['peintures'] },
  'Drawings & Prints':         { code: 'arts-graphiques',                           substrings: ['arts graphiques'] },
  Sculptures:                  { code: 'sculptures',                                substrings: ['sculptures'] },
  'Decorative Arts':           { code: 'objets-art',                                substrings: ["objets d'art"] },
  'Egyptian Antiquities':      { code: 'antiquites-egyptiennes',                    substrings: ['antiquités égyptiennes'] },
  'Greek & Roman Antiquities': { code: 'antiquites-grecques-etrusques-et-romaines', substrings: ['antiquités grecques', 'antiquités romaines', 'antiquités étrusques'] },
  'Near Eastern Antiquities':  { code: 'antiquites-orientales',                     substrings: ['antiquités orientales'] },
  'Islamic Art':               { code: 'arts-de-l-islam',                           substrings: ["arts de l'islam"] },
  'Byzantine Art':             { code: 'arts-de-byzance',                           substrings: ['byzance'] },
};

const DEPARTMENT_TYPES = Object.keys(DEPARTMENTS);

// User-visible department groups for the UI filter builder.
const DEPARTMENT_CATEGORIES = [
  { name: 'Fine Art',    media: ['Paintings', 'Drawings & Prints', 'Sculptures', 'Decorative Arts'] },
  { name: 'Antiquities', media: ['Egyptian Antiquities', 'Greek & Roman Antiquities', 'Near Eastern Antiquities', 'Islamic Art', 'Byzantine Art'] },
];

// In-memory cache: sorted collection-code key → { maxPages, fetchedAt }.
// TTL of 24h so the count refreshes daily as the Louvre adds new items,
// without needing a probe fetch on every shuffle.
const _pageCountCache = new Map();
const PAGE_COUNT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Extract ARK IDs (format: cl\d{9}) from a Louvre search results HTML page.
 */
function extractArkIds(html) {
  const seen = new Set();
  const ids = [];
  for (const m of html.matchAll(/\/ark:\/53355\/(cl\d{9})/g)) {
    if (!seen.has(m[1])) { seen.add(m[1]); ids.push(m[1]); }
  }
  return ids;
}

/**
 * Parse the total page count from Louvre search results HTML.
 * The pagination element contains text like "1 / 536" or "1 / 25 078" (French spacing).
 * Returns null if parsing fails (caller falls back to MAX_PAGES).
 */
function parseMaxPages(html) {
  // Look for "N / M" or "N / M M" patterns near pagination context.
  // French locale uses non-breaking spaces in large numbers (e.g. "25 078").
  const m = html.match(/\d+\s*\/\s*([\d\s\u00a0]{1,10})/);
  if (!m) return null;
  const n = parseInt(m[1].replace(/[\s\u00a0]/g, ''), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Fetch a Louvre search results page.
 * collectionCodes: array of collection[] values (e.g. ['peintures']) for pre-filtering,
 *   or null/[] for no department filter.
 * Returns { arkIds, html }.
 */
async function fetchSearchPage(page, collectionCodes) {
  // Build the query string manually to keep literal brackets in `collection[]`.
  // URLSearchParams would percent-encode them as `collection%5B%5D`, which the
  // Louvre server doesn't recognise as the department filter parameter.
  let qs = `q=&page=${encodeURIComponent(page)}`;
  if (collectionCodes && collectionCodes.length > 0) {
    for (const code of collectionCodes) qs += `&collection[]=${encodeURIComponent(code)}`;
  }
  const response = await axios.get(`${BASE_URL}/en/recherche?${qs}`, {
    timeout: 15000,
    headers: HEADERS,
  });
  return { arkIds: extractArkIds(response.data), html: response.data };
}

/**
 * Get (and cache) the max page count for a given set of collection codes.
 * Probes page 1 to read the pagination total; falls back to MAX_PAGES on parse failure.
 */
async function getMaxPages(collectionCodes) {
  const key = (collectionCodes || []).slice().sort().join(',');
  const cached = _pageCountCache.get(key);
  if (cached && (Date.now() - cached.fetchedAt) < PAGE_COUNT_TTL_MS) return cached.maxPages;

  let maxPages = cached?.maxPages || MAX_PAGES; // keep stale value on failure
  try {
    const { html } = await fetchSearchPage(1, collectionCodes);
    maxPages = parseMaxPages(html) || maxPages;
  } catch (err) {
    console.warn(`[louvre] Could not probe page count for [${key || 'all'}]: ${err.message} — using ${maxPages}`);
  }
  _pageCountCache.set(key, { maxPages, fetchedAt: Date.now() });
  console.log(`[louvre] Page count for [${key || 'all'}]: ${maxPages}`);
  return maxPages;
}

/**
 * Fetch JSON metadata for a single ARK ID.
 * Returns null on 404 (item no longer exists); throws on other errors.
 */
async function fetchArkJson(arkId) {
  let response;
  try {
    response = await axios.get(`${BASE_URL}/ark:/53355/${arkId}.json`, {
      timeout: 15000,
      headers: HEADERS,
    });
  } catch (err) {
    if (err.response?.status === 404) return null;
    throw err;
  }
  return response.data;
}

/**
 * Build a human-readable creator string from the Louvre's creator array.
 * Each element may have a `name` field plus an optional `role` field.
 * Returns null when the array is empty or contains no names.
 */
function buildCreatorString(creatorArray) {
  if (!Array.isArray(creatorArray) || creatorArray.length === 0) return null;
  const names = creatorArray.filter(c => c.name).map(c => c.name);
  return names.length > 0 ? names.join('; ') : null;
}

/**
 * Extract a concise date string from the Louvre's date metadata.
 * Prefers the structured dateCreated array (first entry's year range or text).
 * Falls back to stripping the French label prefix from displayDateCreated.
 */
function buildDateString(record) {
  const dateArr = record.dateCreated;
  if (Array.isArray(dateArr) && dateArr.length > 0) {
    const d = dateArr[0];
    if (d.startYear && d.endYear && d.startYear !== d.endYear) {
      return `${d.startYear}–${d.endYear}`;
    }
    if (d.startYear) return String(d.startYear);
    if (d.text) return d.text;
  }
  const display = record.displayDateCreated;
  if (display) {
    // Strip French label prefix: "Date de création/fabrication : "
    return display.replace(/^[^:]+:\s*/, '').trim() || null;
  }
  return null;
}

/**
 * Returns true if a record's collection field matches any of the given substring sets.
 */
function collectionMatchesFilter(collection, substringSets) {
  if (!collection) return false;
  const lower = collection.toLowerCase();
  return substringSets.some(substrings => substrings.some(s => lower.includes(s)));
}

// ── fetchRandomArtwork ────────────────────────────────────────────────────────

/**
 * Fetch a random artwork from the Louvre collections.
 *
 * Department filtering is applied pre-fetch via the search URL's collection[] parameter.
 * require filters determine which departments are searched; exclude filters are then applied
 * as a secondary post-JSON-fetch check. The page count for a given department combination
 * is probed from page 1 once and cached for the process lifetime.
 *
 * @param {Array<{type: string, mode: 'require'|'exclude', values: string[]}>} [filters=[]]
 *   Supported type: 'department' — values are user-visible names from DEPARTMENT_TYPES.
 * @param {object} [options]
 * @param {'all'|'landscape'|'portrait'} [options.aspectRatio='all']
 * @returns {{ imageBuffer, contentType, metadata }}
 */
async function fetchRandomArtwork(filters = [], options = {}) {
  const { aspectRatio = 'all' } = options;

  // Compute eligible departments (require intersection, then exclude union).
  const requireSets = filters
    .filter(f => f.type === 'department' && f.mode === 'require')
    .map(f => new Set((f.values || []).map(v => v.toLowerCase())));
  const excludeValues = new Set(
    filters
      .filter(f => f.type === 'department' && f.mode === 'exclude')
      .flatMap(f => f.values || [])
      .map(v => v.toLowerCase())
  );

  let eligibleDepartments = DEPARTMENT_TYPES;
  if (requireSets.length > 0) {
    eligibleDepartments = eligibleDepartments.filter(d => requireSets.every(s => s.has(d.toLowerCase())));
  }
  if (excludeValues.size > 0) {
    eligibleDepartments = eligibleDepartments.filter(d => !excludeValues.has(d.toLowerCase()));
  }
  if (eligibleDepartments.length === 0) {
    throw new Error('No departments eligible after applying filters');
  }

  // Pre-filter via URL when departments are constrained.
  const filterActive = eligibleDepartments.length < DEPARTMENT_TYPES.length;
  const collectionCodes = filterActive
    ? eligibleDepartments.map(d => DEPARTMENTS[d].code)
    : null;

  // Validation substrings: if we pre-filtered, verify the JSON record's collection field
  // matches one of the expected departments (guards against stale search HTML or site changes).
  const allowedSubstringSets = filterActive
    ? eligibleDepartments.map(d => DEPARTMENTS[d].substrings)
    : null;

  // Get (possibly cached) page count for this department combination.
  const maxPages = await getMaxPages(collectionCodes);

  const MAX_ATTEMPTS = 20;
  let arkIds = [];

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    // Refresh ARK candidate list from a new random page when exhausted.
    if (arkIds.length === 0) {
      const page = Math.floor(Math.random() * maxPages) + 1;
      try {
        ({ arkIds } = await fetchSearchPage(page, collectionCodes));
      } catch (err) {
        console.warn(`[louvre] Failed to fetch search page ${page}: ${err.message}`);
        continue;
      }
      if (arkIds.length === 0) {
        console.warn(`[louvre] No ARK IDs found on page ${page}`);
        continue;
      }
    }

    // Pick and remove a random ARK from the current batch.
    const idx = Math.floor(Math.random() * arkIds.length);
    const arkId = arkIds.splice(idx, 1)[0];

    let record;
    try {
      record = await fetchArkJson(arkId);
    } catch (err) {
      console.warn(`[louvre] Failed to fetch ARK ${arkId}: ${err.message}`);
      continue;
    }
    if (!record) {
      console.warn(`[louvre] ARK ${arkId} not found (404)`);
      continue;
    }

    // Skip records without images.
    if (!Array.isArray(record.image) || record.image.length === 0) {
      console.warn(`[louvre] ARK ${arkId} has no images`);
      continue;
    }
    const imageEntry = record.image.find(img => img.urlImage) || null;
    if (!imageEntry) {
      console.warn(`[louvre] ARK ${arkId} images have no urlImage`);
      continue;
    }

    // Validate department against expected substrings (only when pre-filtering was active).
    if (allowedSubstringSets && !collectionMatchesFilter(record.collection, allowedSubstringSets)) {
      console.warn(`[louvre] ARK ${arkId} collection "${record.collection}" unexpected for filter — skipping`);
      continue;
    }

    // Download image.
    let imageBuffer, contentType;
    try {
      const imageResponse = await axios.get(imageEntry.urlImage, {
        responseType: 'arraybuffer',
        timeout: 30000,
        headers: HEADERS,
      });
      imageBuffer = Buffer.from(imageResponse.data);
      contentType = imageResponse.headers['content-type'] || 'image/jpeg';
    } catch (err) {
      console.warn(`[louvre] Failed to download image for ARK ${arkId}: ${err.message}`);
      continue;
    }

    // Check aspect ratio.
    if (aspectRatio !== 'all') {
      try {
        const { width, height } = await sharp(imageBuffer).metadata();
        const isLandscape = width > height;
        if (aspectRatio === 'landscape' && !isLandscape) {
          console.warn(`[louvre] ARK ${arkId} skipped: not landscape (${width}x${height})`);
          continue;
        }
        if (aspectRatio === 'portrait' && isLandscape) {
          console.warn(`[louvre] ARK ${arkId} skipped: not portrait (${width}x${height})`);
          continue;
        }
      } catch (err) {
        console.warn(`[louvre] Could not read dimensions for ARK ${arkId}: ${err.message}`);
        continue;
      }
    }

    return {
      imageBuffer,
      contentType,
      metadata: {
        title:       record.title || null,
        creator:     buildCreatorString(record.creator),
        medium:      record.materialsAndTechniques || null,
        dateCreated: buildDateString(record),
        collection:  record.collection || null,
        attribution: imageEntry.copyright || null,
        artworkUrl:  record.url || `${BASE_URL}/ark:/53355/${arkId}`,
        source:      'Musée du Louvre',
      },
    };
  }

  throw new Error(`Could not find a suitable${aspectRatio !== 'all' ? ` ${aspectRatio}` : ''} Louvre artwork after ${MAX_ATTEMPTS} attempts`);
}

// ── selectMode ────────────────────────────────────────────────────────────────

function selectMode(filters = []) {
  const deptFilters = filters.filter(f => f.type === 'department');
  const hasRequire  = deptFilters.some(f => f.mode === 'require');
  const hasExclude  = deptFilters.some(f => f.mode === 'exclude');
  const mode = hasRequire ? 'filtered_page' : hasExclude ? 'excluded_page' : 'random_page';
  return { mode, apiFilters: deptFilters, postFilters: [] };
}

// ── Metadata schema ───────────────────────────────────────────────────────────

const metadataFields = [
  { key: 'title',       label: 'Title',        description: 'Artwork title' },
  { key: 'creator',     label: 'Creator',      description: 'Artist or maker name(s)' },
  { key: 'medium',      label: 'Medium',       description: 'Materials and techniques (e.g. "huile sur toile")' },
  { key: 'dateCreated', label: 'Date Created', description: 'Creation date or period', format: 'date' },
  { key: 'collection',  label: 'Collection',   description: 'Louvre department name (in French)' },
  { key: 'attribution', label: 'Attribution',  description: 'Copyright attribution line from the Louvre' },
  { key: 'source',      label: 'Source',       description: 'Source collection name (always "Musée du Louvre")' },
];

const defaultMapping = {
  title:       'title',
  creator:     { entity: 'creator', attribute: 'name' },
  medium:      'medium',
  dateCreated: 'date',
  collection:  null,
  attribution: null,
  source:      'museum',
};

// ── Filter types ──────────────────────────────────────────────────────────────

function getFilterTypes() {
  return [
    {
      type:        'department',
      label:       'Department',
      description: 'Restrict or exclude artworks by Louvre department. require filters pre-filter the search results at URL level; exclude filters are applied after fetching the JSON record.',
      modes:       ['require', 'exclude'],
      multiValue:  true,
      groups:      DEPARTMENT_CATEGORIES.map(cat => ({ name: cat.name, values: cat.media })),
      values:      DEPARTMENT_TYPES.map(name => ({ value: name, label: name })),
    },
  ];
}

// ── fetchByIdentifier ─────────────────────────────────────────────────────────

/**
 * Returns true if this source can handle the given identifier.
 * Accepts Louvre ARK URLs and bare cl\d{9} identifiers.
 */
function canHandleIdentifier(identifier) {
  const t = identifier.trim();
  return /collections\.louvre\.fr\/(?:en\/)?ark:\/53355\/(cl\d{9})/i.test(t)
    || /^cl\d{9}$/i.test(t);
}

/**
 * Fetch a specific artwork by Louvre ARK URL or bare ARK ID (cl\d{9}).
 */
async function fetchByIdentifier(identifier) {
  const t = identifier.trim();
  const urlMatch = t.match(/\/ark:\/53355\/(cl\d{9})/i);
  const arkId = urlMatch ? urlMatch[1] : t;

  const record = await fetchArkJson(arkId);
  if (!record) throw new Error(`Louvre ARK ${arkId} not found`);

  if (!Array.isArray(record.image) || record.image.length === 0) {
    throw new Error(`Louvre ARK ${arkId} has no images`);
  }
  const imageEntry = record.image.find(img => img.urlImage);
  if (!imageEntry) throw new Error(`Louvre ARK ${arkId} has no downloadable image URL`);

  let imageBuffer, contentType;
  try {
    const imageResponse = await axios.get(imageEntry.urlImage, {
      responseType: 'arraybuffer',
      timeout: 30000,
      headers: HEADERS,
    });
    imageBuffer = Buffer.from(imageResponse.data);
    contentType = imageResponse.headers['content-type'] || 'image/jpeg';
  } catch (err) {
    throw new Error(`Failed to download image for Louvre ARK ${arkId}: ${err.message}`);
  }

  return {
    imageBuffer,
    contentType,
    metadata: {
      title:       record.title || null,
      creator:     buildCreatorString(record.creator),
      medium:      record.materialsAndTechniques || null,
      dateCreated: buildDateString(record),
      collection:  record.collection || null,
      attribution: imageEntry.copyright || null,
      artworkUrl:  record.url || `${BASE_URL}/ark:/53355/${arkId}`,
      source:      'Musée du Louvre',
    },
  };
}

module.exports = {
  fetchRandomArtwork,
  fetchByIdentifier,
  canHandleIdentifier,
  selectMode,
  getFilterTypes,
  metadataFields,
  defaultMapping,
  DEPARTMENT_TYPES,
  DEPARTMENT_CATEGORIES,
};
