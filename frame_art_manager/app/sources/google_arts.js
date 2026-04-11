const axios = require('axios');
const sharp = require('sharp');
const { CookieJar } = require('tough-cookie');
const { dezoomify } = require('../utils/dezoomify');
const { googleCdnSuffix } = require('../utils/thumbSize');

const { mergePreferContent } = require('../utils/merge');

// Object types to exclude by default during random selection.
// Matched case-insensitively against the 'Type' structured field from /api/asset.
// Add values here (or via the UI) as new unwanted types are encountered.
const DEFAULT_EXCLUDED_TYPES = ['folio', 'leaf', 'bound volume', 'manuscript', 'codex', 'book'];

// All art medium entities listed on artsandculture.google.com/category/medium,
// identified by Google/Freebase Knowledge Graph IDs. Discovered via BFS through the
// "related mediums" links returned by /api/entity for each medium.
//
// 'total' is the approximate item count as reported by the entity API at time of
// discovery (recorded 2026-03-07). These values are used for weighted random
// selection — entities with more artworks are proportionally more likely to be chosen,
// giving approximately uniform distribution across all artwork positions.
//
// WHY HARDCODED: Fetching live totals for all 203 entities at startup triggers
// HTTP 429 rate limiting from Google's API, making the source unusable. The totals
// grow slowly over time so slight staleness has negligible practical impact on
// distribution quality. If counts become significantly wrong, update them by running
// a one-time probe against the API (see docs/GOOGLE_ARTS_API.md).
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

// Categories grouping MEDIUM_ENTITIES for display and filtering.
// Used by the web source settings dialog to present a categorized checkbox list.
// Category names and membership mirror the section comments in MEDIUM_ENTITIES above.
//
// IMPORTANT: If you add or remove entries in MEDIUM_ENTITIES, update MEDIUM_CATEGORIES
// accordingly to keep them in sync.
const MEDIUM_CATEGORIES = [
  { name: 'Paints & Pigments',    media: ['oil paint', 'watercolor painting', 'acrylic paint', 'tempera', 'gouache', 'vitreous enamel', 'distemper', 'spray painting', 'oil pastel', 'encaustic painting', 'pigment', 'dye', 'cinnabar', 'azurite', 'cochineal', 'varnish', 'lacquer'] },
  { name: 'Drawing Media',        media: ['ink', 'india ink', 'graphite', 'pencil', 'pen', 'drawing', 'charcoal', 'chalk', 'colored pencil', 'crayon', 'sanguine', 'conté'] },
  { name: 'Printmaking',          media: ['engraving', 'etching'] },
  { name: 'Paper & Supports',     media: ['canvas', 'photographic paper', 'photograph', 'paper negative', 'calotype', 'laid paper', 'vellum', 'tracing paper', 'rice paper', 'cardboard', 'masonite', 'book'] },
  { name: 'Metals',               media: ['metal', 'gold', 'gold leaf', 'silver', 'bronze', 'iron', 'copper', 'brass', 'steel', 'lead', 'tin', 'platinum', 'aluminium', 'wire', 'sterling silver', 'cast iron', 'wrought iron', 'pewter', 'stainless steel', 'sheet metal', 'neon', 'cobalt', 'zinc', 'nickel', 'foil', 'chromium', 'manganese', 'mercury', 'titanium'] },
  { name: 'Stone',                media: ['rock', 'marble', 'granite', 'limestone', 'sandstone', 'slate', 'pebble', 'diorite', 'basalt', 'obsidian', 'quartzite', 'andesite', 'schist', 'flint', 'soapstone', 'alabaster', 'travertine', 'carrara marble', 'parian marble', 'pavonazzo marble'] },
  { name: 'Ceramics & Clay',      media: ['clay', 'ceramic', 'porcelain', 'stoneware', 'terracotta', 'pottery', 'biscuit porcelain', 'faience', 'lustreware', 'brick', 'stucco', 'concrete', 'plaster'] },
  { name: 'Glass',                media: ['glass', 'stained glass', 'crystal', 'milk glass', 'murano glass', 'lead glass', 'fiberglass', 'resin'] },
  { name: 'Textiles',             media: ['textile', 'silk', 'cotton', 'wool', 'linen', 'lace', 'velvet', 'yarn', 'cord', 'satin', 'brocade', 'felt', 'hessian fabric', 'muslin', 'mohair', 'twill', 'damask', 'taffeta', 'chiffon', 'gauze', 'chintz', 'jute', 'rope'] },
  { name: 'Wood',                 media: ['wood', 'oak', 'walnut', 'maple', 'teak', 'mahogany', 'ebony', 'pine', 'cherry', 'eucalyptus', 'beech', 'birch', 'willow', 'spruce', 'fir', 'olive', 'tulipwood'] },
  { name: 'Plastic & Synthetic',  media: ['plastic', 'polyester', 'nylon', 'polyurethane', 'polypropylene', 'epoxy', 'polycarbonate', 'polystyrene', 'bakelite', 'celluloid', 'acrylic resin', 'formica', 'polyethylene', 'natural rubber'] },
  { name: 'Gemstones & Minerals', media: ['gemstone', 'jade', 'quartz', 'amber', 'diamond', 'turquoise', 'garnet', 'feldspar', 'hematite', 'malachite', 'jet', 'sapphire', 'emerald', 'topaz', 'lapis lazuli', 'nephrite', 'jadeite', 'onyx', 'jasper', 'amethyst', 'agate', 'pearl', 'nacre'] },
  { name: 'Other Natural Materials', media: ['ivory', 'bone', 'leather', 'wax', 'beeswax', 'bark', 'leaf', 'root', 'tooth', 'tusk', 'cork'] },
  { name: 'Other Media',          media: ['sculpture', 'adhesive', 'rhinestone', 'adobe'] },
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
 * Pick a random entity from an array, weighted by each entity's accessible artwork count
 * (using the hardcoded totals in MEDIUM_ENTITIES). This gives approximately uniform
 * distribution across individual artwork positions: each position has probability
 * 1/totalAccessible, regardless of which entity it belongs to.
 * Entities with getAccessibleCount() == 0 are effectively excluded (zero weight).
 */
function weightedRandomEntity(entities) {
  const total = entities.reduce((sum, e) => sum + getAccessibleCount(e), 0);
  if (total === 0) return entities[Math.floor(Math.random() * entities.length)];
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

// No -c suffix: Google preserves the original aspect ratio (fit-within, no crop).
// Sizing via googleCdnSuffix(): picks =wN or =hN based on whether the source is wider
// or narrower than the target aspect ratio, using shared headroom constants from thumbSize.js.

/**
 * Build a Google image-serving URL that downloads at original aspect ratio with
 * enough resolution for the processing pipeline to cover-crop to native 4K after
 * frame removal.
 *
 * @param {string} imageBase - Image base URL (no size suffix)
 * @param {number|null} aspectRatio - width/height (from cobject metadata), or null if unknown
 */
function buildDownloadUrl(imageBase, aspectRatio) {
  return `${imageBase}${googleCdnSuffix(aspectRatio)}`;
}

const HTTP_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
};

/**
 * Axios client that maintains a persistent cookie jar for artsandculture.google.com.
 * Google rate-limits cookieless clients aggressively; session cookies obtained by
 * visiting the homepage can reduce 429s over time.
 *
 * Note: if the IP is already rate-limited, cookies cannot be obtained (the seed
 * request itself returns 429). In that case the client operates without cookies
 * until the rate limit expires. A 429 on an API call (not a seed attempt) marks
 * the cookies as potentially stale so the next fetch re-seeds.
 */
const cookieJar = new CookieJar();
const cookieClient = axios.create();
let _cookiesSeeded = false;
let _seedInProgress = false;

cookieClient.interceptors.request.use(async config => {
  const cookies = await cookieJar.getCookies(config.url || '');
  if (cookies.length > 0) {
    config.headers = config.headers || {};
    config.headers.Cookie = cookies.map(c => c.cookieString()).join('; ');
  }
  return config;
});

async function storeCookies(url, setCookieHeader) {
  if (!url || !setCookieHeader) return;
  const headers = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  for (const header of headers) {
    try { await cookieJar.setCookie(header, url); } catch { /* ignore malformed */ }
  }
}

cookieClient.interceptors.response.use(
  async response => {
    await storeCookies(response.config.url, response.headers['set-cookie']);
    return response;
  },
  async error => {
    if (error.config && error.response) {
      await storeCookies(error.config.url, error.response.headers['set-cookie']);
      // Only mark cookies stale on 429 from API calls, not from the seed request
      // itself — otherwise we'd generate extra requests and compound the rate limit.
      if (error.response.status === 429 && !_seedInProgress) {
        await cookieJar.removeAllCookies();
        _cookiesSeeded = false;
        console.log('[google_arts] 429 on API call — cookies cleared, will re-seed next fetch');
      }
    }
    return Promise.reject(error);
  }
);

/**
 * Make a single GET to the Google Arts homepage to seed session cookies.
 * Called once per process (or after an API 429 clears the jar). Non-fatal if it
 * fails (e.g. if the IP is already rate-limited — seeding is skipped gracefully).
 */
async function seedCookies() {
  if (_cookiesSeeded || _seedInProgress) return;
  _seedInProgress = true;
  try {
    await cookieClient.get(BASE_URL, {
      headers: { ...HTTP_HEADERS, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
      timeout: 10000,
    });
    _cookiesSeeded = true;
    console.log('[google_arts] Cookies seeded from artsandculture.google.com');
  } catch (err) {
    // Don't retry on 429 — the IP is rate-limited, extra requests make it worse
    const status = err.response?.status;
    if (status === 429) {
      console.warn('[google_arts] Cookie seeding skipped — IP is rate-limited (429)');
    } else {
      console.warn('[google_arts] Cookie seeding failed (non-fatal):', err.message);
    }
  } finally {
    _seedInProgress = false;
  }
}

// --- Artist entity resolution ---

// TTL for artist entity ID and count caches (24 hours).
const ARTIST_ENTITY_TTL_MS = 24 * 60 * 60 * 1000;

// Maximum offset for artist entity browsing. API returns HTTP 500 at offsets >= 5000;
// 1000 is a conservative cap that still allows wide sampling for large artists.
const ARTIST_MAX_OFFSET = 1000;

// in-memory cache: name.toLowerCase() → { entityId, resolvedName, fetchedAt }
const _artistEntityCache = new Map();
// in-memory cache: entityId → { count, fetchedAt }
const _artistCountCache  = new Map();
// suggest cache: query.toLowerCase() → { results, fetchedAt }. 1-hour TTL.
const ARTIST_SUGGEST_TTL_MS = 60 * 60 * 1000;
const _artistSuggestCache = new Map();

/**
 * Recursively extract artist entity cobjects from a parsed Google Arts API response.
 *
 * Artist cobjects share the stella.common.cobject structure with artwork cobjects but
 * are distinguished by cobject[5] === 3 (typeCode for people/artists) and have a
 * Google Knowledge Graph entity ID at cobject[24][0] (e.g. "/m/01xnj").
 * Their cobject[4] link is an /entity/ path rather than /asset/.
 */
function extractArtistCobjects(obj, depth = 0) {
  const results = [];
  if (depth > 15 || !obj) return results;
  if (Array.isArray(obj)) {
    if (obj[0] === 'stella.common.cobject') {
      if (obj[5] === 3 && Array.isArray(obj[24]) && obj[24][0]) {
        results.push({ name: obj[1] || null, entityId: obj[24][0] });
      }
      // Don't descend into cobjects — nested items are unrelated data
      return results;
    }
    for (const item of obj) {
      results.push(...extractArtistCobjects(item, depth + 1));
    }
  }
  return results;
}

/**
 * Resolve an artist name to a Google Arts & Culture entity ID via /api/search.
 * Picks the best match from typeCode=3 (artist/person) cobjects in the search response.
 * Caches results for 24 hours. Returns null if no artist entity is found.
 *
 * IMPORTANT: Entity IDs come from Google Arts search, not external databases like
 * Wikipedia/Freebase — the IDs differ and cross-source IDs will 404.
 *
 * @param {string} name - Artist name to resolve (e.g. "Claude Monet" or "Monet")
 * @returns {string|null} Google Arts entity ID (e.g. "/m/01xnj"), or null if unresolved
 */
async function resolveArtistEntity(name) {
  const key = name.toLowerCase().trim();
  const cached = _artistEntityCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < ARTIST_ENTITY_TTL_MS) {
    return cached.entityId;
  }

  await seedCookies();
  let entityId = null;
  let resolvedName = null;

  let apiResponded = false;
  try {
    const response = await cookieClient.get(`${BASE_URL}/api/search`, {
      params: { q: name, hl: 'en' },
      headers: { ...HTTP_HEADERS, Accept: 'application/json, text/plain, */*' },
      timeout: 15000,
      responseType: 'text',
    });
    const parsed = parseApiResponse(response.data);
    const candidates = extractArtistCobjects(parsed);
    if (candidates.length > 0) {
      // Prefer exact name match, then substring, then first result
      const exact = candidates.find(c => (c.name || '').toLowerCase() === key);
      const sub   = candidates.find(c => (c.name || '').toLowerCase().includes(key));
      const best  = exact || sub || candidates[0];
      entityId    = best.entityId;
      resolvedName = best.name;
      console.log(`[google_arts] Artist "${name}" resolved to "${resolvedName}" (${entityId})`);
    } else {
      console.warn(`[google_arts] No artist entity found in search results for "${name}"`);
    }
    apiResponded = true;
  } catch (err) {
    console.warn(`[google_arts] Artist entity resolution failed for "${name}": ${err.message}`);
  }

  if (apiResponded) {
    _artistEntityCache.set(key, { entityId, resolvedName, fetchedAt: Date.now() });
  }
  return entityId;
}

/**
 * Fetch the total artwork count for a Google Arts entity from /api/entity.
 * The count is at parsed[0][0][9][4] in the response. Cached for 24 hours.
 *
 * @param {string} entityId - Google Arts entity ID (e.g. "/m/01xnj")
 * @returns {number} Artwork count, or 0 on failure
 */
async function getArtistEntityCount(entityId) {
  const cached = _artistCountCache.get(entityId);
  if (cached && Date.now() - cached.fetchedAt < ARTIST_ENTITY_TTL_MS) {
    return cached.count;
  }

  let count = 0;
  let apiResponded = false;
  try {
    const response = await cookieClient.get(`${BASE_URL}/api/entity`, {
      params: { entityId, hl: 'en', rt: 'j' },
      headers: { ...HTTP_HEADERS, Accept: 'application/json, text/plain, */*' },
      timeout: 15000,
      responseType: 'text',
    });
    const parsed = parseApiResponse(response.data);
    const raw = parsed?.[0]?.[0]?.[9]?.[4];
    if (typeof raw === 'number') {
      count = raw;
      console.log(`[google_arts] Artist entity ${entityId}: ${count} artworks total`);
    }
    apiResponded = true;
  } catch (err) {
    console.warn(`[google_arts] Failed to fetch artwork count for entity ${entityId}: ${err.message}`);
  }

  if (apiResponded) {
    _artistCountCache.set(entityId, { count, fetchedAt: Date.now() });
  }
  return count;
}

/**
 * Fetch a random artwork from a specific Google Arts artist entity.
 * Browses /api/entity/assets with categoryId=artist for paginated artist-scoped results.
 *
 * @param {string} entityId - Google Arts artist entity ID (e.g. "/m/01xnj")
 * @param {number} count - Total artwork count reported by /api/entity
 * @param {object} [options]
 * @param {'all'|'landscape'|'portrait'} [options.aspectRatio='all']
 * @param {string[]} [options.excludedTypesLower=[]]
 * @param {Set<string>[]} [options.requireMediaSets=[]]
 * @param {Set<string>} [options.excludeMediaValues=new Set()]
 * @returns {{ imageBuffer, contentType, metadata }}
 */
async function fetchFromArtistEntity(entityId, count, {
  aspectRatio = 'all',
  excludedTypesLower = [],
  requireMediaSets = [],
  excludeMediaValues = new Set(),
} = {}) {
  const maxOffset = Math.min(count > 0 ? count - 1 : 0, ARTIST_MAX_OFFSET);
  const MAX_ATTEMPTS = 5;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const offset = maxOffset > 0 ? Math.floor(Math.random() * maxOffset) : 0;
    const pt = buildPtToken(offset);

    let parsed;
    try {
      const response = await cookieClient.get(`${BASE_URL}/api/entity/assets`, {
        params: { entityId, categoryId: 'artist', s: 18, pt, hl: 'en', rt: 'j' },
        headers: { ...HTTP_HEADERS, Accept: 'application/json, text/plain, */*' },
        timeout: 15000,
        responseType: 'text',
      });
      parsed = parseApiResponse(response.data);
    } catch (err) {
      console.warn(`[google_arts] Artist entity browse attempt ${attempt + 1} failed for ${entityId}: ${err.message}`);
      continue;
    }

    let artworks = extractArtworks(parsed);
    if (artworks.length === 0) {
      console.warn(`[google_arts] Artist entity browse attempt ${attempt + 1}: no artworks at offset ${offset} for ${entityId}`);
      continue;
    }

    // Filter by aspect ratio using pre-download ratio from cobject metadata.
    if (aspectRatio !== 'all') {
      artworks = artworks.filter(a => {
        if (a.aspectRatio === null) return false;
        if (aspectRatio === 'landscape') return a.aspectRatio > 1;
        if (aspectRatio === 'portrait') return a.aspectRatio < 1;
        return true;
      });
      if (artworks.length === 0) {
        console.warn(`[google_arts] Artist entity browse attempt ${attempt + 1}: no ${aspectRatio} artworks at offset ${offset}`);
        continue;
      }
    }

    const artwork = artworks[Math.floor(Math.random() * artworks.length)];
    const imageUrl = buildDownloadUrl(artwork.imageBase, artwork.aspectRatio);
    const artworkUrl = `${BASE_URL}${artwork.link}`;

    const detailsPromise = fetchAssetDetails(artwork.assetId);
    if (excludedTypesLower.length > 0 || excludeMediaValues.size > 0) {
      const earlyDetails = await detailsPromise;

      if (excludedTypesLower.length > 0) {
        const artworkType = (earlyDetails.type || '').toLowerCase();
        if (excludedTypesLower.includes(artworkType)) {
          console.warn(`[google_arts] Artist entity browse attempt ${attempt + 1}: skipping excluded type "${earlyDetails.type}" ("${artwork.title}")`);
          continue;
        }
      }

      if (excludeMediaValues.size > 0) {
        const entityNames = (earlyDetails.mediumEntities || '').split('; ').filter(Boolean).map(n => n.toLowerCase());
        if (entityNames.some(n => excludeMediaValues.has(n))) {
          console.warn(`[google_arts] Artist entity browse attempt ${attempt + 1}: skipping "${artwork.title}" — medium entity matches exclude filter`);
          continue;
        }
      }
    }

    const imageResponse = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      headers: HTTP_HEADERS,
      timeout: 30000,
    }).catch(err => { throw new Error(`Failed to download artist entity artwork: ${err.message}`); });

    const details = await detailsPromise;
    let imageBuffer = Buffer.from(imageResponse.data);
    const contentType = imageResponse.headers['content-type'] || 'image/jpeg';

    const [targetW, targetH] = aspectRatio === 'portrait' ? [2160, 3840] : [3840, 2160];
    const { width: dlW, height: dlH } = await sharp(imageBuffer).metadata();
    if (dlW < targetW || dlH < targetH) {
      console.log(`[google_arts] Artist entity image is ${dlW}×${dlH} (below ${targetW}×${targetH}); attempting dezoomify for ${artworkUrl}`);
      const dezoomedBuffer = await dezoomify(artworkUrl, { maxWidth: 4801 });
      if (dezoomedBuffer) {
        imageBuffer = dezoomedBuffer;
        console.log(`[google_arts] dezoomify succeeded for ${artworkUrl}`);
      } else {
        console.log(`[google_arts] dezoomify unavailable or failed; using ${dlW}×${dlH} image`);
      }
    }

    return {
      imageBuffer,
      contentType,
      metadata: {
        ...mergePreferContent(
          { title: artwork.title, creator: artwork.creator, repository: artwork.repository, color: artwork.color },
          details,
        ),
        artworkUrl,
        source: 'Google Arts & Culture',
      },
    };
  }

  throw new Error(`Could not find a${aspectRatio !== 'all' ? ` ${aspectRatio}` : 'n'} artwork from artist entity ${entityId} after ${MAX_ATTEMPTS} attempts`);
}

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
 * cobject[8]  = dominant color hex string (e.g. "#17120c").
 * cobject[10] = image metadata sub-array: [0]=assetId, [1]=aspectRatio, [12]=repository.
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
      const meta = Array.isArray(obj[10]) ? obj[10] : [];
      artworks.push({
        title: obj[1] || null,
        creator: obj[2] || null,
        imageBase,
        link: obj[4],
        assetId: meta[0] || null,
        aspectRatio: typeof meta[1] === 'number' ? meta[1] : null,  // width / height
        repository: meta[12] || null,
        color: typeof obj[8] === 'string' ? obj[8] : null,           // dominant color hex
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
 * Parse the structured metadata fields from a stella.av[12] array (from /api/asset).
 * Each entry is [label, values, ...] where values is an array of [displayText, ...].
 * Returns a flat object mapping label strings to joined value strings.
 *
 * Known labels (not exhaustive — vary by artwork and institution):
 *   "Title", "Creator", "Creator Lifespan", "Creator Nationality", "Creator Gender",
 *   "Date Created", "Type" (medium/technique), "Physical Dimensions",
 *   "tag / style", "Rights", "Artist biographical information",
 *   "Additional artwork information"
 */
function parseStructuredFields(av12) {
  const fields = {};
  if (!Array.isArray(av12)) return fields;
  for (const entry of av12) {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string') continue;
    const label = entry[0];
    const values = Array.isArray(entry[1]) ? entry[1] : [];
    const textValues = values
      .filter(v => Array.isArray(v) && typeof v[0] === 'string')
      .map(v => v[0].trim())
      .filter(Boolean);
    if (textValues.length > 0) fields[label] = textValues.join('; ');
  }
  return fields;
}

/**
 * Fetch extended metadata for an artwork via the /api/asset endpoint.
 *
 * Returns a subset of the stella.av structured fields:
 *   dateCreated       — from av[3] or structured "Date Created"
 *   medium            — from structured "Type" (e.g. "Oil on canvas"), more specific
 *                       than the entity-based medium used as fallback
 *   creatorNationality — from structured "Creator Nationality"
 *   dimensions        — from structured "Physical Dimensions"
 *   description       — from av[5][1] with HTML tags stripped
 *
 * Returns {} on network failure or unexpected response structure.
 */
/**
 * Parse all available metadata fields from a stella.av block.
 * Used by both fetchAssetDetails and fetchByIdentifier so extraction logic
 * stays in one place. Returns the subset of FIELD_DEFS fields that come from
 * the API response (excludes color/source/artworkUrl which are added by callers).
 *
 * @param {Array} av - The stella.av array from the parsed API response
 * @returns {object} Extracted metadata fields (values are strings or null)
 */
/**
 * Parse entity associations from stella.av[21] — an array of cobjects representing
 * entities linked to the artwork (artist, art movement, medium, etc.).
 *
 * Each cobject has a trailing metadata tuple [null, ["assetpage_chips", "<category>", "<kgId>", <index>]]
 * where category is one of: "entity/ARTIST", "entity/ART_MOVEMENT", "entity/ART_MEDIUM".
 * The KG ID (e.g. "/m/031cgw") is in cobject[7] and matches MEDIUM_ENTITIES IDs.
 *
 * @param {Array} av21 - The stella.av[21] array
 * @returns {{ mediumEntities: string[], artMovements: string[] }}
 */
function parseEntityAssociations(av21) {
  const artists = [];
  const mediumEntities = [];
  const artMovements = [];
  if (!Array.isArray(av21)) return { artists, mediumEntities, artMovements };
  for (const co of av21) {
    if (!Array.isArray(co) || co[0] !== 'stella.common.cobject') continue;
    const name = co[1];
    // Category is embedded in the trailing metadata tuple
    const chipsMeta = Array.isArray(co[22]) ? co[22] : null;
    const category = chipsMeta?.[1]?.[1]; // e.g. "entity/ARTIST", "entity/ART_MEDIUM", "entity/ART_MOVEMENT"
    if (category === 'entity/ARTIST') {
      artists.push(name);
    } else if (category === 'entity/ART_MEDIUM') {
      mediumEntities.push(name);
    } else if (category === 'entity/ART_MOVEMENT') {
      artMovements.push(name);
    }
  }
  return { artists, mediumEntities, artMovements };
}

const HTML_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
  mdash: '—', ndash: '–', lsquo: '\u2018', rsquo: '\u2019',
  ldquo: '\u201c', rdquo: '\u201d', hellip: '…', copy: '©',
  reg: '®', trade: '™', deg: '°',
};
function decodeHtmlEntities(str) {
  return str
    .replace(/&([a-zA-Z]+);/g, (_, name) => HTML_ENTITIES[name.toLowerCase()] ?? _)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));
}

// Decode HTML entities in a structured text field value (not for URL-type fields).
function dt(value) {
  return value ? decodeHtmlEntities(value) : null;
}

function parseAvBlock(av) {
  const structured = parseStructuredFields(av[12]);
  const rawDesc = Array.isArray(av[5]) ? av[5][1] : null;
  const description = typeof rawDesc === 'string'
    ? decodeHtmlEntities(rawDesc.replace(/<[^>]+>/g, '').trim()) || null
    : null;
  const { artists, mediumEntities, artMovements } = parseEntityAssociations(av[21]);
  return {
    title:              dt(structured['Title']),
    // Some artworks omit "Creator" from structured fields but have an ARTIST entity in av[21].
    creator:            dt(structured['Creator']) || (artists.length > 0 ? artists[0] : null),
    dateCreated:        dt(av[3] || structured['Date Created']),
    type:               dt(structured['Type']),
    medium:             dt(structured['Medium']),
    mediumEntities:     mediumEntities.length > 0 ? mediumEntities.join('; ') : null,
    artMovement:        artMovements.length > 0 ? artMovements.join('; ') : null,
    creatorNationality: dt(structured['Creator Nationality']),
    creatorLifespan:    dt(structured['Creator Lifespan']),
    creatorGender:      dt(structured['Creator Gender']),
    style:              dt(structured['tag / style']),
    repository:         dt(structured['Repository']),
    dimensions:         dt(structured['Physical Dimensions']),
    rights:             dt(structured['Rights']),
    artistBio:          dt(structured['Artist biographical information']),
    additionalInfo:     dt(structured['Additional artwork information']),
    description,
  };
}

async function fetchAssetDetails(assetId) {
  if (!assetId) return {};

  let parsed;
  try {
    const response = await cookieClient.get(`${BASE_URL}/api/asset`, {
      params: { assetId, hl: 'en', rt: 'j' },
      headers: { ...HTTP_HEADERS, Accept: 'application/json, text/plain, */*' },
      timeout: 15000,
      responseType: 'text',
    });
    parsed = parseApiResponse(response.data);
  } catch (err) {
    console.warn(`[google_arts] Failed to fetch asset details for "${assetId}": ${err.message}`);
    return {};
  }

  const ap = parsed?.[0]?.[0];
  if (!Array.isArray(ap) || ap[0] !== 'stella.ap') {
    console.warn(`[google_arts] Unexpected response type for asset "${assetId}": ${ap?.[0]}`);
    return {};
  }

  const av = ap[2]; // stella.av
  if (!Array.isArray(av) || av[0] !== 'stella.av') return {};

  return parseAvBlock(av);
}

/**
 * Fetch a random artwork from Google Arts & Culture.
 *
 * Uses the /api/entity/assets endpoint with a weighted-random medium entity and
 * a random offset, giving approximately uniform distribution across all accessible
 * artwork positions. Entities are weighted by accessible item count so larger
 * collections are proportionally more likely to be selected.
 *
 * Aspect ratio filtering is applied before downloading using cobject[10][1] — the
 * original image aspect ratio (width/height) returned by the API. This avoids
 * discarding already-downloaded images. If no artwork on a fetched page matches the
 * filter, a new entity and offset are tried on the next attempt.
 *
 * @param {Array<{type: string, mode: 'require'|'exclude', values: string[]}>} [filters=[]]
 *   Filter objects applied to the candidate entity pool and/or post-fetch type check.
 *   Supported filter types:
 *   - 'media' + 'require': restrict entity pool to names in values (intersection if multiple).
 *   - 'media' + 'exclude': remove named entities from the pool (union across multiple).
 *   - 'objectType' + 'exclude': skip artworks whose Type field matches any value
 *     (case-insensitive). When non-empty, asset details are fetched before the image
 *     download so excluded artworks never waste bandwidth. If no objectType-exclude
 *     filter is supplied, the source's default excluded types are applied.
 * @param {object} [options]
 * @param {'all'|'landscape'|'portrait'} [options.aspectRatio='all'] - Filter by aspect ratio.
 *   'landscape' = width > height (ratio > 1). 'portrait' = height > width (ratio < 1).
 *   Artworks with no ratio metadata are excluded when filtering is active.
 *
 * @returns {{ imageBuffer, contentType, metadata }} — metadata contains all fields defined in FIELD_DEFS plus artworkUrl.
 * @throws {Error} If the filters match no known media, or on network/API failure.
 */

/**
 * Fetch a random artwork using /api/search.
 * The search endpoint returns ~56–144 fixed results for a given query.
 * We pick a random artwork from the result set.
 *
 * @param {string} query - Search query string
 * @param {object} [options]
 * @param {'all'|'landscape'|'portrait'} [options.aspectRatio='all'] - Aspect ratio filter
 * @param {string[]} [options.excludedTypesLower=[]] - Lowercase objectType values to exclude
 * @param {Set<string>[]} [options.requireMediaSets=[]] - Each set contains lowercase entity names;
 *   artwork must have at least one medium entity in ALL sets (intersection).
 *   Artworks with no medium entities are rejected (require = must have field + match).
 * @param {Set<string>} [options.excludeMediaValues=new Set()] - Lowercase entity names to exclude;
 *   artwork rejected if any of its medium entities match. Empty medium entities pass through.
 */
async function fetchFromSearch(query, { aspectRatio = 'all', excludedTypesLower = [], requireMediaSets = [], excludeMediaValues = new Set() } = {}) {
  await seedCookies();

  // Fetch the result pool once. The search endpoint returns a fixed set of ~56–144 artworks
  // for a given query regardless of how many times it is called, so there is no benefit
  // in re-fetching on every retry — just fetch once and work within the pool.
  let pool = null;
  for (let apiAttempt = 0; apiAttempt < 3; apiAttempt++) {
    try {
      const response = await cookieClient.get(`${BASE_URL}/api/search`, {
        params: { q: query, hl: 'en' },
        headers: { ...HTTP_HEADERS, Accept: 'application/json, text/plain, */*' },
        timeout: 15000,
        responseType: 'text',
      });
      const parsed = parseApiResponse(response.data);
      const artworks = extractArtworks(parsed);
      if (artworks.length > 0) {
        pool = artworks;
        break;
      }
      console.warn(`[google_arts] Search: no artworks for "${query}" (API attempt ${apiAttempt + 1})`);
    } catch (err) {
      console.warn(`[google_arts] Search API error (attempt ${apiAttempt + 1}): ${err.message}`);
    }
  }
  if (!pool) throw new Error(`No artworks found via search for "${query}"`);

  console.log(`[google_arts] Search for "${query}" returned ${pool.length} artworks`);

  // Filter by aspect ratio up front — no point trying artworks we know will fail.
  if (aspectRatio !== 'all') {
    pool = pool.filter(a => {
      if (a.aspectRatio === null) return false;
      if (aspectRatio === 'landscape') return a.aspectRatio > 1;
      if (aspectRatio === 'portrait') return a.aspectRatio < 1;
      return true;
    });
    if (pool.length === 0) {
      throw new Error(`No ${aspectRatio} artworks in search results for "${query}"`);
    }
    console.log(`[google_arts] After aspect ratio filter: ${pool.length} ${aspectRatio} artworks`);
  }

  // Shuffle the pool so we try artworks in random order on each call.
  pool = pool.slice().sort(() => Math.random() - 0.5);

  // Iterate through candidates, applying post-fetch filters where needed.
  const hasPostFilters = excludedTypesLower.length > 0 || requireMediaSets.length > 0 || excludeMediaValues.size > 0;
  const MAX_CANDIDATES = hasPostFilters ? Math.min(pool.length, 5) : 1;

  for (let i = 0; i < MAX_CANDIDATES; i++) {
    const artwork = pool[i];
    const imageUrl = buildDownloadUrl(artwork.imageBase, artwork.aspectRatio);
    const artworkUrl = `${BASE_URL}${artwork.link}`;

    // Fetch details for post-fetch filtering (objectType exclusion + media entity matching).
    const detailsPromise = fetchAssetDetails(artwork.assetId);
    if (hasPostFilters) {
      const earlyDetails = await detailsPromise;

      // objectType exclusion
      if (excludedTypesLower.length > 0) {
        const artworkType = (earlyDetails.type || '').toLowerCase();
        if (excludedTypesLower.includes(artworkType)) {
          console.warn(`[google_arts] Search candidate ${i + 1}: skipping excluded type "${earlyDetails.type}" ("${artwork.title}")`);
          continue;
        }
      }

      // Media entity filtering against av[21] controlled vocabulary
      if (requireMediaSets.length > 0 || excludeMediaValues.size > 0) {
        const entityNames = (earlyDetails.mediumEntities || '').split('; ').filter(Boolean).map(n => n.toLowerCase());

        // Require: artwork must have medium entities AND at least one must be in every require set
        if (requireMediaSets.length > 0) {
          if (entityNames.length === 0) {
            console.warn(`[google_arts] Search candidate ${i + 1}: skipping "${artwork.title}" — no medium entities (require filter active)`);
            continue;
          }
          const matchesAll = requireMediaSets.every(s => entityNames.some(n => s.has(n)));
          if (!matchesAll) {
            console.warn(`[google_arts] Search candidate ${i + 1}: skipping "${artwork.title}" — medium entities [${entityNames.join(', ')}] don't match require filter`);
            continue;
          }
        }

        // Exclude: reject if any entity matches; empty entities pass through
        if (excludeMediaValues.size > 0 && entityNames.some(n => excludeMediaValues.has(n))) {
          console.warn(`[google_arts] Search candidate ${i + 1}: skipping "${artwork.title}" — medium entity matches exclude filter`);
          continue;
        }
      }
    }

    const imageResponse = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      headers: HTTP_HEADERS,
      timeout: 30000,
    }).catch(err => { throw new Error(`Failed to download artwork image: ${err.message}`); });

    const details = await detailsPromise;

    let imageBuffer = Buffer.from(imageResponse.data);
    const contentType = imageResponse.headers['content-type'] || 'image/jpeg';

    // Dezoomify if below 4K target
    const [targetW, targetH] = aspectRatio === 'portrait' ? [2160, 3840] : [3840, 2160];
    const { width: dlW, height: dlH } = await sharp(imageBuffer).metadata();
    if (dlW < targetW || dlH < targetH) {
      console.log(`[google_arts] Search image is ${dlW}×${dlH} (below ${targetW}×${targetH} target); attempting dezoomify for ${artworkUrl}`);
      const dezoomedBuffer = await dezoomify(artworkUrl, { maxWidth: 4801 });
      if (dezoomedBuffer) {
        imageBuffer = dezoomedBuffer;
        console.log(`[google_arts] dezoomify succeeded for ${artworkUrl}`);
      } else {
        console.log(`[google_arts] dezoomify unavailable or failed; using ${dlW}×${dlH} image`);
      }
    }

    return {
      imageBuffer,
      contentType,
      metadata: {
        ...details,
        title:      artwork.title || details.title || null,
        creator:    artwork.creator || details.creator || null,
        repository: artwork.repository || details.repository || null,
        color:      artwork.color || null,
        artworkUrl,
        source: 'Google Arts & Culture',
      },
    };
  }

  throw new Error(`Could not find a matching artwork via search "${query}" after trying ${MAX_CANDIDATES} candidates`);
}

async function fetchRandomArtwork(filters = [], options = {}) {
  await seedCookies();
  const { aspectRatio = 'all' } = options;

  // Split filters by type and mode.
  // require-media: entity must appear in ALL require sets (intersection semantics).
  // exclude-media: entity excluded if it appears in ANY exclude set (union semantics).
  // objectType-exclude: type values to skip post-fetch (union across all such filters).
  // If no objectType-exclude filter is present, fall back to DEFAULT_EXCLUDED_TYPES.
  const requireMediaSets = filters
    .filter(f => f.type === 'media' && f.mode === 'require')
    .map(f => new Set((f.values || []).map(v => v.toLowerCase())));
  const excludeMediaValues = new Set(
    filters
      .filter(f => f.type === 'media' && f.mode === 'exclude')
      .flatMap(f => f.values || [])
      .map(v => v.toLowerCase())
  );
  const objectTypeExcludeFilters = filters.filter(f => f.type === 'objectType' && f.mode === 'exclude');
  const excludedTypes = objectTypeExcludeFilters.length > 0
    ? objectTypeExcludeFilters.flatMap(f => f.values || [])
    : DEFAULT_EXCLUDED_TYPES;
  const excludedTypesLower = excludedTypes.map(t => t.toLowerCase());

  // Artist mode: resolve artist name to a Google Arts entity, then browse by artist.
  // Falls back to keyword search if entity resolution fails or returns no results.
  const artistFilter = filters.find(f => f.type === 'artist' && f.mode === 'require' && f.values?.length > 0);
  if (artistFilter) {
    const artistName = artistFilter.values[0];
    const entityId = await resolveArtistEntity(artistName);
    if (entityId) {
      const count = await getArtistEntityCount(entityId);
      if (count > 0) {
        return fetchFromArtistEntity(entityId, count, { aspectRatio, excludedTypesLower, requireMediaSets, excludeMediaValues });
      }
      console.warn(`[google_arts] Artist entity ${entityId} has count=0; falling back to search`);
    } else {
      console.warn(`[google_arts] Could not resolve artist "${artistName}" to entity; falling back to search`);
    }
    return fetchFromSearch(artistName, { aspectRatio, excludedTypesLower, requireMediaSets, excludeMediaValues });
  }

  // Search mode: use /api/search instead of entity browsing.
  // Media filters are applied post-fetch against av[21] entity associations.
  const searchFilter = filters.find(f => f.type === 'search' && f.values?.length > 0);
  if (searchFilter) {
    return fetchFromSearch(searchFilter.values[0], { aspectRatio, excludedTypesLower, requireMediaSets, excludeMediaValues });
  }

  // Build candidate entity pool by applying media filters.
  let candidates = MEDIUM_ENTITIES;
  if (requireMediaSets.length > 0) {
    candidates = candidates.filter(e => requireMediaSets.every(s => s.has(e.name.toLowerCase())));
    if (candidates.length === 0) {
      throw new Error(`No known media matched require filter: ${filters.filter(f => f.type === 'media' && f.mode === 'require').flatMap(f => f.values).join(', ')}`);
    }
  }
  if (excludeMediaValues.size > 0) {
    candidates = candidates.filter(e => !excludeMediaValues.has(e.name.toLowerCase()));
  }

  const MAX_ATTEMPTS = 5;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const entity = weightedRandomEntity(candidates);
    const maxOffset = getAccessibleCount(entity);
    const offset = maxOffset > 0 ? Math.floor(Math.random() * maxOffset) : 0;
    const pt = buildPtToken(offset);

    let parsed;
    try {
      const response = await cookieClient.get(`${BASE_URL}/api/entity/assets`, {
        params: { entityId: entity.id, categoryId: 'medium', s: 18, pt, hl: 'en', rt: 'j' },
        headers: { ...HTTP_HEADERS, Accept: 'application/json, text/plain, */*' },
        timeout: 15000,
        responseType: 'text',
      });
      parsed = parseApiResponse(response.data);
    } catch (err) {
      console.warn(`[google_arts] Attempt ${attempt + 1}: failed to fetch page for "${entity.name}": ${err.message}`);
      continue;
    }

    let artworks = extractArtworks(parsed);
    if (artworks.length === 0) {
      console.warn(`[google_arts] Attempt ${attempt + 1}: no artworks for "${entity.name}" at offset ${offset}`);
      continue;
    }

    // Filter by aspect ratio using the pre-download ratio from cobject metadata.
    // Artworks without ratio metadata are excluded when a filter is active.
    if (aspectRatio !== 'all') {
      artworks = artworks.filter(a => {
        if (a.aspectRatio === null) return false;
        if (aspectRatio === 'landscape') return a.aspectRatio > 1;
        if (aspectRatio === 'portrait') return a.aspectRatio < 1;
        return true;
      });
      if (artworks.length === 0) {
        console.warn(`[google_arts] Attempt ${attempt + 1}: no ${aspectRatio} artworks on page for "${entity.name}" at offset ${offset}`);
        continue;
      }
    }

    const artwork = artworks[Math.floor(Math.random() * artworks.length)];
    const imageUrl = buildDownloadUrl(artwork.imageBase, artwork.aspectRatio);
    const artworkUrl = `${BASE_URL}${artwork.link}`;

    // Start fetching asset details immediately. When post-fetch filters are active
    // (type exclusion or media exclude), await details before downloading the image
    // so filtered artworks waste no bandwidth.
    const detailsPromise = fetchAssetDetails(artwork.assetId);
    if (excludedTypesLower.length > 0 || excludeMediaValues.size > 0) {
      const earlyDetails = await detailsPromise;

      // objectType exclusion
      if (excludedTypesLower.length > 0) {
        const artworkType = (earlyDetails.type || '').toLowerCase();
        if (excludedTypesLower.includes(artworkType)) {
          console.warn(`[google_arts] Attempt ${attempt + 1}: skipping excluded type "${earlyDetails.type}" ("${artwork.title}")`);
          continue;
        }
      }

      // Media entity exclusion (post-fetch): the entity browse pre-filters by require,
      // but an artwork on an "Oil paint" page may also have "Oak" as a medium entity.
      // Exclude checks av[21] entities to reject unwanted secondary mediums.
      if (excludeMediaValues.size > 0) {
        const entityNames = (earlyDetails.mediumEntities || '').split('; ').filter(Boolean).map(n => n.toLowerCase());
        if (entityNames.some(n => excludeMediaValues.has(n))) {
          console.warn(`[google_arts] Attempt ${attempt + 1}: skipping "${artwork.title}" — medium entity matches exclude filter`);
          continue;
        }
      }
    }

    const imageResponse = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      headers: HTTP_HEADERS,
      timeout: 30000,
    }).catch(err => { throw new Error(`Failed to download artwork image: ${err.message}`); });

    const details = await detailsPromise;

    let imageBuffer = Buffer.from(imageResponse.data);
    const contentType = imageResponse.headers['content-type'] || 'image/jpeg';

    // Check if the downloaded image can cover the TV's 4K target without upscaling.
    // The target depends on orientation: portrait filter → portrait TV (2160×3840);
    // otherwise → landscape TV (3840×2160). Cover-fit requires imageW >= targetW AND
    // imageH >= targetH. If either is short, dezoomify-rs can fetch tiles at higher zoom.
    const [targetW, targetH] = aspectRatio === 'portrait' ? [2160, 3840] : [3840, 2160];
    const { width: dlW, height: dlH } = await sharp(imageBuffer).metadata();
    if (dlW < targetW || dlH < targetH) {
      console.log(`[google_arts] Image is ${dlW}×${dlH} (below ${targetW}×${targetH} target); attempting dezoomify for ${artworkUrl}`);
      const dezoomedBuffer = await dezoomify(artworkUrl, { maxWidth: 4801 });
      if (dezoomedBuffer) {
        imageBuffer = dezoomedBuffer;
        console.log(`[google_arts] dezoomify succeeded for ${artworkUrl}`);
      } else {
        console.log(`[google_arts] dezoomify unavailable or failed; using ${dlW}×${dlH} image`);
      }
    }

    return {
      imageBuffer,
      contentType,
      metadata: {
        // cobject (entity listing) is authoritative; parseAvBlock fills empty fields.
        ...mergePreferContent(
          { title: artwork.title, creator: artwork.creator, repository: artwork.repository, color: artwork.color },
          details,
        ),
        artworkUrl,
        source: 'Google Arts & Culture',
      },
    };
  }

  throw new Error(`Could not find a${aspectRatio !== 'all' ? ` ${aspectRatio}` : 'n'} artwork after ${MAX_ATTEMPTS} attempts`);
}

// Single source of truth for all metadata fields this source can provide.
// label/description feed the UI mapping controls (metadataFields).
// defaultMapHint is the suggested HA attribute name for auto-detection (null = no suggestion).
// NOTE: parseAvBlock() extracts the non-cobject fields listed here; keep the two in sync.
const FIELD_DEFS = [
  { key: 'title',              label: 'Title',            description: 'Artwork title',                                                  defaultMapHint: 'title'  },
  { key: 'creator',            label: 'Creator',          description: 'Artist or creator name',                                         defaultMapHint: { entity: 'creator', attribute: 'name' } },
  { key: 'creatorLifespan',    label: 'Creator Lifespan', description: 'Birth and death years of the artist (e.g. "1452 - 1519")',        defaultMapHint: { entity: 'creator', attribute: 'lifespan' }, format: 'date' },
  { key: 'creatorNationality', label: 'Nationality',      description: 'Nationality of the artist',                                      defaultMapHint: { entity: 'creator', attribute: 'nationality' } },
  { key: 'creatorGender',      label: 'Creator Gender',   description: 'Gender of the artist as cataloged',                              defaultMapHint: null     },
  { key: 'type',               label: 'Type',             description: 'Object type from the museum catalog (e.g. "Paintings", "Folio")', defaultMapHint: null     },
  { key: 'medium',             label: 'Medium',           description: 'Materials and technique (e.g. "Tempera colors, gold leaf")',      defaultMapHint: 'medium' },
  { key: 'mediumEntities',     label: 'Medium Entities',  description: 'Google-categorized medium entities (e.g. "Oil paint; Canvas")',   defaultMapHint: null     },
  { key: 'artMovement',        label: 'Art Movement',     description: 'Art movement or period (e.g. "Impressionism; Post-Impressionism")', defaultMapHint: null   },
  { key: 'style',              label: 'Style',            description: 'AI-generated style tags (e.g. "Impressionism", "Baroque")',       defaultMapHint: null     },
  { key: 'dateCreated',        label: 'Date Created',     description: 'Date or year the artwork was created',                           defaultMapHint: 'date',  format: 'date' },
  { key: 'repository',         label: 'Repository',       description: 'Museum or holding institution',                                  defaultMapHint: 'museum' },
  { key: 'dimensions',         label: 'Dimensions',       description: 'Physical dimensions (e.g. "w1345 x h2390 cm")',                  defaultMapHint: 'dimensions'  },
  { key: 'rights',             label: 'Rights',           description: 'Copyright or rights statement as provided by the museum',        defaultMapHint: null          },
  { key: 'description',        label: 'Description',      description: 'Artwork description or commentary (plain text, HTML stripped)',   defaultMapHint: 'description' },
  { key: 'artistBio',          label: 'Artist Bio',       description: 'Biographical information about the artist',                      defaultMapHint: null     },
  { key: 'additionalInfo',     label: 'Additional Info',  description: 'Additional artwork information as provided by the museum',       defaultMapHint: null     },
  { key: 'color',              label: 'Dominant Color',   description: 'Dominant color of the image as a hex string (e.g. "#17120c")',   defaultMapHint: null     },
  { key: 'source',             label: 'Source',           description: 'Source collection name (always "Google Arts & Culture")',        defaultMapHint: null     },
];

const metadataFields = FIELD_DEFS.map(({ key, label, description, format }) => ({ key, label, description, ...(format && { format }) }));

// Default mapping hints: source field key → suggested HA attribute name.
// Used to auto-detect mappings when no user override is set.
// Hint strings are matched case-insensitively against available HA attributes.
const defaultMapping = Object.fromEntries(FIELD_DEFS.map(({ key, defaultMapHint }) => [key, defaultMapHint ?? null]));

/**
 * Returns the filter types this source supports.
 * Consumed by GET /api/web-sources/sources/:sourceId/filter-types and the UI filter builder.
 *
 * 'media' filter: restrict or exclude artworks by medium entity name.
 *   - require: only sample from entities whose names are in values (intersection if multiple filters).
 *   - exclude: never sample from entities whose names are in values (union if multiple filters).
 *   Values come from MEDIUM_ENTITIES; the groups field mirrors MEDIUM_CATEGORIES for UI grouping.
 *
 * 'objectType' filter: skip artworks post-fetch if their museum-cataloged Type field matches.
 *   - exclude only (require makes no sense for a free-text non-controlled vocabulary field).
 *   Values are free-text (user types their own); DEFAULT_EXCLUDED_TYPES are provided as suggestions.
 *   When no objectType-exclude filter is configured, DEFAULT_EXCLUDED_TYPES are applied automatically.
 */
function getFilterTypes() {
  return [
    {
      type: 'artist',
      label: 'Artist',
      description: 'Browse artworks by artist. Resolves the artist name to a Google Arts entity for precise browsing. Falls back to keyword search if the artist cannot be resolved.',
      modes: ['require'],
      multiValue: false,
      values: [],
      inputStyle: 'search',
    },
    {
      type: 'search',
      label: 'Search',
      description: 'Search Google Arts & Culture by keyword. When set, artworks are fetched from search results instead of browsing by medium. Add style/subject/period words for diversity.',
      modes: ['require'],
      multiValue: false,
      modeDetermining: true,
      inputStyle: 'search',
      values: [],
    },
    {
      type: 'media',
      label: 'Medium',
      description: 'Restrict or exclude artworks by material or technique. Values are Google Arts & Culture medium entities.',
      modes: ['require', 'exclude'],
      multiValue: true,
      groups: MEDIUM_CATEGORIES.map(cat => ({ name: cat.name, values: cat.media })),
      values: MEDIUM_ENTITIES.map(e => ({ value: e.name, label: e.name, total: e.total })),
    },
    {
      type: 'objectType',
      label: 'Object Type',
      description: 'Skip artworks whose museum-cataloged object type matches. Not a controlled vocabulary — type exactly as it appears in the metadata (case-insensitive). Common values are provided as suggestions.',
      modes: ['exclude'],
      multiValue: true,
      inputStyle: 'text',
      values: [],
      suggestions: DEFAULT_EXCLUDED_TYPES,
    },
  ];
}

/**
 * Clear the cookie jar and allow re-seeding on the next fetch.
 * Exposed for manual use (e.g. via a UI button) when cookies appear stale.
 */
async function clearCookies() {
  await cookieJar.removeAllCookies();
  _cookiesSeeded = false;
  console.log('[google_arts] Cookie jar cleared manually');
}

/**
 * Fetch a specific artwork by Google Arts & Culture asset ID or URL.
 *
 * Identifier formats accepted:
 *   - Full artwork URL: https://artsandculture.google.com/asset/<slug>/<assetId>
 *   - Bare asset ID (the last path segment of a Google Arts URL, e.g. "xAHC42GKKiZ8pQ")
 *
 * The /api/asset endpoint is called once to retrieve both the cobject (which contains
 * the image base URL via extractArtworks) and the stella.av structured fields (extended
 * metadata). If no cobject is found in the response, imageBase is attempted from ap[1]
 * as a fallback (some response variants embed the image URL there).
 *
 * @param {string} identifier - Google Arts URL or bare asset ID
 * @returns {{ imageBuffer, contentType, metadata }}
 * @throws {Error} if the identifier cannot be parsed, the asset is inaccessible, or download fails.
 */
async function fetchByIdentifier(identifier, { tvOrientation } = {}) {
  await seedCookies();

  // Parse asset ID from /asset/<slug>/<id> or /asset/<id> path, or accept a bare ID directly.
  let assetId;
  const assetPathMatch = identifier.match(/\/asset\/(?:[^/?#]+\/)?([^/?#]+)/i);
  if (assetPathMatch) {
    assetId = assetPathMatch[1];
  } else if (/^[A-Za-z0-9_-]{6,}$/.test(identifier.trim())) {
    assetId = identifier.trim();
  } else {
    throw new Error(`Cannot interpret "${identifier}" as a Google Arts asset ID or URL`);
  }

  let parsed;
  try {
    const response = await cookieClient.get(`${BASE_URL}/api/asset`, {
      params: { assetId, hl: 'en', rt: 'j' },
      headers: { ...HTTP_HEADERS, Accept: 'application/json, text/plain, */*' },
      timeout: 15000,
      responseType: 'text',
    });
    parsed = parseApiResponse(response.data);
  } catch (err) {
    throw new Error(`Failed to fetch Google Arts asset ${assetId}: ${err.message}`);
  }

  // Try to find the artwork's cobject in the response (gives color and aspectRatio).
  // Filter by assetId: extractArtworks does a DFS that may return cobjects for related
  // artworks first, so artworks[0] may not correspond to the requested asset.
  const artworks = extractArtworks(parsed);
  const cobject = artworks.find(a => a.assetId === assetId) || null;

  // Parse stella.ap / stella.av for image URL, extended metadata, and title/creator fallbacks.
  const ap = parsed?.[0]?.[0];
  let imageBase = null;
  let extendedDetails = {};
  if (Array.isArray(ap) && ap[0] === 'stella.ap') {
    const av = ap[2];
    if (Array.isArray(av) && av[0] === 'stella.av') {
      // av[4] is the primary image URL for the requested asset. Unlike cobject.imageBase,
      // this always corresponds to the requested assetId (not a related artwork).
      const rawImageUrl = av[4];
      if (typeof rawImageUrl === 'string' && rawImageUrl) {
        imageBase = rawImageUrl.startsWith('//') ? `https:${rawImageUrl}` : rawImageUrl;
      }
      extendedDetails = parseAvBlock(av);
    }
    // Secondary fallback: ap[1] sometimes contains the image URL directly
    if (!imageBase) {
      const candidate = ap[1];
      if (typeof candidate === 'string' && (candidate.includes('googleusercontent') || candidate.startsWith('//'))) {
        imageBase = candidate.startsWith('//') ? `https:${candidate}` : candidate;
      }
    }
  }
  if (!imageBase) {
    throw new Error(`Could not find image URL for Google Arts asset ${assetId}. The asset may not be publicly accessible or the API response format may have changed.`);
  }

  const imageUrl = buildDownloadUrl(imageBase, cobject?.aspectRatio ?? null);
  // artworkUrl is always derived from the parsed assetId (not cobject.link, which may point
  // to a different artwork if the matching cobject wasn't found in the response).
  const artworkUrl = `${BASE_URL}/asset/-/${assetId}`;

  const imageResponse = await axios.get(imageUrl, {
    responseType: 'arraybuffer',
    headers: HTTP_HEADERS,
    timeout: 30000,
  }).catch(err => { throw new Error(`Failed to download Google Arts image: ${err.message}`); });

  let imageBuffer = Buffer.from(imageResponse.data);
  const contentType = imageResponse.headers['content-type'] || 'image/jpeg';

  // Dezoomify fallback: if the direct download can't cover the TV's 4K target without
  // upscaling, try fetching higher-resolution tiles from the artwork page.
  const [targetW, targetH] = tvOrientation === 'portrait' ? [2160, 3840] : [3840, 2160];
  const { width: dlW, height: dlH } = await sharp(imageBuffer).metadata();
  if (dlW < targetW || dlH < targetH) {
    console.log(`[google_arts] fetchByIdentifier: ${dlW}×${dlH} is below ${targetW}×${targetH}; attempting dezoomify for ${artworkUrl}`);
    const dezoomedBuffer = await dezoomify(artworkUrl, { maxWidth: 4801 });
    if (dezoomedBuffer) {
      imageBuffer = dezoomedBuffer;
      console.log(`[google_arts] dezoomify succeeded for ${artworkUrl}`);
    } else {
      console.log(`[google_arts] dezoomify unavailable or failed; using ${dlW}×${dlH} image`);
    }
  }

  return {
    imageBuffer,
    contentType,
    metadata: {
      // cobject (entity listing) is authoritative; parseAvBlock fills empty fields.
      ...mergePreferContent(
        { title: cobject?.title, creator: cobject?.creator, repository: cobject?.repository, color: cobject?.color },
        extendedDetails,
      ),
      artworkUrl,
      source: 'Google Arts & Culture',
    },
  };
}

/**
 * Returns true if this source can fetch the given identifier.
 * Accepts Google Arts & Culture asset URLs (artsandculture.google.com/asset/...).
 * Note: checked before google_art_wallpaper in SOURCE_MODULES to ensure specificity.
 */
function canHandleIdentifier(identifier) {
  return /artsandculture\.google\.com\/asset\//i.test(identifier.trim());
}

/**
 * Fetch extended metadata for a Google Arts & Culture artwork by URL or asset ID,
 * without downloading the image. Intended for use by other sources (e.g. Google Art
 * Wallpaper) that already have an image but want richer metadata.
 *
 * @param {string} identifier - Full Google Arts URL or bare asset ID.
 *   Accepted URL formats:
 *   - /asset/<slug>/<id>  (standard Google Arts format)
 *   - asset/<id>          (Google Art Wallpaper list format, single segment, no slug)
 *   - bare asset ID       (alphanumeric/hyphen, 6+ chars)
 * @returns {Promise<object>} Metadata fields (dateCreated, type, medium, creatorNationality,
 *   dimensions, description), or {} if the identifier cannot be resolved or the call fails.
 */
async function fetchArtworkMetadata(identifier) {
  if (!identifier) return {};
  await seedCookies();

  let assetId;
  // Match /asset/<slug>/<id> or /asset/<id> (wallpaper list uses single-segment form).
  // The slug group is made optional so both formats are captured correctly.
  const assetPathMatch = identifier.match(/\/asset\/(?:[^/?#]+\/)?([^/?#]+)/i);
  if (assetPathMatch) {
    assetId = assetPathMatch[1];
  } else if (/^[\w\-]{6,}$/.test(identifier)) {
    assetId = identifier;
  }

  if (!assetId) return {};
  return fetchAssetDetails(assetId);
}

/**
 * Examine the full merged filter set and determine the best API strategy.
 *
 * Modes:
 * - 'search': When a search filter is present (mode-determining). Uses /api/search.
 * - 'browse_medium': Default. Paginated entity browsing by medium via /api/entity/assets.
 *
 * @param {Array<{type, mode, values}>} filters - Merged filters from all cascade levels.
 * @returns {{ mode: string, apiFilters: Array, postFilters: Array }}
 */
function selectMode(filters = []) {
  const artistFilter = filters.find(f => f.type === 'artist' && f.values?.length > 0);
  if (artistFilter) {
    const postFilters = filters.filter(f => f.type === 'objectType' || f.type === 'media');
    return { mode: 'browse_artist', apiFilters: [artistFilter], postFilters };
  }

  const searchFilter = filters.find(f => f.type === 'search' && f.values?.length > 0);
  if (searchFilter) {
    // In search mode, media filters are applied post-fetch against av[21] entity associations
    const postFilters = filters.filter(f => f.type === 'objectType' || f.type === 'media');
    return { mode: 'search', apiFilters: [searchFilter], postFilters };
  }

  const apiFilters = filters.filter(f => f.type === 'media');
  const postFilters = filters.filter(f => f.type === 'objectType');
  return { mode: 'browse_medium', apiFilters, postFilters };
}

/**
 * Returns default filters to apply when a source is first initialized and has no
 * filters configured. Called by the route layer during config read.
 */
function getDefaultFilters() {
  return [
    { type: 'objectType', mode: 'exclude', values: DEFAULT_EXCLUDED_TYPES },
  ];
}

/**
 * Count how many artworks Google Arts has for a given artist name.
 * Resolves the artist entity ID then fetches the total count.
 * Returns 0 if the artist is not found; null on error.
 *
 * @param {string} artistName
 * @returns {Promise<number|null>}
 */
async function countArtistArtworks(artistName) {
  try {
    const entityId = await resolveArtistEntity(artistName);
    if (!entityId) return 0;
    return await getArtistEntityCount(entityId);
  } catch {
    return null;
  }
}

/**
 * Suggest artist name candidates from Google Arts & Culture search.
 * Seeds _artistEntityCache as a side effect (entity IDs needed for subsequent queries).
 *
 * @param {string} query
 * @param {number} [limit=5]
 * @returns {Promise<Array<{ name, entityId, source }>>}
 */
async function suggestArtists(query, limit = 5) {
  const key = query.toLowerCase().trim();
  const cached = _artistSuggestCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < ARTIST_SUGGEST_TTL_MS) {
    return cached.results.slice(0, limit);
  }

  await seedCookies();
  let results = [];
  let apiResponded = false;
  try {
    const response = await cookieClient.get(`${BASE_URL}/api/search`, {
      params: { q: query, hl: 'en' },
      headers: { ...HTTP_HEADERS, Accept: 'application/json, text/plain, */*' },
      timeout: 15000,
      responseType: 'text',
    });
    const parsed = parseApiResponse(response.data);
    const candidates = extractArtistCobjects(parsed);

    results = candidates
      .filter(c => c.name && c.entityId)
      .map(c => ({ name: c.name, entityId: c.entityId, source: 'google_arts' }));

    // Seed entity cache as side effect
    const now = Date.now();
    for (const r of results) {
      const nameKey = r.name.toLowerCase().trim();
      _artistEntityCache.set(nameKey, { entityId: r.entityId, resolvedName: r.name, fetchedAt: now });
    }
    apiResponded = true;
  } catch (err) {
    console.warn(`[google_arts] suggestArtists failed for "${query}": ${err.message}`);
  }

  if (apiResponded) {
    _artistSuggestCache.set(key, { results, fetchedAt: Date.now() });
  }
  return results.slice(0, limit);
}

/**
 * Search preview: return N results from the Google Arts search API with thumbnail metadata.
 * Does NOT download full images — uses the imageBase URL with a small size suffix.
 *
 * @param {string} query        - Search query string
 * @param {object} [options]
 * @param {number} [options.count=12]       - Maximum results to return
 * @param {'all'|'landscape'|'portrait'} [options.aspectRatio='all'] - Aspect ratio filter
 * @returns {Promise<{ results: Array, totalAvailable: number }>}
 */
async function searchPreview(query, { count = 12, aspectRatio = 'all' } = {}) {
  await seedCookies();

  let pool = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await cookieClient.get(`${BASE_URL}/api/search`, {
        params: { q: query, hl: 'en' },
        headers: { ...HTTP_HEADERS, Accept: 'application/json, text/plain, */*' },
        timeout: 15000,
        responseType: 'text',
      });
      const parsed = parseApiResponse(response.data);
      const artworks = extractArtworks(parsed);
      if (artworks.length > 0) {
        pool = artworks;
        break;
      }
    } catch (err) {
      console.warn(`[google_arts] searchPreview API error (attempt ${attempt + 1}): ${err.message}`);
    }
  }

  if (!pool) return { results: [], totalAvailable: 0 };

  // Aspect ratio filtering (uses metadata only — no image download)
  if (aspectRatio !== 'all') {
    pool = pool.filter(a => {
      if (a.aspectRatio === null) return false;
      if (aspectRatio === 'landscape') return a.aspectRatio > 1;
      if (aspectRatio === 'portrait') return a.aspectRatio < 1;
      return true;
    });
  }

  const totalAvailable = pool.length;
  const results = pool.slice(0, count).map(artwork => ({
    title: artwork.title || null,
    creator: artwork.creator || null,
    repository: artwork.repository || null,
    artworkUrl: `${BASE_URL}${artwork.link}`,
    // Thumbnail: imageBase with small size suffix (no full download)
    thumbnailUrl: artwork.imageBase ? `${artwork.imageBase}=w400` : null,
    aspectRatio: artwork.aspectRatio || null,
    source: 'Google Arts & Culture',
  }));

  return { results, totalAvailable };
}

module.exports = { fetchRandomArtwork, fetchByIdentifier, canHandleIdentifier, fetchArtworkMetadata, clearCookies, selectMode, suggestArtists, countArtistArtworks, searchPreview, MEDIUM_ENTITIES, MEDIUM_CATEGORIES, DEFAULT_EXCLUDED_TYPES, getFilterTypes, getDefaultFilters, metadataFields, defaultMapping };
