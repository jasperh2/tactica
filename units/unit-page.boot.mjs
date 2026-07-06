// units/unit-page.boot.mjs — DOM wiring for the unit detail page (?u=<slug>). Reads the slug from
// the URL, fetches both profiles (house preferred, public fallback — see unit-page.mjs's
// selectProfile doc comment for why that's safe), and renders every region from
// design/handoff-academy-pages/design_handoff_immortals_academy/templates/Unit Page.dc.html
// against the flat cb-academy-unit-page/v1 shape (tools/build-unit-pages/README.md).
//
// This module emits the handoff's exact class-name grammar (`.unit-header`, `.stat-chip`,
// `.doctrine-row`, `.vet-option`, `.matchup-card`, `.key-sequence`, etc. — see the handoff
// README's "Template -> data-field map") so unit-page.css can style it pixel-for-pixel from the
// design reference. All content still comes from the same page JSON walked by the pre-port
// version of this file; only the DOM shape and CSS classes changed. Every non-trivial branch
// (profile fallback, relation labels, key-chip parsing, footnote resolution) stays unit-tested in
// unit-page.mjs without a DOM; this file is the thinner rendering layer on top.

import { fetchJson } from '../shared/data.mjs';
import {
  selectProfile,
  isIdentityOnly,
  matchupRelationLabel,
  matchupUnitName,
  doctrineTagLabel,
  cssSafeSuffix,
  lastUpdatedSummary,
  keySequenceChips,
  groupControlsSteps,
  veterancyShape,
  footnoteMarksOf,
  findFootnote,
  footnoteLegendText,
} from './unit-page.mjs';

// NOTE ON ESCAPING: every text value below is assigned via `.textContent =` or
// `document.createTextNode(...)`, both of which insert their argument as literal text — the DOM
// never re-parses it as markup, so there is no injection surface and no need for an HTML-escaping
// helper here. (nav.mjs's escapeHtml exists for the same textContent-only usage and is likewise a
// no-op in practice; it is NOT imported here because pre-escaping a string that only ever reaches
// `.textContent` would corrupt real content — e.g. "Ares' Flurry" or "Queen's Knights" would
// visibly render as "Ares&#39; Flurry" — for zero safety benefit. Only reach for real HTML
// escaping if a future change ever assigns one of these values via `.innerHTML`.)

/** site/units/ -> site/, matching the PATH RESOLUTION convention every shared/site module uses
 * (import.meta.url-relative, never root-relative — see nav.mjs's file header for the full
 * rationale: this keeps every path correct under a subpath deploy). */
const SITE_ROOT_URL = new URL('../', import.meta.url);

/** House-profile JSON path for a slug. NEVER reachable on public hosting by design (the
 * architecture spec's deploy script excludes this tree) — a public visitor's fetch here simply
 * 404s, which selectProfile treats as "fall back to public", not an error state. */
function houseProfilePath(slug) {
  return new URL(`data/unit-pages/house/${encodeURIComponent(slug)}.json`, SITE_ROOT_URL).href;
}

/** Public-profile JSON path for a slug. */
function publicProfilePath(slug) {
  return new URL(`data/unit-pages/public/${encodeURIComponent(slug)}.json`, SITE_ROOT_URL).href;
}

/** Reads `?u=<slug>` from the current page URL. Returns null if absent/empty. */
export function slugFromLocation(locationHref) {
  const url = new URL(locationHref);
  const raw = url.searchParams.get('u');
  return raw && raw.trim().length > 0 ? raw.trim() : null;
}

/** Builds a superscript footnote marker (¹ ² ³ ...). Body text carries superscripts only, per the
 * handoff's footnote-only-attribution rule — no inline author name-tags. */
function footnoteSup(mark) {
  const sup = document.createElement('sup');
  sup.className = 'footnote-marker';
  sup.textContent = String(mark);
  return sup;
}

/** Appends one or more footnote superscripts (from footnoteMarksOf's array) to `parent`. */
function appendFootnoteSups(parent, panel) {
  for (const mark of footnoteMarksOf(panel)) parent.appendChild(footnoteSup(mark));
}

/** Builds a house lock glyph span (🔒), matching the handoff's `.lock` class. Used on any
 * house-classified row/note/matchup per the "lock glyph on house-only content" hard content rule. */
function lockGlyph() {
  const lock = document.createElement('span');
  lock.className = 'lock';
  lock.setAttribute('aria-label', 'house source');
  lock.textContent = '🔒';
  return lock;
}

/** Appends a lock glyph to `parent` only when `isHouse` is true — keeps call sites terse. */
function appendLockIfHouse(parent, isHouse) {
  if (isHouse) parent.appendChild(lockGlyph());
}

// ---- Header (icon, identity, stat chips, last-updated) + verdict --------------

/** Builds the tier chip's combined value, e.g. "AA·T5" (meta letter + rarity on one chip,
 * text-first per the handoff's `.stat-chip-tier` field map). Falls back to whichever half is
 * present when the other is null, and to null (render nothing) when both are absent. */
function tierChipValue(header) {
  const parts = [header.metaTier, header.rarityTier].filter((part) => part !== null && part !== undefined && part !== '');
  return parts.length > 0 ? parts.join('·') : null;
}

/** One `.stat-chip` element: value line + uppercase label line. `extraClass` adds a modifier
 * (e.g. `stat-chip-tier`) matching the handoff's chip variants. */
function statChip(value, label, extraClass) {
  const chip = document.createElement('div');
  chip.className = extraClass ? `stat-chip ${extraClass}` : 'stat-chip';
  const valueEl = document.createElement('div');
  valueEl.className = 'stat-chip-value';
  valueEl.textContent = value;
  const labelEl = document.createElement('div');
  labelEl.className = 'stat-chip-label';
  labelEl.textContent = label;
  chip.append(valueEl, labelEl);
  return chip;
}

/** Renders the identity-only header shape (header + tier + one honest absence line — no build,
 * veterancy, matchups, or controls exist for this unit). Matches the handoff's
 * `.unit-header-identity-only` block. */
function renderIdentityOnlyHeader(page, hostEl) {
  const { header } = page;
  hostEl.innerHTML = '';

  const row = document.createElement('div');
  row.className = 'unit-header-row';

  const iconEl = document.createElement('div');
  iconEl.className = 'unit-icon';
  if (header.icon) {
    const img = document.createElement('img');
    img.src = new URL(String(header.icon), SITE_ROOT_URL).href;
    img.alt = '';
    img.width = 52;
    img.height = 52;
    iconEl.appendChild(img);
  } else {
    iconEl.classList.add('unit-icon-placeholder');
    iconEl.setAttribute('aria-hidden', 'true');
  }
  row.appendChild(iconEl);

  const identity = document.createElement('div');
  identity.className = 'unit-identity';
  const nameEl = document.createElement('div');
  nameEl.className = 'unit-name';
  nameEl.textContent = page.name;
  identity.appendChild(nameEl);
  const metaLine = document.createElement('div');
  metaLine.className = 'unit-meta';
  metaLine.textContent = metaLineText(header);
  identity.appendChild(metaLine);
  row.appendChild(identity);

  const tierValue = tierChipValue(header);
  if (tierValue) row.appendChild(statChip(tierValue, 'tier', 'stat-chip-tier'));

  hostEl.appendChild(row);

  // The identity-only "one honest role line" (e.g. Martellatori: "Mobile shielded melee, trades
  // some defense for speed") lives at panels.battleRole.role in the compiled schema, NOT on the
  // header object — confirmed against site/data/unit-pages/public/martellatori.json, the real
  // identity-only sample. battleRole is always non-null for identity-only pages (it's the one
  // guide-shaped field GUIDE_PANEL_KEYS in unit-page.mjs's isIdentityOnly deliberately excludes),
  // but this still guards defensively rather than assuming.
  const role = page.panels && page.panels.battleRole ? page.panels.battleRole.role : null;
  if (role) {
    const roleLine = document.createElement('div');
    roleLine.className = 'unit-role-line';
    roleLine.textContent = role;
    hostEl.appendChild(roleLine);
  }
}

/** Composes the `.unit-meta` line: era · class · type-class · leadership · origin, with the
 * no-mastery flag appended as a quiet inline note. Mirrors the handoff's segment order and
 * separator (" · "). `origin` renders verbatim, never re-derived (hard content rule: numbers/
 * quotes/strings render as stored) — only Sunward Phalanx has a non-null value today, and its
 * text already ends in its own "... No mastery." sentence, so the noMastery flag is skipped
 * when the origin text already mentions it, to avoid rendering "no mastery" twice. */
function metaLineText(header) {
  const parts = [header.era, header.class, header.typeClass, header.leadership ? `${header.leadership} leadership` : null];
  if (header.origin) parts.push(header.origin);
  let text = parts.filter((part) => part !== null && part !== undefined && part !== '').join(' · ');
  const originAlreadyMentionsNoMastery = typeof header.origin === 'string' && /no mastery/i.test(header.origin);
  if (header.noMastery && !originAlreadyMentionsNoMastery) text += ' · no mastery';
  return text;
}

/** Renders the full-guide header (U1: icon, name, meta line, stat chips) into `hostEl`. Does not
 * render last-updated or verdict — those are appended separately by renderHeaderAndVerdict so
 * their DOM order matches the handoff's header -> last-updated -> verdict stack. */
function renderFullHeader(page, hostEl) {
  const { header } = page;
  hostEl.innerHTML = '';

  const row = document.createElement('div');
  row.className = 'unit-header-row';

  const iconEl = document.createElement('div');
  iconEl.className = 'unit-icon';
  if (header.icon) {
    const img = document.createElement('img');
    img.src = new URL(String(header.icon), SITE_ROOT_URL).href;
    img.alt = '';
    img.width = 52;
    img.height = 52;
    iconEl.appendChild(img);
  } else {
    iconEl.classList.add('unit-icon-placeholder');
    iconEl.setAttribute('aria-hidden', 'true');
  }
  row.appendChild(iconEl);

  const identity = document.createElement('div');
  identity.className = 'unit-identity';
  const nameEl = document.createElement('div');
  nameEl.className = 'unit-name';
  nameEl.textContent = page.name;
  identity.appendChild(nameEl);
  const metaLine = document.createElement('div');
  metaLine.className = 'unit-meta';
  metaLine.textContent = metaLineText(header);
  identity.appendChild(metaLine);
  row.appendChild(identity);

  const chipRow = document.createElement('div');
  chipRow.className = 'stat-chips';
  const tierValue = tierChipValue(header);
  if (tierValue) chipRow.appendChild(statChip(tierValue, 'tier', 'stat-chip-tier'));
  if (header.fightRatings) {
    for (const [label, ratingKey] of [['blob', 'Blob'], ['duelling', 'Duelling'], ['skirmish', 'Skirmish'], ['flank', 'Flank']]) {
      const rating = header.fightRatings[ratingKey];
      if (!rating) continue;
      const chip = statChip(rating.raw, label);
      // Handoff's Sunward Phalanx sample renders a 1/10 flank rating in danger-red (REVIEW_PASSES
      // .md: "rating chips (color reinforces an already-legible number)") — a low-rating signal,
      // not a fixed "flank chip is always red" rule. No documented numeric cutoff exists in the
      // field map, so this uses the same "1" the one real sample shows as the floor, via the
      // schema's own numeric `.value` (never string-parsing `.raw`).
      if (typeof rating.value === 'number' && rating.value <= 1) chip.classList.add('stat-chip-rating-low');
      chipRow.appendChild(chip);
    }
  }
  row.appendChild(chipRow);

  hostEl.appendChild(row);
}

/** Renders the neutral `.last-updated` line (U1a) — three states, identical neutral styling in
 * all three per the handoff's `patchStatus` prop: no-change-signal / changed-by-patch /
 * new-this-season. Never alarm-styled regardless of state. */
function renderLastUpdated(page, hostEl) {
  const { lastUpdated } = page;
  const el = document.createElement('div');
  el.className = 'last-updated';
  const summary = lastUpdatedSummary(lastUpdated);
  el.textContent = summary || 'No last-updated data captured for this unit.';
  hostEl.appendChild(el);
}

/** Renders the U2 verdict block — the page's one editorial moment. Three states: authored (prose
 * only), draft (prose + blue `.badge-draft` pill + note), absent (quiet one-liner). Matches the
 * handoff's `.verdict` / `.badge-draft` classes exactly. */
function renderVerdict(page, hostEl) {
  const { verdict } = page;
  if (verdict.state === 'absent') {
    const el = document.createElement('div');
    el.className = 'verdict verdict-absent';
    el.textContent = 'Verdict — not yet written.';
    hostEl.appendChild(el);
    return;
  }
  const el = document.createElement('div');
  el.className = 'verdict';
  const textEl = document.createElement('span');
  textEl.className = 'verdict-text';
  textEl.textContent = verdict.text || '';
  el.appendChild(textEl);
  if (verdict.state === 'draft') {
    const badge = document.createElement('span');
    badge.className = 'badge-draft';
    badge.textContent = 'draft';
    const badgeNote = document.createElement('span');
    badgeNote.className = 'badge-draft-note';
    badgeNote.textContent = 'Claude-drafted · awaiting sign-off';
    el.append(badge, badgeNote);
  }
  hostEl.appendChild(el);
}

/** Renders header + last-updated + verdict together, in the handoff's stacked order, into one
 * `<header class="unit-header">` host. */
function renderHeaderAndVerdict(page, hostEl) {
  renderFullHeader(page, hostEl);
  renderLastUpdated(page, hostEl);
  renderVerdict(page, hostEl);
}

// ---- Panel title (shared accent-bar + footnote sups + deep-link anchor) -------

/** Builds one panel title row: accent bar + uppercase label + footnote sups + optional trailing
 * note + a `#anchor` deep-link marker on the right, matching every `.panel-title` in the handoff. */
function panelTitle(text, { panel, anchor, note } = {}) {
  const title = document.createElement('div');
  title.className = 'panel-title';
  const accent = document.createElement('div');
  accent.className = 'panel-accent';
  const label = document.createElement('span');
  label.className = 'panel-label';
  label.textContent = text;
  title.append(accent, label);
  if (panel) appendFootnoteSups(title, panel);
  if (note) {
    const noteEl = document.createElement('span');
    noteEl.className = 'panel-subtitle';
    noteEl.textContent = note;
    title.appendChild(noteEl);
  }
  const spacer = document.createElement('span');
  spacer.className = 'panel-title-spacer';
  title.appendChild(spacer);
  if (anchor) {
    const anchorEl = document.createElement('span');
    anchorEl.className = 'panel-anchor';
    anchorEl.textContent = `#${anchor}`;
    title.appendChild(anchorEl);
  }
  return title;
}

function absentNote(text) {
  const p = document.createElement('p');
  p.className = 'empty-state';
  p.textContent = text;
  return p;
}

/** Best-effort honest gap note for a panel key, drawn from the page's own gaps[] entries when one
 * mentions the section — falls back to the caller's generic message when none is found. Never
 * invents content; only surfaces what the compiler already wrote. */
function gapNoteFor(page, keyword) {
  if (!Array.isArray(page.gaps)) return null;
  const match = page.gaps.find((g) => g.note.toLowerCase().includes(keyword));
  return match ? match.note : null;
}

// ---- U3: Doctrines -------------------------------------------------------------

function renderDoctrines(page, hostEl) {
  const panel = page.panels.doctrines;
  hostEl.innerHTML = '';
  hostEl.appendChild(panelTitle('Doctrines', { panel, anchor: 'build' }));

  if (!panel) {
    hostEl.appendChild(absentNote(gapNoteFor(page, 'doctrine') || 'No doctrine guide has been captured for this unit yet.'));
    return;
  }

  const list = document.createElement('div');
  list.className = 'doctrine-list';
  for (const entry of panel.entries) {
    const row = document.createElement('div');
    row.className = 'doctrine-row';
    if (entry.tag) {
      const tag = document.createElement('span');
      tag.className = `tag-badge tag-${cssSafeSuffix(entry.tag)}`;
      tag.textContent = doctrineTagLabel(entry.tag);
      row.appendChild(tag);
    }
    if (entry.name) {
      const nameEl = document.createElement('span');
      nameEl.className = 'doctrine-name';
      nameEl.textContent = entry.name;
      row.appendChild(nameEl);
    }
    if (entry.text) {
      const noteEl = document.createElement('span');
      noteEl.className = 'doctrine-note';
      noteEl.textContent = entry.text;
      row.appendChild(noteEl);
    }
    list.appendChild(row);
  }
  hostEl.appendChild(list);

  if (panel.note) {
    const buildEl = document.createElement('div');
    buildEl.className = 'example-build';
    const label = document.createElement('span');
    label.className = 'example-build-label';
    label.textContent = 'Example build';
    appendFootnoteSups(label, panel);
    buildEl.appendChild(label);
    buildEl.appendChild(document.createTextNode(panel.note));
    hostEl.appendChild(buildEl);
  }

  // Both alternativeBuilds and disagreements render into ONE shared `.differ-notes` container
  // (U3a) — created lazily so a doctrines panel with neither array renders no empty shell.
  const hasAlternativeBuilds = Array.isArray(panel.alternativeBuilds) && panel.alternativeBuilds.length > 0;
  const hasDisagreements = Array.isArray(panel.disagreements) && panel.disagreements.length > 0;
  let differNotesEl = null;
  if (hasAlternativeBuilds || hasDisagreements) {
    differNotesEl = document.createElement('div');
    differNotesEl.className = 'differ-notes';
    hostEl.appendChild(differNotesEl);
  }

  // Alternative build lists from other sources — same row grammar, own footnote mark. Real shape:
  // [{ author, doctrines: [{order, name, text}], note }] (site/data/unit-pages/*/sunward-phalanx.json
  // is the only unit with more than one build source today).
  if (hasAlternativeBuilds) {
    for (const build of panel.alternativeBuilds) {
      const buildEl = document.createElement('div');
      buildEl.className = 'differ-note';
      const topic = document.createElement('span');
      topic.className = 'differ-topic';
      topic.textContent = `${build.author}'s alternative build`;
      buildEl.appendChild(topic);
      buildEl.appendChild(document.createTextNode(' '));
      const list2 = document.createElement('ul');
      list2.className = 'alternative-build-list';
      for (const doctrine of build.doctrines) {
        const item = document.createElement('li');
        item.textContent = `${doctrine.name}${doctrine.text ? ` — ${doctrine.text}` : ''}`;
        list2.appendChild(item);
      }
      buildEl.appendChild(list2);
      if (build.note) buildEl.appendChild(document.createTextNode(build.note));
      differNotesEl.appendChild(buildEl);
    }
  }

  // Disagreements — grouped differ notes (U3a), quiet, lock glyph when any position is house.
  if (hasDisagreements) {
    for (const d of panel.disagreements) {
      const noteEl = document.createElement('div');
      noteEl.className = 'differ-note';
      if (d.positions.some((p) => p.house)) noteEl.classList.add('differ-note-house');
      const topic = document.createElement('span');
      topic.className = 'differ-topic';
      topic.textContent = d.topic.replace(/-/g, ' ');
      noteEl.appendChild(topic);
      noteEl.appendChild(document.createTextNode(' '));
      appendLockIfHouse(noteEl, d.positions.some((p) => p.house));
      noteEl.appendChild(document.createTextNode(
        d.positions.map((p) => `${p.author}: ${p.stance}`).join(' ')
      ));
      differNotesEl.appendChild(noteEl);
    }
  }
}

// ---- U4: Veterancy + Formation --------------------------------------------------

function renderVeterancy(page, hostEl) {
  const panel = page.panels.veterancy;
  hostEl.innerHTML = '';
  hostEl.appendChild(panelTitle('Veterancy', { panel, anchor: 'veterancy' }));

  if (!panel) {
    hostEl.appendChild(absentNote('No veterancy recommendation has been captured for this unit yet.'));
    return;
  }

  const shape = veterancyShape(panel);
  const optionsEl = document.createElement('div');
  optionsEl.className = 'vet-options';

  if (shape === 'recommendations') {
    // Max one `.vet-option-recommended` (gold accent) — the first recommendation with a
    // corroborating source is the recommended pick; others render as plain/alternative cards.
    panel.recommendations.forEach((rec, index) => {
      const card = document.createElement('div');
      const isRecommended = index === 0 && Array.isArray(rec.corroborates) && rec.corroborates.length > 0;
      card.className = isRecommended ? 'vet-option vet-option-recommended' : 'vet-option';
      const head = document.createElement('div');
      head.className = 'vet-option-head';
      const nameEl = document.createElement('span');
      nameEl.className = 'vet-option-name';
      nameEl.textContent = rec.recommendation;
      head.appendChild(nameEl);
      if (isRecommended) {
        const badge = document.createElement('span');
        badge.className = 'badge-recommended';
        badge.textContent = `recommended · ${rec.corroborates.length + 1} sources agree`;
        head.appendChild(badge);
      } else {
        const badge = document.createElement('span');
        badge.className = 'badge-alternative';
        badge.textContent = 'viable alternative';
        head.appendChild(badge);
      }
      card.appendChild(head);
      if (rec.rationale) {
        const whyEl = document.createElement('div');
        whyEl.className = 'vet-option-why';
        whyEl.textContent = rec.rationale;
        card.appendChild(whyEl);
      }
      optionsEl.appendChild(card);
    });
  } else if (shape === 'steps') {
    for (const step of panel.steps) {
      const card = document.createElement('div');
      card.className = 'vet-option';
      const head = document.createElement('div');
      head.className = 'vet-option-head';
      const nameEl = document.createElement('span');
      nameEl.className = 'vet-option-name';
      nameEl.textContent = `${step.line} line — ${step.node}`;
      head.appendChild(nameEl);
      card.appendChild(head);
      optionsEl.appendChild(card);
    }
  }
  hostEl.appendChild(optionsEl);
}

function renderFormation(page, hostEl) {
  const panel = page.panels.formation;
  hostEl.innerHTML = '';
  hostEl.appendChild(panelTitle('Formation', { anchor: 'formation' }));
  if (!panel) {
    hostEl.appendChild(absentNote('No formation guidance has been captured for this unit yet.'));
    return;
  }
  const noteEl = document.createElement('div');
  noteEl.className = 'formation-note';
  noteEl.textContent = panel.text;
  if (panel.footnoteMark) noteEl.appendChild(footnoteSup(panel.footnoteMark));
  hostEl.appendChild(noteEl);
}

// ---- U5: Battle role ------------------------------------------------------------

function renderBattleRole(page, hostEl) {
  const panel = page.panels.battleRole;
  hostEl.innerHTML = '';
  hostEl.appendChild(panelTitle('Battle role', { panel, anchor: 'role' }));

  if (!panel) {
    hostEl.appendChild(absentNote('No battle-role guidance has been captured for this unit yet.'));
    return;
  }

  // The compiled schema carries one role/rationale pair, not the three named columns
  // (deployment/positioning/threatModel) the design mockup shows for its Sunward-Phalanx sample —
  // no per-column field exists in this compiler's output today (see unit-page.mjs header comment
  // on this same gap for matchups/relation labels: render what the data has, never invent a
  // three-way split the source doesn't provide). Role text takes the single column; rationale (if
  // present) takes a second. This keeps the handoff's `.role-columns` grid shape and per-column
  // card styling without fabricating deployment/positioning/threat-model content.
  const columns = document.createElement('div');
  columns.className = 'role-columns';

  const roleCol = document.createElement('div');
  roleCol.className = 'role-col';
  const roleBody = document.createElement('div');
  roleBody.className = 'role-col-body';
  roleBody.textContent = panel.role || '';
  roleCol.appendChild(roleBody);
  columns.appendChild(roleCol);

  if (panel.rationale) {
    const rationaleCol = document.createElement('div');
    rationaleCol.className = 'role-col';
    const rationaleBody = document.createElement('div');
    rationaleBody.className = 'role-col-body';
    rationaleBody.textContent = panel.rationale;
    rationaleCol.appendChild(rationaleBody);
    columns.appendChild(rationaleCol);
  }
  hostEl.appendChild(columns);

  // battleRole.knownGaps[] — real shape { note, reason, house? } observed in compiled output.
  // Honest, lockable, rendered small/quiet, never alarming.
  if (Array.isArray(panel.knownGaps) && panel.knownGaps.length > 0) {
    const gapsEl = document.createElement('div');
    gapsEl.className = 'known-gaps';
    for (const gap of panel.knownGaps) {
      const line = document.createElement('div');
      line.textContent = 'Known gap ';
      appendLockIfHouse(line, gap.house === true);
      line.appendChild(document.createTextNode(` — ${gap.note}`));
      gapsEl.appendChild(line);
    }
    hostEl.appendChild(gapsEl);
  }
}

// ---- U6: Matchups -----------------------------------------------------------------

function renderMatchups(page, hostEl) {
  const panel = page.panels.matchups;
  hostEl.innerHTML = '';
  hostEl.appendChild(panelTitle('Matchups', {
    panel,
    anchor: 'matchups',
    note: 'no match data exists — the why-line is the read',
  }));

  if (!panel || !Array.isArray(panel.entries) || panel.entries.length === 0) {
    hostEl.appendChild(absentNote('No matchup data has been mined for this unit yet.'));
    return;
  }

  const grid = document.createElement('div');
  grid.className = 'matchup-grid';
  for (const entry of panel.entries) {
    const card = document.createElement('div');
    card.className = `matchup-card matchup-relation-${cssSafeSuffix(entry.relation)}`;
    // NOTE: the handoff shows a `.matchup-card-house` variant (e.g. Sunward Phalanx's gated
    // "Modao" card) with a lock glyph. The compiled schema has no per-entry `house` flag today
    // (confirmed: no matchups.entries[] item in any compiled page carries one — housing is
    // decided at the profile-selection level instead, same as techniques below) — this check is
    // defensive/forward-compatible, not currently reachable, and never invents a house
    // classification the data doesn't assert.
    if (entry.house === true) card.classList.add('matchup-card-house');

    // `entry.unit` is observed in two real shapes: null (no named unit resolved — the common
    // case) or an object { displayName, ref, resolution } (a named-but-unresolved reference, e.g.
    // Sunward Phalanx's "Modao" matchup card) — see matchupUnitName's doc comment. Unresolved
    // names render as PLAIN TEXT, never a dead link, and never the house lock glyph (that glyph
    // means "house-only content" elsewhere on this page — "no page exists yet" is unrelated).
    const unitName = matchupUnitName(entry.unit);
    if (unitName) {
      const nameEl = document.createElement('div');
      nameEl.className = 'matchup-name';
      nameEl.textContent = unitName;
      if (entry.house === true) appendLockIfHouse(nameEl, true);
      card.appendChild(nameEl);
    }

    const relationEl = document.createElement('span');
    relationEl.className = `relation-label relation-${cssSafeSuffix(entry.relation)}`;
    relationEl.textContent = matchupRelationLabel(entry.relation);
    card.appendChild(relationEl);

    const whyEl = document.createElement('div');
    whyEl.className = 'matchup-why';
    whyEl.textContent = entry.text || '';
    card.appendChild(whyEl);
    grid.appendChild(card);
  }
  hostEl.appendChild(grid);

  // pressureLine / generalLine — real shape observed: plain strings on the panel, not derived
  // per-entry (the "you pressure" grouping in the design mockup is authored prose, not something
  // this compiler currently emits structurally — see matchups.pressureLine / generalLine field map
  // in the handoff README). Render verbatim when present; never synthesize one from the entries.
  if (panel.pressureLine) {
    const pressureEl = document.createElement('div');
    pressureEl.className = 'pressure-line';
    pressureEl.textContent = panel.pressureLine;
    hostEl.appendChild(pressureEl);
  }
  if (panel.generalLine) {
    const generalEl = document.createElement('div');
    generalEl.className = 'general-line';
    generalEl.textContent = panel.generalLine;
    hostEl.appendChild(generalEl);
  }
}

// ---- U7: Controls -----------------------------------------------------------------

function renderControls(page, hostEl) {
  const panel = page.panels.controls;
  hostEl.innerHTML = '';
  hostEl.appendChild(panelTitle('Controls', { panel, anchor: 'controls' }));

  if (!panel) {
    hostEl.appendChild(absentNote('No control/how-to-use guide has been captured for this unit yet.'));
    return;
  }

  // Every steps-shaped block gets its own key-sequence strip, not just the first — a unit can
  // carry more than one control loop (e.g. Sunward Phalanx's main engage loop PLUS a distinct
  // "vs AoE-heavy comps" variant); rendering only sequenceBlocks[0] would silently drop the rest.
  const { sequenceBlocks, proseBlocks } = groupControlsSteps(panel.steps);
  for (const block of sequenceBlocks) {
    const chips = keySequenceChips(block);
    const strip = document.createElement('div');
    strip.className = 'key-sequence';
    const label = document.createElement('span');
    label.className = 'key-sequence-label';
    label.textContent = block.context;
    strip.appendChild(label);
    if (chips.length > 0) {
      chips.forEach((chip, index) => {
        const chipEl = document.createElement('span');
        chipEl.className = 'key-chip';
        chipEl.textContent = chip;
        strip.appendChild(chipEl);
        if (index < chips.length - 1) {
          const arrow = document.createElement('span');
          arrow.className = 'key-arrow';
          arrow.textContent = '→';
          strip.appendChild(arrow);
        }
      });
    } else {
      // No recognizable key token in any step of this block (e.g. a pure-prose "steps" array like
      // Phalanx's AoE-comp variant) — render the raw step text instead of silently dropping it.
      strip.appendChild(document.createTextNode(block.steps.join(' ')));
    }
    hostEl.appendChild(strip);
  }

  // Text-shaped blocks — real shape { context, text } (the common case: 94 of the compiled 149
  // pages carry ONLY this shape, e.g. site/data/unit-pages/house/iron-reapers.json and claymores
  // .json — confirmed zero mixed-shape files in a full census). This is a DIFFERENT block shape
  // from the steps-shaped ones above, not an edge case of them: groupControlsSteps routes every
  // block without a `.steps` array here specifically so it still renders (regression: this branch
  // did not previously exist at all — proseBlocks was computed by groupControlsSteps and then
  // silently discarded, so every unit whose controls guide used ONLY the flat shape rendered an
  // empty Controls panel with no error). Reuses the same `.key-sequence`/`.key-sequence-label`
  // strip grammar as the steps-shaped blocks above (context label + body), since a flat block is
  // conceptually one prose "step" rather than a distinct visual component.
  for (const block of proseBlocks) {
    const strip = document.createElement('div');
    strip.className = 'key-sequence';
    const label = document.createElement('span');
    label.className = 'key-sequence-label';
    label.textContent = block.context;
    strip.appendChild(label);
    strip.appendChild(document.createTextNode(block.text));
    hostEl.appendChild(strip);
  }

  // controls.quotes[] — real shape { text, context } (e.g. Sunward Phalanx's "Master the double C
  // brace..." playstyle tip, shown trailing the key-sequence strip in the design mockup). Quoted
  // verbatim.
  if (Array.isArray(panel.quotes)) {
    for (const quote of panel.quotes) {
      const quoteEl = document.createElement('div');
      quoteEl.className = 'key-sequence-explainer';
      quoteEl.textContent = `"${quote.text}"`;
      hostEl.appendChild(quoteEl);
    }
  }

  const grid = document.createElement('div');
  grid.className = 'controls-grid';

  const mechanicsCol = document.createElement('div');
  mechanicsCol.className = 'mechanics-list';
  if (Array.isArray(panel.mechanics)) {
    for (const mech of panel.mechanics) {
      const row = document.createElement('div');
      row.className = 'mechanic';
      const nameEl = document.createElement('b');
      nameEl.textContent = mech.name;
      row.append(nameEl, document.createTextNode(` — ${mech.text}`));
      mechanicsCol.appendChild(row);
    }
  }
  grid.appendChild(mechanicsCol);

  const scenariosCol = document.createElement('div');
  scenariosCol.className = 'scenarios-and-techniques';
  if (Array.isArray(panel.scenarios) && panel.scenarios.length > 0) {
    const scenarioList = document.createElement('div');
    scenarioList.className = 'scenario-list';
    const label = document.createElement('b');
    label.textContent = 'Scenarios';
    scenarioList.appendChild(label);
    panel.scenarios.forEach((scenario, index) => {
      scenarioList.appendChild(document.createTextNode(` ${scenario.label} — ${scenario.text} `));
      if (Array.isArray(scenario.timestamps)) {
        for (const ts of scenario.timestamps) {
          const tsEl = document.createElement('span');
          tsEl.className = 'timestamp';
          tsEl.textContent = ts;
          scenarioList.appendChild(tsEl);
          scenarioList.appendChild(document.createTextNode(' '));
        }
      }
      if (index < panel.scenarios.length - 1) scenarioList.appendChild(document.createTextNode('· '));
    });
    scenariosCol.appendChild(scenarioList);
  }

  // Named techniques — real shape observed in the only unit with any (site/data/unit-pages/house/
  // sunward-phalanx.json): { name, steps: string[], conditions?, effect? } — NO `house` field on
  // the technique itself; house-classification is a PANEL-level routing decision in this compiler,
  // not a per-technique tag (a technique only reaches this renderer at all when its unit's chosen
  // house/public profile already includes it — housing is already handled at profile-selection).
  // The `.technique-house` class + lock glyph the handoff shows on a per-row basis would need the
  // compiler to start emitting a per-item `house` signal; `technique.house === true` below is
  // defensive/forward-compatible for that future shape, never reachable against today's data.
  if (Array.isArray(panel.techniques)) {
    for (const technique of panel.techniques) {
      const row = document.createElement('div');
      row.className = technique.house === true ? 'technique technique-house' : 'technique';
      const nameEl = document.createElement('b');
      nameEl.textContent = technique.name;
      row.appendChild(nameEl);
      appendLockIfHouse(row, technique.house === true);
      const detailParts = [];
      if (Array.isArray(technique.steps)) detailParts.push(technique.steps.join(' → '));
      if (technique.conditions) detailParts.push(technique.conditions);
      if (technique.effect) detailParts.push(technique.effect);
      row.appendChild(document.createTextNode(` — ${detailParts.join(' ')}`));
      scenariosCol.appendChild(row);
    }
  }
  grid.appendChild(scenariosCol);

  hostEl.appendChild(grid);
}

// ---- U8: Footer ---------------------------------------------------------------------

function renderFooter(page, hostEl) {
  hostEl.innerHTML = '';

  if (Array.isArray(page.media) && page.media.length > 0) {
    const mediaLine = document.createElement('div');
    mediaLine.className = 'media-line';
    mediaLine.textContent = page.media
      .map((m) => m.caption || (m.channel ? `${m.channel} video` : 'video'))
      .join(' · ');
    hostEl.appendChild(mediaLine);
  }

  if (Array.isArray(page.footnotes) && page.footnotes.length > 0) {
    const legend = document.createElement('div');
    legend.className = 'source-legend';
    page.footnotes.forEach((fn, index) => {
      const sup = document.createElement('sup');
      sup.textContent = String(fn.mark);
      legend.appendChild(sup);
      legend.appendChild(document.createTextNode(` ${footnoteLegendText(fn)}`));
      appendLockIfHouse(legend, fn.house === true);
      if (index < page.footnotes.length - 1) legend.appendChild(document.createTextNode('   '));
    });
    hostEl.appendChild(legend);
  }

  if (Array.isArray(page.gaps) && page.gaps.length > 0) {
    for (const gap of page.gaps) {
      const gapEl = document.createElement('div');
      gapEl.className = 'known-gaps';
      gapEl.textContent = 'Known gap ';
      appendLockIfHouse(gapEl, gap.house === true);
      gapEl.appendChild(document.createTextNode(` — ${gap.note}`));
      hostEl.appendChild(gapEl);
    }
  }
}

// ---- Full page render --------------------------------------------------------------

/**
 * Renders the full page from a resolved cb-academy-unit-page/v1 record into the section hosts
 * declared in units/unit.html (by id). Identity-only units (isIdentityOnly) render the
 * unit-identity-only shape (header + tier + role line + one honest absence note) instead of the
 * full guide grid — no empty panel shells, no "coming soon" filler.
 * @param {object} page
 * @param {Record<string, HTMLElement>} hosts  map of section id -> host element
 */
export function renderUnitPage(page, hosts) {
  document.title = `${page.name} — Immortals Academy`;

  if (isIdentityOnly(page)) {
    if (hosts.identityOnly) hosts.identityOnly.hidden = false;
    if (hosts.fullGuide) hosts.fullGuide.hidden = true;
    if (hosts.headerIdentityOnly) renderIdentityOnlyHeader(page, hosts.headerIdentityOnly);
    if (hosts.identityAbsenceNote) {
      hosts.identityAbsenceNote.textContent =
        gapNoteFor(page, 'identity') ||
        gapNoteFor(page, 'rich-data gate') ||
        'No guide content yet — the tier placement and identity line above are the entire record for this unit.';
    }
    renderFooter(page, hosts.footer);
    return;
  }

  if (hosts.identityOnly) hosts.identityOnly.hidden = true;
  if (hosts.fullGuide) hosts.fullGuide.hidden = false;
  renderHeaderAndVerdict(page, hosts.header);
  renderDoctrines(page, hosts.doctrines);
  renderVeterancy(page, hosts.veterancy);
  renderFormation(page, hosts.formation);
  renderBattleRole(page, hosts.battleRole);
  renderMatchups(page, hosts.matchups);
  renderControls(page, hosts.controls);
  renderFooter(page, hosts.footer);
}

/**
 * Renders the "page not found" state (slug missing from the URL, or neither profile fetch
 * resolved) into `mainEl` — replaces its entire content with one honest message.
 * @param {HTMLElement} mainEl
 * @param {string} message
 */
export function renderNotFound(mainEl, message) {
  mainEl.innerHTML = '';
  const p = document.createElement('p');
  p.className = 'empty-state';
  p.textContent = message;
  mainEl.appendChild(p);
}

/**
 * Full page boot: reads ?u=<slug>, fetches house-then-public, and renders. Matches the section ids
 * declared in units/unit.html.
 */
export async function boot() {
  const mainEl = document.getElementById('unit-main');
  const slug = slugFromLocation(window.location.href);
  if (!slug) {
    renderNotFound(mainEl, 'No unit specified — use ?u=<slug> to view a unit page.');
    return;
  }

  const [houseResult, publicResult] = await Promise.all([
    fetchJson(houseProfilePath(slug)),
    fetchJson(publicProfilePath(slug)),
  ]);
  const page = selectProfile(houseResult, publicResult);

  if (!page) {
    renderNotFound(mainEl, `No page found for "${slug}".`);
    return;
  }

  const hosts = {
    identityOnly: document.getElementById('unit-identity-only'),
    headerIdentityOnly: document.getElementById('unit-header-identity-only'),
    identityAbsenceNote: document.getElementById('unit-identity-absence-note'),
    fullGuide: document.getElementById('unit-full-guide'),
    header: document.getElementById('unit-header'),
    doctrines: document.getElementById('unit-doctrines'),
    veterancy: document.getElementById('unit-veterancy'),
    formation: document.getElementById('unit-formation'),
    battleRole: document.getElementById('unit-battle-role'),
    matchups: document.getElementById('unit-matchups'),
    controls: document.getElementById('unit-controls'),
    footer: document.getElementById('unit-footer'),
  };
  renderUnitPage(page, hosts);
}
