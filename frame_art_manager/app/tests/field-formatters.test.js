#!/usr/bin/env node

/**
 * Field Formatters Tests
 * Tests for date normalization and the field formatting registry.
 */

'use strict';

const assert = require('assert');
const { formatDate, applyFieldFormat, FORMATTERS } = require('../utils/fieldFormatters');

// Color output helpers
const colors = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  reset: '\x1b[0m',
};

function logSuccess(msg) { console.log(`${colors.green}✓${colors.reset} ${msg}`); }
function logError(msg)   { console.log(`${colors.red}✗${colors.reset} ${msg}`); }
function logSection(msg) { console.log(`\n${colors.blue}${msg}${colors.reset}`); }

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

// ---------------------------------------------------------------------------
// formatDate — basic year pass-through
// ---------------------------------------------------------------------------

test('plain year is unchanged', () => {
  assert.strictEqual(formatDate('1889'), '1889');
});

test('plain year with spaces trimmed', () => {
  assert.strictEqual(formatDate('  1889  '), '1889');
});

// ---------------------------------------------------------------------------
// formatDate — ISO date stripping
// ---------------------------------------------------------------------------

test('ISO date strips month and day', () => {
  assert.strictEqual(formatDate('1995-03-07'), '1995');
});

test('ISO date with year-month strips month', () => {
  assert.strictEqual(formatDate('1995-03'), '1995');
});

// ---------------------------------------------------------------------------
// formatDate — slash-separated ranges
// ---------------------------------------------------------------------------

test('slash range of plain years', () => {
  assert.strictEqual(formatDate('1872/2015'), '1872-2015');
});

test('slash range of ISO dates extracts years', () => {
  assert.strictEqual(formatDate('1872-03-07/2015-11-22'), '1872-2015');
});

test('slash range with mixed formats', () => {
  assert.strictEqual(formatDate('1872-03/2015'), '1872-2015');
});

test('dash-separated ISO date range (no slash) extracts years', () => {
  assert.strictEqual(formatDate('1920-03-15-1945-07-11'), '1920-1945');
});

// ---------------------------------------------------------------------------
// formatDate — spaced dash normalization
// ---------------------------------------------------------------------------

test('spaced dash between years becomes tight dash', () => {
  assert.strictEqual(formatDate('1452 - 1519'), '1452-1519');
});

test('spaced dash with extra spaces', () => {
  assert.strictEqual(formatDate('1452  -  1519'), '1452-1519');
});

// ---------------------------------------------------------------------------
// formatDate — same-year range collapse
// ---------------------------------------------------------------------------

test('same-year range collapses to single year', () => {
  assert.strictEqual(formatDate('1920-1920'), '1920');
});

test('different-year range is not collapsed', () => {
  assert.strictEqual(formatDate('1920-1921'), '1920-1921');
});

// ---------------------------------------------------------------------------
// formatDate — circa/about abbreviation
// ---------------------------------------------------------------------------

test('circa is abbreviated to ca.', () => {
  assert.strictEqual(formatDate('circa 1920'), 'ca. 1920');
});

test('about is abbreviated to ca.', () => {
  assert.strictEqual(formatDate('about 1920'), 'ca. 1920');
});

test('approximately is abbreviated to ca.', () => {
  assert.strictEqual(formatDate('approximately 1920'), 'ca. 1920');
});

test('CIRCA (uppercase) is abbreviated', () => {
  assert.strictEqual(formatDate('CIRCA 1920'), 'ca. 1920');
});

test('ca. already normalized stays ca.', () => {
  assert.strictEqual(formatDate('ca. 1920'), 'ca. 1920');
});

// ---------------------------------------------------------------------------
// formatDate — preserved modifiers
// ---------------------------------------------------------------------------

test('before modifier is preserved', () => {
  assert.strictEqual(formatDate('before 1500'), 'before 1500');
});

test('after modifier is preserved', () => {
  assert.strictEqual(formatDate('after 1500'), 'after 1500');
});

// ---------------------------------------------------------------------------
// formatDate — combined cases
// ---------------------------------------------------------------------------

test('circa with ISO date keeps ca. and strips month/day', () => {
  assert.strictEqual(formatDate('circa 1920-05-01'), 'ca. 1920');
});

test('circa slash range', () => {
  assert.strictEqual(formatDate('circa 1800/1900'), 'ca. 1800-1900');
});

// ---------------------------------------------------------------------------
// formatDate — non-date strings
// ---------------------------------------------------------------------------

test('non-date string with no digits passes through', () => {
  assert.strictEqual(formatDate('Unknown'), 'Unknown');
});

test('empty string passes through', () => {
  assert.strictEqual(formatDate(''), '');
});

test('non-string value is converted to string', () => {
  assert.strictEqual(formatDate(1889), '1889');
});

// ---------------------------------------------------------------------------
// applyFieldFormat
// ---------------------------------------------------------------------------

test('applyFieldFormat with "date" type delegates to formatDate', () => {
  assert.strictEqual(applyFieldFormat('1872/2015', 'date'), '1872-2015');
});

test('applyFieldFormat with null format type returns String(value)', () => {
  assert.strictEqual(applyFieldFormat('1872/2015', null), '1872/2015');
});

test('applyFieldFormat with unknown format type returns String(value)', () => {
  assert.strictEqual(applyFieldFormat('hello', 'nonexistent'), 'hello');
});

test('applyFieldFormat with undefined format type returns String(value)', () => {
  assert.strictEqual(applyFieldFormat(42, undefined), '42');
});

// ---------------------------------------------------------------------------
// FORMATTERS registry
// ---------------------------------------------------------------------------

test('FORMATTERS registry has "date" key', () => {
  assert.ok(typeof FORMATTERS.date === 'function');
});

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

async function runTests() {
  console.log('🧪 Running Field Formatters Tests...\n');

  let passed = 0;
  let failed = 0;

  for (const t of tests) {
    try {
      await t.fn();
      logSuccess(t.name);
      passed++;
    } catch (error) {
      logError(t.name);
      console.error(`  ${error.message}`);
      if (error.stack) {
        console.error(`  ${error.stack.split('\n').slice(1, 3).join('\n  ')}`);
      }
      failed++;
    }
  }

  logSection('📊 Test Results');
  console.log(`${colors.green}Passed: ${passed}${colors.reset}`);
  console.log(`${colors.red}Failed: ${failed}${colors.reset}`);
  console.log(`Total: ${tests.length}`);

  process.exit(failed > 0 ? 1 : 0);
}

if (require.main === module) {
  runTests().catch(error => {
    console.error('Test suite error:', error);
    process.exit(1);
  });
}

module.exports = { runTests };
