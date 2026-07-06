// heroes/heroes-index.boot.mjs — DOM wiring for the heroes index page. Consumes the pure logic in
// heroes-index.mjs (tier grouping, hrefs) and shared/data.mjs (fetchHeroIndex), builds the
// tier-table grid, the index-header counts + philosophy line, and the footnote legend.
//
// Ported onto design/handoff-academy-pages/design_handoff_immortals_academy/templates/
// Heroes Index.dc.html — see that file's `data-field` map (also summarized in the handoff
// README's "Heroes index" row): verbatim tier table God->D, `.ordinal` position within tier, AA
// job labels, Epic-Schem badges, Chaindart twice, philosophy line + one-line legend. (The
// template's `.philosophy-line` class name is reserved by hero-page.mjs's H7 role-quote section
// in this same heroes.css file, so this page's philosophy paragraph uses `.hero-index-microcopy`
// only — see heroes.css's file-header comment for the full collision-avoidance rationale.)
//
// Split from heroes-index.mjs for the same reason units-index.boot.mjs splits from
// units-index.mjs — the grouping/href logic is fully unit-testable without a DOM, and this file
// is the thin, harder-to-unit-test DOM layer on top of it.

import { fetchHeroIndex } from '../shared/data.mjs';
import {
  groupByTier,
  heroHref,
  ordinalLabel,
  dualEntryHint,
  otherPlacement,
  distinctClassCount,
  hasMissingClasses,
} from './heroes-index.mjs';

// NOTE ON ESCAPING: every text value below is assigned via `.textContent =` (or `.title =`),
// which inserts its argument as literal text — the DOM never re-parses it as markup, so there is
// no injection surface and no need for an HTML-escaping helper here. An earlier version of this
// file ran values through an escapeHtml() helper before assigning to .textContent, which
// double-escaped them: "Spear & Shield" rendered as the literal string "Spear &amp; Shield" on
// the page, because .textContent never decodes the entities it's given — it just displays them
// as-is. See the equivalent note in units-index.boot.mjs / unit-page.boot.mjs, which never made
// this mistake in the first place.

/**
 * Builds one tierlist row <a> element, matching the design template's `.hero-row` region:
 * ordinal, class name (+ inline variant label for dual entries, per the template's Bastard Sword
 * rows), special-job chip (AA), Epic-Schem tag, dual-entry hint, trailing arrow glyph.
 * @param {Record<string, unknown>} row  one index.json `heroes[]` entry
 * @param {Array<Record<string, unknown>>} allHeroes  the full un-grouped heroes[] array, for
 *   resolving a dual-entry row's counterpart placement (see otherPlacement)
 * @returns {HTMLAnchorElement}
 */
function buildHeroRow(row, allHeroes) {
  const link = document.createElement('a');
  link.className = 'hero-row';
  link.href = heroHref(String(row.slug));
  if (row.isDualEntry) link.classList.add('hero-row-dual-entry');

  const ordinalEl = document.createElement('span');
  ordinalEl.className = 'ordinal hero-row-ordinal';
  ordinalEl.textContent = ordinalLabel(row);
  link.appendChild(ordinalEl);

  const nameEl = document.createElement('span');
  nameEl.className = 'hero-row-name';
  nameEl.textContent = String(row.className);
  if (row.variantLabel) {
    const variantEl = document.createElement('span');
    variantEl.className = 'hero-row-variant';
    variantEl.textContent = String(row.variantLabel);
    nameEl.appendChild(document.createTextNode(' '));
    nameEl.appendChild(variantEl);
  }
  link.appendChild(nameEl);

  if (row.specialJobLabel) {
    const jobChip = document.createElement('span');
    jobChip.className = 'job-label hero-row-job-label';
    jobChip.textContent = String(row.specialJobLabel);
    link.appendChild(jobChip);
  }

  if (row.epicSchemNeeded && row.tierDropNote) {
    const schemChip = document.createElement('span');
    schemChip.className = 'tag-badge tag-epic-schem hero-row-epic-schem-flag';
    schemChip.textContent = 'Epic-Schem';
    schemChip.title = String(row.tierDropNote);
    link.appendChild(schemChip);
  }

  if (row.isDualEntry) {
    const other = otherPlacement(row, allHeroes);
    const hint = other && dualEntryHint(row, other);
    if (hint) {
      const hintEl = document.createElement('span');
      hintEl.className = 'dual-entry-hint hero-row-dual-entry-hint';
      hintEl.textContent = hint;
      link.appendChild(hintEl);
    }
  }

  const spacerEl = document.createElement('span');
  spacerEl.className = 'hero-row-spacer';
  link.appendChild(spacerEl);

  const arrowEl = document.createElement('span');
  arrowEl.className = 'hero-row-arrow';
  arrowEl.setAttribute('aria-hidden', 'true');
  arrowEl.textContent = '→';
  link.appendChild(arrowEl);

  return link;
}

/**
 * Builds one tier-table row group: the fixed-width `.tier-cell` (letter + AA's "special jobs"
 * sub-label) beside a column of `.hero-row`s, matching the template's `.tier-group` region.
 * @param {{ tier: string, rows: Array<Record<string, unknown>> }} section
 * @param {Array<Record<string, unknown>>} allHeroes  full un-grouped heroes[] array (passed
 *   through to buildHeroRow for dual-entry counterpart lookup)
 * @returns {HTMLElement}
 */
function buildTierGroup(section, allHeroes) {
  const wrapper = document.createElement('div');
  wrapper.className = 'tier-group hero-tier-group';
  if (section.tier === 'AA') wrapper.classList.add('tier-group-aa');
  wrapper.setAttribute('role', 'rowgroup');
  wrapper.setAttribute('aria-label', `${section.tier} tier`);

  const cell = document.createElement('div');
  cell.className = 'tier-cell hero-tier-cell';
  const letterEl = document.createElement('span');
  letterEl.className = 'hero-tier-cell-letter';
  letterEl.textContent = section.tier;
  cell.appendChild(letterEl);
  if (section.tier === 'AA') {
    const subLabelEl = document.createElement('span');
    subLabelEl.className = 'hero-tier-cell-sublabel';
    subLabelEl.textContent = 'special jobs';
    cell.appendChild(subLabelEl);
  }
  wrapper.appendChild(cell);

  const rowsEl = document.createElement('div');
  rowsEl.className = 'hero-tier-rows';
  for (const row of section.rows) rowsEl.appendChild(buildHeroRow(row, allHeroes));
  wrapper.appendChild(rowsEl);

  return wrapper;
}

/**
 * Renders the index header's counts line ("N classes · M tierlist entries", template
 * `.index-counts`) from the real fetched row set — never a hardcoded number.
 * @param {HTMLElement} countsEl
 * @param {Array<Record<string, unknown>>} heroes
 */
function renderCounts(countsEl, heroes) {
  if (!countsEl) return;
  const classCount = distinctClassCount(heroes);
  const entryCount = heroes.length;
  countsEl.textContent =
    `${classCount} class${classCount === 1 ? '' : 'es'} · ` +
    `${entryCount} tierlist entr${entryCount === 1 ? 'y' : 'ies'}`;
  countsEl.hidden = false;
}

/**
 * Renders the one-line tierlist-philosophy microcopy (template `.philosophy-line`) into
 * `microcopyEl`, verbatim text from the compiled index's `intro.microcopy` field (see
 * tools/build-hero-pages/lib/intro-block.mjs) — never a paraphrase.
 * @param {HTMLElement} microcopyEl
 * @param {unknown} intro
 */
function renderMicrocopy(microcopyEl, intro) {
  if (!microcopyEl) return;
  const microcopy = intro && typeof intro === 'object' ? intro.microcopy : null;
  if (!microcopy || typeof microcopy.text !== 'string') {
    microcopyEl.hidden = true;
    return;
  }
  microcopyEl.textContent = `“${microcopy.text}”`;
  microcopyEl.hidden = false;
}

/**
 * Renders the footnote legend (template `.index-footnote`, data-field "sources.legend") from the
 * real attribution + generation-date fields the compiled index actually carries
 * (`intro.microcopy.attribution`, top-level `generated`) — the template's own copy names a
 * specific calendar date and a "heroes tierlist" label that aren't data fields in this index's
 * schema, so this renders the honest fields we have rather than fabricating those specifics.
 * @param {HTMLElement} footnoteEl
 * @param {unknown} intro
 * @param {unknown} generated
 */
function renderFootnote(footnoteEl, intro, generated) {
  if (!footnoteEl) return;
  const attribution = intro && typeof intro === 'object' ? intro.microcopy?.attribution : null;
  if (typeof attribution !== 'string') {
    footnoteEl.hidden = true;
    return;
  }
  footnoteEl.innerHTML = '';
  const marker = document.createElement('sup');
  marker.textContent = '1';
  footnoteEl.appendChild(marker);
  const rest = [attribution, typeof generated === 'string' ? generated : null]
    .filter(Boolean)
    .join(' · ');
  footnoteEl.appendChild(
    document.createTextNode(` ${rest} · within a tier, left-to-right source order is preserved (position is data)`)
  );
  footnoteEl.hidden = false;
}

/**
 * Renders an honest note when one or more hero classes have no guide landed yet, rather than
 * silently omitting them with no explanation (graceful-missing convention, see data.mjs).
 * @param {HTMLElement} noteEl
 * @param {unknown} missingSlugs
 */
function renderMissingNote(noteEl, missingSlugs) {
  if (!noteEl) return;
  if (!hasMissingClasses(missingSlugs)) {
    noteEl.hidden = true;
    return;
  }
  const count = missingSlugs.length;
  noteEl.textContent = `${count} class guide${count === 1 ? '' : 's'} still being written — not shown yet.`;
  noteEl.hidden = false;
}

/**
 * Wires the tier-table into `listEl` from an already-fetched `heroes[]` array. Exported
 * separately from boot() so tests can call it directly with fixture data + fake DOM refs.
 * @param {{ heroes: Array<Record<string, unknown>>, listEl: HTMLElement }} refs
 */
export function wireHeroesIndex(refs) {
  const { heroes, listEl } = refs;
  listEl.innerHTML = '';
  const sections = groupByTier(heroes);
  for (const section of sections) listEl.appendChild(buildTierGroup(section, heroes));
}

/**
 * Full page boot: fetches the compiled hero index and either wires the live tierlist or renders
 * the honest "index not available yet" empty state. Reads every element by id from `document`,
 * matching the ids in heroes/index.html.
 */
export async function boot() {
  const listEl = document.getElementById('heroes-list');
  const emptyStateEl = document.getElementById('heroes-empty-state');
  const countsEl = document.getElementById('heroes-counts');
  const microcopyEl = document.getElementById('heroes-microcopy');
  const footnoteEl = document.getElementById('heroes-footnote');
  const missingNoteEl = document.getElementById('heroes-missing-note');

  const result = await fetchHeroIndex();
  const heroes = Array.isArray(result.data?.heroes) ? result.data.heroes : null;

  if (!result.ok || !heroes) {
    if (listEl) listEl.hidden = true;
    if (countsEl) countsEl.hidden = true;
    if (microcopyEl) microcopyEl.hidden = true;
    if (footnoteEl) footnoteEl.hidden = true;
    if (emptyStateEl) {
      emptyStateEl.hidden = false;
      emptyStateEl.textContent = 'Hero index is not available yet — check back once the data build has run.';
    }
    return;
  }

  if (emptyStateEl) emptyStateEl.hidden = true;
  if (listEl) {
    listEl.hidden = false;
    wireHeroesIndex({ heroes, listEl });
  }
  renderCounts(countsEl, heroes);
  renderMicrocopy(microcopyEl, result.data.intro);
  renderFootnote(footnoteEl, result.data.intro, result.data.generated);
  renderMissingNote(missingNoteEl, result.data.missingSlugs);
}
