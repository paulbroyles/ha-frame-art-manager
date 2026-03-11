'use strict';

const { execFile } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

// dezoomify-rs binary installed in the Dockerfile at /usr/local/bin/dezoomify-rs.
// GitHub: https://github.com/lovasoa/dezoomify-rs — download dezoomify-rs-linux.tgz
const DEZOOMIFY_BINARY = '/usr/local/bin/dezoomify-rs';

let _binaryChecked = false;
let _binaryAvailable = false;

async function isBinaryAvailable() {
  if (_binaryChecked) return _binaryAvailable;
  try {
    await fs.access(DEZOOMIFY_BINARY, fs.constants.X_OK);
    _binaryAvailable = true;
  } catch {
    _binaryAvailable = false;
  }
  _binaryChecked = true;
  return _binaryAvailable;
}

/**
 * Download a high-resolution image using dezoomify-rs.
 *
 * dezoomify-rs auto-detects the deep-zoom tile format for supported services
 * (including Google Arts & Culture). It fetches tiles at the smallest zoom level
 * that satisfies the maxWidth constraint, avoiding unnecessarily large downloads.
 *
 * This function is a no-op (returns null) if dezoomify-rs is not installed,
 * so sources that call it degrade gracefully in non-Docker environments.
 *
 * @param {string} artworkUrl - Artwork page URL (e.g., https://artsandculture.google.com/asset/...)
 * @param {object} [options]
 * @param {number} [options.maxWidth=4801] - Maximum width in pixels. dezoomify-rs selects
 *   the smallest zoom level whose width is >= this value. 4801 gives one step above 4800
 *   to ensure we get at least the 4800px target.
 * @returns {Promise<Buffer|null>} Image buffer, or null if dezoomify-rs is unavailable or fails.
 */
async function dezoomify(artworkUrl, { maxWidth = 4801 } = {}) {
  if (!await isBinaryAvailable()) {
    return null;
  }

  const tmpFile = path.join(
    os.tmpdir(),
    `dezoomify-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`
  );

  try {
    await new Promise((resolve, reject) => {
      execFile(
        DEZOOMIFY_BINARY,
        ['--max-width', String(maxWidth), '--compression', '0', artworkUrl, tmpFile],
        { timeout: 120000 },
        (err, _stdout, stderr) => {
          if (err) reject(new Error(`dezoomify-rs failed: ${(stderr || err.message).trim()}`));
          else resolve();
        }
      );
    });
    return await fs.readFile(tmpFile);
  } catch (err) {
    console.warn(`[dezoomify] ${artworkUrl}: ${err.message}`);
    return null;
  } finally {
    try { await fs.unlink(tmpFile); } catch { /* ignore */ }
  }
}

module.exports = { dezoomify };