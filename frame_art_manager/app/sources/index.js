'use strict';

/**
 * Central registry of all web art source modules.
 *
 * Add a new source here and in web_sources.js BUILTIN_SOURCES.
 * All other source-dependent logic (artist suggest, counts, filter types, etc.)
 * derives from this registry dynamically.
 */
module.exports = {
  google_arts:         require('./google_arts'),
  google_art_wallpaper: require('./google_art_wallpaper'),
  met_museum:          require('./met_museum'),
  moma:                require('./moma'),
  louvre:              require('./louvre'),
  artsy:               require('./artsy'),
  delart:              require('./delart'),
  tate:                require('./tate'),
  access_okeefe:       require('./access_okeefe'),
  nga:                 require('./nga'),
  getty:               require('./getty'),
  harvard_art_museums: require('./harvard_art_museums'),
};
