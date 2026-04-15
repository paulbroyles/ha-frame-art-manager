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
  'id', 'title', 'artist_display', 'artist_title', 'date_display', 'medium_display',
  'dimensions', 'image_id', 'is_public_domain', 'department_title',
  'artwork_type_title', 'place_of_origin', 'description', 'credit_line',
  'style_title', 'style_titles',
].join(',');

// Search page size — max 100 per AIC API limits.
const PAGE_SIZE = 100;

// Pool cache TTL (24 hours).
const POOL_TTL_MS = 24 * 60 * 60 * 1000;

// Pool cache: key → { ids: number[], fetchedAt: number }
const poolCache = new Map();

// ── Data tables ────────────────────────────────────────────────────────────────

// Artwork type controlled vocabulary — public-domain counts (early 2026).
// Only display-friendly types exposed.
const ARTWORK_TYPES = [
  { value: 'Painting',               label: 'Paintings',              count: 1795  },
  { value: 'Print',                  label: 'Prints',                 count: 24189 },
  { value: 'Drawing and Watercolor', label: 'Drawings & Watercolors', count: 7567  },
  { value: 'Photograph',             label: 'Photographs',            count: 3778  },
  { value: 'Sculpture',              label: 'Sculpture',              count: 1324  },
  { value: 'Textile',                label: 'Textiles',               count: 5809  },
  { value: 'Ceramics',               label: 'Ceramics',               count: 2758  },
  { value: 'Miniature Painting',     label: 'Miniature Paintings',    count: 228   },
];

// AIC curatorial departments — public-domain image counts (early 2026).
const DEPARTMENTS = [
  { value: 'Prints and Drawings',                  label: 'Prints & Drawings',            count: 25062 },
  { value: 'Arts of Asia',                         label: 'Arts of Asia',                 count: 9718  },
  { value: 'Textiles',                             label: 'Textiles',                     count: 6903  },
  { value: 'Applied Arts of Europe',               label: 'Applied Arts of Europe',       count: 4981  },
  { value: 'Photography and Media',                label: 'Photography & Media',          count: 3776  },
  { value: 'Arts of the Americas',                 label: 'Arts of the Americas',         count: 2720  },
  { value: 'Arts of Greece, Rome, and Byzantium',  label: 'Greece, Rome & Byzantium',     count: 2029  },
  { value: 'Painting and Sculpture of Europe',     label: 'Painting & Sculpture (Europe)',count: 1988  },
  { value: 'Arts of Africa',                       label: 'Arts of Africa',               count: 1087  },
  { value: 'Architecture and Design',              label: 'Architecture & Design',        count: 276   },
  { value: 'Modern Art',                           label: 'Modern Art',                   count: 24    },
];

// Art movements/styles — counts are from style_titles array field (early 2026).
// Filtered against style_titles (all tagged styles, not just primary) for broader coverage.
const STYLES = [
  { value: 'Impressionism',     label: 'Impressionism',     count: 179 },
  { value: 'Renaissance',       label: 'Renaissance',       count: 165 },
  { value: 'Pictorialism',      label: 'Pictorialism',      count: 156 },
  { value: 'Folk Art',          label: 'Folk Art',          count: 127 },
  { value: 'Realism',           label: 'Realism',           count: 80  },
  { value: 'Post-Impressionism',label: 'Post-Impressionism',count: 76  },
  { value: 'Rococo',            label: 'Rococo',            count: 63  },
  { value: 'Modernism',         label: 'Modernism',         count: 58  },
  { value: 'Neoclassicism',     label: 'Neoclassicism',     count: 44  },
  { value: 'Baroque',           label: 'Baroque',           count: 34  },
  { value: 'Art Nouveau',       label: 'Art Nouveau',       count: 21  },
  { value: 'Barbizon School',   label: 'Barbizon School',   count: 19  },
  { value: 'Mannerism',         label: 'Mannerism',         count: 15  },
  { value: 'Flemish',           label: 'Flemish',           count: 6   },
  { value: 'Symbolism',         label: 'Symbolism',         count: 3   },
  { value: 'Pre-Raphaelite',    label: 'Pre-Raphaelite',    count: 2   },
  { value: 'Hudson River School',label:'Hudson River School',count: 2  },
];

// Date periods — mapped to date_start range queries.
// Counts based on artworks with date_start in range (early 2026).
const CENTURIES = [
  { value: 'ancient',      label: 'Ancient & Medieval (before 1400)', startYear: null, endYear: 1399, count: 6616  },
  { value: '15th century', label: '15th century (1400–1499)',          startYear: 1400, endYear: 1499, count: 1265  },
  { value: '16th century', label: '16th century (1500–1599)',          startYear: 1500, endYear: 1599, count: 4361  },
  { value: '17th century', label: '17th century (1600–1699)',          startYear: 1600, endYear: 1699, count: 6082  },
  { value: '18th century', label: '18th century (1700–1799)',          startYear: 1700, endYear: 1799, count: 12356 },
  { value: '19th century', label: '19th century (1800–1899)',          startYear: 1800, endYear: 1899, count: 25316 },
  { value: '20th century', label: '20th century (1900–1999)',          startYear: 1900, endYear: 1999, count: 2328  },
];

// Place of origin — AIC stores as lowercase strings.
// Displayed with capitalized labels; values match place_of_origin.keyword exactly.
const PLACES = [
  { value: 'france',        label: 'France',         count: 11019 },
  { value: 'japan',         label: 'Japan',          count: 7556  },
  { value: 'england',       label: 'England',        count: 5940  },
  { value: 'united states', label: 'United States',  count: 4960  },
  { value: 'italy',         label: 'Italy',          count: 4584  },
  { value: 'germany',       label: 'Germany',        count: 2330  },
  { value: 'china',         label: 'China',          count: 2242  },
  { value: 'netherlands',   label: 'Netherlands',    count: 1686  },
  { value: 'egypt',         label: 'Egypt',          count: 1216  },
  { value: 'flanders',      label: 'Flanders',       count: 978   },
  { value: 'holland',       label: 'Holland',        count: 833   },
  { value: 'peru',          label: 'Peru',           count: 786   },
  { value: 'spain',         label: 'Spain',          count: 647   },
  { value: 'sweden',        label: 'Sweden',         count: 531   },
  { value: 'scotland',      label: 'Scotland',       count: 428   },
  { value: 'mexico',        label: 'Mexico',         count: 367   },
  { value: 'india',         label: 'India',          count: 272   },
  { value: 'turkey',        label: 'Turkey',         count: 255   },
  { value: 'greece',        label: 'Greece',         count: 242   },
  { value: 'iran',          label: 'Iran',           count: 234   },
];

const DEPARTMENT_GROUPS = [
  { name: 'Fine Art',  values: ['Painting and Sculpture of Europe', 'Prints and Drawings', 'Photography and Media', 'Modern Art'] },
  { name: 'Decorative', values: ['Applied Arts of Europe', 'Textiles', 'Architecture and Design'] },
  { name: 'World',     values: ['Arts of Asia', 'Arts of the Americas', 'Arts of Greece, Rome, and Byzantium', 'Arts of Africa'] },
];

const STYLE_GROUPS = [
  { name: 'Renaissance & Early Modern', values: ['Renaissance', 'Mannerism', 'Baroque', 'Flemish', 'Rococo'] },
  { name: '19th Century',               values: ['Neoclassicism', 'Romanticism', 'Realism', 'Barbizon School', 'Hudson River School', 'Pre-Raphaelite', 'Impressionism', 'Post-Impressionism', 'Symbolism', 'Art Nouveau', 'Pictorialism'] },
  { name: 'Other',                      values: ['Folk Art', 'Modernism'] },
];

const CENTURY_GROUPS = [
  { name: 'Pre-Modern',  values: ['ancient', '15th century', '16th century'] },
  { name: 'Early Modern',values: ['17th century', '18th century'] },
  { name: 'Modern',      values: ['19th century', '20th century'] },
];

// ── Filter helpers ─────────────────────────────────────────────────────────────

function getFilterValues(filters, type, mode) {
  return filters
    .filter(f => f.type === type && f.mode === mode)
    .flatMap(f => f.values || []);
}

// ── Pool cache helpers ─────────────────────────────────────────────────────────

function poolCacheKey(filters) {
  const parts = [];
  for (const ft of ['type', 'department', 'style', 'century', 'place', 'artist']) {
    const req = getFilterValues(filters, ft, 'require').slice().sort();
    const exc = getFilterValues(filters, ft, 'exclude').slice().sort();
    if (req.length) parts.push(`${ft}+${req.join(',')}`);
    if (exc.length) parts.push(`${ft}-${exc.join(',')}`);
  }
  return parts.length ? parts.join('|') : 'all';
}

/**
 * Build the Elasticsearch bool clause for the given filters.
 * Always includes `is_public_domain: true` and `exists: image_id`.
 * Returns { filter: [], must_not: [] } suitable for use as a bool query body.
 */
function buildEsFilter(filters) {
  const filter  = [
    { term: { is_public_domain: true } },
    { exists: { field: 'image_id' } },
  ];
  const mustNot = [];

  // Artwork type
  const typeReq = getFilterValues(filters, 'type', 'require');
  const typeExc = getFilterValues(filters, 'type', 'exclude');
  if (typeReq.length === 1) filter.push({ term: { 'artwork_type_title.keyword': typeReq[0] } });
  else if (typeReq.length > 1) filter.push({ terms: { 'artwork_type_title.keyword': typeReq } });
  for (const v of typeExc) mustNot.push({ term: { 'artwork_type_title.keyword': v } });

  // Department
  const deptReq = getFilterValues(filters, 'department', 'require');
  const deptExc = getFilterValues(filters, 'department', 'exclude');
  if (deptReq.length === 1) filter.push({ term: { 'department_title.keyword': deptReq[0] } });
  else if (deptReq.length > 1) filter.push({ terms: { 'department_title.keyword': deptReq } });
  for (const v of deptExc) mustNot.push({ term: { 'department_title.keyword': v } });

  // Style — matches against style_titles array field for broader coverage than style_title (primary only).
  // Multiple require values → OR (any of the styles).
  const styleReq = getFilterValues(filters, 'style', 'require');
  const styleExc = getFilterValues(filters, 'style', 'exclude');
  if (styleReq.length === 1) {
    filter.push({ term: { 'style_titles.keyword': styleReq[0] } });
  } else if (styleReq.length > 1) {
    filter.push({ bool: {
      should: styleReq.map(v => ({ term: { 'style_titles.keyword': v } })),
      minimum_should_match: 1,
    }});
  }
  for (const v of styleExc) mustNot.push({ term: { 'style_titles.keyword': v } });

  // Century — date_start range. Multiple require values → OR.
  const centuryReq = getFilterValues(filters, 'century', 'require');
  const centuryExc = getFilterValues(filters, 'century', 'exclude');
  if (centuryReq.length > 0) {
    const ranges = centuryReq.map(v => CENTURIES.find(c => c.value === v)).filter(Boolean);
    const toRange = r => {
      const rc = {};
      if (r.startYear !== null) rc.gte = r.startYear;
      if (r.endYear   !== null) rc.lte = r.endYear;
      return { range: { date_start: rc } };
    };
    if (ranges.length === 1) {
      filter.push(toRange(ranges[0]));
    } else {
      filter.push({ bool: { should: ranges.map(toRange), minimum_should_match: 1 } });
    }
  }
  for (const v of centuryExc) {
    const r = CENTURIES.find(c => c.value === v);
    if (r) {
      const rc = {};
      if (r.startYear !== null) rc.gte = r.startYear;
      if (r.endYear   !== null) rc.lte = r.endYear;
      mustNot.push({ range: { date_start: rc } });
    }
  }

  // Place of origin
  const placeReq = getFilterValues(filters, 'place', 'require');
  const placeExc = getFilterValues(filters, 'place', 'exclude');
  if (placeReq.length === 1) filter.push({ term: { 'place_of_origin.keyword': placeReq[0] } });
  else if (placeReq.length > 1) filter.push({ terms: { 'place_of_origin.keyword': placeReq } });
  for (const v of placeExc) mustNot.push({ term: { 'place_of_origin.keyword': v } });

  // Artist (exact artist_title match; populated via suggestArtists)
  const artistReq = getFilterValues(filters, 'artist', 'require');
  if (artistReq.length === 1) filter.push({ term: { 'artist_title.keyword': artistReq[0] } });
  else if (artistReq.length > 1) filter.push({ terms: { 'artist_title.keyword': artistReq } });

  return { filter, must_not: mustNot };
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
      query: { bool: buildEsFilter(filters) },
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
  const boolClause = buildEsFilter(filters);
  const total = await getFilterTotal(boolClause);
  const from  = Math.floor(Math.random() * Math.min(total, 1000));

  const body = {
    query: { bool: boolClause },
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

async function getFilterTotal(boolClause) {
  const body = { query: { bool: boolClause }, size: 0, _source: false };
  const response = await axios.post(`${API_BASE}/artworks/search`, body, {
    headers: { ...HEADERS, 'Content-Type': 'application/json' },
    timeout: 10000,
  });
  return response.data.pagination?.total ?? 0;
}

/**
 * Pick a random artwork ID using a full-text keyword search.
 * Not pooled — arbitrary queries are too numerous to pre-cache.
 * Capped at the first 1000 results (AIC's `from` limit).
 *
 * IMPORTANT: uses simple_query_string in the `must` clause (not the `q` URL
 * parameter). When `q` is combined with sort-by-id, Elasticsearch treats it as
 * a scorer only — all documents pass regardless of whether they match. Putting
 * the term in `must` makes it a true filter that participates in scoring AND
 * excludes non-matching documents even when sorting by a non-score field.
 */
async function pickRandomSearchId(filters, keyword) {
  const boolClause = buildEsFilter(filters);
  boolClause.must = [{
    simple_query_string: {
      query:            keyword,
      fields:           ['title^3', 'artist_display^2', 'description', 'subject_titles', 'medium_display'],
      default_operator: 'AND',
    },
  }];

  // Get total matching count.
  const countBody = { query: { bool: boolClause }, size: 0, _source: false };
  const countResp = await axios.post(`${API_BASE}/artworks/search`, countBody, {
    headers: { ...HEADERS, 'Content-Type': 'application/json' },
    timeout: 10000,
  });
  const total = countResp.data.pagination?.total ?? 0;
  if (total === 0) throw new Error(`[aic] No artworks found for "${keyword}"`);

  const from = Math.floor(Math.random() * Math.min(total, 1000));
  const body = {
    query: { bool: boolClause },
    from,
    size: 1,
    sort: [{ id: { order: 'asc' } }],
    fields: ['id'],
    _source: false,
  };
  const resp = await axios.post(`${API_BASE}/artworks/search`, body, {
    headers: { ...HEADERS, 'Content-Type': 'application/json' },
    timeout: 10000,
  });
  const obj = resp.data.data?.[0];
  if (!obj) throw new Error(`[aic] No artworks found for "${keyword}"`);
  return obj.id;
}

// ── Image fetching ─────────────────────────────────────────────────────────────

/**
 * Build a IIIF bounding-box URL for the given image_id at the target orientation.
 * Fetches info.json first to get native dimensions for an accurate bounding box.
 *
 * Returns { url, nativeW, nativeH } so the caller can prescreen aspect ratio
 * before committing to a full image download.
 */
async function buildImageUrl(imageId, orientation) {
  let nativeW, nativeH;
  try {
    const info = await axios.get(`${IIIF_BASE}/${imageId}/info.json`, {
      headers: HEADERS, timeout: 8000,
    });
    nativeW = info.data.width;
    nativeH = info.data.height;
  } catch {
    nativeW = null;
    nativeH = null;
  }

  const bbox = iiifBoundingBox(orientation, nativeW, nativeH);
  return { url: `${IIIF_BASE}/${imageId}/full/!${bbox}/0/default.jpg`, nativeW, nativeH };
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
  const keyword = getFilterValues(filters, 'search', 'require')[0] || null;

  const MAX_CANDIDATES = 10;

  for (let attempt = 0; attempt < MAX_CANDIDATES; attempt++) {
    const id = keyword
      ? await pickRandomSearchId(filters, keyword)
      : await pickRandomId(filters);

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

    const { url: imageUrl, nativeW, nativeH } = await buildImageUrl(obj.image_id, orientation);

    // Prescreen aspect ratio using info.json dimensions (already fetched above, no extra cost).
    if (aspectRatio !== 'all' && nativeW && nativeH) {
      if (aspectRatio === 'landscape' && nativeW < nativeH) {
        console.warn(`[aic] ${id} prescreened out: not landscape (${nativeW}x${nativeH})`);
        continue;
      }
      if (aspectRatio === 'portrait' && nativeW > nativeH) {
        console.warn(`[aic] ${id} prescreened out: not portrait (${nativeW}x${nativeH})`);
        continue;
      }
    }

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

    // Post-download aspect ratio safety check (catches info.json failures where nativeW/nativeH were null).
    if (aspectRatio !== 'all' && !(nativeW && nativeH)) {
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

  const { url: imageUrl } = await buildImageUrl(obj.image_id, orientation);
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
    title:       obj.title         || null,
    creator:     creatorName,
    creatorBio,
    dateCreated: obj.date_display  || null,
    medium:      obj.medium_display || null,
    dimensions:  obj.dimensions    || null,
    style:       obj.style_title   || null,
    department:  obj.department_title || null,
    description: obj.description ? stripHtml(obj.description) : null,
    creditLine:  obj.credit_line   || null,
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
    {
      type:        'department',
      label:       'Department',
      description: 'Restrict or exclude by AIC curatorial department.',
      modes:       ['require', 'exclude'],
      multiValue:  true,
      groups:      DEPARTMENT_GROUPS,
      values:      DEPARTMENTS.map(({ value, label, count }) => ({ value, label, count })),
    },
    {
      type:        'style',
      label:       'Art Movement / Style',
      description: 'Restrict or exclude by art movement or style. Matches any tagged style, not just the primary one.',
      modes:       ['require', 'exclude'],
      multiValue:  true,
      groups:      STYLE_GROUPS,
      values:      STYLES.map(({ value, label, count }) => ({ value, label, count })),
    },
    {
      type:        'century',
      label:       'Period',
      description: 'Restrict or exclude by creation date period (based on date_start year).',
      modes:       ['require', 'exclude'],
      multiValue:  true,
      groups:      CENTURY_GROUPS,
      values:      CENTURIES.map(({ value, label, count }) => ({ value, label, count })),
    },
    {
      type:        'place',
      label:       'Place of Origin',
      description: 'Restrict or exclude by country or region of origin.',
      modes:       ['require', 'exclude'],
      multiValue:  true,
      values:      PLACES.map(({ value, label, count }) => ({ value, label, count })),
    },
    {
      type:        'artist',
      label:       'Artist',
      description: 'Filter by artist name (exact match from AIC records).',
      modes:       ['require'],
      multiValue:  false,
      values:      [],
      inputStyle:  'search',
    },
    {
      type:        'search',
      label:       'Search',
      description: 'Search by title, artist, subject, medium, or style keywords.',
      modes:       ['require'],
      multiValue:  false,
      values:      [],
      inputStyle:  'search',
    },
  ];
}

// ── suggestArtists ─────────────────────────────────────────────────────────────

async function suggestArtists(query, options = {}) {
  const { count = 10 } = options;

  const response = await axios.get(`${API_BASE}/agents/search`, {
    params: { q: query, limit: count * 2, fields: 'id,title,birth_date,death_date' },
    headers: HEADERS,
    timeout: 10000,
  });

  const agents = response.data.data || [];
  return agents
    .filter(a => a.title && !/^(museum|collection|gallery|trust|foundation|estate|institute|school of)/i.test(a.title))
    .slice(0, count)
    .map(a => ({
      name: a.title,
      description: [a.birth_date, a.death_date].filter(Boolean).join('–') || null,
      source: 'aic',
    }));
}

async function countArtistArtworks(artistName, options = {}) {
  const body = {
    query: { bool: { filter: [
      { term: { is_public_domain: true } },
      { exists: { field: 'image_id' } },
      { term: { 'artist_title.keyword': artistName } },
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
  { key: 'style',       label: 'Style',       description: 'Primary art movement or style' },
  { key: 'department',  label: 'Department',  description: 'AIC curatorial department' },
  { key: 'creditLine',  label: 'Credit Line', description: 'Acquisition or gift credit' },
  { key: 'description', label: 'Description', description: 'Curatorial description' },
  { key: 'artworkUrl',  label: 'Artwork URL',  description: 'Link to the artwork on Art Institute of Chicago' },
  { key: 'source',      label: 'Source',      description: 'Always "Art Institute of Chicago"' },
];

const defaultMapping = {
  title:       'title',
  creator:     { entity: 'creator', attribute: 'name' },
  creatorBio:  'creator_nationality',
  dateCreated: 'date',
  medium:      'medium',
  dimensions:  'dimensions',
  style:       null,
  department:  null,
  creditLine:  'credit_line',
  description: 'description',
  artworkUrl:  'artwork_url',
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
