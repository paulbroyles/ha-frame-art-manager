'use strict';

const axios = require('axios');

// Artsy's internal GraphQL API (Metaphysics v2), used by the artsy.net frontend.
// Open source: https://github.com/artsy/metaphysics
const GRAPHQL_URL = 'https://metaphysics-production.artsy.net/v2';

const PAGE_SIZE = 100;
const MAX_PAGE = 100;
const MAX_ATTEMPTS = 10;

// Count cache TTL: 6 hours. Counts come from the artworksConnection.counts.total
// field included in every fetch, so no extra API call is needed to populate it.
const COUNT_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

// Sort orders used for randomization. Picking randomly among these on each fetch
// expands the accessible pool ~4× beyond what a single sort order would expose.
// With 100 pages × 100 items per sort, each medium has ~40,000 accessible works.
// These are the REST-style string values accepted by the Metaphysics API.
const SORT_OPTIONS = [
  '-published_at',
  'published_at',
  '-merchandisability',
  'merchandisability',
  '-created_at',
  'created_at',
];

// Valid medium values for the Artsy artworksConnection filter (confirmed March 2026).
const MEDIUMS = [
  { value: 'painting',             label: 'Painting' },
  { value: 'photography',          label: 'Photography' },
  { value: 'prints',               label: 'Prints & Multiples' },
  { value: 'mixed-media',          label: 'Mixed Media' },
  { value: 'sculpture',            label: 'Sculpture' },
  { value: 'drawing',              label: 'Drawing' },
  { value: 'design',               label: 'Design / Decorative Art' },
  { value: 'textile-arts',         label: 'Textile Arts' },
  { value: 'books-and-portfolios', label: 'Books & Portfolios' },
  { value: 'jewelry',              label: 'Jewelry' },
];

// Curated Artsy marketing collection slugs exposed as user-selectable filters.
// Source: Artsy marketingCollections endpoint (March 2026).
const COLLECTIONS = [
  // Movements & Eras
  { value: 'contemporary',              label: 'Contemporary Art',      group: 'Movements & Eras' },
  { value: 'emerging-art',              label: 'Emerging Art',          group: 'Movements & Eras' },
  { value: 'old-masters',               label: 'Old Masters',           group: 'Movements & Eras' },
  { value: 'fauvism',                   label: 'Fauvism',               group: 'Movements & Eras' },
  { value: 'bauhaus',                   label: 'Bauhaus',               group: 'Movements & Eras' },
  { value: 'de-stijl',                  label: 'De Stijl',              group: 'Movements & Eras' },
  // Curated
  { value: 'curators-picks',            label: "Curators' Picks",       group: 'Curated' },
  { value: 'feminist-art',              label: 'Feminist Art',          group: 'Curated' },
  { value: 'natural-abstraction',       label: 'Natural Abstraction',   group: 'Curated' },
  { value: 'black-abstraction',         label: 'Black Abstraction',     group: 'Curated' },
  { value: 'contemporary-japanese-art', label: 'Japanese Contemporary', group: 'Curated' },
  { value: 'photojournalism',           label: 'Photojournalism',       group: 'Curated' },
  { value: 'emerging-street-art',       label: 'Street Art: Emerging',  group: 'Curated' },
  { value: 'pioneers-of-street-art',    label: 'Street Art: Pioneers',  group: 'Curated' },
  // By Color
  { value: 'black-and-white-artworks',  label: 'Black & White',         group: 'By Color' },
  { value: 'blue-artworks',             label: 'Blue',                  group: 'By Color' },
  { value: 'red-artworks',              label: 'Red',                   group: 'By Color' },
  { value: 'orange-artworks',           label: 'Orange',                group: 'By Color' },
  { value: 'yellow-artworks',           label: 'Yellow',                group: 'By Color' },
  { value: 'neutral-artworks',          label: 'Neutral Tones',         group: 'By Color' },
  // By Region
  { value: 'american-artists',          label: 'American Artists',      group: 'By Region' },
  { value: 'chinese-artists',           label: 'Chinese Artists',       group: 'By Region' },
  { value: 'german-artists',            label: 'German Artists',        group: 'By Region' },
];

// ── Count cache ─────────────────────────────────────────────────────────────
// Keyed by `${medium|"*"}_${collection|"*"}_${sort}`.
// Populated from artworksConnection.counts.total in every fetch response.
// Used to compute maxPage so we never request a page past the end of results.
const _countCache = new Map();

// ── Artist slug cache ────────────────────────────────────────────────────────
// Maps artist name (lowercased) → { slug, resolvedName, fetchedAt }.
// Populated by resolveArtistSlug(). 24-hour TTL.
const ARTIST_SLUG_TTL_MS = 24 * 60 * 60 * 1000;
const _artistSlugCache = new Map();

// Suggest cache: Maps query (lowercased) → { results, fetchedAt }. 1-hour TTL.
const ARTIST_SUGGEST_TTL_MS = 60 * 60 * 1000;
const _artistSuggestCache = new Map();

function _countCacheKey(medium, collection, sort) {
  return `${medium || '*'}_${collection || '*'}_${sort}`;
}

function _getCachedCount(medium, collection, sort) {
  const entry = _countCache.get(_countCacheKey(medium, collection, sort));
  if (!entry || Date.now() - entry.fetchedAt > COUNT_CACHE_TTL_MS) return null;
  return entry.total;
}

function _setCachedCount(medium, collection, sort, total) {
  _countCache.set(_countCacheKey(medium, collection, sort), { total, fetchedAt: Date.now() });
}

// ── Artist slug resolution ───────────────────────────────────────────────────

/**
 * Resolve an artist name to an Artsy slug via searchConnection.
 * Returns the slug string on success, or null if no match found.
 * Results cached for 24 hours.
 *
 * Uses searchConnection(query:, entities:[ARTIST]) — the only working GraphQL
 * path for artist name→slug resolution. (artistsConnection(keyword:) returns HTTP 400.)
 */
async function resolveArtistSlug(name) {
  const key = name.toLowerCase().trim();
  const cached = _artistSlugCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < ARTIST_SLUG_TTL_MS) {
    return cached.slug;
  }

  let slug = null;
  try {
    const escaped = name.replace(/"/g, '\\"');
    const result = await _graphql(`{
      searchConnection(query: "${escaped}", first: 5, entities: [ARTIST]) {
        edges { node { displayLabel ... on Artist { slug } } }
      }
    }`);
    const edges = result?.data?.searchConnection?.edges || [];
    // Prefer exact name match (case-insensitive); fall back to first result
    const nameLower = name.toLowerCase();
    const exactMatch = edges.find(e => (e.node?.displayLabel || '').toLowerCase() === nameLower);
    const best = exactMatch || edges[0];
    slug = best?.node?.slug || null;
    if (slug) {
      console.log(`[artsy] Resolved artist "${name}" → slug "${slug}" (${best.node.displayLabel})`);
    } else {
      console.warn(`[artsy] Could not resolve artist slug for "${name}"`);
    }
  } catch (err) {
    console.warn(`[artsy] Artist slug resolution failed for "${name}": ${err.message}`);
  }

  _artistSlugCache.set(key, { slug, fetchedAt: Date.now() });
  return slug;
}

// ── GraphQL helpers ──────────────────────────────────────────────────────────

async function _graphql(query) {
  const response = await axios.post(
    GRAPHQL_URL,
    { query },
    { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
  );
  if (response.data.errors) {
    const msg = response.data.errors.map(e => e.message).join('; ');
    throw new Error(`GraphQL error: ${msg}`);
  }
  return response.data;
}

function _buildArtworksQuery({ medium, collection, keyword, artistID, sort, page }) {
  const args = [
    `first: ${PAGE_SIZE}`,
    `page: ${page}`,
    `forSale: true`,
    `sort: "${sort}"`,
  ];
  if (medium)     args.push(`medium: "${medium}"`);
  if (collection) args.push(`marketingCollectionID: "${collection}"`);
  if (keyword)    args.push(`keyword: "${keyword.replace(/"/g, '\\"')}"`);
  if (artistID)   args.push(`artistID: "${artistID.replace(/"/g, '\\"')}"`);

  return `{
    artworksConnection(${args.join(', ')}) {
      counts { total }
      edges {
        node {
          title
          date
          medium
          href
          price
          artist { name }
          partner { name }
          image { url(version: "normalized") aspectRatio width height }
        }
      }
    }
  }`;
}

// ── fetchRandomArtwork ───────────────────────────────────────────────────────

/**
 * Fetch a random artwork from Artsy's for-sale collection.
 *
 * @param {Array<{type: string, mode: string, values: string[]}>} [filters=[]]
 *   Supported filter types:
 *   - 'medium'     (require): restrict to specific medium types (e.g. 'painting', 'photography')
 *   - 'collection' (require): restrict to Artsy marketing collection slugs (e.g. 'contemporary')
 *   - 'artist'     (require): filter by artist name; resolved to Artsy slug via searchConnection
 *   - 'search'     (require): keyword search term; first value is used
 *   When multiple medium or collection values are selected, one is chosen randomly per fetch.
 *
 * @param {object} [options]
 * @param {'all'|'landscape'|'portrait'} [options.aspectRatio='all']
 *
 * @returns {{ imageBuffer, contentType, metadata }}
 */
async function fetchRandomArtwork(filters = [], options = {}) {
  const { aspectRatio = 'all' } = options;

  const requireMediums = filters
    .filter(f => f.type === 'medium' && f.mode === 'require')
    .flatMap(f => f.values || []);
  const requireCollections = filters
    .filter(f => f.type === 'collection' && f.mode === 'require')
    .flatMap(f => f.values || []);
  const keyword = filters
    .filter(f => f.type === 'search')
    .map(f => (f.values || [])[0])
    .find(Boolean) || null;

  // Artist filter — resolve name to Artsy slug via searchConnection.
  const artistName = filters.find(f => f.type === 'artist' && f.mode === 'require')?.values?.[0] || null;
  const artistID = artistName ? await resolveArtistSlug(artistName) : null;
  if (artistName && !artistID) {
    console.warn(`[artsy] Artist "${artistName}" not found on Artsy; proceeding without artist filter`);
  }

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    // Each attempt independently picks a medium, collection, and sort.
    // This diversifies the accessible pool across retries.
    const medium     = requireMediums.length     ? requireMediums[Math.floor(Math.random() * requireMediums.length)]         : null;
    const collection = requireCollections.length ? requireCollections[Math.floor(Math.random() * requireCollections.length)] : null;
    const sort       = SORT_OPTIONS[Math.floor(Math.random() * SORT_OPTIONS.length)];

    // Use cached total to compute maxPage; fall back to MAX_PAGE on first call.
    const cachedTotal = _getCachedCount(medium, collection, sort);
    const maxPage = cachedTotal !== null
      ? Math.min(MAX_PAGE, Math.ceil(cachedTotal / PAGE_SIZE))
      : MAX_PAGE;

    if (cachedTotal === 0) {
      console.warn(`[artsy] No artworks for medium=${medium} collection=${collection} sort=${sort}, retrying`);
      continue;
    }

    const page = Math.floor(Math.random() * maxPage) + 1;

    let result;
    try {
      result = await _graphql(_buildArtworksQuery({ medium, collection, keyword, artistID, sort, page }));
    } catch (err) {
      console.warn(`[artsy] GraphQL fetch failed (attempt ${attempt + 1}): ${err.message}`);
      continue;
    }

    const conn = result?.data?.artworksConnection;
    const total = conn?.counts?.total;
    if (total !== undefined) {
      _setCachedCount(medium, collection, sort, total);
    }

    const edges = conn?.edges || [];
    if (edges.length === 0) {
      console.warn(`[artsy] Empty page ${page} (total=${total}, attempt ${attempt + 1}), retrying`);
      continue;
    }

    // Filter by aspect ratio before downloading (aspectRatio is in the API response).
    const eligible = aspectRatio === 'all'
      ? edges
      : edges.filter(({ node }) => {
          if (!node?.image?.aspectRatio) return true; // unknown — allow
          const isLandscape = node.image.aspectRatio > 1;
          return aspectRatio === 'landscape' ? isLandscape : !isLandscape;
        });

    if (eligible.length === 0) {
      console.warn(`[artsy] No ${aspectRatio} artworks on page ${page} (attempt ${attempt + 1}), retrying`);
      continue;
    }

    const node = eligible[Math.floor(Math.random() * eligible.length)]?.node;
    if (!node?.image?.url) {
      console.warn(`[artsy] Selected artwork has no image (attempt ${attempt + 1}), retrying`);
      continue;
    }

    let imageBuffer, contentType;
    try {
      const imageResp = await axios.get(node.image.url, {
        responseType: 'arraybuffer',
        timeout: 30000,
      });
      imageBuffer = Buffer.from(imageResp.data);
      contentType = imageResp.headers['content-type'] || 'image/jpeg';
    } catch (err) {
      console.warn(`[artsy] Image download failed (attempt ${attempt + 1}): ${err.message}`);
      continue;
    }

    return {
      imageBuffer,
      contentType,
      metadata: {
        title:       node.title              || null,
        creator:     node.artist?.name       || null,
        medium:      node.medium             || null,
        dateCreated: node.date               || null,
        artworkUrl:  node.href ? `https://www.artsy.net${node.href}` : null,
        partner:     node.partner?.name      || null,
        price:       node.price              || null,
        source:      'Artsy',
      },
    };
  }

  throw new Error(`[artsy] Could not find a suitable artwork after ${MAX_ATTEMPTS} attempts`);
}

// ── Metadata fields ──────────────────────────────────────────────────────────

const metadataFields = [
  { key: 'title',       label: 'Title',        description: 'Artwork title' },
  { key: 'creator',     label: 'Artist',       description: 'Artist name' },
  { key: 'medium',      label: 'Medium',       description: 'Material or technique (e.g. "Oil on canvas")' },
  { key: 'dateCreated', label: 'Date Created', description: 'Date or year the artwork was created', format: 'date' },
  { key: 'artworkUrl',  label: 'Artwork URL',  description: 'Link to the artwork on Artsy' },
  { key: 'partner',     label: 'Gallery',      description: 'Gallery or partner presenting the work' },
  { key: 'price',       label: 'Price',        description: 'Listing price (may be "Price on request")' },
  { key: 'source',      label: 'Source',       description: 'Always "Artsy"' },
];

const defaultMapping = {
  title:       'title',
  creator:     { entity: 'creator', attribute: 'name' },
  medium:      'medium',
  dateCreated: 'date',
  artworkUrl:  'source_url',
  partner:     'museum',
  price:       null,
  source:      null,
};

// ── selectMode ───────────────────────────────────────────────────────────────

function selectMode(filters = []) {
  const hasArtist     = filters.some(f => f.type === 'artist');
  const hasMedium     = filters.some(f => f.type === 'medium');
  const hasCollection = filters.some(f => f.type === 'collection');
  const hasSearch     = filters.some(f => f.type === 'search');
  const mode = hasArtist     ? 'artist_search'
             : hasSearch     ? 'keyword_search'
             : hasCollection ? 'collection_filter'
             : hasMedium     ? 'medium_filter'
             :                 'browse_all';
  return { mode, apiFilters: filters, postFilters: [] };
}

// ── getFilterTypes ───────────────────────────────────────────────────────────

function getFilterTypes() {
  const collectionGroups = ['Movements & Eras', 'Curated', 'By Color', 'By Region'].map(name => ({
    name,
    values: COLLECTIONS.filter(c => c.group === name).map(c => c.value),
  }));

  return [
    {
      type: 'medium',
      label: 'Medium',
      description: 'Filter by artwork medium type. Multiple values are each eligible for random selection.',
      modes: ['require'],
      multiValue: true,
      values: MEDIUMS,
    },
    {
      type: 'collection',
      label: 'Collection',
      description: 'Filter by Artsy curated collection or movement. Multiple values are each eligible for random selection.',
      modes: ['require'],
      multiValue: true,
      groups: collectionGroups,
      values: COLLECTIONS.map(c => ({ value: c.value, label: c.label })),
    },
    {
      type: 'artist',
      label: 'Artist',
      description: 'Filter by artist name. Resolves to an Artsy artist slug via search for precise matching.',
      modes: ['require'],
      multiValue: false,
      values: [],
      inputStyle: 'search',
    },
    {
      type: 'search',
      label: 'Search',
      description: 'Search artworks by title, artist, or subject.',
      modes: ['require'],
      multiValue: false,
      values: [],
      inputStyle: 'search',
    },
  ];
}

// ── fetchByIdentifier ────────────────────────────────────────────────────────

/**
 * Returns true if this source can fetch the given identifier.
 * Accepts artsy.net artwork URLs (e.g. https://www.artsy.net/artwork/some-slug).
 */
function canHandleIdentifier(identifier) {
  return /artsy\.net\/artwork\//i.test(identifier.trim());
}

/**
 * Fetch a specific artwork by Artsy URL.
 */
async function fetchByIdentifier(identifier) {
  const urlMatch = identifier.trim().match(/artsy\.net\/artwork\/([^/?#]+)/i);
  if (!urlMatch) throw new Error(`[artsy] Cannot parse artwork slug from: ${identifier}`);
  const slug = urlMatch[1];

  let result;
  try {
    result = await _graphql(`{
      artwork(id: "${slug}") {
        title
        date
        medium
        href
        price
        artist { name }
        partner { name }
        image { url(version: "normalized") aspectRatio width height }
      }
    }`);
  } catch (err) {
    throw new Error(`[artsy] Failed to fetch artwork "${slug}": ${err.message}`);
  }

  const node = result?.data?.artwork;
  if (!node)           throw new Error(`[artsy] Artwork "${slug}" not found`);
  if (!node.image?.url) throw new Error(`[artsy] Artwork "${slug}" has no image`);

  let imageBuffer, contentType;
  try {
    const imageResp = await axios.get(node.image.url, {
      responseType: 'arraybuffer',
      timeout: 30000,
    });
    imageBuffer = Buffer.from(imageResp.data);
    contentType = imageResp.headers['content-type'] || 'image/jpeg';
  } catch (err) {
    throw new Error(`[artsy] Image download failed for "${slug}": ${err.message}`);
  }

  return {
    imageBuffer,
    contentType,
    metadata: {
      title:       node.title              || null,
      creator:     node.artist?.name       || null,
      medium:      node.medium             || null,
      dateCreated: node.date               || null,
      artworkUrl:  node.href ? `https://www.artsy.net${node.href}` : null,
      partner:     node.partner?.name      || null,
      price:       node.price              || null,
      source:      'Artsy',
    },
  };
}

/**
 * Suggest artist name candidates from Artsy's searchConnection API.
 * Seeds _artistSlugCache as a side effect (slug is needed for subsequent artist queries).
 *
 * @param {string} query
 * @param {number} [limit=5]
 * @returns {Promise<Array<{ name, slug, source }>>}
 */
async function suggestArtists(query, limit = 5) {
  const key = query.toLowerCase().trim();
  const cached = _artistSuggestCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < ARTIST_SUGGEST_TTL_MS) {
    return cached.results.slice(0, limit);
  }

  let results = [];
  try {
    const escaped = query.replace(/"/g, '\\"');
    const result = await _graphql(`{
      searchConnection(query: "${escaped}", first: ${Math.max(limit, 5)}, entities: [ARTIST]) {
        edges { node { displayLabel ... on Artist { slug } } }
      }
    }`);
    const edges = result?.data?.searchConnection?.edges || [];
    results = edges
      .filter(e => e.node?.displayLabel)
      .map(e => ({
        name:   e.node.displayLabel,
        slug:   e.node.slug || null,
        source: 'artsy',
      }));

    // Seed slug cache as side effect
    for (const r of results) {
      if (r.slug) {
        const nameKey = r.name.toLowerCase().trim();
        _artistSlugCache.set(nameKey, { slug: r.slug, fetchedAt: Date.now() });
      }
    }
  } catch (err) {
    console.warn(`[artsy] suggestArtists failed for "${query}": ${err.message}`);
  }

  _artistSuggestCache.set(key, { results, fetchedAt: Date.now() });
  return results.slice(0, limit);
}

// ── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  fetchRandomArtwork,
  fetchByIdentifier,
  canHandleIdentifier,
  selectMode,
  getFilterTypes,
  suggestArtists,
  metadataFields,
  defaultMapping,
};
