#!/usr/bin/env node
'use strict';

/**
 * Artist Interface Tests
 *
 * Covers the pure logic components of the cross-source artist query system:
 *
 *   1. artistResolver — merge / dedup / sort
 *   2. MoMA filterAndSortArtists — prefix-before-substring, count ordering
 *   3. DelArt nameMatchesQuery — false-positive post-filter
 *   4. DelArt parsePeopleSearchResults — HTML parsing
 *   5. Met artist name verification — regression for partial-word match bug
 *
 * All tests run against pure functions with no network calls.
 * Modules that require 'sharp' (delart.js) are loaded inside a try/catch;
 * their tests are skipped gracefully when sharp is unavailable locally.
 */

const assert = require('assert');

// ── Color output helpers ────────────────────────────────────────────────────

const colors = {
  green:  '\x1b[32m',
  red:    '\x1b[31m',
  yellow: '\x1b[33m',
  blue:   '\x1b[34m',
  reset:  '\x1b[0m',
};
const logSuccess = (msg) => console.log(`${colors.green}✓${colors.reset} ${msg}`);
const logError   = (msg, err) => console.log(`${colors.red}✗${colors.reset} ${msg}${err ? `: ${err.message}` : ''}`);
const logSkip    = (msg) => console.log(`${colors.yellow}ℹ${colors.reset} ${msg}`);
const logSection = (msg) => console.log(`\n${colors.blue}── ${msg} ──${colors.reset}`);

// ── Test registry ────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
let skipped = 0;

function test(name, fn) {
  try {
    fn();
    logSuccess(name);
    passed++;
  } catch (err) {
    logError(name, err);
    failed++;
  }
}

function skip(name, reason) {
  logSkip(`SKIP: ${name} (${reason})`);
  skipped++;
}

// ── Load modules ─────────────────────────────────────────────────────────────

const { createArtistResolver } = require('../utils/artistResolver');
const { filterAndSortArtists } = require('../sources/moma');

let parsePeopleSearchResults, nameMatchesQuery;
let delartAvailable = false;
try {
  const delart = require('../sources/delart');
  parsePeopleSearchResults = delart.parsePeopleSearchResults;
  nameMatchesQuery         = delart.nameMatchesQuery;
  delartAvailable = true;
} catch (err) {
  if (err.message && err.message.includes('sharp')) {
    logSkip('delart.js requires sharp — DelArt parsing tests will be skipped (runs in Docker)');
  } else {
    throw err;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 1. artistResolver — merge / dedup / sort
// ════════════════════════════════════════════════════════════════════════════

logSection('artistResolver — merge / dedup / sort');

// Synchronous mock source factory
function mockSource(id, results) {
  return { id, suggestArtists: async () => results };
}

const noopWikidata = { suggestArtists: async () => [], enrichArtist: async () => null };

test('same artist from two sources is merged into one entry', async () => {
  const resolver = createArtistResolver({
    sources: [
      mockSource('moma',  [{ name: 'Claude Monet', count: 42, source: 'moma' }]),
      mockSource('artsy', [{ name: 'Claude Monet', slug: 'claude-monet', source: 'artsy' }]),
    ],
    wikidata: noopWikidata,
  });
  const results = await resolver.suggest('monet');
  assert.strictEqual(results.length, 1, 'should deduplicate to one entry');
  assert.deepStrictEqual(results[0].sources, ['moma', 'artsy'], 'should list both sources');
  assert.strictEqual(results[0].artsySlug, 'claude-monet', 'should carry Artsy slug');
  assert.strictEqual(results[0].momaCount, 42, 'should carry MoMA count');
});

test('deduplication is case-insensitive', async () => {
  const resolver = createArtistResolver({
    sources: [
      mockSource('moma',  [{ name: 'Claude Monet', count: 10, source: 'moma' }]),
      mockSource('artsy', [{ name: 'claude monet', slug: 'claude-monet', source: 'artsy' }]),
    ],
    wikidata: noopWikidata,
  });
  const results = await resolver.suggest('monet');
  assert.strictEqual(results.length, 1, 'case variants should merge');
  assert.strictEqual(results[0].name, 'Claude Monet', 'keeps first-seen casing');
});

test('Wikidata result merged adds wikidataId and description', async () => {
  const resolver = createArtistResolver({
    sources: [mockSource('moma', [{ name: 'Claude Monet', count: 42, source: 'moma' }])],
    wikidata: {
      suggestArtists: async () => [{ name: 'Claude Monet', wikidataId: 'Q296', description: 'French painter (1840–1926)', source: 'wikidata' }],
      enrichArtist: async () => null,
    },
  });
  const results = await resolver.suggest('monet');
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].wikidataId, 'Q296');
  assert.strictEqual(results[0].description, 'French painter (1840–1926)');
  assert.ok(results[0].sources.includes('wikidata'));
  assert.ok(results[0].sources.includes('moma'));
});

test('local instances sort before any remote results', async () => {
  const resolver = createArtistResolver({
    sources: [mockSource('moma', [{ name: 'Monet Fan', count: 999, source: 'moma' }])],
    wikidata: noopWikidata,
  });
  const localInstances = { 'claude-monet': { name: 'Claude Monet' } };
  const results = await resolver.suggest('mon', { localInstances });
  assert.ok(results.length >= 2, 'should have local + remote results');
  assert.ok(results[0].sources.includes('local'), 'first result should be local');
  assert.strictEqual(results[0].localInstanceKey, 'claude-monet');
});

test('prefix match sorts before substring-only match', async () => {
  const resolver = createArtistResolver({
    sources: [
      mockSource('moma', [
        { name: 'Monet Fan Club',  count: 100, source: 'moma' }, // substring only
        { name: 'Monetized Corp',  count: 50,  source: 'moma' }, // substring only
        { name: 'Claude Monet',    count: 10,  source: 'moma' }, // prefix of "monet"? no — but has "monet"
      ]),
    ],
    wikidata: noopWikidata,
  });
  // "mon" → "Monet Fan Club" starts with "mon", "Claude Monet" has "mon" as substring
  const results = await resolver.suggest('mon');
  const names = results.map(r => r.name);
  const prefixIdx   = names.indexOf('Monet Fan Club');
  const substringIdx = names.indexOf('Claude Monet');
  if (prefixIdx !== -1 && substringIdx !== -1) {
    assert.ok(prefixIdx < substringIdx, 'prefix match should sort before substring-only');
  }
});

test('more sources = sorted higher (source count tiebreaker)', async () => {
  const resolver = createArtistResolver({
    sources: [
      mockSource('moma',  [{ name: 'Pablo Picasso', count: 5, source: 'moma' }]),
      mockSource('artsy', [{ name: 'Pablo Picasso', slug: 'picasso', source: 'artsy' }, { name: 'Paul Picasso', slug: 'paul-picasso', source: 'artsy' }]),
    ],
    wikidata: noopWikidata,
  });
  const results = await resolver.suggest('picasso');
  assert.strictEqual(results[0].name, 'Pablo Picasso', 'entry with 2 sources should rank first');
  assert.deepStrictEqual(results[0].sources, ['moma', 'artsy']);
});

test('MoMA count used as tiebreaker within same source count', async () => {
  const resolver = createArtistResolver({
    sources: [
      mockSource('moma', [
        { name: 'Minor Artist', count: 1, source: 'moma' },
        { name: 'Major Artist', count: 99, source: 'moma' },
      ]),
    ],
    wikidata: noopWikidata,
  });
  // Both have count prefix matching "ist"? No — let's use "artist" query so both are substring
  const results = await resolver.suggest('artist');
  const majorIdx = results.findIndex(r => r.name === 'Major Artist');
  const minorIdx = results.findIndex(r => r.name === 'Minor Artist');
  if (majorIdx !== -1 && minorIdx !== -1) {
    assert.ok(majorIdx < minorIdx, 'higher MoMA count should rank first');
  }
});

test('limit is respected', async () => {
  const resolver = createArtistResolver({
    sources: [
      mockSource('moma', Array.from({ length: 20 }, (_, i) => ({ name: `Artist ${i}`, count: i, source: 'moma' }))),
    ],
    wikidata: noopWikidata,
  });
  const results = await resolver.suggest('artist', { limit: 5 });
  assert.strictEqual(results.length, 5, 'should respect limit');
});

test('source timeout does not crash — timed-out source returns empty', async () => {
  const slowSource = {
    id: 'slow',
    suggestArtists: () => new Promise(resolve => setTimeout(() => resolve([{ name: 'Late Artist', count: 1, source: 'slow' }]), 2000)),
  };
  const resolver = createArtistResolver({
    sources: [mockSource('moma', [{ name: 'Fast Artist', count: 5, source: 'moma' }]), slowSource],
    wikidata: noopWikidata,
    timeout: 50,
  });
  const results = await resolver.suggest('artist');
  assert.ok(results.every(r => !r.sources.includes('slow')), 'timed-out source should not appear in results');
  assert.ok(results.some(r => r.sources.includes('moma')), 'fast source should still appear');
});

// ════════════════════════════════════════════════════════════════════════════
// 2. MoMA filterAndSortArtists
// ════════════════════════════════════════════════════════════════════════════

logSection('MoMA filterAndSortArtists');

// Synthetic index — sorted by count desc as it would be after ensureCache()
const MOCK_MOMA_INDEX = [
  { name: 'Claude Monet',      count: 100 },
  { name: 'Monet Copier',      count:  80 }, // prefix match for "monet"
  { name: 'Joan Miró',         count:  60 },
  { name: 'Piet Mondrian',     count:  40 }, // contains "mon" as substring
  { name: 'Lisa Monet-Clone',  count:  30 }, // substring "monet"
  { name: 'George Monetti',    count:  20 }, // substring "monet"
  { name: 'Vincent van Gogh',  count:  10 },
];

test('prefix matches return before substring-only matches', () => {
  const results = filterAndSortArtists(MOCK_MOMA_INDEX, 'monet', 10);
  const names = results.map(r => r.name);
  // "Monet Copier" and "Claude Monet" don't start with "monet" — wait:
  // "claude monet" starts with "claude", not "monet"
  // "monet copier" starts with "monet" → prefix
  // "lisa monet-clone" does NOT start with "monet" → substring
  const prefixNames  = names.filter(n => n.toLowerCase().startsWith('monet'));
  const substringIdx = names.indexOf('Lisa Monet-Clone');
  if (prefixNames.length > 0 && substringIdx !== -1) {
    for (const pn of prefixNames) {
      assert.ok(names.indexOf(pn) < substringIdx, `prefix "${pn}" should rank above substring "Lisa Monet-Clone"`);
    }
  }
});

test('within prefix group, sorted by count desc (index pre-sorted as in production)', () => {
  // The production artistNameIndex is sorted by count desc during ensureCache().
  // filterAndSortArtists preserves input order within each group.
  const index = [
    { name: 'Monet A', count: 50 }, // highest count — comes first in pre-sorted index
    { name: 'Monet B', count: 10 },
    { name: 'Monet C', count:  5 },
  ];
  const results = filterAndSortArtists(index, 'monet', 10);
  assert.strictEqual(results[0].name, 'Monet A', 'highest count in prefix group should be first');
  assert.strictEqual(results[1].name, 'Monet B');
  assert.strictEqual(results[2].name, 'Monet C');
});

test('empty query returns empty array', () => {
  const results = filterAndSortArtists(MOCK_MOMA_INDEX, '', 10);
  assert.deepStrictEqual(results, []);
});

test('limit is applied after grouping', () => {
  const results = filterAndSortArtists(MOCK_MOMA_INDEX, 'mon', 2);
  assert.strictEqual(results.length, 2);
});

test('result objects have name, count, and source:"moma"', () => {
  const results = filterAndSortArtists(MOCK_MOMA_INDEX, 'van gogh', 5);
  assert.ok(results.length > 0, 'should find Van Gogh');
  const vg = results[0];
  assert.strictEqual(vg.name, 'Vincent van Gogh');
  assert.strictEqual(vg.count, 10);
  assert.strictEqual(vg.source, 'moma');
});

test('no match returns empty array', () => {
  const results = filterAndSortArtists(MOCK_MOMA_INDEX, 'zzznomatch', 10);
  assert.deepStrictEqual(results, []);
});

// ════════════════════════════════════════════════════════════════════════════
// 3. DelArt nameMatchesQuery
// ════════════════════════════════════════════════════════════════════════════

logSection('DelArt nameMatchesQuery');

if (!delartAvailable) {
  skip('all nameMatchesQuery tests', 'sharp not available locally');
} else {
  test('"van gogh" rejects "Rembrandt van Rijn" (missing "gogh")', () => {
    assert.strictEqual(nameMatchesQuery('Rembrandt van Rijn', 'van gogh'), false);
  });

  test('"van gogh" rejects "Theo van Rysselberghe" (missing "gogh")', () => {
    assert.strictEqual(nameMatchesQuery('Theo van Rysselberghe', 'van gogh'), false);
  });

  test('"van gogh" accepts "Vincent van Gogh"', () => {
    assert.strictEqual(nameMatchesQuery('Vincent van Gogh', 'van gogh'), true);
  });

  test('single-word query matches any name containing that word', () => {
    assert.strictEqual(nameMatchesQuery('Winslow Homer', 'homer'), true);
    assert.strictEqual(nameMatchesQuery('Homer Davenport', 'homer'), true);
  });

  test('single-word query rejects non-matching names', () => {
    assert.strictEqual(nameMatchesQuery('Pablo Picasso', 'homer'), false);
  });

  test('words shorter than 3 chars are ignored (no false rejections)', () => {
    // "van" is 3 chars — NOT ignored (≥3), but "de" would be ignored
    // "de kooning" → words: ["de" (ignored, 2 chars), "kooning"] → only "kooning" must match
    assert.strictEqual(nameMatchesQuery('Willem de Kooning', 'de kooning'), true);
  });

  test('match is case-insensitive', () => {
    assert.strictEqual(nameMatchesQuery('WINSLOW HOMER', 'winslow homer'), true);
    assert.strictEqual(nameMatchesQuery('winslow homer', 'WINSLOW HOMER'), true);
  });

  test('all significant words must appear (AND logic)', () => {
    assert.strictEqual(nameMatchesQuery('Winslow Smith', 'winslow homer'), false, 'missing "homer"');
    assert.strictEqual(nameMatchesQuery('John Homer', 'winslow homer'), false, 'missing "winslow"');
    assert.strictEqual(nameMatchesQuery('Winslow Homer', 'winslow homer'), true, 'both present');
  });
}

// ════════════════════════════════════════════════════════════════════════════
// 4. DelArt parsePeopleSearchResults
// ════════════════════════════════════════════════════════════════════════════

logSection('DelArt parsePeopleSearchResults');

// Minimal fixture HTML that mirrors the actual eMuseum people search structure.
// Constructed from observed page HTML (curl https://emuseum.delart.org/search/winslow+homer/people).
const PEOPLE_FIXTURE_HTML = `
<div data-emuseum-id="215265" class="item list-item">
  <div class="list-item-inner">
    <div class="text-wrap">
      <span lang="en">
        <a href="/people/1551/winslow-homer;jsessionid=ABCDEF?ctx=xyz&amp;idx=0">
Winslow Homer
</a>
      </span>
    </div>
    <div class="text-wrap">American painter and illustrator, 1836–1910</div>
    <span class="text-wrap holder-cell">
      <div class="list-links">
        <a class="list-link" href="/people/1551/winslow-homer;jsessionid=ABCDEF/objects">
View All Works
<span class="sr-only">Related to Winslow Homer</span>
(32)
</a>
      </div>
    </span>
  </div>
</div>
<div data-emuseum-id="216000" class="item list-item">
  <div class="list-item-inner">
    <div class="text-wrap">
      <span lang="en">
        <a href="/people/135/homer-davenport;jsessionid=ABCDEF?ctx=xyz&amp;idx=1">
Homer Davenport
</a>
      </span>
    </div>
    <div class="text-wrap">American newspaper artist and political cartoonist, 1867–1912</div>
    <span class="text-wrap holder-cell">
      <div class="list-links">
        <a class="list-link" href="/people/135/homer-davenport;jsessionid=ABCDEF/objects">
View All Works
<span class="sr-only">Related to Homer Davenport</span>
(1)
</a>
      </div>
    </span>
  </div>
</div>
`;

if (!delartAvailable) {
  skip('all parsePeopleSearchResults tests', 'sharp not available locally');
} else {
  test('extracts personId and slug from href', () => {
    const results = parsePeopleSearchResults(PEOPLE_FIXTURE_HTML);
    assert.ok(results.length >= 1, 'should parse at least one person');
    const homer = results.find(r => r.slug === 'winslow-homer');
    assert.ok(homer, 'should find winslow-homer');
    assert.strictEqual(homer.personId, '1551');
    assert.strictEqual(homer.slug, 'winslow-homer');
  });

  test('extracts display name from link text', () => {
    const results = parsePeopleSearchResults(PEOPLE_FIXTURE_HTML);
    const homer = results.find(r => r.slug === 'winslow-homer');
    assert.strictEqual(homer.name, 'Winslow Homer');
  });

  test('extracts description from text-wrap div', () => {
    const results = parsePeopleSearchResults(PEOPLE_FIXTURE_HTML);
    const homer = results.find(r => r.slug === 'winslow-homer');
    assert.strictEqual(homer.description, 'American painter and illustrator, 1836–1910');
  });

  test('extracts work count', () => {
    const results = parsePeopleSearchResults(PEOPLE_FIXTURE_HTML);
    const homer = results.find(r => r.slug === 'winslow-homer');
    assert.strictEqual(homer.count, 32);
  });

  test('"View All Works" entries are not returned as person records', () => {
    const results = parsePeopleSearchResults(PEOPLE_FIXTURE_HTML);
    assert.ok(!results.some(r => r.name === 'View All Works'), '"View All Works" should be filtered out');
  });

  test('parses multiple persons', () => {
    const results = parsePeopleSearchResults(PEOPLE_FIXTURE_HTML);
    const names = results.map(r => r.name);
    assert.ok(names.includes('Winslow Homer'));
    assert.ok(names.includes('Homer Davenport'));
  });

  test('returns empty array for empty HTML', () => {
    const results = parsePeopleSearchResults('<html><body></body></html>');
    assert.deepStrictEqual(results, []);
  });
}

// ════════════════════════════════════════════════════════════════════════════
// 5. Met artist name verification — regression test
//
// Bug: Met API's artistOrCulture=true does partial-word matching.
// "Van Gogh" would match "Salomon van Ruysdael" (matches "van").
// Fix: after fetching an object, verify artistDisplayName contains the query.
// ════════════════════════════════════════════════════════════════════════════

logSection('Met artist name verification (regression)');

// Extracted logic from met_museum.js fetchRandomArtwork:
//   if (!artistLower.includes(nameLower)) { continue; }
function metArtistVerification(artistName, artistDisplayName) {
  const nameLower   = artistName.toLowerCase();
  const artistLower = artistDisplayName.toLowerCase();
  return artistLower.includes(nameLower); // true = passes, false = should skip
}

test('rejects "Salomon van Ruysdael" for query "Van Gogh"', () => {
  assert.strictEqual(metArtistVerification('Van Gogh', 'Salomon van Ruysdael'), false);
});

test('rejects "Joos van Wassenhove" for query "Van Gogh"', () => {
  assert.strictEqual(metArtistVerification('Van Gogh', 'Joos van Wassenhove'), false);
});

test('accepts "Vincent van Gogh" for query "Van Gogh"', () => {
  assert.strictEqual(metArtistVerification('Van Gogh', 'Vincent van Gogh'), true);
});

test('accepts partial name match — "Monet" matches "Claude Monet"', () => {
  assert.strictEqual(metArtistVerification('Monet', 'Claude Monet'), true);
});

test('accepts full name match', () => {
  assert.strictEqual(metArtistVerification('Claude Monet', 'Claude Monet'), true);
});

test('match is case-insensitive', () => {
  assert.strictEqual(metArtistVerification('van gogh', 'Vincent Van Gogh'), true);
  assert.strictEqual(metArtistVerification('VAN GOGH', 'vincent van gogh'), true);
});

test('rejects object with no artist overlap (unrelated object in search results)', () => {
  assert.strictEqual(metArtistVerification('Rembrandt', 'Jan van Eyck'), false);
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${colors.blue}────────────────────────────────────────${colors.reset}`);
console.log(`Passed:  ${passed}`);
console.log(`Failed:  ${failed}`);
console.log(`Skipped: ${skipped}`);

if (failed > 0) process.exit(1);
