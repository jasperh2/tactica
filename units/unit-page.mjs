// units/unit-page.mjs — pure data-shaping helpers for the unit detail page (?u=<slug>). Consumes
// one compiled cb-academy-unit-page/v1 record (tools/build-unit-pages/README.md) and derives every
// display value the DOM layer (unit-page.boot.mjs) needs: profile fallback selection, matchup
// relation labels, doctrine tag labels, key-sequence parsing, richness/identity-only detection,
// and last-updated sentence composition.
//
// Pure/DOM-free by design (same split as nav.mjs/units-index.mjs) — every function here is
// directly node:test-able without a DOM.
//
// PROFILE FALLBACK (documented per the build brief): the page always PREFERS the house profile's
// JSON over the public one when both exist and the house file is reachable, because the house
// profile is a strict superset — house classification only ever ADDS gated panels/footnotes/gaps
// on top of the same public content, never removes or edits public content (see
// tools/build-unit-pages/lib/house-classification.mjs + the README's Classification guard). This
// matters only for whichever local/gated context can actually fetch site/data/unit-pages/house/
// (that tree is NEVER deployed to public hosting per the architecture spec §Layout — a public
// visitor's fetch simply 404s and silently falls back to the public file, which is exactly the
// desired behavior with zero extra branching).

/**
 * Picks which fetch result to render: prefer the house profile if it resolved OK, else fall back
 * to the public profile. Returns null only if NEITHER resolved (both fetches failed/404'd) — the
 * caller renders the "page not found" state in that case.
 * @param {{ok: boolean, data: unknown}} houseResult
 * @param {{ok: boolean, data: unknown}} publicResult
 * @returns {object|null} the chosen cb-academy-unit-page/v1 record, or null
 */
export function selectProfile(houseResult, publicResult) {
  if (houseResult && houseResult.ok && houseResult.data) return houseResult.data;
  if (publicResult && publicResult.ok && publicResult.data) return publicResult.data;
  return null;
}

/**
 * True when a page has no build/usage guide content at all — only identity + tier context (the
 * 93-of-149 "identity-only" case per docs/design-handoff/academy-pages/04-screen-unit-page.md §U9:
 * "An identity-only unit ... renders U1 + tier context + an honest single invitation line").
 * Mirrors build-index-entry.mjs's GUIDE_PANEL_KEYS exclusion of battleRole — battleRole alone
 * (unit-db's role text) exists for every unit and is not itself a "guide".
 * @param {object} page  a cb-academy-unit-page/v1 record
 * @returns {boolean}
 */
export function isIdentityOnly(page) {
  return GUIDE_PANEL_KEYS.every((key) => page.panels[key] === null);
}

const GUIDE_PANEL_KEYS = ['doctrines', 'veterancy', 'formation', 'matchups', 'controls'];

/** Matchup relation -> human display label. The compiled schema's 4 real relation values (see
 * tools/build-unit-pages output — confirmed across all 149 public pages) are named from THIS
 * unit's perspective, so the labels stay literal rather than forcing the design mockup's
 * Phalanx-specific wording ("hero threat", "counters you") onto every unit's generic matchup
 * data — a `struggles-vs` entry is not necessarily a hero, and relabeling it "hero threat" would
 * be an invented claim the source text doesn't make. */
export const MATCHUP_RELATION_LABELS = {
  'loses-to': 'counters you',
  'struggles-vs': 'struggles vs',
  counters: 'you counter',
  'pairs-with': 'pairs with',
};

/**
 * Human label for a matchup relation string. Unrecognized relations fall back to the raw string
 * itself (never silently dropped) so a future relation value still displays something honest.
 * @param {unknown} relation
 * @returns {string}
 */
export function matchupRelationLabel(relation) {
  return MATCHUP_RELATION_LABELS[relation] || String(relation ?? '');
}

/**
 * Extracts a display name from a matchup entry's `unit` field, which in the compiled schema is
 * observed in TWO real shapes (confirmed against every compiled public+house page): `null` (no
 * named unit resolved — the common case, 166 of 168 entries) or an object `{ displayName, ref,
 * resolution }` (a named-but-unresolved reference — e.g. Sunward Phalanx's "Modao" matchup card,
 * which has no page to link to yet: `resolution: "unresolved"`). Returns null (not a name) for
 * either the no-name case or a malformed/future-shaped value, so callers can fall back to the
 * relation label instead of ever stringifying an object into "[object Object]".
 * @param {null|string|{displayName?: string}} unit
 * @returns {string|null}
 */
export function matchupUnitName(unit) {
  if (typeof unit === 'string' && unit.length > 0) return unit;
  if (unit && typeof unit === 'object' && typeof unit.displayName === 'string' && unit.displayName.length > 0) {
    return unit.displayName;
  }
  return null;
}

/** Doctrine tag -> human display label. */
export const DOCTRINE_TAG_LABELS = {
  mandatory: 'mandatory',
  'top-pick': 'top pick',
  filler: 'filler',
  avoid: 'avoid',
};

/**
 * Human label for a doctrine tag string. Unrecognized tags fall back to the raw string.
 * @param {unknown} tag
 * @returns {string}
 */
export function doctrineTagLabel(tag) {
  return DOCTRINE_TAG_LABELS[tag] || String(tag ?? '');
}

/**
 * CSS-safe class suffix for a doctrine tag or matchup relation (kebab-case, alphanumerics only) —
 * used to build `.unit-doctrine-tag-${suffix}` / `.unit-matchup-relation-${suffix}` class names
 * without ever interpolating an unsanitized string into a class attribute.
 * @param {unknown} value
 * @returns {string}
 */
export function cssSafeSuffix(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
}

/**
 * Composes the one neutral last-updated sentence (U1a) from the `lastUpdated` block. Three states
 * per spec: no-change-signal / changed-by-patch / new-this-season. `patchNote` already carries the
 * full authored sentence for changed-by-patch/new-this-season states (the compiler wrote it); for
 * no-change-signal this function prefixes the neutral "unchanged" framing the spec calls for,
 * since that state's patchNote text (e.g. "Not on the changed-units shortlist — ...") reads
 * awkwardly as a standalone sentence without it — see 04-screen-unit-page.md §U1: "unchanged by
 * the <patch> patch". Never styled as a warning regardless of state (spec: "NEVER alarm/warning
 * styled").
 * @param {object} lastUpdated  a cb-academy-unit-page/v1 record's `lastUpdated` block
 * @returns {string}
 */
export function lastUpdatedSummary(lastUpdated) {
  if (!lastUpdated) return '';
  const parts = [];
  if (lastUpdated.newestDate) parts.push(`Updated ${lastUpdated.newestDate}`);
  if (lastUpdated.patchNote) parts.push(lastUpdated.patchNote);
  if (Array.isArray(lastUpdated.sourceSpan) && lastUpdated.sourceSpan.length === 2) {
    const [oldest, newest] = lastUpdated.sourceSpan;
    if (oldest && newest) parts.push(`sources ${oldest} – ${newest}`);
  }
  return parts.join(' · ');
}

/**
 * Parses a key-sequence strip (U7) from a controls step whose shape is `{ context, steps: [...] }`
 * (the "engage loop" scenario shape observed in tools/build-unit-pages output — distinct from the
 * `{ context, text }` shape used for prose steps). Returns the ordered list of key-chip labels, or
 * an empty array if `stepsBlock` doesn't have a `steps` array to draw from.
 * @param {{context?: string, steps?: string[]}|undefined} stepsBlock
 * @returns {string[]}
 */
export function keySequenceChips(stepsBlock) {
  if (!stepsBlock || !Array.isArray(stepsBlock.steps)) return [];
  return stepsBlock.steps
    .map((step) => keyChipFromStepText(step))
    .filter((chip) => chip !== null);
}

/** Extracts a short key-chip label (e.g. "X", "1", "V") from a full step sentence like "Press V to
 * cancel the brace animation" by matching the compiler's own phrasing conventions ("Press <key>",
 * "<Key>-move in"). Falls back to null (dropped, not guessed) when no recognizable key token is
 * found — never invents a chip label the source text doesn't support. */
function keyChipFromStepText(step) {
  if (typeof step !== 'string') return null;
  const pressMatch = step.match(/^Press ([A-Za-z0-9]+)\b/);
  if (pressMatch) return pressMatch[1];
  const moveMatch = step.match(/^([A-Za-z0-9]+)-move\b/);
  if (moveMatch) return moveMatch[1];
  const useMatch = step.match(/^Use ([A-Za-z0-9 ':’]+?)(?: if| when|,|$)/);
  if (useMatch) return useMatch[1].trim();
  return null;
}

/**
 * Groups controls.steps entries by shape so the DOM layer can render the key-sequence strip
 * (steps-shaped) separately from prose step rows (text-shaped), preserving original order within
 * each group. Both shapes are real and observed across the compiled 149 (see file header).
 * @param {Array<object>|undefined} steps
 * @returns {{ sequenceBlocks: Array<object>, proseBlocks: Array<object> }}
 */
export function groupControlsSteps(steps) {
  if (!Array.isArray(steps)) return { sequenceBlocks: [], proseBlocks: [] };
  const sequenceBlocks = [];
  const proseBlocks = [];
  for (const block of steps) {
    if (Array.isArray(block.steps)) sequenceBlocks.push(block);
    else proseBlocks.push(block);
  }
  return { sequenceBlocks, proseBlocks };
}

/**
 * True when `veterancy.steps` shape is present (unit-db-sourced mastery allocation — see README
 * field note: "the mastery-tree allocation" for 148 units), false when `veterancy.recommendations`
 * shape is present (Sunward Phalanx's richer authored recommendation). Returns null when neither
 * key is present (defensive — should not happen on a non-null veterancy panel, but the DOM layer
 * should render nothing rather than guess).
 * @param {object|null} veterancy
 * @returns {'steps'|'recommendations'|null}
 */
export function veterancyShape(veterancy) {
  if (!veterancy) return null;
  if (Array.isArray(veterancy.steps)) return 'steps';
  if (Array.isArray(veterancy.recommendations)) return 'recommendations';
  return null;
}

/**
 * Resolves footnote superscript marks for a panel that may carry either `footnoteMark` (single
 * number) or `footnoteMarks` (array) — both shapes are used across the compiled schema (e.g.
 * matchups panels sometimes carry one, doctrines/battleRole/veterancy carry the array form).
 * Always returns an array (possibly empty), never null/undefined, so callers can always `.map`.
 * @param {{footnoteMark?: number, footnoteMarks?: number[]}} panel
 * @returns {number[]}
 */
export function footnoteMarksOf(panel) {
  if (!panel) return [];
  if (Array.isArray(panel.footnoteMarks)) return panel.footnoteMarks;
  if (typeof panel.footnoteMark === 'number') return [panel.footnoteMark];
  return [];
}

/**
 * Looks up one footnote record by its mark number from the page's `footnotes[]` ledger. Returns
 * null if not found (a dangling mark reference — should not happen from a well-formed compile,
 * but the DOM layer should render nothing rather than throw).
 * @param {Array<{mark: number}>} footnotes
 * @param {number} mark
 * @returns {object|null}
 */
export function findFootnote(footnotes, mark) {
  if (!Array.isArray(footnotes)) return null;
  return footnotes.find((fn) => fn.mark === mark) || null;
}

/**
 * Formats one footnote legend line: "¹ Amya · 2026-05-26" (house sources get a lock glyph
 * appended by the DOM layer, not here — this only composes the text). Author-only (no date) reads
 * as just the author name, matching footnotes with `date: null` (e.g. "unit-db identity").
 * @param {{author?: string, date?: string|null}} footnote
 * @returns {string}
 */
export function footnoteLegendText(footnote) {
  if (!footnote) return '';
  if (footnote.date) return `${footnote.author} · ${footnote.date}`;
  return String(footnote.author ?? '');
}
