#!/usr/bin/env node

/**
 * Web Sources Route Tests
 *
 * Regression tests for the promote endpoint:
 *   POST /api/web-sources/cache/:deviceId/promote
 *
 * The promote endpoint moves a pre-uploaded staged cache file to the display
 * cache and must return `cacheFile` in its response so the HA integration can
 * update the artwork sensor's entity_picture URL.
 *
 * Bug: the endpoint originally returned only `{ success: true }`, causing the
 * fast-path shuffle to never update entity_picture (preview always one behind).
 */

'use strict';

const assert  = require('assert');
const fs      = require('fs').promises;
const http    = require('http');
const os      = require('os');
const path    = require('path');
const express = require('express');

// web_sources.js requires sharp, which is only built for the Docker/Alpine
// environment.  Skip gracefully when running locally.
let webSourcesRouter;
let readWebSourcesConfig;
let writeWebSourcesConfig;
try {
  const mod = require('../routes/web_sources');
  webSourcesRouter      = mod;
  readWebSourcesConfig  = mod.readWebSourcesConfig;
  writeWebSourcesConfig = mod.writeWebSourcesConfig;
} catch (err) {
  if (err.message && err.message.includes('sharp')) {
    console.log(`${'\x1b[33m'}ℹ${'\x1b[0m'} Skipping web-sources tests: sharp module not available locally (runs in Docker)`);
    console.log('Passed: 0');
    console.log('Failed: 0');
    console.log('Skipped: 3');
    process.exit(0);
  }
  throw err;
}

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

// ── Test state ──────────────────────────────────────────────────────────────

let testPath;
let server;
let serverPort;

// ── Setup/teardown ──────────────────────────────────────────────────────────

async function setup() {
  testPath = path.join(os.tmpdir(), `frame-art-ws-test-${Date.now()}`);
  await fs.mkdir(path.join(testPath, 'web_source_cache'), { recursive: true });

  // Initialise web_sources.json (empty config)
  await writeWebSourcesConfig(testPath, {
    sources:         {},
    perTvCache:      {},
    stagedCache:     {},
    webSourceRecency: {},
  });

  // Spin up a minimal Express app with the web-sources router
  const app = express();
  app.use(express.json());
  // Inject frameArtPath the same way the real app does
  app.use((req, _res, next) => { req.frameArtPath = testPath; next(); });
  app.use('/api/web-sources', webSourcesRouter);

  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  serverPort = server.address().port;
}

async function teardown() {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (testPath) await fs.rm(testPath, { recursive: true, force: true });
}

// ── HTTP helper ─────────────────────────────────────────────────────────────

function httpPost(urlPath, body = null) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const options = {
      hostname: '127.0.0.1',
      port:     serverPort,
      path:     urlPath,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ── Tests ───────────────────────────────────────────────────────────────────

test('INTEGRATION: promote returns cacheFile in response', async () => {
  const deviceId = 'test-device-abc123';
  const ext      = 'jpg';

  // Create staged cache file on disk (mimics what fetch-and-send does)
  const stagedFile = path.join(testPath, 'web_source_cache', `${deviceId}_staged.${ext}`);
  await fs.writeFile(stagedFile, 'fake-image-data');

  // Write a stagedCache entry into web_sources.json
  const config = await readWebSourcesConfig(testPath);
  config.stagedCache[deviceId] = {
    filename:   `${deviceId}_staged.${ext}`,
    artworkUrl: 'https://example.com/artwork/123',
    timestamp:  new Date().toISOString(),
  };
  await writeWebSourcesConfig(testPath, config);

  // Call the promote endpoint
  const { status, body } = await httpPost(`/api/web-sources/cache/${deviceId}/promote`);

  assert.strictEqual(status, 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
  assert.strictEqual(body.success, true, 'Response should have success: true');
  assert.ok(
    typeof body.cacheFile === 'string' && body.cacheFile.length > 0,
    `Response should include a non-empty cacheFile string, got: ${JSON.stringify(body.cacheFile)}`,
  );
  assert.strictEqual(
    body.cacheFile,
    `${deviceId}.${ext}`,
    `cacheFile should be the display cache filename '${deviceId}.${ext}', got '${body.cacheFile}'`,
  );
});

test('INTEGRATION: promote renames staged file to display file', async () => {
  const deviceId = 'test-device-rename';
  const ext      = 'jpg';

  const cacheDir    = path.join(testPath, 'web_source_cache');
  const stagedFile  = path.join(cacheDir, `${deviceId}_staged.${ext}`);
  const displayFile = path.join(cacheDir, `${deviceId}.${ext}`);

  await fs.writeFile(stagedFile, 'image-content');

  const config = await readWebSourcesConfig(testPath);
  config.stagedCache[deviceId] = {
    filename:   `${deviceId}_staged.${ext}`,
    artworkUrl: 'https://example.com/artwork/456',
    timestamp:  new Date().toISOString(),
  };
  await writeWebSourcesConfig(testPath, config);

  await httpPost(`/api/web-sources/cache/${deviceId}/promote`);

  // Staged file should be gone; display file should exist
  let stagedExists = true;
  try { await fs.access(stagedFile); } catch { stagedExists = false; }
  assert.ok(!stagedExists, 'Staged file should be removed after promote');

  let displayExists = false;
  try { await fs.access(displayFile); displayExists = true; } catch { displayExists = false; }
  assert.ok(displayExists, 'Display cache file should exist after promote');
});

test('INTEGRATION: promote returns 404 when no staged cache exists', async () => {
  const { status, body } = await httpPost('/api/web-sources/cache/nonexistent-device/promote');
  assert.strictEqual(status, 404, `Expected 404, got ${status}`);
  assert.ok(body.error, 'Response should include an error message');
});

// ── Runner ──────────────────────────────────────────────────────────────────

async function runTests() {
  logSection('Web Sources Promote Endpoint Tests');

  await setup();

  let passed = 0;
  let failed = 0;

  try {
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
  } finally {
    await teardown();
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
