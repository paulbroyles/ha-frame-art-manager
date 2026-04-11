'use strict';

/**
 * Art Institute of Chicago (AIC)
 *
 * Public API — no authentication required.
 * Docs: https://api.artic.edu/docs/
 *
 * API: REST + Elasticsearch (POST /artworks/search).
 * Images: IIIF 2.1 via https://www.artic.edu/iiif/2/{image_id}/...
 *
 * Only public-domain artworks have accessible IIIF images; non-public-domain
 * images return HTTP 400. The `is_public_domain` flag is the correct filter.
 *
 * Selection strategy: build a pool of all public-domain artwork IDs matching
 * the current filter set, using Elasticsearch search_after for full coverage.
 * Pool is cached 24h (similar to Wikidata QID pool). On first fetch before the
 * pool is ready, falls back to random offset within the reachable 1000-item window.
 *
 * Pool build: ~585 requests × 100 items = 58,574 IDs total (all types, no filter).
 * At ~0.2s/request that's ~2 min cold. A background warmup at startup covers the
 * default (no-filter) pool before the first user fetch.
 */

const axios = require('axios');
const sharp = require('sharp');
const { iiifBoundingBox } = require('../utils/thumbSize');

const API_BASE  = 'https://api.artic.edu/api/v1';
const IIIF_BASE = 'https://www.artic.edu/iiif/2';

const USER_AGENT = 'frame-art-manager/1.0 (github.com/paulbroyles/ha-frame-art-manager)';
const HEADERS    = { 'User-Agent': USER_AGENT, 'AIC-User-Agent': USER_AGENT };

// Fields requested from the artworks API.
const ARTWORK_FIELDS = [
  'id', 'title', 'artist_display', 'date_display', 'medium_display',
  'dimensions', 'image_id', 'is_public_domain', 'department_title',
  'artwork_type_title', 'place_of_origin', 'description', 'credit_line',
  'artwork_type_id',
].join(',');

// Search page size — max 100 per AIC API limits.
const PAGE_SIZE = 100;

// Pool cache TTL (24 hours).
const POOL_TTL_MS = 24 * 60 * 60 * 1000;

// Pool cache: key → { ids: number[], fetchedAt: number }
const poolCache = new Map();

// ── Artwork type filters ───────────────────────────────────────────────────────
//
// `artwork_type_title` is a controlled vocabulary. The most common values among
// public-domain artworks with images (from aggregation, early 2026):
//
//   24,189 Print               7,567 Drawing and Watercolor
//    5,809 Textile             3,778 Photograph
//    2,758 Ceramics            1,795 Painting
//    1,780 Glass               1,737 Costume and Accessories
//    1,662 Vessel              1,324 Sculpture
//    1,220 Coin                1,082 Metalwork
//      589 Decorative Arts       494 Arms
//      418 Medals               384 Furniture
//      337 Armor                303 Religious/Ritual Object
//      249 Book                 228 Miniature Painting
//
// We expose the highest-value display-friendly types as user-selectable filters.

const ARTWORK_TYPES = [
  { value: 'Painting',              label: 'Paintings',               count: 1795  },
  { value: 'Print',                 label: 'Prints',                  count: 24189 },
  { value: 'Drawing and Watercolor',label: 'Drawings & Watercolors',  count: 7567  },
  { value: 'Photograph',            label: 'Photographs',             count: 3778  },
  { value: 'Sculpture',             label: 'Sculpture',               count: 1324  },
  { value: 'Textile',               label: 'Textiles',                count: 5809  },
  { value: 'Ceramics',              label: 'Ceramics',                count: 2758  },
  { value: 'Miniature Painting',    label: 'Miniature Paintings',     count: 228   },
];

// ── Pool cache helpers ─────────────────────────────────────────────────────────

function poolCacheKey(filters) {
  const types = getRequireValues(filters, 'type').slice().sort();
  return types.length ? `type:${types.join(',')}` : 'all';
}

function getRequireValues(filters, type) {
  return filters
    .filter(f => f.type === type && f.mode === 'require')
    .flatMap(f => f.values || []);
}

/**
 * Build the Elasticsearch filter clause for the given filters.
 * Always includes `is_public_domain: true` and `exists: image_id`.
 */
function buildEsFilter(filters) {
  const esFilters = [
    { term: { is_public_domain: true } },
    { exists: { field: 'image_id' } },
  ];

  const types = getRequireValues(filters, 'type');
  if (types.length === 1) {
    esFilters.push({ term: { 'artwork_type_title.keyword': types[0] } });
  } else if (types.length > 1) {
    esFilters.push({ terms: { 'artwork_type_title.keyword': types } });
  }

  return esFilters;
}

/**
 * Fetch all public-domain artwork IDs matching the filter set, using
 * Elasticsearch search_after for full coverage beyond the 1000-result window.
 *
 * Returns a shuffled array of numeric IDs.
 * Caches the result for POOL_TTL_MS.
 */
async function buildPool(filters) {
  const key = poolCacheKey(filters);
  const cached = poolCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < POOL_TTL_MS) return cached.ids;

  const ids = [];
  let searchAfter = null;

  while (true) {
    const body = {
      query: { bool: { filter: buildEsFilter(filters) } },
      size: PAGE_SIZE,
      sort: [{ id: { order: 'asc' } }],
      fields: ['id'],
      _source: false,
    };
    if (searchAfter !== null) body.search_after = [searchAfter];

    const response = await axios.post(`${API_BASE}/artworks/search`, body, {
      headers: { ...HEADERS, 'Content-Type': 'application/json' },
      timeout: 15000,
    });

    const page = response.data.data || [];
    if (page.length === 0) break;

    for (const obj of page) ids.push(obj.id);
    searchAfter = page[page.length - 1].id;

    if (page.length < PAGE_SIZE) break;
  }

  // Shuffle so random picks don't cluster at the start.
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }

  poolCache.set(key, { ids, fetchedAt: Date.now() });
  console.log(`[aic] Pool built for "${key}": ${ids.length} artworks`);
  return ids;
}

/**
 * Pick a random ID from the pool, building it if necessary.
 * On first call before pool is ready, falls back to a random search offset.
 */
async function pickRandomId(filters) {
  const key = poolCacheKey(filters);
  const cached = poolCache.get(key);

  if (cached && cached.ids.length > 0) {
    return cached.ids[Math.floor(Math.random() * cached.ids.length)];
  }

  // Pool not yet built — fall back to random offset in first 1000 results.
  const esFilters = buildEsFilter(filters);
  const total = await getFilterTotal(esFilters);
  const from  = Math.floor(Math.random() * Math.min(total, 1000));

  const body = {
    query: { bool: { filter: esFilters } },
    from,
    size: 1,
    sort: [{ id: { order: 'asc' } }],
    fields: ['id'],
    _source: false,
  };
  const response = await axios.post(`${API_BASE}/artworks/search`, body, {
    headers: { ...HEADERS, 'Content-Type': 'application/json' },
    timeout: 10000,
  });
  const obj = response.data.data?.[0];
  if (!obj) throw new Error('[aic] No artworks found matching filters');
  return obj.id;
}

async function getFilterTotal(esFilters) {
  const body = { query: { bool: { filter: esFilters } }, size: 0, _source: false };
  const response = await axios.post(`${API_BASE}/artworks/search`, body, {
    headers: { ...HEADERS, 'Content-Type': 'application/json' },
    timeout: 10000,
  });
  return response.data.pagination?.total ?? 0;
}

// ── Image fetching ─────────────────────────────────────────────────────────────

/**
 * Build a IIIF bounding-box URL for the given image_id at the target orientation.
 * Fetches info.json first to get native dimensions for an accurate bounding box.
 */
async function buildImageUrl(imageId, orientation) {
  // Fetch IIIF info.json for native dimensions.
  let nativeW, nativeH;
  try {
    const info = await axios.get(`${IIIF_BASE}/${imageId}/info.json`, {
      headers: HEADERS, timeout: 8000,
    });
    nativeW = info.data.width;
    nativeH = info.data.height;
  } catch {
    // If info.json fails, request a safe bounding box without native dims.
    nativeW = null;
    nativeH = null;
  }

  const bbox = iiifBoundingBox(orientation, nativeW, nativeH);
  return `${IIIF_BASE}/${imageId}/full/!${bbox}/0/default.jpg`;
}

// ── fetchRandomArtwork ─────────────────────────────────────────────────────────

/**
 * Fetch a random public-domain artwork from the Art Institute of Chicago.
 *
 * @param {Array<{type, mode, values}>} filters
 * @param {object} [options]
 * @param {string} [options.aspectRatio='all'] - 'all' | 'landscape' | 'portrait'
 * @returns {{ imageBuffer, contentType, metadata }}
 */
async function fetchRandomArtwork(filters = [], options = {}) {
  const { aspectRatio = 'all' } = options;
  const orientation = aspectRatio === 'portrait' ? 'portrait' : 'landscape';

  const MAX_CANDIDATES = 10;

  for (let attempt = 0; attempt < MAX_CANDIDATES; attempt++) {
    const id = await pickRandomId(filters);

    let obj;
    try {
      const response = await axios.get(`${API_BASE}/artworks/${id}`, {
        params: { fields: ARTWORK_FIELDS },
        headers: HEADERS,
        timeout: 10000,
      });
      obj = response.data.data;
    } catch (err) {
      console.warn(`[aic] Failed to fetch artwork ${id}: ${err.message}`);
      continue;
    }

    if (!obj?.image_id) {
      console.warn(`[aic] Artwork ${id} has no image_id — skipping`);
      continue;
    }

    const imageUrl = await buildImageUrl(obj.image_id, orientation);
    let imageBuffer;
    try {
      const resp = await axios.get(imageUrl, {
        responseType: 'arraybuffer',
        headers: HEADERS,
        timeout: 30000,
      });
      imageBuffer = Buffer.from(resp.data);
    } catch (err) {
      console.warn(`[aic] Failed to download image for ${id}: ${err.message}`);
      continue;
    }

    // Verify aspect ratio post-download.
    if (aspectRatio !== 'all') {
      let w, h;
      try {
        ({ width: w, height: h } = await sharp(imageBuffer).metadata());
      } catch {
        console.warn(`[aic] Could not read dimensions for ${id}`);
        continue;
      }
      if (aspectRatio === 'landscape' && w < h) continue;
      if (aspectRatio === 'portrait'  && w > h) continue;
    }

    return {
      imageBuffer,
      contentType: 'image/jpeg',
      metadata: buildMetadata(obj),
    };
  }

  throw new Error(`[aic] Could not find a suitable artwork after ${MAX_CANDIDATES} attempts`);
}

// ── fetchByIdentifier ──────────────────────────────────────────────────────────

/**
 * Accepts AIC collection URLs or bare numeric IDs.
 * e.g. https://www.artic.edu/artworks/27992/a-sunday-on-la-grande-jatte-1884
 */
function canHandleIdentifier(identifier) {
  const t = identifier.trim();
  return /artic\.edu\/artworks\/(\d+)/i.test(t) || /^\d+$/.test(t);
}

async function fetchByIdentifier(identifier, options = {}) {
  const { aspectRatio = 'all' } = options;
  const orientation = aspectRatio === 'portrait' ? 'portrait' : 'landscape';

  const t = identifier.trim();
  const urlMatch = t.match(/artic\.edu\/artworks\/(\d+)/i);
  const id = urlMatch ? urlMatch[1] : t;

  const response = await axios.get(`${API_BASE}/artworks/${id}`, {
    params: { fields: ARTWORK_FIELDS },
    headers: HEADERS,
    timeout: 10000,
  });
  const obj = response.data.data;
  if (!obj) throw new Error(`[aic] Artwork ${id} not found`);
  if (!obj.image_id) throw new Error(`[aic] Artwork ${id} has no accessible image`);

  const imageUrl = await buildImageUrl(obj.image_id, orientation);
  const resp = await axios.get(imageUrl, {
    responseType: 'arraybuffer',
    headers: HEADERS,
    timeout: 30000,
  });

  return {
    imageBuffer: Buffer.from(resp.data),
    contentType: 'image/jpeg',
    metadata: buildMetadata(obj),
  };
}

// ── searchPreview ──────────────────────────────────────────────────────────────

async function searchPreview(query, options = {}) {
  const { count = 12 } = options;

  const body = {
    q: query,
    query: { bool: { filter: [
      { term: { is_public_domain: true } },
      { exists: { field: 'image_id' } },
    ]}},
    size: count,
    fields: ['id', 'title', 'artist_display', 'image_id', 'date_display'],
    _source: false,
  };

  const response = await axios.post(`${API_BASE}/artworks/search`, body, {
    headers: { ...HEADERS, 'Content-Type': 'application/json' },
    timeout: 10000,
  });

  const results = (response.data.data || []).map(obj => ({
    title:        obj.title || null,
    creator:      obj.artist_display?.split('\n')[0] || null,
    thumbnailUrl: obj.image_id
      ? `${IIIF_BASE}/${obj.image_id}/full/!200,200/0/default.jpg`
      : null,
    artworkUrl:   `https://www.artic.edu/artworks/${obj.id}`,
    source:       'Art Institute of Chicago',
  }));

  return { results, totalAvailable: response.data.pagination?.total ?? 0 };
}

// ── Metadata helpers ───────────────────────────────────────────────────────────

function buildMetadata(obj) {
  // artist_display includes nationality/lifespan on the second line, e.g.:
  // "Claude Monet\nFrench, 1840–1926"
  const artistLines  = (obj.artist_display || '').split('\n');
  const creatorName  = artistLines[0]?.trim() || null;
  const creatorBio   = artistLines[1]?.trim() || null;

  return {
    title:       obj.title       || null,
    creator:     creatorName,
    creatorBio,
    dateCreated: obj.date_display  || null,
    medium:      obj.medium_display || null,
    dimensions:  obj.dimensions  || null,
    department:  obj.department_title || null,
    description: obj.description ? stripHtml(obj.description) : null,
    creditLine:  obj.credit_line || null,
    artworkUrl:  `https://www.artic.edu/artworks/${obj.id}`,
    source:      'Art Institute of Chicago',
  };
}

function stripHtml(str) {
  return str.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

// ── selectMode ────────────────────────────────────────────────────────────────

function selectMode(filters = []) {
  return 'random';
}

// ── getFilterTypes ─────────────────────────────────────────────────────────────

function getFilterTypes() {
  return [
    {
      type:        'type',
      label:       'Artwork Type',
      description: 'Restrict or exclude artworks by type.',
      modes:       ['require', 'exclude'],
      multiValue:  true,
      values:      ARTWORK_TYPES.map(({ value, label, count }) => ({ value, label, count })),
    },
  ];
}

// ── suggestArtists ─────────────────────────────────────────────────────────────

async function suggestArtists(query, options = {}) {
  const { count = 10 } = options;

  // Search the agents endpoint for artists.
  const response = await axios.get(`${API_BASE}/agents/search`, {
    params: { q: query, limit: count * 2, fields: 'id,title,birth_date,death_date' },
    headers: HEADERS,
    timeout: 10000,
  });

  // Filter to those who have public-domain artworks.
  const agents = response.data.data || [];
  return agents
    .filter(a => a.title && !/^(museum|collection|gallery|trust|foundation|estate)/i.test(a.title))
    .slice(0, count)
    .map(a => ({
      name: a.title,
      description: [a.birth_date, a.death_date].filter(Boolean).join('–') || null,
      source: 'aic',
    }));
}

async function countArtistArtworks(artistName, options = {}) {
  const body = {
    q: artistName,
    query: { bool: { filter: [
      { term: { is_public_domain: true } },
      { exists: { field: 'image_id' } },
    ]}},
    size: 0,
    _source: false,
  };
  const response = await axios.post(`${API_BASE}/artworks/search`, body, {
    headers: { ...HEADERS, 'Content-Type': 'application/json' },
    timeout: 10000,
  });
  return response.data.pagination?.total ?? 0;
}

// ── Metadata declarations ──────────────────────────────────────────────────────

const metadataFields = [
  { key: 'title',       label: 'Title',       description: 'Artwork title' },
  { key: 'creator',     label: 'Artist',      description: 'Primary artist or maker name' },
  { key: 'creatorBio',  label: 'Artist Bio',  description: 'Artist nationality and lifespan (e.g. "French, 1840–1926")' },
  { key: 'dateCreated', label: 'Date',        description: 'Human-readable date (e.g. "1884–86")' },
  { key: 'medium',      label: 'Medium',      description: 'Materials and technique' },
  { key: 'dimensions',  label: 'Dimensions',  description: 'Physical dimensions' },
  { key: 'department',  label: 'Department',  description: 'AIC curatorial department' },
  { key: 'creditLine',  label: 'Credit Line', description: 'Acquisition or gift credit' },
  { key: 'description', label: 'Description', description: 'Curatorial description' },
  { key: 'source',      label: 'Source',      description: 'Always "Art Institute of Chicago"' },
];

const defaultMapping = {
  title:       'title',
  creator:     { entity: 'creator', attribute: 'name' },
  creatorBio:  'creator_nationality',
  dateCreated: 'date',
  medium:      'medium',
  dimensions:  'dimensions',
  department:  null,
  creditLine:  'credit_line',
  description: 'description',
  source:      'museum',
};

// ── Startup pool warm-up ───────────────────────────────────────────────────────

// Pre-populate the default (no-filter) pool in the background so the first
// user fetch doesn't pay the full pool build latency (~2 min).
(async () => {
  try {
    await buildPool([]);
  } catch (err) {
    console.warn(`[aic] Startup pool warmup failed: ${err.message}`);
  }
})();

module.exports = {
  fetchRandomArtwork,
  fetchByIdentifier,
  canHandleIdentifier,
  searchPreview,
  selectMode,
  getFilterTypes,
  suggestArtists,
  countArtistArtworks,
  metadataFields,
  defaultMapping,
};
