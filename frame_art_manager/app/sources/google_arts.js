const axios = require('axios');

// Painting medium categories from artsandculture.google.com/category/medium
const PAINTING_MEDIA = [
  'oil paint',
  'watercolor',
  'gouache',
  'tempera',
  'acrylic paint',
  'fresco',
  'distemper',
  'encaustic painting',
  'ink wash painting',
  'pastel',
  'oil pastel',
  'enamel paint',
  'panel painting',
];

// Subject/style/period modifiers appended to medium queries to diversify results.
// Each combination yields a largely different pool (~90%+ unique artworks vs. the unmodified query),
// so randomly picking a modifier greatly expands effective coverage beyond the fixed first page.
const QUERY_MODIFIERS = [
  // Subjects
  'portrait', 'landscape', 'still life', 'figure', 'nude',
  'mythology', 'religious', 'biblical', 'allegory', 'genre scene',
  'cityscape', 'seascape', 'animal', 'flower', 'interior',
  // Styles / movements
  'renaissance', 'baroque', 'rococo', 'romanticism', 'impressionism',
  'post-impressionism', 'expressionism', 'realism', 'symbolism', 'mannerism',
  'neoclassicism', 'surrealism', 'abstract', 'modernism', 'pre-raphaelite',
  // Regions / schools
  'Italian', 'Dutch', 'Flemish', 'French', 'Spanish',
  'English', 'German', 'American', 'Japanese', 'Chinese',
];

const BASE_URL = 'https://artsandculture.google.com';

const HTTP_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
};

/**
 * Parse the Google Arts & Culture API response.
 * Responses start with )]}'\n (XSSI protection prefix).
 */
function parseApiResponse(data) {
  const prefix = ")]}'\n";
  if (typeof data === 'string' && data.startsWith(prefix)) {
    data = data.slice(prefix.length);
  }
  return typeof data === 'string' ? JSON.parse(data) : data;
}

/**
 * Recursively extract artwork objects from a parsed API response.
 * Cobjects: ['stella.common.cobject', title, creator, imageUrl, link, ...]
 * Only /asset/ links are kept (not /story/ or other types).
 */
function extractArtworks(obj, depth = 0) {
  const artworks = [];
  if (depth > 15 || !obj) return artworks;

  if (Array.isArray(obj)) {
    if (
      obj[0] === 'stella.common.cobject' &&
      typeof obj[4] === 'string' && obj[4].startsWith('/asset/') &&
      typeof obj[3] === 'string'
    ) {
      const imageBase = obj[3].startsWith('//') ? `https:${obj[3]}` : obj[3];
      artworks.push({
        title: obj[1] || null,
        creator: obj[2] || null,
        imageBase,
        link: obj[4],
      });
      return artworks;
    }
    for (const item of obj) {
      artworks.push(...extractArtworks(item, depth + 1));
    }
  }
  return artworks;
}

/**
 * Fetch a random painting from Google Arts & Culture.
 * Picks a random painting medium, searches for it, then picks a random result.
 *
 * Returns:
 *   { imageBuffer, contentType, metadata: { title, creator, artworkUrl, medium, source } }
 *
 * Throws on network errors or if no suitable artwork is found.
 */
async function fetchRandomArtwork() {
  const medium = PAINTING_MEDIA[Math.floor(Math.random() * PAINTING_MEDIA.length)];
  const modifier = QUERY_MODIFIERS[Math.floor(Math.random() * QUERY_MODIFIERS.length)];
  const query = `${medium} ${modifier}`;

  let parsed;
  try {
    const response = await axios.get(`${BASE_URL}/api/search`, {
      params: { q: query, hl: 'en' },
      headers: { ...HTTP_HEADERS, Accept: 'application/json, text/plain, */*' },
      timeout: 15000,
      responseType: 'text',
    });
    parsed = parseApiResponse(response.data);
  } catch (err) {
    throw new Error(`Failed to search Google Arts & Culture for "${query}": ${err.message}`);
  }

  const artworks = extractArtworks(parsed);
  if (artworks.length === 0) {
    throw new Error(`No artworks found for "${query}"`);
  }

  const artwork = artworks[Math.floor(Math.random() * artworks.length)];
  const imageUrl = `${artwork.imageBase}=w3840-h2160-c`;
  const artworkUrl = `${BASE_URL}${artwork.link}`;

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
    throw new Error(`Failed to download artwork image: ${err.message}`);
  }

  return {
    imageBuffer,
    contentType,
    metadata: {
      title: artwork.title,
      creator: artwork.creator,
      artworkUrl,
      medium,
      source: 'Google Arts & Culture',
    },
  };
}

module.exports = { fetchRandomArtwork };
