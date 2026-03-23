'use strict';

/**
 * Artist suggest and enrich endpoints.
 *
 * Mounted at /api/artist-suggest by server.js.
 *
 * GET /api/artist-suggest?q=monet&limit=8
 *   Returns merged artist suggestions from all sources + Wikidata.
 *   Includes local gallery creator instances when they match.
 *
 * GET /api/artist-suggest/enrich?wikidataId=Q296
 *   Fetches structured artist data (name, lifespan, nationality, description)
 *   from Wikidata. Used to auto-fill local entity fields on selection.
 */

const express = require('express');
const router = express.Router();
const MetadataHelper = require('../metadata_helper');
const { createArtistResolver } = require('../utils/artistResolver');
const wikidata = require('../utils/wikidata');
const SOURCE_MODULES = require('../sources');

// Wire the resolver once at module load time.
// Derived dynamically from SOURCE_MODULES — any source that exports suggestArtists
// is automatically included. No manual list to maintain.
const resolver = createArtistResolver({
  sources: Object.entries(SOURCE_MODULES)
    .filter(([, mod]) => mod.suggestArtists)
    .map(([id, mod]) => ({ id, suggestArtists: mod.suggestArtists })),
  wikidata,
  timeout: 1500,
});

/**
 * GET /api/artist-suggest?q=monet&limit=8
 *
 * Response:
 * {
 *   "suggestions": [
 *     {
 *       "name": "Claude Monet",
 *       "sources": ["local", "moma", "artsy", "google_arts", "wikidata"],
 *       "momaCount": 42,
 *       "artsySlug": "claude-monet",
 *       "googleEntityId": "/m/0cv3w",
 *       "wikidataId": "Q296",
 *       "description": "French painter (1840–1926)",
 *       "localInstanceKey": "claude-monet"   // only if in local gallery
 *     }
 *   ]
 * }
 */
router.get('/', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) {
    return res.status(400).json({ error: 'Query must be at least 2 characters' });
  }
  const limit = Math.min(parseInt(req.query.limit, 10) || 8, 20);

  try {
    const helper = new MetadataHelper(req.frameArtPath);
    const metadata = await helper.readMetadata();

    // Collect instances from all artist-kind entity types (not just hardcoded 'creator')
    const artistKindTypes = (metadata.entityTypes || []).filter(e => e.kind === 'artist');
    const localInstances = {};
    for (const et of artistKindTypes) {
      Object.assign(localInstances, (metadata.entityInstances || {})[et.id] || {});
    }

    const suggestions = await resolver.suggest(q, { localInstances, limit });
    res.json({ suggestions });
  } catch (err) {
    console.error('[artist-suggest] suggest error:', err);
    res.status(500).json({ error: 'Failed to fetch artist suggestions' });
  }
});

/**
 * GET /api/artist-suggest/enrich?wikidataId=Q296
 *
 * Response: { name, lifespan, nationality, description, wikidataId }
 */
router.get('/enrich', async (req, res) => {
  const wikidataId = (req.query.wikidataId || '').trim();
  if (!wikidataId) {
    return res.status(400).json({ error: 'wikidataId is required' });
  }

  try {
    const data = await resolver.enrich(wikidataId);
    if (!data) {
      return res.status(404).json({ error: `No Wikidata entity found for ${wikidataId}` });
    }
    res.json(data);
  } catch (err) {
    console.error('[artist-suggest] enrich error:', err);
    res.status(500).json({ error: 'Failed to fetch artist data from Wikidata' });
  }
});

/**
 * GET /api/artist-suggest/counts?artist=Van+Gogh
 *
 * Returns per-source artwork counts for a given artist name.
 * All sources that export countArtistArtworks are queried in parallel.
 * Sources without that export return null. Also includes a local gallery count.
 *
 * Response:
 * {
 *   "artist": "Van Gogh",
 *   "counts": {
 *     "local":       3,
 *     "moma":        42,
 *     "met_museum":  8,
 *     ...
 *   }
 * }
 */
router.get('/counts', async (req, res) => {
  const artist = (req.query.artist || '').trim();
  if (artist.length < 2) {
    return res.status(400).json({ error: 'artist must be at least 2 characters' });
  }

  const helper = new MetadataHelper(req.frameArtPath);
  const sourceEntries = Object.entries(SOURCE_MODULES);

  const [sourceCounts, localImages] = await Promise.all([
    Promise.all(sourceEntries.map(([, mod]) =>
      mod.countArtistArtworks
        ? mod.countArtistArtworks(artist).catch(() => null)
        : Promise.resolve(null)
    )),
    helper.getLocalArtistImages(artist),
  ]);

  const counts = { local: localImages.length };
  sourceEntries.forEach(([id], i) => { counts[id] = sourceCounts[i]; });

  res.json({ artist, counts });
});

module.exports = router;
