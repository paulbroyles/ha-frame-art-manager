'use strict';
const axios = require('axios');
const sharp = require('sharp');

// J. Paul Getty Museum — Los Angeles, California
// Open Content Program: ~91,500 CC0 public-domain images
//
// API: https://www.getty.edu/art/collection/api/search
//   ?open_content=true                    — restrict to open-access artworks
//   &from={offset}                        — pagination offset (0-based)
//   &size={n}                             — results per page
//   &q={term}                             — full-text search
//   &classification_and_object_type={v}   — type filter (exact, case-sensitive)
//   &decade_range={decade}                — era filter (decade start year, e.g. 1870)
//
// Images: IIIF via https://media.getty.edu/iiif/image/{uuid}/full/!4800,4800/0/default.jpg
// Artwork URL: https://www.getty.edu/art/collection/object/{slug}

const SEARCH_URL      = 'https://www.getty.edu/art/collection/api/search';
const IIIF_IMAGE_BASE = 'https://media.getty.edu/iiif/image';
const ARTWORK_BASE    = 'https://www.getty.edu/art/collection';

// Cached total open-access count — updated from live API responses.
// Initial value verified March 2026; the real figure is fetched on first browse.
let _knownBrowseTotal = 91524;

// Object type values for classification_and_object_type filter.
// These are the known values from the API (case-sensitive, singular).
// Grouped for the UI filter builder.
const OBJECT_TYPE_VALUES = [
  { value: 'Painting',              label: 'Painting' },
  { value: 'Drawing',               label: 'Drawing' },
  { value: 'Print',                 label: 'Print' },
  { value: 'Photograph',            label: 'Photograph' },
  { value: 'Sculpture',             label: 'Sculpture' },
  { value: 'Stereograph',           label: 'Stereograph' },
  { value: 'Illuminated Manuscript', label: 'Illuminated Manuscript' },
  { value: 'Folio',                 label: 'Folio' },
  { value: 'Vessel',                label: 'Vessel' },
];

const OBJECT_TYPE_GROUPS = [
  { name: 'Fine Art',     values: ['Painting', 'Drawing', 'Print', 'Sculpture'] },
  { name: 'Photography',  values: ['Photograph', 'Stereograph'] },
  { name: 'Manuscripts',  values: ['Illuminated Manuscript', 'Folio'] },
  { name: 'Decorative',   values: ['Vessel'] },
];

// Era values: decade start years covering the full Getty collection range.
// The API accepts a single decade_range value (e.g. 1870 = the 1870s).
// Grouped by broad art-historical period for the UI.
const ERA_VALUES = [
  // Ancient & Medieval
  { value: '0',    label: 'Ancient (0s)' },
  { value: '100',  label: '100s' },
  { value: '200',  label: '200s' },
  { value: '300',  label: '300s' },
  { value: '400',  label: '400s' },
  { value: '500',  label: '500s' },
  { value: '600',  label: '600s' },
  { value: '700',  label: '700s' },
  { value: '800',  label: '800s' },
  { value: '900',  label: '900s' },
  { value: '1000', label: '1000s' },
  { value: '1100', label: '1100s' },
  { value: '1200', label: '1200s' },
  { value: '1300', label: '1300s' },
  // Renaissance
  { value: '1400', label: '1400s' },
  { value: '1410', label: '1410s' },
  { value: '1420', label: '1420s' },
  { value: '1430', label: '1430s' },
  { value: '1440', label: '1440s' },
  { value: '1450', label: '1450s' },
  { value: '1460', label: '1460s' },
  { value: '1470', label: '1470s' },
  { value: '1480', label: '1480s' },
  { value: '1490', label: '1490s' },
  { value: '1500', label: '1500s' },
  { value: '1510', label: '1510s' },
  { value: '1520', label: '1520s' },
  { value: '1530', label: '1530s' },
  { value: '1540', label: '1540s' },
  { value: '1550', label: '1550s' },
  { value: '1560', label: '1560s' },
  { value: '1570', label: '1570s' },
  { value: '1580', label: '1580s' },
  { value: '1590', label: '1590s' },
  // Baroque & Early Modern
  { value: '1600', label: '1600s' },
  { value: '1610', label: '1610s' },
  { value: '1620', label: '1620s' },
  { value: '1630', label: '1630s' },
  { value: '1640', label: '1640s' },
  { value: '1650', label: '1650s' },
  { value: '1660', label: '1660s' },
  { value: '1670', label: '1670s' },
  { value: '1680', label: '1680s' },
  { value: '1690', label: '1690s' },
  { value: '1700', label: '1700s' },
  { value: '1710', label: '1710s' },
  { value: '1720', label: '1720s' },
  { value: '1730', label: '1730s' },
  { value: '1740', label: '1740s' },
  { value: '1750', label: '1750s' },
  { value: '1760', label: '1760s' },
  { value: '1770', label: '1770s' },
  { value: '1780', label: '1780s' },
  { value: '1790', label: '1790s' },
  // 19th Century
  { value: '1800', label: '1800s' },
  { value: '1810', label: '1810s' },
  { value: '1820', label: '1820s' },
  { value: '1830', label: '1830s' },
  { value: '1840', label: '1840s' },
  { value: '1850', label: '1850s' },
  { value: '1860', label: '1860s' },
  { value: '1870', label: '1870s' },
  { value: '1880', label: '1880s' },
  { value: '1890', label: '1890s' },
  // 20th Century
  { value: '1900', label: '1900s' },
  { value: '1910', label: '1910s' },
  { value: '1920', label: '1920s' },
  { value: '1930', label: '1930s' },
  { value: '1940', label: '1940s' },
  { value: '1950', label: '1950s' },
  { value: '1960', label: '1960s' },
  { value: '1970', label: '1970s' },
  { value: '1980', label: '1980s' },
  { value: '1990', label: '1990s' },
  { value: '2000', label: '2000s' },
];

const ERA_GROUPS = [
  { name: 'Ancient & Medieval',  values: ['0','100','200','300','400','500','600','700','800','900','1000','1100','1200','1300'] },
  { name: 'Renaissance (1400s)', values: ['1400','1410','1420','1430','1440','1450','1460','1470','1480','1490'] },
  { name: '1500s',               values: ['1500','1510','1520','1530','1540','1550','1560','1570','1580','1590'] },
  { name: '1600s',               values: ['1600','1610','1620','1630','1640','1650','1660','1670','1680','1690'] },
  { name: '1700s',               values: ['1700','1710','1720','1730','1740','1750','1760','1770','1780','1790'] },
  { name: '1800s',               values: ['1800','1810','1820','1830','1840','1850','1860','1870','1880','1890'] },
  { name: '1900s',               values: ['1900','1910','1920','1930','1940','1950','1960','1970','1980','1990'] },
  { name: '2000s',               values: ['2000'] },
];

// ── Query building ────────────────────────────────────────────────────────────

// Map from objectType value to the Getty curatorial department name.
// Using `department` instead of `classification_and_object_type` returns only
// works from that curatorial department — excluding fragments, decorative objects,
// and Antiquities pieces that happen to share a classification label.
// Types without a department mapping fall back to classification_and_object_type.
const OBJECT_TYPE_TO_DEPARTMENT = {
  'Painting':              'Paintings',
  'Drawing':               'Drawings',
  'Photograph':            'Photographs',
  'Illuminated Manuscript': 'Manuscripts',
};

/**
 * Build axios params for the search API from the active filter set.
 * open_content=true is always included.
 *
 * Filter → API parameter mapping:
 *   artist     → q= (text search)
 *   search     → q= (text search)
 *   objectType → department= (curatorial dept, for types with a dept mapping)
 *                classification_and_object_type= (exact, case-sensitive, fallback)
 *   era        → decade_range= (decade start year, e.g. 1870)
 *
 * Using department= for major types avoids fragments and mis-classified objects
 * that share a classification label with canonical works (e.g. fresco fragments
 * in the Antiquities dept labeled "Painting").
 */
function buildSearchParams(filters) {
  const params = { open_content: true };

  const artistFilter  = filters.find(f => f.type === 'artist'     && f.mode === 'require');
  const searchFilter  = filters.find(f => f.type === 'search'     && f.mode === 'require');
  const typeFilter    = filters.find(f => f.type === 'objectType' && f.mode === 'require');
  const eraFilter     = filters.find(f => f.type === 'era'        && f.mode === 'require');

  const terms = [];
  if (artistFilter?.values?.[0]) terms.push(artistFilter.values[0].trim());
  if (searchFilter?.values?.[0]) terms.push(searchFilter.values[0].trim());
  if (terms.length > 0) params.q = terms.join(' ');

  if (typeFilter?.values?.[0]) {
    const typeValue = typeFilter.values[0];
    const dept = OBJECT_TYPE_TO_DEPARTMENT[typeValue];
    if (dept) {
      // Use department filter — returns only works from the curatorial dept,
      // excluding fragments and mis-classified objects from other departments.
      params.department = dept;
    } else {
      // Fall back to classification for types without a department mapping
      // (Print, Sculpture, Stereograph, Folio, Vessel).
      params.classification_and_object_type = typeValue;
    }
  }

  // decade_range accepts a decade start year as a string (e.g. "1870" for the 1870s)
  if (eraFilter?.values?.[0]) {
    params.decade_range = eraFilter.values[0];
  }

  return params;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Fetch a random artwork from the Getty Museum open-access collection.
 *
 * Selection strategy:
 *   Browse mode (no text query): pick a random offset in the full ~91,500-item
 *   open-content pool. The page total is cached and refreshed from each response.
 *
 *   Filtered mode (any filter active): first fetch size=0 to get the filtered
 *   total, then pick a random offset within it.
 *
 * objectType and era filters are native API parameters — they narrow the pool
 * server-side before random selection. artist and search are q= text queries.
 *
 * Aspect ratio is determined post-download via sharp (IIIF responses don't
 * include dimensions in the search result).
 *
 * @param {Array<{type, mode, values}>} [filters=[]]
 *   Supported types: 'objectType', 'era', 'artist' (require), 'search' (require)
 * @param {{ aspectRatio?: 'all'|'landscape'|'portrait' }} [options={}]
 */
async function fetchRandomArtwork(filters = [], options = {}) {
  const { aspectRatio = 'all' } = options;
  const params = buildSearchParams(filters);
  const isFiltered = !!(params.q || params.classification_and_object_type || params.department || params.decade_range);

  // Pure browse: use cached total, no preflight needed.
  // Any filter: preflight size=0 to get the filtered pool size.
  let total = _knownBrowseTotal;
  if (isFiltered) {
    const countResp = await axios.get(SEARCH_URL, {
      params: { ...params, size: 0 },
      timeout: 15000,
    });
    total = countResp.data.total || 0;
    if (total === 0) throw new Error('No Getty artworks match the selected filters');
  }

  const MAX_ATTEMPTS = 10;
  const PAGE_SIZE = 10;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const offset = Math.floor(Math.random() * total);

    let items;
    try {
      const resp = await axios.get(SEARCH_URL, {
        params: { ...params, from: offset, size: PAGE_SIZE },
        timeout: 15000,
      });
      if (!isFiltered && resp.data.total) _knownBrowseTotal = resp.data.total;
      items = resp.data.data || [];
    } catch (e) {
      console.warn(`[getty] Search request failed: ${e.message}`);
      continue;
    }

    if (items.length === 0) continue;

    // Shuffle the page so we don't always start at the same position
    items = [...items].sort(() => Math.random() - 0.5);

    for (const item of items) {
      const uuid = item.manifest?.thumbUuid;
      if (!uuid) continue;

      const imageUrl = `${IIIF_IMAGE_BASE}/${uuid}/full/!4800,4800/0/default.jpg`;
      let imageBuffer;
      try {
        const imgResp = await axios.get(imageUrl, {
          responseType: 'arraybuffer',
          timeout: 45000,
        });
        imageBuffer = Buffer.from(imgResp.data);
      } catch (e) {
        console.warn(`[getty] Image download failed (${uuid}): ${e.message}`);
        continue;
      }

      if (aspectRatio !== 'all') {
        const { width, height } = await sharp(imageBuffer).metadata();
        const isLandscape = width > height;
        if (aspectRatio === 'landscape' && !isLandscape) continue;
        if (aspectRatio === 'portrait'  &&  isLandscape) continue;
      }

      return {
        imageBuffer,
        contentType: 'image/jpeg',
        metadata: buildMetadata(item),
      };
    }
  }

  throw new Error(
    `Could not find a suitable${aspectRatio !== 'all' ? ` ${aspectRatio}` : ''} Getty artwork after ${MAX_ATTEMPTS} attempts`
  );
}

/**
 * Build the metadata object from a search result item.
 */
function buildMetadata(item) {
  const producer = item.producers?.[0] || null;
  return {
    title:           item.primary_name      || null,
    creator:         producer?.primary_name || null,
    dateCreated:     item.date_created      || null,
    culture:         item.culture?.[0]      || null,
    accessionNumber: item.object_number     || null,
    artworkUrl:      `${ARTWORK_BASE}${item.slug_with_path || ''}`,
    source:          'J. Paul Getty Museum',
  };
}

/**
 * Returns true if this source can handle the given identifier.
 * Accepts Getty collection URLs and short object slugs (e.g. "103QTM").
 */
function canHandleIdentifier(identifier) {
  const t = identifier.trim();
  return /getty\.edu\/art\/collection\/object\/[A-Z0-9]+/i.test(t)
    || /^[A-Z0-9]{4,8}$/i.test(t);
}

/**
 * Fetch a specific Getty artwork by its URL or short slug (e.g. "103QTM").
 */
async function fetchByIdentifier(identifier, options = {}) {
  const t = identifier.trim();
  const urlMatch = t.match(/\/object\/([A-Z0-9]+)/i);
  const slug = (urlMatch?.[1] || t).toUpperCase();

  const resp = await axios.get(SEARCH_URL, {
    params: { q: slug, open_content: true, size: 25 },
    timeout: 15000,
  });

  const item = resp.data.data?.find(r => r.id_manager_slug?.toUpperCase() === slug);
  if (!item) {
    throw new Error(
      `Getty object "${slug}" not found in the open-access collection. ` +
      `Confirm the URL is for a public-domain work on getty.edu/art/collection.`
    );
  }

  const { aspectRatio = 'all' } = options;
  const uuid = item.manifest?.thumbUuid;
  if (!uuid) throw new Error(`Getty object "${slug}" has no image`);

  const imageUrl = `${IIIF_IMAGE_BASE}/${uuid}/full/!4800,4800/0/default.jpg`;
  const imgResp = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 45000 });
  const imageBuffer = Buffer.from(imgResp.data);

  if (aspectRatio !== 'all') {
    const { width, height } = await sharp(imageBuffer).metadata();
    const isLandscape = width > height;
    if (aspectRatio === 'landscape' && !isLandscape) {
      throw new Error(`Object ${slug} is portrait; landscape filter cannot be satisfied`);
    }
    if (aspectRatio === 'portrait' && isLandscape) {
      throw new Error(`Object ${slug} is landscape; portrait filter cannot be satisfied`);
    }
  }

  return {
    imageBuffer,
    contentType: 'image/jpeg',
    metadata: buildMetadata(item),
  };
}

/**
 * Suggest Getty artist/photographer names matching the query.
 * Uses the artist facet from a text search.
 */
async function suggestArtists(query, limit = 10) {
  const q = (query || '').trim();
  if (!q) return [];

  try {
    const resp = await axios.get(SEARCH_URL, {
      params: { q, open_content: true, size: 0 },
      timeout: 10000,
    });
    const artistFacets = resp.data.facets?.artist || [];
    return artistFacets
      .filter(f => f.value && f.value !== 'Unknown')
      .slice(0, limit)
      .map(f => ({ name: f.value, count: f.count, source: 'getty' }));
  } catch {
    return [];
  }
}

/**
 * Count open-access Getty artworks for a given artist name.
 */
async function countArtistArtworks(artistName) {
  const q = (artistName || '').trim();
  if (!q) return null;

  try {
    const resp = await axios.get(SEARCH_URL, {
      params: { q, open_content: true, size: 0 },
      timeout: 10000,
    });
    return resp.data.total || null;
  } catch {
    return null;
  }
}

/**
 * Returns the API strategy for the given filter set.
 */
function selectMode(filters = []) {
  const hasText = filters.some(f =>
    ['artist', 'search'].includes(f.type) && f.mode === 'require' && f.values?.[0]
  );
  const hasApiFilter = filters.some(f =>
    ['objectType', 'era'].includes(f.type) && f.mode === 'require' && f.values?.[0]
  );
  return {
    mode: hasText ? 'search' : hasApiFilter ? 'filter' : 'browse',
    apiFilters: filters.filter(f =>
      ['artist', 'search', 'objectType', 'era'].includes(f.type)
    ),
    postFilters: [],
  };
}

function getFilterTypes() {
  return [
    {
      type: 'objectType',
      label: 'Object Type',
      description: 'Filter by artwork type. Mapped to the Getty\'s classification system.',
      modes: ['require'],
      multiValue: false,
      modeDetermining: false,
      values: OBJECT_TYPE_VALUES,
      groups: OBJECT_TYPE_GROUPS,
    },
    {
      type: 'era',
      label: 'Era',
      description: 'Filter by decade of creation (e.g. 1870s). Covers ancient to modern.',
      modes: ['require'],
      multiValue: false,
      modeDetermining: false,
      values: ERA_VALUES,
      groups: ERA_GROUPS,
    },
    {
      type: 'artist',
      label: 'Artist / Photographer',
      description: 'Restrict to works by a specific artist or photographer.',
      modes: ['require'],
      multiValue: false,
      modeDetermining: true,
      values: [],
      inputStyle: 'search',
    },
    {
      type: 'search',
      label: 'Search',
      description: 'Filter by title, subject, materials, culture, or any keyword.',
      modes: ['require'],
      multiValue: false,
      modeDetermining: true,
      values: [],
      inputStyle: 'search',
    },
  ];
}

const metadataFields = [
  { key: 'title',           label: 'Title',            description: 'Artwork or photograph title' },
  { key: 'creator',         label: 'Artist',           description: 'Artist or photographer name' },
  { key: 'dateCreated',     label: 'Date',             description: 'Creation date (e.g. "1890", "negative 1885–1903")' },
  { key: 'culture',         label: 'Culture',          description: 'Cultural origin (e.g. "American", "French")' },
  { key: 'accessionNumber', label: 'Accession Number', description: 'Getty Museum accession number' },
  { key: 'source',          label: 'Source',           description: 'Always "J. Paul Getty Museum"' },
];

const defaultMapping = {
  title:           'title',
  creator:         'artist',
  dateCreated:     'date',
  culture:         null,
  accessionNumber: null,
  source:          null,
};

/**
 * Return up to `count` search results for a keyword query without downloading images.
 * Uses the Getty search API with q=; builds IIIF thumbnail URLs from thumbUuid.
 *
 * @param {string} query
 * @param {object} [options]
 * @param {number} [options.count=12]
 * @returns {Promise<{ results: Array<{title,creator,thumbnailUrl,artworkUrl,source}>, totalAvailable: number }>}
 */
async function searchPreview(query, options = {}) {
  const { count = 12 } = options;

  let items, totalAvailable;
  try {
    const resp = await axios.get(SEARCH_URL, {
      params: { q: query, open_content: true, size: count },
      timeout: 15000,
    });
    items         = resp.data.data  || [];
    totalAvailable = resp.data.total || 0;
  } catch (err) {
    throw new Error(`[getty] searchPreview failed: ${err.message}`);
  }

  const results = items
    .filter(item => item.manifest?.thumbUuid)
    .map(item => {
      const producer = item.producers?.[0] || null;
      return {
        title:        item.primary_name      || null,
        creator:      producer?.primary_name || null,
        thumbnailUrl: `${IIIF_IMAGE_BASE}/${item.manifest.thumbUuid}/full/!300,300/0/default.jpg`,
        artworkUrl:   `${ARTWORK_BASE}${item.slug_with_path || ''}`,
        source:       'J. Paul Getty Museum',
      };
    });

  return { results, totalAvailable };
}

module.exports = {
  fetchRandomArtwork,
  fetchByIdentifier,
  canHandleIdentifier,
  selectMode,
  getFilterTypes,
  suggestArtists,
  countArtistArtworks,
  searchPreview,
  metadataFields,
  defaultMapping,
};
