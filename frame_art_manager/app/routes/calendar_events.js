/**
 * Calendar events — HA calendar as sole source of truth.
 *
 * All event data (timing + metadata) lives in the HA calendar. Metadata
 * (label, suppress_moods, linked_calendar, linked_uid, stable uuid) is
 * embedded in each event's description as structured key-value lines and
 * parsed on read. No local events database is maintained.
 *
 * A separate calendar_config.json stores only the calendar entity ID setting.
 *
 * Routes:
 *   GET    /api/calendar-events                          List events from HA
 *   PUT    /api/calendar-events/config                   Update calendar entity ID
 *   GET    /api/calendar-events/calendars                List all HA calendars
 *   GET    /api/calendar-events/calendars/:id/events     List events in a calendar
 *   POST   /api/calendar-events                          Create event in HA
 *   PUT    /api/calendar-events/:uuid                    Update event (delete+recreate)
 *   DELETE /api/calendar-events/:uuid                    Delete event from HA
 *   POST   /api/calendar-events/:uuid/sync-from-linked   Sync times from linked event
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs').promises;
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');

// ── HA connection ──────────────────────────────────────────────────────────

const SUPERVISOR_TOKEN = process.env.SUPERVISOR_TOKEN;
const HA_API_BASE = process.env.HA_URL || 'http://supervisor/core/api';

async function haServiceCall(endpoint, data = null) {
  if (!SUPERVISOR_TOKEN && process.env.NODE_ENV === 'development') {
    return { success: true };
  }
  const resp = await axios({
    method: 'POST',
    url: `${HA_API_BASE}${endpoint}`,
    headers: {
      Authorization: `Bearer ${SUPERVISOR_TOKEN}`,
      'Content-Type': 'application/json',
    },
    data,
  });
  return resp.data;
}

/**
 * Fetch events from the HA calendar REST API.
 * Returns the raw HA event objects which include ha_uid, summary, description,
 * start ({dateTime|date}), end ({dateTime|date}).
 */
async function haRestGetEvents(calendarEntityId, startIso, endIso) {
  if (!SUPERVISOR_TOKEN && process.env.NODE_ENV === 'development') {
    return [];
  }
  const url = `${HA_API_BASE}/calendars/${encodeURIComponent(calendarEntityId)}` +
    `?start=${encodeURIComponent(startIso)}&end=${encodeURIComponent(endIso)}`;
  const resp = await axios({
    method: 'GET',
    url,
    headers: { Authorization: `Bearer ${SUPERVISOR_TOKEN}` },
  });
  return Array.isArray(resp.data) ? resp.data : [];
}

// ── Config storage (calendar entity ID only) ───────────────────────────────

function calendarConfigPath(frameArtPath) {
  return path.join(frameArtPath, 'frame_art', 'calendar_config.json');
}

async function readCalendarConfig(frameArtPath) {
  // Also accept legacy calendar_events.json for the entity ID during transition
  const primary = calendarConfigPath(frameArtPath);
  try {
    const raw = await fs.readFile(primary, 'utf8');
    return JSON.parse(raw);
  } catch {
    try {
      const legacy = path.join(frameArtPath, 'frame_art', 'calendar_events.json');
      const raw = await fs.readFile(legacy, 'utf8');
      const cfg = JSON.parse(raw);
      return { calendar_entity_id: cfg.calendar_entity_id || null };
    } catch {
      return { calendar_entity_id: null };
    }
  }
}

async function writeCalendarConfig(frameArtPath, cfg) {
  const p = calendarConfigPath(frameArtPath);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(cfg, null, 2));
}

// ── Description parsing / building ────────────────────────────────────────

const KNOWN_KEYS = new Set([
  'uid', 'label', 'suppress_moods', 'force_shuffle',
  'linked_calendar', 'linked_uid',
]);

function parseDescription(description) {
  const result = {
    uid: null,
    label: null,
    suppress_moods: false,
    force_shuffle: false,
    linked_calendar: null,
    linked_uid: null,
  };
  if (!description) return result;
  for (const raw of description.split('\n')) {
    const line = raw.trim();
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (!KNOWN_KEYS.has(key)) continue;
    if (key === 'suppress_moods' || key === 'force_shuffle') {
      result[key] = value.toLowerCase() === 'true';
    } else {
      result[key] = value || null;
    }
  }
  return result;
}

function buildDescription(meta) {
  const lines = [];
  if (meta.uid)             lines.push(`uid: ${meta.uid}`);
  if (meta.label)           lines.push(`label: ${meta.label}`);
  if (meta.suppress_moods)  lines.push('suppress_moods: true');
  if (meta.force_shuffle)   lines.push('force_shuffle: true');
  if (meta.linked_calendar) lines.push(`linked_calendar: ${meta.linked_calendar}`);
  if (meta.linked_uid)      lines.push(`linked_uid: ${meta.linked_uid}`);
  return lines.join('\n');
}

// ── HA event helpers ───────────────────────────────────────────────────────

function extractDateTime(haStartOrEnd) {
  if (!haStartOrEnd) return null;
  return haStartOrEnd.dateTime || haStartOrEnd.date || null;
}

/**
 * Create an HA calendar event. Returns null (HA create_event gives no response UID).
 */
async function haCreateEvent(calendarEntityId, summary, startIso, endIso, description) {
  await haServiceCall('/services/calendar/create_event', {
    entity_id: calendarEntityId,
    summary,
    description,
    start_date_time: startIso,
    end_date_time: endIso,
  });
}

/**
 * Delete an HA calendar event by its HA-internal uid.
 */
async function haDeleteEvent(calendarEntityId, haUid) {
  if (!haUid) return;
  try {
    await haServiceCall('/services/calendar/delete_event', {
      entity_id: calendarEntityId,
      uid: haUid,
    });
  } catch (err) {
    if (err?.response?.status !== 404) throw err;
  }
}

/**
 * Find a Frame Art event by our stable uuid, within a wide time window.
 * Returns the raw HA event object (with ha_uid) or null.
 */
async function findHaEventByUuid(calendarEntityId, uuid) {
  const now = new Date();
  const startIso = new Date(now.getTime() - 366 * 24 * 3600 * 1000).toISOString();
  const endIso   = new Date(now.getTime() + 366 * 24 * 3600 * 1000).toISOString();
  const events = await haRestGetEvents(calendarEntityId, startIso, endIso);
  return events.find((e) => parseDescription(e.description).uid === uuid) || null;
}

/**
 * Normalize raw HA REST event into the shape the UI expects.
 */
function normalizeEvent(raw) {
  const meta = parseDescription(raw.description);
  const startIso = extractDateTime(raw.start);
  const endIso   = extractDateTime(raw.end);
  return {
    id: meta.uid || null,           // our stable uuid (null for unmanaged events)
    ha_uid: raw.uid || null,        // HA-internal uid (for delete/update)
    tagset_name: raw.summary || '',
    label: meta.label || raw.summary || '',
    suppress_moods: meta.suppress_moods,
    force_shuffle: meta.force_shuffle,
    linked_calendar: meta.linked_calendar,
    linked_uid: meta.linked_uid,
    start_date_time: startIso,
    end_date_time: endIso,
  };
}

// ── Background sync for linked events ─────────────────────────────────────

let _backgroundSyncFrameArtPath = null;

async function syncLinkedEvents(frameArtPath) {
  const cfg = await readCalendarConfig(frameArtPath);
  if (!cfg.calendar_entity_id) return;

  const now = new Date();
  const startIso = new Date(now.getTime() - 90 * 24 * 3600 * 1000).toISOString();
  const endIso   = new Date(now.getTime() + 366 * 24 * 3600 * 1000).toISOString();

  let faEvents;
  try {
    faEvents = await haRestGetEvents(cfg.calendar_entity_id, startIso, endIso);
  } catch (err) {
    console.warn('[calendar-events] background sync: failed to fetch FA events:', err.message);
    return;
  }

  for (const faEvent of faEvents) {
    const meta = parseDescription(faEvent.description);
    if (!meta.linked_calendar || !meta.linked_uid || !meta.uid) continue;

    try {
      // Find the linked event in its source calendar
      const linkedEvents = await haRestGetEvents(
        meta.linked_calendar,
        new Date(now.getTime() - 90 * 24 * 3600 * 1000).toISOString(),
        endIso,
      );
      const linked = linkedEvents.find((e) => e.uid === meta.linked_uid);
      if (!linked) {
        console.warn(`[calendar-events] background sync: linked event ${meta.linked_uid} not found`);
        continue;
      }

      const newStart = extractDateTime(linked.start);
      const newEnd   = extractDateTime(linked.end);
      const curStart = extractDateTime(faEvent.start);
      const curEnd   = extractDateTime(faEvent.end);

      if (newStart === curStart && newEnd === curEnd) continue;

      console.log(`[calendar-events] background sync: updating times for '${faEvent.summary}'`);
      await haDeleteEvent(cfg.calendar_entity_id, faEvent.uid);
      await haCreateEvent(
        cfg.calendar_entity_id,
        faEvent.summary,
        newStart,
        newEnd,
        faEvent.description, // description unchanged — all metadata preserved
      );
    } catch (err) {
      console.warn(`[calendar-events] background sync: error for '${faEvent.summary}':`, err.message);
    }
  }
}

// Start 24-hour background sync loop. Called from server.js after middleware setup.
function startBackgroundSync(frameArtPath) {
  _backgroundSyncFrameArtPath = frameArtPath;
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  // Run once 60s after startup (gives HA time to be ready), then every 24h
  setTimeout(async () => {
    await syncLinkedEvents(frameArtPath).catch((e) =>
      console.warn('[calendar-events] initial background sync error:', e.message)
    );
    setInterval(() => {
      syncLinkedEvents(frameArtPath).catch((e) =>
        console.warn('[calendar-events] background sync error:', e.message)
      );
    }, MS_PER_DAY);
  }, 60 * 1000);
}

// ── GET /api/calendar-events ───────────────────────────────────────────────

router.get('/', async (req, res) => {
  try {
    const cfg = await readCalendarConfig(req.frameArtPath);
    if (!cfg.calendar_entity_id) {
      return res.json({ calendar_entity_id: null, events: {} });
    }

    const now = new Date();
    // Fetch upcoming + recently-ended events (±30 days) for the list view
    const startIso = new Date(now.getTime() - 30 * 24 * 3600 * 1000).toISOString();
    const endIso   = new Date(now.getTime() + 366 * 24 * 3600 * 1000).toISOString();
    const rawEvents = await haRestGetEvents(cfg.calendar_entity_id, startIso, endIso);

    const events = {};
    for (const raw of rawEvents) {
      const normalized = normalizeEvent(raw);
      const key = normalized.id || `unmanaged-${raw.uid || normalized.start_date_time}`;
      events[key] = normalized;
    }

    res.json({ calendar_entity_id: cfg.calendar_entity_id, events });
  } catch (err) {
    console.error('[calendar-events] GET /: error:', err.message);
    res.status(500).json({ error: 'Failed to fetch calendar events' });
  }
});

// ── PUT /api/calendar-events/config ───────────────────────────────────────

router.put('/config', async (req, res) => {
  const { calendar_entity_id } = req.body;
  if (calendar_entity_id !== undefined && calendar_entity_id !== null &&
      typeof calendar_entity_id !== 'string') {
    return res.status(400).json({ error: 'calendar_entity_id must be a string or null' });
  }
  try {
    const cfg = await readCalendarConfig(req.frameArtPath);
    cfg.calendar_entity_id = calendar_entity_id || null;
    await writeCalendarConfig(req.frameArtPath, cfg);
    res.json({ success: true, calendar_entity_id: cfg.calendar_entity_id });
  } catch (err) {
    console.error('[calendar-events] PUT /config: error:', err.message);
    res.status(500).json({ error: 'Failed to update config' });
  }
});

// ── GET /api/calendar-events/calendars ────────────────────────────────────

router.get('/calendars', async (req, res) => {
  try {
    if (!SUPERVISOR_TOKEN && process.env.NODE_ENV === 'development') {
      return res.json({ calendars: [
        { entity_id: 'calendar.frame_art_events', name: 'Frame Art Events' },
        { entity_id: 'calendar.family', name: 'Family' },
      ]});
    }
    const resp = await axios({
      method: 'GET',
      url: `${HA_API_BASE}/calendars`,
      headers: { Authorization: `Bearer ${SUPERVISOR_TOKEN}` },
    });
    res.json({ calendars: Array.isArray(resp.data) ? resp.data : [] });
  } catch (err) {
    console.error('[calendar-events] GET /calendars: error:', err.message);
    res.status(500).json({ error: 'Failed to fetch calendars from HA' });
  }
});

// ── GET /api/calendar-events/calendars/:id/events ─────────────────────────

router.get('/calendars/:entityId/events', async (req, res) => {
  const { entityId } = req.params;
  const { start, end } = req.query;
  const startIso = start || new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString();
  const endIso   = end   || new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString();
  try {
    const events = await haRestGetEvents(entityId, startIso, endIso);
    res.json({ events });
  } catch (err) {
    console.error('[calendar-events] GET /calendars/:id/events: error:', err.message);
    res.status(500).json({ error: 'Failed to fetch calendar events from HA' });
  }
});

// ── POST /api/calendar-events ─────────────────────────────────────────────

router.post('/', async (req, res) => {
  const {
    label, tagset_name, suppress_moods, force_shuffle,
    start_date_time, end_date_time,
    linked_calendar, linked_uid,
  } = req.body;

  if (!tagset_name?.trim()) {
    return res.status(400).json({ error: 'tagset_name is required' });
  }
  if (!start_date_time || !end_date_time) {
    return res.status(400).json({ error: 'start_date_time and end_date_time are required' });
  }

  try {
    const cfg = await readCalendarConfig(req.frameArtPath);
    if (!cfg.calendar_entity_id) {
      return res.status(400).json({ error: 'No Frame Art calendar configured.' });
    }

    const uuid = uuidv4();
    const meta = {
      uid: uuid,
      label: (label || tagset_name).trim() || null,
      suppress_moods: suppress_moods === true,
      force_shuffle: force_shuffle === true,
      linked_calendar: linked_calendar || null,
      linked_uid: linked_uid || null,
    };
    const description = buildDescription(meta);

    await haCreateEvent(cfg.calendar_entity_id, tagset_name.trim(), start_date_time, end_date_time, description);

    const event = {
      id: uuid,
      ha_uid: null, // HA doesn't return uid on create; available on next read
      tagset_name: tagset_name.trim(),
      ...meta,
      start_date_time,
      end_date_time,
    };
    res.json({ success: true, event });
  } catch (err) {
    console.error('[calendar-events] POST /: error:', err.message);
    res.status(500).json({ error: 'Failed to create calendar event' });
  }
});

// ── PUT /api/calendar-events/:uuid ────────────────────────────────────────

router.put('/:uuid', async (req, res) => {
  const { uuid } = req.params;
  const {
    label, tagset_name, suppress_moods, force_shuffle,
    start_date_time, end_date_time,
    linked_calendar, linked_uid,
  } = req.body;

  try {
    const cfg = await readCalendarConfig(req.frameArtPath);
    if (!cfg.calendar_entity_id) {
      return res.status(400).json({ error: 'No Frame Art calendar configured.' });
    }

    const haEvent = await findHaEventByUuid(cfg.calendar_entity_id, uuid);
    if (!haEvent) {
      return res.status(404).json({ error: `Event with uid '${uuid}' not found in HA calendar` });
    }

    const currentMeta = parseDescription(haEvent.description);
    const updatedMeta = {
      uid: uuid,
      label: (label ?? currentMeta.label ?? '').trim() || null,
      suppress_moods: suppress_moods !== undefined ? suppress_moods === true : currentMeta.suppress_moods,
      force_shuffle: force_shuffle !== undefined ? force_shuffle === true : currentMeta.force_shuffle,
      linked_calendar: linked_calendar !== undefined ? (linked_calendar || null) : currentMeta.linked_calendar,
      linked_uid: linked_uid !== undefined ? (linked_uid || null) : currentMeta.linked_uid,
    };
    const newTagset = (tagset_name ?? haEvent.summary ?? '').trim();
    const newStart  = start_date_time || extractDateTime(haEvent.start);
    const newEnd    = end_date_time   || extractDateTime(haEvent.end);
    const newDesc   = buildDescription(updatedMeta);

    await haDeleteEvent(cfg.calendar_entity_id, haEvent.uid);
    await haCreateEvent(cfg.calendar_entity_id, newTagset, newStart, newEnd, newDesc);

    const event = {
      id: uuid,
      ha_uid: null,
      tagset_name: newTagset,
      ...updatedMeta,
      start_date_time: newStart,
      end_date_time: newEnd,
    };
    res.json({ success: true, event });
  } catch (err) {
    console.error('[calendar-events] PUT /:uuid: error:', err.message);
    res.status(500).json({ error: 'Failed to update calendar event' });
  }
});

// ── DELETE /api/calendar-events/:uuid ─────────────────────────────────────

router.delete('/:uuid', async (req, res) => {
  const { uuid } = req.params;
  try {
    const cfg = await readCalendarConfig(req.frameArtPath);
    if (!cfg.calendar_entity_id) {
      return res.status(400).json({ error: 'No Frame Art calendar configured.' });
    }

    const haEvent = await findHaEventByUuid(cfg.calendar_entity_id, uuid);
    if (!haEvent) {
      return res.status(404).json({ error: `Event with uid '${uuid}' not found in HA calendar` });
    }

    await haDeleteEvent(cfg.calendar_entity_id, haEvent.uid);
    res.json({ success: true });
  } catch (err) {
    console.error('[calendar-events] DELETE /:uuid: error:', err.message);
    res.status(500).json({ error: 'Failed to delete calendar event' });
  }
});

// ── POST /api/calendar-events/:uuid/sync-from-linked ──────────────────────

router.post('/:uuid/sync-from-linked', async (req, res) => {
  const { uuid } = req.params;
  try {
    const cfg = await readCalendarConfig(req.frameArtPath);
    if (!cfg.calendar_entity_id) {
      return res.status(400).json({ error: 'No Frame Art calendar configured.' });
    }

    const haEvent = await findHaEventByUuid(cfg.calendar_entity_id, uuid);
    if (!haEvent) {
      return res.status(404).json({ error: `Event with uid '${uuid}' not found` });
    }

    const meta = parseDescription(haEvent.description);
    if (!meta.linked_calendar || !meta.linked_uid) {
      return res.status(400).json({ error: 'Event has no linked calendar event' });
    }

    const now = new Date();
    const scanStart = new Date(now.getTime() - 90 * 24 * 3600 * 1000).toISOString();
    const scanEnd   = new Date(now.getTime() + 366 * 24 * 3600 * 1000).toISOString();
    const linkedEvents = await haRestGetEvents(meta.linked_calendar, scanStart, scanEnd);
    const linked = linkedEvents.find((e) => e.uid === meta.linked_uid);

    if (!linked) {
      return res.status(404).json({
        error: 'Linked calendar event not found — it may have been deleted',
        changed: false,
      });
    }

    const newStart  = extractDateTime(linked.start);
    const newEnd    = extractDateTime(linked.end);
    const curStart  = extractDateTime(haEvent.start);
    const curEnd    = extractDateTime(haEvent.end);

    if (newStart === curStart && newEnd === curEnd) {
      return res.json({ success: true, changed: false });
    }

    await haDeleteEvent(cfg.calendar_entity_id, haEvent.uid);
    await haCreateEvent(
      cfg.calendar_entity_id,
      haEvent.summary,
      newStart,
      newEnd,
      haEvent.description, // all metadata preserved
    );

    res.json({ success: true, changed: true, newStart, newEnd });
  } catch (err) {
    console.error('[calendar-events] POST /:uuid/sync-from-linked: error:', err.message);
    res.status(500).json({ error: 'Failed to sync from linked calendar' });
  }
});

module.exports = { router, startBackgroundSync };
