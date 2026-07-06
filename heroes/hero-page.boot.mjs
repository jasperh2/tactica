// heroes/hero-page.boot.mjs — DOM wiring for the hero detail page (?h=<slug>). Consumes the pure
// logic in hero-page.mjs (view-model shaping) and shared/data.mjs, fetches the one hero record +
// the shared index (for the philosophy-quote footer microcopy), and renders H1–H7 per the design
// handoff (design/handoff-academy-pages/design_handoff_immortals_academy/templates/Hero Page.dc.html
// + README.md's cb-academy-hero-page/v1 field map).
//
// Split from hero-page.mjs for the same reason every other boot.mjs in this repo splits from its
// pure-logic sibling: the view-model shaping is fully unit-testable without a DOM, and this file
// is the thin, harder-to-unit-test DOM layer on top of it.
//
// Markup/class names here mirror the handoff template's regions (.hero-header, .stat-chip,
// .loadout-row, .build-card, .matchup-card, .technique, .key-chip, .source-legend, ...) — the
// handoff's own README calls these the "template-safety contract." The handoff's classVariant
// states (shortsword full / poleaxe-epic-schem / chaindart-dual-entry) reflect what the DESIGN
// TOOL's sample data happened to have on hand for the demo, not a rule that real data-bearing
// classes render header-only: every section below renders from whatever the JSON record actually
// has (per this build's "never invent, never gate real data behind a demo prop" policy), so a
// data-rich Epic-Schem or dual-entry class (e.g. Poleaxe, Chaindart) still gets full loadout /
// builds / matchups / techniques / gameplay sections — only the header treatment (Epic-Schem note,
// dual tier chips) is genuinely class-shape-dependent.

import { fetchJson, withCacheBust } from '../shared/data.mjs';
import {
  slugFromSearch,
  aimingFlagRows,
  buildHeroPageViewModel,
} from './hero-page.mjs';

// NOTE ON ESCAPING: every text value below is assigned via `.textContent =` or
// `document.createTextNode(...)`, both of which insert their argument as literal text — the DOM
// never re-parses it as markup, so there is no injection surface and no need for an
// HTML-escaping helper here. An earlier version of this file ran values through an escapeHtml()
// helper before assigning to .textContent, which double-escaped them: "Sword & Shield" rendered
// as the literal string "Sword &amp; Shield" on the page, because .textContent never decodes the
// entities it's given — it just displays them as-is. See the equivalent note in
// units-index.boot.mjs / unit-page.boot.mjs, which never made this mistake in the first place.

/** site/heroes/ -> site/, matching the PATH RESOLUTION convention every shared/units/heroes
 * module uses (import.meta.url-relative, never root-relative — see shared/data.mjs header). */
const SITE_ROOT_URL = new URL('../', import.meta.url);
const HERO_RECORD_DIR_URL = new URL('data/hero-pages/', SITE_ROOT_URL);

/**
 * Fetches one compiled hero-page record by slug. Graceful on missing — same result-envelope
 * contract as shared/data.mjs's fetchJson (this doesn't reuse fetchHeroIndex, which is fixed to
 * index.json; a per-slug record is a sibling file the shared helper doesn't have a named function
 * for yet, so this builds the URL directly using the same root-resolution + cache-bust helpers).
 * @param {string} slug
 * @returns {Promise<{ ok: boolean, data: unknown, error: string|null }>}
 */
function fetchHeroRecord(slug) {
  const url = new URL(`${encodeURIComponent(slug)}.json`, HERO_RECORD_DIR_URL).href;
  return fetchJson(withCacheBust(url));
}

/** Fetches the shared hero index (used here only for its `intro.philosophyQuotes`, per the
 * footer's "one line, VERBATIM from the tierlist quotes" slot). */
function fetchHeroIndexForPhilosophy() {
  const url = new URL('index.json', HERO_RECORD_DIR_URL).href;
  return fetchJson(withCacheBust(url));
}

/** Picks one philosophy quote for the footer — the same "best hero is the one you enjoy" quote
 * the heroes index uses as its microcopy (intro.microcopy), for a consistent voice across both
 * pages. Returns null if the index couldn't be read (graceful-missing — the footer just omits the
 * microcopy line rather than blocking the rest of the page). */
function pickPhilosophyQuote(indexData) {
  const microcopy = indexData && typeof indexData === 'object' ? indexData.intro?.microcopy : null;
  return microcopy && typeof microcopy.text === 'string' ? microcopy : null;
}

/** First two letters of the class name, uppercased — the coded-placeholder-tile grammar the
 * handoff uses everywhere real icon art doesn't exist yet (no icon assets ship with this data;
 * README.md "Assets" section: "the coded placeholder tile ... covers all no-icon units/classes"). */
function placeholderIconCode(className) {
  return String(className || '').slice(0, 2).toUpperCase();
}

/** One `.empty-state` line for a panel whose section array is empty — mirrors
 * unit-page.boot.mjs's `absentNote` (same class, same "honest empty states, never filler" rule
 * from README.md). Without this, an empty builds/matchups/techniques/gameplay array left the
 * panel's title bar + anchor rendered with nothing underneath: a bare box, not a collapsed
 * section or an honest line — verified on 12 of 15 real hero-page records (e.g. spear-and-shield
 * has 3 such gaps at once). Every one of these four sections is optional real-world data (not
 * every class guide covers matchups/builds/techniques/gameplay yet), so this never fabricates
 * content — it only makes the existing absence legible instead of silent. */
function emptyPanelNote(text) {
  const p = document.createElement('p');
  p.className = 'empty-state';
  p.textContent = text;
  return p;
}

// ---- H1 Header ----

function renderHeader(refs, header) {
  refs.iconEl.textContent = placeholderIconCode(header.className);

  refs.nameEl.textContent = String(header.className);
  refs.archetypeEl.textContent = header.weaponArchetype ? String(header.weaponArchetype) : '';
  refs.archetypeEl.hidden = !header.weaponArchetype;

  // Dual-entry classes (e.g. Chaindart) carry BOTH tierlist placements — render two chips, never
  // merged, per README.md's "class.tierEntries (2 entries, verbatim, never merged)" rule. A
  // single-entry class renders its one tier chip and hides the secondary slot entirely.
  const variants = header.epicSchemVariants;
  if (header.isDualEntryRecord && variants.length > 0) {
    const [first, second] = variants;
    refs.tierChipEl.textContent = `${first.tier}${Number.isInteger(first.positionInTier) ? ` · #${first.positionInTier}` : ''}`;
    refs.tierChipLabelEl.textContent = first.specialJobLabel || 'tier · position';
    refs.tierChipSecondaryWrapEl.hidden = !second;
    if (second) {
      refs.tierChipSecondaryEl.textContent = `${second.tier}${Number.isInteger(second.positionInTier) ? ` · #${second.positionInTier}` : ''}`;
      refs.tierChipSecondaryLabelEl.textContent = second.specialJobLabel || 'general pick';
    }
  } else {
    refs.tierChipEl.textContent = header.tierLabel;
    refs.tierChipLabelEl.textContent = 'tier · position';
    refs.tierChipSecondaryWrapEl.hidden = true;
  }

  if (header.specialJobLabel && !header.isDualEntryRecord) {
    refs.jobLabelEl.textContent = String(header.specialJobLabel);
    refs.jobLabelWrapEl.hidden = false;
  } else {
    refs.jobLabelWrapEl.hidden = true;
  }

  if (header.attribute) {
    refs.attributeChipEl.textContent = String(header.attribute);
    refs.attributeChipWrapEl.hidden = false;
  } else {
    refs.attributeChipWrapEl.hidden = true;
  }

  if (header.epicSchemNote) {
    const { needed, name, tierDropNote } = header.epicSchemNote;
    const parts = [`Epic Schematic: ${needed}`];
    if (name) parts.push(name);
    refs.epicSchemNoteEl.textContent = parts.join(' — ');
    refs.epicSchemNoteEl.hidden = false;
    if (tierDropNote) {
      refs.epicSchemDropNoteEl.textContent = tierDropNote;
      refs.epicSchemDropNoteEl.hidden = false;
    } else {
      refs.epicSchemDropNoteEl.hidden = true;
    }
  } else {
    refs.epicSchemNoteEl.hidden = true;
    refs.epicSchemDropNoteEl.hidden = true;
  }

  if (header.isDualEntryRecord && variants.length > 0) {
    const labels = variants
      .map((v) => `${v.tier}${Number.isInteger(v.positionInTier) ? ` · #${v.positionInTier}` : ''} (${v.variantName})`)
      .join(' and ');
    refs.dualEntryNoteEl.textContent = `Appears twice in the tierlist — both entries verbatim, one page: ${labels}.`;
    refs.dualEntryNoteEl.hidden = false;
  } else {
    refs.dualEntryNoteEl.hidden = true;
  }

  const patchParts = [header.lastUpdated ? `Updated ${header.lastUpdated}` : null, header.patchNote].filter(Boolean);
  refs.lastUpdatedEl.textContent = patchParts.join(' — ');
  refs.lastUpdatedEl.hidden = patchParts.length === 0;
}

// ---- H2 Verdict (rendered inside the header, per the handoff's single-header-block layout) ----

function renderVerdict(refs, verdict) {
  if (verdict.state === 'authored') {
    refs.verdictTextEl.textContent = String(verdict.text);
    refs.verdictTextEl.hidden = false;
    refs.verdictAbsentEl.hidden = true;
  } else {
    refs.verdictTextEl.hidden = true;
    refs.verdictAbsentEl.textContent = 'Verdict — not yet written.';
    refs.verdictAbsentEl.hidden = false;
  }
}

// ---- H3 Loadout ----

function buildLoadoutRow(label, valueText, { valueClass } = {}) {
  const row = document.createElement('div');
  row.className = 'loadout-row';
  const labelEl = document.createElement('span');
  labelEl.className = 'loadout-label';
  labelEl.textContent = label;
  const valueEl = document.createElement('span');
  valueEl.className = valueClass ? `loadout-value ${valueClass}` : 'loadout-value';
  valueEl.textContent = valueText;
  row.append(labelEl, valueEl);
  return row;
}

function renderLoadout(container, loadout) {
  container.innerHTML = '';

  if (loadout.attribute) container.appendChild(buildLoadoutRow('Attribute', loadout.attribute));

  // Runes: literal "unknown" is rendered honestly, never blank/omitted — README.md's
  // "runes-unknown honesty" rule (loadout.runes: "unknown" never renders as an empty/missing row).
  container.appendChild(
    buildLoadoutRow('Runes', loadout.runes ?? 'unknown', {
      valueClass: loadout.runes === 'unknown' || !loadout.runes ? 'loadout-value-unknown' : undefined,
    })
  );

  const genderParts = [loadout.bestGender, loadout.genderNote].filter(Boolean);
  if (genderParts.length > 0) container.appendChild(buildLoadoutRow('Best gender', genderParts.join(' — ')));

  if (loadout.armorSets.length > 0) {
    const row = document.createElement('div');
    row.className = 'loadout-row';
    const labelEl = document.createElement('span');
    labelEl.className = 'loadout-label';
    labelEl.textContent = 'Armor sets';
    const list = document.createElement('span');
    list.className = 'loadout-armor-list';
    loadout.armorSets.forEach((set, i) => {
      if (i > 0) list.appendChild(document.createTextNode(' · '));
      const nameEl = document.createElement('b');
      nameEl.textContent = set.name;
      list.appendChild(nameEl);
      list.appendChild(document.createTextNode(` — ${set.purpose}`));
    });
    row.append(labelEl, list);
    container.appendChild(row);
  }

  const flagRows = aimingFlagRows(loadout.aimingFlags);
  if (flagRows) {
    const row = document.createElement('div');
    row.className = 'loadout-row';
    const labelEl = document.createElement('span');
    labelEl.className = 'loadout-label';
    labelEl.textContent = 'Aiming';
    const flagsEl = document.createElement('span');
    flagsEl.className = 'aiming-flags';
    for (const flag of flagRows) {
      const span = document.createElement('span');
      span.className = `flag-chip ${flag.on ? 'flag-chip-on' : 'flag-chip-off'}`;
      const labelSpan = document.createElement('span');
      labelSpan.textContent = flag.label;
      span.appendChild(labelSpan);
      const valueSpan = document.createElement('b');
      valueSpan.textContent = flag.on ? 'Yes' : 'No';
      span.appendChild(document.createTextNode(' '));
      span.appendChild(valueSpan);
      flagsEl.appendChild(span);
    }
    row.append(labelEl, flagsEl);
    container.appendChild(row);
  }

  if (loadout.weaponStatsNeed.length > 0 || loadout.weaponStatsBonus.length > 0) {
    const row = document.createElement('div');
    row.className = 'loadout-row';
    const labelEl = document.createElement('span');
    labelEl.className = 'loadout-label';
    labelEl.textContent = 'Weapon stats';
    const statsEl = document.createElement('span');
    statsEl.className = 'weapon-stats';
    if (loadout.weaponStatsNeed.length > 0) {
      const needEl = document.createElement('span');
      needEl.className = 'stat-need';
      const needLabel = document.createElement('span');
      needLabel.className = 'stat-need-bonus-label';
      needLabel.textContent = 'need';
      needEl.append(needLabel, document.createTextNode(loadout.weaponStatsNeed.join(' · ')));
      statsEl.appendChild(needEl);
    }
    if (loadout.weaponStatsBonus.length > 0) {
      const bonusEl = document.createElement('span');
      bonusEl.className = 'stat-bonus';
      const bonusLabel = document.createElement('span');
      bonusLabel.className = 'stat-need-bonus-label';
      bonusLabel.textContent = 'bonus';
      bonusEl.append(bonusLabel, document.createTextNode(loadout.weaponStatsBonus.join(' · ')));
      statsEl.appendChild(bonusEl);
    }
    row.append(labelEl, statsEl);
    container.appendChild(row);
  }

  if (loadout.spellsCore.length > 0 || loadout.spellsFillerNotes) {
    const row = document.createElement('div');
    row.className = 'loadout-row';
    const labelEl = document.createElement('span');
    labelEl.className = 'loadout-label';
    labelEl.textContent = 'Spells';
    const valueEl = document.createElement('span');
    valueEl.className = 'loadout-value';
    if (loadout.spellsCore.length > 0) {
      const coreWrap = document.createElement('span');
      coreWrap.className = 'spell-core';
      const coreLabel = document.createElement('span');
      coreLabel.className = 'stat-need-bonus-label';
      coreLabel.textContent = 'core';
      coreWrap.appendChild(coreLabel);
      for (const spell of loadout.spellsCore) {
        const chip = document.createElement('span');
        chip.className = 'key-chip';
        chip.textContent = spell;
        coreWrap.appendChild(chip);
      }
      valueEl.appendChild(coreWrap);
    }
    if (loadout.spellsFillerNotes) {
      const notesEl = document.createElement('span');
      notesEl.className = 'spell-filler-notes';
      notesEl.textContent = loadout.spellsFillerNotes;
      valueEl.appendChild(notesEl);
    }
    row.append(labelEl, valueEl);
    container.appendChild(row);
  }
}

// ---- H4 Builds ----

function buildBuildCard(build) {
  const card = document.createElement('article');
  card.className = build.recommended ? 'build-card build-card-recommended' : 'build-card';

  const headerRow = document.createElement('div');
  headerRow.className = 'build-card-header';
  const nameEl = document.createElement('span');
  nameEl.className = 'build-name';
  nameEl.textContent = String(build.name);
  headerRow.appendChild(nameEl);
  if (build.recommended) {
    const badge = document.createElement('span');
    badge.className = 'badge-recommended';
    badge.textContent = 'best for beginners';
    headerRow.appendChild(badge);
  }
  card.appendChild(headerRow);

  const summaryEl = document.createElement('div');
  summaryEl.className = 'build-identity';
  summaryEl.textContent = String(build.summary);
  card.appendChild(summaryEl);

  if (build.strongVs) {
    const el = document.createElement('div');
    el.className = 'build-card-meta';
    const label = document.createElement('span');
    label.className = 'build-card-meta-label';
    label.textContent = 'Strong vs: ';
    el.appendChild(label);
    el.appendChild(document.createTextNode(String(build.strongVs)));
    card.appendChild(el);
  }
  if (build.forWhom) {
    const el = document.createElement('div');
    el.className = 'build-card-meta';
    const label = document.createElement('span');
    label.className = 'build-card-meta-label';
    label.textContent = 'For: ';
    el.appendChild(label);
    el.appendChild(document.createTextNode(String(build.forWhom)));
    card.appendChild(el);
  }

  if (build.linkedVariantTierLabel) {
    const link = document.createElement('span');
    link.className = 'tag-badge hero-build-variant-ref';
    link.textContent = `Tier chip: ${build.linkedVariantTierLabel}`;
    card.appendChild(link);
  }

  return card;
}

function renderBuilds(container, builds) {
  container.innerHTML = '';
  if (!Array.isArray(builds) || builds.length === 0) {
    container.appendChild(emptyPanelNote('No build guidance has been captured for this class yet.'));
    return;
  }
  for (const build of builds) container.appendChild(buildBuildCard(build));
}

// ---- H5 Matchups ----

function buildMatchupCard(matchup) {
  const card = document.createElement('div');
  card.className = `matchup-card matchup-card-${matchup.stance}`;

  const vsEl = document.createElement('div');
  vsEl.className = 'matchup-name';
  vsEl.textContent = String(matchup.vs);
  card.appendChild(vsEl);

  const stanceEl = document.createElement('span');
  stanceEl.className = `relation-label relation-${matchup.stance}`;
  stanceEl.textContent = matchup.stance === 'strong-vs' ? 'strong vs' : 'weak vs';
  card.appendChild(stanceEl);

  const whyEl = document.createElement('div');
  whyEl.className = 'matchup-why';
  whyEl.textContent = String(matchup.why);
  card.appendChild(whyEl);

  return card;
}

function renderMatchups(container, matchups) {
  container.innerHTML = '';
  if (!Array.isArray(matchups) || matchups.length === 0) {
    container.appendChild(emptyPanelNote('No matchup data has been mined for this class yet.'));
    return;
  }
  for (const matchup of matchups) container.appendChild(buildMatchupCard(matchup));
}

// ---- H6 Techniques ----

function buildTechniqueEl(technique) {
  const wrapper = document.createElement('div');
  wrapper.className = 'technique';

  const nameEl = document.createElement('b');
  nameEl.className = 'technique-name';
  nameEl.textContent = String(technique.name);
  wrapper.appendChild(nameEl);
  wrapper.appendChild(document.createTextNode(' — '));

  const stepsEl = document.createElement('span');
  stepsEl.className = 'key-sequence';
  technique.steps.forEach((step, i) => {
    if (i > 0) {
      const arrow = document.createElement('span');
      arrow.className = 'key-sequence-arrow';
      arrow.textContent = '→';
      arrow.setAttribute('aria-hidden', 'true');
      stepsEl.appendChild(arrow);
    }
    const chip = document.createElement('span');
    chip.className = 'key-chip';
    chip.textContent = String(step);
    stepsEl.appendChild(chip);
  });
  wrapper.appendChild(stepsEl);

  if (technique.rhythm) {
    const rhythmEl = document.createElement('span');
    rhythmEl.className = 'technique-rhythm';
    rhythmEl.textContent = ` ${technique.rhythm}`;
    wrapper.appendChild(rhythmEl);
  }

  return wrapper;
}

function renderTechniques(container, techniques) {
  container.innerHTML = '';
  if (!Array.isArray(techniques) || techniques.length === 0) {
    container.appendChild(emptyPanelNote('No techniques have been captured for this class yet.'));
    return;
  }
  for (const technique of techniques) container.appendChild(buildTechniqueEl(technique));
}

// ---- Gameplay role prose ----

function renderGameplay(container, gameplay) {
  container.innerHTML = '';
  if (!Array.isArray(gameplay) || gameplay.length === 0) {
    container.appendChild(emptyPanelNote('No gameplay-role guidance has been captured for this class yet.'));
    return;
  }
  for (const block of gameplay) {
    const el = document.createElement('p');
    el.className = 'role-quote';
    el.textContent = `“${block.text}”`;
    const attributionEl = document.createElement('span');
    attributionEl.className = 'role-quote-attribution';
    attributionEl.textContent = `— ${block.attribution}`;
    el.appendChild(document.createTextNode(' '));
    el.appendChild(attributionEl);
    container.appendChild(el);
  }
}

// ---- H7 Footer ----

/** Author role -> display label, matching the two-credit pattern per README.md's
 * "co-authored: OP stat-block author + guide-body author" source legend. */
const AUTHOR_ROLE_LABEL = {
  'OP-stat-block': 'OP stat block',
  'guide-body': 'guide body',
  'sole-author': 'author',
};

function renderFooter(refs, footer) {
  refs.authorsEl.innerHTML = '';
  footer.authors.forEach((author, i) => {
    if (i > 0) refs.authorsEl.appendChild(document.createTextNode('  '));
    const el = document.createElement('span');
    el.className = 'hero-footer-author';
    const roleLabel = AUTHOR_ROLE_LABEL[author.role] || author.role;
    el.textContent = `${author.name} · ${roleLabel}${author.date ? ` · ${author.date}` : ''}`;
    refs.authorsEl.appendChild(el);
  });

  if (footer.philosophyQuote) {
    refs.philosophyEl.textContent = `“${footer.philosophyQuote.text}” — ${footer.philosophyQuote.attribution}`;
    refs.philosophyEl.hidden = false;
  } else {
    refs.philosophyEl.hidden = true;
  }
}

/**
 * Wires the full detail page from an already-fetched record + optional philosophy quote. Exported
 * separately from boot() so tests can call it directly with fixture data + fake DOM refs — same
 * split as wireUnitsIndex/wireHeroesIndex.
 * @param {{ record: Record<string, unknown>, philosophyQuote: object|null, refs: object }} args
 */
export function wireHeroPage({ record, philosophyQuote, refs }) {
  const vm = buildHeroPageViewModel(record, philosophyQuote);
  renderHeader(refs.header, vm.header);
  renderVerdict(refs.verdict, vm.verdict);
  renderLoadout(refs.loadoutContainer, vm.loadout);
  renderBuilds(refs.buildsContainer, vm.builds);
  renderMatchups(refs.matchupsContainer, vm.matchups);
  renderTechniques(refs.techniquesContainer, vm.techniques);
  renderGameplay(refs.gameplayContainer, vm.gameplay);
  renderFooter(refs.footer, vm.footer);
}

/**
 * Reads every element by id from `document`, matching the ids in heroes/hero.html, grouped into
 * the same ref-object shape wireHeroPage expects.
 */
function collectRefs() {
  return {
    header: {
      iconEl: document.getElementById('hero-icon'),
      nameEl: document.getElementById('hero-name'),
      archetypeEl: document.getElementById('hero-archetype'),
      tierChipEl: document.getElementById('hero-tier-chip'),
      tierChipLabelEl: document.getElementById('hero-tier-chip-label'),
      tierChipSecondaryWrapEl: document.getElementById('hero-tier-chip-secondary-wrap'),
      tierChipSecondaryEl: document.getElementById('hero-tier-chip-secondary'),
      tierChipSecondaryLabelEl: document.getElementById('hero-tier-chip-secondary-label'),
      jobLabelEl: document.getElementById('hero-job-label'),
      jobLabelWrapEl: document.getElementById('hero-job-label-wrap'),
      attributeChipEl: document.getElementById('hero-attribute-chip'),
      attributeChipWrapEl: document.getElementById('hero-attribute-chip-wrap'),
      dualEntryNoteEl: document.getElementById('hero-dual-entry-note'),
      epicSchemNoteEl: document.getElementById('hero-epic-schem-note'),
      epicSchemDropNoteEl: document.getElementById('hero-epic-schem-drop-note'),
      lastUpdatedEl: document.getElementById('hero-last-updated'),
    },
    verdict: {
      verdictTextEl: document.getElementById('hero-verdict-text'),
      verdictAbsentEl: document.getElementById('hero-verdict-absent'),
    },
    loadoutContainer: document.getElementById('hero-loadout-grid'),
    buildsContainer: document.getElementById('hero-builds-grid'),
    matchupsContainer: document.getElementById('hero-matchups-grid'),
    techniquesContainer: document.getElementById('hero-techniques-list'),
    gameplayContainer: document.getElementById('hero-gameplay-list'),
    footer: {
      authorsEl: document.getElementById('hero-footer-authors'),
      philosophyEl: document.getElementById('hero-footer-philosophy'),
    },
  };
}

/**
 * Full page boot: reads `?h=<slug>` from the URL, fetches the record (+ the index for the
 * footer's philosophy quote), and either wires the live page or renders an honest not-found /
 * not-available state. Graceful-missing at every step per shared/data.mjs's conventions.
 */
export async function boot() {
  const notFoundEl = document.getElementById('hero-not-found');
  const contentEl = document.getElementById('hero-content');

  const slug = slugFromSearch(window.location.search);
  if (!slug) {
    if (contentEl) contentEl.hidden = true;
    if (notFoundEl) {
      notFoundEl.hidden = false;
      notFoundEl.textContent = 'No hero class specified — return to the Heroes index and pick a class.';
    }
    return;
  }

  const [recordResult, indexResult] = await Promise.all([fetchHeroRecord(slug), fetchHeroIndexForPhilosophy()]);

  if (!recordResult.ok || !recordResult.data) {
    if (contentEl) contentEl.hidden = true;
    if (notFoundEl) {
      notFoundEl.hidden = false;
      notFoundEl.textContent = `No guide found for "${slug}" — it may not have been written yet.`;
    }
    return;
  }

  if (notFoundEl) notFoundEl.hidden = true;
  if (contentEl) contentEl.hidden = false;

  const philosophyQuote = pickPhilosophyQuote(indexResult.data);
  wireHeroPage({ record: recordResult.data, philosophyQuote, refs: collectRefs() });
}
