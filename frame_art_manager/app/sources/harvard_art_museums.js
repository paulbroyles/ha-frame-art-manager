'use strict';

const axios = require('axios');
const sharp = require('sharp');

// Base URL for the Harvard Art Museums REST API.
// Requires a free API key: https://docs.harvardartmuseums.org/
const BASE_URL = 'https://api.harvardartmuseums.org';

// Number of random objects to request per API call. Harvard's sort=random
// returns a freshly shuffled set each call, so we batch-fetch and try
// multiple candidates before making another call. Keeps API usage low.
const BATCH_SIZE = 10;

// Maximum number of API calls per fetch attempt.
const MAX_ROUNDS = 5;

// ── Classification (category) filter ─────────────────────────────────────────
//
// Harvard's `classification` field is a controlled vocabulary string returned
// on every object record. The values below are a curated subset of the most
// common classifications in the collection that also have substantial image
// coverage. The API supports pipe-separated OR queries for this parameter.

const CLASSIFICATION_TYPES = [
  'Paintings',
  'Drawings',
  'Prints',
  'Photographs',
  'Sculpture',
  'Works on Paper',
  'Vessels',
  'Textiles',
  'Furniture and Woodwork',
  'Jewelry',
  'Books and Manuscripts',
];

const MEDIUM_CATEGORIES = [
  { name: 'Fine Art',          media: ['Paintings', 'Drawings', 'Prints', 'Works on Paper'] },
  { name: 'Photography',       media: ['Photographs'] },
  { name: 'Sculpture',         media: ['Sculpture'] },
  { name: 'Decorative Arts',   media: ['Vessels', 'Textiles', 'Furniture and Woodwork', 'Jewelry'] },
  { name: 'Rare Books & Mss',  media: ['Books and Manuscripts'] },
];

// ── Culture filter ────────────────────────────────────────────────────────────
//
// Corresponds to the Harvard API `culture` parameter. Values are from the
// museum's controlled vocabulary; the list below covers the most common
// cultures represented in the digitised collection.

const CULTURE_VALUES = [
  'American',
  'British',
  'Dutch',
  'Flemish',
  'French',
  'German',
  'Italian',
  'Spanish',
  'Greek',
  'Roman',
  'Japanese',
  'Chinese',
  'Indian',
  'Persian',
  'Egyptian',
  'African',
];

const CULTURE_CATEGORIES = [
  { name: 'Western Europe', values: ['British', 'Dutch', 'Flemish', 'French', 'German', 'Italian', 'Spanish'] },
  { name: 'Americas',       values: ['American'] },
  { name: 'Ancient',        values: ['Greek', 'Roman', 'Egyptian'] },
  { name: 'Asia',           values: ['Japanese', 'Chinese', 'Indian', 'Persian'] },
  { name: 'Other',          values: ['African'] },
];

// ── Century filter ────────────────────────────────────────────────────────────
//
// Corresponds to the Harvard API `century` parameter. Values follow the
// museum's "Nth century" convention (CE unless noted). Most fine art falls
// in the 13th–21st century range; earlier centuries cover antiquities.

const CENTURY_VALUES = [
  '1st century BCE', '1st century CE',
  '2nd century', '3rd century', '4th century', '5th century',
  '6th century', '7th century', '8th century', '9th century', '10th century',
  '11th century', '12th century', '13th century', '14th century',
  '15th century', '16th century', '17th century', '18th century',
  '19th century', '20th century', '21st century',
];

const CENTURY_CATEGORIES = [
  { name: 'Ancient',       values: ['1st century BCE', '1st century CE', '2nd century', '3rd century', '4th century', '5th century'] },
  { name: 'Medieval',      values: ['6th century', '7th century', '8th century', '9th century', '10th century', '11th century', '12th century', '13th century'] },
  { name: 'Renaissance',   values: ['14th century', '15th century', '16th century'] },
  { name: 'Early Modern',  values: ['17th century', '18th century'] },
  { name: 'Modern',        values: ['19th century', '20th century', '21st century'] },
];

// ── Worktype filter ───────────────────────────────────────────────────────────
//
// Harvard's `worktypes` field is an array of {worktype, worktypeid} objects.
// The API `worktype` query parameter filters by name (pipe-separated OR for require).
// Exclude is applied post-fetch since the API has no native exclude param for this field.
//
// These curated values cover the most common worktypes in the digitised collection.
// The full reference list is available from GET /worktype?apikey=KEY.

const WORKTYPE_VALUES = [
  'Painting',
  'Drawing',
  'Print',
  'Photograph',
  'Sculpture',
  'Fragment',
  'Vessel',
  'Textile',
  'Furniture',
  'Coin',
  'Jewelry',
  'Illumination',
  'Map',
  'Poster',
];

const WORKTYPE_CATEGORIES = [
  { name: 'Fine Art',        values: ['Painting', 'Drawing', 'Print', 'Illumination', 'Map', 'Poster'] },
  { name: 'Photography',     values: ['Photograph'] },
  { name: 'Sculpture',       values: ['Sculpture'] },
  { name: 'Decorative Arts', values: ['Vessel', 'Textile', 'Furniture', 'Coin', 'Jewelry'] },
  { name: 'Other',           values: ['Fragment'] },
];

// ── Filter helpers ────────────────────────────────────────────────────────────

function applySetFilter(allValues, filters, type) {
  const requireSets = filters
    .filter(f => f.type === type && f.mode === 'require')
    .map(f => new Set((f.values || []).map(v => v.toLowerCase())));
  const excludeValues = new Set(
    filters
      .filter(f => f.type === type && f.mode === 'exclude')
      .flatMap(f => f.values || [])
      .map(v => v.toLowerCase())
  );
  let eligible = allValues;
  if (requireSets.length > 0) {
    eligible = eligible.filter(v => requireSets.every(s => s.has(v.toLowerCase())));
  }
  if (excludeValues.size > 0) {
    eligible = eligible.filter(v => !excludeValues.has(v.toLowerCase()));
  }
  return eligible;
}

// ── fetchRandomArtwork ────────────────────────────────────────────────────────

/**
 * Fetch a random artwork from the Harvard Art Museums collection.
 *
 * Supported filter types (passed in the `filters` array):
 *   media      — restrict/exclude classification categories (e.g. 'Paintings', 'Sculpture')
 *   culture    — restrict/exclude by cultural origin (e.g. 'French', 'Japanese')
 *   century    — restrict/exclude by century (e.g. '17th century', '19th century')
 *   worktype   — restrict/exclude by object type (e.g. 'Painting', 'Fragment')
 *                require: API worktype= param (lowercase) + post-fetch confirmation
 *                exclude: post-fetch only against worktypes array (API has no exclude param)
 *   artist     — require: text search across artist/people fields (single value)
 *   search     — require: general keyword search (single value, lower priority than artist)
 *
 * @param {Array<{type: string, mode: 'require'|'exclude', values: string[]}>} [filters=[]]
 * @param {object} [options]
 * @param {'all'|'landscape'|'portrait'} [options.aspectRatio='all']
 * @param {string} [options.apiKey=''] - Harvard Art Museums API key (required)
 * @returns {{ imageBuffer, contentType, metadata }}
 */
async function fetchRandomArtwork(filters = [], options = {}) {
  const { aspectRatio = 'all', apiKey = '' } = options;

  if (!apiKey) {
    throw new Error(
      'Harvard Art Museums API key is required. ' +
      'Add it under Web Sources → Harvard Art Museums → Settings.'
    );
  }

  // ── Apply set filters ──────────────────────────────────────────────────────
  const eligibleClassifications = applySetFilter(CLASSIFICATION_TYPES, filters, 'media');
  const eligibleCultures        = applySetFilter(CULTURE_VALUES,        filters, 'culture');
  const eligibleCenturies       = applySetFilter(CENTURY_VALUES,        filters, 'century');

  if (eligibleClassifications.length === 0) {
    throw new Error('No classification categories eligible after applying filters');
  }
  if (eligibleCultures.length === 0) {
    throw new Error('No cultures eligible after applying filters');
  }
  if (eligibleCenturies.length === 0) {
    throw new Error('No centuries eligible after applying filters');
  }

  // Worktype: the Harvard /object endpoint does not support a worktype filter parameter,
  // so both require and exclude are applied post-fetch against the worktypes array.
  const worktypeRequireSet = new Set(
    filters
      .filter(f => f.type === 'worktype' && f.mode === 'require')
      .flatMap(f => f.values || [])
      .map(v => v.toLowerCase())
  );
  const worktypeExcludeSet = new Set(
    filters
      .filter(f => f.type === 'worktype' && f.mode === 'exclude')
      .flatMap(f => f.values || [])
      .map(v => v.toLowerCase())
  );

  // ── Build API params ───────────────────────────────────────────────────────
  // Note: `imagepermission` is not a valid query parameter (only a response field
  // `imagepermissionlevel`). Image permission is checked post-fetch instead.
  const params = {
    apikey:  apiKey,
    sort:    'random',
    hasimage: 1,
    size:    BATCH_SIZE,
    fields:  'id,title,people,technique,dated,primaryimageurl,width,height,url,classification,culture,century,worktypes,imagepermissionlevel',
  };

  // Pipe-separated OR filter; omit when all values are eligible.
  if (eligibleClassifications.length < CLASSIFICATION_TYPES.length) {
    params.classification = eligibleClassifications.join('|');
  }
  if (eligibleCultures.length < CULTURE_VALUES.length) {
    params.culture = eligibleCultures.join('|');
  }
  if (eligibleCenturies.length < CENTURY_VALUES.length) {
    params.century = eligibleCenturies.join('|');
  }

  // Worktype require: API supports worktype= filter with pipe-separated lowercase names.
  // Values are lowercase in the API (e.g. "painting", not "Painting").
  if (worktypeRequireSet.size > 0) {
    params.worktype = [...worktypeRequireSet].join('|');  // already lowercased
  }

  // Text search: artist takes priority over general keyword search.
  const artistTerm = filters.find(f => f.type === 'artist' && f.mode === 'require')?.values?.[0] || null;
  const searchTerm = filters.find(f => f.type === 'search'  && f.mode === 'require')?.values?.[0] || null;
  if (artistTerm) {
    params.keyword = artistTerm;
  } else if (searchTerm) {
    params.keyword = searchTerm;
  }

  // ── Fetch loop ─────────────────────────────────────────────────────────────
  for (let round = 0; round < MAX_ROUNDS; round++) {
    let objects;
    try {
      const response = await axios.get(`${BASE_URL}/object`, { params, timeout: 15000 });
      objects = response.data.records || [];
    } catch (err) {
      throw new Error(`Failed to fetch from Harvard Art Museums: ${err.message}`);
    }

    if (!objects.length) {
      throw new Error('No objects returned from Harvard Art Museums API');
    }

    // Extra shuffle within the batch — sort=random is page-level, not item-level.
    const shuffled = [...objects].sort(() => Math.random() - 0.5);

    for (const obj of shuffled) {
      if (!obj.primaryimageurl) {
        console.warn(`[harvard_art_museums] Object ${obj.id} skipped: no primary image`);
        continue;
      }

      // Image permission check. imagepermissionlevel: 0 = unrestricted, 1 = max 256px, 2 = no display.
      // The API has no filter parameter for this; we check post-fetch.
      if (obj.imagepermissionlevel !== undefined && obj.imagepermissionlevel !== 0) {
        console.warn(`[harvard_art_museums] Object ${obj.id} skipped: imagepermissionlevel=${obj.imagepermissionlevel}`);
        continue;
      }

      // Post-fetch worktype filter. Require is also handled at the API level (worktype= param,
      // lowercase), but we re-check here for accuracy. Exclude is post-fetch only (no API support).
      if (worktypeRequireSet.size > 0 || worktypeExcludeSet.size > 0) {
        const objWorktypes = (obj.worktypes || []).map(wt => (wt.worktype || '').toLowerCase());
        if (worktypeRequireSet.size > 0 && !objWorktypes.some(wt => worktypeRequireSet.has(wt))) {
          console.warn(`[harvard_art_museums] Object ${obj.id} skipped: worktype (${objWorktypes.join(', ')}) not in required set`);
          continue;
        }
        if (worktypeExcludeSet.size > 0 && objWorktypes.some(wt => worktypeExcludeSet.has(wt))) {
          console.warn(`[harvard_art_museums] Object ${obj.id} skipped: excluded worktype (${objWorktypes.join(', ')})`);
          continue;
        }
      }

      // Pre-download aspect ratio check using API-provided dimensions (preferred —
      // avoids downloading the full image before rejecting it).
      if (aspectRatio !== 'all' && obj.width && obj.height) {
        const isLandscape = obj.width > obj.height;
        if (aspectRatio === 'landscape' && !isLandscape) {
          console.warn(`[harvard_art_museums] Object ${obj.id} skipped: not landscape (${obj.width}x${obj.height})`);
          continue;
        }
        if (aspectRatio === 'portrait' && isLandscape) {
          console.warn(`[harvard_art_museums] Object ${obj.id} skipped: not portrait (${obj.width}x${obj.height})`);
          continue;
        }
      }

      // Download image.
      let imageBuffer, contentType;
      try {
        const imageResponse = await axios.get(obj.primaryimageurl, {
          responseType: 'arraybuffer',
          timeout: 30000,
        });
        imageBuffer = Buffer.from(imageResponse.data);
        contentType = imageResponse.headers['content-type'] || 'image/jpeg';
      } catch (err) {
        console.warn(`[harvard_art_museums] Failed to download image for object ${obj.id}: ${err.message}`);
        continue;
      }

      // Post-download aspect ratio check (fallback when API omits dimensions).
      if (aspectRatio !== 'all' && (!obj.width || !obj.height)) {
        try {
          const { width, height } = await sharp(imageBuffer).metadata();
          const isLandscape = width > height;
          if (aspectRatio === 'landscape' && !isLandscape) {
            console.warn(`[harvard_art_museums] Object ${obj.id} skipped: not landscape (${width}x${height})`);
            continue;
          }
          if (aspectRatio === 'portrait' && isLandscape) {
            console.warn(`[harvard_art_museums] Object ${obj.id} skipped: not portrait (${width}x${height})`);
            continue;
          }
        } catch (err) {
          console.warn(`[harvard_art_museums] Could not read dimensions for object ${obj.id}: ${err.message}`);
          continue;
        }
      }

      const creator = obj.people?.find(p => p.role === 'Artist')?.name
                   || obj.people?.[0]?.name
                   || null;

      return {
        imageBuffer,
        contentType,
        metadata: {
          title:       obj.title     || null,
          creator,
          medium:      obj.technique || null,
          dateCreated: obj.dated     || null,
          artworkUrl:  obj.url       || null,
          source:      'Harvard Art Museums',
        },
      };
    }
  }

  throw new Error(
    `Could not find a suitable${aspectRatio !== 'all' ? ` ${aspectRatio}` : ''} ` +
    `artwork after ${MAX_ROUNDS * BATCH_SIZE} attempts`
  );
}

// ── fetchByIdentifier ─────────────────────────────────────────────────────────

/**
 * Returns true if the identifier is a Harvard Art Museums object URL.
 * Accepted formats:
 *   https://harvardartmuseums.org/collections/object/12345
 *   https://www.harvardartmuseums.org/collections/object/12345
 */
function canHandleIdentifier(identifier) {
  return /harvardartmuseums\.org\/collections\/object\/\d+/i.test(identifier.trim());
}

/**
 * Fetch a specific artwork by Harvard Art Museums collection URL.
 *
 * @param {string} identifier - Full collection URL
 * @param {object} [options]
 * @param {object} [options.settings] - Source settings (must include apiKey)
 * @returns {{ imageBuffer, contentType, metadata }}
 */
async function fetchByIdentifier(identifier, options = {}) {
  const apiKey = options.settings?.apiKey || '';
  if (!apiKey) {
    throw new Error('Harvard Art Museums API key is required.');
  }

  const match = identifier.trim().match(/\/collections\/object\/(\d+)/i);
  if (!match) throw new Error('Could not extract object ID from Harvard Art Museums URL');
  const objectId = match[1];

  let obj;
  try {
    const response = await axios.get(`${BASE_URL}/object/${objectId}`, {
      params: {
        apikey: apiKey,
        fields: 'id,title,people,technique,dated,primaryimageurl,width,height,url,classification,culture,century',
      },
      timeout: 15000,
    });
    obj = response.data;
  } catch (err) {
    throw new Error(`Failed to fetch Harvard Art Museums object ${objectId}: ${err.message}`);
  }

  if (!obj.primaryimageurl) {
    throw new Error(`Object ${objectId} has no accessible primary image`);
  }

  let imageBuffer, contentType;
  try {
    const imageResponse = await axios.get(obj.primaryimageurl, {
      responseType: 'arraybuffer',
      timeout: 30000,
    });
    imageBuffer = Buffer.from(imageResponse.data);
    contentType = imageResponse.headers['content-type'] || 'image/jpeg';
  } catch (err) {
    throw new Error(`Failed to download image for Harvard Art Museums object ${objectId}: ${err.message}`);
  }

  const creator = obj.people?.find(p => p.role === 'Artist')?.name
               || obj.people?.[0]?.name
               || null;

  return {
    imageBuffer,
    contentType,
    metadata: {
      title:       obj.title     || null,
      creator,
      medium:      obj.technique || null,
      dateCreated: obj.dated     || null,
      artworkUrl:  obj.url       || null,
      source:      'Harvard Art Museums',
    },
  };
}

// ── searchPreview ─────────────────────────────────────────────────────────────

/**
 * Return up to `count` search results for a keyword query without downloading images.
 *
 * @param {string} query
 * @param {object} [options]
 * @param {number} [options.count=12]
 * @param {object} [options.settings] - Source settings (must include apiKey)
 * @returns {Promise<{ results: Array<{title,creator,thumbnailUrl,artworkUrl,source}>, totalAvailable: number }>}
 */
async function searchPreview(query, options = {}) {
  const { count = 12, settings } = options;
  const apiKey = settings?.apiKey || '';
  if (!apiKey) throw new Error('Harvard Art Museums API key is required.');

  let response;
  try {
    response = await axios.get(`${BASE_URL}/object`, {
      params: {
        apikey:          apiKey,
        keyword:         query,
        hasimage:        1,
        imagepermission: 1,
        size:            count * 3,  // overfetch to account for missing images
        fields:          'id,title,people,primaryimageurl,url',
        sort:            'relevance',
      },
      timeout: 15000,
    });
  } catch (err) {
    throw new Error(`[harvard_art_museums] searchPreview failed: ${err.message}`);
  }

  const records       = response.data.records || [];
  const totalAvailable = response.data.info?.totalrecords || records.length;

  const results = [];
  for (const obj of records) {
    if (results.length >= count) break;
    if (!obj.primaryimageurl) continue;
    const creator = obj.people?.find(p => p.role === 'Artist')?.name
                 || obj.people?.[0]?.name
                 || null;
    results.push({
      title:        obj.title           || null,
      creator,
      thumbnailUrl: obj.primaryimageurl,
      artworkUrl:   obj.url             || null,
      source:       'Harvard Art Museums',
    });
  }

  return { results, totalAvailable };
}

// ── countArtistArtworks ───────────────────────────────────────────────────────

/**
 * Return the approximate number of artworks for a given artist keyword.
 * Uses keyword search across people/artist fields.
 * Returns null on network error.
 *
 * @param {string} artistName
 * @param {object} [options]
 * @param {object} [options.settings]
 * @returns {Promise<number|null>}
 */
async function countArtistArtworks(artistName, options = {}) {
  const apiKey = options.settings?.apiKey || '';
  if (!apiKey) return null;
  try {
    const response = await axios.get(`${BASE_URL}/object`, {
      params: {
        apikey:          apiKey,
        keyword:         artistName,
        hasimage:        1,
        imagepermission: 1,
        size:            1,
        fields:          'id',
      },
      timeout: 10000,
    });
    return response.data.info?.totalrecords ?? null;
  } catch {
    return null;
  }
}

// ── selectMode ────────────────────────────────────────────────────────────────

/**
 * Examine the full merged filter set and determine the best API strategy.
 *
 * @param {Array<{type, mode, values}>} filters
 * @returns {{ mode: string, apiFilters: Array, postFilters: Array }}
 */
function selectMode(filters = []) {
  const hasArtist  = filters.some(f => f.type === 'artist');
  const hasSearch  = filters.some(f => f.type === 'search');
  const apiFilters = filters.filter(f => ['media', 'culture', 'century', 'worktype', 'search', 'artist'].includes(f.type));
  const postFilters = [];
  const mode = hasArtist ? 'artist_search' : hasSearch ? 'keyword_search' : 'random';
  return { mode, apiFilters, postFilters };
}

// ── getFilterTypes ────────────────────────────────────────────────────────────

function getFilterTypes() {
  return [
    {
      type:        'media',
      label:       'Category',
      description: 'Restrict or exclude artworks by collection category.',
      modes:       ['require', 'exclude'],
      multiValue:  true,
      groups:      MEDIUM_CATEGORIES.map(cat => ({ name: cat.name, values: cat.media })),
      values:      CLASSIFICATION_TYPES.map(name => ({ value: name, label: name })),
    },
    {
      type:        'culture',
      label:       'Culture',
      description: 'Restrict or exclude artworks by cultural origin.',
      modes:       ['require', 'exclude'],
      multiValue:  true,
      groups:      CULTURE_CATEGORIES.map(cat => ({ name: cat.name, values: cat.values })),
      values:      CULTURE_VALUES.map(name => ({ value: name, label: name })),
    },
    {
      type:        'century',
      label:       'Century',
      description: 'Restrict or exclude artworks by the century in which they were created.',
      modes:       ['require', 'exclude'],
      multiValue:  true,
      groups:      CENTURY_CATEGORIES.map(cat => ({ name: cat.name, values: cat.values })),
      values:      CENTURY_VALUES.map(name => ({ value: name, label: name })),
    },
    {
      type:        'worktype',
      label:       'Object Type',
      description: 'Restrict or exclude by object type. Useful for excluding "Fragment" when browsing the Paintings category, or for requiring "Painting" to get only traditional paintings.',
      modes:       ['require', 'exclude'],
      multiValue:  true,
      groups:      WORKTYPE_CATEGORIES.map(cat => ({ name: cat.name, values: cat.values })),
      values:      WORKTYPE_VALUES.map(name => ({ value: name, label: name })),
    },
    {
      type:        'artist',
      label:       'Artist',
      description: 'Search by artist name.',
      modes:       ['require'],
      multiValue:  false,
      values:      [],
      inputStyle:  'search',
    },
    {
      type:        'search',
      label:       'Search',
      description: 'Search by title, artist, or subject.',
      modes:       ['require'],
      multiValue:  false,
      values:      [],
      inputStyle:  'search',
    },
  ];
}

// ── Settings schema ───────────────────────────────────────────────────────────

const settingsSchema = {
  fields: [
    {
      key:         'apiKey',
      type:        'string',
      default:     '',
      label:       'API Key',
      description: 'Free Harvard Art Museums API key. Request one at https://docs.harvardartmuseums.org/',
      secret:      true,
    },
  ],
};

function getExtraOptions(settings) {
  return { apiKey: settings?.apiKey || '' };
}

// ── Metadata declarations ─────────────────────────────────────────────────────

const metadataFields = [
  { key: 'title',       label: 'Title',        description: 'Artwork title' },
  { key: 'creator',     label: 'Creator',      description: 'Artist or maker name' },
  { key: 'medium',      label: 'Medium',       description: 'Technique or material (e.g. "Oil on canvas")' },
  { key: 'dateCreated', label: 'Date Created', description: 'Date or period the artwork was created', format: 'date' },
  { key: 'source',      label: 'Source',       description: 'Always "Harvard Art Museums"' },
];

const defaultMapping = {
  title:       'title',
  creator:     { entity: 'creator', attribute: 'name' },
  medium:      'medium',
  dateCreated: 'date',
  source:      'museum',
};

module.exports = {
  fetchRandomArtwork,
  fetchByIdentifier,
  canHandleIdentifier,
  countArtistArtworks,
  searchPreview,
  selectMode,
  getFilterTypes,
  settingsSchema,
  getExtraOptions,
  metadataFields,
  defaultMapping,
  CLASSIFICATION_TYPES,
  MEDIUM_CATEGORIES,
  CULTURE_VALUES,
  CENTURY_VALUES,
  WORKTYPE_VALUES,
  WORKTYPE_CATEGORIES,
};
