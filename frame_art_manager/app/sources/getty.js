'use strict';
const axios = require('axios');
const sharp = require('sharp');

// J. Paul Getty Museum — Los Angeles, California
// Open Content Program: ~91,500 CC0 public-domain images
//
// API: https://www.getty.edu/art/collection/api/search
//   ?open_content=true  — restrict to open-access artworks
//   &from={offset}      — pagination offset (0-based)
//   &size={n}           — results per page
//   &q={term}           — full-text search (title, artist, materials, culture, etc.)
//
// Images: IIIF via https://media.getty.edu/iiif/image/{uuid}/full/!4800,4800/0/default.jpg
// Artwork URL: https://www.getty.edu/art/collection/object/{slug}

const SEARCH_URL     = 'https://www.getty.edu/art/collection/api/search';
const IIIF_IMAGE_BASE = 'https://media.getty.edu/iiif/image';
const ARTWORK_BASE   = 'https://www.getty.edu/art/collection';

// Cached total open-access count — updated from live API responses.
// Initial value verified March 2026; the real figure is fetched on first browse.
let _knownBrowseTotal = 91524;

// ── Query building ────────────────────────────────────────────────────────────

/**
 * Build axios params for the search API from the active filter set.
 * open_content=true is always included.
 * artist and search filters both map to the q= text parameter.
 */
function buildSearchParams(filters) {
  const params = { open_content: true };

  const artistFilter = filters.find(f => f.type === 'artist' && f.mode === 'require');
  const searchFilter = filters.find(f => f.type === 'search'  && f.mode === 'require');

  const terms = [];
  if (artistFilter?.values?.[0]) terms.push(artistFilter.values[0].trim());
  if (searchFilter?.values?.[0]) terms.push(searchFilter.values[0].trim());

  if (terms.length > 0) params.q = terms.join(' ');
  return params;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Fetch a random artwork from the Getty Museum open-access collection.
 *
 * Selection strategy:
 *   Browse mode (no text query): pick a random offset in the full ~91,500-item
 *   open-content pool. The page total is cached and refreshed from each response.
 *
 *   Search mode (artist or keyword filter): first fetch size=0 to get the
 *   filtered total, then pick a random offset within it.
 *
 * Aspect ratio is determined post-download via sharp (IIIF responses don't
 * include dimensions in the search result, and an extra info.json round-trip
 * would add latency on every attempt).
 *
 * @param {Array<{type, mode, values}>} [filters=[]]
 *   Supported types: 'artist' (require), 'search' (require)
 * @param {{ aspectRatio?: 'all'|'landscape'|'portrait' }} [options={}]
 */
async function fetchRandomArtwork(filters = [], options = {}) {
  const { aspectRatio = 'all' } = options;
  const params = buildSearchParams(filters);
  const hasQuery = !!params.q;

  // For searches, fetch the total first to bound the random offset.
  // For browse mode, use the cached total (no round-trip needed).
  let total = _knownBrowseTotal;
  if (hasQuery) {
    const countResp = await axios.get(SEARCH_URL, {
      params: { ...params, size: 0 },
      timeout: 15000,
    });
    total = countResp.data.total || 0;
    if (total === 0) throw new Error('No Getty artworks match the selected filters');
  }

  const MAX_ATTEMPTS = 10;
  const PAGE_SIZE = 10; // fetch a small page per attempt so we have alternates if one image fails

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const offset = Math.floor(Math.random() * total);

    let items;
    try {
      const resp = await axios.get(SEARCH_URL, {
        params: { ...params, from: offset, size: PAGE_SIZE },
        timeout: 15000,
      });
      // Keep browse total fresh
      if (!hasQuery && resp.data.total) _knownBrowseTotal = resp.data.total;
      items = resp.data.data || [];
    } catch (e) {
      console.warn(`[getty] Search request failed: ${e.message}`);
      continue;
    }

    if (items.length === 0) continue;

    // Shuffle the page so we don't always start from the same position
    items = [...items].sort(() => Math.random() - 0.5);

    for (const item of items) {
      const uuid = item.manifest?.thumbUuid;
      if (!uuid) continue;

      const imageUrl = `${IIIF_IMAGE_BASE}/${uuid}/full/!4800,4800/0/default.jpg`;
      let imageBuffer;
      try {
        const imgResp = await axios.get(imageUrl, {
          responseType: 'arraybuffer',
          timeout: 45000,
        });
        imageBuffer = Buffer.from(imgResp.data);
      } catch (e) {
        console.warn(`[getty] Image download failed (${uuid}): ${e.message}`);
        continue;
      }

      // Post-download aspect ratio check
      if (aspectRatio !== 'all') {
        const { width, height } = await sharp(imageBuffer).metadata();
        const isLandscape = width > height;
        if (aspectRatio === 'landscape' && !isLandscape) continue;
        if (aspectRatio === 'portrait' &&  isLandscape) continue;
      }

      return {
        imageBuffer,
        contentType: 'image/jpeg',
        metadata: buildMetadata(item),
      };
    }
  }

  throw new Error(
    `Could not find a suitable${aspectRatio !== 'all' ? ` ${aspectRatio}` : ''} Getty artwork after ${MAX_ATTEMPTS} attempts`
  );
}

/**
 * Build the metadata object from a search result item.
 */
function buildMetadata(item) {
  const producer = item.producers?.[0] || null;
  return {
    title:           item.primary_name      || null,
    creator:         producer?.primary_name || null,
    dateCreated:     item.date_created      || null,
    culture:         item.culture?.[0]      || null,
    accessionNumber: item.object_number     || null,
    artworkUrl:      `${ARTWORK_BASE}${item.slug_with_path || ''}`,
    source:          'J. Paul Getty Museum',
  };
}

/**
 * Returns true if this source can handle the given identifier.
 * Accepts Getty collection URLs and short object slugs (e.g. "103QTM").
 */
function canHandleIdentifier(identifier) {
  const t = identifier.trim();
  return /getty\.edu\/art\/collection\/object\/[A-Z0-9]+/i.test(t)
    || /^[A-Z0-9]{4,8}$/i.test(t);
}

/**
 * Fetch a specific Getty artwork by its URL or short slug (e.g. "103QTM").
 * Uses a text search as a best-effort lookup — works reliably for slugs that
 * appear in the collection search index.
 *
 * @param {string} identifier - Getty collection URL or slug
 * @param {{ aspectRatio?: string }} [options={}]
 */
async function fetchByIdentifier(identifier, options = {}) {
  const t = identifier.trim();
  const urlMatch = t.match(/\/object\/([A-Z0-9]+)/i);
  const slug = (urlMatch?.[1] || t).toUpperCase();

  // Getty's search API doesn't support direct slug lookup; use text search
  // and match the id_manager_slug in the result set.
  const resp = await axios.get(SEARCH_URL, {
    params: { q: slug, open_content: true, size: 25 },
    timeout: 15000,
  });

  const item = resp.data.data?.find(r => r.id_manager_slug?.toUpperCase() === slug);
  if (!item) {
    throw new Error(
      `Getty object "${slug}" not found in the open-access collection. ` +
      `Confirm the URL is for a public-domain work on getty.edu/art/collection.`
    );
  }

  const { aspectRatio = 'all' } = options;
  const uuid = item.manifest?.thumbUuid;
  if (!uuid) throw new Error(`Getty object "${slug}" has no image`);

  const imageUrl = `${IIIF_IMAGE_BASE}/${uuid}/full/!4800,4800/0/default.jpg`;
  const imgResp = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 45000 });
  const imageBuffer = Buffer.from(imgResp.data);

  if (aspectRatio !== 'all') {
    const { width, height } = await sharp(imageBuffer).metadata();
    const isLandscape = width > height;
    if (aspectRatio === 'landscape' && !isLandscape) {
      throw new Error(`Object ${slug} is portrait; landscape filter cannot be satisfied`);
    }
    if (aspectRatio === 'portrait' && isLandscape) {
      throw new Error(`Object ${slug} is landscape; portrait filter cannot be satisfied`);
    }
  }

  return {
    imageBuffer,
    contentType: 'image/jpeg',
    metadata: buildMetadata(item),
  };
}

/**
 * Suggest Getty artist/photographer names matching the query.
 * Uses the artist facet from a text search — returns artists whose works
 * match the query, ranked by artwork count.
 *
 * @param {string} query
 * @param {number} [limit=10]
 * @returns {Promise<Array<{name, count, source}>>}
 */
async function suggestArtists(query, limit = 10) {
  const q = (query || '').trim();
  if (!q) return [];

  try {
    const resp = await axios.get(SEARCH_URL, {
      params: { q, open_content: true, size: 0 },
      timeout: 10000,
    });
    const artistFacets = resp.data.facets?.artist || [];
    return artistFacets
      .filter(f => f.value && f.value !== 'Unknown')
      .slice(0, limit)
      .map(f => ({ name: f.value, count: f.count, source: 'getty' }));
  } catch {
    return [];
  }
}

/**
 * Count open-access Getty artworks for a given artist name.
 * Uses full-text search — count may include non-artist matches.
 *
 * @param {string} artistName
 * @returns {Promise<number|null>}
 */
async function countArtistArtworks(artistName) {
  const q = (artistName || '').trim();
  if (!q) return null;

  try {
    const resp = await axios.get(SEARCH_URL, {
      params: { q, open_content: true, size: 0 },
      timeout: 10000,
    });
    return resp.data.total || null;
  } catch {
    return null;
  }
}

/**
 * Returns the API strategy for the given filter set.
 * Getty has two modes: browse (all open-access, random offset) and
 * search (text query narrows the pool before random selection).
 */
function selectMode(filters = []) {
  const hasText = filters.some(f =>
    ['artist', 'search'].includes(f.type) && f.mode === 'require' && f.values?.[0]
  );
  return {
    mode: hasText ? 'search' : 'browse',
    apiFilters: filters.filter(f => ['artist', 'search'].includes(f.type)),
    postFilters: [],
  };
}

function getFilterTypes() {
  return [
    {
      type: 'artist',
      label: 'Artist / Photographer',
      description: 'Restrict to works by a specific artist or photographer.',
      modes: ['require'],
      multiValue: false,
      modeDetermining: true,
      values: [],
      inputStyle: 'search',
    },
    {
      type: 'search',
      label: 'Search',
      description: 'Filter by title, subject, materials, culture, or any keyword.',
      modes: ['require'],
      multiValue: false,
      modeDetermining: true,
      values: [],
      inputStyle: 'search',
    },
  ];
}

const metadataFields = [
  { key: 'title',           label: 'Title',            description: 'Artwork or photograph title' },
  { key: 'creator',         label: 'Artist',           description: 'Artist or photographer name' },
  { key: 'dateCreated',     label: 'Date',             description: 'Creation date (e.g. "1890", "negative 1885–1903")' },
  { key: 'culture',         label: 'Culture',          description: 'Cultural origin (e.g. "American", "French")' },
  { key: 'accessionNumber', label: 'Accession Number', description: 'Getty Museum accession number' },
  { key: 'source',          label: 'Source',           description: 'Always "J. Paul Getty Museum"' },
];

const defaultMapping = {
  title:           'title',
  creator:         'artist',
  dateCreated:     'date',
  culture:         null,
  accessionNumber: null,
  source:          null,
};

module.exports = {
  fetchRandomArtwork,
  fetchByIdentifier,
  canHandleIdentifier,
  selectMode,
  getFilterTypes,
  suggestArtists,
  countArtistArtworks,
  metadataFields,
  defaultMapping,
};
