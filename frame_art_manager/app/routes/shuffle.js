const express = require('express');
const router = express.Router();
const MetadataHelper = require('../metadata_helper');
const { readTagsets } = require('./tagsets');

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

    const helper = new MetadataHelper(req.frameArtPath);
    const metadata = await helper.readMetadata();
    const images = metadata.images || {};

    if (Object.keys(images).length === 0) {
      return res.json({ type: 'none', eligibleCount: 0 });
    }

    // Separate virtual web source tags from real library tags
    const virtualWebTags = includeTags.filter(isVirtualWebTag);
    const libraryIncludeTags = includeTags.filter(t => !isVirtualWebTag(t));
    const hasWebSources = virtualWebTags.length > 0;

    // Only virtual web tags — pick one weighted-randomly and return sentinel
    if (hasWebSources && libraryIncludeTags.length === 0) {
      const chosen = weightedRandomChoice(virtualWebTags, t => tagWeights[t] ?? 1.0);
      return res.json({
        type: 'web_source',
        virtualTagId: getVirtualTagId(chosen),
        eligibleCount: 1,
        selectedTag: chosen,
        freshCount: 0,
        usedFallback: false,
      });
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
    // IMAGE-WEIGHTED MODE: all eligible images equally likely
    // ----------------------------------------------------------------
    if (weightingType === 'image') {
      const eligible = Object.entries(images)
        .filter(([, img]) => {
          const imgTags = new Set(img.tags || []);
          if (!libraryIncludeTags.some(t => imgTags.has(t))) return false;
          if (excludeTags.some(t => imgTags.has(t))) return false;
          return true;
        })
        .map(([filename, img]) => ({ ...img, filename }));

      const libraryCount = eligible.length;

      // Virtual web tags get effective count = avg images per library tag
      const perVtagEffective = hasWebSources && libraryIncludeTags.length > 0
        ? Math.max(1, Math.floor(libraryCount / Math.max(1, libraryIncludeTags.length)))
        : hasWebSources ? 1 : 0;
      const webEffective = perVtagEffective * virtualWebTags.length;
      const eligibleCount = libraryCount + webEffective;

      if (eligibleCount === 0) return res.json({ type: 'none', eligibleCount: 0 });

      // Roll for web source (proportional to effective share)
      if (hasWebSources && Math.random() < webEffective / eligibleCount) {
        const chosen = weightedRandomChoice(virtualWebTags, t => tagWeights[t] ?? 1.0);
        return res.json({
          type: 'web_source',
          virtualTagId: getVirtualTagId(chosen),
          eligibleCount,
          selectedTag: chosen,
          freshCount: 0,
          usedFallback: false,
        });
      }

      if (eligible.length === 0) return res.json({ type: 'none', eligibleCount });

      const candidates = eligible.filter(img => img.filename !== currentImage);
      if (candidates.length === 0) {
        // No library candidates — fall back to web source if available
        if (hasWebSources) {
          const chosen = weightedRandomChoice(virtualWebTags, t => tagWeights[t] ?? 1.0);
          return res.json({
            type: 'web_source',
            virtualTagId: getVirtualTagId(chosen),
            eligibleCount,
            selectedTag: chosen,
            freshCount: 0,
            usedFallback: false,
          });
        }
        return res.json({ type: 'none', eligibleCount });
      }

      const { pool, freshCount, usedFallback } = applyRecencyPreference(candidates, recentImages);
      const selected = selectRandom(pool);

      return res.json({
        type: 'library', ...selected,
        eligibleCount, selectedTag: null, freshCount, usedFallback,
      });
    }

    // ----------------------------------------------------------------
    // TAG-WEIGHTED MODE: select tag first, then random image from pool
    // ----------------------------------------------------------------
    const tagPools = buildTagPools(images, libraryIncludeTags, excludeTags, tagWeights);

    const allEligible = new Set();
    for (const pool of Object.values(tagPools)) {
      for (const img of pool) allEligible.add(img.filename);
    }
    const eligibleCount = allEligible.size + (hasWebSources ? virtualWebTags.length : 0);

    if (eligibleCount === 0) return res.json({ type: 'none', eligibleCount: 0 });

    // Weighted tag selection with re-roll on empty pools
    let remainingTags = [...includeTags];
    let selectedTag = null;
    let candidates = [];

    while (remainingTags.length > 0 && candidates.length === 0) {
      const chosen = weightedRandomChoice(remainingTags, t => tagWeights[t] ?? 1.0);
      selectedTag = chosen;

      if (isVirtualWebTag(chosen)) {
        return res.json({
          type: 'web_source',
          virtualTagId: getVirtualTagId(chosen),
          eligibleCount,
          selectedTag: chosen,
          freshCount: 0,
          usedFallback: false,
        });
      }

      const pool = tagPools[chosen] || [];
      candidates = pool.filter(img => img.filename !== currentImage);

      if (candidates.length === 0) {
        remainingTags = remainingTags.filter(t => t !== chosen);
        selectedTag = null;
      }
    }

    if (candidates.length === 0) return res.json({ type: 'none', eligibleCount });

    const { pool: finalPool, freshCount, usedFallback } = applyRecencyPreference(candidates, recentImages);
    const selected = selectRandom(finalPool);

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
