// heroes/hero-page-v2.mjs — pure logic for the hero detail page v2, the nine-block layout from
// design/handoff-hero-page-v2/Hero Page v2 Shortsword.dc.html (imported from the Claude Design
// project "Tzsum: Home Point Push" 2026-07-13). Block spec:
// docs/design-handoff/hero-page-v2/04-screen-hero-page-v2.md; absence-state rules: 05.
//
// Pure/DOM-free by design (same split as hero-page.mjs / unit-page-v2.mjs) — every function here
// is directly node:test-able without a DOM. No import on the v1 module: the two render paths stay
// independently buildable, per the unit-page v2 precedent.
//
// DATA CONTRACT — v1 base + v2 extension fields (the coordination point with the hero-content
// collection pass running in parallel; site/data/** is read-only to this build):
//   Base: every cb-academy-hero-page/v1 field renders where the 04 delta table moved it
//   (gameplay[] -> Block 2, loadout -> Blocks 5/6, techniques -> Block 6, builds -> 7,
//   matchups -> 8, authors/sources -> 9).
//   Extensions (all OPTIONAL, read off the record when present, honest-empty otherwise —
//   "leave it empty" is the standing rule, never invent):
//     roleLabel: string                          Block 2 label line ("tank / disruptor. A brawler.")
//     positioning: { intro?, bullets: [{lead?, text}] }   Block 3 (NEW in v2)
//     tips:        { intro?, bullets: [{lead?, text}] }   Block 4 (NEW in v2)
//     armorClass: 'Heavy'|'Medium'|'Light'       Block 1 chip + Block 5 ladder intro
//     armorStatPriority: { intro?, tiers: [{grade, label}], quote?: {text, attribution} }
//     statSpreads: [{build, spread, note?}]      Block 5 per-build spreads
//     runesNote: string                          Block 5 note beside the runes value
//     armorRunes: { badge?, intro?, mandatoryNote?, items: [{slot, note?, updated?}] }
//     aimingNotes: { assistedAimHero?, lockedOnHero?, assistedAimUnits?, lockedOnUnits? }  why-notes
//     clips: [{label, href?}]                    Block 6 clips row
//     combos: [{name, steps: [], note?}]         Block 6 combos
//     gapNotes: { controls?, runes? }            supplied [GAP: ...] closers (taxonomy §1)
//     builds[].typeLabel / builds[].altSkill     Block 7 card extras
//   A future `schema: cb-academy-hero-page/v2` tag is fine: fields are additive, nothing here
//   dispatches on the schema string.

/** Reads `?h=<slug>` from a URL search string (duplicated from hero-page.mjs so v2 carries no
 * import on the v1 module it coexists with). */
export function slugFromSearch(search) {
  const params = new URLSearchParams(search);
  const slug = params.get('h');
  return slug && slug.length > 0 ? slug : null;
}

/** "S · #2" chip text from a {tier, positionInTier} block; '' when there is no tier string. */
export function tierChipText(tier) {
  if (!tier || typeof tier.tier !== 'string') return '';
  const position = Number.isInteger(tier.positionInTier) ? ` · #${tier.positionInTier}` : '';
  return `${tier.tier}${position}`;
}

/** "2026-05-21" -> "21/05/2026" (the design's date grammar). Null on anything malformed so the
 * DOM layer can omit the fragment rather than show a broken date. */
export function formatDisplayDate(isoDate) {
  if (typeof isoDate !== 'string') return null;
  const match = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return `${match[3]}/${match[2]}/${match[1]}`;
}

/**
 * Classifies a verbatim epicSchematic.needed capture into the header's short chip word:
 * NEEDED / RECOMMENDED / OPTIONAL / NO — presentation classification only, the verbatim text
 * still renders in full in the header detail line. Null when no rule matches (chip omitted,
 * never guessed). Checked against all 15 real records' values in hero-page-v2.test.mjs.
 */
export function epicSchemChipText(needed) {
  if (typeof needed !== 'string' || needed.trim() === '') return null;
  const text = needed.trim().toLowerCase();
  const hasSoftener = /\b(preferable|recommended|nice|good|worth|valuable|stronger|but)\b/.test(text);
  if (/^yes\b/.test(text)) return 'NEEDED';
  if (/^(not needed|no need)\b/.test(text)) return hasSoftener ? 'OPTIONAL' : 'NO';
  if (/^no\b/.test(text) || /\bdefinitely no\b/.test(text)) return hasSoftener ? 'OPTIONAL' : 'NO';
  if (/\brecommended\b/.test(text)) return 'RECOMMENDED';
  if (/\bneed(ed)?\b/.test(text)) return 'NEEDED';
  return null;
}

/** Coded placeholder-tile initials (the handoff's no-icon grammar): first letters of the first
 * two words, or the first two letters of a single-word name. Always uppercase. */
export function tileInitials(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/** True for supplied content-team honesty lines ("[GAP: ...]") — these render visibly in a quiet
 * mono register wherever they occur (taxonomy §1), never hidden, never dropped. */
export function isGapText(text) {
  return typeof text === 'string' && /^\s*\[GAP\b/i.test(text);
}

/**
 * Splits a v1 build name carrying a parenthetical type label — "Stoneguard (Tank/Brawler)" ->
 * { name: "Stoneguard", typeLabel: "Tank/Brawler" }. A name without one passes through with
 * typeLabel null. An explicit record-level typeLabel (v2 extension) wins over this parse.
 */
export function buildNameParts(rawName) {
  const name = String(rawName ?? '').trim();
  const match = name.match(/^(.*\S)\s*\(([^()]+)\)$/);
  if (!match) return { name, typeLabel: null };
  return { name: match[1], typeLabel: match[2].trim() };
}

// ---- Block 1 · Header -----------------------------------------------------------------------

/**
 * Header model: identity, the chip row (tier chip(s) incl. dual-entry variants + optional armor
 * class + epic-schem classification), and the detail lines (tier provenance, verbatim epic-schem
 * line, standing tier-drop note, freshness line).
 */
export function buildHeaderV2Model(record) {
  const tier = record.tier || {};
  const epic = record.epicSchematic || {};
  const variants = Array.isArray(tier.epicSchemVariants) ? tier.epicSchemVariants : [];
  const isDualEntry = variants.length > 0;

  const tierChips = isDualEntry
    ? variants.map((variant, i) => ({
        value: tierChipText(variant),
        label: variant.specialJobLabel || variant.variantName || (i === 0 ? 'tier · position' : 'general pick'),
      }))
    : [{ value: tierChipText(tier), label: tier.specialJobLabel || 'tier · position' }];

  const tierLine = isDualEntry
    ? variants.map((v) => `${tierChipText(v)}${v.variantName ? ` (${v.variantName})` : ''}`).join(' and ')
    : tierChipText(tier);

  return {
    slug: typeof record.slug === 'string' ? record.slug : null,
    className: record.className,
    weaponArchetype: record.weaponArchetype ?? null,
    iconCode: tileInitials(record.className),
    tierChips: tierChips.filter((c) => c.value !== ''),
    armorClassChip: typeof record.armorClass === 'string' ? record.armorClass.toUpperCase() : null,
    epicChip: epicSchemChipText(epic.needed),
    tierLine: tierLine || null,
    epicSchemLine:
      typeof epic.needed === 'string'
        ? { needed: epic.needed, name: epic.name ?? null }
        : null,
    tierDropNote: epic.tierDropNote ?? null,
    freshnessLine:
      record.patchNote ??
      (record.lastUpdated ? `Guide last updated ${formatDisplayDate(record.lastUpdated) ?? record.lastUpdated}.` : null),
  };
}

// ---- Block 2 · Battle role ------------------------------------------------------------------

/** Battle-role model: optional short role label (v2 extension) + the attributed role prose
 * (v1 gameplay[] fills this slot per the 04 delta table). Empty prose renders an honest line. */
export function buildBattleRoleV2Model(record) {
  const gameplay = Array.isArray(record.gameplay) ? record.gameplay : [];
  return {
    roleLabel: typeof record.roleLabel === 'string' ? record.roleLabel : null,
    paragraphs: gameplay.map((g) => ({ text: g.text, attribution: g.attribution ?? null })),
  };
}

// ---- Blocks 3 + 4 · Positioning | Tips & tricks ----------------------------------------------

/** Normalizes a {intro?, bullets[]} extension block (Blocks 3/4). Bullets may be strings or
 * {lead?, text} objects; both normalize to {lead, text}. Absent -> empty bullets (honest state). */
export function buildBulletBlockModel(block) {
  if (!block || typeof block !== 'object') return { intro: null, bullets: [] };
  const bullets = (Array.isArray(block.bullets) ? block.bullets : [])
    .map((b) => {
      if (typeof b === 'string') return { lead: null, text: b };
      if (b && typeof b === 'object' && typeof b.text === 'string') return { lead: b.lead ?? null, text: b.text };
      return null;
    })
    .filter(Boolean);
  return { intro: typeof block.intro === 'string' ? block.intro : null, bullets };
}

// ---- Block 5 · Armor & stats ----------------------------------------------------------------

/**
 * Armor & stats model, three columns' worth of sub-groups. The epic-schematic set is appended to
 * the armor-set rows (with its needed-status text) unless a set with the same name is already
 * listed — never duplicated, never invented.
 */
export function buildArmorStatsV2Model(record) {
  const loadout = record.loadout || {};
  const epic = record.epicSchematic || {};

  const sets = (Array.isArray(loadout.armorSets) ? loadout.armorSets : []).map((s) => ({
    name: s.name,
    initials: tileInitials(s.name),
    desc: s.purpose ?? null,
    isEpic: false,
    epicNote: null,
  }));
  if (typeof epic.name === 'string' && epic.name.trim() !== '') {
    const already = sets.some((s) => String(s.name).toLowerCase() === epic.name.toLowerCase());
    if (!already) {
      sets.push({
        name: epic.name,
        initials: tileInitials(epic.name),
        desc: epic.needed ?? null,
        isEpic: true,
        epicNote: 'epic schem',
      });
    }
  }

  const priority = record.armorStatPriority;
  const spreads = Array.isArray(record.statSpreads) ? record.statSpreads : [];

  return {
    attribute: loadout.attribute ?? null,
    armorSets: sets,
    statSpreads: spreads.map((s) => ({ build: s.build, spread: s.spread, note: s.note ?? null })),
    statPriority:
      priority && Array.isArray(priority.tiers)
        ? {
            intro: priority.intro ?? null,
            tiers: priority.tiers.map((t) => ({ grade: t.grade, label: t.label })),
            quote: priority.quote ?? null,
          }
        : null,
    weaponStatsNeed: loadout.weaponStats?.need ?? [],
    weaponStatsBonus: loadout.weaponStats?.bonus ?? [],
    gender: loadout.bestGender ? { best: loadout.bestGender, note: loadout.genderNote ?? null } : null,
    runes: {
      value: loadout.runes ?? null,
      note: typeof record.runesNote === 'string' ? record.runesNote : null,
      gapNote: record.gapNotes?.runes ?? null,
    },
    armorRunes:
      record.armorRunes && Array.isArray(record.armorRunes.items)
        ? {
            badge: record.armorRunes.badge ?? null,
            intro: record.armorRunes.intro ?? null,
            mandatoryNote: record.armorRunes.mandatoryNote ?? null,
            items: record.armorRunes.items.map((i) => ({
              slot: i.slot,
              note: i.note ?? null,
              updated: i.updated ?? null,
            })),
          }
        : null,
  };
}

// ---- Block 6 · Controls & combos --------------------------------------------------------------

/** The four aiming rows as {label, on, note} — note is the optional per-setting why-note
 * (v2 extension; taxonomy state 2's annotated aiming rows). Null when the record has no flags. */
export function aimingRowsV2(aimingFlags, aimingNotes) {
  if (!aimingFlags || typeof aimingFlags !== 'object') return null;
  const notes = aimingNotes && typeof aimingNotes === 'object' ? aimingNotes : {};
  return [
    { key: 'assistedAimHero', label: 'Assisted Aiming on Hero' },
    { key: 'lockedOnHero', label: 'Locked on Hero' },
    { key: 'assistedAimUnits', label: 'Assisted Aiming on Units' },
    { key: 'lockedOnUnits', label: 'Locked on Units' },
  ].map(({ key, label }) => ({
    label,
    on: Boolean(aimingFlags[key]),
    note: typeof notes[key] === 'string' ? notes[key] : null,
  }));
}

/** Controls & combos model: aiming rows, CORE skill chips + filler prose, clips, the v1
 * techniques (step chains + rhythm annotation), optional combos, optional closing GAP line. */
export function buildControlsV2Model(record) {
  const loadout = record.loadout || {};
  const techniques = Array.isArray(record.techniques) ? record.techniques : [];
  const combos = Array.isArray(record.combos) ? record.combos : [];
  return {
    aiming: aimingRowsV2(loadout.aimingFlags, record.aimingNotes),
    skillCore: loadout.spells?.core ?? [],
    fillerNotes: loadout.spells?.fillerNotes ?? null,
    clips: Array.isArray(record.clips)
      ? record.clips.map((c) => ({ label: c.label, href: c.href ?? null }))
      : [],
    techniques: techniques.map((t) => ({
      name: t.name,
      steps: Array.isArray(t.steps) ? t.steps : [],
      rhythm: t.rhythm ?? null,
    })),
    combos: combos.map((c) => ({
      name: c.name,
      steps: Array.isArray(c.steps) ? c.steps : [],
      note: c.note ?? null,
    })),
    gapNote: record.gapNotes?.controls ?? null,
  };
}

// ---- Block 7 · Builds -------------------------------------------------------------------------

/** Build cards: parenthetical type labels split out of v1 names (explicit typeLabel wins),
 * linked dual-entry tier variant resolved, at most the record's own `recommended` flags. */
export function buildBuildsV2Model(record) {
  const builds = Array.isArray(record.builds) ? record.builds : [];
  const variants = Array.isArray(record.tier?.epicSchemVariants) ? record.tier.epicSchemVariants : [];
  return builds.map((build) => {
    const parts = buildNameParts(build.name);
    const linkedVariant = build.epicSchemVariantRef
      ? variants.find((v) => v.variantName === build.epicSchemVariantRef) || null
      : null;
    return {
      name: parts.name,
      typeLabel: typeof build.typeLabel === 'string' ? build.typeLabel : parts.typeLabel,
      summary: build.summary ?? null,
      strongVs: build.strongVs ?? null,
      forWhom: build.forWhom ?? null,
      altSkill: typeof build.altSkill === 'string' ? build.altSkill : null,
      recommended: Boolean(build.recommended),
      linkedVariantTierLabel: linkedVariant ? tierChipText(linkedVariant) : null,
    };
  });
}

// ---- Block 8 · Matchups -----------------------------------------------------------------------

/**
 * Groups v1 matchups[] into the design's three columns. Unrecognized stances are surfaced in the
 * synergy column with their raw stance preserved as the card's badge — visible, never dropped
 * (same never-hide rule as unit-page-v2's groupMatchups).
 */
export function groupHeroMatchups(matchups) {
  const entries = Array.isArray(matchups) ? matchups : [];
  const strong = [];
  const weak = [];
  const synergy = [];
  for (const m of entries) {
    const card = { vs: m.vs, why: m.why ?? null, badge: m.build ?? null };
    if (m.stance === 'strong-vs') strong.push(card);
    else if (m.stance === 'weak-vs') weak.push(card);
    else if (m.stance === 'synergy' || m.stance === 'pairs-with') synergy.push(card);
    else synergy.push({ ...card, badge: m.stance ? String(m.stance) : card.badge });
  }
  return { strong, weak, synergy };
}

// ---- Block 9 · Footer ---------------------------------------------------------------------------

/** Footer model: the two-author credit parts, source dates, and the verbatim philosophy quote
 * (supplied by the boot layer from the heroes index intro, same as v1). */
export function buildFooterV2Model(record, philosophyQuote) {
  const authors = Array.isArray(record.authors) ? record.authors : [];
  const creditParts = authors.map((a) => {
    if (a.role === 'OP-stat-block') return `Stat block by ${a.name}`;
    if (a.role === 'guide-body') return `guide by ${a.name}`;
    return a.role ? `${a.name} (${a.role})` : String(a.name);
  });
  const source = Array.isArray(record.sources) && record.sources.length > 0 ? record.sources[0] : null;
  const dates = [];
  if (source?.sourceDate) dates.push(`last guide edit ${formatDisplayDate(source.sourceDate) ?? source.sourceDate}`);
  if (source?.capturedAt) dates.push(`captured ${formatDisplayDate(source.capturedAt) ?? source.capturedAt}`);
  return {
    creditLine: creditParts.join(' · ') || null,
    datesLine: dates.join(' · ') || null,
    philosophyQuote: philosophyQuote || null,
  };
}

// ---- Assembly ------------------------------------------------------------------------------------

/** Assembles the full nine-block page model from one hero record + the index philosophy quote. */
export function buildHeroPageV2Model(record, philosophyQuote = null) {
  return {
    header: buildHeaderV2Model(record),
    battleRole: buildBattleRoleV2Model(record),
    positioning: buildBulletBlockModel(record.positioning),
    tips: buildBulletBlockModel(record.tips),
    armorStats: buildArmorStatsV2Model(record),
    controls: buildControlsV2Model(record),
    builds: buildBuildsV2Model(record),
    matchups: groupHeroMatchups(record.matchups),
    footer: buildFooterV2Model(record, philosophyQuote),
  };
}
