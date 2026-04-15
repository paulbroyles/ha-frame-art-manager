'use strict';
const axios = require('axios');

const BASE_URL = 'https://www.tate.org.uk/api/v2';

// Maximum download + aspect-ratio retry attempts per fetch call.
const MAX_ATTEMPTS = 15;

// Artist list cache: all 6,201 artists from /api/v2/artists/, fetched in pages
// of 100 and held in memory for ARTIST_CACHE_TTL_MS.
const ARTIST_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
let _artistIndex = null;     // Array of { name, cisId, totalWorks } sorted by totalWorks desc
let _artistCacheLoadedAt = 0;
let _artistCachePromise = null;

// Count cache: keyed by canonical params string → { total, fetchedAt }
const COUNT_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const _countCache = new Map();

// ── Classification types ──────────────────────────────────────────────────────

// Maps user-visible category names to Tate API classificationId values.
// Each artwork has exactly one classificationId.
const CLASSIFICATION_IDS = {
  'Paintings':         6,
  'Prints & Graphics': 4,
  'Works on Paper':    5,
  'Sculpture':         8,
  'Installation':      3,
};

const CLASSIFICATION_NAMES = Object.keys(CLASSIFICATION_IDS);

// API fields requested on each artwork fetch. Keep this list minimal to reduce
// response size; master_images is needed for the image URL and aspect ratio.
const ARTWORK_FIELDS = [
  'acno', 'title', 'allArtists', 'medium', 'dateText', 'dimensions',
  'classificationId', 'onDisplayAtTate', 'display_gallery_name',
  'url', 'creditLine', 'master_images', 'mltArtists', 'contributors',
].join(',');

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build API query params from a filter array and an optional cisId for artist filtering.
 *
 * @param {Array<{type, mode, values}>} filters
 * @returns {{ classificationIds: number[]|null, onDisplayAtTate: boolean, cisId: number|null }}
 */
function buildParams(filters) {
  // Build the eligible classification pool.
  const requireSets = filters
    .filter(f => f.type === 'media' && f.mode === 'require')
    .map(f => new Set((f.values || []).map(v => v.toLowerCase())));
  const excludeValues = new Set(
    filters
      .filter(f => f.type === 'media' && f.mode === 'exclude')
      .flatMap(f => f.values || [])
      .map(v => v.toLowerCase())
  );

  let eligible = CLASSIFICATION_NAMES;
  if (requireSets.length > 0) {
    eligible = eligible.filter(n => requireSets.every(s => s.has(n.toLowerCase())));
  }
  if (excludeValues.size > 0) {
    eligible = eligible.filter(n => !excludeValues.has(n.toLowerCase()));
  }

  const classificationIds = eligible.length < CLASSIFICATION_NAMES.length
    ? eligible.map(n => CLASSIFICATION_IDS[n])
    : null; // null = no classification filter (all types)

  if (requireSets.length > 0 && eligible.length === 0) {
    throw new Error('No categories eligible after applying filters');
  }

  const onDisplayAtTate = filters.some(
    f => f.type === 'onDisplay' && f.mode === 'require' && (f.values || []).includes('true')
  );

  return { classificationIds, onDisplayAtTate };
}

/**
 * Fetch the total count for a given set of API params, with 6hr in-memory cache.
 *
 * @param {object} apiParams - Plain object of Tate API query params
 * @returns {Promise<number>}
 */
async function fetchCount(apiParams) {
  const cacheKey = JSON.stringify(apiParams);
  const cached = _countCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < COUNT_CACHE_TTL_MS) {
    return cached.total;
  }

  const response = await axios.get(`${BASE_URL}/artworks/`, {
    params: { ...apiParams, masterImageStatus: 'CLEARED', limit: 1, fields: 'acno' },
    timeout: 10000,
  });
  const total = response.data.meta?.total_count ?? 0;
  _countCache.set(cacheKey, { total, fetchedAt: Date.now() });
  return total;
}

// ── Artist cache ──────────────────────────────────────────────────────────────

/**
 * Ensure the full artist list is loaded into memory.
 * Fetches all 6,201 artists from /api/v2/artists/ in pages of 100.
 * Protected against concurrent rebuilds via promise coalescing.
 */
async function ensureArtistCache() {
  const now = Date.now();
  if (_artistIndex !== null && (now - _artistCacheLoadedAt) < ARTIST_CACHE_TTL_MS) return;
  if (_artistCachePromise) { await _artistCachePromise; return; }

  _artistCachePromise = (async () => {
    try {
      console.log('[tate] Loading artist index...');
      const artists = [];
      let offset = 0;
      const limit = 100;
      // First request to get total_count
      const first = await axios.get(`${BASE_URL}/artists/`, {
        params: { limit, offset, fields: 'title,cis_id,totalWorks', order: '-totalWorks' },
        timeout: 15000,
      });
      const total = first.data.meta?.total_count ?? 0;
      for (const item of (first.data.items || [])) {
        if (item.cis_id != null) artists.push({ name: item.title, cisId: item.cis_id, totalWorks: item.totalWorks || 0 });
      }
      offset += limit;
      // Remaining pages
      const pages = Math.ceil(total / limit);
      for (let page = 1; page < pages; page++) {
        const res = await axios.get(`${BASE_URL}/artists/`, {
          params: { limit, offset, fields: 'title,cis_id,totalWorks', order: '-totalWorks' },
          timeout: 15000,
        });
        for (const item of (res.data.items || [])) {
          if (item.cis_id != null) artists.push({ name: item.title, cisId: item.cis_id, totalWorks: item.totalWorks || 0 });
        }
        offset += limit;
      }
      _artistIndex = artists; // already sorted desc by totalWorks from API
      _artistCacheLoadedAt = Date.now();
      console.log(`[tate] Artist index loaded: ${artists.length} artists`);
    } catch (err) {
      console.warn('[tate] Failed to load artist index:', err.message);
      _artistIndex = _artistIndex || []; // fall back to empty rather than staying null
    } finally {
      _artistCachePromise = null;
    }
  })();

  await _artistCachePromise;
}

/**
 * Resolve an artist name string to a { cisId, name } entry from the cache.
 * Uses case-insensitive exact match first, then substring.
 *
 * @param {string} artistName
 * @returns {Promise<{ cisId: number, name: string }|null>}
 */
async function resolveArtist(artistName) {
  await ensureArtistCache();
  if (!_artistIndex?.length) return null;
  const q = artistName.toLowerCase().trim();
  const exact = _artistIndex.find(a => a.name.toLowerCase() === q);
  if (exact) return exact;
  const partial = _artistIndex.find(a => a.name.toLowerCase().includes(q));
  return partial || null;
}

// ── Artist enrichment ─────────────────────────────────────────────────────────

/**
 * Look up artist lifespan from the artist cache by cisId extracted from contributors.
 * Returns the lifespan string (e.g. "born 1775, died 1851") or null.
 *
 * @param {Array<{url: string, date: string}>} contributors - from artwork API response
 * @returns {Promise<string|null>}
 */
async function resolveArtistLifespan(contributors) {
  if (!Array.isArray(contributors) || contributors.length === 0) return null;
  // contributors[].url ends with "-{cisId}"
  const urlMatch = (contributors[0]?.url || '').match(/-(\d+)$/);
  if (!urlMatch) return null;
  const cisId = parseInt(urlMatch[1], 10);
  await ensureArtistCache();
  const entry = _artistIndex?.find(a => a.cisId === cisId);
  return entry?.date || null;
}

// ── Image extraction ──────────────────────────────────────────────────────────

/**
 * Extract the largest image URL and aspect ratio from a master_images object.
 *
 * @param {object} masterImages
 * @returns {{ url: string, isPortrait: boolean }|null}
 */
function extractImageInfo(masterImages) {
  // master_images is an array; use the first (primary) entry.
  const img = Array.isArray(masterImages) ? masterImages[0] : masterImages;
  const sizes = img?.sizes;
  if (!Array.isArray(sizes) || sizes.length === 0) return null;
  const largest = sizes[sizes.length - 1];
  const imageUrl = largest[2];
  if (!imageUrl) return null;
  // height_ratio = (height / width) * 100; >100 means portrait
  const heightRatio = img.height_ratio || 100;
  const isPortrait = heightRatio > 100;
  return { url: imageUrl, isPortrait };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Fetch a random artwork from the Tate collection.
 *
 * Uses a two-step random-offset strategy: fetch total count for the given
 * filters, pick a random offset, then fetch the artwork at that offset.
 * Aspect ratio is checked pre-download using master_images.height_ratio.
 *
 * @param {Array<{type, mode, values}>} [filters=[]] - Supported filter types:
 *   'media'     — require/exclude by category (classificationId)
 *   'onDisplay' — require: ['true'] to restrict to works on display
 *   'artist'    — require: [artistName] to restrict to a specific artist
 * @param {object} [options]
 * @param {'all'|'landscape'|'portrait'} [options.aspectRatio='all']
 *   Pre-download check using master_images.height_ratio. Works on Paper (classificationId 5)
 *   skews portrait (Turner sketchbooks); MAX_ATTEMPTS is set to 15 to compensate.
 *
 * @returns {{ imageBuffer, contentType, metadata }}
 */
async function fetchRandomArtwork(filters = [], options = {}) {
  const { aspectRatio = 'all' } = options;
  const { classificationIds, onDisplayAtTate } = buildParams(filters);

  // Artist filter: resolve name → cisId
  const artistNameFilter = filters.find(f => f.type === 'artist' && f.mode === 'require')?.values?.[0] || null;
  let artistCisId = null;
  if (artistNameFilter) {
    const resolved = await resolveArtist(artistNameFilter);
    if (!resolved) throw new Error(`Artist not found in Tate collection: "${artistNameFilter}"`);
    artistCisId = resolved.cisId;
  }

  // When multiple classification IDs are eligible, weight by count and pick one.
  // Counts are cached so this is fast after the first fetch.
  const eligibleIds = classificationIds || Object.values(CLASSIFICATION_IDS);

  // Build per-classification counts for weighted selection.
  let selectedClassificationId = null;
  if (eligibleIds.length === 1) {
    selectedClassificationId = eligibleIds[0];
  } else {
    const baseParams = {};
    if (onDisplayAtTate) baseParams.onDisplayAtTate = true;
    if (artistCisId != null) baseParams.mltArtists = artistCisId;

    const counts = await Promise.all(
      eligibleIds.map(id => fetchCount({ ...baseParams, classificationId: id }).catch(() => 0))
    );
    const totalWeight = counts.reduce((s, c) => s + c, 0);
    if (totalWeight === 0) throw new Error('No artworks found matching the selected filters');

    let r = Math.random() * totalWeight;
    for (let i = 0; i < eligibleIds.length; i++) {
      r -= counts[i];
      if (r <= 0) { selectedClassificationId = eligibleIds[i]; break; }
    }
    if (selectedClassificationId == null) selectedClassificationId = eligibleIds[eligibleIds.length - 1];
  }

  // Fetch total for chosen classification + remaining params.
  const fetchParams = { classificationId: selectedClassificationId };
  if (onDisplayAtTate) fetchParams.onDisplayAtTate = true;
  if (artistCisId != null) fetchParams.mltArtists = artistCisId;

  const total = await fetchCount(fetchParams);
  if (total === 0) throw new Error('No artworks found matching the selected filters');

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const offset = Math.floor(Math.random() * total);

    let obj;
    try {
      const response = await axios.get(`${BASE_URL}/artworks/`, {
        params: {
          ...fetchParams,
          masterImageStatus: 'CLEARED',
          limit: 1,
          offset,
          fields: ARTWORK_FIELDS,
        },
        timeout: 15000,
      });
      obj = (response.data.results || response.data.items)?.[0];
    } catch (err) {
      console.warn(`[tate] Fetch attempt ${attempt + 1} failed: ${err.message}`);
      continue;
    }

    if (!obj) continue;

    const imageInfo = extractImageInfo(obj.master_images);
    if (!imageInfo) {
      console.warn(`[tate] ${obj.acno}: no image URL, skipping`);
      continue;
    }

    // Pre-download aspect ratio check using height_ratio.
    if (aspectRatio === 'landscape' && imageInfo.isPortrait) {
      console.warn(`[tate] ${obj.acno}: portrait image skipped (landscape filter active)`);
      continue;
    }
    if (aspectRatio === 'portrait' && !imageInfo.isPortrait) {
      console.warn(`[tate] ${obj.acno}: landscape image skipped (portrait filter active)`);
      continue;
    }

    let imageBuffer, contentType;
    try {
      const imageResponse = await axios.get(imageInfo.url, {
        responseType: 'arraybuffer',
        timeout: 30000,
      });
      imageBuffer = Buffer.from(imageResponse.data);
      contentType = imageResponse.headers['content-type'] || 'image/jpeg';
    } catch (err) {
      console.warn(`[tate] ${obj.acno}: image download failed: ${err.message}`);
      continue;
    }

    const creatorLifespan = await resolveArtistLifespan(obj.contributors).catch(() => null);
    const artworkUrl = obj.url
      ? (obj.url.startsWith('http') ? obj.url : `https://www.tate.org.uk${obj.url}`)
      : null;

    return {
      imageBuffer,
      contentType,
      metadata: {
        title:           obj.title                || null,
        creator:         obj.allArtists           || null,
        creatorLifespan: creatorLifespan          || null,
        medium:          obj.medium               || null,
        dateCreated:     obj.dateText             || null,
        dimensions:      obj.dimensions           || null,
        creditLine:      obj.creditLine           || null,
        gallery:      obj.display_gallery_name || null,
        institution:  obj.display_gallery_name || 'Tate',
        artworkUrl,
        source: 'Tate',
      },
    };
  }

  throw new Error(`Could not find a suitable${aspectRatio !== 'all' ? ` ${aspectRatio}` : ''} artwork after ${MAX_ATTEMPTS} attempts`);
}

/**
 * Suggest artist names from the Tate artist index.
 * Prefix matches sort before substring-only matches; within each group, sorted by totalWorks desc.
 *
 * @param {string} query
 * @param {number} [limit=10]
 * @returns {Promise<Array<{ name, count, source }>>}
 */
async function suggestArtists(query, limit = 10) {
  await ensureArtistCache();
  const q = query.toLowerCase().trim();
  if (!q) return [];

  const prefix = [];
  const substring = [];
  for (const entry of (_artistIndex || [])) {
    const lower = entry.name.toLowerCase();
    if (lower.startsWith(q)) {
      prefix.push(entry);
    } else if (lower.includes(q)) {
      substring.push(entry);
    }
    if (prefix.length + substring.length >= limit * 4) break;
  }

  return [...prefix, ...substring]
    .slice(0, limit)
    .map(e => ({ name: e.name, count: e.totalWorks, source: 'tate' }));
}

/**
 * Return up to `count` search results for a keyword query without downloading images.
 * Uses the /api/v2/artworks/?search= endpoint; filters by aspect ratio using
 * master_images.height_ratio (same pre-download check as fetchRandomArtwork).
 *
 * @param {string} query
 * @param {object} [options]
 * @param {number} [options.count=12]
 * @param {'all'|'landscape'|'portrait'} [options.aspectRatio='all']
 * @returns {Promise<{ results: Array<{title,creator,thumbnailUrl,artworkUrl,source}>, totalAvailable: number }>}
 */
async function searchPreview(query, options = {}) {
  const { count = 12, aspectRatio = 'all' } = options;

  // Fetch extra candidates so aspect-ratio filtering doesn't leave us short.
  const fetchLimit = aspectRatio !== 'all' ? Math.min(count * 4, 100) : count;

  let response;
  try {
    response = await axios.get(`${BASE_URL}/artworks/`, {
      params: {
        search: query,
        masterImageStatus: 'CLEARED',
        limit: fetchLimit,
        fields: 'acno,title,allArtists,url,master_images',
      },
      timeout: 15000,
    });
  } catch (err) {
    throw new Error(`[tate] searchPreview failed: ${err.message}`);
  }

  const items = response.data.items || response.data.results || [];
  const totalAvailable = response.data.meta?.total_count ?? 0;

  const results = [];
  for (const obj of items) {
    if (results.length >= count) break;

    const imageInfo = extractImageInfo(obj.master_images);
    if (!imageInfo) continue;

    if (aspectRatio === 'landscape' && imageInfo.isPortrait) continue;
    if (aspectRatio === 'portrait' && !imageInfo.isPortrait) continue;

    // Use the smallest available size as the thumbnail.
    const img = Array.isArray(obj.master_images) ? obj.master_images[0] : obj.master_images;
    const sizes = img?.sizes;
    const thumbnailUrl = sizes?.[0]?.[2] || imageInfo.url;

    const artworkUrl = obj.url
      ? (obj.url.startsWith('http') ? obj.url : `https://www.tate.org.uk${obj.url}`)
      : null;

    results.push({
      title:        obj.title      || null,
      creator:      obj.allArtists || null,
      thumbnailUrl,
      artworkUrl,
      source: 'Tate',
    });
  }

  return { results, totalAvailable };
}

/**
 * Count cleared artworks in the Tate collection for a given artist name.
 * Resolves name → cisId, then queries the API with mltArtists={cisId}.
 *
 * @param {string} artistName
 * @returns {Promise<number|null>}
 */
async function countArtistArtworks(artistName) {
  try {
    const resolved = await resolveArtist(artistName);
    if (!resolved) return 0;
    return await fetchCount({ mltArtists: resolved.cisId });
  } catch {
    return null;
  }
}

/**
 * Returns true if this source can fetch the given identifier.
 * Accepts:
 *   - Tate artwork URLs: https://www.tate.org.uk/art/artworks/{slug}
 *   - Bare accession numbers: N00530, T16514, AR00153
 */
function canHandleIdentifier(identifier) {
  const t = identifier.trim();
  return /tate\.org\.uk\/art\/artworks\//i.test(t) || /^[A-Z]{1,2}\d{4,}$/i.test(t);
}

/**
 * Fetch a specific Tate artwork by URL or accession number.
 * Extracts the accession number from the URL slug (last hyphen-separated segment)
 * then queries ?acno= for the exact artwork.
 *
 * @param {string} identifier - Tate artwork URL or bare accession number
 * @param {object} [options]
 * @param {'all'|'landscape'|'portrait'} [options.tvOrientation]
 * @returns {{ imageBuffer, contentType, metadata }}
 */
async function fetchByIdentifier(identifier, options = {}) {
  const t = identifier.trim();
  let acno;

  // Extract accession number from URL slug: last hyphen-separated segment
  const urlMatch = t.match(/tate\.org\.uk\/art\/artworks\/[^/?#]*-([A-Za-z]{1,2}\d{4,})(?:[/?#]|$)/i);
  if (urlMatch) {
    acno = urlMatch[1].toUpperCase();
  } else {
    acno = t.toUpperCase();
  }

  let obj;
  try {
    const response = await axios.get(`${BASE_URL}/artworks/`, {
      params: { acno, fields: ARTWORK_FIELDS },
      timeout: 15000,
    });
    obj = (response.data.results || response.data.items)?.[0];
  } catch (err) {
    throw new Error(`Failed to fetch Tate artwork ${acno}: ${err.message}`);
  }

  if (!obj) throw new Error(`Tate artwork not found: ${acno}`);

  const imageInfo = extractImageInfo(obj.master_images);
  if (!imageInfo) throw new Error(`Tate artwork ${acno} has no accessible image`);

  let imageBuffer, contentType;
  try {
    const imageResponse = await axios.get(imageInfo.url, {
      responseType: 'arraybuffer',
      timeout: 30000,
    });
    imageBuffer = Buffer.from(imageResponse.data);
    contentType = imageResponse.headers['content-type'] || 'image/jpeg';
  } catch (err) {
    throw new Error(`Failed to download image for Tate artwork ${acno}: ${err.message}`);
  }

  const creatorLifespan = await resolveArtistLifespan(obj.contributors).catch(() => null);
  const artworkUrl = obj.url ? `https://www.tate.org.uk${obj.url}` : null;

  return {
    imageBuffer,
    contentType,
    metadata: {
      title:           obj.title                || null,
      creator:         obj.allArtists           || null,
      creatorLifespan: creatorLifespan          || null,
      medium:          obj.medium               || null,
      dateCreated:     obj.dateText             || null,
      dimensions:      obj.dimensions           || null,
      creditLine:      obj.creditLine           || null,
      gallery:         obj.display_gallery_name || null,
      artworkUrl,
      source: 'Tate',
    },
  };
}

/**
 * Examine the full merged filter set and determine the best API strategy.
 *
 * @param {Array<{type, mode, values}>} filters
 * @returns {{ mode: string, apiFilters: Array, postFilters: Array }}
 */
function selectMode(filters = []) {
  const hasArtist = filters.some(f => f.type === 'artist');
  const mode = hasArtist ? 'artist_search' : 'offset';
  return { mode, apiFilters: filters, postFilters: [] };
}

function getFilterTypes() {
  return [
    {
      type: 'media',
      label: 'Category',
      description: 'Restrict or exclude artworks by category.',
      modes: ['require', 'exclude'],
      multiValue: true,
      groups: [
        { name: 'Fine Art',      values: ['Paintings', 'Prints & Graphics', 'Works on Paper'] },
        { name: 'Other',         values: ['Sculpture', 'Installation'] },
      ],
      values: CLASSIFICATION_NAMES.map(name => ({ value: name, label: name })),
    },
    {
      type: 'onDisplay',
      label: 'Currently on Display',
      description: 'Restrict to artworks currently on display at a Tate gallery.',
      modes: ['require'],
      multiValue: false,
      values: [{ value: 'true', label: 'Yes' }],
    },
    {
      type: 'artist',
      label: 'Artist',
      description: 'Restrict to artworks by a specific artist.',
      modes: ['require'],
      multiValue: false,
      values: [],
      inputStyle: 'search',
    },
  ];
}

// Metadata fields this source can provide.
const metadataFields = [
  { key: 'title',           label: 'Title',          description: 'Artwork title' },
  { key: 'creator',         label: 'Creator',        description: 'Artist name(s)' },
  { key: 'creatorLifespan', label: 'Lifespan',       description: 'Artist lifespan (e.g. "born 1775, died 1851")' },
  { key: 'medium',          label: 'Medium',         description: 'Material or technique' },
  { key: 'dateCreated',     label: 'Date',           description: 'Human-readable date (e.g. "c.1850")' },
  { key: 'dimensions',      label: 'Dimensions',     description: 'Physical dimensions string' },
  { key: 'creditLine',      label: 'Credit Line',    description: 'Acquisition credit' },
  { key: 'gallery',         label: 'Gallery',        description: 'Gallery within Tate where the work is currently displayed (null if not on display)' },
  { key: 'institution',     label: 'Institution',    description: 'Specific Tate gallery (e.g. "Tate Britain", "Tate Modern"); falls back to "Tate" when not on display' },
  { key: 'artworkUrl',       label: 'Artwork URL',    description: 'Link to the artwork on Tate' },
  { key: 'source',          label: 'Source',         description: 'Always "Tate"' },
];

// Default mapping hints: source field key → suggested HA attribute name.
const defaultMapping = {
  title:           'title',
  creator:         { entity: 'creator', attribute: 'name' },
  creatorLifespan: 'creator_lifespan',
  medium:          'medium',
  dateCreated:     'date',
  dimensions:      null,
  creditLine:      null,
  gallery:         null,
  institution:     'museum',
  artworkUrl:      'artwork_url',
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
  searchPreview,
  CLASSIFICATION_NAMES,
  metadataFields,
  defaultMapping,
};
