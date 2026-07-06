// heroes/heroes-index.mjs — pure logic for the heroes index page: tier-ordered display and
// hero.html link building for site/data/hero-pages/index.json's `heroes[]` rows (schema
// cb-academy-hero-index/v1 — see tools/build-hero-pages/README.md).
//
// Per docs/design-handoff/academy-pages/06-screens-home-nav-auth.md §X2, the heroes index has
// no search/filter controls (unlike the units index) — it's a fixed tierlist-ordered list,
// God -> D, left-to-right position preserved within a tier, dual-entry classes (Bastard Sword,
// Chaindart) shown as two separate rows both linking to the same page. The compiler already
// produces `heroes[]` in this exact order (tools/build-hero-pages/lib/tier-order.mjs is the
// source of truth) — this module does NOT re-sort; it only groups the already-ordered rows by
// tier for rendering and builds hrefs, same "pure/DOM-free" split as units-index.mjs.
//
// Ported onto design/handoff-academy-pages/design_handoff_immortals_academy/templates/
// Heroes Index.dc.html (see that file's `data-field` map + README.md "Heroes index" row) — the
// tier-table grammar (tier-cell + ordinal + row) below matches its markup shape.

/** Display order for the tier ladder — used only to group already-ordered rows into sections,
 * never to re-sort within a tier (the compiler's left-to-right order is authoritative). */
export const TIER_DISPLAY_ORDER = ['God', 'S', 'AA', 'A', 'B', 'C', 'D'];

/**
 * Groups an already tier-ordered `heroes[]` array into per-tier sections, preserving row order
 * within each tier. A tier with zero rows (shouldn't happen with a complete data set, but the
 * compiler's `missingSlugs` can produce this) is simply omitted from the output rather than
 * rendered as an empty section.
 * @param {Array<Record<string, unknown>>} heroes
 * @returns {Array<{ tier: string, rows: Array<Record<string, unknown>> }>}
 */
export function groupByTier(heroes) {
  const sections = [];
  for (const tier of TIER_DISPLAY_ORDER) {
    const rows = heroes.filter((h) => h.tier === tier);
    if (rows.length > 0) sections.push({ tier, rows });
  }
  return sections;
}

/**
 * Builds the href for a hero's detail page from its slug, resolved relative to THIS module's own
 * location — same PATH RESOLUTION convention as units-index.mjs/nav.mjs (import.meta.url-relative,
 * never root-relative), so links keep working under a subpath deploy.
 * @param {string} slug
 * @returns {string}
 */
export function heroHref(slug) {
  return `${new URL('hero.html', import.meta.url).href}?h=${encodeURIComponent(slug)}`;
}

/**
 * Builds the display label for a tier chip's position context, matching `05` H1's "carries the
 * position context" convention (e.g. "S · #2"). A dual-entry row also gets its variantLabel
 * appended when present (e.g. "God · #1 — Riposte Build").
 * @param {Record<string, unknown>} row  one heroes[] entry
 * @returns {string}
 */
export function tierChipLabel(row) {
  const base = `${row.tier} · #${row.positionInTier}`;
  return row.variantLabel ? `${base} — ${row.variantLabel}` : base;
}

/**
 * Renders the visible left-of-row ordinal per Heroes Index.dc.html's `.ordinal` region
 * ("#1", "#2" — left-to-right position WITHIN the tier, reset per tier; never a global running
 * count across the whole table). Position is data (`positionInTier`), not derived here.
 * @param {Record<string, unknown>} row  one heroes[] entry
 * @returns {string}
 */
export function ordinalLabel(row) {
  return `#${row.positionInTier}`;
}

/**
 * Finds a dual-entry row's OTHER placement — the row sharing its slug elsewhere in the full,
 * un-grouped `heroes[]` array. Returns `null` for a single-entry row or if no counterpart is
 * found (defensive; shouldn't happen for a row the compiler marked `isDualEntry`).
 * @param {Record<string, unknown>} row  one heroes[] entry
 * @param {Array<Record<string, unknown>>} allHeroes  the full un-grouped heroes[] array
 * @returns {Record<string, unknown>|null}
 */
export function otherPlacement(row, allHeroes) {
  if (!row.isDualEntry) return null;
  return allHeroes.find((h) => h.slug === row.slug && h.tier !== row.tier) || null;
}

/**
 * Honest dual-entry hint text for a row's second-listing context — or `null` when the design
 * template pins no hint at all. The template shows visible `.dual-entry-hint` text ONLY on
 * Chaindart's two rows (an AA special-job placement paired with a general-pick placement); it
 * shows NO hint on Bastard Sword's two rows (two named-build placements of one weapon, neither
 * AA), even though both are `isDualEntry`. The data-driven signal for this split is
 * `specialJobLabel`: it is populated only on AA-style "home" placements, never on a plain second
 * named-build placement — so a pairing gets a hint only when at least one side of it carries a
 * `specialJobLabel`. The placement WITH the label (the "home" row) reads "also at <tier> — one
 * page"; its counterpart (without the label) reads "second listing — same page as the <tier>
 * entry". A pairing where NEITHER side has a `specialJobLabel` (Bastard Sword) returns `null` for
 * both its rows, matching the template's silence there.
 * @param {Record<string, unknown>} row  one heroes[] entry (isDualEntry === true)
 * @param {Record<string, unknown>} other  its counterpart placement, from otherPlacement()
 * @returns {string|null}
 */
export function dualEntryHint(row, other) {
  if (!row.specialJobLabel && !other?.specialJobLabel) return null;
  return row.specialJobLabel
    ? `also at ${other.tier} — one page`
    : `second listing — same page as the ${other.tier} entry`;
}

/**
 * Distinct hero-class count from an already-fetched `heroes[]` array (deduped by slug) — the
 * "N classes" half of the index header's "N classes · M tierlist entries" line
 * (Heroes Index.dc.html `.index-counts`, data-field "index.counts"). Computed from the real
 * fetched rows, same category as the units index's live result count — never a hardcoded number.
 * @param {Array<Record<string, unknown>>} heroes
 * @returns {number}
 */
export function distinctClassCount(heroes) {
  return new Set(heroes.map((h) => h.slug)).size;
}

/**
 * True if a given hero class slug from `missingSlugs` should render as an honest "guide not yet
 * available" row rather than being silently absent from the page. The heroes index doesn't
 * currently render missing rows as tiles (there's no tier/position for them to slot into without
 * inventing one), but this predicate is exposed so the boot layer can surface a summary note
 * ("2 classes still being written") without re-deriving the check inline.
 * @param {unknown} missingSlugs
 * @returns {boolean}
 */
export function hasMissingClasses(missingSlugs) {
  return Array.isArray(missingSlugs) && missingSlugs.length > 0;
}
