// heroes/hero-page.mjs — pure logic for the hero detail page: reads a validated
// cb-academy-hero-page/v1 record (site/data/hero-pages/<slug>.json) and shapes it into the
// section-by-section view models hero-page.boot.mjs renders, per
// docs/design-handoff/academy-pages/05-screen-hero-page.md (H1–H7).
//
// Pure/DOM-free by design (same split as units-index.mjs / nav.mjs) so every function here is
// directly node:test-able without a DOM.

/**
 * Reads `?h=<slug>` from a URL (defaults to `window.location` semantics via the `search` string
 * the caller passes in — kept pure/testable rather than reading `window` directly here).
 * @param {string} search  e.g. "?h=shortsword"
 * @returns {string|null}
 */
export function slugFromSearch(search) {
  const params = new URLSearchParams(search);
  const slug = params.get('h');
  return slug && slug.length > 0 ? slug : null;
}

/**
 * Builds the H1 header view model: class name + archetype, tier chip (with position + dual-entry
 * variant label + AA special-job label), Epic-Schem standing note, attribute recommendation, and
 * the last-updated/patch line (same U1a neutral grammar as the unit page, per `05`).
 * @param {Record<string, unknown>} record  a validated hero-page record
 * @returns {object}
 */
export function buildHeaderViewModel(record) {
  const tier = record.tier || {};
  const epicSchematic = record.epicSchematic || {};
  return {
    className: record.className,
    weaponArchetype: record.weaponArchetype,
    tierLabel: tierChipText(tier),
    specialJobLabel: tier.specialJobLabel || null,
    isDualEntryRecord: Array.isArray(tier.epicSchemVariants) && tier.epicSchemVariants.length > 0,
    epicSchemVariants: Array.isArray(tier.epicSchemVariants) ? tier.epicSchemVariants : [],
    epicSchemNote: buildEpicSchemNote(epicSchematic),
    attribute: record.loadout?.attribute ?? null,
    lastUpdated: record.lastUpdated,
    patchNote: record.patchNote,
  };
}

/**
 * "<Tier> · #<position>" chip text — same convention as heroes-index.mjs's tierChipLabel, applied
 * to a raw `tier` block instead of an index row (the detail page's tier field shape is
 * {tier, positionInTier, ...}, matching the schema directly rather than a flattened index row).
 * @param {{tier?: string, positionInTier?: number}} tier
 * @returns {string}
 */
export function tierChipText(tier) {
  if (!tier || typeof tier.tier !== 'string') return '';
  const position = Number.isInteger(tier.positionInTier) ? ` · #${tier.positionInTier}` : '';
  return `${tier.tier}${position}`;
}

/**
 * Builds the Epic-Schem standing note text per `05` H1 ("rated tier assumes the schematic; drops
 * 1–2 tiers if unequipped") — only rendered when the record actually carries a tierDropNote
 * (Epic-Schem-flagged classes only, per hero-page-schema.md §3's tierDropNote field note).
 * @param {{needed?: string, name?: string|null, tierDropNote?: string|null}} epicSchematic
 * @returns {{ needed: string, name: string|null, tierDropNote: string|null } | null}
 */
export function buildEpicSchemNote(epicSchematic) {
  if (!epicSchematic || typeof epicSchematic.needed !== 'string') return null;
  return {
    needed: epicSchematic.needed,
    name: epicSchematic.name ?? null,
    tierDropNote: epicSchematic.tierDropNote ?? null,
  };
}

/**
 * Builds the H2 verdict view model. Three states per `08` §10: authored (plain paragraph),
 * draft, absent (the honest "not yet written" line) — hero-page-schema.md §3 notes `verdict: null`
 * is the default for all 15 classes today (no draft state exists yet in this dataset, but the
 * shape supports it for forward-compatibility: a draft is any non-null string, same "authored"
 * rendering for now since no draft-badge signal exists in the schema).
 * @param {unknown} verdict
 * @returns {{ state: 'authored'|'absent', text: string|null }}
 */
export function buildVerdictViewModel(verdict) {
  if (typeof verdict === 'string' && verdict.length > 0) {
    return { state: 'authored', text: verdict };
  }
  return { state: 'absent', text: null };
}

/**
 * Builds the H3 loadout panel view model straight from the record's `loadout` block. Per `08`
 * §17: runes may be the literal string "unknown" (never blank/omitted) — this function passes
 * it through as-is, the boot layer renders whatever string is here honestly.
 * @param {Record<string, unknown>} loadout
 * @returns {object}
 */
export function buildLoadoutViewModel(loadout) {
  const l = loadout || {};
  return {
    attribute: l.attribute ?? null,
    runes: l.runes ?? null,
    bestGender: l.bestGender ?? null,
    genderNote: l.genderNote ?? null,
    armorSets: Array.isArray(l.armorSets) ? l.armorSets : [],
    aimingFlags: l.aimingFlags ?? null,
    weaponStatsNeed: l.weaponStats?.need ?? [],
    weaponStatsBonus: l.weaponStats?.bonus ?? [],
    spellsCore: l.spells?.core ?? [],
    spellsFillerNotes: l.spells?.fillerNotes ?? null,
  };
}

/**
 * The four H3 aiming-flag rows as display-ready {label, on} pairs, or `null` when the source
 * record has no aiming-flags data at all (per hero-page-schema.md, `aimingFlags` is nullable).
 * @param {unknown} aimingFlags
 * @returns {Array<{label: string, on: boolean}> | null}
 */
export function aimingFlagRows(aimingFlags) {
  if (!aimingFlags || typeof aimingFlags !== 'object') return null;
  return [
    { label: 'Assisted aim (hero)', on: Boolean(aimingFlags.assistedAimHero) },
    { label: 'Locked-on (hero)', on: Boolean(aimingFlags.lockedOnHero) },
    { label: 'Assisted aim (units)', on: Boolean(aimingFlags.assistedAimUnits) },
    { label: 'Locked-on (units)', on: Boolean(aimingFlags.lockedOnUnits) },
  ];
}

/**
 * Builds the H4 builds panel view model: passes each build through, plus resolves
 * `epicSchemVariantRef` against the record's own tier.epicSchemVariants[] so the boot layer can
 * render "ties back to the H1 chip" (hero-page-schema.md §3) without re-searching the array
 * itself.
 * @param {unknown} builds
 * @param {unknown} epicSchemVariants
 * @returns {Array<object>}
 */
export function buildBuildsViewModel(builds, epicSchemVariants) {
  if (!Array.isArray(builds)) return [];
  const variants = Array.isArray(epicSchemVariants) ? epicSchemVariants : [];
  return builds.map((build) => {
    const linkedVariant = build.epicSchemVariantRef
      ? variants.find((v) => v.variantName === build.epicSchemVariantRef) || null
      : null;
    return {
      name: build.name,
      summary: build.summary,
      strongVs: build.strongVs ?? null,
      forWhom: build.forWhom ?? null,
      recommended: Boolean(build.recommended),
      linkedVariantTierLabel: linkedVariant ? tierChipText(linkedVariant) : null,
    };
  });
}

/**
 * Builds the H5 matchups view model — passes each entry through with a resolved display class for
 * the strong-vs/weak-vs stance (armor-class-based per `05` H5, not per-unit).
 * @param {unknown} matchups
 * @returns {Array<{vs: string, stance: string, why: string}>}
 */
export function buildMatchupsViewModel(matchups) {
  if (!Array.isArray(matchups)) return [];
  return matchups.map((m) => ({ vs: m.vs, stance: m.stance, why: m.why }));
}

/**
 * Builds the H6 techniques view model — each technique's `steps[]` become chip-ready strings; the
 * boot layer draws the arrow separators.
 * @param {unknown} techniques
 * @returns {Array<{name: string, steps: string[], rhythm: string|null}>}
 */
export function buildTechniquesViewModel(techniques) {
  if (!Array.isArray(techniques)) return [];
  return techniques.map((t) => ({
    name: t.name,
    steps: Array.isArray(t.steps) ? t.steps : [],
    rhythm: t.rhythm ?? null,
  }));
}

/**
 * Builds the gameplay prose-blocks view model (general playstyle text not tied to a named build,
 * per hero-page-schema.md §3's `gameplay[]` field note — Pike's "Hero vs Hero fight" section is
 * this shape). Passthrough with a defensive array guard.
 * @param {unknown} gameplay
 * @returns {Array<{text: string, attribution: string}>}
 */
export function buildGameplayViewModel(gameplay) {
  if (!Array.isArray(gameplay)) return [];
  return gameplay.map((g) => ({ text: g.text, attribution: g.attribution }));
}

/**
 * Builds the H7 footer view model: two-author credit support (per `05` H7 — "must support
 * two-author attribution cleanly") + the tierlist philosophy microcopy line, sourced from the
 * compiled index's `intro.philosophyQuotes` (passed in by the boot layer, since the individual
 * hero record itself carries no philosophy quote — it's a cross-cutting heroes-index/detail-page
 * concern, see tools/build-hero-pages/lib/intro-block.mjs).
 * @param {unknown} authors
 * @param {unknown} sources
 * @param {{text: string, attribution: string}|null} philosophyQuote
 * @returns {object}
 */
export function buildFooterViewModel(authors, sources, philosophyQuote) {
  return {
    authors: Array.isArray(authors) ? authors : [],
    sources: Array.isArray(sources) ? sources : [],
    philosophyQuote: philosophyQuote || null,
  };
}

/**
 * Assembles the full page view model from one validated hero-page record plus the tierlist
 * philosophy quote to show in the footer (sourced from the heroes index's `intro` block, which
 * the boot layer fetches separately — see hero-page.boot.mjs).
 * @param {Record<string, unknown>} record
 * @param {{text: string, attribution: string}|null} [philosophyQuote]
 * @returns {object}
 */
export function buildHeroPageViewModel(record, philosophyQuote = null) {
  const tier = record.tier || {};
  return {
    header: buildHeaderViewModel(record),
    verdict: buildVerdictViewModel(record.verdict),
    loadout: buildLoadoutViewModel(record.loadout),
    builds: buildBuildsViewModel(record.builds, tier.epicSchemVariants),
    matchups: buildMatchupsViewModel(record.matchups),
    techniques: buildTechniquesViewModel(record.techniques),
    gameplay: buildGameplayViewModel(record.gameplay),
    footer: buildFooterViewModel(record.authors, record.sources, philosophyQuote),
  };
}
