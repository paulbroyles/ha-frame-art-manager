/**
 * Merge metadata from multiple sources, preferring non-empty values left-to-right.
 * The first source is authoritative; later sources fill in any fields left null or "".
 * Empty strings are treated as absent — they neither block later sources nor win over content.
 */
function mergePreferContent(...sources) {
  const result = {};
  for (const source of sources) {
    for (const [k, v] of Object.entries(source || {})) {
      if ((result[k] == null || result[k] === '') && v != null && v !== '') result[k] = v;
    }
  }
  return result;
}

module.exports = { mergePreferContent };
