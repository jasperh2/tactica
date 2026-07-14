// heroes/hero-page-v3.mjs — pure logic deltas for the hero detail page v3, the layout from
// design/handoff-hero-page-v3/Hero Page v3 Shortsword.dc.html (imported from the Claude Design
// project "Tzsum: Home Point Push" 2026-07-14). v3 reuses the v2 pure models where the blocks
// carried over unchanged and adds:
//
//   - the class-specific vs GENERAL split for Tips & Tricks (Jasper, 2026-07-14): bullets and
//     techniques flagged `general: true` in the record render BELOW a separator, class-specific
//     content on top. Controls & Combos consequently shows only class-specific techniques.
//   - the season eyebrow label, derived from weaponRunes.seasonLine (data-provenance rule:
//     season-rotating data names its season; nothing is invented when the line is absent).
//   - the three-column Learn More model (replays+study links / TW recordings / who to ask),
//     fed by clips + learnMore links + askChannel + authors.
//
// Pure/DOM-free by design — every function here is node:test-able without a DOM. Imports only
// the v2 PURE module (never the v2 boot), so the v2 render path stays independently bootable
// as the rollback.

import {
  buildHeaderV2Model,
  buildBattleRoleV2Model,
  buildArmorStatsV2Model,
  buildBuildsV2Model,
  groupHeroMatchups,
  buildFooterV2Model,
  aimingRowsV2,
} from './hero-page-v2.mjs';

export { slugFromSearch, isGapText, tileInitials } from './hero-page-v2.mjs';

/**
 * Eyebrow season label from the weapon-runes season line —
 * "Chaos season (25/06/2026), fetched 13/07/2026 - ..." -> "CHAOS SEASON · 25/06/2026".
 * Null when the record has no parseable season line (label omitted, never guessed).
 */
export function seasonEyebrowLabel(record) {
  const line = record?.weaponRunes?.seasonLine;
  if (typeof line !== 'string') return null;
  const match = line.match(/^\s*([A-Za-z][A-Za-z ]*?)\s+season\s*\(([^)]+)\)/i);
  if (!match) return null;
  return `${match[1].toUpperCase()} SEASON · ${match[2]}`;
}

/** Splits any {…, general?} item list into class-specific and general halves, order preserved. */
export function splitByGeneral(items) {
  const list = Array.isArray(items) ? items : [];
  return {
    specific: list.filter((item) => !item?.general),
    general: list.filter((item) => Boolean(item?.general)),
  };
}

/** v3 bullet-block normalizer — v2's shape plus the `general` flag surviving normalization. */
export function buildBulletBlockV3Model(block) {
  if (!block || typeof block !== 'object') return { intro: null, bullets: [] };
  const bullets = (Array.isArray(block.bullets) ? block.bullets : [])
    .map((b) => {
      if (typeof b === 'string') return { lead: null, text: b, general: false };
      if (b && typeof b === 'object' && typeof b.text === 'string') {
        return { lead: b.lead ?? null, text: b.text, general: Boolean(b.general) };
      }
      return null;
    })
    .filter(Boolean);
  return { intro: typeof block.intro === 'string' ? block.intro : null, bullets };
}

/** One technique normalized for rendering (shared by controls + the tips GENERAL section). */
function techniqueModel(t) {
  return {
    name: t.name,
    steps: Array.isArray(t.steps) ? t.steps : [],
    rhythm: t.rhythm ?? null,
    general: Boolean(t.general),
  };
}

/**
 * Tips & Tricks v3 model: class-specific bullets on top; the GENERAL section below the separator
 * carries general-flagged bullets plus the cross-class techniques (which v3 moves OUT of
 * Controls & Combos so that block stays class-specific too).
 */
export function buildTipsV3Model(record) {
  const block = buildBulletBlockV3Model(record.tips);
  const bullets = splitByGeneral(block.bullets);
  const techniques = splitByGeneral(
    (Array.isArray(record.techniques) ? record.techniques : []).map(techniqueModel),
  );
  return {
    intro: block.intro,
    bullets: bullets.specific,
    general: {
      bullets: bullets.general,
      techniques: techniques.general,
    },
  };
}

/**
 * Controls & Combos v3 model: class-specific techniques only (general ones render in Tips),
 * no clips row (clips move to Learn More's replays column in v3).
 */
export function buildControlsV3Model(record) {
  const loadout = record.loadout || {};
  const techniques = splitByGeneral(
    (Array.isArray(record.techniques) ? record.techniques : []).map(techniqueModel),
  );
  const combos = Array.isArray(record.combos) ? record.combos : [];
  return {
    aiming: aimingRowsV2(loadout.aimingFlags, record.aimingNotes),
    skillCore: loadout.spells?.core ?? [],
    fillerNotes: loadout.spells?.fillerNotes ?? null,
    techniques: techniques.specific,
    combos: combos.map((c) => ({
      name: c.name,
      steps: Array.isArray(c.steps) ? c.steps : [],
      note: c.note ?? null,
    })),
    combosSignoff:
      typeof record.combosSignoff === 'string' && record.combosSignoff !== '' ? record.combosSignoff : null,
    gapNote: record.gapNotes?.controls ?? null,
  };
}

/**
 * Learn More v3 model — the design's three columns:
 *   replays:  study links (v2 learnMore) + clips, with the learnMore intro as column prose
 *   twRecordings: no data field exists yet -> always the honest empty state
 *   ask:      the page-level ask channel + author cards derived from authors[] + sources[0]
 * Nothing here is invented: author descriptions are role-derived phrases over record data.
 */
export function buildLearnMoreV3Model(record) {
  const learnMore = record.learnMore || {};
  const links = (Array.isArray(learnMore.links) ? learnMore.links : [])
    .filter((l) => l && typeof l.label === 'string' && typeof l.href === 'string')
    .map((l) => ({ label: l.label, href: l.href, desc: l.desc ?? null }));
  const clips = (Array.isArray(record.clips) ? record.clips : [])
    .filter((c) => c && typeof c.label === 'string')
    .map((c) => ({ label: c.label, href: c.href ?? null, desc: null }));

  const source = Array.isArray(record.sources) && record.sources.length > 0 ? record.sources[0] : null;
  const sourceName = source && typeof source.source === 'string' ? source.source : null;
  const className = typeof record.className === 'string' ? record.className : 'this class';
  const authors = (Array.isArray(record.authors) ? record.authors : [])
    .filter((a) => a && typeof a.name === 'string')
    .map((a) => {
      let desc;
      if (a.role === 'OP-stat-block') desc = `Stat block author for ${className}`;
      else if (a.role === 'guide-body') desc = `Wrote the ${className} guide`;
      else desc = `Wrote the ${className} guide & stat block`;
      return { name: a.name, desc: sourceName ? `${desc} - ${sourceName}` : desc };
    });

  return {
    intro: typeof learnMore.intro === 'string' ? learnMore.intro : null,
    replays: [...links, ...clips],
    askChannel: typeof record.askChannel === 'string' ? record.askChannel : null,
    authors,
  };
}

/** Assembles the full v3 page model from one hero record + the index philosophy quote. */
export function buildHeroPageV3Model(record, philosophyQuote = null) {
  return {
    seasonLabel: seasonEyebrowLabel(record),
    header: buildHeaderV2Model(record),
    battleRole: buildBattleRoleV2Model(record),
    controls: buildControlsV3Model(record),
    armorStats: buildArmorStatsV2Model(record),
    positioning: buildBulletBlockV3Model(record.positioning),
    tips: buildTipsV3Model(record),
    builds: buildBuildsV2Model(record),
    matchups: groupHeroMatchups(record.matchups),
    learnMore: buildLearnMoreV3Model(record),
    footer: buildFooterV2Model(record, philosophyQuote),
  };
}
