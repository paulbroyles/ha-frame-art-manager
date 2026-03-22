/**
 * Merge metadata from multiple sources, preferring non-null values left-to-right.
 * The first source is authoritative; later sources fill in any fields left null.
 * Non-content never replaces content.
 */
function mergePreferContent(...sources) {
  const result = {};
  for (const source of sources) {
    for (const [k, v] of Object.entries(source || {})) {
      if (result[k] == null && v != null) result[k] = v;
    }
  }
  return result;
}

module.exports = { mergePreferContent };
