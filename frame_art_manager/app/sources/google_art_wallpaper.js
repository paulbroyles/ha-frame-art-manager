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
 *   { imageBuffer, contentType, metadata: { title, creator, attribution, artworkUrl, source } }
 *
 * Throws on network errors, if the list is empty, or if aspectRatio is 'portrait'.
 */
async function fetchRandomArtwork(_mediaFilter = null, options = {}) {
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

  return {
    imageBuffer,
    contentType,
    metadata: {
      title: entry.title || null,
      creator: entry.creator || null,
      attribution: entry.attribution || null,
      artworkUrl,
      source: 'Google Art Wallpaper',
    },
  };
}

// Metadata fields this source can provide.
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
 * @returns {{ imageBuffer, contentType, metadata }}
 * @throws {Error} if no matching entry is found, or on download failure.
 */
async function fetchByIdentifier(identifier) {
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

  return {
    imageBuffer,
    contentType,
    metadata: {
      title: entry.title || null,
      creator: entry.creator || null,
      attribution: entry.attribution || null,
      artworkUrl,
      source: 'Google Art Wallpaper',
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

module.exports = { fetchRandomArtwork, fetchByIdentifier, canHandleIdentifier, metadataFields, defaultMapping, alreadyProcessed };
