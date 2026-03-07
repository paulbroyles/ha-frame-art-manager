const axios = require('axios');

// All art medium entities listed on artsandculture.google.com/category/medium,
// identified by Google/Freebase Knowledge Graph IDs. Discovered via BFS through the
// "related mediums" links returned by /api/entity for each medium.
//
// 'total' is the item count as reported by the entity API at time of discovery.
// Offset is clamped to min(ENTITY_MAX_OFFSET, total - 18) so small collections don't 404.
const MEDIUM_ENTITIES = [
  // Paints & pigments
  { name: 'oil paint',            id: '/m/031cgw',   total: 96746  },
  { name: 'watercolor painting',  id: '/m/018ktp',   total: 71108  },
  { name: 'acrylic paint',        id: '/m/011lx',    total: 25049  },
  { name: 'tempera',              id: '/m/07mtr',    total: 14818  },
  { name: 'gouache',              id: '/m/0j12g',    total: 14915  },
  { name: 'vitreous enamel',      id: '/m/01tp42',   total: 15377  },
  { name: 'distemper',            id: '/m/027cnnk',  total: 3881   },
  { name: 'spray painting',       id: '/m/02kzxb',   total: 13294  },
  { name: 'oil pastel',           id: '/m/04wbc_',   total: 2758   },
  { name: 'encaustic painting',   id: '/m/0cjhq',    total: 258    },
  { name: 'pigment',              id: '/m/0d5pz',    total: 44089  },
  { name: 'dye',                  id: '/m/028qp',    total: 21107  },
  { name: 'cinnabar',             id: '/m/0f0b7',    total: 258    },
  { name: 'azurite',              id: '/m/02by5g',   total: 102    },
  { name: 'cochineal',            id: '/m/01jq68',   total: 447    },
  { name: 'varnish',              id: '/m/01ffcg',   total: 9272   },
  { name: 'lacquer',              id: '/m/01fn7d',   total: 6041   },
  // Drawing media
  { name: 'ink',                  id: '/m/03yhk',    total: 193021 },
  { name: 'india ink',            id: '/m/03yjs',    total: 2915   },
  { name: 'graphite',             id: '/m/037vk',    total: 111418 },
  { name: 'pencil',               id: '/m/063w2',    total: 23690  },
  { name: 'pen',                  id: '/m/0k1tl',    total: 29798  },
  { name: 'drawing',              id: '/m/02csf',    total: 47152  },
  { name: 'charcoal',             id: '/m/0c3yk',    total: 25403  },
  { name: 'chalk',                id: '/m/0c5q8',    total: 10942  },
  { name: 'colored pencil',       id: '/m/03q7mr3',  total: 9729   },
  { name: 'crayon',               id: '/m/0ckdv',    total: 8262   },
  { name: 'sanguine',             id: '/m/03bxb3w',  total: 3430   },
  { name: 'conté',                id: '/m/03qz2_',   total: 3561   },
  // Printmaking
  { name: 'engraving',            id: '/m/0gc80',    total: 80512  },
  { name: 'etching',              id: '/m/03q7qln',  total: 47527  },
  // Paper & supports
  { name: 'canvas',               id: '/m/0jmpt',    total: 77966  },
  { name: 'photographic paper',   id: '/m/01d07t',   total: 77402  },
  { name: 'photograph',           id: '/m/068jd',    total: 327077 },
  { name: 'paper negative',       id: '/m/08bghl',   total: 19635  },
  { name: 'calotype',             id: '/m/0kybl',    total: 1609   },
  { name: 'laid paper',           id: '/m/0270pz1',  total: 18551  },
  { name: 'vellum',               id: '/m/07z2_',    total: 9741   },
  { name: 'tracing paper',        id: '/m/0c676r',   total: 3659   },
  { name: 'rice paper',           id: '/m/025s1d',   total: 6492   },
  { name: 'cardboard',            id: '/m/03q7pgh',  total: 17455  },
  { name: 'masonite',             id: '/m/044_hq',   total: 6691   },
  { name: 'book',                 id: '/m/0bt_c3',   total: 12563  },
  // Metals
  { name: 'metal',                id: '/m/04t7l',    total: 238338 },
  { name: 'gold',                 id: '/m/025rs2z',  total: 71584  },
  { name: 'gold leaf',            id: '/m/03q7p6c',  total: 21954  },
  { name: 'silver',               id: '/m/025sf8x',  total: 56002  },
  { name: 'bronze',               id: '/m/01brf',    total: 35988  },
  { name: 'iron',                 id: '/m/025rw19',  total: 26964  },
  { name: 'copper',               id: '/m/025rsfk',  total: 20485  },
  { name: 'brass',                id: '/m/01504',    total: 12299  },
  { name: 'steel',                id: '/m/06qqb',    total: 10636  },
  { name: 'lead',                 id: '/m/025r_0t',  total: 3965   },
  { name: 'tin',                  id: '/m/025sk5n',  total: 4373   },
  { name: 'platinum',             id: '/m/025s7y2',  total: 1382   },
  { name: 'aluminium',            id: '/m/027vj2v',  total: 2830   },
  { name: 'wire',                 id: '/m/083kv',    total: 3161   },
  { name: 'sterling silver',      id: '/m/01g8vd',   total: 3462   },
  { name: 'cast iron',            id: '/m/0_1c0',    total: 1942   },
  { name: 'wrought iron',         id: '/m/0pf1p',    total: 998    },
  { name: 'pewter',               id: '/m/0gd79',    total: 1432   },
  { name: 'stainless steel',      id: '/m/06qqv',    total: 1454   },
  { name: 'sheet metal',          id: '/m/0586q3',   total: 948    },
  { name: 'neon',                 id: '/m/025s4r0',  total: 2362   },
  { name: 'cobalt',               id: '/m/025tkrf',  total: 2254   },
  { name: 'zinc',                 id: '/m/025sqz8',  total: 659    },
  { name: 'nickel',               id: '/m/025s4r7',  total: 985    },
  { name: 'foil',                 id: '/m/02vk7kj',  total: 8506   },
  { name: 'chromium',             id: '/m/025tkr6',  total: 224    },
  { name: 'manganese',            id: '/m/025s0zp',  total: 428    },
  { name: 'mercury',              id: '/m/025sw5g',  total: 124    },
  { name: 'titanium',             id: '/m/025sk56',  total: 55     },
  // Stone
  { name: 'rock',                 id: '/m/01cbzq',   total: 164405 },
  { name: 'marble',               id: '/m/04tdh',    total: 23735  },
  { name: 'granite',              id: '/m/03fcm',    total: 3485   },
  { name: 'limestone',            id: '/m/04hgv',    total: 6063   },
  { name: 'sandstone',            id: '/m/06xky',    total: 2511   },
  { name: 'slate',                id: '/m/0c1ml',    total: 321    },
  { name: 'pebble',               id: '/m/01tp0c',   total: 91     },
  { name: 'diorite',              id: '/m/02943b',   total: 181    },
  { name: 'basalt',               id: '/m/0bxps',    total: 496    },
  { name: 'obsidian',             id: '/m/05pjv',    total: 168    },
  { name: 'quartzite',            id: '/m/029zr1',   total: 338    },
  { name: 'andesite',             id: '/m/01pxwx',   total: 193    },
  { name: 'schist',               id: '/m/0bxnh',    total: 318    },
  { name: 'flint',                id: '/m/0byhp',    total: 544    },
  { name: 'soapstone',            id: '/m/0c5l2',    total: 1802   },
  { name: 'alabaster',            id: '/m/0pj6',     total: 1461   },
  { name: 'travertine',           id: '/m/01khnr',   total: 638    },
  { name: 'carrara marble',       id: '/m/0hzplp5',  total: 279    },
  { name: 'parian marble',        id: '/m/05vx0v',   total: 257    },
  { name: 'pavonazzo marble',     id: '/m/0b6lgbk',  total: 15     },
  // Ceramics & clay
  { name: 'clay',                 id: '/m/0975t',    total: 109489 },
  { name: 'ceramic',              id: '/m/01x5q',    total: 64105  },
  { name: 'porcelain',            id: '/m/016f4d',   total: 26258  },
  { name: 'stoneware',            id: '/m/03q7p08',  total: 25284  },
  { name: 'terracotta',           id: '/m/017jcd',   total: 13387  },
  { name: 'pottery',              id: '/m/064rk',    total: 14687  },
  { name: 'biscuit porcelain',    id: '/m/06w9k4',   total: 1634   },
  { name: 'faience',              id: '/m/02bnj5',   total: 5194   },
  { name: 'lustreware',           id: '/m/05pg1b',   total: 968    },
  { name: 'brick',                id: '/m/01g0g',    total: 7616   },
  { name: 'stucco',               id: '/m/033nbz',   total: 5963   },
  { name: 'concrete',             id: '/m/01mxf',    total: 5391   },
  { name: 'plaster',              id: '/m/01w_gm',   total: 17906  },
  // Glass
  { name: 'glass',                id: '/m/039jq',    total: 52486  },
  { name: 'stained glass',        id: '/m/011y23',   total: 4202   },
  { name: 'crystal',              id: '/m/01t4h',    total: 2863   },
  { name: 'milk glass',           id: '/m/07w219',   total: 84     },
  { name: 'murano glass',         id: '/m/0ftc03',   total: 45     },
  { name: 'lead glass',           id: '/m/02x31v',   total: 2268   },
  { name: 'fiberglass',           id: '/m/014qy5',   total: 1099   },
  { name: 'resin',                id: '/m/0g27n',    total: 5282   },
  // Textiles
  { name: 'textile',              id: '/m/0dnr7',    total: 109315 },
  { name: 'silk',                 id: '/m/0dl6q',    total: 45219  },
  { name: 'cotton',               id: '/m/095zt',    total: 17446  },
  { name: 'wool',                 id: '/m/09kxp',    total: 14334  },
  { name: 'linen',                id: '/m/0fkqd',    total: 11479  },
  { name: 'lace',                 id: '/m/0m95s',    total: 8974   },
  { name: 'velvet',               id: '/m/011ljn',   total: 7928   },
  { name: 'yarn',                 id: '/m/02kvytt',  total: 6913   },
  { name: 'cord',                 id: '/m/0b2t53',   total: 8990   },
  { name: 'satin',                id: '/m/02xhmrh',  total: 4304   },
  { name: 'brocade',              id: '/m/026c1s9',  total: 2683   },
  { name: 'felt',                 id: '/m/0158y_',   total: 2105   },
  { name: 'hessian fabric',       id: '/m/06w8z_',   total: 1119   },
  { name: 'muslin',               id: '/m/01cgyj',   total: 1611   },
  { name: 'mohair',               id: '/m/0175vp',   total: 875    },
  { name: 'twill',                id: '/m/02xhmpq',  total: 929    },
  { name: 'damask',               id: '/m/04m908',   total: 767    },
  { name: 'taffeta',              id: '/m/080j18',   total: 904    },
  { name: 'chiffon',              id: '/m/08h11d',   total: 530    },
  { name: 'gauze',                id: '/m/0bzzvg',   total: 480    },
  { name: 'chintz',               id: '/m/06f_6h',   total: 133    },
  { name: 'jute',                 id: '/m/01xj7m',   total: 431    },
  { name: 'rope',                 id: '/m/01xc8d',   total: 1387   },
  // Wood
  { name: 'wood',                 id: '/m/083vt',    total: 92678  },
  { name: 'oak',                  id: '/m/09wzt',    total: 2894   },
  { name: 'walnut',               id: '/m/015_77',   total: 3331   },
  { name: 'maple',                id: '/m/0cffdh',   total: 792    },
  { name: 'teak',                 id: '/m/01s5tq',   total: 217    },
  { name: 'mahogany',             id: '/m/0c7cd',    total: 1573   },
  { name: 'ebony',                id: '/m/0194pb',   total: 1146   },
  { name: 'pine',                 id: '/m/09t57',    total: 1679   },
  { name: 'cherry',               id: '/m/0f8sw',    total: 291    },
  { name: 'eucalyptus',           id: '/m/0d7gy',    total: 213    },
  { name: 'beech',                id: '/m/015_vx',   total: 712    },
  { name: 'birch',                id: '/m/0hpx4',    total: 356    },
  { name: 'willow',               id: '/m/0mw_6',    total: 93     },
  { name: 'spruce',               id: '/m/016x44',   total: 697    },
  { name: 'fir',                  id: '/m/016x4z',   total: 235    },
  { name: 'olive',                id: '/m/03l9pw',   total: 338    },
  { name: 'tulipwood',            id: '/m/07_yv6',   total: 437    },
  // Plastic & synthetic
  { name: 'plastic',              id: '/m/05z87',    total: 59854  },
  { name: 'polyester',            id: '/m/09hb3s',   total: 1964   },
  { name: 'nylon',                id: '/m/05d6r',    total: 752    },
  { name: 'polyurethane',         id: '/m/0cym6',    total: 316    },
  { name: 'polypropylene',        id: '/m/01cnhn',   total: 336    },
  { name: 'epoxy',                id: '/m/01f0y0',   total: 1288   },
  { name: 'polycarbonate',        id: '/m/02mqs4',   total: 729    },
  { name: 'polystyrene',          id: '/m/016jr1',   total: 783    },
  { name: 'bakelite',             id: '/m/01fnt',    total: 327    },
  { name: 'celluloid',            id: '/m/0psq1',    total: 161    },
  { name: 'acrylic resin',        id: '/m/0d665k',   total: 2669   },
  { name: 'formica',              id: '/m/02p9fd',   total: 19     },
  { name: 'polyethylene',         id: '/m/0k8xc',    total: 124    },
  { name: 'natural rubber',       id: '/m/09kmv',    total: 1924   },
  // Gemstones & minerals
  { name: 'gemstone',             id: '/m/03c4j',    total: 20026  },
  { name: 'jade',                 id: '/m/01b5dy',   total: 7345   },
  { name: 'quartz',               id: '/m/069p0',    total: 3445   },
  { name: 'amber',                id: '/m/0pbc',     total: 610    },
  { name: 'diamond',              id: '/m/027_y',    total: 1073   },
  { name: 'turquoise',            id: '/m/0fgkh',    total: 1279   },
  { name: 'garnet',               id: '/m/09bz0',    total: 684    },
  { name: 'feldspar',             id: '/m/09ghj',    total: 206    },
  { name: 'hematite',             id: '/m/03pf1',    total: 449    },
  { name: 'malachite',            id: '/m/01zn3_',   total: 203    },
  { name: 'jet',                  id: '/m/02qkkn',   total: 139    },
  { name: 'sapphire',             id: '/m/0797j',    total: 267    },
  { name: 'emerald',              id: '/m/02qv1',    total: 488    },
  { name: 'topaz',                id: '/m/07qmk',    total: 88     },
  { name: 'lapis lazuli',         id: '/m/0c51n',    total: 567    },
  { name: 'nephrite',             id: '/m/025rpbz',  total: 2157   },
  { name: 'jadeite',              id: '/m/03w1p7',   total: 574    },
  { name: 'onyx',                 id: '/m/01s85q',   total: 424    },
  { name: 'jasper',               id: '/m/0k059',    total: 590    },
  { name: 'amethyst',             id: '/m/0p7h',     total: 383    },
  { name: 'agate',                id: '/m/0qjx',     total: 962    },
  { name: 'pearl',                id: '/m/05_8m',    total: 3322   },
  { name: 'nacre',                id: '/m/0237xf',   total: 2479   },
  // Other natural materials
  { name: 'ivory',                id: '/m/03xgl',    total: 8931   },
  { name: 'bone',                 id: '/m/01b92',    total: 12441  },
  { name: 'leather',              id: '/m/04lbp',    total: 11506  },
  { name: 'wax',                  id: '/m/0fy__',    total: 1790   },
  { name: 'beeswax',              id: '/m/0bxq8',    total: 151    },
  { name: 'bark',                 id: '/m/016v85',   total: 1423   },
  { name: 'leaf',                 id: '/m/09t49',    total: 1724   },
  { name: 'root',                 id: '/m/0flg6',    total: 118    },
  { name: 'tooth',                id: '/m/0cnxs6x',  total: 920    },
  { name: 'tusk',                 id: '/m/01n_j_',   total: 779    },
  { name: 'cork',                 id: '/m/0k1ps',    total: 272    },
  // Other media
  { name: 'sculpture',            id: '/m/06msq',    total: 28774  },
  { name: 'adhesive',             id: '/m/0z49',     total: 4485   },
  { name: 'rhinestone',           id: '/m/04wy1k',   total: 950    },
  { name: 'adobe',                id: '/m/0h_4',     total: 15     },
];

// The /api/entity/assets endpoint returns HTTP 500 for offsets ≥ ~5000,
// regardless of an entity's actual total. This constant caps the usable range.
// To lift the cap once full pagination is available, remove the Math.min() call
// in getAccessibleCount() and delete this constant.
const ENTITY_MAX_OFFSET = 4800;

/**
 * Returns the number of artworks accessible for an entity given current API limits.
 * Capped at ENTITY_MAX_OFFSET due to server-side offset restrictions.
 * When full pagination becomes available: return Math.max(0, entity.total - 18)
 *
 * Entities with total ≤ 18 return 0. These are excluded from weighted selection
 * (they have zero weight) and will never be picked by weightedRandomEntity(). This
 * is intentional: with only a handful of artworks we can't meaningfully randomize
 * the offset, so they're treated as inaccessible for selection purposes.
 * Examples: pavonazzo marble (15), adobe (15).
 */
function getAccessibleCount(entity) {
  return Math.min(ENTITY_MAX_OFFSET, Math.max(0, entity.total - 18));
}

/**
 * Pick a random entity from an array, weighted by each entity's accessible artwork count.
 * This gives approximately uniform distribution across individual artwork positions:
 * each position has probability 1/totalAccessible, regardless of which entity it belongs to.
 * Entities with getAccessibleCount() == 0 are effectively excluded (zero weight).
 */
function weightedRandomEntity(entities) {
  const total = entities.reduce((sum, e) => sum + getAccessibleCount(e), 0);
  let r = Math.random() * total;
  for (const entity of entities) {
    r -= getAccessibleCount(entity);
    if (r <= 0) return entity;
  }
  return entities[entities.length - 1];
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

  const entity = weightedRandomEntity(candidates);
  const maxOffset = getAccessibleCount(entity);
  const offset = Math.floor(Math.random() * maxOffset);
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
