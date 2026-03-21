/**
 * Lightweight Wikidata client for artist search and enrichment.
 *
 * This module has NO dependencies on the Frame Art Manager application.
 * Only dependency: axios (or the fetch API). Portable — can be extracted
 * as a standalone package alongside MetaMuseum.
 *
 * Two public functions:
 *   suggestArtists(query, limit)  — search Wikidata for artist name candidates
 *   enrichArtist(wikidataId)      — fetch structured attributes for a known Q-ID
 */

const axios = require('axios');

const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';

// TTL for suggest and enrich caches (1h for suggestions, 24h for enrichment).
const SUGGEST_TTL_MS = 60 * 60 * 1000;
const ENRICH_TTL_MS  = 24 * 60 * 60 * 1000;

const _suggestCache = new Map(); // query.toLowerCase() → { results, fetchedAt }
const _enrichCache  = new Map(); // wikidataId → { data, fetchedAt }

// Description-based filter for visual artists. Matches common English descriptions
// returned by Wikidata's wbsearchentities endpoint (e.g. "French painter (1840-1926)").
// Applied client-side to remove non-artist entities (cities, surnames, animals, etc.)
// from search results. Can be upgraded to CirrusSearch haswbstatement if needed.
const ARTIST_PATTERN = /\b(painter|artist|sculptor|printmaker|illustrator|engraver|photographer|drawer|draughtsman|architect|ceramicist|goldsmith|graphic artist|muralist|portraitist|watercolorist|watercolourist|etcher|lithographer|miniaturist|colorist|colourist|craftsman|craftsperson|glassworker|jeweler|jeweller|mosaicist|weaver|textile artist|collage artist|installation artist|performance artist|mixed media|video artist)\b/i;

/**
 * Search Wikidata for artist name candidates matching a query string.
 * Uses the wbsearchentities action (~130ms, single call, no auth required).
 * Results are filtered to visual artists via description text.
 *
 * @param {string} query - Partial or full artist name
 * @param {number} [limit=5] - Max results to return after filtering
 * @returns {Promise<Array<{ name, wikidataId, description, source }>>}
 */
async function suggestArtists(query, limit = 5) {
  const key = query.toLowerCase().trim();
  const cached = _suggestCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < SUGGEST_TTL_MS) {
    return cached.results.slice(0, limit);
  }

  let results = [];
  let apiResponded = false;
  try {
    const response = await axios.get(WIKIDATA_API, {
      params: {
        action:    'wbsearchentities',
        search:    query,
        language:  'en',
        type:      'item',
        limit:     20,  // fetch more than needed to allow filtering
        format:    'json',
        uselang:   'en',
      },
      headers: { 'User-Agent': 'frame-art-manager/1.0 (artist-suggest)' },
      timeout: 5000,
    });

    const hits = response.data?.search || [];
    results = hits
      .filter(h => h.description && ARTIST_PATTERN.test(h.description))
      .slice(0, limit)
      .map(h => ({
        name:        h.label || h.match?.text || '',
        wikidataId:  h.id,
        description: h.description,
        source:      'wikidata',
      }));
    apiResponded = true;
  } catch (err) {
    console.warn(`[wikidata] suggestArtists failed for "${query}": ${err.message}`);
  }

  if (apiResponded) {
    _suggestCache.set(key, { results, fetchedAt: Date.now() });
  }
  return results;
}

/**
 * Fetch structured entity attributes for a known Wikidata Q-ID.
 * Extracts name, lifespan, nationality, and description — matching the
 * 'creator' entity attributes (name, lifespan, nationality).
 *
 * @param {string} wikidataId - Wikidata Q-ID (e.g. "Q296")
 * @returns {Promise<{ name, lifespan, nationality, description, wikidataId } | null>}
 */
async function enrichArtist(wikidataId) {
  const cached = _enrichCache.get(wikidataId);
  if (cached && Date.now() - cached.fetchedAt < ENRICH_TTL_MS) {
    return cached.data;
  }

  let data = null;
  try {
    const response = await axios.get(WIKIDATA_API, {
      params: {
        action:    'wbgetentities',
        ids:       wikidataId,
        props:     'labels|descriptions|claims',
        languages: 'en',
        format:    'json',
      },
      headers: { 'User-Agent': 'frame-art-manager/1.0 (artist-enrich)' },
      timeout: 8000,
    });

    const entity = response.data?.entities?.[wikidataId];
    if (!entity || entity.missing) {
      _enrichCache.set(wikidataId, { data: null, fetchedAt: Date.now() });
      return null;
    }

    const name        = entity.labels?.en?.value || null;
    const description = entity.descriptions?.en?.value || null;
    const claims      = entity.claims || {};

    // P569: date of birth, P570: date of death — extract year from datavalue.value.time
    const birthYear = _extractYear(claims['P569']?.[0]);
    const deathYear = _extractYear(claims['P570']?.[0]);
    const lifespan  = birthYear && deathYear
      ? `${birthYear}–${deathYear}`
      : birthYear ? `b. ${birthYear}` : null;

    // P27: country of citizenship — use English label of first value
    const citizenshipId = claims['P27']?.[0]?.mainsnak?.datavalue?.value?.id;
    const nationality = citizenshipId ? await _resolveLabel(citizenshipId) : null;

    data = { name, lifespan, nationality, description, wikidataId };
  } catch (err) {
    console.warn(`[wikidata] enrichArtist failed for "${wikidataId}": ${err.message}`);
  }

  if (data !== null) {
    _enrichCache.set(wikidataId, { data, fetchedAt: Date.now() });
  }
  return data;
}

/**
 * Extract a 4-digit year string from a Wikidata time claim value.
 * Wikidata time format: "+1840-01-01T00:00:00Z"
 */
function _extractYear(claim) {
  const time = claim?.mainsnak?.datavalue?.value?.time;
  if (!time) return null;
  const m = time.match(/[+-]?(\d{4})-/);
  return m ? m[1] : null;
}

/**
 * Resolve a single Wikidata Q-ID to its English label.
 * Used for nationality (P27) lookup. Not cached — called at most once per enrich.
 */
async function _resolveLabel(entityId) {
  try {
    const response = await axios.get(WIKIDATA_API, {
      params: {
        action:    'wbgetentities',
        ids:       entityId,
        props:     'labels',
        languages: 'en',
        format:    'json',
      },
      headers: { 'User-Agent': 'frame-art-manager/1.0 (label-resolve)' },
      timeout: 5000,
    });
    return response.data?.entities?.[entityId]?.labels?.en?.value || null;
  } catch {
    return null;
  }
}

module.exports = { suggestArtists, enrichArtist };
