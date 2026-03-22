const { enrichArtist } = require('../wikidata');

/**
 * Enriches an artist-kind entity instance using Wikidata.
 * Requires instance._links.wikidataId to be set.
 * Returns a partial data object with any fields that could be fetched;
 * returns {} on failure (graceful degradation).
 */
async function enrich(instance) {
  const wikidataId = instance._links && instance._links.wikidataId;
  if (!wikidataId) return {};
  try {
    return await enrichArtist(wikidataId) || {};
  } catch (err) {
    console.warn(`[wikidata_artist] Enrichment failed for ${wikidataId}: ${err.message}`);
    return {};
  }
}

module.exports = { enrich };
