// units/units-index.boot.mjs — DOM wiring for the units index page. Consumes the pure logic in
// units-index.mjs (search/filter/sort) and shared/data.mjs (fetchUnitIndex), builds the tile grid
// + filter-chip rows, and wires the search input + chip buttons to re-render on every change.
//
// Markup/classes port design/handoff-academy-pages/design_handoff_immortals_academy/templates/
// Units Index.dc.html (see that file's data-field comments + the handoff README's "Units index"
// template→data map) — class names are the CSS contract, kept exactly as named there
// (unit-tile-grid, unit-tile, unit-tile-icon, tier-chip, richness-badge, filter-chip*,
// empty-result, clear-search). Unlike the handoff's demo (which hardcodes 8 sample tiles with the
// era/class-bucket chips deliberately UNWIRED — REVIEW_PASSES.md §3: "no per-tile era/bucket in
// doc 09"), the real site/data/unit-pages/index.json DOES carry `era` and `classBucket` per unit
// (tools/build-unit-pages/lib/build-index-entry.mjs), so all three filter axes are wired for real
// here — the demo's gap was a sample-data limitation, not a design decision to omit them.
//
// Split from units-index.mjs for the same reason nav.mjs splits buildNav (DOM) from isActiveItem
// (pure) — the filter/sort/search logic is fully unit-testable without a DOM, and this file is the
// thin, harder-to-unit-test DOM layer on top of it.

import { fetchUnitIndex } from '../shared/data.mjs';
import {
  FILTER_ALL,
  TIER_FILTER_CHIPS,
  distinctSorted,
  filterUnits,
  sortForDisplay,
  unitHref,
  richnessBadgeLabel,
  rarityColorVar,
  tierChipText,
} from './units-index.mjs';

// NOTE ON ESCAPING: every text value below is assigned via `.textContent =`, which inserts its
// argument as literal text — the DOM never re-parses it as markup, so there is no injection
// surface and no need for an HTML-escaping helper here. Pre-escaping a string that only ever
// reaches `.textContent` would corrupt real content instead (e.g. a unit name containing an
// apostrophe would visibly render as "&#39;") for zero safety benefit — see the equivalent note in
// unit-page.boot.mjs.

/** classBucket enum -> display label (Title Case; the raw values are lowercase in the data). Also
 * doubles as the era-chip / filter-chip button label map fallback (any string not in this map
 * displays verbatim — era values like "Golden"/"Feudal" are already display-cased in the data). */
const CLASS_BUCKET_LABEL = { melee: 'Melee', ranged: 'Ranged', cavalry: 'Cavalry' };

/**
 * Builds one tile <a> element for a unit index row (Units Index.dc.html `.unit-tile`). Icon: real
 * art path if present, else the coded placeholder tile carrying the unit's own 2-letter code
 * (first letters of up to two name words) tinted by rarity — the handoff's tile grammar (`.unit-
 * tile-icon`, data-field "unit.icon ... coded placeholder tile, rarity-tinted") covers every
 * no-icon unit, at any richness.
 * @param {Record<string, unknown>} unit  one site/data/unit-pages/index.json `units[]` row
 * @returns {HTMLAnchorElement}
 */
function buildTile(unit) {
  const tile = document.createElement('a');
  tile.className = 'unit-tile';
  tile.href = unitHref(unit.slug);

  const rarityColor = rarityColorVar(unit.rarity);

  const iconEl = document.createElement('div');
  iconEl.className = 'unit-tile-icon';
  if (unit.icon) {
    const img = document.createElement('img');
    img.src = new URL(String(unit.icon), new URL('../', import.meta.url)).href;
    img.alt = '';
    img.loading = 'lazy';
    img.width = 40;
    img.height = 40;
    iconEl.appendChild(img);
  } else {
    // Sets only `color` inline — units-index.css's .unit-tile-icon-placeholder rule derives both
    // the text tint AND the 10%/35%-opacity background/border washes from `currentColor` via
    // color-mix(), so one inline property reproduces the handoff's three-part rarity tint
    // (Units Index.dc.html iconStyle: text color + soft background wash + soft border wash, all
    // from the same rarity hex) without fighting a separately-set solid border-color.
    iconEl.classList.add('unit-tile-icon-placeholder');
    iconEl.style.color = rarityColor;
    iconEl.setAttribute('aria-hidden', 'true');
    iconEl.textContent = placeholderCode(unit.name);
  }
  tile.appendChild(iconEl);

  const body = document.createElement('div');
  body.className = 'unit-tile-body';

  const nameEl = document.createElement('span');
  nameEl.className = 'unit-tile-name';
  nameEl.textContent = unit.name;
  body.appendChild(nameEl);

  const chipsEl = document.createElement('span');
  chipsEl.className = 'unit-tile-chips';

  if (tierChipText(unit.tier, unit.rarity)) {
    const tierChip = document.createElement('span');
    tierChip.className = 'tier-chip';
    if (typeof unit.tier === 'string' && unit.tier.length > 0) {
      tierChip.appendChild(document.createTextNode(unit.rarity ? `${unit.tier} ` : unit.tier));
    }
    if (typeof unit.rarity === 'string' && unit.rarity.length > 0) {
      const raritySpan = document.createElement('span');
      raritySpan.className = 'tier-chip-rarity';
      raritySpan.style.color = rarityColor;
      raritySpan.textContent = `· ${unit.rarity}`;
      tierChip.appendChild(raritySpan);
    }
    chipsEl.appendChild(tierChip);
  }

  const richnessChip = document.createElement('span');
  richnessChip.className = `richness-badge richness-badge-${unit.richness === 'full' ? 'full' : 'stats-only'}`;
  richnessChip.textContent = richnessBadgeLabel(unit.richness);
  chipsEl.appendChild(richnessChip);

  body.appendChild(chipsEl);
  tile.appendChild(body);
  return tile;
}

/** Best-effort 1–2 letter placeholder code from a unit name (e.g. "Sunward Phalanx" -> "SP",
 * "Azaps" -> "AZ") — same grammar as the handoff's hand-picked sample codes (Units Index.dc.html's
 * `data` array), derived rather than hardcoded so it works for all 149 names, not just the 8-tile
 * sample. First letter of the first word, plus first letter of the second word if one exists, else
 * the first two letters of the sole word. */
function placeholderCode(name) {
  const words = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/**
 * Builds one `.filter-chip` button. `isActive` drives the handoff's gold-vs-neutral chip style
 * (Units Index.dc.html tierOpts: active = gold text/border/wash, inactive = neutral elevated
 * surface) — kept as a CSS class toggle (`is-active`) rather than inline styles so the visual
 * contract lives in units-index.css, not in this DOM layer.
 * @param {string} label
 * @param {string} extraClass
 * @param {boolean} isActive
 * @param {() => void} onClick
 * @returns {HTMLButtonElement}
 */
function filterChip(label, extraClass, isActive, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `filter-chip ${extraClass}${isActive ? ' is-active' : ''}`;
  btn.textContent = label;
  btn.setAttribute('aria-pressed', String(isActive));
  btn.addEventListener('click', onClick);
  return btn;
}

/**
 * Wires the search input + tier/class/era filter-chip rows to filter/sort `units` and re-render
 * the tile grid into `gridEl` on every change. Shows `emptyResultEl` (with the live query echoed
 * per the handoff's "No units match “{query}”." copy) and hides the grid when the current filter
 * combination matches zero units — never an empty grid with no explanation.
 * @param {{
 *   units: Array<Record<string, unknown>>,
 *   gridEl: HTMLElement,
 *   emptyResultEl: HTMLElement,
 *   emptyResultTextEl: HTMLElement,
 *   clearSearchBtn: HTMLElement,
 *   searchInput: HTMLInputElement,
 *   tierChipsEl: HTMLElement,
 *   classChipsEl: HTMLElement,
 *   eraChipsEl: HTMLElement,
 *   resultCountEl?: HTMLElement,
 * }} refs
 */
export function wireUnitsIndex(refs) {
  const {
    units, gridEl, emptyResultEl, emptyResultTextEl, clearSearchBtn, searchInput,
    tierChipsEl, classChipsEl, eraChipsEl, resultCountEl,
  } = refs;

  const eraValues = distinctSorted(units, 'era');
  const classValues = distinctSorted(units, 'classBucket');

  let state = { query: '', tier: 'All', era: FILTER_ALL, classBucket: FILTER_ALL };

  function setState(patch) {
    state = { ...state, ...patch };
    render();
  }

  function renderChipRows() {
    tierChipsEl.innerHTML = '';
    for (const tierValue of TIER_FILTER_CHIPS) {
      tierChipsEl.appendChild(
        filterChip(tierValue, 'filter-chip-tier', state.tier === tierValue, () => setState({ tier: tierValue }))
      );
    }

    classChipsEl.innerHTML = '';
    for (const bucket of classValues) {
      const label = CLASS_BUCKET_LABEL[bucket] || bucket;
      const isActive = state.classBucket === bucket;
      classChipsEl.appendChild(
        filterChip(label, 'filter-chip-bucket', isActive, () =>
          setState({ classBucket: isActive ? FILTER_ALL : bucket })
        )
      );
    }

    eraChipsEl.innerHTML = '';
    for (const era of eraValues) {
      const isActive = state.era === era;
      eraChipsEl.appendChild(
        filterChip(era, 'filter-chip-era', isActive, () => setState({ era: isActive ? FILTER_ALL : era }))
      );
    }
  }

  function render() {
    renderChipRows();

    const filtered = sortForDisplay(
      filterUnits(units, { query: state.query, era: state.era, classBucket: state.classBucket, tier: state.tier })
    );

    gridEl.innerHTML = '';
    if (filtered.length === 0) {
      gridEl.hidden = true;
      emptyResultEl.hidden = false;
      emptyResultTextEl.textContent = `No units match “${state.query}”.`;
    } else {
      gridEl.hidden = false;
      emptyResultEl.hidden = true;
      for (const unit of filtered) gridEl.appendChild(buildTile(unit));
    }
    if (resultCountEl) {
      resultCountEl.textContent = `${filtered.length} of ${units.length} units`;
    }
  }

  searchInput.addEventListener('input', () => setState({ query: searchInput.value }));
  clearSearchBtn.addEventListener('click', () => {
    searchInput.value = '';
    setState({ query: '', tier: 'All', era: FILTER_ALL, classBucket: FILTER_ALL });
  });

  render();
}

/**
 * Full page boot: fetches the compiled unit index and either wires the live grid or renders the
 * honest "index not available yet" empty state (graceful-missing convention, see data.mjs). Reads
 * every element by id from `document`, matching the ids in units/index.html.
 */
export async function boot() {
  const gridEl = document.getElementById('units-grid');
  const emptyResultEl = document.getElementById('units-empty-result');
  const emptyResultTextEl = document.getElementById('units-empty-result-text');
  const clearSearchBtn = document.getElementById('units-clear-search');
  const searchInput = document.getElementById('units-search');
  const tierChipsEl = document.getElementById('units-filter-tier');
  const classChipsEl = document.getElementById('units-filter-class');
  const eraChipsEl = document.getElementById('units-filter-era');
  const resultCountEl = document.getElementById('units-result-count');
  const controlsEl = document.getElementById('units-controls');
  const countsEl = document.getElementById('units-index-counts');

  const result = await fetchUnitIndex();
  const units = Array.isArray(result.data?.units) ? result.data.units : null;

  if (!result.ok || !units) {
    if (controlsEl) controlsEl.hidden = true;
    gridEl.hidden = true;
    emptyResultEl.hidden = false;
    emptyResultTextEl.textContent = 'Unit index is not available yet — check back once the data build has run.';
    if (clearSearchBtn) clearSearchBtn.hidden = true;
    return;
  }

  if (countsEl) {
    const fullGuideCount = units.filter((u) => u.richness === 'full').length;
    countsEl.textContent = `${units.length} units · ${fullGuideCount} full guides`;
  }

  wireUnitsIndex({
    units, gridEl, emptyResultEl, emptyResultTextEl, clearSearchBtn, searchInput,
    tierChipsEl, classChipsEl, eraChipsEl, resultCountEl,
  });
}
