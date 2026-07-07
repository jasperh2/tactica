// units/unit-page-v2.mjs — pure data-shaping helpers for the v2 unit-page layout (cb-unit-page-v2/1
// schema). Consumes one compiled record from data/unit-pages-v2/<slug>.json (contract:
// .claude/skills/unit-template-fill/SKILL.md) and derives every display value the DOM layer
// (unit-page-v2.boot.mjs) needs: schema detection, footnote lookup, inline `{n}` mark parsing,
// tag/relation label lookups, and the corner-date formatter.
//
// Pure/DOM-free by design (same split as unit-page.mjs/nav.mjs/units-index.mjs) — every function
// here is directly node:test-able without a DOM.
//
// SCHEMA DISPATCH: a v2 record is recognized by `schema === "cb-unit-page-v2/1"` (see
// isV2Schema). A v2 record additionally carries an `insufficient: true` short-circuit shape
// (`{ schema, slug, insufficient: true }`, no other keys) for stats-only units per the SKILL.md
// "Insufficient-data rule" — isInsufficientV2 detects that shape so the DOM layer can fall back to
// the existing v1 identity-only page instead of rendering an empty v2 guide grid.

/** The exact schema tag a v2 unit-page record carries (contract: SKILL.md's JSON contract block). */
export const V2_SCHEMA = 'cb-unit-page-v2/1';

/**
 * True when `record` is a v2-schema unit page (any shape — full or insufficient). Used by the boot
 * module to decide "v2 layout" vs "current v1 layout" per the task's dispatch rule: only records
 * carrying this exact schema string route to the v2 renderer; anything else (missing schema,
 * v1's own schema string, a future schema) keeps rendering through the v1 path unchanged.
 * @param {unknown} record
 * @returns {boolean}
 */
export function isV2Schema(record) {
  return Boolean(record) && typeof record === 'object' && /** @type {any} */ (record).schema === V2_SCHEMA;
}

/**
 * True when a v2 record is the "insufficient data" short-circuit shape (SKILL.md: "if the RAW
 * contains NO guide-type content ... emit exactly `{ schema, slug, insufficient: true }` and stop
 * — the page stays a stats-only identity page"). The DOM layer renders the existing v1
 * identity-only shape for these, not an empty v2 guide grid.
 * @param {unknown} record
 * @returns {boolean}
 */
export function isInsufficientV2(record) {
  return isV2Schema(record) && /** @type {any} */ (record).insufficient === true;
}

/**
 * Looks up one footnote record by its mark number from the page's `footnotes[]` ledger. Mirrors
 * unit-page.mjs's findFootnote (same dangling-reference-safe contract: returns null rather than
 * throwing on a mark with no matching footnote).
 * @param {Array<{mark: number}>|undefined} footnotes
 * @param {number} mark
 * @returns {object|null}
 */
export function findFootnoteV2(footnotes, mark) {
  if (!Array.isArray(footnotes)) return null;
  return footnotes.find((fn) => fn.mark === mark) || null;
}

/**
 * Formats one footnote legend line: "Amya · May 2026" (house sources get the lock glyph appended
 * by the DOM layer, not here — this only composes the text, same split as
 * unit-page.mjs's footnoteLegendText). Author-only (no date) reads as just the author name.
 * @param {{author?: string, date?: string|null}} footnote
 * @returns {string}
 */
export function footnoteLegendTextV2(footnote) {
  if (!footnote) return '';
  if (footnote.date) return `${footnote.author} · ${footnote.date}`;
  return String(footnote.author ?? '');
}

/**
 * Splits a prose string carrying inline `{n}` footnote-mark placeholders (the v2 contract's
 * battleRole/controls.notes prose shape — see SKILL.md: "prose with superscript marks inline as
 * {n}") into an ordered list of segments the DOM layer can render as alternating text nodes and
 * `<sup>` elements. Each segment is either `{ type: 'text', value: string }` or
 * `{ type: 'mark', value: number }`. A malformed/non-numeric `{...}` token (should not happen from
 * a well-formed compile) is treated as literal text rather than dropped or thrown on, so a bad
 * upstream value degrades to visible text instead of vanishing.
 * @param {string|null|undefined} text
 * @returns {Array<{type: 'text', value: string}|{type: 'mark', value: number}>}
 */
export function parseInlineMarks(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const segments = [];
  const re = /\{(\d+)\}/g;
  let lastIndex = 0;
  let match;
  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIndex) segments.push({ type: 'text', value: text.slice(lastIndex, match.index) });
    segments.push({ type: 'mark', value: Number(match[1]) });
    lastIndex = re.lastIndex;
  }
  if (lastIndex < text.length) segments.push({ type: 'text', value: text.slice(lastIndex) });
  return segments;
}

/** Doctrine tag -> human display label (v2 contract tags: mandatory/top-pick/filler/avoid — same
 * four values as v1's DOCTRINE_TAG_LABELS, kept as an independent copy per-module so the v2 layer
 * has no import dependency on the v1 module it must coexist with, not replace). */
export const DOCTRINE_TAG_LABELS_V2 = {
  mandatory: 'mandatory',
  'top-pick': 'top pick',
  filler: 'filler',
  avoid: 'avoid',
};

/**
 * Human label for a v2 doctrine tag string. Unrecognized tags fall back to the raw string (never
 * silently dropped), matching unit-page.mjs's doctrineTagLabel contract.
 * @param {unknown} tag
 * @returns {string}
 */
export function doctrineTagLabelV2(tag) {
  return DOCTRINE_TAG_LABELS_V2[tag] || String(tag ?? '');
}

/** Doctrine tag -> the approved template's own short CSS class name (unit-page-template-v2.html:
 * `<span class="tag mand">` / `.tag.top` / `.tag.fill` / `.tag.avoid` — NOT a kebab-cased version
 * of the tag string itself, e.g. "mandatory" must map to "mand", not "mandatory"). Kept as an
 * explicit lookup table rather than a string transform (cssSafeSuffixV2("mandatory") would wrongly
 * produce "mandatory", not "mand") so the DOM layer never has to know the template's exact
 * abbreviations. Unrecognized tags fall back to cssSafeSuffixV2's generic sanitizer so an unknown
 * future tag still produces A valid (if unstyled) class name rather than an empty one. */
const DOCTRINE_TAG_CLASS_V2 = {
  mandatory: 'mand',
  'top-pick': 'top',
  filler: 'fill',
  avoid: 'avoid',
};

/**
 * CSS class suffix for a v2 doctrine tag pill, matching the approved template's exact class names
 * (`.tag.mand`/`.tag.top`/`.tag.fill`/`.tag.avoid` — see DOCTRINE_TAG_CLASS_V2).
 * @param {unknown} tag
 * @returns {string}
 */
export function doctrineTagClassV2(tag) {
  return DOCTRINE_TAG_CLASS_V2[tag] || cssSafeSuffixV2(tag);
}

/** Matchup relation -> human display label (v2 contract relations: counters-you/hero-threat/pairs
 * — see SKILL.md's matchups.cards[].rel enum. Deliberately a different value set from v1's
 * loses-to/struggles-vs/counters/pairs-with — the v2 template's own approved wording, e.g. "counters
 * you" / "hero threat" / "pairs", per unit-page-template-v2.html's `.mu-card` markup). */
export const MATCHUP_RELATION_LABELS_V2 = {
  'counters-you': 'counters you',
  'hero-threat': 'hero threat',
  pairs: 'pairs',
};

/**
 * Human label for a v2 matchup relation string. Unrecognized relations fall back to the raw string
 * (never silently dropped), matching unit-page.mjs's matchupRelationLabel contract.
 * @param {unknown} relation
 * @returns {string}
 */
export function matchupRelationLabelV2(relation) {
  return MATCHUP_RELATION_LABELS_V2[relation] || String(relation ?? '');
}

/**
 * CSS-safe class suffix for a doctrine tag or matchup relation (kebab-case, alphanumerics only) —
 * identical contract to unit-page.mjs's cssSafeSuffix, duplicated here so unit-page-v2.mjs has no
 * cross-import on the v1 module (the two render paths must stay independently buildable/testable).
 * @param {unknown} value
 * @returns {string}
 */
export function cssSafeSuffixV2(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
}

/**
 * Formats the v2 record's `date` field (an ISO "YYYY-MM-DD" string) into the template's corner-date
 * display text, e.g. "2026-06-29" -> "Jun 29, 2026" (matching unit-page-template-v2.html's `.hd-date`
 * sample: "Jun 29, 2026"). Returns null for a missing/malformed date so the DOM layer can render no
 * corner date at all rather than an empty or "Invalid Date" string.
 * @param {string|null|undefined} isoDate
 * @returns {string|null}
 */
export function formatCornerDate(isoDate) {
  if (typeof isoDate !== 'string') return null;
  const match = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const [, yearStr, monthStr, dayStr] = match;
  const year = Number(yearStr);
  const monthIndex = Number(monthStr) - 1;
  const day = Number(dayStr);
  if (monthIndex < 0 || monthIndex > 11 || day < 1 || day > 31) return null;
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${MONTHS[monthIndex]} ${day}, ${year}`;
}

/** Ordered (label, fightRatings key) pairs for the header stat-chip row, matching the template's
 * chip order: tier, rarity, blob, duel, skirm, flank (unit-page-template-v2.html's `.chips` block).
 * fightRatings keys are the SKILL.md contract's own casing: blob/duel/skirm/flank. */
export const FIGHT_RATING_CHIPS_V2 = [
  ['blob', 'blob'],
  ['duel', 'duel'],
  ['skirm', 'skirm'],
  ['flank', 'flank'],
];

/**
 * True for the template's "flank" rating chip specifically (the one chip styled danger-red per
 * unit-page-template-v2.html's `.stat.flank b{color:var(--danger)}` rule) — a fixed per-slot
 * styling choice from the approved template, not a numeric-threshold rule (contrast with v1's
 * value<=1 low-rating heuristic, which this module does not reuse: the v2 template calls out flank
 * by name, not by score).
 * @param {string} label
 * @returns {boolean}
 */
export function isFlankChip(label) {
  return label === 'flank';
}
