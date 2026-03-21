/**
 * Artist resolver — merges artist name suggestions from multiple sources.
 *
 * This module has NO dependencies on the Frame Art Manager application.
 * Source suggest functions and the Wikidata client are injected at creation
 * time, so this module can be extracted alongside MetaMuseum without changes.
 *
 * Usage:
 *   const resolver = createArtistResolver({ sources, wikidata, timeout });
 *   const results  = await resolver.suggest('monet', { localInstances, limit });
 *   const details  = await resolver.enrich('Q296');
 */

/**
 * Create an artist resolver that fans out to all injected sources and merges results.
 *
 * @param {object} opts
 * @param {Array<{ id: string, suggestArtists: (query, limit) => Promise<Array> }>} opts.sources
 *   Art-database suggest functions. Each returns an array of
 *   { name, source, ...sourceSpecificIds }
 * @param {{ suggestArtists, enrichArtist }} opts.wikidata
 *   Wikidata client (from utils/wikidata.js or equivalent).
 * @param {number} [opts.timeout=800]
 *   Milliseconds before remote source calls are abandoned (MoMA is instant and unaffected).
 * @returns {{ suggest, enrich }}
 */
function createArtistResolver({ sources = [], wikidata, timeout = 800 }) {
  /**
   * Suggest artist name candidates from all sources.
   *
   * Merge strategy:
   * - Deduplication by case-insensitive name match.
   * - Local instances always sort first (already in gallery).
   * - Exact prefix matches before substring-only matches.
   * - Within each group: by source count desc, then by MoMA artwork count desc.
   *
   * @param {string} query
   * @param {object} [opts]
   * @param {object} [opts.localInstances] - creator entity instances from metadata
   *   (format: { [instanceKey]: { name, lifespan, nationality } })
   * @param {number} [opts.limit=8]
   * @returns {Promise<Array>} Merged suggestion objects
   */
  async function suggest(query, { localInstances = {}, limit = 8 } = {}) {
    const qLower = query.toLowerCase().trim();

    // ── Local instances (instant) ───────────────────────────────────────────
    const localResults = Object.entries(localInstances)
      .filter(([, data]) => (data.name || '').toLowerCase().includes(qLower))
      .map(([instanceKey, data]) => ({
        name:             data.name,
        sources:          ['local'],
        localInstanceKey: instanceKey,
      }));

    // ── Remote source calls (with timeout) ─────────────────────────────────
    const withTimeout = (promise) => Promise.race([
      promise,
      new Promise(resolve => setTimeout(() => resolve([]), timeout)),
    ]);

    const [wikidataSuggestions, ...sourceSuggestions] = await Promise.all([
      wikidata ? withTimeout(wikidata.suggestArtists(query, 5)) : Promise.resolve([]),
      ...sources.map(s => withTimeout(s.suggestArtists(query, s.id === 'moma' ? 15 : 5))),
    ]);

    // ── Merge all results into a unified list ───────────────────────────────
    // Index: normalizedName → merged entry
    const index = new Map();

    // Seed with local instances (highest priority)
    for (const r of localResults) {
      index.set(r.name.toLowerCase(), r);
    }

    // Merge art source results
    for (let i = 0; i < sources.length; i++) {
      const sourceId = sources[i].id;
      for (const r of sourceSuggestions[i] || []) {
        const key = (r.name || '').toLowerCase();
        if (!key) continue;
        if (index.has(key)) {
          const existing = index.get(key);
          if (!existing.sources.includes(sourceId)) existing.sources.push(sourceId);
          // Attach source-specific IDs
          if (r.slug      && !existing.artsySlug)      existing.artsySlug      = r.slug;
          if (r.entityId  && !existing.googleEntityId)  existing.googleEntityId = r.entityId;
          if (r.count     && !existing.momaCount)       existing.momaCount      = r.count;
        } else {
          index.set(key, {
            name:           r.name,
            sources:        [sourceId],
            momaCount:      r.count     || undefined,
            artsySlug:      r.slug      || undefined,
            googleEntityId: r.entityId  || undefined,
          });
        }
      }
    }

    // Merge Wikidata results (provides wikidataId + description)
    for (const r of wikidataSuggestions) {
      const key = (r.name || '').toLowerCase();
      if (!key) continue;
      if (index.has(key)) {
        const existing = index.get(key);
        if (!existing.sources.includes('wikidata')) existing.sources.push('wikidata');
        if (!existing.wikidataId)   existing.wikidataId   = r.wikidataId;
        if (!existing.description)  existing.description  = r.description;
      } else {
        index.set(key, {
          name:        r.name,
          sources:     ['wikidata'],
          wikidataId:  r.wikidataId,
          description: r.description,
        });
      }
    }

    // ── Sort ────────────────────────────────────────────────────────────────
    const all = Array.from(index.values());

    all.sort((a, b) => {
      // Local instances first
      const aLocal = a.sources.includes('local') ? 0 : 1;
      const bLocal = b.sources.includes('local') ? 0 : 1;
      if (aLocal !== bLocal) return aLocal - bLocal;

      // Exact prefix match before substring-only
      const aPrefix = a.name.toLowerCase().startsWith(qLower) ? 0 : 1;
      const bPrefix = b.name.toLowerCase().startsWith(qLower) ? 0 : 1;
      if (aPrefix !== bPrefix) return aPrefix - bPrefix;

      // More sources = higher confidence
      if (b.sources.length !== a.sources.length) return b.sources.length - a.sources.length;

      // MoMA count as tiebreaker
      return (b.momaCount || 0) - (a.momaCount || 0);
    });

    return all.slice(0, limit);
  }

  /**
   * Fetch structured artist data for a known Wikidata Q-ID.
   * Returns { name, lifespan, nationality, description, wikidataId } or null.
   */
  async function enrich(wikidataId) {
    if (!wikidata) return null;
    return wikidata.enrichArtist(wikidataId);
  }

  return { suggest, enrich };
}

module.exports = { createArtistResolver };
