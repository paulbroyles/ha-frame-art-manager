const wikidataArtist = require('./wikidata_artist');
const { mergePreferContent } = require('../merge');

/**
 * Enrich an artist-kind entity instance using all applicable enrichers.
 * Only fills fields that are empty in the current instance (content wins).
 *
 * @param {object} entityType  - The entity type object (must have kind='artist')
 * @param {object} instance    - The current instance data (including _links)
 * @returns {Promise<object|null>} Merged instance with enriched fields, or null if nothing changed
 */
async function enrichArtistInstance(entityType, instance) {
  if (entityType.kind !== 'artist') return null;

  const enrichments = await Promise.all([
    wikidataArtist.enrich(instance),
    // future: artsyArtist.enrich(instance),
  ]);

  const merged = mergePreferContent(instance, ...enrichments);

  // Return null if nothing actually changed
  const changed = Object.keys(merged).some(k => merged[k] !== instance[k]);
  return changed ? merged : null;
}

module.exports = { enrichArtistInstance };
