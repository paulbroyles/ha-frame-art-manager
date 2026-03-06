const express = require('express');
const router = express.Router();
const MetadataHelper = require('../metadata_helper');

// GET all attributes
router.get('/', async (req, res) => {
  try {
    const helper = new MetadataHelper(req.frameArtPath);
    const attributes = await helper.getAllAttributes();
    res.json(attributes);
  } catch (error) {
    console.error('Error getting attributes:', error);
    res.status(500).json({ error: 'Failed to retrieve attributes' });
  }
});

// POST add new attribute
router.post('/', async (req, res) => {
  try {
    const { name } = req.body;

    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'Attribute name is required' });
    }

    const helper = new MetadataHelper(req.frameArtPath);
    const attributes = await helper.addAttribute(name.trim());
    res.json({ success: true, attributes });
  } catch (error) {
    console.error('Error adding attribute:', error);
    res.status(500).json({ error: 'Failed to add attribute' });
  }
});

// PUT reorder attributes
router.put('/order', async (req, res) => {
  try {
    const { order } = req.body;
    if (!Array.isArray(order)) {
      return res.status(400).json({ error: 'order must be an array' });
    }
    const helper = new MetadataHelper(req.frameArtPath);
    const attributes = await helper.reorderAttributes(order);
    res.json({ success: true, attributes });
  } catch (error) {
    console.error('Error reordering attributes:', error);
    res.status(500).json({ error: 'Failed to reorder attributes' });
  }
});

// GET attribute usage (images with non-empty value) before delete
router.get('/:attributeName/usage', async (req, res) => {
  try {
    const helper = new MetadataHelper(req.frameArtPath);
    const imagesWithValue = await helper.getImagesWithAttributeValue(req.params.attributeName);
    res.json({ imagesWithValue });
  } catch (error) {
    console.error('Error checking attribute usage:', error);
    res.status(500).json({ error: 'Failed to check attribute usage' });
  }
});

// DELETE attribute
router.delete('/:attributeName', async (req, res) => {
  try {
    const helper = new MetadataHelper(req.frameArtPath);
    const attributes = await helper.removeAttribute(req.params.attributeName);
    res.json({ success: true, attributes });
  } catch (error) {
    console.error('Error removing attribute:', error);
    res.status(500).json({ error: 'Failed to remove attribute' });
  }
});

module.exports = router;
