const express = require('express');
const router = express.Router();
const MetadataHelper = require('../metadata_helper');

// GET full blacklist
router.get('/', async (req, res) => {
  try {
    const helper = new MetadataHelper(req.frameArtPath);
    const blacklist = await helper.readBlacklist();
    res.json(blacklist);
  } catch (error) {
    console.error('Error reading blacklist:', error);
    res.status(500).json({ error: 'Failed to read blacklist' });
  }
});

// POST add entry
// Body: { type: 'local'|'web', identifier: string }
router.post('/', async (req, res) => {
  try {
    const { type, identifier } = req.body;
    if (!type || !['local', 'web'].includes(type)) {
      return res.status(400).json({ error: 'type must be "local" or "web"' });
    }
    if (!identifier || typeof identifier !== 'string' || !identifier.trim()) {
      return res.status(400).json({ error: 'identifier is required' });
    }
    const helper = new MetadataHelper(req.frameArtPath);
    const blacklist = await helper.addToBlacklist(type, identifier.trim());
    res.json({ success: true, blacklist });
  } catch (error) {
    console.error('Error adding to blacklist:', error);
    res.status(500).json({ error: 'Failed to add to blacklist' });
  }
});

// DELETE remove entry
// Body: { type: 'local'|'web', identifier: string }
router.delete('/', async (req, res) => {
  try {
    const { type, identifier } = req.body;
    if (!type || !identifier) {
      return res.status(400).json({ error: 'type and identifier are required' });
    }
    const helper = new MetadataHelper(req.frameArtPath);
    const blacklist = await helper.removeFromBlacklist(type, identifier);
    res.json({ success: true, blacklist });
  } catch (error) {
    console.error('Error removing from blacklist:', error);
    res.status(500).json({ error: 'Failed to remove from blacklist' });
  }
});

module.exports = router;
