const axios = require('axios');

const WALLPAPER_LIST_URL = 'https://www.gstatic.com/culturalinstitute/tabext/imax_2_2.json';
const BASE_URL = 'https://artsandculture.google.com';

const HTTP_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
};

/**
 * Fetch a random artwork from the Google Art Wallpaper list (imax_2_2.json).
 * This is a curated list of ~349 widescreen artworks formatted for large displays.
 *
 * All images are center-cropped to 3840×2160 (landscape) via the URL suffix.
 * This source is incompatible with portrait filtering and is automatically skipped
 * when the aspect ratio filter is set to 'portrait' (enforced in web_sources.js via
 * aspectRatioConstraint: 'landscape' on the BUILTIN_SOURCES entry). This function
 * still rejects portrait explicitly as a defensive guard.
 *
 * @param {string[]} [_mediaFilter] - Ignored; no media filtering for this source.
 * @param {object} [options]
 * @param {'all'|'landscape'|'portrait'} [options.aspectRatio='all']
 *
 * Returns:
 *   { imageBuffer, contentType, metadata: { title, creator, attribution, artworkUrl, source, [rich fields] } }
 *   Rich fields (type, medium, dateCreated, etc.) are included when options.fetchRichMetadata is true.
 *
 * Throws on network errors, if the list is empty, or if aspectRatio is 'portrait'.
 */
async function fetchRandomArtwork(_filters = [], options = {}) {
  const { aspectRatio = 'all' } = options;
  if (aspectRatio === 'portrait') {
    throw new Error(
      'Google Art Wallpaper only provides landscape artworks (all images are cropped to 3840×2160); portrait filter cannot be satisfied'
    );
  }
  let wallpaperList;
  try {
    const response = await axios.get(WALLPAPER_LIST_URL, {
      headers: HTTP_HEADERS,
      timeout: 15000,
      responseType: 'json',
    });
    wallpaperList = response.data;
  } catch (err) {
    throw new Error(`Failed to fetch Google Art Wallpaper list: ${err.message}`);
  }

  if (!Array.isArray(wallpaperList) || wallpaperList.length === 0) {
    throw new Error('Google Art Wallpaper list is empty or invalid');
  }

  const entry = wallpaperList[Math.floor(Math.random() * wallpaperList.length)];

  if (!entry.image) {
    throw new Error('Selected wallpaper entry has no image URL');
  }

  const imageUrl = `${entry.image}=w3840-h2160-c`;
  const artworkUrl = entry.link ? `${BASE_URL}/${entry.link}` : null;

  let imageBuffer, contentType;
  try {
    const imageResponse = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      headers: HTTP_HEADERS,
      timeout: 30000,
    });
    imageBuffer = Buffer.from(imageResponse.data);
    contentType = imageResponse.headers['content-type'] || 'image/jpeg';
  } catch (err) {
    throw new Error(`Failed to download wallpaper image: ${err.message}`);
  }

  const richMetadata = options.fetchRichMetadata && artworkUrl
    ? await enrichWithGoogleArts(artworkUrl)
    : {};

  return {
    imageBuffer,
    contentType,
    metadata: {
      title: entry.title || null,
      creator: entry.creator || null,
      attribution: entry.attribution || null,
      artworkUrl,
      source: 'Google Art Wallpaper',
      ...richMetadata,
    },
  };
}

// Base metadata fields always provided by this source.
const metadataFields = [
  { key: 'title',       label: 'Title',       description: 'Artwork title' },
  { key: 'creator',     label: 'Creator',     description: 'Artist or creator name' },
  { key: 'attribution', label: 'Attribution', description: 'Attribution line' },
  { key: 'source',      label: 'Source',      description: 'Source collection name (always "Google Art Wallpaper")' },
];

// Default mapping hints: source field key → suggested HA attribute name.
const defaultMapping = {
  title:       'title',
  creator:     'artist',
  attribution: null,
  source:      null,
};

/**
 * Returns the effective metadata fields for this source given its stored settings.
 * When fetchRichMetadata is enabled, appends google_arts metadata fields (lazy-loaded)
 * so the mapping UI reflects what will actually be fetched.
 *
 * @param {object} settings - Stored source settings
 * @returns {Array} Metadata field descriptors
 */
function getMetadataFields(settings) {
  if (!settings?.fetchRichMetadata) return metadataFields;

  let googleArts;
  try {
    googleArts = require('./google_arts');
  } catch (_) {
    return metadataFields;
  }

  const baseKeys = new Set(metadataFields.map(f => f.key));
  const richFields = (googleArts.metadataFields || []).filter(f => !baseKeys.has(f.key));
  return [...metadataFields, ...richFields];
}

// Settings schema for the source's settings UI.
const settingsSchema = {
  fields: [
    {
      key:            'fetchRichMetadata',
      type:           'boolean',
      default:        false,
      requiresSource: 'google_arts',
      label:          'Fetch rich metadata from Google Arts & Culture',
      description:    'Queries the Google Arts & Culture API for extended artwork details (type, medium, date, nationality, dimensions, description). Requires Google Arts & Culture to be enabled as a web source.',
    },
  ],
};

/**
 * Returns the filter types this source supports.
 * Google Art Wallpaper is a fixed curated list with no filterable dimensions,
 * so no filter types are supported.
 */
/**
 * Examine the full merged filter set and determine the best API strategy.
 * Google Art Wallpaper always uses the static curated list; no filters affect mode.
 *
 * @param {Array<{type, mode, values}>} filters - Merged filters from all cascade levels.
 * @returns {{ mode: string, apiFilters: Array, postFilters: Array }}
 */
function selectMode(filters = []) {
  return { mode: 'list', apiFilters: [], postFilters: [] };
}

function getFilterTypes() {
  return [];
}

/**
 * Returns non-filter fetch options derived from stored source settings.
 * Called by the route layer to pass source-specific options to fetchRandomArtwork.
 */
function getExtraOptions(settings) {
  return { fetchRichMetadata: !!settings?.fetchRichMetadata };
}

/**
 * Enrich basic wallpaper metadata with extended fields from Google Arts & Culture.
 * Lazy-loads google_arts only when called. Returns {} on any failure.
 */
async function enrichWithGoogleArts(artworkUrl) {
  let googleArts;
  try {
    googleArts = require('./google_arts');
  } catch (err) {
    console.warn('[google_art_wallpaper] Could not load google_arts module:', err.message);
    return {};
  }
  if (typeof googleArts.fetchArtworkMetadata !== 'function') {
    console.warn('[google_art_wallpaper] google_arts.fetchArtworkMetadata is not available');
    return {};
  }
  try {
    return await googleArts.fetchArtworkMetadata(artworkUrl);
  } catch (err) {
    console.warn('[google_art_wallpaper] Rich metadata fetch failed:', err.message);
    return {};
  }
}

// Images from this source are already cropped to 3840×2160 by the URL suffix.
// The processing pipeline should skip them to avoid re-cropping pre-sized images.
const alreadyProcessed = true;

/**
 * Fetch a specific artwork from the Google Art Wallpaper list by its artwork URL.
 *
 * Identifier format accepted:
 *   - Full Google Arts artwork URL: https://artsandculture.google.com/<path>
 *     (the artworkUrl field shown in test results after a random fetch)
 *
 * The wallpaper list is downloaded and searched for an entry whose link matches
 * the path portion of the identifier. The match is normalized to handle leading
 * slashes on either side.
 *
 * @param {string} identifier - Full Google Arts URL previously shown as artworkUrl
 * @param {object} [options]
 * @param {object} [options.settings] - Stored source settings; respects fetchRichMetadata flag.
 * @returns {{ imageBuffer, contentType, metadata }}
 * @throws {Error} if no matching entry is found, or on download failure.
 */
async function fetchByIdentifier(identifier, { settings } = {}) {
  let wallpaperList;
  try {
    const response = await axios.get(WALLPAPER_LIST_URL, {
      headers: HTTP_HEADERS,
      timeout: 15000,
      responseType: 'json',
    });
    wallpaperList = response.data;
  } catch (err) {
    throw new Error(`Failed to fetch Google Art Wallpaper list: ${err.message}`);
  }

  if (!Array.isArray(wallpaperList) || wallpaperList.length === 0) {
    throw new Error('Google Art Wallpaper list is empty or invalid');
  }

  // Normalize: strip scheme + host, then strip leading slash for comparison.
  const inputPath = identifier.trim()
    .replace(/^https?:\/\/[^/]+/, '')
    .replace(/^\//, '');

  const entry = wallpaperList.find(e => {
    if (!e.link) return false;
    const entryPath = e.link.replace(/^\//, '');
    return entryPath === inputPath;
  });

  if (!entry) {
    throw new Error(
      `No Google Art Wallpaper entry found matching "${identifier}". ` +
      `The URL must match the artworkUrl of a wallpaper entry exactly.`
    );
  }

  if (!entry.image) {
    throw new Error('Matched wallpaper entry has no image URL');
  }

  const imageUrl = `${entry.image}=w3840-h2160-c`;
  const artworkUrl = entry.link ? `${BASE_URL}/${entry.link.replace(/^\//, '')}` : null;

  let imageBuffer, contentType;
  try {
    const imageResponse = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      headers: HTTP_HEADERS,
      timeout: 30000,
    });
    imageBuffer = Buffer.from(imageResponse.data);
    contentType = imageResponse.headers['content-type'] || 'image/jpeg';
  } catch (err) {
    throw new Error(`Failed to download wallpaper image: ${err.message}`);
  }

  const richMetadata = settings?.fetchRichMetadata && artworkUrl ? await enrichWithGoogleArts(artworkUrl) : {};

  return {
    imageBuffer,
    contentType,
    metadata: {
      title: entry.title || null,
      creator: entry.creator || null,
      attribution: entry.attribution || null,
      artworkUrl,
      source: 'Google Art Wallpaper',
      ...richMetadata,
    },
  };
}

/**
 * Returns true if this source can fetch the given identifier.
 * Accepts any artsandculture.google.com URL that is not an /asset/ path
 * (those are handled by google_arts). In practice this covers wallpaper
 * artworkUrls such as /streetview/ and /culturalinstitute/ paths.
 */
function canHandleIdentifier(identifier) {
  const t = identifier.trim();
  return /artsandculture\.google\.com/i.test(t) && !/artsandculture\.google\.com\/asset\//i.test(t);
}

// All entries are center-cropped to 3840×2160 — landscape only.
const aspectRatioConstraint = 'landscape';

module.exports = { fetchRandomArtwork, fetchByIdentifier, canHandleIdentifier, selectMode, getMetadataFields, getFilterTypes, getExtraOptions, metadataFields, defaultMapping, settingsSchema, alreadyProcessed, aspectRatioConstraint };
