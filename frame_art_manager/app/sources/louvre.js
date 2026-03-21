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
// Category filtering uses the `typology[N]=<id>` query parameter, which pre-filters results
// server-side by object type (e.g. typology[0]=22 for Paintings). Multiple categories are
// passed as typology[0]=22&typology[1]=24 etc. (the server returns items matching any).
// The page count for a filtered search is probed once and cached for 7 days.
//
// Total unfiltered collection: ~478,000 objects across 25,078 pages of 20 results each.

const BASE_URL  = 'https://collections.louvre.fr';
const MAX_PAGES = 25078; // Observed maximum page (unfiltered)

const HEADERS = { 'User-Agent': 'frame-art-manager/1.0 (home automation art display)' };

// Object categories available for filtering via typology[N]=<id>.
// IDs were verified by probing https://collections.louvre.fr/en/recherche?typology[0]=N.
const CATEGORIES = {
  'Paintings':         { id: 22 },  // ~549 pages (~10,972 items)
  'Drawings & Prints': { id: 13 },  // ~310 pages (~6,200 items)
  'Sculptures':        { id: 24 },  // ~1,927 pages (~38,537 items)
  'Jewelry':           { id: 12 },  // ~1,142 pages (~22,835 items)
  'Furniture':         { id: 15 },  // ~179 pages (~3,571 items)
  'Textiles':          { id: 26 },  // ~401 pages (~8,015 items)
  'Vases':             { id: 27 },  // ~3,205 pages (~64K items)
  'Coins & Medals':    { id: 16 },  // ~299 pages (~5,972 items)
};

const CATEGORY_TYPES = Object.keys(CATEGORIES);

// User-visible category groups for the UI filter builder.
const CATEGORY_GROUPS = [
  { name: 'Fine Art',        media: ['Paintings', 'Drawings & Prints', 'Sculptures'] },
  { name: 'Decorative Arts', media: ['Jewelry', 'Furniture', 'Textiles', 'Vases', 'Coins & Medals'] },
];

// In-memory cache: sorted typology-ID key → { maxPages, fetchedAt }.
// 7-day TTL so the count refreshes weekly as the Louvre adds new items.
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
 * typologyIds: array of numeric typology IDs for pre-filtering (e.g. [22] for Paintings,
 *   [22, 24] for Paintings + Sculptures), or null/[] for no category filter.
 * searchTerm: optional keyword passed as the q= parameter.
 * Returns { arkIds, html }.
 */
async function fetchSearchPage(page, typologyIds, searchTerm) {
  // Build the query string manually to preserve literal brackets in typology[N] parameter
  // names. URLSearchParams would percent-encode them as typology%5BN%5D, which the
  // Louvre server does not recognise.
  let qs = `q=${encodeURIComponent(searchTerm || '')}&page=${encodeURIComponent(page)}`;
  if (typologyIds && typologyIds.length > 0) {
    typologyIds.forEach((id, i) => { qs += `&typology[${i}]=${id}`; });
  }
  const response = await axios.get(`${BASE_URL}/en/recherche?${qs}`, {
    timeout: 15000,
    headers: HEADERS,
  });
  return { arkIds: extractArkIds(response.data), html: response.data };
}

/**
 * Get (and cache) the max page count for a given set of typology IDs and optional search term.
 * Probes page 1 to read the pagination total; falls back to MAX_PAGES on parse failure.
 */
async function getMaxPages(typologyIds, searchTerm) {
  const key = [...(typologyIds || []).slice().sort(), searchTerm || ''].join(',');
  const cached = _pageCountCache.get(key);
  if (cached && (Date.now() - cached.fetchedAt) < PAGE_COUNT_TTL_MS) return cached.maxPages;

  let maxPages = cached?.maxPages || MAX_PAGES; // keep stale value on failure
  try {
    const { html } = await fetchSearchPage(1, typologyIds, searchTerm);
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

// ── fetchRandomArtwork ────────────────────────────────────────────────────────

/**
 * Fetch a random artwork from the Louvre collections.
 *
 * Category filtering is applied pre-fetch via `typology[N]=<id>` URL parameters.
 * require filters restrict to the selected categories; exclude filters remove them.
 * The resulting typology IDs are passed to the search URL so every page fetch
 * already matches the filter. The page count for a given category combination
 * is probed from page 1 once and cached for 7 days.
 *
 * @param {Array<{type: string, mode: 'require'|'exclude', values: string[]}>} [filters=[]]
 *   Supported type: 'category' — values are user-visible names from CATEGORY_TYPES.
 * @param {object} [options]
 * @param {'all'|'landscape'|'portrait'} [options.aspectRatio='all']
 * @returns {{ imageBuffer, contentType, metadata }}
 */
async function fetchRandomArtwork(filters = [], options = {}) {
  const { aspectRatio = 'all' } = options;

  // Artist filter — passed as the q= parameter. Takes priority over keyword search,
  // since artist names are typically more specific search terms.
  const artistName = filters.find(f => f.type === 'artist' && f.mode === 'require')?.values?.[0] || null;

  // Keyword search filter — passed as the q= parameter to the Louvre search URL.
  const searchTerm = filters.find(f => f.type === 'search' && f.mode === 'require')?.values?.[0] || null;

  // Artist takes priority over keyword search (both map to q=).
  const effectiveSearchTerm = artistName || searchTerm || null;

  // Compute eligible categories (require intersection, then exclude union).
  const requireSets = filters
    .filter(f => f.type === 'category' && f.mode === 'require')
    .map(f => new Set((f.values || []).map(v => v.toLowerCase())));
  const excludeValues = new Set(
    filters
      .filter(f => f.type === 'category' && f.mode === 'exclude')
      .flatMap(f => f.values || [])
      .map(v => v.toLowerCase())
  );

  let eligibleCategories = CATEGORY_TYPES;
  if (requireSets.length > 0) {
    eligibleCategories = eligibleCategories.filter(c => requireSets.every(s => s.has(c.toLowerCase())));
  }
  if (excludeValues.size > 0) {
    eligibleCategories = eligibleCategories.filter(c => !excludeValues.has(c.toLowerCase()));
  }
  if (eligibleCategories.length === 0) {
    throw new Error('No categories eligible after applying filters');
  }

  // Pass typology IDs to the search URL when categories are constrained.
  const filterActive = eligibleCategories.length < CATEGORY_TYPES.length;
  const typologyIds = filterActive
    ? eligibleCategories.map(c => CATEGORIES[c].id)
    : null;

  // Get (possibly cached) page count for this category + search combination.
  const maxPages = await getMaxPages(typologyIds, effectiveSearchTerm);

  const MAX_ATTEMPTS = 20;
  let arkIds = [];

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    // Refresh ARK candidate list from a new random page when exhausted.
    if (arkIds.length === 0) {
      const page = Math.floor(Math.random() * maxPages) + 1;
      try {
        ({ arkIds } = await fetchSearchPage(page, typologyIds, effectiveSearchTerm));
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
  const catFilters = filters.filter(f => f.type === 'category');
  const hasArtist  = filters.some(f => f.type === 'artist');
  const hasSearch  = filters.some(f => f.type === 'search');
  const hasRequire = catFilters.some(f => f.mode === 'require');
  const hasExclude = catFilters.some(f => f.mode === 'exclude');
  const mode = hasArtist  ? 'artist_search'
             : hasSearch  ? 'keyword_search'
             : hasRequire ? 'filtered_page'
             : hasExclude ? 'excluded_page'
             :              'random_page';
  return { mode, apiFilters: [...catFilters, ...filters.filter(f => f.type === 'search' || f.type === 'artist')], postFilters: [] };
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
      type:        'category',
      label:       'Object Category',
      description: 'Restrict or exclude artworks by object type. Filtering is applied server-side via the Louvre search API, so only matching categories are fetched.',
      modes:       ['require', 'exclude'],
      multiValue:  true,
      groups:      CATEGORY_GROUPS.map(g => ({ name: g.name, values: g.media })),
      values:      CATEGORY_TYPES.map(name => ({ value: name, label: name })),
    },
    {
      type:        'artist',
      label:       'Artist',
      description: 'Search by artist name. Passed as a keyword query to the Louvre search API. Takes priority over the Search filter.',
      modes:       ['require'],
      multiValue:  false,
      values:      [],
      inputStyle:  'search',
    },
    {
      type:        'search',
      label:       'Search',
      description: 'Search by title, artist, or subject. Applied via the Louvre collection search API.',
      modes:       ['require'],
      multiValue:  false,
      values:      [],
      inputStyle:  'search',
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

/**
 * Count result pages for a given artist name in the Louvre collection.
 * The Louvre's search HTML shows page counts ("1 / 536") but not total item counts.
 * Returns the number of result pages (each page holds ~24 items), or null on error.
 *
 * @param {string} artistName
 * @returns {Promise<number|null>}
 */
async function countArtistArtworks(artistName) {
  try {
    const pages = await getMaxPages([], artistName);
    // MAX_PAGES is the fallback when the probe fails — treat as unknown.
    if (pages === MAX_PAGES) return null;
    // Each page has up to 20 items; multiply for an estimated total.
    return pages * 20;
  } catch {
    return null;
  }
}

module.exports = {
  fetchRandomArtwork,
  fetchByIdentifier,
  canHandleIdentifier,
  selectMode,
  getFilterTypes,
  countArtistArtworks,
  metadataFields,
  defaultMapping,
  CATEGORY_TYPES,
  CATEGORY_GROUPS,
};
