const express = require('express');
const router = express.Router();
const MetadataHelper = require('../metadata_helper');

// GET all entity types
router.get('/', async (req, res) => {
  try {
    const helper = new MetadataHelper(req.frameArtPath);
    const entityTypes = await helper.getAllEntityTypes();
    res.json(entityTypes);
  } catch (error) {
    console.error('Error getting entity types:', error);
    res.status(500).json({ error: 'Failed to retrieve entity types' });
  }
});

// GET all entity types with instances and custom data order (for frontend init)
router.get('/with-instances', async (req, res) => {
  try {
    const helper = new MetadataHelper(req.frameArtPath);
    const metadata = await helper.readMetadata();
    const entityTypes = metadata.entityTypes || [];
    const entityInstances = metadata.entityInstances || {};
    const customDataOrder = metadata.customDataOrder || helper._buildDefaultCustomDataOrder(metadata);
    res.json({ entityTypes, entityInstances, customDataOrder });
  } catch (error) {
    console.error('Error getting entities with instances:', error);
    res.status(500).json({ error: 'Failed to retrieve entities' });
  }
});

// PUT reorder the unified custom data list (must be before /:entityId routes)
router.put('/custom-data-order', async (req, res) => {
  try {
    const { order } = req.body;
    if (!Array.isArray(order)) {
      return res.status(400).json({ error: 'order must be an array' });
    }
    const helper = new MetadataHelper(req.frameArtPath);
    const customDataOrder = await helper.reorderCustomData(order);
    res.json({ success: true, customDataOrder });
  } catch (error) {
    console.error('Error reordering custom data:', error);
    res.status(500).json({ error: 'Failed to reorder custom data' });
  }
});

// POST create new entity type
router.post('/', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'Entity type name is required' });
    }
    const helper = new MetadataHelper(req.frameArtPath);
    const result = await helper.addEntityType(name.trim());
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Error adding entity type:', error);
    res.status(500).json({ error: 'Failed to add entity type' });
  }
});

// DELETE entity type
router.delete('/:entityId', async (req, res) => {
  try {
    const helper = new MetadataHelper(req.frameArtPath);
    const result = await helper.removeEntityType(req.params.entityId);
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Error removing entity type:', error);
    res.status(500).json({ error: 'Failed to remove entity type' });
  }
});

// POST add attribute to entity type
router.post('/:entityId/attributes', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'Attribute name is required' });
    }
    const helper = new MetadataHelper(req.frameArtPath);
    const entityType = await helper.addEntityTypeAttribute(req.params.entityId, name.trim());
    res.json({ success: true, entityType });
  } catch (error) {
    console.error('Error adding entity attribute:', error);
    res.status(500).json({ error: error.message || 'Failed to add entity attribute' });
  }
});

// DELETE attribute from entity type
router.delete('/:entityId/attributes/:attrName', async (req, res) => {
  try {
    const helper = new MetadataHelper(req.frameArtPath);
    const entityType = await helper.removeEntityTypeAttribute(req.params.entityId, req.params.attrName);
    res.json({ success: true, entityType });
  } catch (error) {
    console.error('Error removing entity attribute:', error);
    res.status(500).json({ error: error.message || 'Failed to remove entity attribute' });
  }
});

// PUT reorder attributes within entity type
router.put('/:entityId/attributes/order', async (req, res) => {
  try {
    const { order } = req.body;
    if (!Array.isArray(order)) {
      return res.status(400).json({ error: 'order must be an array' });
    }
    const helper = new MetadataHelper(req.frameArtPath);
    const entityType = await helper.reorderEntityTypeAttributes(req.params.entityId, order);
    res.json({ success: true, entityType });
  } catch (error) {
    console.error('Error reordering entity attributes:', error);
    res.status(500).json({ error: error.message || 'Failed to reorder entity attributes' });
  }
});

// GET all instances of an entity type
router.get('/:entityId/instances', async (req, res) => {
  try {
    const helper = new MetadataHelper(req.frameArtPath);
    const instances = await helper.getAllEntityInstances(req.params.entityId);
    res.json(instances);
  } catch (error) {
    console.error('Error getting entity instances:', error);
    res.status(500).json({ error: 'Failed to retrieve entity instances' });
  }
});

// GET usage for a specific instance key
router.get('/:entityId/instances/:key/usage', async (req, res) => {
  try {
    const helper = new MetadataHelper(req.frameArtPath);
    const filenames = await helper.getEntityInstanceUsage(req.params.entityId, req.params.key);
    res.json({ filenames });
  } catch (error) {
    console.error('Error getting entity instance usage:', error);
    res.status(500).json({ error: 'Failed to get entity instance usage' });
  }
});

// POST create or update entity instance (key derived server-side from key attribute value)
router.post('/:entityId/instances', async (req, res) => {
  try {
    const { data } = req.body;
    if (!data || typeof data !== 'object') {
      return res.status(400).json({ error: 'data object is required' });
    }
    const helper = new MetadataHelper(req.frameArtPath);
    const result = await helper.upsertEntityInstance(req.params.entityId, data);
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Error upserting entity instance:', error);
    res.status(500).json({ error: error.message || 'Failed to save entity instance' });
  }
});

module.exports = router;
