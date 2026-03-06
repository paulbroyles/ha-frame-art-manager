const express = require('express');
const router = express.Router();
const MetadataHelper = require('../metadata_helper');

// GET all fields
router.get('/', async (req, res) => {
  try {
    const helper = new MetadataHelper(req.frameArtPath);
    const fields = await helper.getAllFields();
    res.json(fields);
  } catch (error) {
    console.error('Error getting fields:', error);
    res.status(500).json({ error: 'Failed to retrieve fields' });
  }
});

// POST add new field
router.post('/', async (req, res) => {
  try {
    const { name } = req.body;

    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'Field name is required' });
    }

    const helper = new MetadataHelper(req.frameArtPath);
    const fields = await helper.addField(name.trim());
    res.json({ success: true, fields });
  } catch (error) {
    console.error('Error adding field:', error);
    res.status(500).json({ error: 'Failed to add field' });
  }
});

// PUT reorder fields
router.put('/order', async (req, res) => {
  try {
    const { order } = req.body;
    if (!Array.isArray(order)) {
      return res.status(400).json({ error: 'order must be an array' });
    }
    const helper = new MetadataHelper(req.frameArtPath);
    const fields = await helper.reorderFields(order);
    res.json({ success: true, fields });
  } catch (error) {
    console.error('Error reordering fields:', error);
    res.status(500).json({ error: 'Failed to reorder fields' });
  }
});

// GET field usage (images with non-empty value) before delete
router.get('/:fieldName/usage', async (req, res) => {
  try {
    const helper = new MetadataHelper(req.frameArtPath);
    const imagesWithValue = await helper.getImagesWithFieldValue(req.params.fieldName);
    res.json({ imagesWithValue });
  } catch (error) {
    console.error('Error checking field usage:', error);
    res.status(500).json({ error: 'Failed to check field usage' });
  }
});

// DELETE field
router.delete('/:fieldName', async (req, res) => {
  try {
    const helper = new MetadataHelper(req.frameArtPath);
    const fields = await helper.removeField(req.params.fieldName);
    res.json({ success: true, fields });
  } catch (error) {
    console.error('Error removing field:', error);
    res.status(500).json({ error: 'Failed to remove field' });
  }
});

module.exports = router;
