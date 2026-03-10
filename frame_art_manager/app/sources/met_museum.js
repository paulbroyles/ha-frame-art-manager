const axios = require('axios');
const sharp = require('sharp');

// Base URL for the Metropolitan Museum of Art Open Access API.
// No API key required. Rate limit: 80 requests/second.
const BASE_URL = 'https://collectionapi.metmuseum.org/public/collection/v1';

// Classification-level categories for filtering the Met's collection.
//
// The Met API's /search endpoint accepts a `medium` parameter that filters
// objects by their `classification` field — a controlled vocabulary (e.g.
// "Paintings", "Prints") distinct from the free-text `medium` field (e.g.
// "Oil on canvas", "Etching and aquatint").
//
// Each category here corresponds to one or more `classification` values in
// the Met's data. The user can enable or disable categories in the settings
// dialog. Disabled categories are stored as disabledMedia in settings.
//
// CLASSIFICATION_EXPANSIONS maps user-visible category names to the full set
// of related classification values passed to the API's `medium=` filter.
// Many categories have sub-classifications (e.g. "Ceramics-Porcelain") that
// are grouped under the parent for convenience.
const CLASSIFICATION_EXPANSIONS = {
  Paintings:    ['Paintings'],
  Drawings:     ['Drawings'],
  Prints:       ['Prints'],
  Watercolors:  ['Watercolors'],
  Miniatures:   ['Miniatures'],
  Photographs:  ['Photographs'],
  Sculpture:    ['Sculpture', 'Sculpture-Wood', 'Sculpture-Architectural',
                 'Stone-Sculpture', 'Wood-Sculpture', 'Bronzes', 'Terracottas'],
  Ceramics:     ['Ceramics', 'Ceramics-Porcelain', 'Ceramics-Pottery', 'Vases'],
  Glass:        ['Glass', 'Glass-Stained', 'Glass-Vessels'],
  Textiles:     ['Textiles', 'Textiles-Woven', 'Textiles-Embroidered',
                 'Textiles-Printed', 'Textiles-Velvets', 'Textiles-Laces',
                 'Tapestries'],
  Metalwork:    ['Metalwork', 'Metalwork-Silver', 'Metalwork-Copper alloy',
                 'Metalwork-Iron', 'Metalwork-Gilt Bronze', 'Gold and Silver',
                 'Medals and Plaquettes'],
  Jewelry:      ['Jewelry', 'Gems'],
};

// Flat list of all user-visible category names.
// IMPORTANT: If you add or remove entries here, update MEDIUM_CATEGORIES below
// and CLASSIFICATION_EXPANSIONS above accordingly to keep them in sync.
const MEDIUM_TYPES = Object.keys(CLASSIFICATION_EXPANSIONS);

// IMPORTANT: If you add or remove entries in MEDIUM_TYPES, update MEDIUM_CATEGORIES
// accordingly to keep them in sync.
const MEDIUM_CATEGORIES = [
  { name: 'Fine Art',        media: ['Paintings', 'Drawings', 'Prints', 'Watercolors', 'Miniatures'] },
  { name: 'Photography',     media: ['Photographs'] },
  { name: 'Sculpture',       media: ['Sculpture'] },
  { name: 'Decorative Arts', media: ['Ceramics', 'Glass', 'Textiles', 'Metalwork', 'Jewelry'] },
];

// q=* is a true wildcard in this API, returning all 530K+ objects when used
// alone. hasImages=true reduces the unfiltered pool to ~3,260 objects, but
// those are the only ones guaranteed to have accessible public-domain images
// (~0.6% of the full collection). Without this filter, the retry loop would
// need hundreds of attempts on average to find a valid image.
const BROAD_QUERY = '*';

/**
 * Fetch a random artwork from the Metropolitan Museum of Art Open Access collection.
 *
 * The free-text `medium` field (e.g. "Oil on canvas") is returned in metadata
 * regardless of how filtering was applied.
 *
 * @param {string[]} [mediaFilter] - Optional list of classification values to
 *   restrict selection (e.g. ['Paintings', 'Drawings']). If omitted or empty,
 *   all objects with images are eligible. Each value is queried separately and
 *   results are unioned — the Met API treats pipe-delimited medium values as
 *   AND (intersection), not OR, so multi-classification queries must be split.
 * @param {object} [options]
 * @param {'all'|'landscape'|'portrait'} [options.aspectRatio='all'] - Filter by aspect ratio.
 *   Checked against the actual downloaded image dimensions via sharp.
 *   'landscape' = width > height. 'portrait' = height > width.
 *
 * @returns {{ imageBuffer, contentType, metadata: { title, creator, medium, dateCreated, artworkUrl, source } }}
 * @throws {Error} on network/API failure or if no suitable artwork is found.
 */
async function fetchRandomArtwork(mediaFilter = null, options = {}) {
  const { aspectRatio = 'all' } = options;
  let objectIDs;

  if (!mediaFilter || mediaFilter.length === 0) {
    // No filter: single search for all public-domain objects with images
    try {
      const response = await axios.get(`${BASE_URL}/search`, {
        params: { q: BROAD_QUERY, hasImages: true },
        timeout: 15000,
      });
      objectIDs = response.data.objectIDs || [];
    } catch (err) {
      throw new Error(`Failed to search Met Museum collection: ${err.message}`);
    }
  } else {
    // Filtered: one search per classification value, union the results.
    // The API's medium= parameter acts as AND for pipe-delimited values,
    // so each classification must be queried separately.
    const idSet = new Set();
    for (const classification of mediaFilter) {
      try {
        const response = await axios.get(`${BASE_URL}/search`, {
          params: { q: BROAD_QUERY, hasImages: true, medium: classification },
          timeout: 15000,
        });
        (response.data.objectIDs || []).forEach(id => idSet.add(id));
      } catch (err) {
        console.warn(`[met_museum] Search failed for classification "${classification}": ${err.message}`);
      }
    }
    objectIDs = Array.from(idSet);
  }

  if (!objectIDs.length) {
    throw new Error('No objects found matching the selected categories');
  }

  const MAX_ATTEMPTS = 20;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const objectId = objectIDs[Math.floor(Math.random() * objectIDs.length)];

    let obj;
    try {
      const response = await axios.get(`${BASE_URL}/objects/${objectId}`, {
        timeout: 15000,
      });
      obj = response.data;
    } catch (err) {
      console.warn(`[met_museum] Failed to fetch object ${objectId}: ${err.message}`);
      continue;
    }

    if (!obj.isPublicDomain || !obj.primaryImage) {
      console.warn(`[met_museum] Object ${objectId} skipped: isPublicDomain=${obj.isPublicDomain}, hasImage=${!!obj.primaryImage}`);
      continue;
    }

    let imageBuffer, contentType;
    try {
      const imageResponse = await axios.get(obj.primaryImage, {
        responseType: 'arraybuffer',
        timeout: 30000,
      });
      imageBuffer = Buffer.from(imageResponse.data);
      contentType = imageResponse.headers['content-type'] || 'image/jpeg';
    } catch (err) {
      console.warn(`[met_museum] Failed to download image for object ${objectId}: ${err.message}`);
      continue;
    }

    // Check aspect ratio from actual image dimensions (Met images are direct URLs
    // without a crop suffix, so the downloaded pixels reflect the original ratio).
    if (aspectRatio !== 'all') {
      try {
        const { width, height } = await sharp(imageBuffer).metadata();
        const isLandscape = width > height;
        if (aspectRatio === 'landscape' && !isLandscape) {
          console.warn(`[met_museum] Object ${objectId} skipped: not landscape (${width}x${height})`);
          continue;
        }
        if (aspectRatio === 'portrait' && isLandscape) {
          console.warn(`[met_museum] Object ${objectId} skipped: not portrait (${width}x${height})`);
          continue;
        }
      } catch (err) {
        console.warn(`[met_museum] Could not read dimensions for object ${objectId}: ${err.message}`);
        continue;
      }
    }

    return {
      imageBuffer,
      contentType,
      metadata: {
        title: obj.title || null,
        creator: obj.artistDisplayName || null,
        medium: obj.medium || null,
        dateCreated: obj.objectDate || null,
        artworkUrl: obj.objectURL || null,
        source: 'The Metropolitan Museum of Art',
      },
    };
  }

  throw new Error(`Could not find a suitable${aspectRatio !== 'all' ? ` ${aspectRatio}` : ''} public-domain artwork after ${MAX_ATTEMPTS} attempts`);
}

// Metadata fields this source can provide.
const metadataFields = [
  { key: 'title',       label: 'Title',        description: 'Artwork title' },
  { key: 'creator',     label: 'Creator',      description: 'Artist or creator name' },
  { key: 'medium',      label: 'Medium',       description: 'Material or technique (e.g. "Oil on canvas")' },
  { key: 'dateCreated', label: 'Date Created', description: 'Date or year the artwork was created' },
  { key: 'source',      label: 'Source',       description: 'Source collection name (always "The Metropolitan Museum of Art")' },
];

// Default mapping hints: source field key → suggested HA attribute name.
const defaultMapping = {
  title:       'title',
  creator:     'artist',
  medium:      'medium',
  dateCreated: 'year',
  source:      null,
};

// Settings schema for the web source settings dialog.
const settingsSchema = {
  mediaCategories: MEDIUM_CATEGORIES,
};

/**
 * Convert stored source settings to fetcher call options.
 *
 * settings.disabledMedia: string[] — category names to exclude.
 * Each category name is expanded to its full set of classification values
 * via CLASSIFICATION_EXPANSIONS before being passed to fetchRandomArtwork.
 * Returns { mediaFilter: string[] }, or {} if no restriction applies.
 */
function buildFetcherOptions(settings) {
  const disabledMedia = settings?.disabledMedia;
  if (!disabledMedia || disabledMedia.length === 0) return {};
  const disabledSet = new Set(disabledMedia.map(m => m.toLowerCase()));
  const enabledCategories = MEDIUM_TYPES.filter(m => !disabledSet.has(m.toLowerCase()));
  if (enabledCategories.length === MEDIUM_TYPES.length) return {};
  const classificationFilter = enabledCategories.flatMap(c => CLASSIFICATION_EXPANSIONS[c] || [c]);
  return classificationFilter.length > 0 ? { mediaFilter: classificationFilter } : {};
}

/**
 * Fetch a specific artwork by Met Museum object ID.
 * Skips the random selection loop and retrieves the exact object.
 * Throws if the object is not public domain, has no image, or download fails.
 *
 * @param {number|string} objectId - The numeric Met Museum object ID
 * @returns {{ imageBuffer, contentType, metadata }}
 */
async function fetchByObjectId(objectId) {
  let obj;
  try {
    const response = await axios.get(`${BASE_URL}/objects/${objectId}`, { timeout: 15000 });
    obj = response.data;
  } catch (err) {
    throw new Error(`Failed to fetch Met Museum object ${objectId}: ${err.message}`);
  }
  if (!obj.isPublicDomain) throw new Error(`Object ${objectId} is not public domain`);
  if (!obj.primaryImage) throw new Error(`Object ${objectId} has no primary image`);

  let imageBuffer, contentType;
  try {
    const imageResponse = await axios.get(obj.primaryImage, { responseType: 'arraybuffer', timeout: 30000 });
    imageBuffer = Buffer.from(imageResponse.data);
    contentType = imageResponse.headers['content-type'] || 'image/jpeg';
  } catch (err) {
    throw new Error(`Failed to download image for Met Museum object ${objectId}: ${err.message}`);
  }

  return {
    imageBuffer,
    contentType,
    metadata: {
      title: obj.title || null,
      creator: obj.artistDisplayName || null,
      medium: obj.medium || null,
      dateCreated: obj.objectDate || null,
      artworkUrl: obj.objectURL || null,
      source: 'The Metropolitan Museum of Art',
    },
  };
}

/**
 * Returns true if this source can fetch the given identifier.
 * Accepts Met Museum collection URLs and bare numeric object IDs.
 */
function canHandleIdentifier(identifier) {
  const t = identifier.trim();
  return /metmuseum\.org\/art\/collection\/search\/\d+/i.test(t) || /^\d+$/.test(t);
}

// fetchByObjectId is the canonical specific-fetch function for this source.
// It accepts a numeric ID (from canHandleIdentifier) or a Met Museum URL
// (caller should extract the ID first, or pass the full URL — the ID is parsed here).
const _fetchByObjectIdOriginal = fetchByObjectId;

/**
 * Fetch a specific artwork by Met Museum object ID or collection URL.
 * Delegates to fetchByObjectId after extracting the ID from a URL if needed.
 */
async function fetchByIdentifier(identifier) {
  const t = identifier.trim();
  const urlMatch = t.match(/metmuseum\.org\/art\/collection\/search\/(\d+)/i);
  const objectId = urlMatch ? urlMatch[1] : t;
  return _fetchByObjectIdOriginal(objectId);
}

module.exports = { fetchRandomArtwork, fetchByObjectId, fetchByIdentifier, canHandleIdentifier, MEDIUM_TYPES, MEDIUM_CATEGORIES, metadataFields, defaultMapping, settingsSchema, buildFetcherOptions };