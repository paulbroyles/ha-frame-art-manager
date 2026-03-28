'use strict';

const axios = require('axios');
const sharp = require('sharp');
const { dezoomify } = require('../utils/dezoomify');

// Delaware Art Museum — https://emuseum.delart.org
//
// The museum uses eMuseum (Gallery Systems), a server-side rendered HTML gallery.
// No JSON API is available. Selection strategy: pick a random browse page, extract
// object paths and media IDs from the grid HTML, then fetch the detail page for
// full metadata.
//
// Browse URL: https://emuseum.delart.org/objects/images?page=N
// Classification filter: ?filter=classifications%3APAINTING (etc.)
// 12 items per page; ~1,068 pages unfiltered (~12,800 objects total).
//
// Image resolution: dezoomify-rs on the object page URL extracts high-res tiles
// via the eMuseum IIPImage deep-zoom endpoint. Falls back to the /full dispatcher
// URL (~1024px max) when dezoomify-rs is unavailable or the page has no tiles.

const BASE_URL = 'https://emuseum.delart.org';
const ITEMS_PER_PAGE = 12;

const HEADERS = {
  'User-Agent': 'frame-art-manager/1.0 (home automation art display)',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

// Classification values for filtering.
// Keys are user-visible labels; values are the eMuseum URL filter parameter values.
const CLASSIFICATIONS = {
  'Painting':   'PAINTING',
  'Drawing':    'DRAWING',
  'Print':      'PRINT',
  'Photograph': 'PHOTOGRAPH',
  'Sculpture':  'SCULPTURE',
};

const CLASSIFICATION_TYPES = Object.keys(CLASSIFICATIONS);

// In-memory page count cache: classificationValue (or '') → { maxPages, totalCount, fetchedAt }
// 7-day TTL so counts refresh as the collection grows.
const _pageCountCache = new Map();
const PAGE_COUNT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Artist suggest cache: query → [{ personId, slug, name, description, count }]
// 1-hour TTL.
const _artistSuggestCache = new Map();
const ARTIST_SUGGEST_TTL_MS = 60 * 60 * 1000;

// Artist person cache: artistName (lower) → { personId, slug } | null
// Seeded by suggestArtists; used by fetchRandomArtwork to avoid re-resolving.
const _artistPersonCache = new Map();

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build browse URL for a given page and optional classification filter value.
 * classificationValue should be the eMuseum parameter value (e.g. 'PAINTING').
 */
function buildBrowseUrl(page, classificationValue) {
  let url = `${BASE_URL}/objects/images?page=${page}`;
  if (classificationValue) {
    url += `&filter=classifications%3A${encodeURIComponent(classificationValue)}`;
  }
  return url;
}

/**
 * Build the person-objects browse URL for an artist's works.
 */
function buildPersonObjectsUrl(personId, slug, page) {
  return `${BASE_URL}/people/${personId}/${slug}/objects?page=${page}`;
}

/**
 * Parse people search results from /search/{query}/people HTML.
 * Returns [{ personId, slug, name, description, count }].
 */
function parsePeopleSearchResults(html) {
  const results = [];
  // Each person record follows the pattern:
  //   href="/people/{id}/{slug};jsessionid=..." (text link)
  //   <a ...>\nName\n</a>  (display name)
  //   <div class="text-wrap">description</div>  (bio line)
  //   list-link href="/people/{id}/{slug}.../objects">(N)</a>  (work count)
  const linkRe = /href="\/people\/(\d+)\/([^;"/]+)[^"]*"\s*>\s*\n([^\n<]+)\n/g;
  let m;
  while ((m = linkRe.exec(html)) !== null) {
    const personId = m[1];
    const slug     = m[2];
    const name     = m[3].trim();
    if (!name || name === 'View All Works') continue;
    // Find description line following this match
    const tail = html.slice(m.index, m.index + 600);
    const descM = tail.match(/class="text-wrap">([^<]{5,150})</);
    const description = descM ? descM[1].trim() : null;
    // Work count: (N) in list-link
    const countM = tail.match(/\((\d+)\)/);
    const count = countM ? parseInt(countM[1], 10) : null;
    results.push({ personId, slug, name, description, count });
  }
  return results;
}

/**
 * Returns true if all significant words in `query` (≥3 chars) appear in `name`.
 * Used to post-filter people search results for false positives
 * (e.g. "van gogh" matching "Rembrandt van Rijn" because of "van").
 */
function nameMatchesQuery(name, query) {
  const nameLower  = name.toLowerCase();
  const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length >= 3);
  return queryWords.every(w => nameLower.includes(w));
}

/**
 * Parse the total object count from eMuseum browse page HTML.
 * eMuseum renders something like "Showing 1 - 12 of 12,812 objects".
 * Returns null if parsing fails.
 */
function parseTotalCount(html) {
  const m = html.match(/\bof\s+([\d,]+)\s*(?:records?|items?|results?|objects?)?/i);
  if (!m) return null;
  const n = parseInt(m[1].replace(/,/g, ''), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Parse grid items from a browse page HTML.
 * Splits on data-emuseum-id attributes so each block contains one item's href and media_id.
 * Returns array of { objectPath, mediaId }.
 */
function parseGridItems(html) {
  const items = [];
  // Split HTML on the attribute that marks each grid item boundary.
  const blocks = html.split(/(?=data-emuseum-id=)/);
  for (const block of blocks.slice(1)) {
    const pathMatch  = block.match(/href="(\/objects\/\d+\/[^"]+)"/);
    const mediaMatch = block.match(/\/internal\/media\/dispatcher\/(\d+)\/thumbnail/);
    if (pathMatch && mediaMatch) {
      items.push({ objectPath: pathMatch[1], mediaId: mediaMatch[1] });
    }
  }
  return items;
}

/**
 * Fetch a browse page and return { items, html }.
 */
async function fetchBrowsePage(page, classificationValue) {
  const url = buildBrowseUrl(page, classificationValue);
  const response = await axios.get(url, { timeout: 15000, headers: HEADERS });
  return { items: parseGridItems(response.data), html: response.data };
}

/**
 * Get (and cache) the page count and total item count for a given classification value,
 * or null for unfiltered. Probes page 1 to read totals; falls back to last-known on failure.
 * Returns { maxPages, totalCount }.
 */
async function getPageInfo(classificationValue) {
  const key = classificationValue || '';
  const cached = _pageCountCache.get(key);
  if (cached && (Date.now() - cached.fetchedAt) < PAGE_COUNT_TTL_MS) {
    return { maxPages: cached.maxPages, totalCount: cached.totalCount };
  }

  const fallbackPages = cached?.maxPages || 1068;
  const fallbackTotal = cached?.totalCount || fallbackPages * ITEMS_PER_PAGE;
  let maxPages = fallbackPages;
  let totalCount = fallbackTotal;
  try {
    const { html } = await fetchBrowsePage(1, classificationValue);
    const total = parseTotalCount(html);
    if (total) {
      totalCount = total;
      maxPages   = Math.ceil(total / ITEMS_PER_PAGE);
    }
  } catch (err) {
    console.warn(`[delart] Could not probe page count for [${key || 'all'}]: ${err.message} — using ${maxPages}`);
  }
  _pageCountCache.set(key, { maxPages, totalCount, fetchedAt: Date.now() });
  console.log(`[delart] Page count for [${key || 'all'}]: ${maxPages} (${totalCount} items)`);
  return { maxPages, totalCount };
}

/**
 * Search DelArt's people index for artists matching query.
 * Hits /search/{query}/people, parses person records, and post-filters so that
 * all significant words in the query (≥ 3 chars) appear in the person name.
 *
 * Returns [{ name, personId, slug, description, count, source: 'delart' }]
 * Seeds _artistPersonCache as a side effect.
 */
async function suggestArtists(query, limit = 10) {
  const key = query.trim().toLowerCase();
  const cached = _artistSuggestCache.get(key);
  if (cached && (Date.now() - cached.fetchedAt) < ARTIST_SUGGEST_TTL_MS) {
    return cached.results.slice(0, limit);
  }

  let html;
  try {
    const url = `${BASE_URL}/search/${encodeURIComponent(query)}/people`;
    const resp = await axios.get(url, { timeout: 10000, headers: HEADERS });
    html = resp.data;
  } catch (err) {
    console.warn(`[delart] suggestArtists fetch failed: ${err.message}`);
    return [];
  }

  const candidates = parsePeopleSearchResults(html);
  const results = candidates
    .filter(p => nameMatchesQuery(p.name, query))
    .map(p => ({ name: p.name, personId: p.personId, slug: p.slug, description: p.description, count: p.count, source: 'delart' }));

  // Seed person cache for faster resolution later.
  for (const r of results) {
    _artistPersonCache.set(r.name.toLowerCase(), { personId: r.personId, slug: r.slug });
  }

  _artistSuggestCache.set(key, { results, fetchedAt: Date.now() });
  return results.slice(0, limit);
}

/**
 * Return the number of artworks by this artist in DelArt's collection.
 * Returns null if the artist is not found.
 */
async function countArtistArtworks(artistName) {
  try {
    const results = await suggestArtists(artistName, 5);
    // Find the best name match (exact or closest).
    const nameLower = artistName.toLowerCase();
    const exact = results.find(r => r.name.toLowerCase() === nameLower);
    const match = exact || results[0];
    return match?.count ?? null;
  } catch (err) {
    console.warn(`[delart] countArtistArtworks failed: ${err.message}`);
    return null;
  }
}

/**
 * Resolve an artist name to a DelArt person { personId, slug }.
 * Checks cache first, then falls back to suggestArtists.
 * Returns null if not found.
 */
async function resolveArtistPerson(artistName) {
  const key = artistName.trim().toLowerCase();
  const cached = _artistPersonCache.get(key);
  if (cached !== undefined) return cached || null;

  const results = await suggestArtists(artistName, 5);
  const nameLower = key;
  const exact = results.find(r => r.name.toLowerCase() === nameLower);
  const person = exact || results[0] || null;
  _artistPersonCache.set(key, person ? { personId: person.personId, slug: person.slug } : null);
  return person ? { personId: person.personId, slug: person.slug } : null;
}

/**
 * Parse search result items from a /search/{query}/objects HTML page.
 * Extends parseGridItems to also extract title and creator from each block,
 * which eMuseum renders alongside the thumbnail in the search result grid.
 * Returns array of { objectPath, mediaId, title, creator }.
 */
function parseSearchItems(html) {
  const items = [];
  const blocks = html.split(/(?=data-emuseum-id=)/);
  for (const block of blocks.slice(1)) {
    const pathMatch  = block.match(/href="(\/objects\/\d+\/[^"]+)"/);
    const mediaMatch = block.match(/\/internal\/media\/dispatcher\/(\d+)\/thumbnail/);
    if (!pathMatch || !mediaMatch) continue;

    // Title: try common eMuseum class patterns, then fall back to first <a> text.
    const titleMatch =
      block.match(/class="[^"]*(?:objectTitle|title-field|emuseum-img-link-title)[^"]*"[^>]*>([\s\S]*?)<\/(?:div|span|p|h\d)>/i) ||
      block.match(/<h[2-4][^>]*>([\s\S]*?)<\/h[2-4]>/i) ||
      block.match(/class="[^"]*title[^"]*"[^>]*>\s*<[^>]+>\s*([\s\S]*?)<\//i);
    const title = titleMatch ? stripHtml(titleMatch[1]) : null;

    // Creator: try people/artist class names.
    const creatorMatch =
      block.match(/class="[^"]*(?:people|artist|creatorField|objectPeople)[^"]*"[^>]*>([\s\S]*?)<\/(?:div|span|p)>/i);
    const creator = creatorMatch ? stripHtml(creatorMatch[1]) : null;

    const objectPath = pathMatch[1].replace(/;jsessionid=[^?#]*/i, '');
    items.push({
      objectPath,
      mediaId: mediaMatch[1],
      title,
      creator,
    });
  }
  return items;
}

/**
 * Return up to `count` search results for a keyword query without downloading images.
 * Uses the eMuseum /search/{query}/objects endpoint (server-rendered HTML).
 *
 * @param {string} query
 * @param {object} [options]
 * @param {number} [options.count=12]
 * @returns {Promise<{ results: Array<{title,creator,thumbnailUrl,artworkUrl,source}>, totalAvailable: number }>}
 */
async function searchPreview(query, options = {}) {
  const { count = 12 } = options;

  const url = `${BASE_URL}/search/${encodeURIComponent(query)}/objects`;
  let html;
  try {
    const resp = await axios.get(url, { timeout: 15000, headers: HEADERS });
    html = resp.data;
  } catch (err) {
    throw new Error(`[delart] searchPreview failed: ${err.message}`);
  }

  const totalAvailable = parseTotalCount(html) ?? 0;
  const items = parseSearchItems(html);

  const results = items.slice(0, count).map(item => ({
    title:        item.title,
    creator:      item.creator,
    thumbnailUrl: `${BASE_URL}/internal/media/dispatcher/${item.mediaId}/thumbnail`,
    artworkUrl:   `${BASE_URL}${item.objectPath}`,
    source:       'Delaware Art Museum',
  }));

  return { results, totalAvailable };
}

/**
 * Parse metadata fields and media ID from a detail page HTML.
 * eMuseum detail pages use .detailField.{fieldName} wrappers with .detailFieldValue spans.
 */
function parseDetailPage(html) {
  // Extract text from a named detailField section.
  function getField(fieldClass) {
    const m = html.match(
      new RegExp(`class="[^"]*${fieldClass}[^"]*"[\\s\\S]*?class="[^"]*detailFieldValue[^"]*"[^>]*>([\\s\\S]*?)<\\/(?:span|div|p|td)>`, 'i')
    );
    return m ? stripHtml(m[1]) : null;
  }

  // Title lives in an <h1> inside .titleField.
  const titleMatch = html.match(/class="[^"]*titleField[^"]*"[\s\S]*?<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const title = titleMatch ? stripHtml(titleMatch[1]) : null;

  const creator        = getField('peopleField');
  const medium         = getField('mediumField');
  const dateCreated    = getField('dateField');
  const classification = getField('classificationField');

  // Media ID from og:image meta tag: content="/internal/media/dispatcher/{id}/full"
  const ogMatch = html.match(/property="og:image"\s+content="[^"]*\/dispatcher\/(\d+)\/full"/i)
    || html.match(/content="[^"]*\/dispatcher\/(\d+)\/full"[^>]*property="og:image"/i);
  const mediaId = ogMatch ? ogMatch[1] : null;

  return { title, creator, medium, dateCreated, classification, mediaId };
}

/**
 * Strip HTML tags and decode common entities from a string.
 */
function stripHtml(s) {
  if (!s) return null;
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || null;
}

// ── fetchRandomArtwork ────────────────────────────────────────────────────────

/**
 * Fetch a random artwork from the Delaware Art Museum collection.
 *
 * Classification filtering uses the eMuseum `filter=classifications%3AVALUE`
 * URL parameter, applied server-side. When multiple classifications are eligible,
 * all are probed in parallel (cached for 7 days) and one is selected weighted by
 * item count so larger categories are sampled proportionally.
 *
 * @param {Array<{type: string, mode: 'require'|'exclude', values: string[]}>} [filters=[]]
 *   Supported type: 'classification' — values are user-visible names from CLASSIFICATION_TYPES.
 * @param {object} [options]
 * @param {'all'|'landscape'|'portrait'} [options.aspectRatio='all']
 * @returns {{ imageBuffer, contentType, metadata }}
 */
async function fetchRandomArtwork(filters = [], options = {}) {
  const { aspectRatio = 'all' } = options;

  // ── Artist filter path ────────────────────────────────────────────────────
  // When an artist filter is present, resolve the artist to a DelArt person
  // and browse /people/{id}/{slug}/objects instead of the classification grid.
  const artistFilter = filters.find(f => f.type === 'artist');
  if (artistFilter) {
    const artistName = (artistFilter.values || [])[0] || '';
    if (!artistName) throw new Error('[delart] Artist filter has no name value');

    const person = await resolveArtistPerson(artistName);
    if (!person) {
      throw new Error(`[delart] Artist not found in collection: ${artistName}`);
    }

    // Probe page 1 to get total count, then pick randomly.
    const probeUrl = buildPersonObjectsUrl(person.personId, person.slug, 1);
    let probeHtml;
    try {
      const resp = await axios.get(probeUrl, { timeout: 15000, headers: HEADERS });
      probeHtml = resp.data;
    } catch (err) {
      throw new Error(`[delart] Failed to probe artist objects page: ${err.message}`);
    }
    const total = parseTotalCount(probeHtml) || ITEMS_PER_PAGE;
    const maxPages = Math.ceil(total / ITEMS_PER_PAGE);

    const MAX_ATTEMPTS = 10;
    let items = parseGridItems(probeHtml); // use probe results on page 1
    let loadedPage = 1;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (items.length === 0) {
        const page = Math.floor(Math.random() * maxPages) + 1;
        if (page === loadedPage) continue;
        loadedPage = page;
        try {
          const resp = await axios.get(buildPersonObjectsUrl(person.personId, person.slug, page), { timeout: 15000, headers: HEADERS });
          items = parseGridItems(resp.data);
        } catch (err) {
          console.warn(`[delart] Failed to fetch artist page ${page}: ${err.message}`);
          continue;
        }
        if (items.length === 0) continue;
      }

      const idx = Math.floor(Math.random() * items.length);
      const { objectPath, mediaId: gridMediaId } = items.splice(idx, 1)[0];
      // Strip session ID from path
      const cleanPath = objectPath.replace(/;jsessionid=[^?#]*/i, '');
      const objectUrl = `${BASE_URL}${cleanPath}`;

      let detailHtml;
      try {
        const resp = await axios.get(objectUrl, { timeout: 15000, headers: HEADERS });
        detailHtml = resp.data;
      } catch (err) {
        console.warn(`[delart] Failed to fetch artist detail ${cleanPath}: ${err.message}`);
        continue;
      }

      const detail = parseDetailPage(detailHtml);
      const mediaId = detail.mediaId || gridMediaId;
      if (!mediaId) continue;

      let imageBuffer = await dezoomify(objectUrl);
      let contentType = 'image/jpeg';
      if (!imageBuffer) {
        const fallbackUrl = `${BASE_URL}/internal/media/dispatcher/${mediaId}/full`;
        try {
          const resp = await axios.get(fallbackUrl, { responseType: 'arraybuffer', timeout: 30000, headers: HEADERS });
          imageBuffer = Buffer.from(resp.data);
          contentType = resp.headers['content-type'] || 'image/jpeg';
        } catch (err) {
          console.warn(`[delart] Failed to download artist artwork image: ${err.message}`);
          continue;
        }
      }

      if (aspectRatio !== 'all') {
        try {
          const { width, height } = await sharp(imageBuffer).metadata();
          const isLandscape = width > height;
          if (aspectRatio === 'landscape' && !isLandscape) continue;
          if (aspectRatio === 'portrait' && isLandscape) continue;
        } catch (err) {
          console.warn(`[delart] Could not read dimensions: ${err.message}`);
          continue;
        }
      }

      return {
        imageBuffer,
        contentType,
        metadata: {
          title:          detail.title,
          creator:        detail.creator,
          medium:         detail.medium,
          dateCreated:    detail.dateCreated,
          classification: detail.classification,
          artworkUrl:     objectUrl,
          source:         'Delaware Art Museum',
        },
      };
    }
    throw new Error(`Could not find a suitable Delaware Art Museum artwork by "${artistName}" after ${MAX_ATTEMPTS} attempts`);
  }

  // ── Classification filter path (original logic) ───────────────────────────

  // Compute eligible classifications.
  const requireSets = filters
    .filter(f => f.type === 'classification' && f.mode === 'require')
    .map(f => new Set((f.values || []).map(v => v.toLowerCase())));
  const excludeValues = new Set(
    filters
      .filter(f => f.type === 'classification' && f.mode === 'exclude')
      .flatMap(f => f.values || [])
      .map(v => v.toLowerCase())
  );

  let eligibleClassifications = CLASSIFICATION_TYPES;
  if (requireSets.length > 0) {
    eligibleClassifications = eligibleClassifications.filter(c =>
      requireSets.every(s => s.has(c.toLowerCase()))
    );
  }
  if (excludeValues.size > 0) {
    eligibleClassifications = eligibleClassifications.filter(c =>
      !excludeValues.has(c.toLowerCase())
    );
  }
  if (eligibleClassifications.length === 0) {
    throw new Error('No classifications eligible after applying filters');
  }

  // If all classifications are eligible, browse unfiltered (single probe, widest selection).
  // Otherwise, probe all eligible classifications in parallel and pick one weighted by
  // item count so larger categories are sampled proportionally.
  const filterActive = eligibleClassifications.length < CLASSIFICATION_TYPES.length;

  let classificationValue, maxPages;
  if (!filterActive) {
    ({ maxPages } = await getPageInfo(null));
    classificationValue = null;
  } else {
    const infos = await Promise.all(
      eligibleClassifications.map(async (c) => {
        const { maxPages: mp, totalCount } = await getPageInfo(CLASSIFICATIONS[c]);
        return { classification: c, classificationValue: CLASSIFICATIONS[c], maxPages: mp, totalCount };
      })
    );
    // Weighted random draw by totalCount.
    const totalItems = infos.reduce((sum, info) => sum + info.totalCount, 0);
    let pick = Math.random() * totalItems;
    let chosen = infos[infos.length - 1];
    for (const info of infos) {
      pick -= info.totalCount;
      if (pick <= 0) { chosen = info; break; }
    }
    classificationValue = chosen.classificationValue;
    maxPages            = chosen.maxPages;
  }

  const MAX_ATTEMPTS = 15;
  let items = [];

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    // Refresh candidate list from a new random page when exhausted.
    if (items.length === 0) {
      const page = Math.floor(Math.random() * maxPages) + 1;
      try {
        ({ items } = await fetchBrowsePage(page, classificationValue));
      } catch (err) {
        console.warn(`[delart] Failed to fetch browse page ${page}: ${err.message}`);
        continue;
      }
      if (items.length === 0) {
        console.warn(`[delart] No items found on page ${page}`);
        continue;
      }
    }

    // Pick and remove a random item from the current batch.
    const idx = Math.floor(Math.random() * items.length);
    const { objectPath, mediaId: gridMediaId } = items.splice(idx, 1)[0];
    const objectUrl = `${BASE_URL}${objectPath}`;

    // Fetch detail page for full metadata and authoritative media ID.
    let detailHtml;
    try {
      const resp = await axios.get(objectUrl, { timeout: 15000, headers: HEADERS });
      detailHtml = resp.data;
    } catch (err) {
      console.warn(`[delart] Failed to fetch detail page ${objectPath}: ${err.message}`);
      continue;
    }

    const detail = parseDetailPage(detailHtml);
    const mediaId = detail.mediaId || gridMediaId;
    if (!mediaId) {
      console.warn(`[delart] No media ID for ${objectPath}`);
      continue;
    }

    // Try dezoomify-rs first for high-resolution tiles (graceful no-op if unavailable).
    let imageBuffer = await dezoomify(objectUrl);
    let contentType = 'image/jpeg';

    if (!imageBuffer) {
      // Fall back to the /full dispatcher URL (~1024px).
      const fallbackUrl = `${BASE_URL}/internal/media/dispatcher/${mediaId}/full`;
      try {
        const resp = await axios.get(fallbackUrl, {
          responseType: 'arraybuffer',
          timeout: 30000,
          headers: HEADERS,
        });
        imageBuffer = Buffer.from(resp.data);
        contentType = resp.headers['content-type'] || 'image/jpeg';
      } catch (err) {
        console.warn(`[delart] Failed to download fallback image for ${objectPath}: ${err.message}`);
        continue;
      }
    }

    // Check aspect ratio.
    if (aspectRatio !== 'all') {
      try {
        const { width, height } = await sharp(imageBuffer).metadata();
        const isLandscape = width > height;
        if (aspectRatio === 'landscape' && !isLandscape) {
          console.warn(`[delart] ${objectPath} skipped: not landscape (${width}x${height})`);
          continue;
        }
        if (aspectRatio === 'portrait' && isLandscape) {
          console.warn(`[delart] ${objectPath} skipped: not portrait (${width}x${height})`);
          continue;
        }
      } catch (err) {
        console.warn(`[delart] Could not read dimensions for ${objectPath}: ${err.message}`);
        continue;
      }
    }

    return {
      imageBuffer,
      contentType,
      metadata: {
        title:          detail.title,
        creator:        detail.creator,
        medium:         detail.medium,
        dateCreated:    detail.dateCreated,
        classification: detail.classification,
        artworkUrl:     objectUrl,
        source:         'Delaware Art Museum',
      },
    };
  }

  throw new Error(
    `Could not find a suitable${aspectRatio !== 'all' ? ` ${aspectRatio}` : ''} Delaware Art Museum artwork after ${MAX_ATTEMPTS} attempts`
  );
}

// ── selectMode ────────────────────────────────────────────────────────────────

function selectMode(filters = []) {
  const clsFilters = filters.filter(f => f.type === 'classification');
  const hasRequire = clsFilters.some(f => f.mode === 'require');
  const hasExclude = clsFilters.some(f => f.mode === 'exclude');
  const mode = hasRequire ? 'filtered_page' : hasExclude ? 'excluded_page' : 'random_page';
  return { mode, apiFilters: clsFilters, postFilters: [] };
}

// ── Metadata schema ───────────────────────────────────────────────────────────

const metadataFields = [
  { key: 'title',          label: 'Title',          description: 'Artwork title' },
  { key: 'creator',        label: 'Artist',         description: 'Artist or maker name(s)' },
  { key: 'medium',         label: 'Medium',         description: 'Materials and techniques' },
  { key: 'dateCreated',    label: 'Date',           description: 'Creation date or period', format: 'date' },
  { key: 'classification', label: 'Classification', description: 'Object type (e.g. Painting, Drawing)' },
  { key: 'source',         label: 'Source',         description: 'Always "Delaware Art Museum"' },
];

const defaultMapping = {
  title:          'title',
  creator:        { entity: 'creator', attribute: 'name' },
  medium:         'medium',
  dateCreated:    'date',
  classification: null,
  source:         'museum',
};

// ── Filter types ──────────────────────────────────────────────────────────────

function getFilterTypes() {
  return [
    {
      type:        'classification',
      label:       'Classification',
      description: 'Restrict or exclude artworks by object type. Applied server-side via the eMuseum browse filter.',
      modes:       ['require', 'exclude'],
      multiValue:  true,
      values:      CLASSIFICATION_TYPES.map(name => ({ value: name, label: name })),
    },
    {
      type:        'artist',
      label:       'Artist',
      description: 'Filter by artist name. Resolves the artist via the DelArt people directory and browses their works directly.',
      modes:       ['require'],
      multiValue:  false,
    },
  ];
}

// ── fetchByIdentifier ─────────────────────────────────────────────────────────

/**
 * Returns true if this source can handle the given identifier.
 * Accepts Delaware Art Museum eMuseum object page URLs.
 */
function canHandleIdentifier(identifier) {
  return /emuseum\.delart\.org\/objects\/\d+/i.test(identifier.trim());
}

/**
 * Fetch a specific artwork by Delaware Art Museum eMuseum object URL.
 */
async function fetchByIdentifier(identifier) {
  const t = identifier.trim();
  const m = t.match(/(\/objects\/\d+\/[^?#\s]+)/i);
  if (!m) throw new Error(`Cannot parse Delaware Art Museum object path from: ${identifier}`);
  const objectPath = m[1];
  const objectUrl  = `${BASE_URL}${objectPath}`;

  let detailHtml;
  try {
    const resp = await axios.get(objectUrl, { timeout: 15000, headers: HEADERS });
    detailHtml = resp.data;
  } catch (err) {
    throw new Error(`Failed to fetch Delaware Art Museum detail page ${objectPath}: ${err.message}`);
  }

  const detail = parseDetailPage(detailHtml);
  if (!detail.mediaId) throw new Error(`No media ID found for ${objectPath}`);

  let imageBuffer = await dezoomify(objectUrl);
  let contentType = 'image/jpeg';

  if (!imageBuffer) {
    const fallbackUrl = `${BASE_URL}/internal/media/dispatcher/${detail.mediaId}/full`;
    try {
      const resp = await axios.get(fallbackUrl, {
        responseType: 'arraybuffer',
        timeout: 30000,
        headers: HEADERS,
      });
      imageBuffer = Buffer.from(resp.data);
      contentType = resp.headers['content-type'] || 'image/jpeg';
    } catch (err) {
      throw new Error(`Failed to download image for ${objectPath}: ${err.message}`);
    }
  }

  return {
    imageBuffer,
    contentType,
    metadata: {
      title:          detail.title,
      creator:        detail.creator,
      medium:         detail.medium,
      dateCreated:    detail.dateCreated,
      classification: detail.classification,
      artworkUrl:     objectUrl,
      source:         'Delaware Art Museum',
    },
  };
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
  parsePeopleSearchResults,   // exported for unit tests
  nameMatchesQuery,           // exported for unit tests
  parseSearchItems,           // exported for unit tests
  metadataFields,
  defaultMapping,
  CLASSIFICATION_TYPES,
};
