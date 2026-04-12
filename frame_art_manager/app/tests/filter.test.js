#!/usr/bin/env node

/**
 * Filter and Fetch-Retry Tests
 *
 * Tests for the pure filter helpers and shared fetch-with-retry logic in
 * routes/web_sources.js:
 *
 *   resolveAspectRatioFilter  — reads orientation setting from config (v1/v2)
 *   isSourceCompatible        — checks source constraints against active filter
 *   mergeFilterCascade        — intersects require, unions exclude across levels
 *   fetchWithRetry            — retries fetcher on orientation, resolution, recency,
 *                               and mood reject_term mismatches
 *
 * fetchWithRetry calls sharp internally to read image dimensions.  The tests
 * skip gracefully when sharp is not available (local dev without the native
 * module); they always run inside Docker.
 */

'use strict';

const assert = require('assert');

// ── Load modules (skip gracefully if sharp is missing) ────────────────────────

let resolveAspectRatioFilter, isSourceCompatible, mergeFilterCascade, fetchWithRetry;
let sharp;
let sharpAvailable = false;

try {
  const mod = require('../routes/web_sources');
  resolveAspectRatioFilter = mod.resolveAspectRatioFilter;
  isSourceCompatible       = mod.isSourceCompatible;
  mergeFilterCascade       = mod.mergeFilterCascade;
  fetchWithRetry           = mod.fetchWithRetry;
  sharp = require('sharp');
  sharpAvailable = true;
} catch (err) {
  if (err.message && err.message.includes('sharp')) {
    console.log(`\x1b[33mℹ\x1b[0m Skipping filter tests: sharp module not available locally (runs in Docker)`);
    console.log('Passed: 0');
    console.log('Failed: 0');
    console.log('Skipped: 15');
    process.exit(0);
  }
  throw err;
}

// ── Color output helpers ──────────────────────────────────────────────────────

const colors = { green: '\x1b[32m', red: '\x1b[31m', blue: '\x1b[34m', reset: '\x1b[0m' };
const logSuccess = (msg) => console.log(`${colors.green}✓${colors.reset} ${msg}`);
const logError   = (msg) => console.log(`${colors.red}✗${colors.reset} ${msg}`);
const logSection = (msg) => console.log(`\n${colors.blue}${msg}${colors.reset}`);

// ── Test registry ─────────────────────────────────────────────────────────────

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ── Image helpers ─────────────────────────────────────────────────────────────

/** Create a minimal solid-color PNG with the given pixel dimensions. */
function makeImage(width, height) {
  return sharp({ create: { width, height, channels: 3, background: { r: 128, g: 128, b: 128 } } })
    .png()
    .toBuffer();
}

/** Fake metadata object returned by a source fetcher. */
function makeFakeResult(imageBuffer, { artworkUrl = 'https://example.com/art/1', title = 'Test' } = {}) {
  return { imageBuffer, contentType: 'image/png', metadata: { artworkUrl, title } };
}

// ── resolveAspectRatioFilter ──────────────────────────────────────────────────

test('resolveAspectRatioFilter: returns "all" with empty config', () => {
  assert.strictEqual(resolveAspectRatioFilter({}), 'all');
});

test('resolveAspectRatioFilter: reads v2 globalFilters orientation entry', () => {
  const webSources = {
    globalFilters: [{ type: 'orientation', mode: 'require', values: ['landscape'] }],
  };
  assert.strictEqual(resolveAspectRatioFilter(webSources), 'landscape');
});

test('resolveAspectRatioFilter: falls back to v1 aspectRatioFilter field', () => {
  assert.strictEqual(resolveAspectRatioFilter({ aspectRatioFilter: 'portrait' }), 'portrait');
});

test('resolveAspectRatioFilter: v2 globalFilters takes precedence over v1 field', () => {
  const webSources = {
    globalFilters: [{ type: 'orientation', mode: 'require', values: ['landscape'] }],
    aspectRatioFilter: 'portrait',
  };
  assert.strictEqual(resolveAspectRatioFilter(webSources), 'landscape');
});

test('resolveAspectRatioFilter: match_tv resolves to tvOrientation when provided', () => {
  const webSources = { aspectRatioFilter: 'match_tv' };
  assert.strictEqual(resolveAspectRatioFilter(webSources, 'portrait'), 'portrait');
  assert.strictEqual(resolveAspectRatioFilter(webSources, 'landscape'), 'landscape');
});

test('resolveAspectRatioFilter: match_tv falls back to "all" when tvOrientation is absent', () => {
  const webSources = { aspectRatioFilter: 'match_tv' };
  assert.strictEqual(resolveAspectRatioFilter(webSources, undefined), 'all');
  assert.strictEqual(resolveAspectRatioFilter(webSources, null), 'all');
});

// ── isSourceCompatible ────────────────────────────────────────────────────────

// Minimal fake SOURCE_MODULES-style objects are passed via the BUILTIN_SOURCES
// path — but isSourceCompatible reads from SOURCE_MODULES first.  We test the
// function directly by passing sourceIds that map to known BUILTIN_SOURCES
// entries (google_art_wallpaper has aspectRatioConstraint: 'landscape').

test('isSourceCompatible: source with no constraint is always compatible', () => {
  // google_arts has no constraint
  assert.ok(isSourceCompatible('google_arts', 'landscape'));
  assert.ok(isSourceCompatible('google_arts', 'portrait'));
  assert.ok(isSourceCompatible('google_arts', 'all'));
});

test('isSourceCompatible: landscape-constrained source is incompatible with portrait filter', () => {
  // google_art_wallpaper exports aspectRatioConstraint: 'landscape'
  assert.strictEqual(isSourceCompatible('google_art_wallpaper', 'portrait'), false);
});

test('isSourceCompatible: landscape-constrained source is compatible with landscape and all filters', () => {
  assert.ok(isSourceCompatible('google_art_wallpaper', 'landscape'));
  assert.ok(isSourceCompatible('google_art_wallpaper', 'all'));
});

// ── mergeFilterCascade ────────────────────────────────────────────────────────

test('mergeFilterCascade: empty levels produce empty result', () => {
  assert.deepStrictEqual(mergeFilterCascade([], [], []), []);
});

test('mergeFilterCascade: single-level passthrough', () => {
  const result = mergeFilterCascade([{ type: 'medium', mode: 'require', values: ['oil paint', 'watercolor'] }]);
  assert.strictEqual(result.length, 1);
  assert.deepStrictEqual(result[0].values.sort(), ['oil paint', 'watercolor'].sort());
});

test('mergeFilterCascade: require filters intersect (only common values survive)', () => {
  const global = [{ type: 'medium', mode: 'require', values: ['oil paint', 'watercolor'] }];
  const source = [{ type: 'medium', mode: 'require', values: ['watercolor', 'acrylic'] }];
  const result = mergeFilterCascade(global, source);
  const mediumFilter = result.find(f => f.type === 'medium' && f.mode === 'require');
  assert.deepStrictEqual(mediumFilter.values, ['watercolor']);
});

test('mergeFilterCascade: require filter with empty intersection is dropped', () => {
  const global = [{ type: 'medium', mode: 'require', values: ['oil paint'] }];
  const source = [{ type: 'medium', mode: 'require', values: ['watercolor'] }];
  const result = mergeFilterCascade(global, source);
  const mediumFilter = result.find(f => f.type === 'medium' && f.mode === 'require');
  assert.ok(!mediumFilter, 'Filter with empty values should be dropped');
});

test('mergeFilterCascade: exclude filters union (all values collected)', () => {
  const global = [{ type: 'objectType', mode: 'exclude', values: ['book'] }];
  const source = [{ type: 'objectType', mode: 'exclude', values: ['manuscript'] }];
  const result = mergeFilterCascade(global, source);
  const excludeFilter = result.find(f => f.type === 'objectType' && f.mode === 'exclude');
  assert.ok(excludeFilter.values.includes('book'));
  assert.ok(excludeFilter.values.includes('manuscript'));
});

// ── fetchWithRetry ────────────────────────────────────────────────────────────

test('fetchWithRetry: returns first result immediately when no filters active', async () => {
  const imageBuffer = await makeImage(200, 100);
  let callCount = 0;
  const fetcher = async () => { callCount++; return makeFakeResult(imageBuffer); };

  const result = await fetchWithRetry(fetcher, [], { aspectRatio: 'all' });
  assert.strictEqual(callCount, 1, 'Should only call fetcher once');
  assert.ok(result.imageBuffer, 'Should return a result');
});

test('fetchWithRetry: retries when orientation does not match, returns correct result', async () => {
  const portrait  = await makeImage(100, 200);  // wrong for landscape filter
  const landscape = await makeImage(200, 100);  // correct
  let callCount = 0;
  const fetcher = async () => {
    callCount++;
    return makeFakeResult(callCount === 1 ? portrait : landscape);
  };

  const result = await fetchWithRetry(fetcher, [], { aspectRatio: 'landscape' });
  assert.strictEqual(callCount, 2, 'Should retry once after portrait result');
  const { width, height } = await sharp(result.imageBuffer).metadata();
  assert.ok(width > height, 'Returned image should be landscape');
});

test('fetchWithRetry: returns last result after maxAttempts even if orientation is wrong', async () => {
  const portrait = await makeImage(100, 200);
  let callCount = 0;
  const fetcher = async () => { callCount++; return makeFakeResult(portrait); };

  const result = await fetchWithRetry(fetcher, [], { aspectRatio: 'landscape', maxAttempts: 3 });
  assert.strictEqual(callCount, 3, 'Should try maxAttempts times');
  assert.ok(result.imageBuffer, 'Should still return a result');
});

test('fetchWithRetry: retries when image is below minResolution', async () => {
  const lowRes  = await makeImage(100, 50);   // short side 50 < 1080
  const highRes = await makeImage(1920, 1080); // short side 1080, passes
  let callCount = 0;
  const fetcher = async () => {
    callCount++;
    return makeFakeResult(callCount === 1 ? lowRes : highRes);
  };

  const result = await fetchWithRetry(fetcher, [], { aspectRatio: 'all', skipLowRes: true, minResolution: 1080 });
  assert.strictEqual(callCount, 2, 'Should retry once after low-res result');
  const { width, height } = await sharp(result.imageBuffer).metadata();
  assert.ok(Math.min(width, height) >= 1080, 'Returned image should meet minimum resolution');
});

test('fetchWithRetry: retries for recently-shown artwork, returns fresh result', async () => {
  const imageBuffer = await makeImage(200, 100);
  const recentUrl = 'https://example.com/art/recent';
  const freshUrl  = 'https://example.com/art/fresh';
  let callCount = 0;
  const fetcher = async () => {
    callCount++;
    const url = callCount === 1 ? recentUrl : freshUrl;
    return makeFakeResult(imageBuffer, { artworkUrl: url });
  };

  const result = await fetchWithRetry(fetcher, [], {
    aspectRatio: 'all',
    recentArtworkIds: new Set([recentUrl]),
  });
  assert.strictEqual(callCount, 2);
  assert.strictEqual(result.metadata.artworkUrl, freshUrl);
});

test('fetchWithRetry: retries when mood reject_terms match metadata', async () => {
  const imageBuffer = await makeImage(200, 100);
  let callCount = 0;
  const fetcher = async () => {
    callCount++;
    const title = callCount === 1 ? 'Battle of Waterloo' : 'Sunflowers';
    return makeFakeResult(imageBuffer, { artworkUrl: `https://example.com/art/${callCount}`, title });
  };
  // Assign title into metadata the way sources actually do
  const wrappedFetcher = async (filters, opts) => {
    const r = await fetcher(filters, opts);
    return r;
  };

  const result = await fetchWithRetry(wrappedFetcher, [], {
    aspectRatio: 'all',
    moodRejectTerms: ['battle'],
  });
  assert.strictEqual(callCount, 2);
  assert.strictEqual(result.metadata.title, 'Sunflowers');
});

test('fetchWithRetry: reuses prefetchedResult on first attempt', async () => {
  const imageBuffer = await makeImage(200, 100);
  const prefetched = makeFakeResult(imageBuffer, { artworkUrl: 'https://example.com/prefetched' });
  let callCount = 0;
  const fetcher = async () => { callCount++; return makeFakeResult(imageBuffer); };

  const result = await fetchWithRetry(fetcher, [], { aspectRatio: 'all', prefetchedResult: prefetched });
  assert.strictEqual(callCount, 0, 'Fetcher should not be called when prefetchedResult is valid');
  assert.strictEqual(result.metadata.artworkUrl, 'https://example.com/prefetched');
});

// ── Runner ────────────────────────────────────────────────────────────────────

async function runTests() {
  logSection('Filter and Fetch-Retry Tests');

  let passed = 0;
  let failed = 0;

  for (const t of tests) {
    try {
      await t.fn();
      logSuccess(t.name);
      passed++;
    } catch (err) {
      logError(t.name);
      console.error(`  ${err.message}`);
      if (err.stack) console.error(`  ${err.stack.split('\n').slice(1, 3).join('\n')}`);
      failed++;
    }
  }

  logSection('📊 Test Results');
  console.log(`\x1b[32mPassed: ${passed}\x1b[0m`);
  console.log(`\x1b[31mFailed: ${failed}\x1b[0m`);
  console.log(`Total: ${tests.length}`);

  process.exit(failed > 0 ? 1 : 0);
}

if (require.main === module) {
  runTests().catch((err) => {
    console.error('Test suite error:', err);
    process.exit(1);
  });
}

module.exports = { runTests };
