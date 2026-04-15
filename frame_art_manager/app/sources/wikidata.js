'use strict';

/**
 * Wikidata SPARQL art source.
 *
 * Architecture: QID pool caching.
 *   1. Build a SPARQL query that selects all matching item QIDs for the given filters.
 *   2. Cache up to POOL_MAX_SIZE QIDs per filter combination (TTL: POOL_TTL_MS).
 *   3. For each fetch, pick a random QID from the cached pool.
 *   4. Run a fast single-item detail query (~0.07s) to get metadata + image URL.
 *   5. Download the image from the P18 Special:FilePath URL.
 *
 * This avoids SPARQL OFFSET (which scales linearly and is unusable at large offsets)
 * while still reaching a large, randomised pool of artworks.
 *
 * Filters supported via Wikidata properties:
 *   media      → P31 (instance of): painting, drawing, photograph, sculpture, print, watercolor
 *   movement   → P135 (movement): Impressionism, Baroque, Romanticism, etc.
 *   genre      → P136 (genre): portrait, landscape, still life, etc.
 *   institution→ P195 (collection): Rijksmuseum, Louvre, Met, etc.
 *   century    → P571 (inception) year range
 *   artist     → P170 (creator) resolved from name → QID via wbsearchentities
 *
 * Default (no filters): paintings (P31=Q3305213) with P18 image.
 */

const axios = require('axios');
const sharp = require('sharp');

const SPARQL_ENDPOINT = 'https://query.wikidata.org/sparql';
const ENTITY_API      = 'https://www.wikidata.org/w/api.php';
const USER_AGENT      = 'frame-art-manager/1.0 (home art display system; https://github.com/home-assistant)';

const { thumbSpecialFileParam } = require('../utils/thumbSize');

const POOL_MAX_SIZE      = 10000;
const POOL_TTL_MS        = 6  * 60 * 60 * 1000;   // 6 hours — pool composition shifts slowly

// Shard rotation for large unfiltered queries.
// Without sharding, the pool query returns the same 10K items in QID order every time.
// With sharding, each pool build picks a random slice: QID % SHARD_COUNT = random shard.
// Over (SHARD_COUNT × POOL_TTL_MS) the entire corpus is reachable.
// Only applied when no narrowing filters are active — small filtered pools (< ~500 items)
// would be destroyed by sharding.
const SHARD_COUNT = 40;  // 40 shards × 6hr TTL = full 400K corpus reachable in ~10 days
const CREATOR_CACHE_TTL  = 24 * 60 * 60 * 1000;   // 24 hours — creator QIDs are stable
const MAX_ROUNDS         = 5;
// When aspect ratio filtering is active, most candidates get rejected after image download.
// Classical paintings skew heavily portrait; landscape filter may reject 60-70% of candidates.
// Use a larger candidate window so we find a match without exhausting the pool too often.
const MAX_ASPECT_CANDIDATES = 60;
const SPARQL_TIMEOUT_MS  = 60000;   // pool queries can take up to ~30s for large result sets
const IMAGE_TIMEOUT_MS   = 30000;

// ── Data tables ───────────────────────────────────────────────────────────────

// P31 (instance of) QIDs for supported media types.
// Default (no filter) = Paintings.
const MEDIA_TYPES = [
  { value: 'Paintings',           label: 'Paintings',           qid: 'Q3305213'  },
  { value: 'Drawings',            label: 'Drawings',            qid: 'Q93184'    },
  { value: 'Prints',              label: 'Prints',              qid: 'Q11060274' },
  { value: 'Photographs',         label: 'Photographs',         qid: 'Q125191'   },
  { value: 'Sculptures',          label: 'Sculptures',          qid: 'Q860861'   },
  { value: 'Watercolors',         label: 'Watercolors',         qid: 'Q18761202' },
  { value: 'Miniature paintings', label: 'Miniature paintings', qid: 'Q2647254'  },
];

const DEFAULT_MEDIA_QID = 'Q3305213';  // paintings

// P135 (movement) QIDs.
const MOVEMENTS = [
  { value: 'Baroque',             label: 'Baroque',             qid: 'Q37853'    },
  { value: 'Romanticism',         label: 'Romanticism',         qid: 'Q37068'    },
  { value: 'Realism',             label: 'Realism',             qid: 'Q578597'   },
  { value: 'Impressionism',       label: 'Impressionism',       qid: 'Q40415'    },
  { value: 'Post-Impressionism',  label: 'Post-Impressionism',  qid: 'Q207280'   },
  { value: 'Dutch Golden Age',    label: 'Dutch Golden Age',    qid: 'Q1380327'  },
  { value: 'Renaissance',         label: 'Renaissance',         qid: 'Q4692'     },
  { value: 'Rococo',              label: 'Rococo',              qid: 'Q39979'    },
  { value: 'Neoclassicism',       label: 'Neoclassicism',       qid: 'Q33216'    },
  { value: 'Mannerism',           label: 'Mannerism',           qid: 'Q1640824'  },
  { value: 'Symbolism',           label: 'Symbolism',           qid: 'Q42196'    },
  { value: 'Art Nouveau',         label: 'Art Nouveau',         qid: 'Q34636'    },
  { value: 'Expressionism',       label: 'Expressionism',       qid: 'Q80113'    },
  { value: 'Fauvism',             label: 'Fauvism',             qid: 'Q153178'   },
  { value: 'Cubism',              label: 'Cubism',              qid: 'Q36534'    },
  { value: 'Futurism',            label: 'Futurism',            qid: 'Q47041'    },
  { value: 'Surrealism',          label: 'Surrealism',          qid: 'Q39427'    },
  { value: 'Abstract art',        label: 'Abstract art',        qid: 'Q128115'   },
  { value: 'Pre-Raphaelitism',    label: 'Pre-Raphaelitism',    qid: 'Q182719'   },
  { value: 'Japonisme',           label: 'Japonisme',           qid: 'Q130277'   },
];

// P136 (genre) QIDs.
const GENRES = [
  { value: 'Portrait',            label: 'Portrait',            qid: 'Q134307'   },
  { value: 'Self-portrait',       label: 'Self-portrait',       qid: 'Q192110'   },
  { value: 'Landscape',           label: 'Landscape',           qid: 'Q191163'   },
  { value: 'Still life',          label: 'Still life',          qid: 'Q170571'   },
  { value: 'History painting',    label: 'History painting',    qid: 'Q1057740'  },
  { value: 'Genre painting',      label: 'Genre painting',      qid: 'Q1047337'  },
  { value: 'Religious art',       label: 'Religious art',       qid: 'Q2864737'  },
  { value: 'Mythological',        label: 'Mythological',        qid: 'Q3375868'  },
  { value: 'Nude',                label: 'Nude',                qid: 'Q40446'    },
  { value: 'Animal painting',     label: 'Animal painting',     qid: 'Q16878234' },
  { value: 'Marine art',          label: 'Marine art',          qid: 'Q158607'   },
];

// P195 (collection) QIDs — where the work is held.
const INSTITUTIONS = [
  { value: 'Rijksmuseum',                label: 'Rijksmuseum',                qid: 'Q190804' },
  { value: 'Louvre',                     label: 'Louvre',                     qid: 'Q19675'  },
  { value: 'Hermitage',                  label: 'Hermitage Museum',           qid: 'Q132783' },
  { value: 'Metropolitan Museum of Art', label: 'Metropolitan Museum of Art', qid: 'Q160236' },
  { value: 'Uffizi',                     label: 'Uffizi',                     qid: 'Q51252'  },
  { value: 'Prado',                      label: 'Prado',                      qid: 'Q160112' },
  { value: 'National Gallery London',    label: 'National Gallery (London)',  qid: 'Q180788' },
  { value: 'Getty Museum',               label: 'Getty Museum',               qid: 'Q731126' },
  { value: 'Art Institute of Chicago',   label: 'Art Institute of Chicago',   qid: 'Q239303' },
  { value: 'British Museum',             label: 'British Museum',             qid: 'Q6373'   },
  { value: 'Museum of Fine Arts Boston', label: 'Museum of Fine Arts Boston', qid: 'Q49133'  },
  { value: 'Victoria and Albert Museum', label: 'Victoria and Albert Museum', qid: 'Q213322' },
  { value: 'National Gallery of Art',    label: 'National Gallery of Art',    qid: 'Q214867' },
  { value: 'Musée d\'Orsay',            label: "Musée d'Orsay",              qid: 'Q23402'  },
  { value: 'Tate',                       label: 'Tate',                       qid: 'Q193375' },
  { value: 'Smithsonian',                label: 'Smithsonian Institution',    qid: 'Q131626' },
];

// P571 (inception) year ranges by century.
const CENTURIES = [
  { value: '13th century', label: '13th century', startYear: 1200, endYear: 1299 },
  { value: '14th century', label: '14th century', startYear: 1300, endYear: 1399 },
  { value: '15th century', label: '15th century', startYear: 1400, endYear: 1499 },
  { value: '16th century', label: '16th century', startYear: 1500, endYear: 1599 },
  { value: '17th century', label: '17th century', startYear: 1600, endYear: 1699 },
  { value: '18th century', label: '18th century', startYear: 1700, endYear: 1799 },
  { value: '19th century', label: '19th century', startYear: 1800, endYear: 1899 },
  { value: '20th century', label: '20th century', startYear: 1900, endYear: 1999 },
  { value: '21st century', label: '21st century', startYear: 2000, endYear: 2099 },
];

// ── Caches ─────────────────────────────────────────────────────────────────────

// QID pool cache: filterKey → { qids: string[], expiresAt: number }
const poolCache   = new Map();
// Creator name→QID: normalised name → { qid: string, expiresAt: number }
const creatorCache = new Map();

// ── Helpers ────────────────────────────────────────────────────────────────────

function getRequireValues(filters, type) {
  return filters
    .filter(f => f.type === type && f.mode === 'require')
    .flatMap(f => f.values || []);
}

/**
 * Deterministic cache key for a set of filters + resolved creator QID.
 * Sorted so order-independent filter arrays produce the same key.
 */
function poolCacheKey(filters, creatorQid) {
  const entries = filters.map(f => `${f.type}:${f.mode}:${(f.values || []).slice().sort().join(',')}`);
  entries.sort();
  if (creatorQid) entries.push(`creator:${creatorQid}`);
  return entries.join('|');
}

/**
 * Execute a SPARQL query against Wikidata and return the result bindings array.
 * Uses POST to avoid URL length limits on complex queries.
 */
async function sparqlQuery(query, timeoutMs = SPARQL_TIMEOUT_MS) {
  let response;
  try {
    response = await axios.post(SPARQL_ENDPOINT, new URLSearchParams({ query }), {
      headers: {
        'User-Agent':   USER_AGENT,
        'Accept':       'application/sparql-results+json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      timeout: timeoutMs,
    });
  } catch (err) {
    // Log the query on 400 to aid diagnosis.
    if (err.response?.status === 400) {
      console.error(`[wikidata] SPARQL 400 — query was:\n${query}`);
    }
    throw err;
  }
  return response.data.results?.bindings ?? [];
}

/**
 * Resolve an artist name to a Wikidata QID using the wbsearchentities API.
 * Returns the first result, which is typically the most prominent match.
 * Results are cached for 24 hours.
 */
async function resolveCreatorQid(name) {
  const key = name.toLowerCase().trim();
  const cached = creatorCache.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.qid;

  try {
    const response = await axios.get(ENTITY_API, {
      params: {
        action:   'wbsearchentities',
        search:   name,
        type:     'item',
        language: 'en',
        limit:    5,
        format:   'json',
        origin:   '*',
      },
      headers: { 'User-Agent': USER_AGENT },
      timeout: 10000,
    });

    const results = response.data.search || [];
    // Prefer results whose description suggests they are human creators.
    const CREATOR_KEYWORDS = ['painter', 'artist', 'sculptor', 'photographer', 'printmaker', 'illustrator', 'draughtsman', 'engraver'];
    let qid = null;
    for (const r of results) {
      const desc = (r.description || '').toLowerCase();
      if (CREATOR_KEYWORDS.some(k => desc.includes(k))) {
        qid = r.id;
        break;
      }
    }
    // Fallback: take first result if none matched creator keywords.
    if (!qid && results.length > 0) qid = results[0].id;

    if (qid) {
      creatorCache.set(key, { qid, expiresAt: Date.now() + CREATOR_CACHE_TTL });
      return qid;
    }
  } catch (err) {
    console.warn(`[wikidata] Could not resolve creator QID for "${name}": ${err.message}`);
  }
  return null;
}

/**
 * Returns true when the filter set is broad enough that QID sharding is needed.
 * Sharding is skipped for filtered queries — small pools (e.g. Impressionism, ~466 items)
 * would be decimated by a modulus filter, returning only ~12 items per shard.
 */
function shouldShard(filters, creatorQid) {
  if (creatorQid) return false;
  const narrowing = ['movement', 'genre', 'institution', 'century'];
  return narrowing.every(type => getRequireValues(filters, type).length === 0);
}

/**
 * Build a SPARQL pool query that selects up to POOL_MAX_SIZE QIDs matching the filters.
 *
 * The query includes only ?item in the SELECT so the response is as compact as possible —
 * SPARQL label service and string manipulation are deferred to the fast per-item detail query.
 *
 * For large unfiltered queries, a random shard filter (QID % SHARD_COUNT = shard) is injected
 * so each pool build returns a different slice of the corpus. Pass shard=null to disable.
 */
function buildPoolQuery(filters, creatorQid, shard = null) {
  const mediaRequired  = getRequireValues(filters, 'media');
  const movements      = getRequireValues(filters, 'movement');
  const genres         = getRequireValues(filters, 'genre');
  const institutions   = getRequireValues(filters, 'institution');
  const centuries      = getRequireValues(filters, 'century');

  const mediaQids = mediaRequired.length > 0
    ? mediaRequired.map(v => MEDIA_TYPES.find(m => m.value === v)?.qid).filter(Boolean)
    : [DEFAULT_MEDIA_QID];

  const lines = ['SELECT DISTINCT ?item WHERE {'];

  // Media type (P31): painting, photograph, etc.
  if (mediaQids.length === 1) {
    lines.push(`  ?item wdt:P31 wd:${mediaQids[0]} ;`);
    lines.push(`        wdt:P18 [] .`);
  } else {
    lines.push(`  VALUES ?mediaType { ${mediaQids.map(q => `wd:${q}`).join(' ')} }`);
    lines.push(`  ?item wdt:P31 ?mediaType ;`);
    lines.push(`        wdt:P18 [] .`);
  }

  // Art movement (P135)
  if (movements.length > 0) {
    const qids = movements.map(v => MOVEMENTS.find(m => m.value === v)?.qid).filter(Boolean);
    if (qids.length === 1) {
      lines.push(`  ?item wdt:P135 wd:${qids[0]} .`);
    } else if (qids.length > 1) {
      lines.push(`  VALUES ?movement { ${qids.map(q => `wd:${q}`).join(' ')} }`);
      lines.push(`  ?item wdt:P135 ?movement .`);
    }
  }

  // Genre (P136)
  if (genres.length > 0) {
    const qids = genres.map(v => GENRES.find(g => g.value === v)?.qid).filter(Boolean);
    if (qids.length === 1) {
      lines.push(`  ?item wdt:P136 wd:${qids[0]} .`);
    } else if (qids.length > 1) {
      lines.push(`  VALUES ?genre { ${qids.map(q => `wd:${q}`).join(' ')} }`);
      lines.push(`  ?item wdt:P136 ?genre .`);
    }
  }

  // Collection (P195)
  if (institutions.length > 0) {
    const qids = institutions.map(v => INSTITUTIONS.find(i => i.value === v)?.qid).filter(Boolean);
    if (qids.length === 1) {
      lines.push(`  ?item wdt:P195 wd:${qids[0]} .`);
    } else if (qids.length > 1) {
      lines.push(`  VALUES ?inst { ${qids.map(q => `wd:${q}`).join(' ')} }`);
      lines.push(`  ?item wdt:P195 ?inst .`);
    }
  }

  // Creator (P170) — resolved from artist name
  if (creatorQid) {
    lines.push(`  ?item wdt:P170 wd:${creatorQid} .`);
  }

  // Inception date range (P571) — one or more century ranges OR'd together
  if (centuries.length > 0) {
    const ranges = centuries
      .map(v => CENTURIES.find(c => c.value === v))
      .filter(Boolean);
    if (ranges.length > 0) {
      lines.push(`  ?item wdt:P571 ?date .`);
      const parts = ranges.map(({ startYear, endYear }) =>
        `(YEAR(?date) >= ${startYear} && YEAR(?date) <= ${endYear})`
      );
      lines.push(`  FILTER(${parts.join(' || ')})`);
    }
  }

  // Shard filter: restrict to items whose QID numeric part falls in the chosen shard.
  // This rotates which slice of the corpus is returned on each pool rebuild.
  // SUBSTR(STR(?item), 33) extracts the numeric suffix: the Wikidata entity URI is
  // "http://www.wikidata.org/entity/Q<number>" — Q is at position 32, digits at 33+.
  // SPARQL has no % operator; modulo is expressed as: x - FLOOR(x/n)*n.
  if (shard !== null) {
    lines.push(`  BIND(xsd:integer(SUBSTR(STR(?item), 33)) AS ?_qnum)`);
    lines.push(`  FILTER((?_qnum - FLOOR(?_qnum / ${SHARD_COUNT}) * ${SHARD_COUNT}) = ${shard})`);
  }

  lines.push('}');
  lines.push(`LIMIT ${POOL_MAX_SIZE}`);
  return lines.join('\n');
}

/**
 * Build a fast detail query for a single item QID.
 * Returns metadata: title, creator, date, movement, genre, collection, image URL.
 * May return multiple rows if an item has multiple creators/movements/genres/collections —
 * the caller takes first non-null value for each field.
 */
/**
 * Fetch item detail via the MediaWiki action API (wbgetentities) instead of SPARQL.
 *
 * Motivation: the SPARQL detail query (which ran on every fetch) hit Blazegraph
 * under variable load — cache hit ~3s, cache miss up to 45s. wbgetentities is a
 * direct database lookup: ~300-500ms consistently regardless of server load.
 *
 * Two requests:
 *   1. Item claims + label (all properties in one call).
 *   2. Batch label lookup for linked entities (creator, movement, genre,
 *      collection, material) — combined into a single request.
 *
 * Returns: { imageUrl, title, creator, dateRaw, movement, genre, collection,
 *            medium, height, width } — all nullable strings.
 */
async function fetchItemDetail(qid) {
  // ── Request 1: item claims + en label ─────────────────────────────────────
  const itemResp = await axios.get(ENTITY_API, {
    params: {
      action:           'wbgetentities',
      ids:              qid,
      format:           'json',
      props:            'claims|labels',
      languages:        'en',
      languagefallback:  1,
    },
    headers: { 'User-Agent': USER_AGENT },
    timeout: 10000,
  });

  const entity = itemResp.data.entities?.[qid];
  if (!entity || entity.missing === '') return null;

  const title        = entity.labels?.en?.value || null;
  const claims       = entity.claims || {};

  // P18 → Wikimedia Commons Special:FilePath URL
  const imageFile    = claims.P18?.[0]?.mainsnak?.datavalue?.value;
  const imageUrl     = imageFile
    ? `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURI(imageFile.trim().replace(/ /g, '_'))}`
    : null;

  // Extract QIDs for linked entities that need label resolution.
  const creatorQid    = claims.P170?.[0]?.mainsnak?.datavalue?.value?.id   || null;
  const movementQid   = claims.P135?.[0]?.mainsnak?.datavalue?.value?.id   || null;
  const genreQid      = claims.P136?.[0]?.mainsnak?.datavalue?.value?.id   || null;
  const collectionQid = (claims.P195 ?? claims.P276)?.[0]?.mainsnak?.datavalue?.value?.id || null;
  const materialQid   = claims.P186?.[0]?.mainsnak?.datavalue?.value?.id   || null;

  // P571 (inception) time string e.g. "+1889-06-07T00:00:00Z"
  const dateRaw      = claims.P571?.[0]?.mainsnak?.datavalue?.value?.time  || null;

  // P2048/P2049 amount strings e.g. "+73.7"
  const heightRaw    = claims.P2048?.[0]?.mainsnak?.datavalue?.value?.amount || null;
  const widthRaw     = claims.P2049?.[0]?.mainsnak?.datavalue?.value?.amount || null;
  const height       = heightRaw ? heightRaw.replace(/^\+/, '') : null;
  const width        = widthRaw  ? widthRaw.replace(/^\+/, '')  : null;

  // ── Request 2: batch-resolve linked-entity labels ─────────────────────────
  const labelQids = [creatorQid, movementQid, genreQid, collectionQid, materialQid].filter(Boolean);
  const labelMap  = {};

  if (labelQids.length > 0) {
    const labelResp = await axios.get(ENTITY_API, {
      params: {
        action:           'wbgetentities',
        ids:              labelQids.join('|'),
        format:           'json',
        props:            'labels',
        languages:        'en',
        languagefallback:  1,
      },
      headers: { 'User-Agent': USER_AGENT },
      timeout: 10000,
    });
    for (const [id, ent] of Object.entries(labelResp.data.entities || {})) {
      labelMap[id] = ent.labels?.en?.value || null;
    }
  }

  return {
    imageUrl,
    title,
    creator:    creatorQid    ? labelMap[creatorQid]    : null,
    dateRaw,
    movement:   movementQid   ? labelMap[movementQid]   : null,
    genre:      genreQid      ? labelMap[genreQid]      : null,
    collection: collectionQid ? labelMap[collectionQid] : null,
    medium:     materialQid   ? labelMap[materialQid]   : null,
    height,
    width,
  };
}

/**
 * Fetch original image dimensions from the Wikimedia Commons imageinfo API.
 * Returns { width, height } or null on failure.
 * This is a lightweight metadata-only call (~200ms) — no image body is downloaded.
 * Used to prescreen aspect ratio before committing to a full thumbnail download.
 */
async function fetchCommonsImageDimensions(filename) {
  try {
    const resp = await axios.get('https://commons.wikimedia.org/w/api.php', {
      params: {
        action:  'query',
        prop:    'imageinfo',
        iiprop:  'size',
        titles:  `File:${filename}`,
        format:  'json',
      },
      headers: { 'User-Agent': USER_AGENT },
      timeout: 5000,
    });
    const pages = resp.data?.query?.pages || {};
    const page  = Object.values(pages)[0];
    const info  = page?.imageinfo?.[0];
    return info ? { width: info.width, height: info.height } : null;
  } catch (err) {
    return null;  // graceful degradation — caller falls through to download
  }
}

/**
 * Batch-fetch item claims + labels for multiple QIDs in groups of 50.
 * Returns a Map of qid → entity object (the raw API entity, with .claims and .labels).
 * Used to prescreen candidates before committing to individual detail fetches.
 */
async function batchFetchItemClaims(qids) {
  const BATCH = 50;
  const entityMap = new Map();
  for (let i = 0; i < qids.length; i += BATCH) {
    const batch = qids.slice(i, i + BATCH);
    try {
      const resp = await axios.get(ENTITY_API, {
        params: {
          action:           'wbgetentities',
          ids:              batch.join('|'),
          format:           'json',
          props:            'claims|labels',
          languages:        'en',
          languagefallback:  1,
        },
        headers: { 'User-Agent': USER_AGENT },
        timeout: 15000,
      });
      for (const [id, entity] of Object.entries(resp.data.entities || {})) {
        if (!entity.missing) entityMap.set(id, entity);
      }
    } catch (err) {
      console.warn(`[wikidata] Batch claims fetch failed (batch ${i}–${i + batch.length - 1}): ${err.message}`);
    }
  }
  return entityMap;
}

/**
 * Batch-fetch image dimensions from Wikimedia Commons imageinfo for multiple files.
 * Sends groups of 50 filenames per request.
 * Returns a Map of normalizedFilename → { width, height }.
 *
 * Key normalization: spaces→underscores, matching what we store in candidatesWithImages.
 */
async function batchFetchCommonsImageDimensions(filenames) {
  const BATCH = 50;
  const dimMap = new Map();
  const unique = [...new Set(filenames)];
  for (let i = 0; i < unique.length; i += BATCH) {
    const batch = unique.slice(i, i + BATCH);
    try {
      const resp = await axios.get('https://commons.wikimedia.org/w/api.php', {
        params: {
          action: 'query',
          prop:   'imageinfo',
          iiprop: 'size',
          titles: batch.map(fn => `File:${fn}`).join('|'),
          format: 'json',
        },
        headers: { 'User-Agent': USER_AGENT },
        timeout: 10000,
      });
      for (const page of Object.values(resp.data?.query?.pages || {})) {
        const info = page?.imageinfo?.[0];
        if (info) {
          // Strip "File:" prefix and normalize spaces→underscores to match the key we store.
          const key = (page.title || '').replace(/^File:/, '').replace(/ /g, '_');
          dimMap.set(key, { width: info.width, height: info.height });
        }
      }
    } catch (err) {
      console.warn(`[wikidata] Batch Commons imageinfo failed (batch ${i}–${i + batch.length - 1}): ${err.message}`);
    }
  }
  return dimMap;
}

/**
 * Fetch or return cached QID pool for the given filter combination.
 * Pool is refreshed after POOL_TTL_MS.
 *
 * For large unfiltered queries, a random shard is picked on each cache miss so successive
 * pool builds cover different slices of the full corpus. The shard is stored alongside
 * the pool and reused until the TTL expires (so fetches within a 6h window all draw from
 * the same slice, then rotate to a new random slice on the next rebuild).
 */
async function getPool(filters, creatorQid) {
  const key    = poolCacheKey(filters, creatorQid);
  const cached = poolCache.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.qids;

  const useSharding = shouldShard(filters, creatorQid);

  // When sharding, retry up to SHARD_COUNT times with different shards.
  // Individual shards can be empty for narrow filters (e.g. landscape paintings
  // in a specific period), so we keep trying until we find a non-empty shard.
  const maxAttempts = useSharding ? Math.min(SHARD_COUNT, 5) : 1;
  const triedShards = new Set();
  let qids = [];

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let shard = null;
    if (useSharding) {
      do { shard = Math.floor(Math.random() * SHARD_COUNT); } while (triedShards.has(shard));
      triedShards.add(shard);
    }

    const query = buildPoolQuery(filters, creatorQid, shard);
    const shardLabel = shard !== null ? ` shard ${shard}/${SHARD_COUNT}` : '';
    console.log(`[wikidata] Fetching QID pool${shardLabel} (key: ${key.slice(0, 80)}...)`);
    const bindings = await sparqlQuery(query, SPARQL_TIMEOUT_MS);

    qids = bindings
      .map(b => b.item?.value?.replace('http://www.wikidata.org/entity/', ''))
      .filter(Boolean);

    if (qids.length > 0) break;
    if (attempt < maxAttempts - 1) {
      console.log(`[wikidata] Shard ${shard} returned 0 items — retrying with different shard`);
    }
  }

  if (qids.length === 0) throw new Error('Wikidata returned no items for the current filters');

  poolCache.set(key, { qids, expiresAt: Date.now() + POOL_TTL_MS });
  console.log(`[wikidata] Pool cached: ${qids.length} QIDs for "${key.slice(0, 80)}"`);
  return qids;
}

/**
 * Format a SPARQL date value (xsd:dateTime like "1889-06-07T00:00:00Z") to a year or full date.
 */
function formatDate(dateStr) {
  if (!dateStr) return null;
  // wbgetentities time values have a leading "+"; strip before parsing.
  const match = dateStr.replace(/^\+/, '').match(/^(-?\d{1,4})/);
  return match ? match[1] : null;
}

/**
 * Format artwork dimensions from Wikidata P2048 (height) and P2049 (width).
 * Both values are numeric, assumed to be in centimetres.
 */
function formatDimensions(height, width) {
  const h = height ? parseFloat(height) : null;
  const w = width  ? parseFloat(width)  : null;
  if (w && h) return `${w.toFixed(1)} × ${h.toFixed(1)} cm`;
  if (h) return `${h.toFixed(1)} cm (height)`;
  if (w) return `${w.toFixed(1)} cm (width)`;
  return null;
}

// ── fetchRandomArtwork ─────────────────────────────────────────────────────────

/**
 * Fetch a random artwork from Wikidata.
 *
 * @param {Array<{type, mode, values}>} [filters=[]]
 * @param {object} [options]
 * @param {'all'|'landscape'|'portrait'} [options.aspectRatio='all']
 * @param {string} [options.sourceLabel='Wikidata']
 * @param {Array} [options.preFilters=[]]
 * @param {boolean} [options.skipLowRes=false]
 * @param {number} [options.minResolution=1080]
 * @returns {{ imageBuffer, contentType, metadata }}
 */
async function fetchRandomArtwork(filters = [], options = {}) {
  const { aspectRatio = 'all', sourceLabel = 'Wikidata', preFilters = [],
          skipLowRes = false, minResolution = 1080 } = options;
  const allFilters = [...preFilters, ...filters];

  const searchKeyword = getRequireValues(allFilters, 'search')[0] || null;

  // How many candidates to evaluate before giving up.
  // With aspect ratio filtering, most candidates may be rejected post-download
  // (classical paintings skew portrait). A larger window prevents spurious failures.
  const maxCandidates = aspectRatio !== 'all' ? MAX_ASPECT_CANDIDATES : MAX_ROUNDS * 3;

  let candidates;
  if (searchKeyword) {
    // Keyword search — bypass pool; use mwapi SPARQL search.
    // Structural filters (movement, century, etc.) are applied in the SPARQL query.
    candidates = await getSearchCandidates(searchKeyword, allFilters);
    candidates = candidates.slice(0, maxCandidates);
  } else {
    // Resolve artist filter to a Wikidata QID.
    const artistName = getRequireValues(allFilters, 'artist')[0] || null;
    let creatorQid   = null;
    if (artistName) {
      creatorQid = await resolveCreatorQid(artistName);
      if (!creatorQid) {
        console.warn(`[wikidata] Could not resolve artist "${artistName}" to a QID — ignoring artist filter`);
      }
    }

    // Get (or build) the QID pool for this filter combination.
    const pool = await getPool(allFilters, creatorQid);
    candidates = [...pool].sort(() => Math.random() - 0.5).slice(0, maxCandidates);
  }

  const needsPrescreen = aspectRatio !== 'all' || skipLowRes;
  const sizeParam = thumbSpecialFileParam(aspectRatio === 'portrait' ? 'portrait' : 'landscape');

  // ── Batch prescreen path ──────────────────────────────────────────────────
  // When orientation or low-res filtering is active, classical paintings skew heavily
  // portrait — checking 60 candidates sequentially (2 API calls + 200ms Commons per item)
  // takes 4+ minutes in the worst case.  Instead: batch-fetch all claims and all Commons
  // dimensions upfront (2–3 total API calls), then download only the first candidate that
  // passes the filter.  Total time: ~3s instead of 4+ minutes.
  if (needsPrescreen) {
    // Phase 1: Batch-fetch claims for all candidates (groups of 50).
    const entityMap = await batchFetchItemClaims(candidates);

    // Extract image filenames from P18 for candidates that have an image.
    const withImages = candidates.flatMap(qid => {
      const entity = entityMap.get(qid);
      if (!entity) return [];
      const imageFile = entity.claims?.P18?.[0]?.mainsnak?.datavalue?.value;
      if (!imageFile) {
        console.warn(`[wikidata] ${qid}: no image URL`);
        return [];
      }
      // Normalize spaces→underscores to match Commons page titles.
      const filename = imageFile.trim().replace(/ /g, '_');
      return [{ qid, entity, filename }];
    });

    // Phase 2: Batch-fetch Commons dimensions for all filenames (groups of 50).
    const dimMap = await batchFetchCommonsImageDimensions(withImages.map(c => c.filename));

    // Phase 3: Filter by orientation and resolution.
    const prescreened = withImages.filter(({ qid, filename }) => {
      const dims = dimMap.get(filename);
      if (!dims) return true; // no dims → let through to post-download check

      if (aspectRatio !== 'all') {
        const isLandscape = dims.width > dims.height;
        if (aspectRatio === 'landscape' && !isLandscape) {
          console.warn(`[wikidata] ${qid} prescreened out: not landscape (${dims.width}x${dims.height})`);
          return false;
        }
        if (aspectRatio === 'portrait' && isLandscape) {
          console.warn(`[wikidata] ${qid} prescreened out: not portrait (${dims.width}x${dims.height})`);
          return false;
        }
      }
      if (skipLowRes) {
        const shortSide = Math.min(dims.width, dims.height);
        if (shortSide < minResolution) {
          console.warn(`[wikidata] ${qid} prescreened out: low-res (${dims.width}x${dims.height}, short side ${shortSide} < ${minResolution})`);
          return false;
        }
      }
      return true;
    });

    // Phase 4: Download prescreened candidates sequentially until one works.
    for (const { qid, entity } of prescreened) {
      const imageFile = entity.claims?.P18?.[0]?.mainsnak?.datavalue?.value;
      const imageUrl  = `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURI(imageFile.trim().replace(/ /g, '_'))}`;
      const thumbUrl  = `${imageUrl}?${sizeParam}`;
      let imageBuffer, contentType;
      try {
        const resp = await axios.get(thumbUrl, {
          responseType: 'arraybuffer',
          timeout:      IMAGE_TIMEOUT_MS,
          headers:      { 'User-Agent': USER_AGENT },
          maxRedirects: 5,
        });
        imageBuffer = Buffer.from(resp.data);
        contentType = resp.headers['content-type'] || 'image/jpeg';
      } catch (err) {
        console.warn(`[wikidata] Image download failed for ${qid}: ${err.message}`);
        continue;
      }

      if (contentType.includes('svg') || !contentType.startsWith('image/')) {
        console.warn(`[wikidata] ${qid} skipped: unsupported content-type ${contentType}`);
        continue;
      }

      // Post-download orientation check — catches any prescreening misses.
      if (aspectRatio !== 'all') {
        try {
          const { width, height } = await sharp(imageBuffer).metadata();
          const isLandscape = width > height;
          if (aspectRatio === 'landscape' && !isLandscape) {
            console.warn(`[wikidata] ${qid} skipped post-download: not landscape (${width}x${height})`);
            continue;
          }
          if (aspectRatio === 'portrait' && isLandscape) {
            console.warn(`[wikidata] ${qid} skipped post-download: not portrait (${width}x${height})`);
            continue;
          }
        } catch (err) {
          console.warn(`[wikidata] ${qid}: could not read dimensions: ${err.message}`);
          continue;
        }
      }

      // Winner found — fetch full metadata (labels for linked entities) for this item only.
      let detail;
      try {
        detail = await fetchItemDetail(qid);
      } catch (err) {
        console.warn(`[wikidata] Detail fetch failed for winner ${qid}: ${err.message}`);
        // Fall back to what we already have from the batch claims fetch.
        const title = entity.labels?.en?.value || null;
        detail = { imageUrl, title, creator: null, medium: null, dateRaw: null,
                   movement: null, genre: null, collection: null, height: null, width: null };
      }

      return {
        imageBuffer,
        contentType,
        metadata: {
          title:       detail.title,
          creator:     detail.creator,
          medium:      detail.medium,
          dimensions:  formatDimensions(detail.height, detail.width),
          dateCreated: formatDate(detail.dateRaw),
          artworkUrl:  `https://www.wikidata.org/wiki/${qid}`,
          source:      sourceLabel,
          movement:    detail.movement,
          genre:       detail.genre,
          collection:  detail.collection,
        },
      };
    }
  } else {
    // ── Sequential path (no prescreen needed) ──────────────────────────────
    for (const qid of candidates) {
      // Fetch item detail via wbgetentities (two REST calls, ~1s total vs 3-45s SPARQL).
      let detail;
      try {
        detail = await fetchItemDetail(qid);
      } catch (err) {
        console.warn(`[wikidata] Detail fetch failed for ${qid}: ${err.message}`);
        continue;
      }
      if (!detail?.imageUrl) {
        console.warn(`[wikidata] ${qid}: no image URL`);
        continue;
      }

      // Download a thumbnail rather than the full-res original.
      // Special:FilePath?width=N (landscape) or ?height=N (portrait) redirects to a JPEG thumb
      // at that long-edge size. Originals can be 50–100 MB TIFFs; ~4608px is sufficient for 4K output.
      const thumbUrl = detail.imageUrl.includes('?')
        ? `${detail.imageUrl}&${sizeParam}`
        : `${detail.imageUrl}?${sizeParam}`;
      let imageBuffer, contentType;
      try {
        const resp = await axios.get(thumbUrl, {
          responseType: 'arraybuffer',
          timeout:      IMAGE_TIMEOUT_MS,
          headers:      { 'User-Agent': USER_AGENT },
          maxRedirects: 5,
        });
        imageBuffer = Buffer.from(resp.data);
        contentType = resp.headers['content-type'] || 'image/jpeg';
      } catch (err) {
        console.warn(`[wikidata] Image download failed for ${qid}: ${err.message}`);
        continue;
      }

      if (contentType.includes('svg') || !contentType.startsWith('image/')) {
        console.warn(`[wikidata] ${qid} skipped: unsupported content-type ${contentType}`);
        continue;
      }

      return {
        imageBuffer,
        contentType,
        metadata: {
          title:       detail.title,
          creator:     detail.creator,
          medium:      detail.medium,
          dimensions:  formatDimensions(detail.height, detail.width),
          dateCreated: formatDate(detail.dateRaw),
          artworkUrl:  `https://www.wikidata.org/wiki/${qid}`,
          source:      sourceLabel,
          movement:    detail.movement,
          genre:       detail.genre,
          collection:  detail.collection,
        },
      };
    }
  }

  throw new Error(
    `Could not find a suitable${aspectRatio !== 'all' ? ` ${aspectRatio}` : ''} ` +
    `artwork from Wikidata after trying ${Math.min(candidates.length, MAX_ROUNDS * 3)} candidates`
  );
}

// ── searchPreview + keyword search helpers ────────────────────────────────────

/**
 * Build SPARQL filter clauses from structural filters (media, movement, genre,
 * institution, century) for use inside a search query. Returns an array of
 * SPARQL triple/filter lines to inject into a WHERE block.
 *
 * Note: Wikidata descriptions are brief ("painting by Claude Monet, 1890"),
 * not rich curatorial text. The mwapi search indexes labels AND descriptions,
 * so artist names and artwork titles embedded in descriptions are searchable,
 * but subject/content queries ("bridge at sunset") won't match.
 */
function buildStructuralFilterLines(filters) {
  const lines = [];

  const mediaRequired = getRequireValues(filters, 'media');
  const movements     = getRequireValues(filters, 'movement');
  const genres        = getRequireValues(filters, 'genre');
  const institutions  = getRequireValues(filters, 'institution');
  const centuries     = getRequireValues(filters, 'century');

  // Media type (P31)
  if (mediaRequired.length > 0) {
    const qids = mediaRequired.map(v => MEDIA_TYPES.find(m => m.value === v)?.qid).filter(Boolean);
    if (qids.length === 1) {
      lines.push(`  ?item wdt:P31 wd:${qids[0]}.`);
    } else if (qids.length > 1) {
      lines.push(`  VALUES ?mediaType { ${qids.map(q => `wd:${q}`).join(' ')} }`);
      lines.push(`  ?item wdt:P31 ?mediaType.`);
    }
  }

  // Movement (P135)
  if (movements.length > 0) {
    const qids = movements.map(v => MOVEMENTS.find(m => m.value === v)?.qid).filter(Boolean);
    if (qids.length === 1) lines.push(`  ?item wdt:P135 wd:${qids[0]}.`);
    else if (qids.length > 1) {
      lines.push(`  VALUES ?movement { ${qids.map(q => `wd:${q}`).join(' ')} }`);
      lines.push(`  ?item wdt:P135 ?movement.`);
    }
  }

  // Genre (P136)
  if (genres.length > 0) {
    const qids = genres.map(v => GENRES.find(g => g.value === v)?.qid).filter(Boolean);
    if (qids.length === 1) lines.push(`  ?item wdt:P136 wd:${qids[0]}.`);
    else if (qids.length > 1) {
      lines.push(`  VALUES ?genre { ${qids.map(q => `wd:${q}`).join(' ')} }`);
      lines.push(`  ?item wdt:P136 ?genre.`);
    }
  }

  // Institution (P195)
  if (institutions.length > 0) {
    const qids = institutions.map(v => INSTITUTIONS.find(i => i.value === v)?.qid).filter(Boolean);
    if (qids.length === 1) lines.push(`  ?item wdt:P195 wd:${qids[0]}.`);
    else if (qids.length > 1) {
      lines.push(`  VALUES ?inst { ${qids.map(q => `wd:${q}`).join(' ')} }`);
      lines.push(`  ?item wdt:P195 ?inst.`);
    }
  }

  // Century (P571 inception year range)
  if (centuries.length > 0) {
    const ranges = centuries.map(v => CENTURIES.find(c => c.value === v)).filter(Boolean);
    if (ranges.length > 0) {
      lines.push(`  ?item wdt:P571 ?date.`);
      const parts = ranges.map(({ startYear, endYear }) =>
        `(YEAR(?date) >= ${startYear} && YEAR(?date) <= ${endYear})`
      );
      lines.push(`  FILTER(${parts.join(' || ')})`);
    }
  }

  return lines;
}

/**
 * Build and execute a SPARQL search query using the mwapi Search service.
 * Searches the MediaWiki full-text index (labels + descriptions + aliases),
 * applies structural filters, requires P18 image.
 *
 * Returns a shuffled array of QID strings.
 */
async function getSearchCandidates(keyword, filters = []) {
  const structuralLines = buildStructuralFilterLines(filters);

  const query = [
    'SELECT DISTINCT ?item WHERE {',
    '  SERVICE wikibase:mwapi {',
    '    bd:serviceParam wikibase:endpoint "www.wikidata.org";',
    '                    wikibase:api "Search";',
    `                    mwapi:srsearch ${JSON.stringify(keyword)};`,
    '                    mwapi:language "en";',
    '                    mwapi:limit "100".',
    '    ?item wikibase:apiOutputItem mwapi:title.',
    '  }',
    '  ?item wdt:P18 [].',
    ...structuralLines,
    '}',
    'LIMIT 50',
  ].join('\n');

  const bindings = await sparqlQuery(query, 30000);
  const qids = bindings
    .map(b => b.item?.value?.replace('http://www.wikidata.org/entity/', ''))
    .filter(Boolean);

  if (qids.length === 0) throw new Error(`[wikidata] No items with images found for "${keyword}"`);
  return qids.sort(() => Math.random() - 0.5);
}

/**
 * Return up to `count` search result previews for the given query.
 * Uses the same mwapi approach so labels and descriptions are both searched.
 */
async function searchPreview(queryStr, options = {}) {
  const { count = 12 } = options;

  const sparql = [
    'SELECT DISTINCT ?item ?image ?itemLabel ?creatorLabel WHERE {',
    '  SERVICE wikibase:mwapi {',
    '    bd:serviceParam wikibase:endpoint "www.wikidata.org";',
    '                    wikibase:api "Search";',
    `                    mwapi:srsearch ${JSON.stringify(queryStr)};`,
    '                    mwapi:language "en";',
    `                    mwapi:limit "${count * 3}".`,
    '    ?item wikibase:apiOutputItem mwapi:title.',
    '  }',
    '  ?item wdt:P18 ?image.',
    '  OPTIONAL { ?item wdt:P170 ?creator }',
    '  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }',
    '}',
    `LIMIT ${count}`,
  ].join('\n');

  const bindings = await sparqlQuery(sparql, 30000);

  const results = bindings.map(b => {
    const qid      = b.item?.value?.replace('http://www.wikidata.org/entity/', '') || null;
    const imageUrl = b.image?.value || null;
    return {
      title:        b.itemLabel?.value  || null,
      creator:      b.creatorLabel?.value || null,
      thumbnailUrl: imageUrl ? `${imageUrl}?width=200` : null,
      artworkUrl:   qid ? `https://www.wikidata.org/wiki/${qid}` : null,
      source:       'Wikidata',
    };
  });

  return { results, totalAvailable: results.length };
}

// ── fetchByIdentifier ─────────────────────────────────────────────────────────

/**
 * Returns true if the identifier is a Wikidata item URL.
 * Accepted formats:
 *   https://www.wikidata.org/wiki/Q12418
 *   https://www.wikidata.org/entity/Q12418
 */
function canHandleIdentifier(identifier) {
  return /wikidata\.org\/(wiki|entity)\/(Q\d+)/i.test(identifier.trim());
}

function extractQid(identifier) {
  const match = identifier.trim().match(/\/(Q\d+)/i);
  return match ? match[1].toUpperCase() : null;
}

/**
 * Fetch a specific artwork by Wikidata item URL.
 *
 * @param {string} identifier
 * @param {object} [options]
 * @param {string} [options.sourceLabel='Wikidata']
 * @returns {{ imageBuffer, contentType, metadata }}
 */
async function fetchByIdentifier(identifier, options = {}) {
  const { sourceLabel = 'Wikidata' } = options;
  const qid = extractQid(identifier);
  if (!qid) throw new Error('Could not extract QID from Wikidata URL');

  let detail;
  try {
    detail = await fetchItemDetail(qid);
  } catch (err) {
    throw new Error(`Wikidata detail fetch failed for ${qid}: ${err.message}`);
  }
  if (!detail?.imageUrl) throw new Error(`No image found for Wikidata item ${qid}`);

  const sizeParam = thumbSpecialFileParam(options.tvOrientation === 'portrait' ? 'portrait' : 'landscape');
  const thumbUrl = detail.imageUrl.includes('?')
    ? `${detail.imageUrl}&${sizeParam}`
    : `${detail.imageUrl}?${sizeParam}`;
  let imageBuffer, contentType;
  try {
    const resp = await axios.get(thumbUrl, {
      responseType: 'arraybuffer',
      timeout:      IMAGE_TIMEOUT_MS,
      headers:      { 'User-Agent': USER_AGENT },
      maxRedirects: 5,
    });
    imageBuffer = Buffer.from(resp.data);
    contentType = resp.headers['content-type'] || 'image/jpeg';
  } catch (err) {
    throw new Error(`Failed to download Wikidata image for ${qid}: ${err.message}`);
  }

  return {
    imageBuffer,
    contentType,
    metadata: {
      title:       detail.title,
      creator:     detail.creator,
      medium:      detail.medium,
      dimensions:  formatDimensions(detail.height, detail.width),
      dateCreated: formatDate(detail.dateRaw),
      artworkUrl:  `https://www.wikidata.org/wiki/${qid}`,
      source:      sourceLabel,
      movement:    detail.movement,
      genre:       detail.genre,
      collection:  detail.collection,
    },
  };
}

// ── countArtistArtworks ───────────────────────────────────────────────────────

/**
 * Return the approximate number of artworks for an artist in Wikidata.
 * Used by the artist panel to show per-source counts.
 *
 * @param {string} artistName
 * @param {object} [options]
 * @param {Array}  [options.preFilters=[]]
 * @returns {Promise<number|null>}
 */
async function countArtistArtworks(artistName, options = {}) {
  const { preFilters = [] } = options;
  try {
    const creatorQid = await resolveCreatorQid(artistName);
    if (!creatorQid) return null;

    const mediaQids = getRequireValues(preFilters, 'media')
      .map(v => MEDIA_TYPES.find(m => m.value === v)?.qid)
      .filter(Boolean);
    const mediaQid = mediaQids.length > 0 ? mediaQids[0] : DEFAULT_MEDIA_QID;

    const query = `
SELECT (COUNT(DISTINCT ?item) AS ?count) WHERE {
  ?item wdt:P31 wd:${mediaQid} ;
        wdt:P18 [] ;
        wdt:P170 wd:${creatorQid} .
}`.trim();

    const bindings = await sparqlQuery(query, 15000);
    const count = parseInt(bindings[0]?.count?.value ?? '0', 10);
    return count || null;
  } catch {
    return null;
  }
}

// ── selectMode ─────────────────────────────────────────────────────────────────

function selectMode(filters = []) {
  const hasArtist = filters.some(f => f.type === 'artist');
  let mode = 'random';
  if (hasArtist) mode = 'artist_search';
  else if (filters.some(f => ['movement', 'genre', 'institution', 'century', 'media'].includes(f.type) && f.mode === 'require')) {
    mode = 'category_search';
  }
  return { mode, apiFilters: filters, postFilters: [] };
}

// ── getFilterTypes ─────────────────────────────────────────────────────────────

const MOVEMENT_GROUPS = [
  { name: 'Medieval & Renaissance', values: ['Renaissance', 'Mannerism'] },
  { name: 'Baroque & Classical',    values: ['Baroque', 'Rococo', 'Neoclassicism'] },
  { name: '19th Century',           values: ['Romanticism', 'Realism', 'Pre-Raphaelitism', 'Impressionism', 'Post-Impressionism', 'Symbolism', 'Art Nouveau', 'Japonisme'] },
  { name: 'Early Modern',           values: ['Fauvism', 'Expressionism', 'Cubism', 'Futurism', 'Surrealism', 'Abstract art'] },
  { name: 'Regional',               values: ['Dutch Golden Age'] },
];

const GENRE_GROUPS = [
  { name: 'People',   values: ['Portrait', 'Self-portrait', 'Nude'] },
  { name: 'Nature',   values: ['Landscape', 'Animal painting', 'Marine art'] },
  { name: 'Objects',  values: ['Still life'] },
  { name: 'Narrative',values: ['History painting', 'Genre painting', 'Religious art', 'Mythological'] },
];

const INSTITUTION_GROUPS = [
  { name: 'France',         values: ['Louvre', "Musée d'Orsay"] },
  { name: 'UK',             values: ['National Gallery London', 'British Museum', 'Victoria and Albert Museum', 'Tate'] },
  { name: 'Netherlands',    values: ['Rijksmuseum'] },
  { name: 'Italy',          values: ['Uffizi'] },
  { name: 'Spain',          values: ['Prado'] },
  { name: 'Russia',         values: ['Hermitage'] },
  { name: 'United States',  values: ['Metropolitan Museum of Art', 'Getty Museum', 'Art Institute of Chicago', 'Museum of Fine Arts Boston', 'National Gallery of Art', 'Smithsonian'] },
];

const MEDIA_GROUPS = [
  { name: 'Fine Art',        values: ['Paintings', 'Watercolors', 'Miniature paintings', 'Drawings', 'Prints'] },
  { name: 'Photography',     values: ['Photographs'] },
  { name: 'Sculpture',       values: ['Sculptures'] },
];

const CENTURY_GROUPS = [
  { name: 'Medieval',        values: ['13th century', '14th century', '15th century'] },
  { name: 'Renaissance',     values: ['16th century'] },
  { name: 'Early Modern',    values: ['17th century', '18th century'] },
  { name: 'Modern',          values: ['19th century', '20th century', '21st century'] },
];

function getFilterTypes() {
  return [
    {
      type:        'media',
      label:       'Media Type',
      description: 'Restrict by medium. Defaults to paintings when unset.',
      modes:       ['require'],
      multiValue:  true,
      groups:      MEDIA_GROUPS,
      values:      MEDIA_TYPES.map(m => ({ value: m.value, label: m.label })),
    },
    {
      type:        'movement',
      label:       'Art Movement',
      description: 'Restrict to a specific art movement or style (Wikidata P135).',
      modes:       ['require'],
      multiValue:  false,
      groups:      MOVEMENT_GROUPS,
      values:      MOVEMENTS.map(m => ({ value: m.value, label: m.label })),
    },
    {
      type:        'genre',
      label:       'Genre',
      description: 'Restrict to a subject genre such as portrait, landscape, or still life (Wikidata P136).',
      modes:       ['require'],
      multiValue:  false,
      groups:      GENRE_GROUPS,
      values:      GENRES.map(g => ({ value: g.value, label: g.label })),
    },
    {
      type:        'institution',
      label:       'Collection',
      description: 'Restrict to artworks held by a specific museum or collection (Wikidata P195).',
      modes:       ['require'],
      multiValue:  false,
      groups:      INSTITUTION_GROUPS,
      values:      INSTITUTIONS.map(i => ({ value: i.value, label: i.label })),
    },
    {
      type:        'century',
      label:       'Century',
      description: 'Restrict by creation date range via inception date (Wikidata P571).',
      modes:       ['require'],
      multiValue:  false,
      groups:      CENTURY_GROUPS,
      values:      CENTURIES.map(c => ({ value: c.value, label: c.label })),
    },
    {
      type:        'artist',
      label:       'Artist',
      description: 'Filter by artist name. The name is resolved to a Wikidata creator QID (P170).',
      modes:       ['require'],
      multiValue:  false,
      values:      [],
      inputStyle:  'search',
    },
    {
      type:        'search',
      label:       'Search',
      description: 'Search by artwork title, artist name, or subject. Uses Wikidata entity search (labels and aliases).',
      modes:       ['require'],
      multiValue:  false,
      values:      [],
      inputStyle:  'search',
    },
  ];
}

// ── Metadata declarations ──────────────────────────────────────────────────────

const metadataFields = [
  { key: 'title',       label: 'Title',       description: 'Artwork title (Wikidata item label)' },
  { key: 'creator',     label: 'Creator',     description: 'Artist or maker (P170 label)' },
  { key: 'dateCreated', label: 'Date',        description: 'Inception year (P571)', format: 'date' },
  { key: 'medium',      label: 'Medium',      description: 'Material used (P186 label, e.g. "oil paint")' },
  { key: 'dimensions',  label: 'Dimensions',  description: 'Physical size formatted as "W × H cm" from P2049/P2048' },
  { key: 'movement',    label: 'Movement',    description: 'Art movement (P135 label)' },
  { key: 'genre',       label: 'Genre',       description: 'Genre (P136 label)' },
  { key: 'collection',  label: 'Collection',  description: 'Museum or collection holding the work (P195/P276 label)' },
  { key: 'source',      label: 'Source',      description: 'Source label' },
];

const defaultMapping = {
  title:       'title',
  creator:     { entity: 'creator', attribute: 'name' },
  dateCreated: 'date',
  medium:      'medium',
  dimensions:  'dimensions',
  collection:  'museum',
  source:      null,
};

// ── Startup pool warm-up ───────────────────────────────────────────────────────
//
// Pre-populate the QID pool for the most common query (all paintings, no filters)
// so the first user fetch doesn't pay the ~10s pool fetch latency.
// Runs asynchronously at module load; failures are silently ignored.

(async () => {
  const key = poolCacheKey([], null);
  if (poolCache.has(key)) return;
  try {
    await getPool([], null);
  } catch (err) {
    console.warn(`[wikidata] Startup pool warmup failed: ${err.message}`);
  }
})();

module.exports = {
  fetchRandomArtwork,
  fetchByIdentifier,
  canHandleIdentifier,
  searchPreview,
  countArtistArtworks,
  selectMode,
  getFilterTypes,
  metadataFields,
  defaultMapping,
};
