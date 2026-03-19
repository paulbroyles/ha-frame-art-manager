#!/usr/bin/env node

/**
 * HA Route Template Contract Tests
 *
 * The GET /api/ha/tvs endpoint uses a Jinja2 template to read per-TV tagset
 * assignments from HA entity states.  These assignments live in dedicated
 * sensor entities whose IDs end with specific suffixes:
 *
 *   _selected_tagset   → FrameArtSelectedTagsetEntity  (state = tagset name)
 *   _override_tagset   → FrameArtOverrideTagsetEntity  (state = tagset name)
 *   _override_expiry   → FrameArtOverrideExpiryEntity  (state = expiry datetime)
 *
 * Bug history: the template previously read these as *attributes* of the
 * _current_artwork entity (which holds artwork metadata, not tagset info).
 * This caused the Tags UI to always show "no tagset assigned" even when a
 * tagset was correctly stored in the HA config entry.
 *
 * These tests verify the template reads from the correct entities so that any
 * future refactor that regresses to the wrong pattern fails loudly.
 */

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

// ── Color output helpers ────────────────────────────────────────────────────

const colors = {
  green:  '\x1b[32m',
  red:    '\x1b[31m',
  yellow: '\x1b[33m',
  blue:   '\x1b[34m',
  reset:  '\x1b[0m',
};
const logSuccess = (msg) => console.log(`${colors.green}✓${colors.reset} ${msg}`);
const logError   = (msg) => console.log(`${colors.red}✗${colors.reset} ${msg}`);
const logSection = (msg) => console.log(`\n${colors.blue}${msg}${colors.reset}`);

// ── Test registry ───────────────────────────────────────────────────────────

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ── Load the ha.js source once ──────────────────────────────────────────────

const haRoutePath = path.join(__dirname, '../routes/ha.js');
const haSource    = fs.readFileSync(haRoutePath, 'utf8');

/**
 * Extract the Jinja2 template string from the ha.js source.
 * The template is assigned as a template literal: const template = `...`;
 */
function extractTemplate() {
  // Match the template literal assigned to `const template`
  const match = haSource.match(/const\s+template\s*=\s*`([\s\S]*?)`\s*;/);
  assert.ok(match, 'Could not extract template string from ha.js — has the variable name changed?');
  return match[1];
}

// ── Tests ───────────────────────────────────────────────────────────────────

test('UNIT: template reads selected_tagset from _selected_tagset entity state', () => {
  const template = extractTemplate();

  // Must check the _selected_tagset entity suffix
  assert.ok(
    template.includes("endswith('_selected_tagset')"),
    "Template must check entity.endswith('_selected_tagset') to read the selected tagset",
  );

  // Must read it as state(), not as a state_attr()
  // Find the block that handles _selected_tagset
  const blockMatch = template.match(
    /endswith\('_selected_tagset'\)[\s\S]*?{%\s*endif\s*%}/
  );
  assert.ok(blockMatch, 'Expected a {% if entity.endswith("_selected_tagset") %} block');

  const block = blockMatch[0];
  assert.ok(
    block.includes('states(entity)'),
    'selected_tagset should be read from states(entity), not state_attr()',
  );
  assert.ok(
    !block.includes("state_attr(entity, 'selected_tagset')"),
    "selected_tagset must not be read as state_attr(entity, 'selected_tagset')",
  );
});

test('UNIT: template reads override_tagset from _override_tagset entity state', () => {
  const template = extractTemplate();

  assert.ok(
    template.includes("endswith('_override_tagset')"),
    "Template must check entity.endswith('_override_tagset') to read the override tagset",
  );

  const blockMatch = template.match(
    /endswith\('_override_tagset'\)[\s\S]*?{%\s*endif\s*%}/
  );
  assert.ok(blockMatch, 'Expected a {% if entity.endswith("_override_tagset") %} block');

  const block = blockMatch[0];
  assert.ok(
    block.includes('states(entity)'),
    'override_tagset should be read from states(entity), not state_attr()',
  );
});

test('UNIT: template reads override_expiry from _override_expiry entity state', () => {
  const template = extractTemplate();

  assert.ok(
    template.includes("endswith('_override_expiry')"),
    "Template must check entity.endswith('_override_expiry') to read the override expiry",
  );

  const blockMatch = template.match(
    /endswith\('_override_expiry'\)[\s\S]*?{%\s*endif\s*%}/
  );
  assert.ok(blockMatch, 'Expected a {% if entity.endswith("_override_expiry") %} block');

  const block = blockMatch[0];
  assert.ok(
    block.includes('states(entity)'),
    'override_expiry should be read from states(entity)',
  );
});

test('UNIT: template does not read tagset info as attributes of _current_artwork', () => {
  const template = extractTemplate();

  // Find the _current_artwork block (if it still exists for other purposes)
  const currentArtworkBlock = template.match(
    /endswith\('_current_artwork'\)[\s\S]*?{%\s*endif\s*%}/
  );

  if (currentArtworkBlock) {
    const block = currentArtworkBlock[0];
    // These attributes moved to dedicated sensors — must not be read from _current_artwork
    const forbidden = ['selected_tagset', 'override_tagset', 'override_expiry_time', 'active_tagset'];
    for (const attr of forbidden) {
      assert.ok(
        !block.includes(`state_attr(entity, '${attr}')`),
        `'${attr}' must not be read as a state_attr of _current_artwork — ` +
        `it is a state of a dedicated sensor entity`,
      );
    }
  }
  // If the _current_artwork block no longer exists, the constraint is trivially satisfied.
});

test('UNIT: active_tagset is computed in JS from override/selected (not from template)', () => {
  // active_tagset is no longer fetched from HA — it is computed server-side as
  // override_tagset || selected_tagset after the template is parsed.
  // Verify the computation exists in the route source.
  assert.ok(
    haSource.includes('active_tagset') &&
    haSource.includes('override_tagset') &&
    haSource.includes('selected_tagset') &&
    // The computation: tv.active_tagset = tv.override_tagset || tv.selected_tagset ...
    /active_tagset\s*=\s*.+override_tagset\s*\|\|\s*.+selected_tagset/.test(haSource),
    'active_tagset should be computed as override_tagset || selected_tagset in the JS route handler',
  );
});

// ── Runner ──────────────────────────────────────────────────────────────────

async function runTests() {
  logSection('HA Route Template Contract Tests');

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
      if (err.stack) {
        console.error(`  ${err.stack.split('\n').slice(1, 3).join('\n')}`);
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
  runTests().catch((err) => {
    console.error('Test suite error:', err);
    process.exit(1);
  });
}

module.exports = { runTests };
