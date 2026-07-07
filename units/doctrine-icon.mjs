// units/doctrine-icon.mjs — dynamic doctrine-name -> icon resolver.
//
// The doctrines panel renders each doctrine by NAME. Once our doctrine names are
// canonicalized to the real in-game names, this maps a name to its icon file with
// zero per-page hardcoding: look the (normalized) name up in the authoritative
// name->slug map shipped at site/data/doctrine-icons.json (built from the conqsite
// doctrine vocab), and point at assets/doctrine-icons/<slug>.png.
//
// It is deliberately EXACT-MATCH ONLY (no fuzzy slugify): a re-slugify would diverge
// from the CDN filenames for ~35 doctrines (apostrophes, "&") AND could surface the
// WRONG icon for a paraphrased name. A name we can't resolve simply renders with no
// icon — never a wrong one. Canonicalization is what raises coverage; this stays safe.

export const DOCTRINE_ICON_DIR = 'assets/doctrine-icons';

/** Normalizes a doctrine name for lookup: trim, lowercase, collapse internal
 * whitespace. Mirrors the key normalization used when building doctrine-icons.json. */
export function normalizeDoctrineName(name) {
  return typeof name === 'string' ? name.trim().toLowerCase().replace(/\s+/g, ' ') : '';
}

/** Resolves a doctrine name to its icon slug via the name->slug map, or null. */
export function doctrineIconSlug(name, nameToSlug) {
  const key = normalizeDoctrineName(name);
  if (!key || !nameToSlug) return null;
  return Object.prototype.hasOwnProperty.call(nameToSlug, key) ? nameToSlug[key] : null;
}

/** Resolves a doctrine name to its site-relative icon path, or null when the name
 * isn't a known canonical doctrine (kept-descriptive entries render iconless). */
export function doctrineIconPath(name, nameToSlug) {
  const slug = doctrineIconSlug(name, nameToSlug);
  return slug ? `${DOCTRINE_ICON_DIR}/${slug}.png` : null;
}
