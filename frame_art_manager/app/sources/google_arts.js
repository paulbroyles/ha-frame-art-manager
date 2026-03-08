const axios = require('axios');

// All art medium entities listed on artsandculture.google.com/category/medium,
// identified by Google/Freebase Knowledge Graph IDs. Discovered via BFS through the
// "related mediums" links returned by /api/entity for each medium.
//
// Item counts are fetched at runtime from the API (stella.pr[4] in the entity/assets
// response) and cached in-process. See fetchEntityTotal().
const MEDIUM_ENTITIES = [
  // Paints & pigments
  { name: 'oil paint',            id: '/m/031cgw'  },
  { name: 'watercolor painting',  id: '/m/018ktp'  },
  { name: 'acrylic paint',        id: '/m/011lx'   },
  { name: 'tempera',              id: '/m/07mtr'   },
  { name: 'gouache',              id: '/m/0j12g'   },
  { name: 'vitreous enamel',      id: '/m/01tp42'  },
  { name: 'distemper',            id: '/m/027cnnk' },
  { name: 'spray painting',       id: '/m/02kzxb'  },
  { name: 'oil pastel',           id: '/m/04wbc_'  },
  { name: 'encaustic painting',   id: '/m/0cjhq'   },
  { name: 'pigment',              id: '/m/0d5pz'   },
  { name: 'dye',                  id: '/m/028qp'   },
  { name: 'cinnabar',             id: '/m/0f0b7'   },
  { name: 'azurite',              id: '/m/02by5g'  },
  { name: 'cochineal',            id: '/m/01jq68'  },
  { name: 'varnish',              id: '/m/01ffcg'  },
  { name: 'lacquer',              id: '/m/01fn7d'  },
  // Drawing media
  { name: 'ink',                  id: '/m/03yhk'   },
  { name: 'india ink',            id: '/m/03yjs'   },
  { name: 'graphite',             id: '/m/037vk'   },
  { name: 'pencil',               id: '/m/063w2'   },
  { name: 'pen',                  id: '/m/0k1tl'   },
  { name: 'drawing',              id: '/m/02csf'   },
  { name: 'charcoal',             id: '/m/0c3yk'   },
  { name: 'chalk',                id: '/m/0c5q8'   },
  { name: 'colored pencil',       id: '/m/03q7mr3' },
  { name: 'crayon',               id: '/m/0ckdv'   },
  { name: 'sanguine',             id: '/m/03bxb3w' },
  { name: 'conté',                id: '/m/03qz2_'  },
  // Printmaking
  { name: 'engraving',            id: '/m/0gc80'   },
  { name: 'etching',              id: '/m/03q7qln' },
  // Paper & supports
  { name: 'canvas',               id: '/m/0jmpt'   },
  { name: 'photographic paper',   id: '/m/01d07t'  },
  { name: 'photograph',           id: '/m/068jd'   },
  { name: 'paper negative',       id: '/m/08bghl'  },
  { name: 'calotype',             id: '/m/0kybl'   },
  { name: 'laid paper',           id: '/m/0270pz1' },
  { name: 'vellum',               id: '/m/07z2_'   },
  { name: 'tracing paper',        id: '/m/0c676r'  },
  { name: 'rice paper',           id: '/m/025s1d'  },
  { name: 'cardboard',            id: '/m/03q7pgh' },
  { name: 'masonite',             id: '/m/044_hq'  },
  { name: 'book',                 id: '/m/0bt_c3'  },
  // Metals
  { name: 'metal',                id: '/m/04t7l'   },
  { name: 'gold',                 id: '/m/025rs2z' },
  { name: 'gold leaf',            id: '/m/03q7p6c' },
  { name: 'silver',               id: '/m/025sf8x' },
  { name: 'bronze',               id: '/m/01brf'   },
  { name: 'iron',                 id: '/m/025rw19' },
  { name: 'copper',               id: '/m/025rsfk' },
  { name: 'brass',                id: '/m/01504'   },
  { name: 'steel',                id: '/m/06qqb'   },
  { name: 'lead',                 id: '/m/025r_0t' },
  { name: 'tin',                  id: '/m/025sk5n' },
  { name: 'platinum',             id: '/m/025s7y2' },
  { name: 'aluminium',            id: '/m/027vj2v' },
  { name: 'wire',                 id: '/m/083kv'   },
  { name: 'sterling silver',      id: '/m/01g8vd'  },
  { name: 'cast iron',            id: '/m/0_1c0'   },
  { name: 'wrought iron',         id: '/m/0pf1p'   },
  { name: 'pewter',               id: '/m/0gd79'   },
  { name: 'stainless steel',      id: '/m/06qqv'   },
  { name: 'sheet metal',          id: '/m/0586q3'  },
  { name: 'neon',                 id: '/m/025s4r0' },
  { name: 'cobalt',               id: '/m/025tkrf' },
  { name: 'zinc',                 id: '/m/025sqz8' },
  { name: 'nickel',               id: '/m/025s4r7' },
  { name: 'foil',                 id: '/m/02vk7kj' },
  { name: 'chromium',             id: '/m/025tkr6' },
  { name: 'manganese',            id: '/m/025s0zp' },
  { name: 'mercury',              id: '/m/025sw5g' },
  { name: 'titanium',             id: '/m/025sk56' },
  // Stone
  { name: 'rock',                 id: '/m/01cbzq'  },
  { name: 'marble',               id: '/m/04tdh'   },
  { name: 'granite',              id: '/m/03fcm'   },
  { name: 'limestone',            id: '/m/04hgv'   },
  { name: 'sandstone',            id: '/m/06xky'   },
  { name: 'slate',                id: '/m/0c1ml'   },
  { name: 'pebble',               id: '/m/01tp0c'  },
  { name: 'diorite',              id: '/m/02943b'  },
  { name: 'basalt',               id: '/m/0bxps'   },
  { name: 'obsidian',             id: '/m/05pjv'   },
  { name: 'quartzite',            id: '/m/029zr1'  },
  { name: 'andesite',             id: '/m/01pxwx'  },
  { name: 'schist',               id: '/m/0bxnh'   },
  { name: 'flint',                id: '/m/0byhp'   },
  { name: 'soapstone',            id: '/m/0c5l2'   },
  { name: 'alabaster',            id: '/m/0pj6'    },
  { name: 'travertine',           id: '/m/01khnr'  },
  { name: 'carrara marble',       id: '/m/0hzplp5' },
  { name: 'parian marble',        id: '/m/05vx0v'  },
  { name: 'pavonazzo marble',     id: '/m/0b6lgbk' },
  // Ceramics & clay
  { name: 'clay',                 id: '/m/0975t'   },
  { name: 'ceramic',              id: '/m/01x5q'   },
  { name: 'porcelain',            id: '/m/016f4d'  },
  { name: 'stoneware',            id: '/m/03q7p08' },
  { name: 'terracotta',           id: '/m/017jcd'  },
  { name: 'pottery',              id: '/m/064rk'   },
  { name: 'biscuit porcelain',    id: '/m/06w9k4'  },
  { name: 'faience',              id: '/m/02bnj5'  },
  { name: 'lustreware',           id: '/m/05pg1b'  },
  { name: 'brick',                id: '/m/01g0g'   },
  { name: 'stucco',               id: '/m/033nbz'  },
  { name: 'concrete',             id: '/m/01mxf'   },
  { name: 'plaster',              id: '/m/01w_gm'  },
  // Glass
  { name: 'glass',                id: '/m/039jq'   },
  { name: 'stained glass',        id: '/m/011y23'  },
  { name: 'crystal',              id: '/m/01t4h'   },
  { name: 'milk glass',           id: '/m/07w219'  },
  { name: 'murano glass',         id: '/m/0ftc03'  },
  { name: 'lead glass',           id: '/m/02x31v'  },
  { name: 'fiberglass',           id: '/m/014qy5'  },
  { name: 'resin',                id: '/m/0g27n'   },
  // Textiles
  { name: 'textile',              id: '/m/0dnr7'   },
  { name: 'silk',                 id: '/m/0dl6q'   },
  { name: 'cotton',               id: '/m/095zt'   },
  { name: 'wool',                 id: '/m/09kxp'   },
  { name: 'linen',                id: '/m/0fkqd'   },
  { name: 'lace',                 id: '/m/0m95s'   },
  { name: 'velvet',               id: '/m/011ljn'  },
  { name: 'yarn',                 id: '/m/02kvytt' },
  { name: 'cord',                 id: '/m/0b2t53'  },
  { name: 'satin',                id: '/m/02xhmrh' },
  { name: 'brocade',              id: '/m/026c1s9' },
  { name: 'felt',                 id: '/m/0158y_'  },
  { name: 'hessian fabric',       id: '/m/06w8z_'  },
  { name: 'muslin',               id: '/m/01cgyj'  },
  { name: 'mohair',               id: '/m/0175vp'  },
  { name: 'twill',                id: '/m/02xhmpq' },
  { name: 'damask',               id: '/m/04m908'  },
  { name: 'taffeta',              id: '/m/080j18'  },
  { name: 'chiffon',              id: '/m/08h11d'  },
  { name: 'gauze',                id: '/m/0bzzvg'  },
  { name: 'chintz',               id: '/m/06f_6h'  },
  { name: 'jute',                 id: '/m/01xj7m'  },
  { name: 'rope',                 id: '/m/01xc8d'  },
  // Wood
  { name: 'wood',                 id: '/m/083vt'   },
  { name: 'oak',                  id: '/m/09wzt'   },
  { name: 'walnut',               id: '/m/015_77'  },
  { name: 'maple',                id: '/m/0cffdh'  },
  { name: 'teak',                 id: '/m/01s5tq'  },
  { name: 'mahogany',             id: '/m/0c7cd'   },
  { name: 'ebony',                id: '/m/0194pb'  },
  { name: 'pine',                 id: '/m/09t57'   },
  { name: 'cherry',               id: '/m/0f8sw'   },
  { name: 'eucalyptus',           id: '/m/0d7gy'   },
  { name: 'beech',                id: '/m/015_vx'  },
  { name: 'birch',                id: '/m/0hpx4'   },
  { name: 'willow',               id: '/m/0mw_6'   },
  { name: 'spruce',               id: '/m/016x44'  },
  { name: 'fir',                  id: '/m/016x4z'  },
  { name: 'olive',                id: '/m/03l9pw'  },
  { name: 'tulipwood',            id: '/m/07_yv6'  },
  // Plastic & synthetic
  { name: 'plastic',              id: '/m/05z87'   },
  { name: 'polyester',            id: '/m/09hb3s'  },
  { name: 'nylon',                id: '/m/05d6r'   },
  { name: 'polyurethane',         id: '/m/0cym6'   },
  { name: 'polypropylene',        id: '/m/01cnhn'  },
  { name: 'epoxy',                id: '/m/01f0y0'  },
  { name: 'polycarbonate',        id: '/m/02mqs4'  },
  { name: 'polystyrene',          id: '/m/016jr1'  },
  { name: 'bakelite',             id: '/m/01fnt'   },
  { name: 'celluloid',            id: '/m/0psq1'   },
  { name: 'acrylic resin',        id: '/m/0d665k'  },
  { name: 'formica',              id: '/m/02p9fd'  },
  { name: 'polyethylene',         id: '/m/0k8xc'   },
  { name: 'natural rubber',       id: '/m/09kmv'   },
  // Gemstones & minerals
  { name: 'gemstone',             id: '/m/03c4j'   },
  { name: 'jade',                 id: '/m/01b5dy'  },
  { name: 'quartz',               id: '/m/069p0'   },
  { name: 'amber',                id: '/m/0pbc'    },
  { name: 'diamond',              id: '/m/027_y'   },
  { name: 'turquoise',            id: '/m/0fgkh'   },
  { name: 'garnet',               id: '/m/09bz0'   },
  { name: 'feldspar',             id: '/m/09ghj'   },
  { name: 'hematite',             id: '/m/03pf1'   },
  { name: 'malachite',            id: '/m/01zn3_'  },
  { name: 'jet',                  id: '/m/02qkkn'  },
  { name: 'sapphire',             id: '/m/0797j'   },
  { name: 'emerald',              id: '/m/02qv1'   },
  { name: 'topaz',                id: '/m/07qmk'   },
  { name: 'lapis lazuli',         id: '/m/0c51n'   },
  { name: 'nephrite',             id: '/m/025rpbz' },
  { name: 'jadeite',              id: '/m/03w1p7'  },
  { name: 'onyx',                 id: '/m/01s85q'  },
  { name: 'jasper',               id: '/m/0k059'   },
  { name: 'amethyst',             id: '/m/0p7h'    },
  { name: 'agate',                id: '/m/0qjx'    },
  { name: 'pearl',                id: '/m/05_8m'   },
  { name: 'nacre',                id: '/m/0237xf'  },
  // Other natural materials
  { name: 'ivory',                id: '/m/03xgl'   },
  { name: 'bone',                 id: '/m/01b92'   },
  { name: 'leather',              id: '/m/04lbp'   },
  { name: 'wax',                  id: '/m/0fy__'   },
  { name: 'beeswax',              id: '/m/0bxq8'   },
  { name: 'bark',                 id: '/m/016v85'  },
  { name: 'leaf',                 id: '/m/09t49'   },
  { name: 'root',                 id: '/m/0flg6'   },
  { name: 'tooth',                id: '/m/0cnxs6x' },
  { name: 'tusk',                 id: '/m/01n_j_'  },
  { name: 'cork',                 id: '/m/0k1ps'   },
  // Other media
  { name: 'sculpture',            id: '/m/06msq'   },
  { name: 'adhesive',             id: '/m/0z49'    },
  { name: 'rhinestone',           id: '/m/04wy1k'  },
  { name: 'adobe',                id: '/m/0h_4'    },
];

// The /api/entity/assets endpoint returns HTTP 500 for offsets ≥ ~5000,
// regardless of an entity's actual total. This constant caps the usable range.
// To lift the cap once full pagination is available, remove the Math.min() call
// in getAccessibleCount() and delete this constant.
const ENTITY_MAX_OFFSET = 4800;

// In-process cache: entity id → total artwork count fetched from the API.
const _totalCache = new Map();

/**
 * Fetch the total artwork count for an entity from the API, with in-process caching.
 * Uses a page-size-1 probe request to minimize data transfer.
 * Returns 0 on failure (which excludes the entity from weighted selection).
 */
async function fetchEntityTotal(entity) {
  if (_totalCache.has(entity.id)) {
    return _totalCache.get(entity.id);
  }
  const pt = buildPtToken(0);
  try {
    const response = await axios.get(`${BASE_URL}/api/entity/assets`, {
      params: { entityId: entity.id, categoryId: 'medium', s: 1, pt, hl: 'en', rt: 'j' },
      headers: { ...HTTP_HEADERS, Accept: 'application/json, text/plain, */*' },
      timeout: 10000,
      responseType: 'text',
    });
    const parsed = parseApiResponse(response.data);
    const total = parsed?.[0]?.[0]?.[4] ?? 0;
    _totalCache.set(entity.id, total);
    return total;
  } catch (err) {
    console.warn(`[google_arts] Failed to fetch total for "${entity.name}": ${err.message}`);
    return 0;
  }
}

/**
 * Returns the number of artworks accessible for an entity given current API limits.
 * Capped at ENTITY_MAX_OFFSET due to server-side offset restrictions.
 * When full pagination becomes available: return Math.max(0, total - 18)
 *
 * Entities with total ≤ 18 return 0. These are excluded from weighted selection
 * (they have zero weight) and will never be picked by weightedRandomEntity(). This
 * is intentional: with only a handful of artworks we can't meaningfully randomize
 * the offset, so they're treated as inaccessible for selection purposes.
 * Examples: pavonazzo marble (15), adobe (15).
 */
function getAccessibleCount(total) {
  return Math.min(ENTITY_MAX_OFFSET, Math.max(0, total - 18));
}

/**
 * Pick a random entity from an array, weighted by each entity's accessible artwork count.
 * Fetches totals from the API concurrently (cached after first call per process).
 * This gives approximately uniform distribution across individual artwork positions:
 * each position has probability 1/totalAccessible, regardless of which entity it belongs to.
 * Entities with getAccessibleCount() == 0 are effectively excluded (zero weight).
 * Returns { entity, total } for the selected entity.
 */
async function weightedRandomEntity(entities) {
  const totals = await Promise.all(entities.map(e => fetchEntityTotal(e)));
  const weights = totals.map(t => getAccessibleCount(t));
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  if (totalWeight === 0) {
    const idx = Math.floor(Math.random() * entities.length);
    return { entity: entities[idx], total: totals[idx] };
  }
  let r = Math.random() * totalWeight;
  for (let i = 0; i < entities.length; i++) {
    r -= weights[i];
    if (r <= 0) return { entity: entities[i], total: totals[i] };
  }
  return { entity: entities[entities.length - 1], total: totals[totals.length - 1] };
}

/**
 * Build a base64url-encoded protobuf pagination token for /api/entity/assets.
 *
 * Token structure (reverse-engineered from HAR captures):
 *   field 1 (length-delimited): sub-message containing field 1 (varint) = offset
 *
 * The server accepts a minimal token with just this field; the additional cursor
 * fields present in server-generated tokens are optional.
 */
function buildPtToken(offset) {
  function encodeVarint(v) {
    const bytes = [];
    while (true) {
      const b = v & 0x7f;
      v >>>= 7;
      if (v) bytes.push(b | 0x80);
      else { bytes.push(b); break; }
    }
    return Buffer.from(bytes);
  }
  const offsetVarint = encodeVarint(offset);
  const field1Val = Buffer.concat([Buffer.from([0x08]), offsetVarint]);
  const token = Buffer.concat([
    Buffer.from([0x0a]),
    encodeVarint(field1Val.length),
    field1Val,
  ]);
  // URL-safe base64, no padding
  return token.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

const BASE_URL = 'https://artsandculture.google.com';

const HTTP_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
};

/**
 * Parse the Google Arts & Culture API response.
 * Responses start with )]}'\n (XSSI protection prefix).
 */
function parseApiResponse(data) {
  const prefix = ")]}'\n";
  if (typeof data === 'string' && data.startsWith(prefix)) {
    data = data.slice(prefix.length);
  }
  return typeof data === 'string' ? JSON.parse(data) : data;
}

/**
 * Recursively extract artwork objects from a parsed API response.
 * Cobjects: ['stella.common.cobject', title, creator, imageUrl, link, ...]
 * Only /asset/ links are kept (not /story/ or other types).
 */
function extractArtworks(obj, depth = 0) {
  const artworks = [];
  if (depth > 15 || !obj) return artworks;

  if (Array.isArray(obj)) {
    if (
      obj[0] === 'stella.common.cobject' &&
      typeof obj[4] === 'string' && obj[4].startsWith('/asset/') &&
      typeof obj[3] === 'string'
    ) {
      const imageBase = obj[3].startsWith('//') ? `https:${obj[3]}` : obj[3];
      artworks.push({
        title: obj[1] || null,
        creator: obj[2] || null,
        imageBase,
        link: obj[4],
      });
      return artworks;
    }
    for (const item of obj) {
      artworks.push(...extractArtworks(item, depth + 1));
    }
  }
  return artworks;
}

/**
 * Fetch a random artwork from Google Arts & Culture.
 *
 * Uses the /api/entity/assets endpoint with a weighted-random medium entity and
 * a random offset, giving approximately uniform distribution across all accessible
 * artwork positions. Entities are weighted by accessible item count so larger
 * collections are proportionally more likely to be selected.
 *
 * @param {string[]} [mediaFilter] - Optional list of medium names to restrict selection.
 *   Names are matched case-insensitively against MEDIUM_ENTITIES. If omitted or empty,
 *   all 203 media are eligible. Pass e.g. ['oil paint', 'watercolor painting'] to
 *   restrict to specific media.
 *
 * @returns {{ imageBuffer, contentType, metadata: { title, creator, artworkUrl, medium, source } }}
 * @throws {Error} If the filter matches no known media, or on network/API failure.
 */
async function fetchRandomArtwork(mediaFilter = null) {
  let candidates = MEDIUM_ENTITIES;
  if (mediaFilter && mediaFilter.length > 0) {
    const filterSet = new Set(mediaFilter.map(m => m.toLowerCase()));
    candidates = MEDIUM_ENTITIES.filter(e => filterSet.has(e.name.toLowerCase()));
    if (candidates.length === 0) {
      throw new Error(`No known media matched filter: ${mediaFilter.join(', ')}`);
    }
  }

  const { entity, total } = await weightedRandomEntity(candidates);
  const maxOffset = getAccessibleCount(total);
  const offset = maxOffset > 0 ? Math.floor(Math.random() * maxOffset) : 0;
  const pt = buildPtToken(offset);

  let parsed;
  try {
    const response = await axios.get(`${BASE_URL}/api/entity/assets`, {
      params: { entityId: entity.id, categoryId: 'medium', s: 18, pt, hl: 'en', rt: 'j' },
      headers: { ...HTTP_HEADERS, Accept: 'application/json, text/plain, */*' },
      timeout: 15000,
      responseType: 'text',
    });
    parsed = parseApiResponse(response.data);
  } catch (err) {
    throw new Error(`Failed to fetch artworks for "${entity.name}": ${err.message}`);
  }

  const artworks = extractArtworks(parsed);
  if (artworks.length === 0) {
    throw new Error(`No artworks found for "${entity.name}" at offset ${offset}`);
  }

  const artwork = artworks[Math.floor(Math.random() * artworks.length)];
  const imageUrl = `${artwork.imageBase}=w3840-h2160-c`;
  const artworkUrl = `${BASE_URL}${artwork.link}`;

  let imageBuffer, contentType;
  try {
    const imageResponse = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      headers: HTTP_HEADERS,
      timeout: 30000,
    });
    imageBuffer = Buffer.from(imageResponse.data);
    contentType = imageResponse.headers['content-type'] || 'image/jpeg';
  } catch (err) {
    throw new Error(`Failed to download artwork image: ${err.message}`);
  }

  return {
    imageBuffer,
    contentType,
    metadata: {
      title: artwork.title,
      creator: artwork.creator,
      artworkUrl,
      medium: entity.name,
      source: 'Google Arts & Culture',
    },
  };
}

module.exports = { fetchRandomArtwork, MEDIUM_ENTITIES };
