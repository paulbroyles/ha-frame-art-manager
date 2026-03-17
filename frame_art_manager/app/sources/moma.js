'use strict';
const axios = require('axios');
const fs = require('fs').promises;

// GitHub dataset: MuseumofModernArt/collection — snapshot of the full MoMA collection.
// 160,269 total records; ~93,188 have an ImageURL. Updated by MoMA periodically.
const GITHUB_URL = 'https://raw.githubusercontent.com/MuseumofModernArt/collection/master/Artworks.json';

// Sanity CMS: MoMA's editorial "curated" collection — the works that appear on
// moma.org/collection with rich gallery label text. ~8,665 records with tmsId.
const SANITY_URL = 'https://476nwnl9.api.sanity.io/v2021-10-21/data/query/production';
const SANITY_QUERY = '*[_type == "artwork" && defined(tmsId)]{tmsId}';

// On-disk cache path inside the add-on's persistent data volume.
const CACHE_PATH = '/data/moma_cache.json';
const CACHE_VERSION = 1;
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// In-memory state populated by ensureCache().
let artworkIndex = null;  // Array of trimmed artwork records
let curatedSet = null;    // Set of ObjectIDs flagged as curated (from Sanity)
let cacheLoadedAt = 0;
let cachePromise = null;  // In-flight build to prevent concurrent rebuilds

// Classification values present in the GitHub dataset (used for filter UI).
// Derived from the MoMA collection as of early 2026.
const CLASSIFICATIONS = [
  'Painting',
  'Drawing',
  'Print',
  'Photograph',
  'Sculpture',
  'Design',
  'Architecture',
  'Film',
  'Video',
  'Illustrated Book',
  'Textile',
  'Collage',
  'Installation',
  'Performance',
  'Periodical',
  'Multiple',
  'Work on Paper',
];

// Curatorial departments in the MoMA collection.
const DEPARTMENTS = [
  'Painting & Sculpture',
  'Drawings & Prints',
  'Photography',
  'Architecture & Design',
  'Film',
  'Media and Performance',
  'Library',
];

// ── Image URL construction ────────────────────────────────────────────────────

/**
 * Extract the Dragonfly file ID from a MoMA image URL.
 *
 * ImageURLs in the GitHub dataset look like:
 *   https://www.moma.org/media/{base64}.jpg?sha=...
 *
 * The base64 path decodes to a JSON instruction array, e.g.:
 *   [["f","619222"],["p","convert","-quality 90 -resize 1024x1024\u003e"]]
 *
 * IMPORTANT: The \u003e in the decoded string is the literal 6-character
 * sequence \, u, 0, 0, 3, e — NOT the > character (U+003E). Dragonfly
 * requires this literal encoding; using > causes a 400 error.
 *
 * @param {string} imageUrl - Raw ImageURL from the GitHub dataset
 * @returns {string|null} Dragonfly file ID, or null if parsing fails
 */
function extractFileId(imageUrl) {
  if (!imageUrl) return null;
  const match = imageUrl.match(/\/media\/([^.?]+)\.jpg/);
  if (!match) return null;
  const b64 = match[1];
  const pad = (4 - (b64.length % 4)) % 4;
  try {
    const decoded = Buffer.from(b64 + '='.repeat(pad), 'base64').toString('ascii');
    const instructions = JSON.parse(decoded);
    const fid = instructions?.[0]?.[1];
    return fid ? String(fid) : null;
  } catch {
    return null;
  }
}

/**
 * Build a 2000×2000 MoMA Dragonfly image URL from a file ID.
 * sha validation is not enforced by Dragonfly — the URL works without it.
 *
 * @param {string} fileId - Dragonfly file ID (e.g. "619222")
 * @returns {string} Image URL serving up to 2000×2000 pixels
 */
function buildImageUrl(fileId) {
  // The string "\\u003e" in JS is 6 literal chars: \, u, 0, 0, 3, e.
  // This matches the literal \u003e bytes that Dragonfly expects in the instruction JSON.
  const raw = `[["f","${fileId}"],["p","convert","-quality 90 -resize 2000x2000\\u003e"]]`;
  const b64 = Buffer.from(raw, 'ascii').toString('base64').replace(/=+$/, '');
  return `https://www.moma.org/media/${b64}.jpg`;
}

// ── Cache management ──────────────────────────────────────────────────────────

/**
 * Download the GitHub dataset and Sanity curated set, trim to needed fields,
 * and write to CACHE_PATH.
 *
 * The GitHub Artworks.json is ~144 MB. The trimmed cache is ~15–20 MB.
 * Each artwork record is reduced to only the fields used for filtering and display.
 */
async function buildCache() {
  console.log('[moma] Downloading GitHub dataset (~144 MB)...');
  let artworks;
  try {
    const resp = await axios.get(GITHUB_URL, { timeout: 180000, responseType: 'json' });
    artworks = resp.data;
  } catch (err) {
    throw new Error(`[moma] Failed to download GitHub dataset: ${err.message}`);
  }

  const trimmed = [];
  for (const rec of artworks) {
    if (!rec.ImageURL) continue;
    const fid = extractFileId(rec.ImageURL);
    if (!fid) continue;
    const w = rec['Width (cm)'];
    const h = rec['Height (cm)'];
    trimmed.push({
      id:  rec.ObjectID,
      t:   rec.Title || null,
      a:   Array.isArray(rec.Artist) ? rec.Artist.filter(Boolean) : [],
      b:   Array.isArray(rec.ArtistBio) ? rec.ArtistBio.filter(Boolean) : [],
      n:   Array.isArray(rec.Nationality) ? rec.Nationality.filter(Boolean) : [],
      d:   rec.Date || null,
      med: rec.Medium || null,
      dim: rec.Dimensions || null,
      cls: rec.Classification || null,
      dpt: rec.Department || null,
      url: rec.URL || null,
      fid,
      w:   typeof w === 'number' ? w : null,
      h:   typeof h === 'number' ? h : null,
      ov:  !!(rec['On View']),
    });
  }

  // Fetch Sanity curated tmsIds (ObjectIDs) for the "curated" filter.
  let curatedIds = [];
  try {
    const resp = await axios.get(SANITY_URL, {
      params: { query: SANITY_QUERY },
      timeout: 30000,
    });
    const result = resp.data?.result || [];
    curatedIds = result
      .map(r => r.tmsId)
      .filter(id => typeof id === 'number');
  } catch (err) {
    console.warn(`[moma] Failed to fetch Sanity curated set (curated filter will be unavailable): ${err.message}`);
  }

  const cacheData = {
    v:        CACHE_VERSION,
    ts:       Date.now(),
    curated:  curatedIds,
    artworks: trimmed,
  };

  await fs.mkdir('/data', { recursive: true });
  await fs.writeFile(CACHE_PATH, JSON.stringify(cacheData));
  console.log(`[moma] Cache built: ${trimmed.length} artworks with images, ${curatedIds.length} curated`);
  return cacheData;
}

/**
 * Ensure the in-memory artwork index is loaded and not stale.
 * Concurrent callers share a single in-flight build promise.
 */
async function ensureCache() {
  const now = Date.now();
  if (artworkIndex !== null && (now - cacheLoadedAt) < CACHE_TTL_MS) return;

  if (cachePromise) {
    await cachePromise;
    return;
  }

  cachePromise = (async () => {
    let data = null;
    try {
      const raw = await fs.readFile(CACHE_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed.v === CACHE_VERSION && (now - parsed.ts) < CACHE_TTL_MS) {
        data = parsed;
      }
    } catch {
      // Cache missing or stale — will rebuild
    }

    if (!data) data = await buildCache();

    artworkIndex = data.artworks;
    curatedSet   = new Set(data.curated || []);
    cacheLoadedAt = now;
    cachePromise  = null;
  })();

  await cachePromise;
}

// ── Metadata helpers ──────────────────────────────────────────────────────────

function buildMetadata(rec) {
  const creator     = rec.a.filter(Boolean).join(', ') || null;
  const creatorBio  = rec.b.filter(Boolean)[0]         || null;
  const nationality = rec.n.filter(Boolean).join(', ') || null;
  return {
    title:              rec.t   || null,
    creator,
    creatorBio,
    creatorNationality: nationality,
    medium:             rec.med || null,
    dimensions:         rec.dim || null,
    dateCreated:        rec.d   || null,
    classification:     rec.cls || null,
    department:         rec.dpt || null,
    artworkUrl:         rec.url || (rec.id ? `https://www.moma.org/collection/works/${rec.id}` : null),
    source: 'The Museum of Modern Art (MoMA)',
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Fetch a random artwork from the MoMA collection.
 *
 * @param {Array<{type, mode, values}>} [filters=[]] - Supported filter types:
 *   'classification' — require/exclude by Classification field (e.g. 'Painting')
 *   'department'     — require/exclude by Department field (e.g. 'Photography')
 * @param {object} [options]
 * @param {'all'|'landscape'|'portrait'} [options.aspectRatio='all']
 *   Pre-download filter using Width (cm) / Height (cm) from GitHub dataset.
 *   Records without dimension data are excluded when aspectRatio is not 'all'.
 * @param {boolean} [options.curatedOnly=false]
 *   Restrict to artworks in MoMA's Sanity CMS editorial collection (~8,600 works).
 * @param {boolean} [options.onViewOnly=false]
 *   Restrict to artworks currently on view in the museum.
 *
 * @returns {{ imageBuffer, contentType, metadata }}
 */
async function fetchRandomArtwork(filters = [], options = {}) {
  const { aspectRatio = 'all', curatedOnly = false, onViewOnly = false } = options;

  await ensureCache();

  let pool = artworkIndex;

  // Curated filter (Sanity tmsId set)
  if (curatedOnly) {
    if (curatedSet.size === 0) {
      console.warn('[moma] curatedOnly requested but Sanity curated set is empty; ignoring');
    } else {
      pool = pool.filter(a => curatedSet.has(a.id));
    }
  }

  // On-view filter
  if (onViewOnly) {
    pool = pool.filter(a => a.ov);
  }

  // Classification filter
  const reqClsSets = filters
    .filter(f => f.type === 'classification' && f.mode === 'require')
    .map(f => new Set((f.values || []).map(v => v.toLowerCase())));
  const excClsVals = new Set(
    filters
      .filter(f => f.type === 'classification' && f.mode === 'exclude')
      .flatMap(f => f.values || [])
      .map(v => v.toLowerCase())
  );
  if (reqClsSets.length > 0) {
    pool = pool.filter(a => {
      const c = (a.cls || '').toLowerCase();
      return reqClsSets.every(s => s.has(c));
    });
  }
  if (excClsVals.size > 0) {
    pool = pool.filter(a => !excClsVals.has((a.cls || '').toLowerCase()));
  }

  // Department filter
  const reqDptSets = filters
    .filter(f => f.type === 'department' && f.mode === 'require')
    .map(f => new Set((f.values || []).map(v => v.toLowerCase())));
  const excDptVals = new Set(
    filters
      .filter(f => f.type === 'department' && f.mode === 'exclude')
      .flatMap(f => f.values || [])
      .map(v => v.toLowerCase())
  );
  if (reqDptSets.length > 0) {
    pool = pool.filter(a => {
      const d = (a.dpt || '').toLowerCase();
      return reqDptSets.every(s => s.has(d));
    });
  }
  if (excDptVals.size > 0) {
    pool = pool.filter(a => !excDptVals.has((a.dpt || '').toLowerCase()));
  }

  // Aspect ratio filter — pre-download using physical dimensions from GitHub dataset.
  // Note: Width/Height are physical dimensions for 2D works; 3D objects may have
  // misleading ratios. Records missing both dimensions are excluded when filtering.
  if (aspectRatio !== 'all') {
    pool = pool.filter(a => {
      if (!a.w || !a.h) return false;
      return aspectRatio === 'landscape' ? a.w > a.h : a.h > a.w;
    });
  }

  if (pool.length === 0) {
    throw new Error('No MoMA artworks match the selected filters');
  }

  const MAX_ATTEMPTS = 10;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const artwork = pool[Math.floor(Math.random() * pool.length)];
    const imageUrl = buildImageUrl(artwork.fid);

    let imageBuffer, contentType;
    try {
      const resp = await axios.get(imageUrl, {
        responseType: 'arraybuffer',
        timeout: 30000,
      });
      imageBuffer = Buffer.from(resp.data);
      contentType = resp.headers['content-type'] || 'image/jpeg';
    } catch (err) {
      console.warn(`[moma] Failed to download image for object ${artwork.id}: ${err.message}`);
      continue;
    }

    return {
      imageBuffer,
      contentType,
      metadata: buildMetadata(artwork),
    };
  }

  throw new Error(`Could not download a MoMA artwork image after ${MAX_ATTEMPTS} attempts`);
}

/**
 * Returns true if this source can handle the given identifier.
 * Accepts MoMA collection URLs and bare numeric object IDs.
 */
function canHandleIdentifier(identifier) {
  const t = identifier.trim();
  return /moma\.org\/collection\/works\/\d+/i.test(t) || /^\d{4,6}$/.test(t);
}

/**
 * Fetch a specific artwork by MoMA collection URL or numeric ObjectID.
 *
 * @param {string} identifier - MoMA URL or numeric object ID string
 * @returns {{ imageBuffer, contentType, metadata }}
 */
async function fetchByIdentifier(identifier) {
  const t = identifier.trim();
  const urlMatch = t.match(/moma\.org\/collection\/works\/(\d+)/i);
  const objectId = parseInt(urlMatch ? urlMatch[1] : t, 10);

  await ensureCache();

  const artwork = artworkIndex.find(a => a.id === objectId);
  if (!artwork) {
    throw new Error(`MoMA object ${objectId} not found in index (no public image in dataset)`);
  }

  const imageUrl = buildImageUrl(artwork.fid);
  let imageBuffer, contentType;
  try {
    const resp = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 30000 });
    imageBuffer = Buffer.from(resp.data);
    contentType = resp.headers['content-type'] || 'image/jpeg';
  } catch (err) {
    throw new Error(`Failed to download MoMA image for object ${objectId}: ${err.message}`);
  }

  return {
    imageBuffer,
    contentType,
    metadata: buildMetadata(artwork),
  };
}

/**
 * Examine the merged filter set and return the API strategy.
 * MoMA always uses the local index; no API call is needed for selection.
 */
function selectMode(filters = []) {
  const postFilters = filters.filter(f => f.type === 'classification' || f.type === 'department');
  return { mode: 'index', apiFilters: [], postFilters };
}

function getFilterTypes() {
  return [
    {
      type: 'classification',
      label: 'Classification',
      description: 'Restrict or exclude artworks by object type (e.g. Painting, Photograph).',
      modes: ['require', 'exclude'],
      multiValue: true,
      values: CLASSIFICATIONS.map(c => ({ value: c, label: c })),
    },
    {
      type: 'department',
      label: 'Department',
      description: 'Restrict or exclude artworks by MoMA curatorial department.',
      modes: ['require', 'exclude'],
      multiValue: true,
      values: DEPARTMENTS.map(d => ({ value: d, label: d })),
    },
  ];
}

const settingsSchema = {
  fields: [
    {
      key: 'curatedOnly',
      type: 'boolean',
      default: false,
      label: 'Curated Works Only',
      description: 'Limit to ~8,600 artworks highlighted in MoMA\'s editorial collection (moma.org/collection). When disabled, the full dataset of ~93,000 works with images is used.',
    },
    {
      key: 'onViewOnly',
      type: 'boolean',
      default: false,
      label: 'On View Only',
      description: 'Limit to artworks currently on view in the museum.',
    },
  ],
};

function getExtraOptions(settings) {
  return {
    curatedOnly: !!settings?.curatedOnly,
    onViewOnly:  !!settings?.onViewOnly,
  };
}

const metadataFields = [
  { key: 'title',              label: 'Title',          description: 'Artwork title' },
  { key: 'creator',            label: 'Artist',         description: 'Primary artist name(s); multiple artists joined with ", "' },
  { key: 'creatorBio',         label: 'Artist Bio',     description: 'Biographical note for first listed artist (e.g. "French, 1869–1954")' },
  { key: 'creatorNationality', label: 'Nationality',    description: 'Artist nationality (first artist if multiple)' },
  { key: 'medium',             label: 'Medium',         description: 'Physical materials (e.g. "Oil on canvas")' },
  { key: 'dimensions',         label: 'Dimensions',     description: 'Physical dimensions string (e.g. \'36 × 28" (91.4 × 71.1 cm)\')' },
  { key: 'dateCreated',        label: 'Date',           description: 'Date or year of creation (e.g. "1929", "1928–29")' },
  { key: 'classification',     label: 'Classification', description: 'Object type (e.g. "Painting", "Photograph")' },
  { key: 'department',         label: 'Department',     description: 'MoMA curatorial department' },
  { key: 'source',             label: 'Source',         description: 'Always "The Museum of Modern Art (MoMA)"' },
];

const defaultMapping = {
  title:              'title',
  creator:            { entity: 'creator', attribute: 'name' },
  creatorBio:         null,
  creatorNationality: null,
  medium:             'medium',
  dimensions:         null,
  dateCreated:        'date',
  classification:     null,
  department:         null,
  source:             'museum',
};

module.exports = {
  fetchRandomArtwork,
  fetchByIdentifier,
  canHandleIdentifier,
  selectMode,
  getFilterTypes,
  settingsSchema,
  getExtraOptions,
  metadataFields,
  defaultMapping,
};
