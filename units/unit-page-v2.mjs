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

/** The schema tags the cheat-sheet renderer accepts. v3 is a strict superset of the v2 contract
 * (docs/specs/unit-page-v3-template.md) rendered by the SAME layout, so both route here. V2_SCHEMA
 * is kept as the historical name; RENDERABLE_SCHEMAS is the routing set. */
export const V2_SCHEMA = 'cb-unit-page-v2/1';
export const V3_SCHEMA = 'cb-unit-page-v3/1';
export const RENDERABLE_SCHEMAS = new Set([V2_SCHEMA, V3_SCHEMA]);

/**
 * True when `record` carries a schema the cheat-sheet renderer handles (v2 OR its v3 superset,
 * full or insufficient). Used by the boot module to decide "cheat-sheet layout" vs "current v1
 * layout": only records carrying a renderable schema route to the v2/v3 renderer; anything else
 * (missing schema, v1's own schema string, a future schema) keeps rendering through v1 unchanged.
 * Name kept as isV2Schema for call-site stability.
 * @param {unknown} record
 * @returns {boolean}
 */
export function isV2Schema(record) {
  return Boolean(record) && typeof record === 'object' && RENDERABLE_SCHEMAS.has(/** @type {any} */ (record).schema);
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

// ============================================================================
// v3 "Modao Cheat Sheet" layout helpers (design/handoff-unit-page-v3/Modao Cheat Sheet.dc.html,
// imported 2026-07-07). The cheat-sheet redesign keeps the SAME cb-unit-page-v2/1 data contract —
// it only re-arranges/re-groups the same fields — so these helpers live alongside the ones above
// and every one stays pure/DOM-free and node-testable. The DOM layer (unit-page-v2.boot.mjs)
// consumes them to build the new three-band cheat-sheet without inventing any content the record
// doesn't carry.
// ============================================================================

/**
 * True when a prose value reads as an honest "no data" statement rather than real content — used to
 * decide whether a matchups.pressure line / battleRole.formation field should render as its normal
 * content or as a muted empty-state note. Null/blank counts as a no-source note. Detects a leading
 * negative ("No ...", "None", "Not ...", "N/A", "Unknown") and the common "no (direct) source/data/
 * guidance" phrasing the compiler emits (e.g. Modao Battalion's "No direct source on what you
 * pressure." and "No formation guidance in sources."). Deliberately conservative: real content that
 * merely mentions the word "no" mid-sentence (e.g. "You pressure ... no block units survive") is NOT
 * flagged, because the leading-token / "no <noun>" shapes it looks for don't match there.
 * @param {unknown} text
 * @returns {boolean}
 */
export function isNoSourceText(text) {
  if (typeof text !== 'string' || text.trim() === '') return true;
  const trimmed = text.trim();
  if (/^(no|none|not|n\/a|unknown)\b/i.test(trimmed)) return true;
  if (/\bno (direct )?(source|sources|data|guidance|match data)\b/i.test(trimmed)) return true;
  return false;
}

/** Matchup relation that means "this unit counters them" — grouped under the green COUNTERS heading
 * (this unit beats them). Distinct from `counters-you` (they beat this unit → COUNTERED). */
export const COUNTER_RELS_V2 = ['counters'];
/** Matchup relations that mean "this beats you" — grouped under the red COUNTERED heading in the
 * cheat-sheet (both the plain counter and the hero-threat variant land here). */
export const COUNTERED_RELS_V2 = ['counters-you', 'hero-threat'];
/** Matchup relations that mean "pairs well with you" — grouped under the gold SYNERGIES heading. */
export const SYNERGY_RELS_V2 = ['pairs'];

/**
 * Regroups a v2 `matchups` object into the cheat-sheet's three semantic buckets:
 *   - `countered` (red): cards whose rel is in COUNTERED_RELS_V2 — units that beat this one.
 *   - `synergies` (gold): cards whose rel is in SYNERGY_RELS_V2 — units this one pairs with.
 *   - `counterCards` (green): cards this unit COUNTERS — the explicit `counters` rel
 *     (COUNTER_RELS_V2), plus any unrecognized/future rel, surfaced here rather than silently
 *     dropped.
 * plus the free-text `pressure` line that fills the green COUNTERS section when there are no
 * counter cards, with `pressureIsNote` flagging whether that line is an honest "no source" note
 * (render muted/dashed) vs real content. Never invents cards or reclassifies — a card with no
 * recognized rel is preserved, not hidden.
 * @param {{cards?: Array<{rel?: string}>, pressure?: string|null}|null|undefined} matchups
 */
export function groupMatchups(matchups) {
  const m = matchups && typeof matchups === 'object' ? matchups : {};
  const cards = Array.isArray(m.cards) ? m.cards : [];
  const isCountered = (c) => COUNTERED_RELS_V2.includes(c.rel);
  const isSynergy = (c) => SYNERGY_RELS_V2.includes(c.rel);
  const countered = cards.filter(isCountered);
  const synergies = cards.filter(isSynergy);
  const counterCards = cards.filter((c) => !isCountered(c) && !isSynergy(c));
  const pressure = typeof m.pressure === 'string' && m.pressure.trim() !== '' ? m.pressure.trim() : null;
  return { counterCards, countered, synergies, pressure, pressureIsNote: isNoSourceText(pressure) };
}

/**
 * Splits a prose field (e.g. battleRole.tips) into bullet-sized segments at inline `{n}` footnote-
 * mark boundaries — each source excerpt in the compiled prose ends with its own `{n}` mark, so a
 * segment (text up to and including its mark) is exactly one attributable point, which the cheat-
 * sheet renders as one diamond-bulleted tip. Text with no marks returns as a single bullet; a
 * trailing tail after the last mark becomes its own bullet; blank/non-string input returns []. The
 * `{n}` marks stay in the returned strings so the DOM layer's parseInlineMarks still turns them
 * into superscripts per bullet.
 * @param {unknown} text
 * @returns {string[]}
 */
export function splitIntoBullets(text) {
  if (typeof text !== 'string') return [];
  const trimmed = text.trim();
  if (trimmed === '') return [];
  const parts = [];
  const re = /\{\d+\}/g;
  let last = 0;
  let match;
  while ((match = re.exec(trimmed)) !== null) {
    const chunk = trimmed.slice(last, re.lastIndex).trim();
    if (chunk) parts.push(chunk);
    last = re.lastIndex;
  }
  const tail = trimmed.slice(last).trim();
  if (tail) parts.push(tail);
  return parts.length > 0 ? parts : [trimmed];
}

/**
 * Derives the cheat-sheet's top-right eyebrow season label (e.g. "SEASON 19 · ALEXANDER") from the
 * record's `headerMeta` line, which carries the season inline as "... Seasonal (S19: Alexander)".
 * Returns null when no season token is present (a non-seasonal unit shows no season eyebrow rather
 * than a fabricated one) — the DOM layer omits the label entirely in that case. Only the season
 * number + name are surfaced; nothing is invented beyond re-casing what headerMeta already states.
 * @param {unknown} headerMeta
 * @returns {string|null}
 */
export function seasonLabelV2(headerMeta) {
  if (typeof headerMeta !== 'string') return null;
  const match =
    headerMeta.match(/S(\d+)\s*:\s*([^)]+?)\s*\)/i) ||
    headerMeta.match(/Season\s*(\d+)\s*[:·-]\s*([A-Za-z][\w '-]*)/i);
  if (!match) return null;
  return `SEASON ${match[1]} · ${match[2].trim().toUpperCase()}`;
}

// ============================================================================
// v3 identity/patch/numbers/learnMore/general helpers (Phase D — the v3 field-surfacing pass,
// 2026-07-14, phase-d-class-contract.md). Same honest-absence discipline as every helper above:
// each function returns null/[]/false rather than a fabricated placeholder when the record carries
// no data for that field, so the DOM layer renders nothing (hidden, not stubbed).
// ============================================================================

/**
 * True when `value` is a string with real (post-trim) content — the shared honest-absence guard
 * reused by the header identity chips, patch strip, and doctrine effect subline below (null,
 * undefined, or whitespace-only all count as "no data", not "empty string worth rendering").
 * @param {unknown} value
 * @returns {boolean}
 */
export function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * The header hero-pairing identity chip's value text (e.g. "Medium & Heavy armors", "Any"), from
 * `identity.heroPairing.text`. Returns null when absent/blank so the DOM layer hides the whole
 * `.cs-id-chip-pairing` chip rather than rendering an empty one (class-contract #2).
 * @param {{heroPairing?: {text?: string}}|null|undefined} identity
 * @returns {string|null}
 */
export function heroPairingChipText(identity) {
  const text = identity && identity.heroPairing ? identity.heroPairing.text : null;
  return isNonEmptyString(text) ? text : null;
}

/**
 * The header mastery identity chip's value text: "Yes" when the unit has a mastery tree with no
 * captured path detail, or "Yes · N-step path" when `mastery.order[]` names N ordered allocation
 * steps (a count, never a fabricated summary of what those steps say — the chip is a small header
 * slot, not a mastery-tree panel). Returns null when `mastery.has` isn't exactly `true`, matching
 * the contract's "hidden when neither exists" rule (class-contract #2).
 * @param {{has?: boolean, order?: string[]}|null|undefined} mastery
 * @returns {string|null}
 */
export function masteryChipText(mastery) {
  if (!mastery || mastery.has !== true) return null;
  if (Array.isArray(mastery.order) && mastery.order.length > 0) return `Yes · ${mastery.order.length}-step path`;
  return 'Yes';
}

/**
 * CSS class suffix for the patch-freshness strip's kind modifier, matching class-contract #3's
 * `.cs-patch-nerf` / `.cs-patch-buff` / `.cs-patch-adjust`. A case-insensitive substring match (not
 * an exact-value lookup) because the compiled `patch.kind` field carries free text like "Nerf" or
 * "Buff/Rework" (see data/unit-pages-v2/iron-reapers.json) — anything that isn't recognizably a
 * nerf or a buff falls back to the neutral "adjust" modifier rather than guessing.
 * @param {unknown} kind
 * @returns {'nerf'|'buff'|'adjust'}
 */
export function patchKindClass(kind) {
  const lower = typeof kind === 'string' ? kind.toLowerCase() : '';
  if (lower.includes('nerf')) return 'nerf';
  if (lower.includes('buff')) return 'buff';
  return 'adjust';
}

/**
 * Display label for the patch strip's `.cs-patch-kind` pill ("NERF" / "BUFF" / "CHANGED"), derived
 * from the same classification as patchKindClass so the pill text and the strip's color modifier
 * never disagree.
 * @param {unknown} kind
 * @returns {'NERF'|'BUFF'|'CHANGED'}
 */
export function patchKindLabel(kind) {
  const cls = patchKindClass(kind);
  if (cls === 'nerf') return 'NERF';
  if (cls === 'buff') return 'BUFF';
  return 'CHANGED';
}

/**
 * True when the Learn More band (class-contract #5) has anything to show: at least one video link
 * or an ask-channel. Both absent means the whole band is omitted (hidden, not an empty panel).
 * @param {{videos?: unknown[], askChannel?: unknown}|null|undefined} learnMore
 * @returns {boolean}
 */
export function hasLearnMoreContent(learnMore) {
  const videos = learnMore && Array.isArray(learnMore.videos) ? learnMore.videos : [];
  return videos.length > 0 || isNonEmptyString(learnMore && learnMore.askChannel);
}

/**
 * Resolves a v3 record's `general[]` key list against the site's shared `unit-general.json` file
 * (schema cb-unit-general/1, `{blocks: {key: {title, body, footnotes, as_of}}}`) into an ordered
 * array of renderable blocks — the specific/GENERAL separator pattern's GENERAL half (class-
 * contract #6). Preserves the record's own key order. A key with no match in `generalFile.blocks`
 * (a stale/renamed key, or a fetch that came back empty) is skipped, not thrown on or rendered as a
 * broken block — missing-key tolerance, the same honest-absence discipline as every other v3 helper
 * here. `generalFile` may be null/malformed (e.g. the fetch failed) — this degrades to an empty
 * blocks map rather than crashing the page (class-contract's "Handle fetch failure gracefully").
 * @param {{general?: unknown}|null|undefined} record
 * @param {{blocks?: Record<string, {title?: string, body?: string, footnotes?: object[]}>}|null|undefined} generalFile
 * @returns {Array<{key: string, title: string, body: string, footnotes: object[]}>}
 */
export function buildGeneralBlocks(record, generalFile) {
  const keys = record && Array.isArray(record.general) ? record.general : [];
  const blocksMap =
    generalFile && typeof generalFile === 'object' && generalFile.blocks && typeof generalFile.blocks === 'object'
      ? generalFile.blocks
      : {};
  const blocks = [];
  for (const key of keys) {
    const raw = blocksMap[key];
    if (!raw || typeof raw !== 'object') continue; // missing-key tolerance: skip silently, never fabricate
    blocks.push({
      key,
      title: isNonEmptyString(raw.title) ? raw.title : '',
      body: isNonEmptyString(raw.body) ? raw.body : '',
      footnotes: Array.isArray(raw.footnotes) ? raw.footnotes : [],
    });
  }
  return blocks;
}
