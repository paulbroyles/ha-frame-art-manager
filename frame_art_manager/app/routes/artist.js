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
const moma = require('../sources/moma');
const artsy = require('../sources/artsy');
const googleArts = require('../sources/google_arts');
const metMuseum = require('../sources/met_museum');
const louvre = require('../sources/louvre');
const delart = require('../sources/delart');

// Wire the resolver once at module load time.
// Source suggest functions are injected — the resolver has no direct dependency on these modules.
const resolver = createArtistResolver({
  sources: [
    { id: 'moma',        suggestArtists: moma.suggestArtists },
    { id: 'artsy',       suggestArtists: artsy.suggestArtists },
    { id: 'google_arts', suggestArtists: googleArts.suggestArtists },
    { id: 'delart',      suggestArtists: delart.suggestArtists },
  ],
  wikidata,
  timeout: 800,
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
    const localInstances = (metadata.entityInstances || {}).creator || {};

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
 * All capable sources are queried in parallel. Sources that don't support
 * counting (Artsy) return null.
 *
 * Response:
 * {
 *   "artist": "Van Gogh",
 *   "counts": {
 *     "moma":        42,
 *     "met_museum":  8,      // raw API total — may include partial-word false matches
 *     "google_arts": 50,
 *     "louvre":      60,     // estimated artworks (pages × 20); null if probe failed
 *     "delart":      7,      // artworks in DelArt people directory
 *     "artsy":       null    // not countable without additional API calls
 *   },
 *   "units": {
 *     "louvre": "pages"      // all others default to "artworks"
 *   }
 * }
 */
router.get('/counts', async (req, res) => {
  const artist = (req.query.artist || '').trim();
  if (artist.length < 2) {
    return res.status(400).json({ error: 'artist must be at least 2 characters' });
  }

  const [momaCount, metCount, googleCount, louvreCount, delartCount] = await Promise.all([
    moma.countArtistArtworks(artist),
    metMuseum.countArtistArtworks(artist),
    googleArts.countArtistArtworks(artist),
    louvre.countArtistArtworks(artist),
    delart.countArtistArtworks(artist),
  ]);

  res.json({
    artist,
    counts: {
      moma:        momaCount,
      met_museum:  metCount,
      google_arts: googleCount,
      louvre:      louvreCount,
      delart:      delartCount,
      artsy:       null,
    },
    units: {},
  });
});

module.exports = router;
