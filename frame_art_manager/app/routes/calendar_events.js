/**
 * Calendar events storage and HA calendar write API.
 *
 * Manages Frame Art calendar events — scheduled tagset overrides tied to
 * a dedicated HA calendar entity (e.g. calendar.frame_art_events). Event
 * timing lives in HA; this file stores display metadata and optional links
 * to "main" calendar events for automatic time-syncing.
 *
 * Routes:
 *   GET    /api/calendar-events                          List all events + config
 *   PUT    /api/calendar-events/config                   Update calendar entity ID
 *   GET    /api/calendar-events/calendars                List all HA calendars
 *   GET    /api/calendar-events/calendars/:id/events     List events in a calendar
 *   POST   /api/calendar-events                          Create event
 *   PUT    /api/calendar-events/:id                      Update event
 *   DELETE /api/calendar-events/:id                      Delete event
 *   POST   /api/calendar-events/:id/sync-from-linked     Re-sync times from linked calendar event
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs').promises;
const { randomUUID } = require('crypto');
const axios = require('axios');

// ── HA connection ──────────────────────────────────────────────────────────

const SUPERVISOR_TOKEN = process.env.SUPERVISOR_TOKEN;
const HA_API_BASE = process.env.HA_URL || 'http://supervisor/core/api';

async function haRequest(method, endpoint, data = null) {
  if (!SUPERVISOR_TOKEN && process.env.NODE_ENV === 'development') {
    // Dev mode: return plausible mocks
    if (endpoint.includes('/calendars')) {
      if (endpoint.match(/\/calendars\/[^/]+\/events/)) {
        return [
          { uid: 'mock-uid-1', summary: 'Star Wars Day', start: { dateTime: '2026-05-04T00:00:00' }, end: { dateTime: '2026-05-05T00:00:00' } },
          { uid: 'mock-uid-2', summary: 'Christmas', start: { dateTime: '2026-12-25T00:00:00' }, end: { dateTime: '2026-12-26T00:00:00' } },
        ];
      }
      return [
        { entity_id: 'calendar.frame_art_events', name: 'Frame Art Events' },
        { entity_id: 'calendar.family', name: 'Family' },
        { entity_id: 'calendar.work', name: 'Work' },
      ];
    }
    if (endpoint.includes('calendar/get_events')) {
      return { 'calendar.frame_art_events': { events: [] } };
    }
    if (endpoint.includes('/services/calendar/')) {
      return { success: true };
    }
    return { success: true };
  }

  const config = {
    method,
    url: `${HA_API_BASE}${endpoint}`,
    headers: {
      Authorization: `Bearer ${SUPERVISOR_TOKEN}`,
      'Content-Type': 'application/json',
    },
    data,
  };
  const resp = await axios(config);
  return resp.data;
}

// ── Storage ────────────────────────────────────────────────────────────────

function calendarEventsConfigPath(frameArtPath) {
  return path.join(frameArtPath, 'frame_art', 'calendar_events.json');
}

async function readCalendarEventsConfig(frameArtPath) {
  try {
    const raw = await fs.readFile(calendarEventsConfigPath(frameArtPath), 'utf8');
    const cfg = JSON.parse(raw);
    if (!cfg.events) cfg.events = {};
    return cfg;
  } catch {
    return { version: 1, calendar_entity_id: null, events: {} };
  }
}

async function writeCalendarEventsConfig(frameArtPath, cfg) {
  const p = calendarEventsConfigPath(frameArtPath);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(cfg, null, 2));
}

// ── HA calendar helpers ────────────────────────────────────────────────────

/**
 * Build the description string for a Frame Art HA calendar event.
 * Only writes non-default values to keep descriptions clean.
 */
function buildEventDescription(event) {
  const lines = [];
  if (event.suppress_moods) lines.push('suppress_moods: true');
  if (event.linked_calendar) lines.push(`linked_calendar: ${event.linked_calendar}`);
  if (event.linked_uid) lines.push(`linked_uid: ${event.linked_uid}`);
  return lines.join('\n');
}

/**
 * Create a HA calendar event and return the UID.
 * HA's create_event service doesn't return the UID, so we follow up with
 * a narrow get_events query and match by summary + start time.
 */
async function createHaCalendarEvent(calendarEntityId, tagsetName, startIso, endIso, event) {
  const description = buildEventDescription(event);
  await haRequest('POST', '/services/calendar/create_event', {
    entity_id: calendarEntityId,
    summary: tagsetName,
    description,
    start_date_time: startIso,
    end_date_time: endIso,
  });

  // Fetch back to find the UID: query a ±2 min window around the start time
  const windowStart = new Date(new Date(startIso).getTime() - 2 * 60 * 1000).toISOString();
  const windowEnd = new Date(new Date(startIso).getTime() + 2 * 60 * 1000).toISOString();
  try {
    const result = await haRequest('POST', '/services/calendar/get_events', {
      entity_id: calendarEntityId,
      start_date_time: windowStart,
      end_date_time: windowEnd,
    });
    const events = (result?.[calendarEntityId]?.events) || [];
    const match = events.find((e) => {
      const eStart = e.start?.dateTime || e.start?.date || '';
      return e.summary === tagsetName && eStart.startsWith(startIso.slice(0, 16));
    });
    return match?.uid || null;
  } catch {
    return null;
  }
}

/**
 * Delete a HA calendar event by UID. Gracefully ignores 404.
 */
async function deleteHaCalendarEvent(calendarEntityId, uid) {
  if (!uid) return;
  try {
    await haRequest('POST', '/services/calendar/delete_event', {
      entity_id: calendarEntityId,
      uid,
    });
  } catch (err) {
    if (!err?.response?.status === 404) throw err;
  }
}

// ── GET /api/calendar-events ───────────────────────────────────────────────

router.get('/', async (req, res) => {
  try {
    const cfg = await readCalendarEventsConfig(req.frameArtPath);
    res.json({ calendar_entity_id: cfg.calendar_entity_id || null, events: cfg.events });
  } catch (err) {
    console.error('[calendar-events] GET /: error:', err.message);
    res.status(500).json({ error: 'Failed to read calendar events' });
  }
});

// ── PUT /api/calendar-events/config ───────────────────────────────────────

router.put('/config', async (req, res) => {
  const { calendar_entity_id } = req.body;
  if (calendar_entity_id !== undefined && calendar_entity_id !== null && typeof calendar_entity_id !== 'string') {
    return res.status(400).json({ error: 'calendar_entity_id must be a string or null' });
  }
  try {
    const cfg = await readCalendarEventsConfig(req.frameArtPath);
    cfg.calendar_entity_id = calendar_entity_id || null;
    await writeCalendarEventsConfig(req.frameArtPath, cfg);
    res.json({ success: true, calendar_entity_id: cfg.calendar_entity_id });
  } catch (err) {
    console.error('[calendar-events] PUT /config: error:', err.message);
    res.status(500).json({ error: 'Failed to update config' });
  }
});

// ── GET /api/calendar-events/calendars ────────────────────────────────────

router.get('/calendars', async (req, res) => {
  try {
    const calendars = await haRequest('GET', '/calendars');
    res.json({ calendars: Array.isArray(calendars) ? calendars : [] });
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
  const endIso = end || new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString();

  try {
    const result = await haRequest('POST', '/services/calendar/get_events', {
      entity_id: entityId,
      start_date_time: startIso,
      end_date_time: endIso,
    });
    const events = (result?.[entityId]?.events) || [];
    res.json({ events });
  } catch (err) {
    console.error('[calendar-events] GET /calendars/:id/events: error:', err.message);
    res.status(500).json({ error: 'Failed to fetch calendar events from HA' });
  }
});

// ── POST /api/calendar-events ─────────────────────────────────────────────

router.post('/', async (req, res) => {
  const { label, tagset_name, suppress_moods, start_date_time, end_date_time } = req.body;

  if (!tagset_name || typeof tagset_name !== 'string' || !tagset_name.trim()) {
    return res.status(400).json({ error: 'tagset_name is required' });
  }
  if (!start_date_time || !end_date_time) {
    return res.status(400).json({ error: 'start_date_time and end_date_time are required' });
  }

  try {
    const cfg = await readCalendarEventsConfig(req.frameArtPath);
    if (!cfg.calendar_entity_id) {
      return res.status(400).json({ error: 'No Frame Art calendar configured. Set calendar_entity_id first.' });
    }

    const id = randomUUID();
    const event = {
      id,
      label: (label || tagset_name).trim(),
      tagset_name: tagset_name.trim(),
      suppress_moods: suppress_moods === true,
      start_date_time,
      end_date_time,
      ha_event_uid: null,
      linked_calendar: null,
      linked_uid: null,
      created_at: new Date().toISOString(),
    };

    const uid = await createHaCalendarEvent(
      cfg.calendar_entity_id,
      event.tagset_name,
      start_date_time,
      end_date_time,
      event,
    );
    event.ha_event_uid = uid;

    cfg.events[id] = event;
    await writeCalendarEventsConfig(req.frameArtPath, cfg);

    res.json({ success: true, event });
  } catch (err) {
    console.error('[calendar-events] POST /: error:', err.message);
    res.status(500).json({ error: 'Failed to create calendar event' });
  }
});

// ── PUT /api/calendar-events/:id ──────────────────────────────────────────

router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const { label, tagset_name, suppress_moods, start_date_time, end_date_time } = req.body;

  try {
    const cfg = await readCalendarEventsConfig(req.frameArtPath);
    const existing = cfg.events[id];
    if (!existing) {
      return res.status(404).json({ error: `Event '${id}' not found` });
    }
    if (!cfg.calendar_entity_id) {
      return res.status(400).json({ error: 'No Frame Art calendar configured.' });
    }

    const updated = {
      ...existing,
      label: (label ?? existing.label).trim(),
      tagset_name: ((tagset_name ?? existing.tagset_name) || '').trim(),
      suppress_moods: suppress_moods !== undefined ? suppress_moods === true : existing.suppress_moods,
      updated_at: new Date().toISOString(),
    };

    // Update HA calendar event: delete old + recreate (HA has no generic update service)
    if (start_date_time || end_date_time) {
      const newStart = start_date_time || null;
      const newEnd = end_date_time || null;
      if (newStart && newEnd) {
        updated.start_date_time = newStart;
        updated.end_date_time = newEnd;
        await deleteHaCalendarEvent(cfg.calendar_entity_id, existing.ha_event_uid);
        const newUid = await createHaCalendarEvent(
          cfg.calendar_entity_id,
          updated.tagset_name,
          newStart,
          newEnd,
          updated,
        );
        updated.ha_event_uid = newUid;
      }
    } else if (
      updated.tagset_name !== existing.tagset_name ||
      updated.suppress_moods !== existing.suppress_moods
    ) {
      // Metadata changed but no time change — delete + recreate to update summary/description
      // We need the original times; query HA for them
      if (existing.ha_event_uid) {
        const now = new Date();
        const scanStart = new Date(now.getTime() - 366 * 24 * 3600 * 1000).toISOString();
        const scanEnd = new Date(now.getTime() + 366 * 24 * 3600 * 1000).toISOString();
        try {
          const result = await haRequest('POST', '/services/calendar/get_events', {
            entity_id: cfg.calendar_entity_id,
            start_date_time: scanStart,
            end_date_time: scanEnd,
          });
          const events = (result?.[cfg.calendar_entity_id]?.events) || [];
          const haEvent = events.find((e) => e.uid === existing.ha_event_uid);
          if (haEvent) {
            const eStart = haEvent.start?.dateTime || haEvent.start?.date;
            const eEnd = haEvent.end?.dateTime || haEvent.end?.date;
            await deleteHaCalendarEvent(cfg.calendar_entity_id, existing.ha_event_uid);
            const newUid = await createHaCalendarEvent(
              cfg.calendar_entity_id,
              updated.tagset_name,
              eStart,
              eEnd,
              updated,
            );
            updated.ha_event_uid = newUid;
          }
        } catch (e) {
          console.warn('[calendar-events] PUT /:id: could not re-sync HA event:', e.message);
        }
      }
    }

    cfg.events[id] = updated;
    await writeCalendarEventsConfig(req.frameArtPath, cfg);

    res.json({ success: true, event: updated });
  } catch (err) {
    console.error('[calendar-events] PUT /:id: error:', err.message);
    res.status(500).json({ error: 'Failed to update calendar event' });
  }
});

// ── DELETE /api/calendar-events/:id ───────────────────────────────────────

router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const cfg = await readCalendarEventsConfig(req.frameArtPath);
    const existing = cfg.events[id];
    if (!existing) {
      return res.status(404).json({ error: `Event '${id}' not found` });
    }

    if (cfg.calendar_entity_id && existing.ha_event_uid) {
      await deleteHaCalendarEvent(cfg.calendar_entity_id, existing.ha_event_uid);
    }

    delete cfg.events[id];
    await writeCalendarEventsConfig(req.frameArtPath, cfg);

    res.json({ success: true, message: `Event '${existing.label}' deleted` });
  } catch (err) {
    console.error('[calendar-events] DELETE /:id: error:', err.message);
    res.status(500).json({ error: 'Failed to delete calendar event' });
  }
});

// ── POST /api/calendar-events/:id/sync-from-linked ────────────────────────

router.post('/:id/sync-from-linked', async (req, res) => {
  const { id } = req.params;
  try {
    const cfg = await readCalendarEventsConfig(req.frameArtPath);
    const event = cfg.events[id];
    if (!event) return res.status(404).json({ error: `Event '${id}' not found` });
    if (!event.linked_calendar || !event.linked_uid) {
      return res.status(400).json({ error: 'Event has no linked calendar event' });
    }
    if (!cfg.calendar_entity_id) {
      return res.status(400).json({ error: 'No Frame Art calendar configured.' });
    }

    // Find the linked event in its source calendar
    const scanStart = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString();
    const scanEnd = new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString();
    const result = await haRequest('POST', '/services/calendar/get_events', {
      entity_id: event.linked_calendar,
      start_date_time: scanStart,
      end_date_time: scanEnd,
    });
    const linkedEvents = (result?.[event.linked_calendar]?.events) || [];
    const linked = linkedEvents.find((e) => e.uid === event.linked_uid);

    if (!linked) {
      return res.status(404).json({
        error: 'Linked calendar event not found — it may have been deleted',
        changed: false,
      });
    }

    const newStart = linked.start?.dateTime || linked.start?.date;
    const newEnd = linked.end?.dateTime || linked.end?.date;

    // Get current HA event times to compare
    const faScanResult = await haRequest('POST', '/services/calendar/get_events', {
      entity_id: cfg.calendar_entity_id,
      start_date_time: scanStart,
      end_date_time: scanEnd,
    });
    const faEvents = (faScanResult?.[cfg.calendar_entity_id]?.events) || [];
    const faEvent = faEvents.find((e) => e.uid === event.ha_event_uid);
    const currentStart = faEvent?.start?.dateTime || faEvent?.start?.date;
    const currentEnd = faEvent?.end?.dateTime || faEvent?.end?.date;

    if (newStart === currentStart && newEnd === currentEnd) {
      event.last_synced_at = new Date().toISOString();
      cfg.events[id] = event;
      await writeCalendarEventsConfig(req.frameArtPath, cfg);
      return res.json({ success: true, changed: false });
    }

    // Times differ — delete old HA event, create new one
    await deleteHaCalendarEvent(cfg.calendar_entity_id, event.ha_event_uid);
    const newUid = await createHaCalendarEvent(
      cfg.calendar_entity_id,
      event.tagset_name,
      newStart,
      newEnd,
      event,
    );

    event.ha_event_uid = newUid;
    event.start_date_time = newStart;
    event.end_date_time = newEnd;
    event.last_synced_at = new Date().toISOString();
    cfg.events[id] = event;
    await writeCalendarEventsConfig(req.frameArtPath, cfg);

    res.json({ success: true, changed: true, newStart, newEnd, event });
  } catch (err) {
    console.error('[calendar-events] POST /:id/sync-from-linked: error:', err.message);
    res.status(500).json({ error: 'Failed to sync from linked calendar' });
  }
});

module.exports = router;
