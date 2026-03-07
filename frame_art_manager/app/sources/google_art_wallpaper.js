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
 * Returns:
 *   { imageBuffer, contentType, metadata: { title, creator, attribution, artworkUrl, source } }
 *
 * Throws on network errors or if the list is empty.
 */
async function fetchRandomArtwork() {
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

module.exports = { fetchRandomArtwork };
