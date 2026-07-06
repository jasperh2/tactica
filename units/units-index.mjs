// units/units-index.mjs — pure logic for the units index page: live name search, era/classBucket/
// tier filters derived FROM the data (not a hardcoded enum — the compiled index has already been
// observed to carry non-standard tier strings like "Best Filler (top pick, unlettered)" alongside
// the clean God/S/AA/A/B/C/D-E-F ladder, so filter options must be whatever the index actually
// contains, sorted for display, rather than an assumed closed set), and tile-row shaping for
// site/data/unit-pages/index.json's `units[]` rows (schema cb-academy-unit-index/v1 — see
// tools/build-unit-pages/README.md).
//
// Pure/DOM-free by design (same split as nav.mjs: isActiveItem vs buildNav) so every function here
// is directly node:test-able without a DOM. units-index.boot.mjs (inlined in index.html) owns the
// actual document.createElement calls and wires these functions to the live fetch + input events.

/** A single filter's "no restriction" sentinel — matches every row regardless of that row's
 * field value. Used as the default state for each filter dropdown. */
export const FILTER_ALL = '__all__';

/**
 * Distinct values for one field across `units`, sorted for stable display order. Null/undefined
 * values are dropped (an "unknown" tier/era doesn't get its own filter option — those rows still
 * match the FILTER_ALL/no-restriction state, they just opt out of every named filter value).
 * @param {Array<Record<string, unknown>>} units
 * @param {string} field
 * @returns {string[]}
 */
export function distinctSorted(units, field) {
  const values = new Set();
  for (const unit of units) {
    const value = unit[field];
    if (typeof value === 'string' && value.length > 0) values.add(value);
  }
  return [...values].sort((a, b) => a.localeCompare(b));
}

/**
 * True if `name` contains `query` as a case-insensitive substring. Empty/whitespace-only query
 * matches everything (the "no search typed yet" state). Non-string `name` never matches.
 * @param {unknown} name
 * @param {string} query
 * @returns {boolean}
 */
export function matchesSearch(name, query) {
  const trimmed = query.trim();
  if (trimmed === '') return true;
  if (typeof name !== 'string') return false;
  return name.toLowerCase().includes(trimmed.toLowerCase());
}

/**
 * Filters `units` by name search + the three filter axes. `era`/`classBucket` are either
 * FILTER_ALL (no restriction) or an exact string the row's field must equal; `tier` goes through
 * matchesTierChip so it also accepts the handoff's grouped 'D-E-F' chip and the bare 'All' string
 * (FILTER_ALL and 'All' are both treated as "no restriction" — see matchesTierChip). Order of
 * checks is cheapest-first (search substring, then three equality checks) — no material perf
 * difference at 149 rows, but keeps the intent readable.
 * @param {Array<Record<string, unknown>>} units
 * @param {{ query?: string, era?: string, classBucket?: string, tier?: string }} filters
 * @returns {Array<Record<string, unknown>>}
 */
export function filterUnits(units, filters = {}) {
  const { query = '', era = FILTER_ALL, classBucket = FILTER_ALL, tier = FILTER_ALL } = filters;
  return units.filter((unit) => {
    if (!matchesSearch(unit.name, query)) return false;
    if (era !== FILTER_ALL && unit.era !== era) return false;
    if (classBucket !== FILTER_ALL && unit.classBucket !== classBucket) return false;
    if (!matchesTierChip(unit.tier, tier)) return false;
    return true;
  });
}

/**
 * Sorts units for display: named-tier units first (alphabetical by name within tier group,
 * tier groups ordered by the ladder below), then untiered (identity-only) units alphabetically.
 * Unrecognized tier strings (e.g. "Best Filler (top pick, unlettered)") sort after the known
 * ladder but before untiered — they are real tier signal, just not on the clean enum, so they
 * should not be buried at the very bottom next to units with no tier data at all.
 * @param {Array<Record<string, unknown>>} units
 * @returns {Array<Record<string, unknown>>}
 */
export function sortForDisplay(units) {
  const rank = (tier) => {
    const index = TIER_LADDER.indexOf(tier);
    if (index >= 0) return index;
    if (typeof tier === 'string' && tier.length > 0) return TIER_LADDER.length; // known-but-odd tier string
    return TIER_LADDER.length + 1; // no tier at all
  };
  return [...units].sort((a, b) => {
    const rankDiff = rank(a.tier) - rank(b.tier);
    if (rankDiff !== 0) return rankDiff;
    return String(a.name).localeCompare(String(b.name));
  });
}

/** Display order for the clean tier ladder (README: God/S/AA/A/B/C/D-E-F). "God" is included even
 * though it hasn't been observed in the current index — future patches may introduce it, and
 * ranking it above S costs nothing if unused. */
const TIER_LADDER = ['God', 'S', 'AA', 'A', 'B', 'C', 'D', 'E', 'F'];

/** Handoff-defined display order for the tier FILTER's chip row (README template map: "meta letter
 * + rarity on one chip"; Units Index.dc.html's tierOpts). Distinct from TIER_LADDER (which ranks
 * every real tier string for tile SORT order) — this is a fixed, small set of filter buttons, and
 * "D-E-F" is one combined filter option grouping three index.json tier values, not a tier string
 * that ever appears on a row. */
export const TIER_FILTER_CHIPS = ['All', 'God', 'S', 'AA', 'A', 'B', 'C', 'D-E-F'];

/**
 * True if a unit's `tier` field matches one tier-filter chip value. `FILTER_ALL`/'All' matches
 * everything; 'D-E-F' matches any of the three grouped tiers (the handoff's one combined chip for
 * the bottom of the ladder — Units Index.dc.html line 102); every other chip is an exact match.
 * @param {unknown} tier
 * @param {string} chipValue
 * @returns {boolean}
 */
export function matchesTierChip(tier, chipValue) {
  if (chipValue === FILTER_ALL || chipValue === 'All') return true;
  if (chipValue === 'D-E-F') return tier === 'D' || tier === 'E' || tier === 'F';
  return tier === chipValue;
}

/** rarity string ("T1".."T5") -> a CSS color value carrying its tint. shared/academy.css §1b
 * already declares the primary token for every step (--rarity-legendary-t5 down to
 * --rarity-common-t1, aliasing the handoff's tokens.css T1-T5 ramp), so the `var(--x, fallback)`
 * form here resolves to `--x` in normal operation; the literal hex after each comma is inert
 * defensive fallback only (belt-and-suspenders if academy.css's §1b block is ever reordered or
 * temporarily missing), same pattern site/home.css's header comment documents for --gold-*. */
const RARITY_COLOR_VAR = {
  T5: 'var(--rarity-legendary-t5, var(--rarity-legendary, #e6b24c))',
  T4: 'var(--rarity-epic-t4, var(--rarity-epic, #b45ce6))',
  T3: 'var(--rarity-rare-t3, var(--rarity-rare, #4c9bef))',
  T2: 'var(--rarity-uncommon-t2, var(--rarity-uncommon, #46c46e))',
  T1: 'var(--rarity-common-t1, var(--text-secondary, #9aa3b2))',
};

/**
 * CSS color value (a `var(--rarity-*, ...)` fallback chain — see RARITY_COLOR_VAR) for a rarity
 * string. Unrecognized/missing rarity falls back to --text-secondary (T1's own grey) rather than
 * an accent color — an absent rarity is not meaningfully different from the lowest tier's visual
 * weight.
 * @param {unknown} rarity
 * @returns {string}
 */
export function rarityColorVar(rarity) {
  return RARITY_COLOR_VAR[rarity] || 'var(--text-secondary, #9aa3b2)';
}

/**
 * The tier chip's display text — handoff spec (README template map, `.stat-chip-tier`): "meta
 * letter + rarity on one chip (\"AA·T5\"), text-first". Renders whichever parts exist; a unit with
 * only one of {tier, rarity} (or neither) still renders honestly rather than showing a stray "·"
 * or a fabricated placeholder — see index.json rows with `tier: null, rarity: null` (the
 * identity-only units).
 * @param {unknown} tier
 * @param {unknown} rarity
 * @returns {string}
 */
export function tierChipText(tier, rarity) {
  return [tier, rarity].filter((part) => typeof part === 'string' && part.length > 0).join(' · ');
}

/**
 * Builds the href for a unit's detail page from its slug, resolved relative to THIS module's own
 * location — same PATH RESOLUTION convention as nav.mjs/data.mjs (import.meta.url-relative, never
 * root-relative), so links keep working under a subpath deploy.
 * @param {string} slug
 * @returns {string}
 */
export function unitHref(slug) {
  return `${new URL('unit.html', import.meta.url).href}?u=${encodeURIComponent(slug)}`;
}

/**
 * Richness badge label for a tile. `richness` is the index row's own field ("full" | "stats-only"
 * per build-index-entry.mjs) — this only maps it to display text, it does not re-derive richness.
 * Lowercase per the handoff's own copy (README template map: "'full guide' gold badge vs 'stats
 * only' neutral"; Units Index.dc.html's demo data literally: `t.full ? 'full guide' : 'stats
 * only'`) — matches every other badge/chip/tag label in this design system (mandatory/top pick/
 * filler/avoid, no source yet/not applicable/not yet written), none of which are sentence-cased.
 * @param {unknown} richness
 * @returns {string}
 */
export function richnessBadgeLabel(richness) {
  return richness === 'full' ? 'full guide' : 'stats only';
}
