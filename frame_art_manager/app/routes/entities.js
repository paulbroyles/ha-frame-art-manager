const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs').promises;
const MetadataHelper = require('../metadata_helper');

const DEFAULT_ATTRIBUTES = ['title', 'date', 'museum', 'medium'];
const DEFAULT_ENTITY_TYPES = [
  { id: 'creator', name: 'Creator', attributes: ['name', 'lifespan', 'nationality'], kind: 'artist' },
];

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

// PUT set display role on a custom data entry
router.put('/custom-data-order/display-role', async (req, res) => {
  try {
    const { type, nameOrId, role } = req.body;
    if (!type || !nameOrId) {
      return res.status(400).json({ error: 'type and nameOrId are required' });
    }
    if (role && !['primary', 'secondary'].includes(role)) {
      return res.status(400).json({ error: 'role must be "primary", "secondary", or null' });
    }
    const helper = new MetadataHelper(req.frameArtPath);
    const customDataOrder = await helper.setDisplayRole(type, nameOrId, role || null);
    res.json({ success: true, customDataOrder });
  } catch (error) {
    console.error('Error setting display role:', error);
    res.status(500).json({ error: error.message || 'Failed to set display role' });
  }
});

// POST create new entity type
router.post('/', async (req, res) => {
  try {
    const { name, kind } = req.body;
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'Entity type name is required' });
    }
    if (kind !== undefined && kind !== null && kind !== 'artist') {
      return res.status(400).json({ error: 'kind must be "artist" or null' });
    }
    const helper = new MetadataHelper(req.frameArtPath);
    const result = await helper.addEntityType(name.trim(), { kind: kind || null });
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Error adding entity type:', error);
    res.status(500).json({ error: 'Failed to add entity type' });
  }
});

// PUT set/clear the kind on an entity type
router.put('/:entityId/kind', async (req, res) => {
  try {
    const { kind } = req.body;
    if (kind !== null && kind !== 'artist') {
      return res.status(400).json({ error: 'kind must be "artist" or null' });
    }
    const helper = new MetadataHelper(req.frameArtPath);
    const entityType = await helper.setEntityTypeKind(req.params.entityId, kind);
    res.json({ success: true, entityType });
  } catch (error) {
    console.error('Error setting entity kind:', error);
    res.status(500).json({ error: error.message || 'Failed to set entity kind' });
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
// Body: { data: { name, lifespan, ... }, _links?: { wikidataId, artsySlug, googleEntityId } | null }
// _links omitted → preserve existing; null → remove; object → replace
router.post('/:entityId/instances', async (req, res) => {
  try {
    const { data, _links } = req.body;
    if (!data || typeof data !== 'object') {
      return res.status(400).json({ error: 'data object is required' });
    }
    const helper = new MetadataHelper(req.frameArtPath);
    const result = await helper.upsertEntityInstance(req.params.entityId, data, { _links });
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Error upserting entity instance:', error);
    res.status(500).json({ error: error.message || 'Failed to save entity instance' });
  }
});

// GET all unlinked artist-kind instances (for retroactive linking UI)
// Returns { instances: [{ entityId, key, data }] }
router.get('/unlinked-artists', async (req, res) => {
  try {
    const helper = new MetadataHelper(req.frameArtPath);
    const metadata = await helper.readMetadata();
    const artistTypes = (metadata.entityTypes || []).filter(e => e.kind === 'artist');
    const result = [];
    for (const et of artistTypes) {
      const instances = (metadata.entityInstances || {})[et.id] || {};
      for (const [key, inst] of Object.entries(instances)) {
        if (!inst._links || Object.keys(inst._links).length === 0) {
          const usage = Object.keys(metadata.images || {}).filter(f => {
            return (metadata.images[f].entityRefs || {})[et.id] === key;
          });
          result.push({ entityId: et.id, key, data: inst, usageCount: usage.length });
        }
      }
    }
    // Sort by usage count desc (most-used unlinked artists first)
    result.sort((a, b) => b.usageCount - a.usageCount);
    res.json({ instances: result });
  } catch (error) {
    console.error('Error getting unlinked artists:', error);
    res.status(500).json({ error: 'Failed to retrieve unlinked artists' });
  }
});

// POST /restore-defaults
// Resets Custom Metadata attributes to defaults and clears all web source
// userMapping entries (they will be re-seeded from defaultMapping on next read).
router.post('/restore-defaults', async (req, res) => {
  try {
    const helper = new MetadataHelper(req.frameArtPath);
    const metadata = await helper.readMetadata();

    // Replace attributes with defaults, clear any type overrides
    metadata.attributes = [...DEFAULT_ATTRIBUTES];
    delete metadata.attributeTypes;

    // Seed default entity types (add if missing, update attributes if present)
    if (!metadata.entityTypes) metadata.entityTypes = [];
    if (!metadata.entityInstances) metadata.entityInstances = {};
    for (const def of DEFAULT_ENTITY_TYPES) {
      const existing = metadata.entityTypes.find(e => e.id === def.id);
      if (existing) {
        existing.name = def.name;
        existing.attributes = [...def.attributes];
        existing.kind = def.kind || null;
      } else {
        metadata.entityTypes.push({ id: def.id, name: def.name, attributes: [...def.attributes], kind: def.kind || null });
      }
      if (!metadata.entityInstances[def.id]) metadata.entityInstances[def.id] = {};
    }

    // Rebuild customDataOrder: default attributes first, then default entities,
    // then any non-default entity entries that were already present
    const defaultEntityIds = new Set(DEFAULT_ENTITY_TYPES.map(e => e.id));
    const extraEntityEntries = (metadata.customDataOrder || [])
      .filter(e => e.type === 'entity' && !defaultEntityIds.has(e.id));
    metadata.customDataOrder = [
      ...DEFAULT_ATTRIBUTES.map(name => ({ type: 'attribute', name })),
      ...DEFAULT_ENTITY_TYPES.map(({ id }) => ({ type: 'entity', id })),
      ...extraEntityEntries,
    ];

    await helper.writeMetadata(metadata);

    // Clear userMapping from all web sources so they get re-seeded on next read
    const webSourcesPath = path.join(req.frameArtPath, 'web_sources.json');
    try {
      const raw = await fs.readFile(webSourcesPath, 'utf8');
      const webSources = JSON.parse(raw);
      for (const sourceConfig of Object.values(webSources.sources || {})) {
        delete sourceConfig.userMapping;
      }
      await fs.writeFile(webSourcesPath, JSON.stringify(webSources, null, 2));
    } catch {
      // web_sources.json may not exist yet; seeding will happen on first read
    }

    res.json({ success: true, attributes: metadata.attributes });
  } catch (error) {
    console.error('Error restoring custom metadata defaults:', error);
    res.status(500).json({ error: 'Failed to restore defaults' });
  }
});

module.exports = router;
