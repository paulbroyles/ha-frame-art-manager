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
const SPARQL_TIMEOUT_MS  = 60000;   // pool queries can take up to ~30s for large result sets
const DETAIL_TIMEOUT_MS  = 15000;
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
 */
async function sparqlQuery(query, timeoutMs = SPARQL_TIMEOUT_MS) {
  const response = await axios.get(SPARQL_ENDPOINT, {
    params:  { query, format: 'json' },
    headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/sparql-results+json' },
    timeout: timeoutMs,
  });
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
  // SUBSTR(STR(?item), 33) extracts the numeric part: the entity URI is
  // "http://www.wikidata.org/entity/Q<number>" — "Q" is at position 32, number at 33.
  if (shard !== null) {
    lines.push(`  FILTER(xsd:integer(SUBSTR(STR(?item), 33)) % ${SHARD_COUNT} = ${shard})`);
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
function buildDetailQuery(qid) {
  return `
SELECT ?image ?itemLabel ?creatorLabel ?date ?movementLabel ?genreLabel ?collectionLabel WHERE {
  VALUES ?item { wd:${qid} }
  OPTIONAL { ?item wdt:P18 ?image }
  OPTIONAL { ?item wdt:P170 ?creator }
  OPTIONAL { ?item wdt:P571 ?date }
  OPTIONAL { ?item wdt:P135 ?movement }
  OPTIONAL { ?item wdt:P136 ?genre }
  OPTIONAL { ?item (wdt:P195|wdt:P276) ?collection }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,fr,de,nl,it,es,pt". }
}
LIMIT 10
`.trim();
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

  const shard = shouldShard(filters, creatorQid)
    ? Math.floor(Math.random() * SHARD_COUNT)
    : null;

  const query = buildPoolQuery(filters, creatorQid, shard);
  const shardLabel = shard !== null ? ` shard ${shard}/${SHARD_COUNT}` : '';
  console.log(`[wikidata] Fetching QID pool${shardLabel} (key: ${key.slice(0, 80)}...)`);
  const bindings = await sparqlQuery(query, SPARQL_TIMEOUT_MS);

  const qids = bindings
    .map(b => b.item?.value?.replace('http://www.wikidata.org/entity/', ''))
    .filter(Boolean);

  if (qids.length === 0) throw new Error('Wikidata returned no items for the current filters');

  poolCache.set(key, { qids, expiresAt: Date.now() + POOL_TTL_MS });
  console.log(`[wikidata] Pool cached: ${qids.length} QIDs${shardLabel} for "${key.slice(0, 80)}"`);
  return qids;
}

/**
 * Extract the first non-null value from multiple SPARQL result bindings for a given field.
 */
function firstValue(bindings, field) {
  for (const b of bindings) {
    const v = b[field]?.value;
    if (v) return v;
  }
  return null;
}

/**
 * Format a SPARQL date value (xsd:dateTime like "1889-06-07T00:00:00Z") to a year or full date.
 */
function formatDate(dateStr) {
  if (!dateStr) return null;
  const match = dateStr.match(/^-?(\d{1,4})/);
  return match ? match[1] : null;
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
 * @returns {{ imageBuffer, contentType, metadata }}
 */
async function fetchRandomArtwork(filters = [], options = {}) {
  const { aspectRatio = 'all', sourceLabel = 'Wikidata', preFilters = [] } = options;
  const allFilters = [...preFilters, ...filters];

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

  // Try up to MAX_ROUNDS random QIDs from the pool.
  const candidates = [...pool].sort(() => Math.random() - 0.5).slice(0, MAX_ROUNDS * 3);

  for (const qid of candidates) {
    // Fast single-item metadata + image URL query.
    let bindings;
    try {
      bindings = await sparqlQuery(buildDetailQuery(qid), DETAIL_TIMEOUT_MS);
    } catch (err) {
      console.warn(`[wikidata] Detail query failed for ${qid}: ${err.message}`);
      continue;
    }
    if (!bindings.length) {
      console.warn(`[wikidata] ${qid}: no detail results`);
      continue;
    }

    const imageUrl = firstValue(bindings, 'image');
    if (!imageUrl) {
      console.warn(`[wikidata] ${qid}: no image URL`);
      continue;
    }

    // Download the image. The Special:FilePath URL redirects to upload.wikimedia.org.
    let imageBuffer, contentType;
    try {
      const resp = await axios.get(imageUrl, {
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

    // Skip SVG and non-raster files.
    if (contentType.includes('svg') || !contentType.startsWith('image/')) {
      console.warn(`[wikidata] ${qid} skipped: unsupported content-type ${contentType}`);
      continue;
    }

    // Aspect ratio check (post-download via sharp).
    if (aspectRatio !== 'all') {
      try {
        const { width, height } = await sharp(imageBuffer).metadata();
        const isLandscape = width > height;
        if (aspectRatio === 'landscape' && !isLandscape) {
          console.warn(`[wikidata] ${qid} skipped: not landscape (${width}x${height})`);
          continue;
        }
        if (aspectRatio === 'portrait' && isLandscape) {
          console.warn(`[wikidata] ${qid} skipped: not portrait (${width}x${height})`);
          continue;
        }
      } catch (err) {
        console.warn(`[wikidata] ${qid}: could not read dimensions: ${err.message}`);
        continue;
      }
    }

    // Build metadata from detail query results.
    const title      = firstValue(bindings, 'itemLabel');
    const creator    = firstValue(bindings, 'creatorLabel');
    const dateRaw    = firstValue(bindings, 'date');
    const movement   = firstValue(bindings, 'movementLabel');
    const genre      = firstValue(bindings, 'genreLabel');
    const collection = firstValue(bindings, 'collectionLabel');

    return {
      imageBuffer,
      contentType,
      metadata: {
        title:       title || null,
        creator:     creator || null,
        medium:      null,
        dateCreated: formatDate(dateRaw),
        artworkUrl:  `https://www.wikidata.org/wiki/${qid}`,
        source:      sourceLabel,
        movement:    movement || null,
        genre:       genre || null,
        collection:  collection || null,
      },
    };
  }

  throw new Error(
    `Could not find a suitable${aspectRatio !== 'all' ? ` ${aspectRatio}` : ''} ` +
    `artwork from Wikidata after trying ${Math.min(candidates.length, MAX_ROUNDS * 3)} candidates`
  );
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

  let bindings;
  try {
    bindings = await sparqlQuery(buildDetailQuery(qid), DETAIL_TIMEOUT_MS);
  } catch (err) {
    throw new Error(`Wikidata detail query failed for ${qid}: ${err.message}`);
  }

  const imageUrl = firstValue(bindings, 'image');
  if (!imageUrl) throw new Error(`No image found for Wikidata item ${qid}`);

  let imageBuffer, contentType;
  try {
    const resp = await axios.get(imageUrl, {
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

  const title      = firstValue(bindings, 'itemLabel');
  const creator    = firstValue(bindings, 'creatorLabel');
  const dateRaw    = firstValue(bindings, 'date');
  const movement   = firstValue(bindings, 'movementLabel');
  const genre      = firstValue(bindings, 'genreLabel');
  const collection = firstValue(bindings, 'collectionLabel');

  return {
    imageBuffer,
    contentType,
    metadata: {
      title:       title || null,
      creator:     creator || null,
      medium:      null,
      dateCreated: formatDate(dateRaw),
      artworkUrl:  `https://www.wikidata.org/wiki/${qid}`,
      source:      sourceLabel,
      movement:    movement || null,
      genre:       genre || null,
      collection:  collection || null,
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
  ];
}

// ── Metadata declarations ──────────────────────────────────────────────────────

const metadataFields = [
  { key: 'title',       label: 'Title',       description: 'Artwork title (Wikidata item label)' },
  { key: 'creator',     label: 'Creator',     description: 'Artist or maker (P170 label)' },
  { key: 'dateCreated', label: 'Date',        description: 'Inception year (P571)', format: 'date' },
  { key: 'movement',    label: 'Movement',    description: 'Art movement (P135 label)' },
  { key: 'genre',       label: 'Genre',       description: 'Genre (P136 label)' },
  { key: 'collection',  label: 'Collection',  description: 'Museum or collection holding the work (P195/P276 label)' },
  { key: 'source',      label: 'Source',      description: 'Source label' },
];

const defaultMapping = {
  title:       'title',
  creator:     { entity: 'creator', attribute: 'name' },
  dateCreated: 'date',
  source:      'museum',
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
  countArtistArtworks,
  selectMode,
  getFilterTypes,
  metadataFields,
  defaultMapping,
};
