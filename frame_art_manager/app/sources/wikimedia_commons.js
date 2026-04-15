'use strict';

const axios = require('axios');
const sharp = require('sharp');

const WIKIMEDIA_API = 'https://commons.wikimedia.org/w/api.php';

// Wikimedia policy requires a descriptive User-Agent on all API and image requests.
const USER_AGENT = 'frame-art-manager/1.0 (home art display system; https://github.com/home-assistant)';

const { THUMB_LONG_EDGE, thumbWidthFor, adjustThumbWidth } = require('../utils/thumbSize');

const BATCH_SIZE = 10;
const MAX_ROUNDS = 5;

// CirrusSearch hard-rejects gsroffset >= 10000. We stay safely below.
const MAX_SEARCH_OFFSET = 9500;

// In-memory cache for CirrusSearch totalhits counts, keyed by query string.
// Avoids a serial count API call on every fetch for the same filter combination.
// TTL: 1 hour — counts shift slowly and staleness is harmless (just affects offset range).
const COUNT_CACHE_TTL_MS = 60 * 60 * 1000;
const countCache = new Map(); // query → { count, expiresAt }

function getCachedCount(query) {
  const entry = countCache.get(query);
  if (!entry || Date.now() > entry.expiresAt) return null;
  return entry.count;
}

function setCachedCount(query, count) {
  countCache.set(query, { count, expiresAt: Date.now() + COUNT_CACHE_TTL_MS });
}

const EXTMETA_FILTER = 'ObjectName|Artist|DateTimeOriginal|LicenseShortName|Credit|ImageDescription';

// ── Media type categories ─────────────────────────────────────────────────────
//
// Each entry maps a user-visible filter value to a Wikimedia Commons category.
// `weight` drives the default weighted-random draw when no media filter is active.
// `centuryPrefix` is the prefix used to build century×media categories, e.g.
//   "17th-century" + centuryPrefix → "Category:17th-century paintings".

const MEDIA_CATEGORIES = [
  { value: 'Paintings',               label: 'Paintings',               gcmtitle: 'Category:Paintings',              weight: 5, centuryPrefix: 'paintings' },
  { value: 'Drawings',                label: 'Drawings',                gcmtitle: 'Category:Drawings',               weight: 2, centuryPrefix: 'drawings' },
  { value: 'Prints',                  label: 'Prints',                  gcmtitle: 'Category:Prints (art)',            weight: 2, centuryPrefix: 'prints' },
  { value: 'Photographs',             label: 'Photographs',             gcmtitle: 'Category:Photographs',             weight: 3, centuryPrefix: 'photographs' },
  { value: 'Sculptures',              label: 'Sculptures',              gcmtitle: 'Category:Sculptures',              weight: 2, centuryPrefix: 'sculptures' },
  { value: 'Illuminated manuscripts', label: 'Illuminated manuscripts', gcmtitle: 'Category:Illuminated manuscripts', weight: 1, centuryPrefix: 'illuminated manuscripts' },
  { value: 'Tapestries',              label: 'Tapestries',              gcmtitle: 'Category:Tapestries',              weight: 1, centuryPrefix: 'tapestries' },
];

// ── Institutions ──────────────────────────────────────────────────────────────
//
// Major art collections with substantial Commons image sets.
// Thin wrapper sources (e.g. paris_musees.js) pre-inject one of these as a
// fixed filter; the general source exposes the full list.

const INSTITUTIONS = [
  { value: 'Paris Musées',                    label: 'Paris Musées',                    gcmtitle: 'Category:Images from Paris Musées' },
  { value: 'Rijksmuseum',                     label: 'Rijksmuseum',                     gcmtitle: 'Category:Images from the Rijksmuseum' },
  { value: 'Wellcome Collection',             label: 'Wellcome Collection',             gcmtitle: 'Category:Wellcome Collection' },
  { value: 'Smithsonian Institution',         label: 'Smithsonian Institution',         gcmtitle: 'Category:Images from Smithsonian Institution' },
  { value: 'Cleveland Museum of Art',         label: 'Cleveland Museum of Art',         gcmtitle: 'Category:Cleveland Museum of Art' },
  { value: 'Los Angeles County Museum of Art',label: 'LACMA',                           gcmtitle: 'Category:Los Angeles County Museum of Art' },
  { value: 'Louvre',                          label: 'Louvre',                          gcmtitle: 'Category:Paintings in the Louvre' },
  { value: 'Uffizi',                          label: 'Uffizi',                          gcmtitle: 'Category:Paintings in the Uffizi' },
  { value: 'Prado',                           label: 'Prado',                           gcmtitle: 'Category:Paintings in the Museo del Prado' },
  { value: 'Hermitage',                       label: 'Hermitage',                       gcmtitle: 'Category:Paintings in the Hermitage Museum' },
  { value: 'National Gallery, London',        label: 'National Gallery (London)',       gcmtitle: 'Category:Paintings in the National Gallery, London' },
];

// ── Subject / theme categories ────────────────────────────────────────────────
//
// Commons has well-organized subject categories that cut across media types.
// A subject filter changes the browse gcmtitle, or adds incategory: in search mode.

// Subject categories use deepcat: in CirrusSearch to traverse the full subcategory tree.
// Categories are general/cross-media (not painting-specific) so the subject filter works
// across all media types — "Landscapes" returns landscape paintings AND landscape photos
// AND landscape drawings.
//
// When a subject is active in search mode, no media clause is added. CirrusSearch
// intersection of subject deepcat + media deepcat yields near-zero results because
// Commons organises media-specific subcategories under the subject tree, not as
// an intersection of separate subject and media trees.
//
// `gcmtitle` is used for direct category browse (single-filter mode).
// `deepcatTitle` is the exact Commons category name for CirrusSearch deepcat:.
// Pool sizes verified 2026-04-10 using CirrusSearch totalhits.
const SUBJECT_CATEGORIES = [
  { value: 'Portraits',      label: 'Portraits',      gcmtitle: 'Category:Portraits',             deepcatTitle: 'Portraits',             approxSize: 165000 },
  { value: 'Landscapes',     label: 'Landscapes',     gcmtitle: 'Category:Landscapes',             deepcatTitle: 'Landscapes',             approxSize: 206000 },
  { value: 'Still lifes',    label: 'Still lifes',    gcmtitle: 'Category:Still life',             deepcatTitle: 'Still life',             approxSize: 56000  },
  { value: 'Religious art',  label: 'Religious art',  gcmtitle: 'Category:Religious art',          deepcatTitle: 'Religious art',          approxSize: 107000 },
  { value: 'Mythology',      label: 'Mythology',      gcmtitle: 'Category:Mythology in art',       deepcatTitle: 'Mythology in art',       approxSize: 85000  },
  { value: 'Genre scenes',   label: 'Genre scenes',   gcmtitle: 'Category:Genre art',              deepcatTitle: 'Genre art',              approxSize: 59000  },
  { value: 'Animals',        label: 'Animals',        gcmtitle: 'Category:Animals in art',         deepcatTitle: 'Animals in art',         approxSize: 120000 },
  { value: 'Botanical art',  label: 'Botanical art',  gcmtitle: 'Category:Botanical illustrations',deepcatTitle: 'Botanical illustrations', approxSize: 158000 },
  { value: 'Nude art',       label: 'Nude art',       gcmtitle: 'Category:Nude paintings',         deepcatTitle: 'Nude paintings',         approxSize: 28000  },
  { value: 'Marine art',     label: 'Marine art',     gcmtitle: 'Category:Marine art',             deepcatTitle: 'Marine art',             approxSize: 110000 },
  { value: 'Battle art',     label: 'Battle art',     gcmtitle: 'Category:History paintings',      deepcatTitle: 'History paintings',      approxSize: 104000 },
  { value: 'City scenes',    label: 'City scenes',    gcmtitle: 'Category:Cityscapes',             deepcatTitle: 'Cityscapes',             approxSize: 171000 },
];

// ── Century values ────────────────────────────────────────────────────────────
//
// Used to construct century×media category names (e.g. "Category:17th-century paintings")
// or incategory: search clauses. Century filter always forces search mode since
// the category name depends on the media type selected.

const CENTURY_VALUES = [
  '13th century', '14th century', '15th century',
  '16th century', '17th century', '18th century',
  '19th century', '20th century', '21st century',
];

// Convert "17th century" → "17th-century" for use in Commons category names.
function centuryToHyphenated(century) {
  return century.replace(' century', '-century');
}

// ── License values ────────────────────────────────────────────────────────────
//
// Wikimedia extmetadata returns `LicenseShortName` on each file.
// We can only filter post-fetch; this may increase rounds needed.

const LICENSE_VALUES = [
  { value: 'CC0',       label: 'CC0 (Public Domain)',   shortNames: ['CC0', 'Public Domain'] },
  { value: 'CC BY',     label: 'CC BY',                 shortNames: ['CC BY', 'CC BY 4.0', 'CC BY 3.0', 'CC BY 2.0', 'CC BY 2.5'] },
  { value: 'CC BY-SA',  label: 'CC BY-SA',              shortNames: ['CC BY-SA', 'CC BY-SA 4.0', 'CC BY-SA 3.0', 'CC BY-SA 2.0', 'CC BY-SA 2.5'] },
  { value: 'Public Domain', label: 'Public Domain (Expired copyright)', shortNames: ['Public Domain', 'PD-old', 'PD', 'PD-Art'] },
];

// Check whether a file's LicenseShortName matches a set of license require/exclude values.
function licenseMatches(licenseShortName, requireSet, excludeSet) {
  if (!licenseShortName) return requireSet.size === 0;
  const lc = licenseShortName.toLowerCase();
  if (excludeSet.size > 0) {
    for (const entry of LICENSE_VALUES) {
      if (!excludeSet.has(entry.value)) continue;
      if (entry.shortNames.some(s => lc.startsWith(s.toLowerCase()))) return false;
    }
  }
  if (requireSet.size === 0) return true;
  for (const entry of LICENSE_VALUES) {
    if (!requireSet.has(entry.value)) continue;
    if (entry.shortNames.some(s => lc.startsWith(s.toLowerCase()))) return true;
  }
  return false;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function stripHtml(str) {
  return str ? str.replace(/<[^>]*>/g, '').trim() || null : null;
}

function stripCategoryPrefix(gcmtitle) {
  return gcmtitle.replace(/^Category:/, '');
}

// Weighted random selection from an array of {weight, ...} objects.
function weightedRandom(items) {
  const total = items.reduce((sum, item) => sum + item.weight, 0);
  let r = Math.random() * total;
  for (const item of items) {
    r -= item.weight;
    if (r <= 0) return item;
  }
  return items[items.length - 1];
}

// Random uppercase letter A–Z for gcmstartsortkeyprefix.
function randomSortKeyPrefix() {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  return letters[Math.floor(Math.random() * letters.length)];
}

function commonsPageUrl(title) {
  if (!title) return null;
  return `https://commons.wikimedia.org/wiki/${title.replace(/ /g, '_')}`;
}

function extractMeta(imageinfo) {
  const meta = imageinfo?.extmetadata || {};
  const raw  = key => meta[key]?.value || null;
  return {
    title:       stripHtml(raw('ObjectName')),
    creator:     stripHtml(raw('Artist')),
    dateCreated: stripHtml(raw('DateTimeOriginal')),
    license:     raw('LicenseShortName') || null,
  };
}

function iiParams(urlWidth) {
  const p = {
    prop:                    'imageinfo',
    iiprop:                  'url|size|mime|extmetadata',
    iiextmetadatafilter:     EXTMETA_FILTER,
    iiextmetadatalanguage:   'en',
  };
  if (urlWidth) p.iiurlwidth = urlWidth;
  return p;
}

function getRequireValues(filters, type) {
  return filters
    .filter(f => f.type === type && f.mode === 'require')
    .flatMap(f => f.values || []);
}

// ── Detail image detection ────────────────────────────────────────────────────
//
// Many Commons uploads include detail/closeup images alongside the full work.
// These are undesirable for display. We detect them via:
//   1. Filename keyword matching (fast, pre-download).
//   2. -deepcat:"Details of paintings" in CirrusSearch queries (search mode only).
//
// Common naming conventions for detail images:
//   - Keyword: "detail", "détail", "Detail", "signature", "signé", "fragment",
//     "closeup", "close-up", "inscription", "verso", "recto", "label", "stamp"
//   - Numbered suffix: filename ends in _02, _03, … (full work is _01 or unsuffixed)
//   - Parenthetical suffix: "(detail)", "(2)", "(3)"
//
// False-positive risk is low: these patterns are very specific to detail images
// and rarely appear in titles of standalone works.

const DETAIL_TITLE_RE = /\b(detail|d[eé]tail|closeup|close[- ]up|signature|sign[eé]|fragment|verso|recto|inscription|label|stamp)\b|\([2-9]\)|[_ -]0[2-9](?:\.|$)/i;

function isLikelyDetailImage(title) {
  if (!title) return false;
  // Strip "File:" prefix and file extension for matching.
  const name = title.replace(/^File:/i, '').replace(/\.[^.]+$/, '');
  return DETAIL_TITLE_RE.test(name);
}

// ── Filter resolution ─────────────────────────────────────────────────────────

function resolveEligibleMedia(allFilters) {
  const requireValues = new Set(
    getRequireValues(allFilters, 'media').map(v => v.toLowerCase())
  );
  const excludeValues = new Set(
    allFilters
      .filter(f => f.type === 'media' && f.mode === 'exclude')
      .flatMap(f => f.values || [])
      .map(v => v.toLowerCase())
  );
  let eligible = MEDIA_CATEGORIES.filter(c => !excludeValues.has(c.value.toLowerCase()));
  if (requireValues.size > 0) {
    eligible = eligible.filter(c => requireValues.has(c.value.toLowerCase()));
  }
  return eligible;
}

// Determine whether to use CirrusSearch rather than category browse.
// Forced by: text filters, century filter, any subject filter (subject categories
// are hierarchical — deepcat: traversal is required; direct member browse yields nothing),
// or 2+ orthogonal category filters active.
function shouldUseSearch(allFilters, textTerm) {
  if (textTerm) return true;
  if (getRequireValues(allFilters, 'century').length > 0) return true;
  if (getRequireValues(allFilters, 'subject').length > 0) return true;
  // Media filter always uses search (deepcat:) — category browse only returns direct
  // file members of the top-level category, which is near-zero for broad categories
  // like Paintings (everything is nested in subcategories).
  if (getRequireValues(allFilters, 'media').length > 0) return true;
  // Count distinct non-text category filter types with active require values.
  const activeCategoryTypes = ['institution'].filter(type =>
    getRequireValues(allFilters, type).length > 0
  );
  return activeCategoryTypes.length >= 2;
}

// Select the gcmtitle for a single-filter random browse round.
// Called only when shouldUseSearch() is false.
function resolveGcmtitle(allFilters) {
  const institutionValues = getRequireValues(allFilters, 'institution');
  const subjectValues     = getRequireValues(allFilters, 'subject');
  const eligibleMedia     = resolveEligibleMedia(allFilters);

  if (institutionValues.length > 0) {
    const pick = institutionValues[Math.floor(Math.random() * institutionValues.length)];
    return INSTITUTIONS.find(i => i.value === pick)?.gcmtitle || null;
  }
  if (subjectValues.length > 0) {
    const pick = subjectValues[Math.floor(Math.random() * subjectValues.length)];
    return SUBJECT_CATEGORIES.find(s => s.value === pick)?.gcmtitle || null;
  }
  // Media only (or no filters): weighted random draw across eligible media.
  const pool = eligibleMedia.length > 0 ? eligibleMedia : MEDIA_CATEGORIES;
  return weightedRandom(pool).gcmtitle;
}

// Build the CirrusSearch query for search mode.
// Century × media produces merged incategory clauses (e.g. "17th-century paintings").
// filterDetails adds -deepcat:"Details of paintings" to exclude detail/closeup images.
function buildSearchQuery(allFilters, textTerm, filterDetails = true) {
  const parts = [];
  if (textTerm) parts.push(textTerm);

  const institutions = getRequireValues(allFilters, 'institution');
  const centuries    = getRequireValues(allFilters, 'century');
  const subjects     = getRequireValues(allFilters, 'subject');
  const eligibleMedia = resolveEligibleMedia(allFilters);

  // Institution
  if (institutions.length > 0) {
    const pick  = institutions[Math.floor(Math.random() * institutions.length)];
    const entry = INSTITUTIONS.find(i => i.value === pick);
    if (entry) parts.push(`incategory:"${stripCategoryPrefix(entry.gcmtitle)}"`);
  }

  // Subject: use deepcat: with cross-media subject categories.
  // When subject is active, do NOT also add a media clause — the CirrusSearch intersection
  // of subject deepcat + media deepcat yields near-zero results. Commons doesn't organise
  // files at the intersection of independent subject and media category trees; you need to
  // use subject-specific category names (e.g. "deepcat:Landscapes" returns 206K cross-media
  // files, while "deepcat:Landscapes + deepcat:Paintings" returns 17).
  // Institution is the same: don't add a media clause alongside it — institution categories
  // are independent of the media category tree.
  if (subjects.length > 0) {
    const pick  = subjects[Math.floor(Math.random() * subjects.length)];
    const entry = SUBJECT_CATEGORIES.find(s => s.value === pick);
    if (entry) parts.push(`deepcat:"${entry.deepcatTitle}"`);
  } else if (institutions.length === 0) {
    // No subject, no institution: apply century × media or plain media filter.
    // Century × media: merge into a single incategory clause (e.g. "17th-century paintings").
    if (centuries.length > 0) {
      const century    = centuries[Math.floor(Math.random() * centuries.length)];
      const hyphenated = centuryToHyphenated(century);
      const mediaPool  = eligibleMedia.length > 0 ? eligibleMedia : MEDIA_CATEGORIES;
      const media      = weightedRandom(mediaPool);
      parts.push(`incategory:"${hyphenated} ${media.centuryPrefix}"`);
    } else if (eligibleMedia.length > 0 && eligibleMedia.length < MEDIA_CATEGORIES.length) {
      // Media filter without century: use deepcat to reach subcategories.
      const media = weightedRandom(eligibleMedia);
      parts.push(`deepcat:"${stripCategoryPrefix(media.gcmtitle)}"`);
    }
  }
  // Institution with no subject: institution clause already added above; no media clause.

  // Exclude detail/closeup images via category exclusion in search mode.
  if (filterDetails) {
    parts.push('-deepcat:"Details of paintings"');
  }

  return parts.join(' ');
}

// ── fetchRandomArtwork ────────────────────────────────────────────────────────

/**
 * Fetch a random artwork from Wikimedia Commons.
 *
 * Fetch strategy:
 *   No category filters at all → weighted random draw across all MEDIA_CATEGORIES (category browse)
 *   Single category filter     → random sort-key browse on that category
 *   2+ category filters        → CirrusSearch with incategory: for each
 *   Century filter             → always CirrusSearch (century × media merged into one clause)
 *   Any text filter            → CirrusSearch
 *
 * Supported filter types:
 *   media       — require/exclude: restrict by medium (Paintings, Photographs, …)
 *   institution — require: restrict to a specific museum/collection on Commons
 *   subject     — require: restrict by theme (Portraits, Landscapes, Still lifes, …)
 *   century     — require: restrict to century (13th–21st); merged with media for category precision
 *   license     — require/exclude: post-fetch filter by license type (CC0, CC BY, etc.)
 *   artist      — require: text search for artist name
 *   search      — require: general keyword search
 *
 * Options:
 *   aspectRatio   — 'all' | 'landscape' | 'portrait'
 *   sourceLabel   — override the 'source' metadata field (used by wrapper sources)
 *   preFilters    — filters pre-injected by wrapper sources (prepended before user filters)
 *   filterDetails — if true (default), skip detail/closeup images via filename patterns
 *                   and -deepcat:"Details of paintings" in search queries
 *
 * @param {Array<{type, mode, values}>} [filters=[]]
 * @param {object} [options]
 * @returns {{ imageBuffer, contentType, metadata }}
 */
async function fetchRandomArtwork(filters = [], options = {}) {
  const { aspectRatio = 'all', sourceLabel = 'Wikimedia Commons', preFilters = [], filterDetails = true } = options;
  const allFilters = [...preFilters, ...filters];

  const artistTerm = getRequireValues(allFilters, 'artist')[0] || null;
  const searchTerm = getRequireValues(allFilters, 'search')[0]  || null;
  const textTerm   = artistTerm || searchTerm || null;

  const licenseRequireSet = new Set(getRequireValues(allFilters, 'license'));
  const licenseExcludeSet = new Set(
    allFilters.filter(f => f.type === 'license' && f.mode === 'exclude').flatMap(f => f.values || [])
  );

  const useSearch    = shouldUseSearch(allFilters, textTerm);
  const eligibleMedia = resolveEligibleMedia(allFilters);

  if (!useSearch && getRequireValues(allFilters, 'media').length > 0 && eligibleMedia.length === 0) {
    throw new Error('No media types eligible after applying filters');
  }

  // In search mode, resolve a random base offset so the full result set is reachable.
  // Without this, every fetch starts at offset 0 and returns the same top results.
  //
  // Strategy: use whatever cached count we have immediately (no waiting). If no cached
  // count exists, fire the count query in parallel with the first batch query so there
  // is zero serial latency — the count result is stored for the next fetch.
  // On first-ever fetch for a given query, we use MAX_SEARCH_OFFSET as the range;
  // subsequent fetches use the accurate cached count.
  let searchBaseOffset = 0;
  let backgroundCountPromise = null;
  if (useSearch) {
    const query = buildSearchQuery(allFilters, textTerm, filterDetails);
    if (query.trim()) {
      const cachedCount = getCachedCount(query);
      if (cachedCount !== null) {
        // Cache hit: use the known count immediately, no extra API call.
        const searchableCount = Math.max(1, Math.min(cachedCount, MAX_SEARCH_OFFSET));
        searchBaseOffset = Math.floor(Math.random() * searchableCount);
      } else {
        // Cache miss: use MAX_SEARCH_OFFSET for this fetch, fire count in parallel with
        // the first batch query (it will resolve while the batch is in-flight).
        searchBaseOffset = Math.floor(Math.random() * MAX_SEARCH_OFFSET);
        backgroundCountPromise = axios.get(WIKIMEDIA_API, {
          params: {
            action:      'query',
            list:        'search',
            srsearch:    query,
            srnamespace: 6,
            srlimit:     1,
            srinfo:      'totalhits',
            format:      'json',
            origin:      '*',
          },
          headers: { 'User-Agent': USER_AGENT },
          timeout: 10000,
        }).then(r => {
          const hits = r.data.query?.searchinfo?.totalhits ?? 0;
          if (hits > 0) setCachedCount(query, hits);
        }).catch(() => {});  // non-fatal
      }
    }
  }

  for (let round = 0; round < MAX_ROUNDS; round++) {
    let pages;

    if (useSearch) {
      const query = buildSearchQuery(allFilters, textTerm, filterDetails);
      if (!query.trim()) break;
      // Advance sequentially from the random base, wrapping around within the reachable range.
      const offset = (searchBaseOffset + round * BATCH_SIZE) % (MAX_SEARCH_OFFSET + BATCH_SIZE);
      try {
        const response = await axios.get(WIKIMEDIA_API, {
          params: {
            action:       'query',
            generator:    'search',
            gsrsearch:    query,
            gsrnamespace: 6,
            gsrlimit:     BATCH_SIZE,
            gsroffset:    offset,
            ...iiParams(THUMB_LONG_EDGE),
            format:       'json',
            origin:       '*',
          },
          headers: { 'User-Agent': USER_AGENT },
          timeout: 15000,
        });
        pages = Object.values(response.data.query?.pages || {});
      } catch (err) {
        throw new Error(`Wikimedia Commons search failed: ${err.message}`);
      }
      if (!pages?.length) break;  // search exhausted
    } else {
      const gcmtitle = resolveGcmtitle(allFilters);
      if (!gcmtitle) continue;
      try {
        const response = await axios.get(WIKIMEDIA_API, {
          params: {
            action:                'query',
            generator:             'categorymembers',
            gcmtitle:              gcmtitle,
            gcmtype:               'file',
            gcmlimit:              BATCH_SIZE,
            gcmstartsortkeyprefix: randomSortKeyPrefix(),
            ...iiParams(THUMB_LONG_EDGE),
            format:                'json',
            origin:                '*',
          },
          headers: { 'User-Agent': USER_AGENT },
          timeout: 15000,
        });
        pages = Object.values(response.data.query?.pages || {});
      } catch (err) {
        throw new Error(`Failed to fetch from Wikimedia Commons: ${err.message}`);
      }
      if (!pages?.length) continue;  // empty letter prefix — try another
    }

    const shuffled = [...pages].sort(() => Math.random() - 0.5);

    for (const page of shuffled) {
      const imageinfo = page.imageinfo?.[0];
      if (!imageinfo?.url) {
        console.warn(`[wikimedia_commons] Page ${page.pageid} skipped: no image URL`);
        continue;
      }

      // Skip non-raster or vector files.
      const mime = imageinfo.mime || '';
      if (!mime.startsWith('image/') || mime === 'image/svg+xml') {
        console.warn(`[wikimedia_commons] ${page.title} skipped: unsupported type ${mime}`);
        continue;
      }

      // Detail image filter: skip closeups, signatures, and numbered detail images.
      // Applied post-fetch in all modes; search mode also excludes via -deepcat: query.
      if (filterDetails && isLikelyDetailImage(page.title)) {
        console.warn(`[wikimedia_commons] ${page.title} skipped: likely detail image`);
        continue;
      }

      // Post-fetch license filter (no API pre-filter available).
      if (licenseRequireSet.size > 0 || licenseExcludeSet.size > 0) {
        const m = extractMeta(imageinfo);
        if (!licenseMatches(m.license, licenseRequireSet, licenseExcludeSet)) {
          console.warn(`[wikimedia_commons] ${page.title} skipped: license ${m.license}`);
          continue;
        }
      }

      // Pre-download aspect ratio check.
      if (aspectRatio !== 'all' && imageinfo.width && imageinfo.height) {
        const isLandscape = imageinfo.width > imageinfo.height;
        if (aspectRatio === 'landscape' && !isLandscape) {
          console.warn(`[wikimedia_commons] ${page.title} skipped: not landscape (${imageinfo.width}x${imageinfo.height})`);
          continue;
        }
        if (aspectRatio === 'portrait' && isLandscape) {
          console.warn(`[wikimedia_commons] ${page.title} skipped: not portrait (${imageinfo.width}x${imageinfo.height})`);
          continue;
        }
      }

      // Prefer a thumbnail over the full-res original (originals can be 50–100 MB TIFFs).
      // The batch request fetched thumburls at THUMB_LONG_EDGE. Now that we've selected a
      // specific image and know its source dimensions and the output orientation, rewrite the
      // thumburl to the precisely computed width so we don't over- or under-fetch.
      let downloadUrl = imageinfo.url;  // full-res fallback
      if (imageinfo.thumburl) {
        const tw = (imageinfo.width && imageinfo.height)
          ? thumbWidthFor(imageinfo.width, imageinfo.height, aspectRatio === 'portrait' ? 'portrait' : 'landscape')
          : THUMB_LONG_EDGE;
        downloadUrl = adjustThumbWidth(imageinfo.thumburl, tw);
      }
      let imageBuffer, contentType;
      try {
        const imageResponse = await axios.get(downloadUrl, {
          responseType: 'arraybuffer',
          timeout:      30000,
          headers:      { 'User-Agent': USER_AGENT },
        });
        imageBuffer = Buffer.from(imageResponse.data);
        contentType = imageResponse.headers['content-type'] || mime || 'image/jpeg';
      } catch (err) {
        console.warn(`[wikimedia_commons] Failed to download ${page.title}: ${err.message}`);
        continue;
      }

      // Post-download aspect ratio check (fallback when API omits dimensions).
      if (aspectRatio !== 'all' && (!imageinfo.width || !imageinfo.height)) {
        try {
          const { width, height } = await sharp(imageBuffer).metadata();
          const isLandscape = width > height;
          if (aspectRatio === 'landscape' && !isLandscape) {
            console.warn(`[wikimedia_commons] ${page.title} skipped: not landscape (${width}x${height})`);
            continue;
          }
          if (aspectRatio === 'portrait' && isLandscape) {
            console.warn(`[wikimedia_commons] ${page.title} skipped: not portrait (${width}x${height})`);
            continue;
          }
        } catch (err) {
          console.warn(`[wikimedia_commons] Could not read dimensions for ${page.title}: ${err.message}`);
          continue;
        }
      }

      const m = extractMeta(imageinfo);
      return {
        imageBuffer,
        contentType,
        metadata: {
          title:       m.title,
          creator:     m.creator,
          medium:      null,
          dateCreated: m.dateCreated,
          artworkUrl:  commonsPageUrl(page.title),
          source:      sourceLabel,
        },
      };
    }
  }

  throw new Error(
    `Could not find a suitable${aspectRatio !== 'all' ? ` ${aspectRatio}` : ''} ` +
    `artwork from Wikimedia Commons after ${MAX_ROUNDS * BATCH_SIZE} attempts`
  );
}

// ── fetchByIdentifier ─────────────────────────────────────────────────────────

/**
 * Returns true if the identifier is a Wikimedia Commons file URL.
 * Accepted format: https://commons.wikimedia.org/wiki/File:Something.jpg
 */
function canHandleIdentifier(identifier) {
  return /commons\.wikimedia\.org\/wiki\/File:/i.test(identifier.trim());
}

/**
 * Fetch a specific artwork by Wikimedia Commons file URL.
 *
 * @param {string} identifier
 * @param {object} [options]
 * @param {string} [options.sourceLabel='Wikimedia Commons']
 * @returns {{ imageBuffer, contentType, metadata }}
 */
async function fetchByIdentifier(identifier, options = {}) {
  const { sourceLabel = 'Wikimedia Commons', tvOrientation = 'landscape' } = options;

  const match = identifier.trim().match(/wiki\/(File:[^#?]+)/i);
  if (!match) throw new Error('Could not extract file title from Wikimedia Commons URL');
  const fileTitle = decodeURIComponent(match[1]).replace(/_/g, ' ');

  let page;
  try {
    const response = await axios.get(WIKIMEDIA_API, {
      params: {
        action:  'query',
        titles:  fileTitle,
        ...iiParams(THUMB_LONG_EDGE),
        format:  'json',
        origin:  '*',
      },
      headers: { 'User-Agent': USER_AGENT },
      timeout: 15000,
    });
    page = Object.values(response.data.query?.pages || {})[0];
  } catch (err) {
    throw new Error(`Failed to fetch from Wikimedia Commons: ${err.message}`);
  }

  const imageinfo = page?.imageinfo?.[0];
  if (!imageinfo?.url) throw new Error(`No image URL found for ${fileTitle}`);

  const downloadUrl = imageinfo.thumburl || imageinfo.url;
  let imageBuffer, contentType;
  try {
    const imageResponse = await axios.get(downloadUrl, {
      responseType: 'arraybuffer',
      timeout:      30000,
      headers:      { 'User-Agent': USER_AGENT },
    });
    imageBuffer = Buffer.from(imageResponse.data);
    contentType = imageResponse.headers['content-type'] || 'image/jpeg';
  } catch (err) {
    throw new Error(`Failed to download Wikimedia Commons image: ${err.message}`);
  }

  const m = extractMeta(imageinfo);
  return {
    imageBuffer,
    contentType,
    metadata: {
      title:       m.title,
      creator:     m.creator,
      medium:      null,
      dateCreated: m.dateCreated,
      artworkUrl:  commonsPageUrl(fileTitle),
      source:      sourceLabel,
    },
  };
}

// ── searchPreview ─────────────────────────────────────────────────────────────

/**
 * Return up to `count` preview results for a keyword query.
 *
 * @param {string} query
 * @param {object} [options]
 * @param {number} [options.count=12]
 * @param {Array}  [options.preFilters=[]]
 * @param {string} [options.sourceLabel='Wikimedia Commons']
 * @returns {Promise<{ results, totalAvailable }>}
 */
async function searchPreview(query, options = {}) {
  const { count = 12, preFilters = [], sourceLabel = 'Wikimedia Commons' } = options;
  const srQuery = buildSearchQuery(preFilters, query) || query;

  let response;
  try {
    response = await axios.get(WIKIMEDIA_API, {
      params: {
        action:                'query',
        generator:             'search',
        gsrsearch:             srQuery,
        gsrnamespace:          6,
        gsrlimit:              count,
        prop:                  'imageinfo',
        iiprop:                'url|size|extmetadata',
        iiurlwidth:            200,
        iiextmetadatafilter:   EXTMETA_FILTER,
        iiextmetadatalanguage: 'en',
        format:                'json',
        origin:                '*',
      },
      headers: { 'User-Agent': USER_AGENT },
      timeout: 15000,
    });
  } catch (err) {
    throw new Error(`[wikimedia_commons] searchPreview failed: ${err.message}`);
  }

  const pagesMap       = response.data.query?.pages || {};
  const totalAvailable = response.data.query?.searchinfo?.totalhits ?? Object.keys(pagesMap).length;
  const pages          = Object.values(pagesMap);

  const results = [];
  for (const page of pages) {
    if (results.length >= count) break;
    const imageinfo = page.imageinfo?.[0];
    if (!imageinfo?.url) continue;
    const m = extractMeta(imageinfo);
    results.push({
      title:        m.title || page.title?.replace(/^File:/, '') || null,
      creator:      m.creator,
      thumbnailUrl: imageinfo.thumburl || imageinfo.url,
      artworkUrl:   commonsPageUrl(page.title),
      source:       sourceLabel,
    });
  }

  return { results, totalAvailable };
}

// ── countArtistArtworks ───────────────────────────────────────────────────────

/**
 * Return the approximate number of artworks for an artist.
 *
 * @param {string} artistName
 * @param {object} [options]
 * @param {Array}  [options.preFilters=[]]
 * @returns {Promise<number|null>}
 */
async function countArtistArtworks(artistName, options = {}) {
  const { preFilters = [] } = options;
  const srsearch = buildSearchQuery(preFilters, artistName) || artistName;
  try {
    const response = await axios.get(WIKIMEDIA_API, {
      params: {
        action:      'query',
        list:        'search',
        srsearch:    srsearch,
        srnamespace: 6,
        srlimit:     1,
        srinfo:      'totalhits',
        format:      'json',
        origin:      '*',
      },
      headers: { 'User-Agent': USER_AGENT },
      timeout: 10000,
    });
    return response.data.query?.searchinfo?.totalhits ?? null;
  } catch {
    return null;
  }
}

// ── selectMode ────────────────────────────────────────────────────────────────

function selectMode(filters = []) {
  const hasArtist  = filters.some(f => f.type === 'artist');
  const hasSearch  = filters.some(f => f.type === 'search');
  const hasCentury = filters.some(f => f.type === 'century');
  const textTerm   = hasArtist ? 'artist' : hasSearch ? 'search' : null;
  let mode = 'random';
  if (hasArtist)      mode = 'artist_search';
  else if (hasSearch) mode = 'keyword_search';
  else if (shouldUseSearch(filters, textTerm)) mode = 'category_search';
  return { mode, apiFilters: filters, postFilters: [] };
}

// ── getFilterTypes ────────────────────────────────────────────────────────────

const MEDIA_GROUPS = [
  { name: 'Fine Art',           values: ['Paintings', 'Drawings', 'Prints'] },
  { name: 'Photography',        values: ['Photographs'] },
  { name: 'Sculpture & Craft',  values: ['Sculptures', 'Tapestries'] },
  { name: 'Manuscripts',        values: ['Illuminated manuscripts'] },
];

const INSTITUTION_GROUPS = [
  { name: 'France',        values: ['Paris Musées', 'Louvre'] },
  { name: 'UK',            values: ['Wellcome Collection', 'National Gallery, London'] },
  { name: 'Netherlands',   values: ['Rijksmuseum'] },
  { name: 'Italy',         values: ['Uffizi'] },
  { name: 'Spain',         values: ['Prado'] },
  { name: 'Russia',        values: ['Hermitage'] },
  { name: 'United States', values: ['Smithsonian Institution', 'Cleveland Museum of Art', 'Los Angeles County Museum of Art'] },
];

const SUBJECT_GROUPS = [
  { name: 'People',        values: ['Portraits', 'Nude art'] },
  { name: 'Nature',        values: ['Landscapes', 'Animals', 'Botanical art', 'Marine art'] },
  { name: 'Themes',        values: ['Religious art', 'Mythology', 'Genre scenes', 'Battle art'] },
  { name: 'Other',         values: ['Still lifes', 'City scenes'] },
];

const CENTURY_GROUPS = [
  { name: 'Medieval',      values: ['13th century', '14th century', '15th century'] },
  { name: 'Renaissance',   values: ['16th century'] },
  { name: 'Early Modern',  values: ['17th century', '18th century'] },
  { name: 'Modern',        values: ['19th century', '20th century', '21st century'] },
];

const LICENSE_GROUPS = [
  { name: 'Open',          values: ['CC0', 'Public Domain'] },
  { name: 'Attribution',   values: ['CC BY', 'CC BY-SA'] },
];

/**
 * Returns filter type definitions for all supported filters.
 * Wrapper sources can call this and remove filter types that don't apply
 * (e.g. institution when the institution is pre-set by the wrapper).
 */
function getFilterTypes() {
  return [
    {
      type:        'media',
      label:       'Media Type',
      description: 'Restrict or exclude artworks by medium or type.',
      modes:       ['require', 'exclude'],
      multiValue:  true,
      groups:      MEDIA_GROUPS,
      values:      MEDIA_CATEGORIES.map(c => ({ value: c.value, label: c.label })),
    },
    {
      type:        'institution',
      label:       'Institution',
      description: 'Restrict to a specific museum or collection.',
      modes:       ['require'],
      multiValue:  false,
      groups:      INSTITUTION_GROUPS,
      values:      INSTITUTIONS.map(i => ({ value: i.value, label: i.label })),
    },
    {
      type:        'subject',
      label:       'Subject',
      description: 'Restrict to a theme or subject category.',
      modes:       ['require'],
      multiValue:  false,
      groups:      SUBJECT_GROUPS,
      values:      SUBJECT_CATEGORIES.map(s => ({ value: s.value, label: s.label })),
    },
    {
      type:        'century',
      label:       'Century',
      description: 'Restrict to artworks from a specific century. Combined with Media Type for category precision.',
      modes:       ['require'],
      multiValue:  false,
      groups:      CENTURY_GROUPS,
      values:      CENTURY_VALUES.map(v => ({ value: v, label: v })),
    },
    {
      type:        'license',
      label:       'License',
      description: 'Restrict or exclude by license type. Applied after download — may require more API calls.',
      modes:       ['require', 'exclude'],
      multiValue:  true,
      groups:      LICENSE_GROUPS,
      values:      LICENSE_VALUES.map(l => ({ value: l.value, label: l.label })),
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
      description: 'Search by title, subject, or keyword.',
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
      key:         'filterDetails',
      type:        'boolean',
      default:     true,
      label:       'Filter detail images',
      description: 'Skip closeups, signatures, and numbered detail images based on filename patterns. Also excludes the "Details of paintings" category in search mode.',
    },
  ],
};

function getExtraOptions(settings) {
  return {
    filterDetails: settings?.filterDetails !== false,  // default true when unset
  };
}

// ── Metadata declarations ─────────────────────────────────────────────────────

const metadataFields = [
  { key: 'title',       label: 'Title',        description: 'Artwork title from Wikimedia Commons ObjectName' },
  { key: 'creator',     label: 'Creator',      description: 'Artist or maker name' },
  { key: 'dateCreated', label: 'Date Created', description: 'Date or period the artwork was created', format: 'date' },
  { key: 'artworkUrl',  label: 'Artwork URL',   description: 'Link to the artwork on Wikimedia Commons' },
  { key: 'source',      label: 'Source',       description: 'Source label (Wikimedia Commons, or institution name for wrappers)' },
];

const defaultMapping = {
  title:       'title',
  creator:     { entity: 'creator', attribute: 'name' },
  dateCreated: 'date',
  artworkUrl:  'artwork_url',
  source:      null,
};

// ── Startup cache warm-up ─────────────────────────────────────────────────────
//
// Pre-populate totalhits cache for common filter combinations so the first user
// fetch doesn't pay the count query latency. Runs asynchronously at module load;
// failures are silently ignored.

const WARMUP_QUERIES = [
  // No filters (default random — all media weighted draw uses search when media filter active,
  // but pure no-filter uses category browse, so warm up the most common single-filter combos)
  'deepcat:"Paintings" -deepcat:"Details of paintings"',
  'deepcat:"Photographs" -deepcat:"Details of paintings"',
  'deepcat:"Landscapes" -deepcat:"Details of paintings"',
  'deepcat:"Portraits" -deepcat:"Details of paintings"',
];

(async () => {
  for (const query of WARMUP_QUERIES) {
    if (getCachedCount(query) !== null) continue;
    try {
      const r = await axios.get(WIKIMEDIA_API, {
        params: { action: 'query', list: 'search', srsearch: query, srnamespace: 6, srlimit: 1, srinfo: 'totalhits', format: 'json', origin: '*' },
        headers: { 'User-Agent': USER_AGENT },
        timeout: 15000,
      });
      const hits = r.data.query?.searchinfo?.totalhits ?? 0;
      if (hits > 0) setCachedCount(query, hits);
    } catch {}
  }
})();

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
  // Exported for use by thin wrappers.
  INSTITUTIONS,
  MEDIA_CATEGORIES,
  SUBJECT_CATEGORIES,
};
