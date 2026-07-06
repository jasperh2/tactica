// units/unit-page-v2.boot.mjs — DOM rendering for the v2 unit-page layout (cb-unit-page-v2/1
// schema). Reference markup/classes: site/units/unit-page-template-v2.html (Jasper-approved
// 2026-07-06). Contract: .claude/skills/unit-template-fill/SKILL.md.
//
// Renders into the v2-specific host elements declared in unit.html (`#unit-v2-*`), kept entirely
// separate from the v1 host tree (`#unit-header`, `#unit-doctrines`, etc.) so the two layouts never
// share a DOM subtree — unit-page.boot.mjs's boot() decides which tree to show/hide based on the
// fetched record's schema field (see that file's dispatch comment).
//
// ESCAPING: every text value below is assigned via `.textContent =` or `document.createTextNode`,
// never `.innerHTML` — matching unit-page.boot.mjs's own no-escaping-needed rationale (see that
// file's header comment). The one exception that LOOKS like markup injection, parseInlineMarks,
// is not one: it splits a string on `{n}` tokens and builds `<sup>` elements via
// document.createElement + textContent, so a unit name or note containing a literal `{` or `}`
// character (not a footnote mark) still renders as plain text, never re-parsed as HTML.

import {
  footnoteLegendTextV2,
  parseInlineMarks,
  doctrineTagLabelV2,
  doctrineTagClassV2,
  matchupRelationLabelV2,
  cssSafeSuffixV2,
  formatCornerDate,
  FIGHT_RATING_CHIPS_V2,
  isFlankChip,
} from './unit-page-v2.mjs';

/** Builds a house lock glyph span (🔒) — same contract as unit-page.boot.mjs's lockGlyph (calm,
 * never alarm-styled; the text it decorates already carries the "house" meaning on its own). */
function lockGlyph() {
  const lock = document.createElement('span');
  lock.className = 'lock';
  lock.setAttribute('aria-label', 'house source');
  lock.textContent = '🔒';
  return lock;
}

/** Appends a lock glyph to `parent` only when `isHouse` is true.
 *
 * MERGED-GUIDE POLICY (Jasper, 2026-07-06 — see DECISIONS.md): house and public
 * are one coherent guide now ("I never wanted... a distinction between house and
 * public"), so the 🔒 house marker is NOT rendered — house-sourced facts read
 * identically to public ones. The `house:true` flags remain in the data (and the
 * `lockGlyph`/`card.house`/`fn.house` plumbing stays wired) so re-enabling the
 * marker for a future re-gate is a one-line change here. */
function appendLockIfHouse(_parent, _isHouse) {
  // intentionally a no-op under the merged-guide policy
}

/** Builds a `<sup>` footnote-mark element (e.g. "1", "2 3" for multiple marks on one field). */
function footnoteSup(marks) {
  const sup = document.createElement('sup');
  sup.textContent = Array.isArray(marks) && marks.length > 0 ? marks.join(' ') : '';
  return sup;
}

/**
 * Appends `text` to `parent`, converting inline `{n}` footnote-mark placeholders into `<sup>`
 * elements as it goes (contract: SKILL.md "Inline marks in prose as `{n}` (renderer converts)").
 * Uses parseInlineMarks so a malformed `{...}` token degrades to visible literal text rather than
 * vanishing or throwing.
 * @param {HTMLElement} parent
 * @param {string|null|undefined} text
 */
function appendProseWithMarks(parent, text) {
  for (const segment of parseInlineMarks(text)) {
    if (segment.type === 'text') {
      parent.appendChild(document.createTextNode(segment.value));
    } else {
      parent.appendChild(footnoteSup([segment.value]));
    }
  }
}

// ---- Header (icon, name, meta, corner date, stat chips) ------------------------

/** Renders the v2 header: icon tile, name, meta line, corner date (no sentence — SKILL.md/template
 * hard rule), and the tier/rarity/fightRatings stat-chip row. */
function renderHeaderV2(page, hostEl) {
  hostEl.innerHTML = '';

  const row = document.createElement('div');
  row.className = 'hd';

  const iconEl = document.createElement('div');
  iconEl.className = 'hd-icon';
  iconEl.setAttribute('aria-hidden', 'true');
  row.appendChild(iconEl);

  const identity = document.createElement('div');
  const nameEl = document.createElement('div');
  nameEl.className = 'hd-name';
  nameEl.textContent = page.name;
  identity.appendChild(nameEl);
  if (page.headerMeta) {
    const metaEl = document.createElement('div');
    metaEl.className = 'hd-meta';
    metaEl.textContent = page.headerMeta;
    identity.appendChild(metaEl);
  }
  row.appendChild(identity);

  const cornerDate = formatCornerDate(page.date);
  if (cornerDate) {
    const dateEl = document.createElement('div');
    dateEl.className = 'hd-date';
    dateEl.textContent = cornerDate;
    row.appendChild(dateEl);
  }

  hostEl.appendChild(row);

  const chipsRow = document.createElement('div');
  chipsRow.className = 'chips';
  const stats = page.stats || {};

  if (stats.metaTier) {
    const chip = document.createElement('div');
    chip.className = 'stat tier';
    const b = document.createElement('b');
    b.textContent = stats.metaTier;
    const span = document.createElement('span');
    span.textContent = 'tier';
    chip.append(b, span);
    chipsRow.appendChild(chip);
  }
  if (stats.rarity) {
    const chip = document.createElement('div');
    chip.className = 'stat';
    const b = document.createElement('b');
    b.textContent = stats.rarity;
    const span = document.createElement('span');
    span.textContent = 'rarity';
    chip.append(b, span);
    chipsRow.appendChild(chip);
  }
  if (stats.fightRatings) {
    for (const [label, key] of FIGHT_RATING_CHIPS_V2) {
      const value = stats.fightRatings[key];
      if (value === null || value === undefined) continue;
      const chip = document.createElement('div');
      chip.className = isFlankChip(label) ? 'stat flank' : 'stat';
      const b = document.createElement('b');
      b.textContent = String(value);
      const span = document.createElement('span');
      span.textContent = label;
      chip.append(b, span);
      chipsRow.appendChild(chip);
    }
  }
  hostEl.appendChild(chipsRow);
}

// ---- Pitch box ------------------------------------------------------------------

/** Renders the high-contrast 2-sentence pitch box. Verbatim text, no mark parsing — the pitch is
 * the ONE synthesized text on the page per SKILL.md rule 5 ("everything else traces to a source
 * excerpt"), so it carries no footnote marks by contract. */
function renderPitchV2(page, hostEl) {
  hostEl.innerHTML = '';
  if (!page.pitch) return;
  const p = document.createElement('p');
  p.textContent = page.pitch;
  hostEl.appendChild(p);
}

// ---- Panel title helper ---------------------------------------------------------

/** Builds one v2 panel title: gold accent bar + uppercase mono label + optional footnote sup,
 * matching the template's `.ph` block (`<span class="bar">` + `<h3>` + `<sup>`). */
function panelTitleV2(text, marks) {
  const ph = document.createElement('div');
  ph.className = 'ph';
  const bar = document.createElement('span');
  bar.className = 'bar';
  const h3 = document.createElement('h3');
  h3.textContent = text;
  ph.append(bar, h3);
  if (Array.isArray(marks) && marks.length > 0) ph.appendChild(footnoteSup(marks));
  return ph;
}

function absentNoteV2(text) {
  const p = document.createElement('p');
  p.className = 'empty-state';
  p.textContent = text;
  return p;
}

// ---- Doctrines --------------------------------------------------------------------

/** Renders the doctrines grid: tag pill + name + note per row, no redundant tag words in the note
 * (SKILL.md rule 3 — the compiler already stripped those; the renderer just displays what's given). */
function renderDoctrinesV2(page, hostEl) {
  hostEl.innerHTML = '';
  const entries = Array.isArray(page.doctrines) ? page.doctrines : [];
  hostEl.appendChild(panelTitleV2('Doctrines', collectAllMarks(entries)));

  if (entries.length === 0) {
    hostEl.appendChild(absentNoteV2('No doctrine guide has been captured for this unit yet.'));
    return;
  }

  const grid = document.createElement('div');
  grid.className = 'doc';
  for (const entry of entries) {
    if (entry.tag) {
      const tag = document.createElement('span');
      tag.className = `tag ${doctrineTagClassV2(entry.tag)}`;
      tag.textContent = doctrineTagLabelV2(entry.tag);
      grid.appendChild(tag);
    } else {
      grid.appendChild(document.createElement('span'));
    }

    const nameWrap = document.createElement('span');
    nameWrap.className = 'name';
    nameWrap.appendChild(document.createTextNode(entry.name || ''));
    if (entry.note) {
      const noteEl = document.createElement('span');
      noteEl.className = 'note';
      noteEl.appendChild(document.createTextNode(' — '));
      appendProseWithMarks(noteEl, entry.note);
      nameWrap.appendChild(noteEl);
    }
    grid.appendChild(nameWrap);
  }
  hostEl.appendChild(grid);
}

/** Collects the union of every `marks` array across a list of contract entries, in first-seen
 * order with duplicates removed — used to build a panel title's combined footnote superscript
 * (e.g. Doctrines panel sup shows every source mark used anywhere in the grid, matching the
 * template's `<sup>1</sup>` single combined marker). */
function collectAllMarks(entries) {
  const seen = [];
  for (const entry of entries) {
    if (!Array.isArray(entry.marks)) continue;
    for (const mark of entry.marks) {
      if (!seen.includes(mark)) seen.push(mark);
    }
  }
  return seen;
}

// ---- Veterancy ----------------------------------------------------------------------

/** Renders veterancy: one option per row (SKILL.md rule 4 — never '/'-joined), max one
 * `recommended: true` badge. */
function renderVeterancyV2(page, hostEl) {
  hostEl.innerHTML = '';
  const options = Array.isArray(page.veterancy) ? page.veterancy : [];
  hostEl.appendChild(panelTitleV2('Veterancy', collectAllMarks(options)));

  if (options.length === 0) {
    hostEl.appendChild(absentNoteV2('No veterancy recommendation has been captured for this unit yet.'));
    return;
  }

  for (const opt of options) {
    const row = document.createElement('div');
    row.className = 'vet-opt';

    const lbl = document.createElement('span');
    lbl.className = 'lbl';
    lbl.textContent = opt.label || '';
    row.appendChild(lbl);

    if (opt.recommended === true) {
      const rec = document.createElement('span');
      rec.className = 'rec';
      rec.textContent = 'recommended';
      row.appendChild(rec);
    }

    const body = document.createElement('span');
    body.className = 'body';
    appendProseWithMarks(body, opt.body);
    row.appendChild(body);

    hostEl.appendChild(row);
  }
}

// ---- Battle role (real tabs) ----------------------------------------------------------

/** The three battle-role tab keys in template order, paired with their contract field name and
 * display label. A tab whose field is null is hidden entirely (task requirement: "hide a tab whose
 * field is null"), never rendered as an empty pane. */
const BATTLE_ROLE_TABS_V2 = [
  ['positioning', 'pos', 'Positioning'],
  ['formation', 'form', 'Formation'],
  ['tips', 'tips', 'Tips & tricks'],
];

/** Renders the Battle role panel: real clickable tabs (role="tablist"/"tab"), one pane visible at
 * a time via `aria-selected` / `data-active`, wired with click handlers (matching the template's
 * inline `<script>` behavior, ported to addEventListener here). */
function renderBattleRoleV2(page, hostEl) {
  hostEl.innerHTML = '';
  const role = page.battleRole || {};
  const availableTabs = BATTLE_ROLE_TABS_V2.filter(([field]) => role[field] !== null && role[field] !== undefined && role[field] !== '');

  hostEl.appendChild(panelTitleV2('Battle role'));

  if (availableTabs.length === 0) {
    hostEl.appendChild(absentNoteV2('No battle-role guidance has been captured for this unit yet.'));
    return;
  }

  const tabsEl = document.createElement('div');
  tabsEl.className = 'tabs';
  tabsEl.setAttribute('role', 'tablist');

  const panes = [];
  availableTabs.forEach(([field, key, label], index) => {
    const btn = document.createElement('button');
    btn.className = 'tab';
    btn.type = 'button';
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', String(index === 0));
    btn.dataset.t = key;
    btn.textContent = label;
    tabsEl.appendChild(btn);

    const pane = document.createElement('div');
    pane.className = 'tabpane';
    pane.dataset.pane = key;
    pane.dataset.active = String(index === 0);
    appendProseWithMarks(pane, role[field]);
    panes.push(pane);

    btn.addEventListener('click', () => {
      tabsEl.querySelectorAll('.tab').forEach((b) => b.setAttribute('aria-selected', String(b === btn)));
      panes.forEach((p) => { p.dataset.active = String(p.dataset.pane === key); });
    });
  });

  hostEl.appendChild(tabsEl);
  for (const pane of panes) hostEl.appendChild(pane);
}

// ---- Matchups -------------------------------------------------------------------------

/** Renders the matchups panel: per-unit cards + a "you pressure" line. House-flagged cards get the
 * lock glyph on the unit name. */
function renderMatchupsV2(page, hostEl) {
  hostEl.innerHTML = '';
  const matchups = page.matchups || {};
  const cards = Array.isArray(matchups.cards) ? matchups.cards : [];
  hostEl.appendChild(panelTitleV2('Matchups', collectAllMarks(cards)));

  if (cards.length === 0 && !matchups.pressure) {
    hostEl.appendChild(absentNoteV2('No matchup data has been mined for this unit yet.'));
    return;
  }

  if (cards.length > 0) {
    const grid = document.createElement('div');
    grid.className = 'mu';
    for (const card of cards) {
      const cardEl = document.createElement('div');
      cardEl.className = 'mu-card';

      const nameEl = document.createElement('b');
      nameEl.appendChild(document.createTextNode(card.name || ''));
      appendLockIfHouse(nameEl, card.house);
      cardEl.appendChild(nameEl);

      const relEl = document.createElement('span');
      relEl.className = `mu-rel rel-${cssSafeSuffixV2(card.rel)}`;
      relEl.textContent = matchupRelationLabelV2(card.rel);
      cardEl.appendChild(relEl);

      const whyEl = document.createElement('div');
      whyEl.className = 'mu-why';
      whyEl.textContent = card.why || '';
      cardEl.appendChild(whyEl);

      grid.appendChild(cardEl);
    }
    hostEl.appendChild(grid);
  }

  if (matchups.pressure) {
    const pressureEl = document.createElement('div');
    pressureEl.className = 'mu-pressure';
    pressureEl.textContent = matchups.pressure;
    hostEl.appendChild(pressureEl);
  }
}

// ---- Controls -----------------------------------------------------------------------------

/** Renders the controls panel: key-chip loop (with arrows between, `↺` at the end matching the
 * template's looped-sequence convention) + mechanics notes prose. */
function renderControlsV2(page, hostEl) {
  hostEl.innerHTML = '';
  const controls = page.controls || {};
  const loop = Array.isArray(controls.loop) ? controls.loop : [];
  hostEl.appendChild(panelTitleV2('Controls'));

  if (loop.length === 0 && !controls.notes) {
    hostEl.appendChild(absentNoteV2('No control/how-to-use guide has been captured for this unit yet.'));
    return;
  }

  if (loop.length > 0) {
    const loopEl = document.createElement('div');
    loopEl.className = 'loop';

    const labelEl = document.createElement('span');
    labelEl.style.color = 'var(--text-muted)';
    labelEl.appendChild(document.createTextNode('The loop'));
    if (Array.isArray(controls.loopMarks) && controls.loopMarks.length > 0) {
      labelEl.appendChild(footnoteSup(controls.loopMarks));
    }
    loopEl.appendChild(labelEl);

    loop.forEach((step, index) => {
      const chip = document.createElement('span');
      chip.className = 'key';
      chip.textContent = step;
      loopEl.appendChild(chip);
      const arrow = document.createElement('span');
      arrow.className = 'arrow';
      arrow.textContent = index < loop.length - 1 ? '→' : '↺';
      loopEl.appendChild(arrow);
    });

    hostEl.appendChild(loopEl);
  }

  if (controls.notes) {
    const notesEl = document.createElement('div');
    notesEl.className = 'ctrl-note';
    appendProseWithMarks(notesEl, controls.notes);
    hostEl.appendChild(notesEl);
  }
}

// ---- Footer (footnote legend) ---------------------------------------------------------------

/** Renders the footnote legend footer: one entry per footnotes[] record, superscript + author +
 * date, house-locked entries get the glyph. */
function renderFooterV2(page, hostEl) {
  hostEl.innerHTML = '';
  const footnotes = Array.isArray(page.footnotes) ? page.footnotes : [];
  if (footnotes.length === 0) return;

  const leg = document.createElement('span');
  leg.className = 'leg';
  for (const fn of footnotes) {
    const entry = document.createElement('span');
    const sup = document.createElement('sup');
    sup.textContent = String(fn.mark);
    entry.appendChild(sup);
    entry.appendChild(document.createTextNode(` ${footnoteLegendTextV2(fn)}`));
    appendLockIfHouse(entry, fn.house);
    leg.appendChild(entry);
  }
  hostEl.appendChild(leg);
}

/** Renders the honest gaps list, when present (contract: page.gaps[] — "honest one-liners about
 * what no source covers"). Rendered quietly below the footnote legend, never alarm-styled. */
function renderGapsV2(page, hostEl) {
  const gaps = Array.isArray(page.gaps) ? page.gaps : [];
  if (gaps.length === 0) return;
  for (const gap of gaps) {
    const gapEl = document.createElement('div');
    gapEl.className = 'known-gaps';
    gapEl.textContent = gap;
    hostEl.appendChild(gapEl);
  }
}

// ---- Full v2 page render ----------------------------------------------------------------------

/**
 * Renders the full v2 page from a resolved cb-unit-page-v2/1 record into the v2 section hosts
 * declared in units/unit.html (by id). Deep-link anchors (#doctrines, #role, #matchups, #controls)
 * live on the host `<section>` elements in unit.html itself, not rendered here.
 * @param {object} page  a cb-unit-page-v2/1 record (not the insufficient short-circuit shape)
 * @param {Record<string, HTMLElement>} hosts  map of section id -> host element
 */
export function renderUnitPageV2(page, hosts) {
  document.title = `${page.name} — Immortals Academy`;

  renderHeaderV2(page, hosts.header);
  renderPitchV2(page, hosts.pitch);
  renderDoctrinesV2(page, hosts.doctrines);
  renderVeterancyV2(page, hosts.veterancy);
  renderBattleRoleV2(page, hosts.battleRole);
  renderMatchupsV2(page, hosts.matchups);
  renderControlsV2(page, hosts.controls);
  renderFooterV2(page, hosts.footer);
  renderGapsV2(page, hosts.footer);
}
