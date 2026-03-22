# Artist Entity Enrichment

This document describes how the add-on automatically enriches artist entity
instances with structured metadata (lifespan, nationality) from external sources.

---

## Overview

The enrichment system fills empty attribute fields on **Creator** (and any other
`kind='artist'`) entity instances. It never overwrites existing content — the
user's own data always wins; enrichment only fills gaps.

Enrichment data is sourced from **Wikidata** (via Q-IDs). Artsy is a placeholder
for a future enricher.

---

## Trigger Points

### 1. Manual link via autocomplete (client-side, immediate)

When a user selects a Wikidata suggestion from the entity autocomplete in the
image modal, the frontend immediately calls:

```
GET /api/artist-suggest/enrich?wikidataId=<Q-ID>
```

and pre-populates the lifespan and nationality fields in the form with a
"suggested" highlight. The user can accept, edit, or clear these values before
saving. This is the primary enrichment path for local library images.

### 2. Manual link via entities route (server-side, on save)

When `POST /api/entities/:entityId/instances` is called with an explicit
`_links` payload (i.e. the user is actively linking an artist), the route
triggers server-side enrichment after the upsert:

1. Calls `enrichArtistInstance(entityType, instance)` from `utils/enrichers/`
2. Wikidata enricher fetches structured data for the stored `wikidataId`
3. `patchEntityInstance()` fills any still-empty attributes

This covers the **Review Unlinked Artists** modal, where the client sends
`_links` but does not do client-side field pre-population.

### 3. Web source shuffle (server-side, fire-and-forget)

Every time `POST /api/web-sources/fetch-and-send` completes successfully, the
`entitySnapshot` built from the source metadata is used to enrich or auto-create
entity instances:

- **Known artist** (instance already exists): `patchEntityInstance()` fills
  any empty attributes from the snapshot (e.g. lifespan/nationality returned
  by Google Arts).
- **Unknown artist** (no matching instance): an async fire-and-forget job
  searches Wikidata for the artist name, validates identity, and — if a
  compatible match is found — creates a new instance with `_links.wikidataId`
  set. The response is not delayed by this work.

The auto-link job fires after every shuffle of an unknown artist. Results are
cached by Wikidata's in-memory cache (`ENRICH_TTL_MS`, default 24h), so
repeated shuffles of the same artist do not re-hit the API.

---

## Identity Validation (web source auto-link)

To avoid linking the wrong person when multiple artists share a name, the
auto-link job compares lifespan years:

1. Extract all 4-digit years from the web source's lifespan string
   (e.g. `"1606 - 1669"` → birth 1606, death 1669).
2. Extract years from the Wikidata candidate's lifespan.
3. If both sources provide a **birth year** and they differ → skip this
   candidate.
4. If both sources provide a **death year** and they differ → skip this
   candidate.
5. Try the next Wikidata candidate (up to 3 results searched).
6. If no compatible candidate is found → no instance is created.

Nationality is **not** used for validation because the formats returned by
different sources are too varied to compare reliably (e.g. "Dutch",
"Netherlands", "NLD").

---

## Known Limitations

### Name-based matching

Entity instances are keyed by a slugified version of the key attribute
(typically `name`). Matching is exact on the slug:

- `"Van Gogh"` → key `van-gogh`
- `"Vincent van Gogh"` → key `vincent-van-gogh`

These are different keys and **will not match each other**. An artist tagged
in the local library as "Van Gogh" will not be patched when a web source
returns "Vincent van Gogh", and vice versa.

### Wikidata search ambiguity

The auto-link job takes the first Wikidata candidate whose lifespan is
compatible. For common names (e.g. "Smith", "Wang") the first result may be
the wrong person even after lifespan validation, because:
- The source doesn't always provide lifespan (validation skipped)
- Two different artists may share birth/death years

For rare or highly specific names this is very unlikely in practice.

### No lifespan → no validation

If the web source does not return lifespan data (either because the source
doesn't have it or the user's field mapping excludes it), lifespan validation
is skipped entirely. The first Wikidata candidate is accepted without
year-based confirmation.

### Fire-and-forget latency

The web source auto-link job is non-blocking. The instance may not exist in
the local library immediately after the shuffle that triggered it — it will
appear on the next page load. If the Wikidata API is slow or unavailable, the
job silently fails and no instance is created.

### Orphan cleanup

Auto-created instances are protected from orphan cleanup **only** because they
have `_links.wikidataId` set. If `_links` is removed (e.g. via explicit
unlink), the instance will be deleted on the next metadata read unless it is
also referenced by at least one local image.

---

## Code Map

| File | Role |
|------|------|
| `utils/enrichers/index.js` | `enrichArtistInstance()` — enrich existing linked instance; `autoLinkArtistFromWebSource()` — create + link unknown artist |
| `utils/enrichers/wikidata_artist.js` | Calls `enrichArtist(wikidataId)` from wikidata.js |
| `utils/wikidata.js` | `suggestArtists()`, `enrichArtist()` — Wikidata API client with in-memory cache |
| `utils/merge.js` | `mergePreferContent()` — shared merge strategy (content wins) |
| `metadata_helper.js` | `patchEntityInstance()` — fill empty attrs only; `upsertEntityInstance()` — create/update with `_links` |
| `routes/entities.js` | Triggers `enrichArtistInstance` after POST instances when `_links` set |
| `routes/web_sources.js` | Triggers patch (known) or `autoLinkArtistFromWebSource` (unknown) after fetch-and-send |
