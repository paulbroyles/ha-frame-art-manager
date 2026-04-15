const express = require('express');
const router = express.Router();
const MetadataHelper = require('../metadata_helper');
const { readTagsets } = require('./tagsets');
const { readMoods } = require('./moods');
const { readWebSourcesConfig, getArtistCounts } = require('./web_sources');

// Virtual tag constants (mirrored from frame-art-shuffler)
const WEB_SOURCES_VIRTUAL_TAG = 'web_sources';
const WS_TAG_PREFIX = 'ws:';

function isVirtualWebTag(tag) {
  return tag === WEB_SOURCES_VIRTUAL_TAG || tag.startsWith(WS_TAG_PREFIX);
}

function getVirtualTagId(tag) {
  return tag.startsWith(WS_TAG_PREFIX) ? tag.slice(WS_TAG_PREFIX.length) : null;
}

/**
 * Build per-tag image pools for tag-weighted selection.
 * Multi-tag images are assigned to their highest-weight matching tag.
 * Ties broken by position in includeTags (earlier = higher priority).
 */
function buildTagPools(images, includeTags, excludeTags, tagWeights) {
  const tagPools = {};
  for (const tag of includeTags) tagPools[tag] = [];

  for (const [filename, imageData] of Object.entries(images)) {
    const imageTags = new Set(imageData.tags || []);

    if (excludeTags.some(t => imageTags.has(t))) continue;

    const matchingTags = includeTags.filter(t => imageTags.has(t));
    if (matchingTags.length === 0) continue;

    // Assign to highest-weight tag; ties broken by earlier position in includeTags
    const bestTag = matchingTags.reduce((best, tag) => {
      const bw = tagWeights[best] ?? 1.0;
      const tw = tagWeights[tag] ?? 1.0;
      if (tw > bw) return tag;
      if (tw === bw && includeTags.indexOf(tag) < includeTags.indexOf(best)) return tag;
      return best;
    });

    tagPools[bestTag].push({ ...imageData, filename });
  }

  return tagPools;
}

/**
 * Weighted random choice from an array.
 * weightFn(item) returns a non-negative number.
 */
function weightedRandomChoice(items, weightFn) {
  const weights = items.map(weightFn);
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  let roll = Math.random() * total;
  for (let i = 0; i < items.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return items[i];
  }
  return items[items.length - 1];
}

/**
 * Apply recency preference: prefer images not in recentImages set.
 * Falls back to full candidates if all are recent.
 */
function applyRecencyPreference(candidates, recentImages) {
  if (!recentImages || recentImages.length === 0) {
    return { pool: candidates, freshCount: 0, usedFallback: false };
  }
  const recentSet = new Set(recentImages);
  const fresh = candidates.filter(img => !recentSet.has(img.filename));
  if (fresh.length > 0) {
    return { pool: fresh, freshCount: fresh.length, usedFallback: false };
  }
  return { pool: candidates, freshCount: 0, usedFallback: true };
}

function selectRandom(arr) {
  if (arr.length === 0) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * For an artist-mode virtual tag: perform count-weighted local-vs-source selection.
 *
 * Returns null if the tag is not an artist virtual tag (caller uses normal web_source response).
 * Returns { type: 'library', filename, ...imageData } if a local image was selected.
 * Returns { preferredSourceId } if a web source was selected (add to web_source response).
 *
 * @param {string|null} virtualTagId
 * @param {object} opts
 * @param {string} opts.frameArtPath
 * @param {object} opts.metadata  pre-loaded metadata
 * @param {MetadataHelper} opts.helper
 * @param {string|null} opts.currentImage
 * @param {string[]} opts.recentImages
 */
async function resolveArtistVirtualTag(virtualTagId, { frameArtPath, metadata, helper, currentImage, recentImages }) {
  if (!virtualTagId) return null;

  let webSources;
  try {
    webSources = await readWebSourcesConfig(frameArtPath);
  } catch {
    return null;
  }

  const virtualTag = (webSources.virtualTags || []).find(vt => vt.id === virtualTagId);
  if (!virtualTag || virtualTag.queryMode !== 'artist') return null;

  const artistName = virtualTag.queryParams?.artist;
  if (!artistName) return null;

  let counts, localImages;
  try {
    ({ counts, localImages } = await getArtistCounts(artistName, {
      aspectRatio: 'all', // aspect ratio handled later in fetchFromVirtualTag
      localCountFn: name => helper.getLocalArtistImages(name, metadata),
    }));
  } catch {
    return null;
  }

  // Build weighted pool (exclude null counts and zero counts)
  const entries = Object.entries(counts).filter(([, c]) => c != null && c > 0);
  if (entries.length === 0) return null; // no data — fall back to equal-weight dispatch

  const totalWeight = entries.reduce((s, [, c]) => s + c, 0);
  let roll = Math.random() * totalWeight;
  let chosen = entries[entries.length - 1][0];
  for (const [id, c] of entries) {
    roll -= c;
    if (roll <= 0) { chosen = id; break; }
  }

  if (chosen === 'local' && localImages.length > 0) {
    // Select a local image respecting currentImage + recency preference
    const withoutCurrent = localImages.filter(f => f !== currentImage);
    const candidates = withoutCurrent.length > 0 ? withoutCurrent : localImages;
    const { pool } = applyRecencyPreference(
      candidates.map(f => ({ filename: f })),
      recentImages
    );
    const selected = selectRandom(pool);
    const imageData = selected ? ((metadata.images || {})[selected.filename] || {}) : {};
    return { type: 'library', filename: selected?.filename, ...imageData };
  }

  if (chosen !== 'local') {
    return { preferredSourceId: chosen };
  }

  return null; // local won but no local images — fall back
}

/**
 * Build the response object for a virtual web source tag.
 * For artist tags, performs count-weighted dispatch first:
 *   - If a local image wins → returns library response
 *   - If a web source wins → returns web_source response with preferredSourceId
 * For non-artist tags → returns plain web_source response.
 */
async function makeWebSourceResponse(tag, { eligibleCount, freshCount, usedFallback, frameArtPath, metadata, helper, currentImage, recentImages }) {
  const virtualTagId = getVirtualTagId(tag);
  const artistResult = await resolveArtistVirtualTag(virtualTagId, { frameArtPath, metadata, helper, currentImage, recentImages }).catch(() => null);

  if (artistResult) {
    if (artistResult.type === 'library') {
      return { ...artistResult, eligibleCount, selectedTag: tag, freshCount: freshCount || 0, usedFallback: usedFallback || false };
    }
    // preferredSourceId: attach to web_source response
    return { type: 'web_source', virtualTagId, preferredSourceId: artistResult.preferredSourceId, eligibleCount, selectedTag: tag, freshCount: 0, usedFallback: false };
  }

  return { type: 'web_source', virtualTagId, eligibleCount, selectedTag: tag, freshCount: 0, usedFallback: false };
}

// ── Mood scoring constants ─────────────────────────────────────────────────
// Each matching boost_tag multiplies the score by (1 + strength * BOOST_FACTOR)
const BOOST_FACTOR = 0.5;
// Each matching suppress_tag (penalize mode) multiplies score by SUPPRESS_PENALTY
const SUPPRESS_PENALTY = 0.2;

/**
 * Compute a mood-adjusted score for a single image.
 *
 * @param {string[]} imageTags  Tags on the image
 * @param {Array}    activeMoodDefs  Array of resolved mood definition objects
 * @param {boolean}  inBasePool  Whether this image is in the base tagset pool
 * @returns {number} Final weighted score (log-compressed for diminishing returns)
 */
function scoreMoodImage(imageTags, activeMoodDefs, inBasePool = true) {
  const tagSet = new Set(imageTags);
  let score = inBasePool ? 1.0 : 0.5; // base pool images start higher

  for (const mood of activeMoodDefs) {
    const boostMatches = (mood.boost_tags || []).filter(t => tagSet.has(t)).length;
    if (boostMatches > 0) {
      score *= (1 + (mood.strength || 1.0) * boostMatches * BOOST_FACTOR);
    }

    if (mood.suppress_mode !== 'exclude') {
      const suppressMatches = (mood.suppress_tags || []).filter(t => tagSet.has(t)).length;
      if (suppressMatches > 0) {
        score *= Math.pow(SUPPRESS_PENALTY, suppressMatches);
      }
    }
  }

  // Diminishing returns compression
  return Math.log(1 + score);
}

/**
 * Return true if an image is hard-suppressed (suppress_mode='exclude')
 * by ANY active mood.
 */
function isMoodHardSuppressed(imageTags, activeMoodDefs) {
  const tagSet = new Set(imageTags);
  return activeMoodDefs.some(
    mood => mood.suppress_mode === 'exclude' &&
            (mood.suppress_tags || []).some(t => tagSet.has(t))
  );
}

/**
 * Get the baseline floor probability (0-1) from active moods.
 * If any exclusive mood is active, floor = 0.
 * Otherwise, the TV's configured baseline_floor is used (default 0).
 */
function getMoodBaselineFloor(activeMoodDefs, configuredFloor = 0) {
  const hasExclusive = activeMoodDefs.some(m => m.exclusive);
  return hasExclusive ? 0 : configuredFloor;
}

/**
 * Build mood-derived web source search entries from active mood definitions.
 *
 * Moods with search_terms and search_compose !== false are merged into a single
 * composed query (AND semantics via joined keyword string). Moods with
 * search_compose === false each produce an independent search entry.
 *
 * @param {Array} activeMoodDefs  Resolved mood definition objects
 * @returns {Array} Entries with { keyword, weight } for pool selection
 */
function buildMoodSearchEntries(activeMoodDefs) {
  const entries = [];
  const composing = activeMoodDefs.filter(
    m => (m.search_terms || []).length > 0 && m.search_compose !== false
  );
  if (composing.length > 0) {
    const keyword = composing.flatMap(m => m.search_terms).join(' ');
    const weight = composing.reduce((s, m) => s + (m.strength || 1.0), 0);
    entries.push({ keyword, weight });
  }
  const independent = activeMoodDefs.filter(
    m => (m.search_terms || []).length > 0 && m.search_compose === false
  );
  for (const mood of independent) {
    entries.push({ keyword: mood.search_terms.join(' '), weight: mood.strength || 1.0 });
  }
  return entries;
}

/**
 * Pick one web source entry from the combined pool of virtual tags and
 * mood-derived keyword searches, using weighted random selection.
 *
 * @param {string[]} virtualWebTags   Virtual web source tags (ws:* strings)
 * @param {object}   tagWeights       Per-tag weights from tagset config
 * @param {Array}    moodSearchEntries Entries from buildMoodSearchEntries()
 * @returns {{ kind: 'vtag', id: string } | { kind: 'mood', keyword: string } | null}
 */
function selectWebEntry(virtualWebTags, tagWeights, moodSearchEntries) {
  const pool = [
    ...virtualWebTags.map(id => ({ kind: 'vtag', id, weight: tagWeights[id] ?? 1.0 })),
    ...moodSearchEntries.map(e => ({ kind: 'mood', keyword: e.keyword, weight: e.weight })),
  ];
  if (pool.length === 0) return null;
  return weightedRandomChoice(pool, e => e.weight);
}

/**
 * Resolve tagset and mood parameters into canonical pool-building inputs.
 *
 * Given raw request fields (tagsetName, includeTags, excludeTags, tagWeights,
 * weightingType, activeMoods), returns the resolved set of fields ready for
 * pool construction.
 *
 * @param {object} params
 * @param {string} frameArtPath
 * @returns {Promise<{includeTags, excludeTags, tagWeights, weightingType, activeMoodDefs, moodExpandedTags}>}
 */
async function resolvePoolParams(params, frameArtPath) {
  let {
    tagsetName = null,
    includeTags = [],
    excludeTags = [],
    tagWeights = {},
    weightingType = 'image',
    activeMoods = [],
  } = params;

  if (tagsetName) {
    const tagsetsConfig = await readTagsets(frameArtPath);
    const tagset = tagsetsConfig.tagsets[tagsetName];
    if (tagset) {
      includeTags = tagset.tags || [];
      excludeTags = tagset.exclude_tags || [];
      tagWeights = tagset.tag_weights || {};
      weightingType = tagset.weighting_type || 'image';
    }
  }

  let activeMoodDefs = [];
  if (activeMoods && activeMoods.length > 0) {
    try {
      const moodsConfig = await readMoods(frameArtPath);
      activeMoodDefs = activeMoods.map(id => moodsConfig.moods[id]).filter(Boolean);
    } catch (err) {
      console.warn('[shuffle] Could not read moods:', err.message);
    }
  }

  // Exclusive mood override
  const exclusiveMoods = activeMoodDefs.filter(m => m.exclusive);
  let moodExpandedTags = new Set();

  if (exclusiveMoods.length > 0) {
    const winnerMood = exclusiveMoods.reduce((a, b) => (b.strength || 1.0) > (a.strength || 1.0) ? b : a);
    includeTags = winnerMood.boost_tags || [];
    excludeTags = [...excludeTags, ...(winnerMood.suppress_tags || [])];
    tagWeights = {};
    weightingType = 'image';
  } else if (activeMoodDefs.length > 0) {
    const baseTagSet = new Set(includeTags.filter(t => !isVirtualWebTag(t)));
    for (const mood of activeMoodDefs) {
      for (const tag of (mood.boost_tags || [])) {
        if (!baseTagSet.has(tag)) moodExpandedTags.add(tag);
      }
    }
  }

  return { includeTags, excludeTags, tagWeights, weightingType, activeMoodDefs, moodExpandedTags };
}

/**
 * Build the library pool and web entry list from resolved pool parameters.
 *
 * Returns the full scored pool (all eligible images with mood scores), excluded
 * images, and web source entries — without performing random selection.
 *
 * @param {object} resolved  Output from resolvePoolParams()
 * @param {object} images    Metadata images map (already blacklist-filtered)
 * @returns {object} { libraryPool, excludedImages, virtualWebTags, moodSearchEntries, webEntries, stats }
 */
function buildScoredPool(resolved, images) {
  const { includeTags, excludeTags, tagWeights, weightingType, activeMoodDefs, moodExpandedTags } = resolved;

  const virtualWebTags = includeTags.filter(isVirtualWebTag);
  const libraryIncludeTags = includeTags.filter(t => !isVirtualWebTag(t));
  const moodSearchEntries = buildMoodSearchEntries(activeMoodDefs);
  const hasWebSources = virtualWebTags.length > 0 || moodSearchEntries.length > 0;

  const libraryPool = [];
  const excludedImages = [];

  for (const [filename, img] of Object.entries(images)) {
    const imgTags = new Set(img.tags || []);

    // Hard exclude: suppress_mode=exclude
    if (activeMoodDefs.length > 0 && isMoodHardSuppressed(img.tags || [], activeMoodDefs)) {
      excludedImages.push({ filename, tags: img.tags || [], reason: 'mood_suppress' });
      continue;
    }

    // Tag exclusion
    if (excludeTags.some(t => imgTags.has(t))) {
      excludedImages.push({ filename, tags: img.tags || [], reason: 'excluded_tag' });
      continue;
    }

    // Determine membership
    let inBasePool = false;

    if (libraryIncludeTags.length === 0) {
      inBasePool = true;
    } else if (libraryIncludeTags.some(t => imgTags.has(t))) {
      inBasePool = true;
    } else if (moodExpandedTags.size > 0 && [...moodExpandedTags].some(t => imgTags.has(t))) {
      inBasePool = false; // in expanded pool only (mood boost)
    } else {
      continue; // not in any pool
    }

    const score = scoreMoodImage(img.tags || [], activeMoodDefs, inBasePool);
    libraryPool.push({ filename, tags: img.tags || [], score, inBasePool, boosted: score > (inBasePool ? Math.log(2) : Math.log(1.5)), suppressed: score < (inBasePool ? Math.log(1.5) : Math.log(1.2)) });
  }

  // Sort by score descending
  libraryPool.sort((a, b) => b.score - a.score);

  // Build web entries for display
  const webEntries = [
    ...virtualWebTags.map(tag => ({ kind: 'vtag', id: getVirtualTagId(tag) || tag, tag, weight: tagWeights[tag] ?? 1.0 })),
    ...moodSearchEntries.map(e => ({ kind: 'mood', keyword: e.keyword, weight: e.weight })),
  ];

  const stats = {
    totalEligible: libraryPool.length,
    hardExcluded: excludedImages.filter(e => e.reason === 'mood_suppress').length,
    tagExcluded: excludedImages.filter(e => e.reason === 'excluded_tag').length,
    moodExpanded: libraryPool.filter(i => !i.inBasePool).length,
    webEntryCount: webEntries.length,
    hasWebSources,
  };

  return { libraryPool, excludedImages, virtualWebTags, moodSearchEntries, webEntries, stats };
}

/**
 * POST /api/shuffle/preview
 *
 * Returns the full scored library pool and web entry list for a given
 * tagset + mood combination. Used by the Preview tab in the test page.
 *
 * Request body:
 *   tagsetName    string?   Tagset to resolve (optional)
 *   activeMoods   string[]  Mood IDs to apply (optional)
 *   sampleSize    number    Max library images to return (default 50)
 *
 * Response:
 *   { libraryPool, excludedImages, webEntries, stats }
 */
router.post('/preview', async (req, res) => {
  try {
    const { tagsetName = null, activeMoods = [], sampleSize = 50 } = req.body;

    const resolved = await resolvePoolParams(
      { tagsetName, activeMoods },
      req.frameArtPath
    );

    const helper = new MetadataHelper(req.frameArtPath);
    const metadata = await helper.readMetadata();

    const blacklist = await helper.readBlacklist().catch(() => ({ local: [], web: [] }));
    const blacklistedLocal = new Set(blacklist.local || []);
    let images = metadata.images || {};
    if (blacklistedLocal.size > 0) {
      images = Object.fromEntries(
        Object.entries(images).filter(([f]) => !blacklistedLocal.has(f))
      );
    }

    const { libraryPool, excludedImages, webEntries, stats } = buildScoredPool(resolved, images);

    return res.json({
      libraryPool: libraryPool.slice(0, sampleSize),
      excludedImages: excludedImages.slice(0, sampleSize),
      webEntries,
      stats,
    });
  } catch (err) {
    console.error('[shuffle/preview] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/shuffle/select
 *
 * Selects a random image from the library (or a virtual web source tag)
 * based on the provided tagset constraints. Mirrors the logic of
 * _select_random_image() in frame-art-shuffler's shuffle.py.
 *
 * Request body:
 *   includeTags     string[]  Tags images must match (at least one)
 *   excludeTags     string[]  Tags images must not have
 *   tagWeights      object    {tag: weight} — optional, defaults to 1.0
 *   weightingType   string    "image" (default) or "tag"
 *   currentImage    string?   Currently displayed filename (excluded from selection)
 *   recentImages    string[]  Recently shown filenames (soft-excluded via recency preference)
 *
 * Response (library image):
 *   { type: "library", filename, tags, attributes, entityRefs, matte, filter,
 *     eligibleCount, selectedTag, freshCount, usedFallback }
 *
 * Response (web source):
 *   { type: "web_source", virtualTagId, eligibleCount, selectedTag, freshCount, usedFallback }
 *
 * Response (no eligible images):
 *   { type: "none", eligibleCount }
 */
router.post('/select', async (req, res) => {
  try {
    let {
      tagsetName = null,
      includeTags = [],
      excludeTags = [],
      tagWeights = {},
      weightingType = 'image',
      currentImage = null,
      recentImages = [],
      activeMoods = [],
    } = req.body;

    // If tagsetName is provided, resolve the tagset definition locally.
    // Falls back to raw includeTags/excludeTags/tagWeights/weightingType if
    // tagsetName is absent (backward compat) or tagset not found.
    if (tagsetName) {
      const tagsetsConfig = await readTagsets(req.frameArtPath);
      const tagset = tagsetsConfig.tagsets[tagsetName];
      if (tagset) {
        includeTags = tagset.tags || [];
        excludeTags = tagset.exclude_tags || [];
        tagWeights = tagset.tag_weights || {};
        weightingType = tagset.weighting_type || 'image';
      }
    }

    // Resolve active mood definitions
    let activeMoodDefs = [];
    if (activeMoods && activeMoods.length > 0) {
      try {
        const moodsConfig = await readMoods(req.frameArtPath);
        activeMoodDefs = activeMoods
          .map(id => moodsConfig.moods[id])
          .filter(Boolean);
      } catch (err) {
        console.warn('[shuffle/select] Could not read moods:', err.message);
      }
    }

    // If an exclusive mood is active, redirect pool to that mood's boost_tags
    const exclusiveMoods = activeMoodDefs.filter(m => m.exclusive);
    const activeMoodsTotalStrength = activeMoodDefs.reduce((s, m) => s + (m.strength || 1.0), 0);
    let moodExpandedTags = new Set(); // tags added from mood boost_tags beyond base pool

    if (exclusiveMoods.length > 0) {
      // Highest-strength exclusive mood wins
      const winnerMood = exclusiveMoods.reduce((a, b) => (b.strength || 1.0) > (a.strength || 1.0) ? b : a);
      includeTags = winnerMood.boost_tags || [];
      excludeTags = [...excludeTags, ...(winnerMood.suppress_tags || [])];
      tagWeights = {};
      weightingType = 'image';
    } else if (activeMoodDefs.length > 0) {
      // Normal mode: expand pool with mood boost_tags not already in include_tags
      const baseTagSet = new Set(includeTags.filter(t => !isVirtualWebTag(t)));
      for (const mood of activeMoodDefs) {
        for (const tag of (mood.boost_tags || [])) {
          if (!baseTagSet.has(tag)) moodExpandedTags.add(tag);
        }
      }
    }

    const helper = new MetadataHelper(req.frameArtPath);
    const metadata = await helper.readMetadata();

    // Filter out locally-blacklisted images before any selection logic
    const blacklist = await helper.readBlacklist().catch(() => ({ local: [], web: [] }));
    const blacklistedLocal = new Set(blacklist.local || []);
    if (blacklistedLocal.size > 0) {
      metadata.images = Object.fromEntries(
        Object.entries(metadata.images || {}).filter(([f]) => !blacklistedLocal.has(f))
      );
    }
    const images = metadata.images || {};

    if (Object.keys(images).length === 0) {
      return res.json({ type: 'none', eligibleCount: 0 });
    }

    // Separate virtual web source tags from real library tags
    const virtualWebTags = includeTags.filter(isVirtualWebTag);
    const libraryIncludeTags = includeTags.filter(t => !isVirtualWebTag(t));

    // Mood-derived keyword search entries compete alongside virtual tags in the pool.
    // Only generate entries when web sources are available (mood-only search with no
    // virtual tags is excluded because exclusive moods already reset includeTags).
    const moodSearchEntries = buildMoodSearchEntries(activeMoodDefs);
    const hasMoodSearches = moodSearchEntries.length > 0;
    const hasWebSources = virtualWebTags.length > 0 || hasMoodSearches;

    // Only virtual web tags / mood searches — pick one and return sentinel
    if (hasWebSources && libraryIncludeTags.length === 0) {
      const webEntry = selectWebEntry(virtualWebTags, tagWeights, moodSearchEntries);
      if (webEntry && webEntry.kind === 'mood') {
        return res.json({ type: 'web_source', moodKeyword: webEntry.keyword, eligibleCount: 1, selectedTag: null, freshCount: 0, usedFallback: false });
      }
      return res.json(await makeWebSourceResponse(webEntry.id, {
        eligibleCount: 1, freshCount: 0, usedFallback: false,
        frameArtPath: req.frameArtPath, metadata, helper, currentImage, recentImages,
      }));
    }

    // No include tags = all images (flat image-weighted selection)
    if (libraryIncludeTags.length === 0) {
      const eligible = Object.entries(images)
        .filter(([, img]) => !excludeTags.some(t => (img.tags || []).includes(t)))
        .map(([filename, img]) => ({ ...img, filename }));

      const eligibleCount = eligible.length;
      if (eligibleCount === 0) return res.json({ type: 'none', eligibleCount: 0 });

      const candidates = eligible.filter(img => img.filename !== currentImage);
      if (candidates.length === 0) return res.json({ type: 'none', eligibleCount });

      const { pool, freshCount, usedFallback } = applyRecencyPreference(candidates, recentImages);
      const selected = selectRandom(pool);

      return res.json({
        type: 'library', ...selected,
        eligibleCount, selectedTag: null, freshCount, usedFallback,
      });
    }

    // ----------------------------------------------------------------
    // IMAGE-WEIGHTED MODE: images weighted by mood scores
    // ----------------------------------------------------------------
    if (weightingType === 'image') {
      // Base pool: images matching the tagset include tags
      const eligible = Object.entries(images)
        .filter(([, img]) => {
          const imgTags = new Set(img.tags || []);
          if (libraryIncludeTags.length > 0 && !libraryIncludeTags.some(t => imgTags.has(t))) return false;
          if (excludeTags.some(t => imgTags.has(t))) return false;
          if (activeMoodDefs.length > 0 && isMoodHardSuppressed(img.tags || [], activeMoodDefs)) return false;
          return true;
        })
        .map(([filename, img]) => ({ ...img, filename, _inBasePool: true }));

      // Mood-expanded pool: images matching mood boost_tags but not in base pool
      const baseFilenames = new Set(eligible.map(img => img.filename));
      let expandedEligible = [];
      if (moodExpandedTags.size > 0) {
        expandedEligible = Object.entries(images)
          .filter(([filename, img]) => {
            if (baseFilenames.has(filename)) return false; // already in base pool
            const imgTags = new Set(img.tags || []);
            if (excludeTags.some(t => imgTags.has(t))) return false;
            if (isMoodHardSuppressed(img.tags || [], activeMoodDefs)) return false;
            return [...moodExpandedTags].some(t => imgTags.has(t));
          })
          .map(([filename, img]) => ({ ...img, filename, _inBasePool: false }));
      }

      const allEligible = [...eligible, ...expandedEligible];
      const libraryCount = allEligible.length;

      // Give each virtual web tag effective image count = avg images per library tag,
      // scaled by its tag weight so high-weight virtual tags compete proportionally.
      const totalWebEntryCount = virtualWebTags.length + moodSearchEntries.length;
      const totalVtagWeight = virtualWebTags.reduce((s, t) => s + (tagWeights[t] ?? 1.0), 0);
      const totalMoodWeight = moodSearchEntries.reduce((s, e) => s + e.weight, 0);
      const totalWebWeight = totalVtagWeight + totalMoodWeight;
      const perUnitEffective = hasWebSources && libraryIncludeTags.length > 0
        ? Math.max(1, Math.floor(eligible.length / Math.max(1, libraryIncludeTags.length)))
        : hasWebSources ? 1 : 0;
      // webEffectiveForProb uses sum-of-weights so the library/web split respects tag weights.
      // eligibleCount uses raw entry count (for display only).
      const webEffectiveForProb = perUnitEffective * totalWebWeight;
      const eligibleCount = libraryCount + perUnitEffective * totalWebEntryCount;

      if (eligibleCount === 0) return res.json({ type: 'none', eligibleCount: 0 });

      // Compute library vs web split using mood-weighted library total
      const moodsActive = activeMoodDefs.length > 0;
      let libraryTotalWeight = 0;
      if (moodsActive) {
        for (const img of allEligible) {
          libraryTotalWeight += scoreMoodImage(img.tags || [], activeMoodDefs, img._inBasePool);
        }
      } else {
        libraryTotalWeight = allEligible.length;
      }

      // Roll for web source (proportional to effective share relative to total weight)
      if (hasWebSources) {
        const totalWeight = libraryTotalWeight + webEffectiveForProb;
        if (Math.random() < webEffectiveForProb / totalWeight) {
          const webEntry = selectWebEntry(virtualWebTags, tagWeights, moodSearchEntries);
          if (webEntry && webEntry.kind === 'mood') {
            return res.json({ type: 'web_source', moodKeyword: webEntry.keyword, eligibleCount, selectedTag: null, freshCount: 0, usedFallback: false });
          }
          return res.json(await makeWebSourceResponse(webEntry.id, {
            eligibleCount, freshCount: 0, usedFallback: false,
            frameArtPath: req.frameArtPath, metadata, helper, currentImage, recentImages,
          }));
        }
      }

      if (allEligible.length === 0) return res.json({ type: 'none', eligibleCount });

      const candidates = allEligible.filter(img => img.filename !== currentImage);
      if (candidates.length === 0) {
        if (hasWebSources) {
          const webEntry = selectWebEntry(virtualWebTags, tagWeights, moodSearchEntries);
          if (webEntry && webEntry.kind === 'mood') {
            return res.json({ type: 'web_source', moodKeyword: webEntry.keyword, eligibleCount, selectedTag: null, freshCount: 0, usedFallback: false });
          }
          return res.json(await makeWebSourceResponse(webEntry.id, {
            eligibleCount, freshCount: 0, usedFallback: false,
            frameArtPath: req.frameArtPath, metadata, helper, currentImage, recentImages,
          }));
        }
        return res.json({ type: 'none', eligibleCount });
      }

      const { pool, freshCount, usedFallback } = applyRecencyPreference(candidates, recentImages);

      let selected;
      if (moodsActive) {
        selected = weightedRandomChoice(pool, img => scoreMoodImage(img.tags || [], activeMoodDefs, img._inBasePool));
      } else {
        selected = selectRandom(pool);
      }

      const { _inBasePool: _bp, ...selectedClean } = selected || {};
      return res.json({
        type: 'library', ...selectedClean,
        eligibleCount, selectedTag: null, freshCount, usedFallback,
      });
    }

    // ----------------------------------------------------------------
    // TAG-WEIGHTED MODE: select tag first, then mood-weighted image from pool
    // ----------------------------------------------------------------
    const tagPools = buildTagPools(images, libraryIncludeTags, excludeTags, tagWeights);

    const allEligible = new Set();
    for (const pool of Object.values(tagPools)) {
      for (const img of pool) allEligible.add(img.filename);
    }
    const totalWebEntryCountTagMode = virtualWebTags.length + moodSearchEntries.length;
    const eligibleCount = allEligible.size + (hasWebSources ? totalWebEntryCountTagMode : 0);

    if (eligibleCount === 0) return res.json({ type: 'none', eligibleCount: 0 });

    // Weighted tag selection with re-roll on empty pools.
    // Mood search entries are added to the pool as synthetic entrants so they compete
    // alongside existing virtual tags. Each is assigned a unique placeholder key.
    const moodSearchTagMap = new Map(moodSearchEntries.map((e, i) => [`__mood_search_${i}__`, e]));
    let remainingTags = [
      ...includeTags,
      ...Array.from(moodSearchTagMap.keys()),
    ];
    let selectedTag = null;
    let candidates = [];

    while (remainingTags.length > 0 && candidates.length === 0) {
      const chosen = weightedRandomChoice(remainingTags, t => moodSearchTagMap.get(t)?.weight ?? tagWeights[t] ?? 1.0);
      selectedTag = chosen;

      // Mood search entry wins — return a web_source response with the keyword.
      const moodSearchEntry = moodSearchTagMap.get(chosen);
      if (moodSearchEntry) {
        return res.json({ type: 'web_source', moodKeyword: moodSearchEntry.keyword, eligibleCount, selectedTag: null, freshCount: 0, usedFallback: false });
      }

      if (isVirtualWebTag(chosen)) {
        return res.json(await makeWebSourceResponse(chosen, {
          eligibleCount, freshCount: 0, usedFallback: false,
          frameArtPath: req.frameArtPath, metadata, helper, currentImage, recentImages,
        }));
      }

      const pool = tagPools[chosen] || [];
      candidates = pool.filter(img => img.filename !== currentImage);

      if (candidates.length === 0) {
        remainingTags = remainingTags.filter(t => t !== chosen);
        selectedTag = null;
      }
    }

    // Apply hard suppression from moods to tag pools
    if (activeMoodDefs.length > 0) {
      for (const tag of Object.keys(tagPools)) {
        tagPools[tag] = tagPools[tag].filter(
          img => !isMoodHardSuppressed(img.tags || [], activeMoodDefs)
        );
      }
    }

    if (candidates.length === 0) return res.json({ type: 'none', eligibleCount });

    const { pool: finalPool, freshCount, usedFallback } = applyRecencyPreference(candidates, recentImages);

    let selected;
    if (activeMoodDefs.length > 0) {
      selected = weightedRandomChoice(finalPool, img => scoreMoodImage(img.tags || [], activeMoodDefs, true));
    } else {
      selected = selectRandom(finalPool);
    }

    return res.json({
      type: 'library', ...selected,
      eligibleCount, selectedTag, freshCount, usedFallback,
    });
  } catch (err) {
    console.error('[shuffle/select] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/shuffle/pool-filenames
 *
 * Returns the set of library filenames that match the given tag filters.
 * Used by the pool health endpoint to compute recency statistics.
 *
 * Query params:
 *   includeTags  comma-separated list of include tags (optional = all images)
 *   excludeTags  comma-separated list of exclude tags (optional = none excluded)
 *
 * Response: { filenames: string[], count: number }
 */
router.get('/pool-filenames', async (req, res) => {
  try {
    const includeTags = req.query.includeTags
      ? req.query.includeTags.split(',').filter(Boolean)
      : [];
    const excludeTags = req.query.excludeTags
      ? req.query.excludeTags.split(',').filter(Boolean)
      : [];

    // Filter out virtual web tags — they have no library images
    const libraryIncludeTags = includeTags.filter(t => !isVirtualWebTag(t));

    const helper = new MetadataHelper(req.frameArtPath);
    const metadata = await helper.readMetadata();
    const images = metadata.images || {};

    const filenames = [];
    for (const [filename, img] of Object.entries(images)) {
      const imgTags = new Set(img.tags || []);
      if (libraryIncludeTags.length > 0 && !libraryIncludeTags.some(t => imgTags.has(t))) continue;
      if (excludeTags.some(t => imgTags.has(t))) continue;
      filenames.push(filename);
    }

    res.json({ filenames, count: filenames.length });
  } catch (err) {
    console.error('[shuffle/pool-filenames] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
