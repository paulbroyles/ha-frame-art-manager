'use strict';
const axios = require('axios');

// National Gallery of Art — Washington, D.C.
// Open data: https://github.com/NationalGalleryOfArt/opendata
//
// Two CSVs are downloaded and joined in memory (24h TTL cache):
//   objects.csv         — title, attribution, classification, subclassification, medium,
//                         dimensions, date, credit line, timespan
//   published_images.csv — IIIF service URL, native dimensions, openaccess flag, viewtype
//
// Images are served via IIIF at up to native resolution (typically 3000–4500px).
// Artwork page URL: https://www.nga.gov/collection/art-object-page.{objectid}.html

const OBJECTS_CSV_URL = 'https://raw.githubusercontent.com/NationalGalleryOfArt/opendata/main/data/objects.csv';
const IMAGES_CSV_URL  = 'https://raw.githubusercontent.com/NationalGalleryOfArt/opendata/main/data/published_images.csv';

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// User-visible classification values for the objectType filter.
// Matched case-insensitively against objects.csv `classification`.
const CLASSIFICATION_TYPES = [
  'Painting',
  'Drawing',
  'Print',
  'Photograph',
  'Sculpture',
  'Decorative Art',
  'Textile/Fashion',
  'Portfolio',
];

// Default time period values shown before the cache loads.
// Replaced by discovered values from visualbrowsertimespan once the cache is built.
// These match the NGA's standard Browse-by-Date buckets.
const PERIOD_DEFAULTS = [
  '1 to 500',
  '500 to 1000',
  '1000 to 1400',
  '1400 to 1500',
  '1500 to 1600',
  '1600 to 1700',
  '1700 to 1800',
  '1800 to 1850',
  '1850 to 1900',
  '1900 to 1950',
  '1950 to 2000',
  '2000 to present',
];

// Module-level store for filter values discovered when the cache loads.
// getFilterTypes() reads from here so the route always returns up-to-date values.
const _discoveredValues = {
  timePeriod:      PERIOD_DEFAULTS.map(v => ({ value: v, label: v })),
  subclassification: [],
};

// ── CSV parser ────────────────────────────────────────────────────────────────

// Columns we actually need from each CSV.
// Keeping this list tight is critical: objects.csv has 27 columns including
// provenancetext, inscription, markings, etc. that can be very long — parsing
// all of them exhausts the container's heap.
const OBJECT_COLS = [
  'objectid', 'title', 'attribution', 'classification', 'subclassification',
  'medium', 'dimensions', 'displaydate', 'creditline', 'visualbrowsertimespan', 'isvirtual',
];
const IMAGE_COLS = [
  'iiifurl', 'viewtype', 'width', 'height', 'openaccess', 'depictstmsobjectid',
];

/**
 * Parse the header row and return a Map<columnIndex → fieldName> for only the
 * columns listed in desiredCols, plus the highest needed index.
 */
function buildColIndex(headerLine, desiredCols) {
  const headers = headerLine.split(',').map(h => h.replace(/^"|"$/g, '').trim());
  const idxToCol = new Map();
  for (const col of desiredCols) {
    const idx = headers.indexOf(col);
    if (idx !== -1) idxToCol.set(idx, col);
  }
  const maxIdx = idxToCol.size ? Math.max(...idxToCol.keys()) : -1;
  return { idxToCol, maxIdx };
}

/**
 * Parse one CSV data line, extracting only the columns in idxToCol.
 * Stops parsing as soon as maxIdx is passed to avoid processing long trailing fields
 * (e.g. provenancetext that can be thousands of characters).
 */
function parseLine(line, idxToCol, maxIdx) {
  const result = {};
  let field = '';
  let inQuotes = false;
  let colIdx = 0;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') { inQuotes = false; }
      else { field += ch; }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        if (idxToCol.has(colIdx)) result[idxToCol.get(colIdx)] = field;
        field = '';
        colIdx++;
        if (colIdx > maxIdx) break; // all needed columns collected — stop early
      } else {
        field += ch;
      }
    }
  }
  if (colIdx <= maxIdx && idxToCol.has(colIdx)) result[idxToCol.get(colIdx)] = field;
  return result;
}

/**
 * Parse a CSV text string, extracting only desiredCols from each row.
 * Much more memory-efficient than full parsing: avoids allocating per-row arrays
 * and stops parsing each line once the last needed column is reached.
 *
 * @param {string} text
 * @param {string[]} desiredCols
 * @returns {Object[]}
 */
function parseCsvSelective(text, desiredCols) {
  const nl = text.indexOf('\n');
  if (nl === -1) return [];
  const { idxToCol, maxIdx } = buildColIndex(text.slice(0, nl), desiredCols);
  if (maxIdx === -1) return [];

  const rows = [];
  let pos = nl + 1;
  while (pos < text.length) {
    let end = text.indexOf('\n', pos);
    if (end === -1) end = text.length;
    const line = text.slice(pos, end).trimEnd();
    if (line) rows.push(parseLine(line, idxToCol, maxIdx));
    pos = end + 1;
  }
  return rows;
}

// ── In-memory cache ───────────────────────────────────────────────────────────

let _cache = null;          // Array of joined record objects
let _cacheBuiltAt = null;   // Timestamp when cache was last built
let _cachePromise = null;   // In-flight build promise (prevents duplicate fetches)

/**
 * Download, parse, and join the NGA CSVs into a single array of records.
 * Only includes open-access images with 'primary' or 'front' viewtype from non-virtual objects.
 * Also populates _discoveredValues for dynamic filter type generation.
 *
 * @returns {Promise<Array>}
 */
async function buildCache() {
  console.log('[nga] Downloading NGA objects CSV...');

  // Download sequentially so we never hold both large CSV texts in memory at once.
  // objects.csv can be 50–80 MB (provenancetext etc.); parallel download doubles peak usage.
  const objectsResp = await axios.get(OBJECTS_CSV_URL, { responseType: 'text', timeout: 60000 });

  // Parse only the columns we need; stop each line at the last needed column index
  // to avoid allocating memory for long trailing fields (provenancetext, markings, etc.)
  const objectMap = new Map();
  for (const obj of parseCsvSelective(objectsResp.data, OBJECT_COLS)) {
    if (obj.objectid && obj.isvirtual !== '1') {
      objectMap.set(obj.objectid, obj);
    }
  }
  console.log(`[nga] Loaded ${objectMap.size} objects`);

  // Release the objects CSV text before downloading the images CSV
  objectsResp.data = null;

  console.log('[nga] Downloading NGA images CSV...');
  const imagesResp = await axios.get(IMAGES_CSV_URL, { responseType: 'text', timeout: 60000 });

  // Join: open-access images with primary/front viewtype
  const records = [];
  for (const img of parseCsvSelective(imagesResp.data, IMAGE_COLS)) {
    if (img.openaccess !== '1') continue;
    const vt = (img.viewtype || '').toLowerCase();
    if (vt && vt !== 'primary' && vt !== 'front') continue;
    if (!img.iiifurl || !img.depictstmsobjectid) continue;

    const obj = objectMap.get(img.depictstmsobjectid);
    if (!obj) continue;

    records.push({
      objectId:          obj.objectid,
      title:             obj.title                || null,
      attribution:       obj.attribution          || null,
      classification:    obj.classification       || null,
      subclassification: obj.subclassification    || null,
      medium:            obj.medium               || null,
      dimensions:        obj.dimensions           || null,
      displaydate:       obj.displaydate          || null,
      creditline:        obj.creditline           || null,
      timePeriod:        obj.visualbrowsertimespan || null,
      iiifUrl:           img.iiifurl.replace(/\/$/, ''), // strip trailing slash
      width:             parseInt(img.width,  10) || 0,
      height:            parseInt(img.height, 10) || 0,
    });
  }

  console.log(`[nga] Cache built: ${records.length} eligible records`);

  // Discover unique timePeriod and subclassification values for dynamic filter types.
  // Sort timePeriod by numeric start year; subclassification alphabetically.
  const periodSet = new Set();
  const subclassSet = new Set();
  for (const r of records) {
    if (r.timePeriod) periodSet.add(r.timePeriod);
    if (r.subclassification) subclassSet.add(r.subclassification);
  }

  const sortedPeriods = [...periodSet].sort((a, b) => {
    const numA = parseInt(a, 10) || 0;
    const numB = parseInt(b, 10) || 0;
    return numA - numB;
  });
  const sortedSubclasses = [...subclassSet].sort();

  _discoveredValues.timePeriod      = sortedPeriods.map(v => ({ value: v, label: v }));
  _discoveredValues.subclassification = sortedSubclasses.map(v => ({ value: v, label: v }));

  console.log(`[nga] Discovered ${sortedPeriods.length} time periods, ${sortedSubclasses.length} subclassifications`);

  return records;
}

/**
 * Return the cache, building it if absent or expired.
 * Concurrent callers share the in-flight promise.
 */
async function getCache() {
  const now = Date.now();
  if (_cache && _cacheBuiltAt && (now - _cacheBuiltAt) < CACHE_TTL_MS) {
    return _cache;
  }
  if (!_cachePromise) {
    _cachePromise = buildCache().then(records => {
      _cache = records;
      _cacheBuiltAt = Date.now();
      _cachePromise = null;
      return records;
    }).catch(err => {
      _cachePromise = null;
      throw err;
    });
  }
  return _cachePromise;
}

// ── Filter helpers ────────────────────────────────────────────────────────────

/**
 * Resolve objectType filters into a Set of eligible lowercase classification names,
 * or null if no type filter is active.
 * Throws if require filters leave nothing eligible.
 */
function resolveTypeFilter(filters) {
  const requireSets = filters
    .filter(f => f.type === 'objectType' && f.mode === 'require')
    .map(f => new Set((f.values || []).map(v => v.toLowerCase())));
  const excludeValues = new Set(
    filters
      .filter(f => f.type === 'objectType' && f.mode === 'exclude')
      .flatMap(f => f.values || [])
      .map(v => v.toLowerCase())
  );

  if (requireSets.length === 0 && excludeValues.size === 0) return null;

  let eligible = CLASSIFICATION_TYPES;
  if (requireSets.length > 0) {
    eligible = eligible.filter(n => requireSets.every(s => s.has(n.toLowerCase())));
  }
  if (excludeValues.size > 0) {
    eligible = eligible.filter(n => !excludeValues.has(n.toLowerCase()));
  }
  if (requireSets.length > 0 && eligible.length === 0) {
    throw new Error('No object types eligible after applying filters');
  }
  return new Set(eligible.map(n => n.toLowerCase()));
}

/**
 * Apply a simple enum filter against a record field.
 * Values are matched case-insensitively.
 * Multiple require filters intersect; exclude filters union.
 * Returns a filtered copy of pool, or pool unchanged if no filter is active.
 *
 * @param {Array} pool
 * @param {Array} filters
 * @param {string} filterType  - filter.type to look for
 * @param {string} recordField - key on each record to compare against
 * @returns {Array}
 */
function applyEnumFilter(pool, filters, filterType, recordField) {
  const requireSets = filters
    .filter(f => f.type === filterType && f.mode === 'require')
    .map(f => new Set((f.values || []).map(v => v.toLowerCase())));
  const excludeValues = new Set(
    filters
      .filter(f => f.type === filterType && f.mode === 'exclude')
      .flatMap(f => f.values || [])
      .map(v => v.toLowerCase())
  );

  if (requireSets.length === 0 && excludeValues.size === 0) return pool;

  return pool.filter(r => {
    const val = r[recordField];
    const norm = val ? val.toLowerCase() : null;
    if (requireSets.length > 0) {
      if (!norm || !requireSets.every(s => s.has(norm))) return false;
    }
    if (excludeValues.size > 0) {
      if (norm && excludeValues.has(norm)) return false;
    }
    return true;
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Fetch a random artwork from the National Gallery of Art open-access collection.
 *
 * Loads the NGA CSV data into a 24h in-memory cache on first call.
 * All filters are applied in-memory before random selection.
 * Aspect ratio is pre-filtered using native image dimensions from the CSV.
 * Images are downloaded via IIIF at up to 4800px.
 *
 * @param {Array<{type, mode, values}>} [filters=[]]
 *   Supported types: 'objectType', 'subclassification', 'timePeriod', 'artist', 'search'
 * @param {{ aspectRatio?: 'all'|'landscape'|'portrait' }} [options={}]
 */
async function fetchRandomArtwork(filters = [], options = {}) {
  const { aspectRatio = 'all' } = options;

  const records = await getCache();

  // Artist filter
  const artistFilter = filters.find(f => f.type === 'artist' && f.mode === 'require');
  const artistName = (artistFilter?.values?.[0] || '').trim();

  // Keyword search filter
  const searchFilter = filters.find(f => f.type === 'search' && f.mode === 'require');
  const searchTerm = (searchFilter?.values?.[0] || '').toLowerCase().trim();

  // Classification filter
  const eligibleTypes = resolveTypeFilter(filters);

  // Build the eligible pool
  let pool = records;

  if (artistName) {
    const nameLower = artistName.toLowerCase();
    pool = pool.filter(r => r.attribution && r.attribution.toLowerCase().includes(nameLower));
    if (pool.length === 0) {
      throw new Error(`No NGA artworks found for artist "${artistName}"`);
    }
  }

  if (searchTerm) {
    pool = pool.filter(r =>
      (r.title       && r.title.toLowerCase().includes(searchTerm)) ||
      (r.attribution && r.attribution.toLowerCase().includes(searchTerm))
    );
  }

  if (eligibleTypes !== null) {
    pool = pool.filter(r => r.classification && eligibleTypes.has(r.classification.toLowerCase()));
  }

  pool = applyEnumFilter(pool, filters, 'subclassification', 'subclassification');
  pool = applyEnumFilter(pool, filters, 'timePeriod', 'timePeriod');

  console.log(`[nga] pool size after filters: ${pool.length} (filters: ${JSON.stringify(filters)}, aspectRatio: ${aspectRatio})`);

  if (aspectRatio !== 'all') {
    pool = pool.filter(r => {
      if (!r.width || !r.height) return true; // dimensions unknown; include
      const isLandscape = r.width > r.height;
      if (aspectRatio === 'landscape') return isLandscape;
      if (aspectRatio === 'portrait') return !isLandscape;
      return true;
    });
  }

  if (pool.length === 0) {
    throw new Error('No NGA artworks match the selected filters');
  }

  // Pick a random record and download its image
  const MAX_ATTEMPTS = 10;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const idx = Math.floor(Math.random() * pool.length);
    const record = pool[idx];

    console.log(`[nga] attempt ${attempt + 1}: idx=${idx} objectId=${record.objectId} attribution="${record.attribution}" classification="${record.classification}"`);

    const imageUrl = `${record.iiifUrl}/full/!4800,4800/0/default.jpg`;
    let imageBuffer;
    try {
      const imgResp = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 45000 });
      imageBuffer = Buffer.from(imgResp.data);
    } catch (e) {
      console.warn(`[nga] Failed to download image for object ${record.objectId}: ${e.message}`);
      continue;
    }

    console.log(`[nga] success: objectId=${record.objectId} attribution="${record.attribution}"`);
    return {
      imageBuffer,
      contentType: 'image/jpeg',
      metadata: buildMetadata(record),
    };
  }

  throw new Error(`Could not download a NGA artwork image after ${MAX_ATTEMPTS} attempts`);
}

/**
 * Build the metadata object from a cached record.
 */
function buildMetadata(record) {
  return {
    title:       record.title       || null,
    creator:     record.attribution || null,
    medium:      record.medium      || null,
    dateCreated: record.displaydate || null,
    dimensions:  record.dimensions  || null,
    creditLine:  record.creditline  || null,
    artworkUrl:  `https://www.nga.gov/collection/art-object-page.${record.objectId}.html`,
    source:      'National Gallery of Art',
  };
}

/**
 * Returns true if this source can handle the given identifier.
 * Accepts NGA artwork page URLs and bare numeric object IDs.
 */
function canHandleIdentifier(identifier) {
  const t = identifier.trim();
  return /nga\.gov\/collection\/art-object-page\.(\d+)\.html/i.test(t) || /^\d+$/.test(t);
}

/**
 * Fetch a specific artwork by NGA object ID or artwork page URL.
 * Uses the cache to look up metadata; downloads image via IIIF.
 *
 * @param {string} identifier - NGA artwork URL or bare object ID
 * @param {{ aspectRatio?: string }} [options={}]
 */
async function fetchByIdentifier(identifier, options = {}) {
  const t = identifier.trim();
  const urlMatch = t.match(/nga\.gov\/collection\/art-object-page\.(\d+)\.html/i);
  const objectId = urlMatch ? urlMatch[1] : t;

  const records = await getCache();
  const record = records.find(r => r.objectId === objectId);
  if (!record) {
    throw new Error(`NGA object ${objectId} not found in open-access collection`);
  }

  const { aspectRatio = 'all' } = options;
  if (aspectRatio !== 'all' && record.width && record.height) {
    const isLandscape = record.width > record.height;
    if (aspectRatio === 'landscape' && !isLandscape) {
      throw new Error(`Object ${objectId} is portrait; landscape filter cannot be satisfied`);
    }
    if (aspectRatio === 'portrait' && isLandscape) {
      throw new Error(`Object ${objectId} is landscape; portrait filter cannot be satisfied`);
    }
  }

  const imageUrl = `${record.iiifUrl}/full/!4800,4800/0/default.jpg`;
  let imageBuffer;
  try {
    const imgResp = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 45000 });
    imageBuffer = Buffer.from(imgResp.data);
  } catch (e) {
    throw new Error(`Failed to download image for NGA object ${objectId}: ${e.message}`);
  }

  return {
    imageBuffer,
    contentType: 'image/jpeg',
    metadata: buildMetadata(record),
  };
}

/**
 * Suggest NGA artist names matching the query string.
 * Searches unique attribution values from the cached data.
 * Returns the top matches sorted by artwork count.
 *
 * @param {string} query
 * @param {number} [limit=10]
 * @returns {Promise<Array<{name, count, source}>>}
 */
async function suggestArtists(query, limit = 10) {
  const q = (query || '').toLowerCase().trim();
  if (!q) return [];

  let records;
  try {
    records = await getCache();
  } catch {
    return [];
  }

  const counts = new Map();
  for (const r of records) {
    if (!r.attribution) continue;
    counts.set(r.attribution, (counts.get(r.attribution) || 0) + 1);
  }

  const results = [];
  for (const [name, count] of counts) {
    if (name.toLowerCase().includes(q)) {
      results.push({ name, count, source: 'nga' });
    }
  }
  results.sort((a, b) => b.count - a.count);
  return results.slice(0, limit);
}

/**
 * Count artworks in the NGA open-access collection for a given artist name.
 * Returns null on cache failure.
 *
 * @param {string} artistName
 * @returns {Promise<number|null>}
 */
async function countArtistArtworks(artistName) {
  const q = (artistName || '').toLowerCase().trim();
  if (!q) return null;

  let records;
  try {
    records = await getCache();
  } catch {
    return null;
  }

  return records.filter(r => r.attribution && r.attribution.toLowerCase().includes(q)).length;
}

/**
 * Returns the API strategy for the given filter set.
 * NGA uses in-memory filtering against the CSV cache — no server-side query modes.
 */
function selectMode(filters = []) {
  return {
    mode: 'cache_filter',
    apiFilters: [],
    postFilters: filters,
  };
}

/**
 * Returns filter type definitions for the NGA source.
 * timePeriod and subclassification values are populated from the cache once it loads;
 * timePeriod falls back to PERIOD_DEFAULTS before the cache is ready.
 *
 * This function is called dynamically (not cached at startup) so discovered values
 * are always served to the UI.
 */
function getFilterTypes() {
  return [
    {
      type: 'objectType',
      label: 'Object Type',
      description: 'Filter by broad artwork classification (e.g. Painting, Print, Sculpture).',
      modes: ['require', 'exclude'],
      multiValue: true,
      modeDetermining: false,
      values: CLASSIFICATION_TYPES.map(name => ({ value: name, label: name })),
    },
    {
      type: 'subclassification',
      label: 'Sub-type',
      description: 'Filter by specific medium or technique within a classification (e.g. etching, lithograph, oil, daguerreotype). Values are discovered from the collection.',
      modes: ['require', 'exclude'],
      multiValue: true,
      modeDetermining: false,
      values: _discoveredValues.subclassification,
    },
    {
      type: 'timePeriod',
      label: 'Time Period',
      description: 'Filter by the NGA\'s standard date range buckets (e.g. "1600 to 1700").',
      modes: ['require', 'exclude'],
      multiValue: true,
      modeDetermining: false,
      values: _discoveredValues.timePeriod,
    },
    {
      type: 'artist',
      label: 'Artist',
      description: 'Restrict to works by a specific artist or attribution.',
      modes: ['require'],
      multiValue: false,
      values: [],
      inputStyle: 'search',
    },
    {
      type: 'search',
      label: 'Search',
      description: 'Search by title or artist name.',
      modes: ['require'],
      multiValue: false,
      values: [],
      inputStyle: 'search',
    },
  ];
}

const metadataFields = [
  { key: 'title',       label: 'Title',        description: 'Artwork title' },
  { key: 'creator',     label: 'Artist',        description: 'Artist name or attribution' },
  { key: 'dateCreated', label: 'Date',          description: 'Display date (e.g. "1844", "c. 1820–25")' },
  { key: 'medium',      label: 'Medium',        description: 'Materials and technique' },
  { key: 'dimensions',  label: 'Dimensions',    description: 'Physical dimensions' },
  { key: 'creditLine',  label: 'Credit Line',   description: 'Acquisition credit or collection name' },
  { key: 'source',      label: 'Source',        description: 'Always "National Gallery of Art"' },
];

const defaultMapping = {
  title:       'title',
  creator:     'artist',
  dateCreated: 'date',
  medium:      'medium',
  dimensions:  'dimensions',
  creditLine:  'credit_line',
  source:      null,
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
