'use strict';
const axios = require('axios');

// Access O'Keeffe — Georgia O'Keeffe Museum collection
// https://access-ok.okeeffemuseum.org/object/
//
// Data endpoint: https://access-ok.okeeffemuseum.org/data/object/{id}.json  (Linked Art JSON-LD)
// IIIF images:   https://iiif.okeeffemuseum.org/image/iiif/2/{imageId}/full/max/0/default.jpg
//
// Random selection: probe random repository numbers in [1, REPO_MAX].
// The range is dense enough that retries on 404 are infrequent.
//
// Aspect ratio: IIIF info.json provides width/height before image download.
// No dezoomify needed — IIIF full/max already delivers maximum available resolution.

const BASE_URL   = 'https://access-ok.okeeffemuseum.org';
const IIIF_BASE  = 'https://iiif.okeeffemuseum.org/image/iiif/2';
const DATA_URL   = `${BASE_URL}/data/object`;

const REPO_MAX    = 2000;
const MAX_ATTEMPTS = 15;

// ── Getty AAT URIs for identification ────────────────────────────────────────

// Top-level classified_as IDs (use _id field)
const AAT_PREFERRED_TERM   = 'https://vocab.getty.edu/aat/300404670';
const AAT_ACCESSION_NUMBER = 'https://vocab.getty.edu/aat/300312355';
const AAT_CREDIT_LINE      = 'https://vocab.getty.edu/aat/300026687';
const AAT_DESCRIPTION      = 'https://vocab.getty.edu/aat/300435416';

// Local museum term URIs (used in referred_to_by.classified_as.id)
const LOCAL_MATERIALS_DESC     = 'https://data.okeeffemuseum.org/terms/materials_description';
const LOCAL_MEASUREMENT_DESC   = 'https://data.okeeffemuseum.org/terms/measurement_description';
const LOCAL_CAPTION_TITLE_DATE = 'https://data.okeeffemuseum.org/terms/caption_title_date';
const LOCAL_CAPTION_COPYRIGHT  = 'https://data.okeeffemuseum.org/terms/caption_copyright';

// ── Object type filter definitions ───────────────────────────────────────────

// Maps user-visible type names to Getty AAT URIs found in top-level classified_as.
// An object matches a type if ANY of its classified_as entries has that URI.
const OBJECT_TYPE_URIS = {
  'Paintings':    'http://vocab.getty.edu/aat/300033618',
  'Drawings':     'http://vocab.getty.edu/aat/300033973',
  'Photographs':  'http://vocab.getty.edu/aat/300046300',
  'Prints':       'http://vocab.getty.edu/aat/300041273',
  'Watercolors':  'http://vocab.getty.edu/aat/300078925',
  'Pastels':      'http://vocab.getty.edu/aat/300181705',
  'Sculpture':    'http://vocab.getty.edu/aat/300047090',
};

const OBJECT_TYPE_NAMES = Object.keys(OBJECT_TYPE_URIS);

// ── JSON-LD helpers ───────────────────────────────────────────────────────────

/**
 * Get a canonical ID from a classified_as entry, handling both `id` and `_id` variants.
 */
function getClassId(ca) {
  return ca.id || ca._id || '';
}

/**
 * Find the string content of the first referred_to_by entry whose classified_as includes classId.
 */
function getReferred(obj, classId) {
  for (const item of (obj.referred_to_by || [])) {
    for (const ca of (item.classified_as || [])) {
      if (getClassId(ca) === classId) {
        const c = item.content;
        return Array.isArray(c) ? c[0] : (typeof c === 'string' ? c : null);
      }
    }
  }
  return null;
}

/**
 * Find the string content of the first identified_by entry whose classified_as includes classId.
 */
function getIdentified(obj, classId) {
  for (const item of (obj.identified_by || [])) {
    for (const ca of (item.classified_as || [])) {
      if (getClassId(ca) === classId) {
        const c = item.content;
        return typeof c === 'string' ? c : null;
      }
    }
  }
  return null;
}

/**
 * Extract the IIIF image service base URL (e.g. https://iiif.okeeffemuseum.org/image/iiif/2/790766)
 * from the representation array of a Linked Art object.
 */
function extractIIIFServiceUrl(obj) {
  try {
    const serviceUrl = obj.representation?.[0]
      ?.digitally_shown_by?.[0]
      ?.digitally_available_via?.[0]
      ?.access_point?.[0]?.id;
    if (serviceUrl && serviceUrl.includes('/iiif/')) return serviceUrl;

    // Fallback: extract from direct image access_point URL
    const directUrl = obj.representation?.[0]
      ?.digitally_shown_by?.[0]
      ?.access_point?.[0]?.id;
    if (directUrl) {
      const match = directUrl.match(/(https?:\/\/[^/]+\/image\/iiif\/\d+\/[^/]+)/);
      if (match) return match[1];
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Determine which OBJECT_TYPE_NAMES the object belongs to.
 * Returns an array of matching type names (may be empty for non-artwork items).
 */
function getObjectTypes(obj) {
  const uris = new Set((obj.classified_as || []).map(ca => getClassId(ca)));
  return OBJECT_TYPE_NAMES.filter(name => uris.has(OBJECT_TYPE_URIS[name]));
}

/**
 * Extract structured metadata from a Linked Art object.
 */
function extractMetadata(obj, repoId) {
  const title = getIdentified(obj, AAT_PREFERRED_TERM);

  // Creator: _label on the first carried_out_by actor
  const creator = obj.produced_by?.carried_out_by?.[0]?._label || null;

  // Date: strip the title prefix from "Caption - Title and Date"
  // e.g. "Untitled (Abstraction), ca. 1960" → "ca. 1960"
  const captionTitleDate = getReferred(obj, LOCAL_CAPTION_TITLE_DATE);
  let dateCreated = null;
  if (captionTitleDate) {
    if (title && captionTitleDate.startsWith(title + ', ')) {
      dateCreated = captionTitleDate.slice(title.length + 2);
    } else {
      dateCreated = captionTitleDate;
    }
  }

  const medium      = getReferred(obj, LOCAL_MATERIALS_DESC);
  const dimensions  = getReferred(obj, LOCAL_MEASUREMENT_DESC);
  const creditLine  = getReferred(obj, AAT_CREDIT_LINE);
  const description = getReferred(obj, AAT_DESCRIPTION);
  const copyright   = getReferred(obj, LOCAL_CAPTION_COPYRIGHT);
  const accessionNumber = getIdentified(obj, AAT_ACCESSION_NUMBER);

  return {
    title,
    creator,
    dateCreated,
    medium,
    dimensions,
    creditLine,
    accessionNumber,
    description,
    copyright,
    artworkUrl: `${BASE_URL}/object/${repoId}/`,
    source: "Access O'Keeffe",
  };
}

// ── Filter helpers ────────────────────────────────────────────────────────────

/**
 * Resolve the type filter into eligible type names.
 * Returns null if no type filter is active (all types allowed).
 * Throws if require + exclude leaves nothing eligible.
 *
 * @param {Array<{type, mode, values}>} filters
 * @returns {Set<string>|null}
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

  if (requireSets.length === 0 && excludeValues.size === 0) return null; // no type filter

  let eligible = OBJECT_TYPE_NAMES;
  if (requireSets.length > 0) {
    eligible = eligible.filter(n => requireSets.every(s => s.has(n.toLowerCase())));
  }
  if (excludeValues.size > 0) {
    eligible = eligible.filter(n => !excludeValues.has(n.toLowerCase()));
  }
  if (requireSets.length > 0 && eligible.length === 0) {
    throw new Error('No object types eligible after applying filters');
  }
  return new Set(eligible);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Fetch a random artwork from the Access O'Keeffe collection.
 *
 * Probes random repository IDs in [1, REPO_MAX] until an imaged artwork
 * satisfying the filters is found. Aspect ratio is checked pre-download via
 * IIIF info.json. Image is downloaded at full/max IIIF resolution.
 *
 * @param {Array<{type, mode, values}>} [filters=[]]
 * @param {{ aspectRatio?: 'all'|'landscape'|'portrait' }} [options={}]
 */
async function fetchRandomArtwork(filters = [], options = {}) {
  const { aspectRatio = 'all' } = options;
  const eligibleTypes = resolveTypeFilter(filters);

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const repoId = Math.floor(Math.random() * REPO_MAX) + 1;

    // Fetch JSON-LD record
    let obj;
    try {
      const resp = await axios.get(`${DATA_URL}/${repoId}.json`, { timeout: 10000 });
      obj = resp.data;
    } catch (e) {
      if (e.response?.status === 404) continue;
      throw new Error(`Access O'Keeffe API error: ${e.message}`);
    }

    // Must have a IIIF image
    const iiifServiceUrl = extractIIIFServiceUrl(obj);
    if (!iiifServiceUrl) continue;

    // Object type filter (post-JSON-LD, pre-image-download)
    if (eligibleTypes !== null) {
      const types = getObjectTypes(obj);
      if (!types.some(t => eligibleTypes.has(t))) continue;
    }

    // Aspect ratio check via IIIF info.json (pre-download)
    let iiifWidth = null, iiifHeight = null;
    try {
      const infoResp = await axios.get(`${iiifServiceUrl}/info.json`, { timeout: 10000 });
      iiifWidth  = infoResp.data.width;
      iiifHeight = infoResp.data.height;
    } catch {
      // Proceed without dimension info; aspect ratio check skipped
    }

    if (aspectRatio !== 'all' && iiifWidth && iiifHeight) {
      const isLandscape = iiifWidth >= iiifHeight;
      if (aspectRatio === 'landscape' && !isLandscape) continue;
      if (aspectRatio === 'portrait'  &&  isLandscape) continue;
    }

    // Download image at full resolution
    const imageUrl = `${iiifServiceUrl}/full/max/0/default.jpg`;
    let imageBuffer;
    try {
      const imgResp = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 30000 });
      imageBuffer = Buffer.from(imgResp.data);
    } catch (e) {
      if (e.response?.status === 404) continue;
      throw new Error(`Failed to download image: ${e.message}`);
    }

    return {
      imageBuffer,
      contentType: 'image/jpeg',
      metadata: extractMetadata(obj, repoId),
    };
  }

  throw new Error(
    `Could not find a suitable Access O'Keeffe artwork after ${MAX_ATTEMPTS} attempts`
  );
}

/**
 * Returns true if this source can handle the given identifier.
 * Accepts Access O'Keeffe object URLs and bare repository integers.
 */
function canHandleIdentifier(identifier) {
  const t = identifier.trim();
  return /access-ok\.okeeffemuseum\.org\/object\/(\d+)/i.test(t)
    || /^\d+$/.test(t);
}

/**
 * Fetch a specific artwork by repository ID or Access O'Keeffe URL.
 */
async function fetchByIdentifier(identifier, options = {}) {
  const { aspectRatio = 'all' } = options;
  const t = identifier.trim();

  // Extract repo ID from URL or bare integer
  let repoId;
  const urlMatch = t.match(/access-ok\.okeeffemuseum\.org\/object\/(\d+)/i);
  if (urlMatch) {
    repoId = urlMatch[1];
  } else if (/^\d+$/.test(t)) {
    repoId = t;
  } else {
    throw new Error(`Cannot parse Access O'Keeffe identifier: ${t}`);
  }

  let obj;
  try {
    const resp = await axios.get(`${DATA_URL}/${repoId}.json`, { timeout: 10000 });
    obj = resp.data;
  } catch (e) {
    if (e.response?.status === 404) throw new Error(`Object ${repoId} not found`);
    throw new Error(`Access O'Keeffe API error: ${e.message}`);
  }

  const iiifServiceUrl = extractIIIFServiceUrl(obj);
  if (!iiifServiceUrl) throw new Error(`Object ${repoId} has no image`);

  // Aspect ratio check via IIIF info.json
  if (aspectRatio !== 'all') {
    try {
      const infoResp = await axios.get(`${iiifServiceUrl}/info.json`, { timeout: 10000 });
      const { width, height } = infoResp.data;
      if (width && height) {
        const isLandscape = width >= height;
        if (aspectRatio === 'landscape' && !isLandscape) {
          throw new Error(`Object ${repoId} is portrait; landscape filter cannot be satisfied`);
        }
        if (aspectRatio === 'portrait' && isLandscape) {
          throw new Error(`Object ${repoId} is landscape; portrait filter cannot be satisfied`);
        }
      }
    } catch (e) {
      if (e.message.includes('cannot be satisfied')) throw e;
      // info.json failure: proceed anyway
    }
  }

  const imageUrl = `${iiifServiceUrl}/full/max/0/default.jpg`;
  let imageBuffer;
  try {
    const imgResp = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 30000 });
    imageBuffer = Buffer.from(imgResp.data);
  } catch (e) {
    throw new Error(`Failed to download image for object ${repoId}: ${e.message}`);
  }

  return {
    imageBuffer,
    contentType: 'image/jpeg',
    metadata: extractMetadata(obj, repoId),
  };
}

/**
 * Returns the API strategy for the given filter set.
 * Access O'Keeffe has only one mode — random repository probe.
 */
function selectMode(filters = []) {
  return {
    mode: 'random_probe',
    apiFilters: [],
    postFilters: filters.filter(f => f.type === 'objectType'),
  };
}

function getFilterTypes() {
  return [
    {
      type: 'objectType',
      label: 'Object Type',
      description: 'Filter by type of artwork',
      modes: ['require', 'exclude'],
      multiValue: true,
      modeDetermining: false,
      values: OBJECT_TYPE_NAMES.map(name => ({ value: name, label: name })),
    },
  ];
}

const metadataFields = [
  { key: 'title',           label: 'Title',            description: 'Artwork title' },
  { key: 'creator',         label: 'Artist',           description: "Artist name" },
  { key: 'dateCreated',     label: 'Date',             description: 'Date of creation (e.g. "1932", "ca. 1920–25")' },
  { key: 'medium',          label: 'Medium',           description: 'Materials and technique (e.g. "Oil on canvas")' },
  { key: 'dimensions',      label: 'Dimensions',       description: 'Physical dimensions (e.g. "24 x 36 inches")' },
  { key: 'creditLine',      label: 'Credit Line',      description: 'Acquisition credit' },
  { key: 'accessionNumber', label: 'Accession Number', description: 'Museum accession number' },
  { key: 'description',     label: 'Description',      description: 'Curatorial description of the artwork' },
  { key: 'copyright',       label: 'Copyright',        description: 'Copyright notice (e.g. "© Georgia O\'Keeffe Museum")' },
  { key: 'source',          label: 'Source',           description: "Always \"Access O'Keeffe\"" },
];

const defaultMapping = {
  title:           'title',
  creator:         'artist',
  dateCreated:     'date',
  medium:          'medium',
  dimensions:      'dimensions',
  creditLine:      'credit_line',
  accessionNumber: null,
  description:     'description',
  copyright:       null,
  source:          null,
};

module.exports = {
  fetchRandomArtwork,
  fetchByIdentifier,
  canHandleIdentifier,
  selectMode,
  getFilterTypes,
  metadataFields,
  defaultMapping,
};
