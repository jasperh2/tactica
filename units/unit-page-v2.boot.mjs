// units/unit-page-v2.boot.mjs — DOM rendering for the v2 unit page, "Modao Cheat Sheet" layout.
// Design source: design/handoff-unit-page-v3/Modao Cheat Sheet.dc.html (imported from Claude Design
// 2026-07-07). Data contract is UNCHANGED — still one cb-unit-page-v2/1 record per
// data/unit-pages-v2/<slug>.json (.claude/skills/unit-template-fill/SKILL.md). This redesign only
// re-arranges/re-groups the same fields into a Discord-dark, gold-accented single-page cheat sheet:
//   eyebrow → header widget (icon/name/meta/date/stat-chips + pitch) → three-band grid
//   (doctrines timeline · veterancy+controls · matchups grouped Counters/Countered/Synergies) →
//   full-width battle-role cards → footnote/gaps footer.
//
// The whole tree is built into ONE root element (unit.html's `#unit-v2-page`) so the layout is
// fully owned here, not split across HTML host stubs. unit-page.boot.mjs's boot() shows that root
// (hides the v1 identity-only / full-guide trees) and calls renderUnitPageV2(record, root).
//
// v3 field-surfacing pass (Phase D, 2026-07-14, phase-d-class-contract.md): the same
// cb-unit-page-v3/1 record now carries a handful of optional extra fields, each hidden when
// absent — a doctrine effect subline, header identity chips (hero pairing / mastery), a patch
// freshness strip, a tested-numbers chip row, a Learn More band (mirrors hero-page-v3.boot.mjs),
// and a GENERAL band (the specific/GENERAL separator pattern, CLAUDE.md hard rule) resolved
// against site/data/unit-general.json via unit-page.boot.mjs's extra fetch. Full render order:
// eyebrow → header (+ identity chips) → patch strip → numbers → three-band grid → battleRole →
// learn more → GENERAL band → footer.
//
// ESCAPING: every record-derived value is written via `.textContent` / `document.createTextNode`,
// never `.innerHTML` — same rationale as unit-page.boot.mjs's header comment (the DOM never
// re-parses those as markup, so there is no injection surface and pre-escaping would corrupt real
// content like "Ares' Flurry"). The ONE `.innerHTML` use is `icon()` below, and it only ever
// assigns a compile-time-constant SVG string from SVG_ICONS — never a record value — which is
// exactly the static-markup case that rule explicitly permits. parseInlineMarks likewise builds
// `<sup>` nodes structurally, so a literal `{`/`}` in prose stays plain text.

import {
  footnoteLegendTextV2,
  parseInlineMarks,
  doctrineTagLabelV2,
  doctrineTagClassV2,
  formatCornerDate,
  FIGHT_RATING_CHIPS_V2,
  isFlankChip,
  isNoSourceText,
  groupMatchups,
  splitIntoBullets,
  seasonLabelV2,
  isNonEmptyString,
  heroPairingChipText,
  masteryChipText,
  patchKindClass,
  patchKindLabel,
  hasLearnMoreContent,
  buildGeneralBlocks,
} from './unit-page-v2.mjs';
import { doctrineIconPath } from './doctrine-icon.mjs';

/** site/units/ -> site/ (import.meta.url-relative, never root-relative — same PATH RESOLUTION
 * convention as unit-page.boot.mjs, so icon URLs stay correct under a subpath deploy). */
const SITE_ROOT_URL = new URL('../', import.meta.url);

/** Unit header icon lives at site/assets/unit-icons/<slug>.png (keyed by slug). Not every unit has
 * one (53 of 68 v2 units today); a missing file 404s and the img's error handler swaps in the
 * placeholder tile, so this always returns the candidate path and lets the DOM decide. */
function unitIconPath(slug) {
  return slug ? `assets/unit-icons/${encodeURIComponent(slug)}.png` : null;
}

// ---- Inline SVG icon set (static constants — see file-header ESCAPING note) ----------------------
//
// Small Phosphor-style 24×24 glyphs, `currentColor`-driven so CSS controls their color. Kept inline
// (rather than an icon webfont / CDN) to keep the page self-contained and offline-capable. Every
// value here is a compile-time constant; none is ever built from a record field.

const SVG_ICONS = {
  star: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.5l2.85 6.1 6.65.62-5 4.45 1.46 6.53L12 16.9l-5.96 3.3 1.46-6.53-5-4.45 6.65-.62z"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2l8 3v6c0 5-3.4 8.6-8 11-4.6-2.4-8-6-8-11V5z"/></svg>',
  repeat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12a8 8 0 0 1 13.5-5.8L20 8"/><path d="M20 3v5h-5"/><path d="M20 12a8 8 0 0 1-13.5 5.8L4 16"/><path d="M4 21v-5h5"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="8.6"/><line x1="12" y1="11" x2="12" y2="16.2"/><circle cx="12" cy="7.6" r="1.1" fill="currentColor" stroke="none"/></svg>',
  crosshair: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" aria-hidden="true"><circle cx="12" cy="12" r="6.8"/><line x1="12" y1="1.6" x2="12" y2="5.2"/><line x1="12" y1="18.8" x2="12" y2="22.4"/><line x1="1.6" y1="12" x2="5.2" y2="12"/><line x1="18.8" y1="12" x2="22.4" y2="12"/></svg>',
  grid: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="3" y="3" width="7.6" height="7.6" rx="1.2"/><rect x="13.4" y="3" width="7.6" height="7.6" rx="1.2"/><rect x="3" y="13.4" width="7.6" height="7.6" rx="1.2"/><rect x="13.4" y="13.4" width="7.6" height="7.6" rx="1.2"/></svg>',
  bulb: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M9 20.5h6v1H9zM12 2a7 7 0 0 0-4.2 12.6c.5.4.7.9.7 1.5v.4h7v-.4c0-.6.2-1.1.7-1.5A7 7 0 0 0 12 2z"/></svg>',
};

/**
 * Builds a decorative `<span>` carrying one inline SVG glyph (aria-hidden — icons are decorative in
 * this layout; every glyph is accompanied by a text label). `name` selects a constant from
 * SVG_ICONS; an unknown name falls back to the neutral dot so a slot always renders something.
 * @param {string} name
 * @param {string} [className]
 * @returns {HTMLSpanElement}
 */
function icon(name, className) {
  const span = document.createElement('span');
  span.className = className ? `cs-ic ${className}` : 'cs-ic';
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = SVG_ICONS[name] || ''; // static constant only — never record data
  return span;
}

/**
 * Builds a square icon tile that shows a real image when `iconPath` resolves and a striped
 * placeholder ("holds a place" until real art exists) otherwise. A resolvable path that then 404s
 * swaps itself for the placeholder via the img's error handler, so a stale map entry / missing file
 * never leaves a broken image. Sizing comes from `className` (`cs-head-icon` / `cs-doc-tile`).
 * @param {string} className
 * @param {string|null} iconPath  site-relative path (e.g. "assets/doctrine-icons/<slug>.png") or null
 * @returns {HTMLSpanElement}
 */
function iconTile(className, iconPath) {
  const tile = el('span', className);
  tile.setAttribute('aria-hidden', 'true');
  if (iconPath) {
    const img = document.createElement('img');
    img.src = new URL(iconPath, SITE_ROOT_URL).href;
    img.alt = '';
    img.loading = 'lazy';
    img.addEventListener('error', () => {
      tile.classList.add('is-ph');
      img.remove();
    });
    tile.appendChild(img);
  } else {
    tile.classList.add('is-ph');
  }
  return tile;
}

// ---- Small DOM builders ------------------------------------------------------------------------

/** Creates an element with an optional class and optional textContent (text set via .textContent,
 * so it is inserted literally — never parsed as markup). */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

/** A `<sup>` carrying one or more footnote marks (e.g. "1", or "1 2" when a field cites two
 * sources), matching the design's small mono superscripts. */
function footnoteSup(marks) {
  const sup = document.createElement('sup');
  sup.textContent = Array.isArray(marks) && marks.length > 0 ? marks.join(' ') : '';
  return sup;
}

/** House lock glyph (🔒) — calm, never alarm-styled; the content it marks already carries the
 * "house source" meaning on its own. */
function lockGlyph() {
  const lock = el('span', 'lock', '🔒');
  lock.setAttribute('aria-label', 'house source');
  return lock;
}

/** Appends a lock glyph to `parent` only when `isHouse === true`. */
function appendLockIfHouse(parent, isHouse) {
  if (isHouse === true) parent.appendChild(lockGlyph());
}

/** Appends `text` to `parent`, converting inline `{n}` footnote placeholders into `<sup>` nodes as
 * it goes (contract: SKILL.md "Inline marks in prose as `{n}`"). Degrades a malformed `{...}` token
 * to visible literal text via parseInlineMarks rather than dropping or throwing. */
function appendProseWithMarks(parent, text) {
  for (const segment of parseInlineMarks(text)) {
    if (segment.type === 'text') parent.appendChild(document.createTextNode(segment.value));
    else parent.appendChild(footnoteSup([segment.value]));
  }
}

/** Collects the union of every `marks` array across a list of contract entries, first-seen order,
 * de-duplicated — used to build a panel head's combined footnote superscript. */
function collectAllMarks(entries) {
  const seen = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!Array.isArray(entry.marks)) continue;
    for (const mark of entry.marks) if (!seen.includes(mark)) seen.push(mark);
  }
  return seen;
}

/** One panel head: gold accent bar + uppercase mono label + the panel's combined footnote marks
 * (each mark a separate small mono chip, matching the design's `<span>1</span><span>4</span>...`). */
function panelHead(label, marks) {
  const head = el('div', 'cs-phead');
  head.appendChild(el('span', 'cs-bar'));
  head.appendChild(el('span', 'cs-plabel', label));
  const list = Array.isArray(marks) ? marks : [];
  if (list.length > 0) {
    const marksEl = el('span', 'cs-pmarks');
    for (const mark of list) marksEl.appendChild(el('span', null, String(mark)));
    head.appendChild(marksEl);
  }
  return head;
}

/** A muted empty-state note (used when a whole panel has no captured content). */
function absentNote(text) {
  return el('p', 'cs-empty', text);
}

// ---- Eyebrow -----------------------------------------------------------------------------------

/** The top strip: crest tile + IMMORTALS · UNIT GUIDE + rule + optional SEASON label (derived from
 * headerMeta; omitted entirely for non-seasonal units). */
function renderEyebrow(page) {
  const bar = el('div', 'cs-eyebrow');
  const crest = el('span', 'cs-crest');
  crest.appendChild(icon('shield'));
  bar.appendChild(crest);
  bar.appendChild(el('span', 'cs-brand', 'IMMORTALS'));
  bar.appendChild(el('span', 'cs-kicker', 'UNIT GUIDE'));
  bar.appendChild(el('span', 'cs-rule'));
  const season = seasonLabelV2(page.headerMeta);
  if (season) bar.appendChild(el('span', 'cs-season', season));
  return bar;
}

// ---- Header widget (identity, date, stat chips, pitch) -----------------------------------------

function statChip(value, label, modifier) {
  const chip = el('div', modifier ? `cs-chip ${modifier}` : 'cs-chip');
  chip.appendChild(el('b', null, value));
  chip.appendChild(el('span', null, label));
  return chip;
}

/** One header identity chip: small label + value, e.g. "HERO PAIRING" / "Medium & Heavy armors"
 * (class-contract #2). */
function identityChip(modifier, label, value) {
  const chip = el('div', `cs-id-chip ${modifier}`);
  chip.appendChild(el('span', 'cs-id-chip-label', label));
  chip.appendChild(el('span', 'cs-id-chip-value', value));
  return chip;
}

/** The `.cs-id-chips` row (hero pairing + mastery), or null when the record carries neither —
 * identity.origin/tierHistory are the v3 record's data-only fields and are never surfaced here
 * (task's "NEVER render data-only fields" rule). */
function renderIdentityChips(identity) {
  const pairingText = heroPairingChipText(identity);
  const masteryText = masteryChipText(identity && identity.mastery);
  if (!pairingText && !masteryText) return null;
  const wrap = el('div', 'cs-id-chips');
  if (pairingText) wrap.appendChild(identityChip('cs-id-chip-pairing', 'HERO PAIRING', pairingText));
  if (masteryText) wrap.appendChild(identityChip('cs-id-chip-mastery', 'MASTERY', masteryText));
  return wrap;
}

function renderHeader(page) {
  const section = el('section', 'cs-header');

  const row = el('div', 'cs-head-row');

  const id = el('div', 'cs-id');
  id.appendChild(iconTile('cs-head-icon', unitIconPath(page.slug)));
  const idText = el('div', 'cs-id-text');
  idText.appendChild(el('h1', 'cs-name', page.name));
  if (page.headerMeta) idText.appendChild(el('p', 'cs-meta', page.headerMeta));
  const identityChips = renderIdentityChips(page.identity);
  if (identityChips) idText.appendChild(identityChips);
  id.appendChild(idText);
  row.appendChild(id);

  const right = el('div', 'cs-head-right');
  const cornerDate = formatCornerDate(page.date);
  if (cornerDate) right.appendChild(el('span', 'cs-date', cornerDate));

  const chips = el('div', 'cs-chips');
  const stats = page.stats || {};
  if (stats.metaTier) chips.appendChild(statChip(stats.metaTier, 'tier', 'is-tier'));
  if (stats.rarity) chips.appendChild(statChip(stats.rarity, 'rarity'));
  if (stats.fightRatings) {
    for (const [label, key] of FIGHT_RATING_CHIPS_V2) {
      const value = stats.fightRatings[key];
      if (value === null || value === undefined) continue;
      chips.appendChild(statChip(String(value), label, isFlankChip(label) ? 'is-flank' : null));
    }
  }
  right.appendChild(chips);
  row.appendChild(right);
  section.appendChild(row);

  if (page.pitch) {
    const pitch = el('div', 'cs-pitch');
    pitch.appendChild(el('p', null, page.pitch));
    section.appendChild(pitch);
  }
  return section;
}

// ---- Patch freshness strip + tested-numbers chip row (class-contract #3, #4) -------------------

/** The `.cs-patch` freshness strip, or null when the record carries no `patch` object / it isn't
 * an auto-joined "changed" patch (class-contract #3: "Rendered ONLY when ... changed==true"). */
function renderPatchStrip(page) {
  const patch = page.patch;
  if (!patch || patch.changed !== true) return null;
  const strip = el('div', `cs-patch cs-patch-${patchKindClass(patch.kind)}`);
  strip.appendChild(el('span', 'cs-patch-kind', patchKindLabel(patch.kind)));
  if (isNonEmptyString(patch.summary)) strip.appendChild(el('span', 'cs-patch-summary', patch.summary));
  if (isNonEmptyString(patch.patch)) strip.appendChild(el('span', 'cs-patch-season', patch.patch));
  return strip;
}

/** The `.cs-numbers` tested-numbers chip row, or null when `numbers[]` is empty/absent. */
function renderNumbers(page) {
  const numbers = Array.isArray(page.numbers) ? page.numbers : [];
  if (numbers.length === 0) return null;
  const wrap = el('div', 'cs-numbers');
  for (const entry of numbers) {
    const chip = el('div', 'cs-number');
    chip.appendChild(el('span', 'cs-number-label', entry.label || ''));
    chip.appendChild(el('span', 'cs-number-value', entry.value || ''));
    wrap.appendChild(chip);
  }
  return wrap;
}

// ---- Doctrines (timeline of tiles) -------------------------------------------------------------

function renderDoctrines(page, doctrineIconMap) {
  const panel = el('section', 'cs-panel cs-panel-doctrines');
  const entries = Array.isArray(page.doctrines) ? page.doctrines : [];
  panel.appendChild(panelHead('Doctrines', collectAllMarks(entries)));

  if (entries.length === 0) {
    panel.appendChild(absentNote('No doctrine guide has been captured for this unit yet.'));
    return panel;
  }

  const list = el('div', 'cs-doc-list');
  for (const entry of entries) {
    const rowEl = el('div', 'cs-doc');

    // Real doctrine art keyed by (canonical) name via the exact-match name->slug map; an
    // unresolved/absent name renders the striped placeholder tile ("holds a place" until the name
    // is canonicalized or the art lands), never a wrong icon.
    rowEl.appendChild(iconTile('cs-doc-tile', doctrineIconPath(entry.name, doctrineIconMap)));

    const body = el('div', 'cs-doc-body');
    if (entry.tag) {
      const tag = el('span', `cs-tag is-${doctrineTagClassV2(entry.tag)}`);
      if (entry.tag === 'top-pick') tag.appendChild(icon('star', 'cs-tag-star'));
      tag.appendChild(document.createTextNode(doctrineTagLabelV2(entry.tag)));
      body.appendChild(tag);
    }
    body.appendChild(el('div', 'cs-doc-name', entry.name || ''));
    if (entry.note) {
      const note = el('div', 'cs-doc-note');
      appendProseWithMarks(note, entry.note);
      body.appendChild(note);
    }
    // Official card-effect text (from the doctrine registry) — secondary to the unit-specific
    // note above, so it renders after it. Plain text, not prose-with-marks: this is verbatim card
    // copy, not attributed guide prose (class-contract #1).
    if (isNonEmptyString(entry.effect)) body.appendChild(el('div', 'cs-doc-effect', entry.effect));
    rowEl.appendChild(body);
    list.appendChild(rowEl);
  }
  panel.appendChild(list);
  return panel;
}

// ---- Veterancy ---------------------------------------------------------------------------------

/** A decorative 8-node track: filled gold + gold rail when the line is recommended ("take it"),
 * hollow + muted rail when it's an alternative ("skippable"). Schematic — a visual metaphor for a
 * veterancy line, not a literal node count (the record carries no per-node data). */
function vetTrack(recommended) {
  const track = el('div', `cs-vet-track ${recommended ? 'is-rec' : 'is-skip'}`);
  track.appendChild(el('span', 'cs-vet-line'));
  const dots = el('div', 'cs-vet-dots');
  for (let i = 0; i < 8; i += 1) dots.appendChild(el('span', 'cs-vet-dot'));
  track.appendChild(dots);
  return track;
}

function renderVeterancy(page) {
  const panel = el('section', 'cs-panel cs-panel-veterancy');
  const options = Array.isArray(page.veterancy) ? page.veterancy : [];
  panel.appendChild(panelHead('Veterancy', collectAllMarks(options)));

  if (options.length === 0) {
    panel.appendChild(absentNote('No veterancy recommendation has been captured for this unit yet.'));
    return panel;
  }

  options.forEach((opt, index) => {
    if (index > 0) panel.appendChild(el('div', 'cs-divider'));
    const recommended = opt.recommended === true;
    const optEl = el('div', `cs-vet-opt ${recommended ? 'is-rec' : 'is-alt'}`);

    const head = el('div', 'cs-vet-head');
    const label = el('span', 'cs-vet-label');
    // A "(17 points)"-style parenthetical in the label renders as a muted "· 17 points" detail (the
    // detail is real data — it lives inside the label string — not fabricated).
    const match = typeof opt.label === 'string' ? opt.label.match(/^(.*?)\s*\(([^)]+)\)\s*$/) : null;
    label.appendChild(document.createTextNode(match ? match[1] : opt.label || ''));
    if (match) label.appendChild(el('span', 'cs-vet-detail', `· ${match[2]}`));
    head.appendChild(label);

    const badge = el('span', recommended ? 'cs-vet-badge is-rec' : 'cs-vet-badge is-alt');
    if (recommended) badge.appendChild(icon('star', 'cs-badge-star'));
    badge.appendChild(document.createTextNode(recommended ? 'recommended' : 'alternative'));
    head.appendChild(badge);
    optEl.appendChild(head);

    optEl.appendChild(vetTrack(recommended));

    const body = el('div', 'cs-vet-body');
    appendProseWithMarks(body, opt.body);
    optEl.appendChild(body);

    panel.appendChild(optEl);
  });
  return panel;
}

// ---- Controls ----------------------------------------------------------------------------------

/** True for a "word" key (a named skill like Brace/Overwhelm) vs a single game key (X, 1, V) — used
 * to give the loop's named-action keycaps the gold emphasis the design shows on "Brace". */
function isWordKey(key) {
  return typeof key === 'string' && key.trim().length > 1;
}

function renderControls(page) {
  const panel = el('section', 'cs-panel cs-panel-controls');
  const controls = page.controls || {};
  const loop = Array.isArray(controls.loop) ? controls.loop : [];
  panel.appendChild(panelHead('Controls', []));

  if (loop.length === 0 && !controls.notes) {
    panel.appendChild(absentNote('No control / how-to-use guide has been captured for this unit yet.'));
    return panel;
  }

  if (loop.length > 0) {
    const loopEl = el('div', 'cs-loop');
    const label = el('span', 'cs-loop-label');
    label.appendChild(document.createTextNode('The loop'));
    if (Array.isArray(controls.loopMarks) && controls.loopMarks.length > 0) {
      label.appendChild(footnoteSup(controls.loopMarks));
    }
    loopEl.appendChild(label);

    const keys = el('div', 'cs-keys');
    loop.forEach((step, i) => {
      keys.appendChild(el('span', isWordKey(step) ? 'cs-key is-word' : 'cs-key', step));
      if (i < loop.length - 1) keys.appendChild(el('span', 'cs-key-arrow', '→'));
    });
    keys.appendChild(icon('repeat', 'cs-key-repeat'));
    loopEl.appendChild(keys);
    panel.appendChild(loopEl);
  }

  if (controls.notes) {
    if (loop.length > 0) panel.appendChild(el('div', 'cs-divider'));
    const notes = el('div', 'cs-notes');
    appendProseWithMarks(notes, controls.notes);
    panel.appendChild(notes);
  }
  return panel;
}

// ---- Matchups (Counters / Countered / Synergies) -----------------------------------------------

/** A group heading row: colored square + uppercase label + optional count chip. */
function matchupGroupHead(label, kind, count) {
  const head = el('div', `cs-mu-gh is-${kind}`);
  head.appendChild(el('span', 'cs-mu-dot'));
  head.appendChild(el('span', 'cs-mu-glabel', label));
  if (typeof count === 'number') head.appendChild(el('span', 'cs-mu-count', String(count)));
  return head;
}

/** One matchup card: name (+ house lock) + why-line, colored left border set by `kind`. The why-
 * line's inline {n} marks are parsed via appendProseWithMarks, matching every other prose field in
 * this file (regression: this used to assign card.why straight to el()'s textContent argument, so
 * a literal "{1}" showed up in the rendered text instead of becoming a superscript). */
function matchupCard(card, kind) {
  const cardEl = el('div', `cs-mu-card is-${kind}`);
  const name = el('div', 'cs-mu-name');
  name.appendChild(document.createTextNode(card.name || ''));
  appendLockIfHouse(name, card.house);
  cardEl.appendChild(name);
  if (card.why) {
    const why = el('div', 'cs-mu-why');
    appendProseWithMarks(why, card.why);
    cardEl.appendChild(why);
  }
  return cardEl;
}

function matchupGrid(cards, kind) {
  const grid = el('div', 'cs-mu-grid');
  for (const card of cards) grid.appendChild(matchupCard(card, kind));
  return grid;
}

function renderMatchups(page) {
  const panel = el('section', 'cs-panel cs-panel-matchups');
  const matchups = page.matchups || {};
  const allCards = Array.isArray(matchups.cards) ? matchups.cards : [];
  panel.appendChild(panelHead('Matchups', collectAllMarks(allCards)));

  const { counterCards, countered, synergies, pressure, pressureIsNote } = groupMatchups(matchups);

  if (allCards.length === 0 && pressure === null) {
    panel.appendChild(absentNote('No matchup data has been mined for this unit yet.'));
    return panel;
  }

  // COUNTERS (green) — cards this unit beats (rare in the current schema) or the free-text pressure
  // line; an honest "no source" pressure renders as a muted dashed note.
  panel.appendChild(matchupGroupHead('Counters', 'counter', counterCards.length > 0 ? counterCards.length : null));
  if (counterCards.length > 0) {
    panel.appendChild(matchupGrid(counterCards, 'counter'));
  } else if (pressure && !pressureIsNote) {
    panel.appendChild(el('div', 'cs-mu-pressure', pressure));
  } else {
    const note = el('div', 'cs-mu-note');
    note.appendChild(icon('info', 'cs-mu-note-ic'));
    note.appendChild(document.createTextNode(pressure || 'No direct source on what this unit pressures.'));
    panel.appendChild(note);
  }

  // COUNTERED (red) — what beats this unit.
  if (countered.length > 0) {
    panel.appendChild(matchupGroupHead('Countered', 'countered', countered.length));
    panel.appendChild(matchupGrid(countered, 'countered'));
  }

  // SYNERGIES (gold) — what this unit pairs with.
  if (synergies.length > 0) {
    panel.appendChild(matchupGroupHead('Synergies', 'synergy', synergies.length));
    panel.appendChild(matchupGrid(synergies, 'synergy'));
  }
  return panel;
}

// ---- Battle role (Positioning / Formation cards + Tips list) -----------------------------------

/** The three battle-role fields, in template order, each with its display label + header icon. */
const BATTLE_ROLE_FIELDS = [
  ['positioning', 'Positioning', 'crosshair'],
  ['formation', 'Formation', 'grid'],
  ['tips', 'Tips & tricks', 'bulb'],
];

/** A battle-role card head: gold icon chip + uppercase label. */
function roleCardHead(label, iconName) {
  const head = el('div', 'cs-role-head');
  const chip = el('span', 'cs-role-chip');
  chip.appendChild(icon(iconName));
  head.appendChild(chip);
  head.appendChild(el('span', 'cs-role-label', label));
  return head;
}

/** A prose battle-role card (Positioning / Formation): head + one paragraph with inline marks. */
function roleProseCard(field, label, iconName) {
  const card = el('div', 'cs-role-card');
  card.appendChild(roleCardHead(label, iconName));
  const p = el('p', 'cs-role-body');
  appendProseWithMarks(p, field);
  card.appendChild(p);
  return card;
}

/** The Tips card: head + a diamond-bulleted list, one bullet per attributed excerpt (splitIntoBullets
 * cuts the tips prose at footnote-mark boundaries). */
function roleTipsCard(field, label, iconName) {
  const card = el('div', 'cs-role-card is-tips');
  card.appendChild(roleCardHead(label, iconName));
  const list = el('div', 'cs-tips');
  for (const bullet of splitIntoBullets(field)) {
    const row = el('div', 'cs-tip');
    row.appendChild(el('span', 'cs-tip-dot'));
    const text = el('span', 'cs-tip-text');
    appendProseWithMarks(text, bullet);
    row.appendChild(text);
    list.appendChild(row);
  }
  card.appendChild(list);
  return card;
}

function renderBattleRole(page) {
  const section = el('section', 'cs-panel cs-panel-role');
  section.appendChild(panelHead('Battle role', []));

  const role = page.battleRole || {};
  // A field renders only when it carries real content — a null field or an honest "no source"
  // sentence (e.g. Modao's "No formation guidance in sources.") is omitted here; the absence is
  // still surfaced honestly in the gaps footer, so it is never silently swallowed.
  const present = BATTLE_ROLE_FIELDS.filter(([key]) => !isNoSourceText(role[key]));
  if (present.length === 0) {
    section.appendChild(absentNote('No battle-role guidance has been captured for this unit yet.'));
    return section;
  }

  const leftCards = present.filter(([key]) => key !== 'tips');
  const tips = present.find(([key]) => key === 'tips');

  const grid = el('div', tips && leftCards.length > 0 ? 'cs-role-grid' : 'cs-role-grid is-single');
  if (leftCards.length > 0) {
    const left = el('div', 'cs-role-col');
    for (const [key, label, iconName] of leftCards) left.appendChild(roleProseCard(role[key], label, iconName));
    grid.appendChild(left);
  }
  if (tips) grid.appendChild(roleTipsCard(role.tips, tips[1], tips[2]));
  section.appendChild(grid);
  return section;
}

// ---- Learn More band (class-contract #5, mirrors hero-page-v3.boot.mjs's renderLearnMore) ------

/** One `.cs-learn-video` card: a link (new tab) when the video has a URL, plain text otherwise,
 * plus its `.cs-learn-stamps` timestamp list when present. */
function learnVideoCard(video) {
  const card = el('div', 'cs-learn-video');
  if (isNonEmptyString(video.url)) {
    const a = document.createElement('a');
    a.className = 'cs-learn-video-label';
    a.href = video.url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = video.label || video.url;
    card.appendChild(a);
  } else {
    card.appendChild(el('span', 'cs-learn-video-label', video.label || ''));
  }
  if (Array.isArray(video.stamps) && video.stamps.length > 0) {
    const stamps = el('div', 'cs-learn-stamps');
    for (const stamp of video.stamps) stamps.appendChild(el('div', 'cs-learn-stamp', stamp));
    card.appendChild(stamps);
  }
  return card;
}

/** The `.cs-learn` band: video links + the `#units` ask chip. Returns null when the record has
 * neither (hasLearnMoreContent), so the whole panel is omitted rather than shown empty. */
function renderLearnMore(page) {
  const learnMore = page.learnMore || {};
  if (!hasLearnMoreContent(learnMore)) return null;
  const panel = el('section', 'cs-learn');
  panel.appendChild(panelHead('Learn more', []));

  const videos = Array.isArray(learnMore.videos) ? learnMore.videos : [];
  if (videos.length > 0) {
    const list = el('div', 'cs-learn-videos');
    for (const video of videos) list.appendChild(learnVideoCard(video));
    panel.appendChild(list);
  }

  if (isNonEmptyString(learnMore.askChannel)) {
    const ask = el('div', 'cs-learn-ask');
    ask.appendChild(el('span', 'cs-learn-ask-chip', learnMore.askChannel));
    panel.appendChild(ask);
  }
  return panel;
}

// ---- GENERAL band (class-contract #6 — specific/GENERAL separator, CLAUDE.md hard rule) --------

/** One `.cs-general-block`: title + prose body (with {n} marks) + its own local footnote legend
 * (`.cs-general-foot`) — general-block footnotes are numbered independently per block in
 * site/data/unit-general.json, so they render inline with their own block rather than folding into
 * the page's unrelated footer legend (class-contract #6 leaves this choice to the renderer). */
function generalBlockEl(block) {
  const blockEl = el('div', 'cs-general-block');
  if (block.title) blockEl.appendChild(el('div', 'cs-general-title', block.title));
  const body = el('div', 'cs-general-body');
  appendProseWithMarks(body, block.body);
  blockEl.appendChild(body);
  if (block.footnotes.length > 0) {
    const foot = el('div', 'cs-general-foot');
    for (const fn of block.footnotes) {
      const sup = document.createElement('sup');
      sup.textContent = String(fn.mark);
      foot.appendChild(sup);
      foot.appendChild(document.createTextNode(` ${footnoteLegendTextV2(fn)}`));
      appendLockIfHouse(foot, fn.house);
    }
    blockEl.appendChild(foot);
  }
  return blockEl;
}

/** The labeled separator + `.cs-general` band, LAST content before the footer. `generalFile` is
 * the raw fetched site/data/unit-general.json payload (or null/{} on fetch failure — see boot()'s
 * data-loading note); returns null when the record's `general[]` resolves to zero blocks, so a
 * unit with no general[] keys (or a failed fetch) shows no separator at all. */
function renderGeneralBand(page, generalFile) {
  const blocks = buildGeneralBlocks(page, generalFile);
  if (blocks.length === 0) return null;

  const fragment = document.createDocumentFragment();
  const sep = el('div', 'cs-general-sep');
  sep.appendChild(el('span', null, 'GENERAL · APPLIES TO MOST UNITS'));
  fragment.appendChild(sep);

  const band = el('div', 'cs-general');
  for (const block of blocks) band.appendChild(generalBlockEl(block));
  fragment.appendChild(band);
  return fragment;
}

// ---- Footer (footnote legend + honest gaps) ----------------------------------------------------

function renderFooter(page) {
  const footnotes = Array.isArray(page.footnotes) ? page.footnotes : [];
  const gaps = Array.isArray(page.gaps) ? page.gaps : [];
  if (footnotes.length === 0 && gaps.length === 0) return null;

  const foot = el('footer', 'cs-foot');
  foot.setAttribute('aria-label', 'Sources and notes');

  if (footnotes.length > 0) {
    const legend = el('div', 'cs-legend');
    for (const fn of footnotes) {
      const entry = el('span', 'cs-legend-item');
      const sup = document.createElement('sup');
      sup.textContent = String(fn.mark);
      entry.appendChild(sup);
      entry.appendChild(document.createTextNode(` ${footnoteLegendTextV2(fn)}`));
      appendLockIfHouse(entry, fn.house);
      legend.appendChild(entry);
    }
    foot.appendChild(legend);
  }

  if (gaps.length > 0) {
    const gapsEl = el('div', 'cs-gaps');
    for (const gap of gaps) {
      const row = el('div', 'cs-gap');
      row.appendChild(el('span', 'cs-gap-tag', 'gap'));
      row.appendChild(document.createTextNode(` ${gap}`));
      gapsEl.appendChild(row);
    }
    foot.appendChild(gapsEl);
  }
  return foot;
}

// ---- Full v2 page render -----------------------------------------------------------------------

/**
 * Renders the full "Modao Cheat Sheet" v2 page from a resolved cb-unit-page-v2/1 record into a
 * single root element (unit.html's `#unit-v2-page`). Clears the root first, so re-rendering is
 * idempotent.
 * @param {object} page  a cb-unit-page-v2/1 record (not the insufficient short-circuit shape)
 * @param {HTMLElement} root  the single container element to build the whole cheat sheet into
 * @param {Record<string,string>} [doctrineIconMap]  normalized-doctrine-name -> icon-slug map (from
 *   site/data/doctrine-icons.json's nameToSlug); an empty map (the default) simply renders every
 *   doctrine tile as a placeholder.
 * @param {{blocks?: Record<string, object>}} [generalFile]  the raw fetched site/data/
 *   unit-general.json payload (schema cb-unit-general/1); an empty object (the default) simply
 *   means the GENERAL band renders nothing (buildGeneralBlocks degrades gracefully — see its
 *   doc comment).
 */
export function renderUnitPageV2(page, root, doctrineIconMap = {}, generalFile = {}) {
  document.title = `${page.name} — Immortals Academy`;
  root.innerHTML = '';

  root.appendChild(renderEyebrow(page));
  root.appendChild(renderHeader(page));

  const patchStrip = renderPatchStrip(page);
  if (patchStrip) root.appendChild(patchStrip);
  const numbers = renderNumbers(page);
  if (numbers) root.appendChild(numbers);

  // Three-band grid: doctrines | (veterancy + controls) | matchups.
  const band = el('div', 'cs-band');
  band.appendChild(renderDoctrines(page, doctrineIconMap));
  const center = el('div', 'cs-center');
  center.appendChild(renderVeterancy(page));
  center.appendChild(renderControls(page));
  band.appendChild(center);
  band.appendChild(renderMatchups(page));
  root.appendChild(band);

  root.appendChild(renderBattleRole(page));

  const learnMore = renderLearnMore(page);
  if (learnMore) root.appendChild(learnMore);

  // GENERAL band — specific info above, GENERAL below a separator, LAST content before the footer
  // (CLAUDE.md hard rule; class-contract #6).
  const generalBand = renderGeneralBand(page, generalFile);
  if (generalBand) root.appendChild(generalBand);

  const foot = renderFooter(page);
  if (foot) root.appendChild(foot);
}
