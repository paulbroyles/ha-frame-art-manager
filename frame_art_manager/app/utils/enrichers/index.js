const wikidataArtist = require('./wikidata_artist');
const { mergePreferContent } = require('../merge');
const { suggestArtists, enrichArtist } = require('../wikidata');

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

/**
 * Extract all 4-digit years from a lifespan string.
 * e.g. "1606 - 1669" → { birth: 1606, death: 1669 }
 *      "b. 1452"     → { birth: 1452, death: null }
 */
function extractYears(lifespan) {
  if (!lifespan) return { birth: null, death: null };
  const years = (String(lifespan).match(/\b\d{4}\b/g) || []).map(Number);
  return { birth: years[0] || null, death: years[1] || null };
}

/**
 * Returns true if both lifespans provide a birth or death year that disagrees.
 * If either string is absent/empty, no conflict can be detected → returns false.
 */
function lifespanConflict(sourceLifespan, wikidataLifespan) {
  if (!sourceLifespan || !wikidataLifespan) return false;
  const src = extractYears(sourceLifespan);
  const wd  = extractYears(wikidataLifespan);
  if (src.birth && wd.birth && src.birth !== wd.birth) return true;
  if (src.death && wd.death && src.death !== wd.death) return true;
  return false;
}

/**
 * Fire-and-forget: auto-create an entity instance for a web-source artist not yet
 * in the local library. Searches Wikidata by name, validates identity against
 * lifespan years if the source provides them, then creates the instance with
 * _links.wikidataId so it survives orphan cleanup.
 *
 * @param {MetadataHelper} helper
 * @param {string}         entityId
 * @param {object}         entityType
 * @param {object}         snapshotAttrs  - display attrs from the web source (name, lifespan, …)
 */
/**
 * Dry-run enrichment for a single artist entity snapshot — performs the same
 * Wikidata lookup as autoLinkArtistFromWebSource but returns the merged data
 * without writing anything. Used by the test panel to preview enriched metadata.
 *
 * @param {object} entityType    - The entity type object (must have kind='artist')
 * @param {object} snapshotAttrs - Raw snapshot attrs from the web source
 * @returns {Promise<object>}    - Merged attrs (may be identical to input if no enrichment found)
 */
async function previewArtistEnrichment(entityType, snapshotAttrs) {
  if (entityType.kind !== 'artist') return snapshotAttrs;
  const keyAttr = entityType.attributes[0];
  const name = snapshotAttrs[keyAttr];
  if (!name) return snapshotAttrs;

  try {
    const candidates = await suggestArtists(name, 3);
    for (const candidate of candidates) {
      if (!candidate.wikidataId) continue;
      const wikidataData = await enrichArtist(candidate.wikidataId);
      if (!wikidataData) continue;
      if (lifespanConflict(snapshotAttrs.lifespan, wikidataData.lifespan)) continue;
      return mergePreferContent(snapshotAttrs, wikidataData);
    }
  } catch (err) {
    console.warn(`[enrichers] previewArtistEnrichment failed for "${name}": ${err.message}`);
  }
  return snapshotAttrs;
}

async function autoLinkArtistFromWebSource(helper, entityId, entityType, snapshotAttrs) {
  if (entityType.kind !== 'artist') return;
  const keyAttr = entityType.attributes[0];
  const name = snapshotAttrs[keyAttr];
  if (!name) return;

  const candidates = await suggestArtists(name, 3);
  for (const candidate of candidates) {
    if (!candidate.wikidataId) continue;
    const wikidataData = await enrichArtist(candidate.wikidataId);
    if (!wikidataData) continue;
    if (lifespanConflict(snapshotAttrs.lifespan, wikidataData.lifespan)) continue;

    // Compatible match — merge source attrs (win) with Wikidata, then create instance
    const merged = mergePreferContent(snapshotAttrs, wikidataData);
    await helper.upsertEntityInstance(entityId, merged, {
      _links: { wikidataId: candidate.wikidataId },
    });
    return;
  }
}

/**
 * Dry-run enrichment for a full entitySnapshot — enriches each artist entity
 * in-place and returns a new snapshot with merged data. Non-artist entity types
 * are returned unchanged. Errors per entity are non-fatal.
 *
 * @param {object} entitySnapshot - { entityId: { attrName: value } }
 * @param {Array}  entityTypes    - Full entity type list from metadata (for kind lookup)
 * @returns {Promise<object>}     - New snapshot with enriched artist entries
 */
async function enrichEntitySnapshotPreview(entitySnapshot, entityTypes = []) {
  const result = {};
  await Promise.all(
    Object.entries(entitySnapshot).map(async ([entityId, attrs]) => {
      const entityType = entityTypes.find(e => e.id === entityId);
      result[entityId] = entityType
        ? await previewArtistEnrichment(entityType, attrs)
        : attrs;
    })
  );
  return result;
}

module.exports = { enrichArtistInstance, autoLinkArtistFromWebSource, enrichEntitySnapshotPreview };
