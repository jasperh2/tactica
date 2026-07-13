// heroes/hero-page-v2.boot.mjs — DOM rendering for the hero detail page v2, the nine-block layout
// from design/handoff-hero-page-v2/Hero Page v2 Shortsword.dc.html (Claude Design project "Tzsum:
// Home Point Push", imported 2026-07-13). This renderer drives ALL hero pages: eyebrow → header →
// battle role → positioning | tips & tricks → armor & stats (attribute/sets/spreads · ladder/
// weapon-stats/gender · runes) → controls & combos → build cards → matchups → footer.
//
// The whole tree is built into ONE root element (hero.html's `#hero-v2-page`), same ownership
// model as unit-page-v2.boot.mjs. The v1 tree (#hero-content) stays in the HTML, permanently
// hidden, as the rollback path — swap hero.html's boot import to go back.
//
// Content the parallel hero-content pass hasn't delivered yet renders as honest labeled empty
// states (never invented, never silently omitted — docs/design-handoff/hero-page-v2/05 taxonomy).
// The extension-field contract those states wait on lives in hero-page-v2.mjs's header comment.
//
// ESCAPING: every record-derived value is written via `.textContent` / createTextNode, never
// `.innerHTML` — the only innerHTML use is icon()'s compile-time-constant SVG strings (same
// static-markup carve-out as unit-page-v2.boot.mjs).

import { fetchJson, withCacheBust } from '../shared/data.mjs';
import { slugFromSearch, buildHeroPageV2Model, isGapText, tileInitials } from './hero-page-v2.mjs';

/** site/heroes/ -> site/ (import.meta.url-relative, never root-relative — shared PATH RESOLUTION
 * convention, keeps asset URLs correct under a subpath deploy). */
const SITE_ROOT_URL = new URL('../', import.meta.url);
const HERO_RECORD_DIR_URL = new URL('data/hero-pages/', SITE_ROOT_URL);

// ---- Inline SVG icon set (static constants — see file-header ESCAPING note) ---------------------

const SVG_ICONS = {
  check:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 12.8l5 5L19.5 7"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>',
  trendUp:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 16.5 9.5 10 13.5 14 21 6.5"/><polyline points="14.5 6.5 21 6.5 21 13"/></svg>',
  trendDown:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 7.5 9.5 14 13.5 10 21 17.5"/><polyline points="14.5 17.5 21 17.5 21 11"/></svg>',
  link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 14a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 10a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>',
  video:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="6" width="13" height="12" rx="2"/><path d="M15.5 12l6-3.5v7z"/></svg>',
  star: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.5l2.85 6.1 6.65.62-5 4.45 1.46 6.53L12 16.9l-5.96 3.3 1.46-6.53-5-4.45 6.65-.62z"/></svg>',
};

/** Decorative inline-SVG glyph span; `name` selects a SVG_ICONS constant (never record data). */
function icon(name, className) {
  const span = document.createElement('span');
  span.className = className ? `hv2-ic ${className}` : 'hv2-ic';
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = SVG_ICONS[name] || ''; // static constant only — never record data
  return span;
}

// ---- Small DOM builders --------------------------------------------------------------------------

/** Element with optional class + textContent (text inserted literally, never parsed as markup). */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

/** The design's 6px rotated-square gold diamond bullet. */
function diamond(className) {
  return el('span', className ? `hv2-diamond ${className}` : 'hv2-diamond');
}

/** Panel section-title bar: gold accent tick + tracked label + optional mono meta + #anchor. */
function sectionTitle(label, { meta = null, anchor = null } = {}) {
  const bar = el('div', 'hv2-sec-title');
  bar.appendChild(el('span', 'hv2-sec-accent'));
  bar.appendChild(el('span', 'hv2-sec-label', label));
  if (meta) bar.appendChild(el('span', 'hv2-sec-meta', meta));
  bar.appendChild(el('span', 'hv2-sec-spacer'));
  if (anchor) bar.appendChild(el('span', 'hv2-sec-anchor', anchor));
  return bar;
}

/** 10px tracked mono sub-group label (ATTRIBUTE POINTS, ARMOR SETS, ...). */
function microLabel(text) {
  return el('div', 'hv2-micro-label', text);
}

/** Hairline divider between sub-groups. */
function divider() {
  return el('div', 'hv2-divider');
}

/** Mono gold author sign-off: "- SanY" (copy-voice rule: hyphen, never an em-dash). */
function authorSuffix(name) {
  return el('span', 'hv2-author', ` - ${name}`);
}

/** Appends prose + optional author sign-off to a parent. */
function appendAttributed(parent, text, attribution) {
  parent.appendChild(document.createTextNode(String(text)));
  if (attribution) {
    parent.appendChild(document.createTextNode(' '));
    parent.appendChild(authorSuffix(attribution));
  }
}

/** Honest labeled empty state — dashed quiet row (the design's own "No clips linked" grammar). */
function emptyRow(text, iconName = null) {
  const row = el('div', 'hv2-empty');
  if (iconName) row.appendChild(icon(iconName));
  row.appendChild(document.createTextNode(text));
  return row;
}

/** Supplied [GAP: ...] honesty line — quiet mono register, visible where it occurs (taxonomy §1). */
function gapLine(text) {
  return el('div', 'hv2-gap', text);
}

/** A paragraph/bullet text node that renders as a GAP line when the supplied text is one. */
function proseOrGap(text, className) {
  if (isGapText(text)) return gapLine(text);
  return el('p', className, text);
}

/** Square placeholder tile with coded initials (the handoff's no-icon grammar). */
function initialsTile(initials, className, accent = false) {
  const tile = el('span', `hv2-tile ${className || ''}${accent ? ' hv2-tile-gold' : ''}`, initials);
  tile.setAttribute('aria-hidden', 'true');
  return tile;
}

/**
 * Header weapon-class icon tile: real art from site/assets/hero-icons/<slug>.png (Jasper's
 * 2026-07-13 imgur set — provenance in that folder's manifest.json), layered over the coded
 * initials so a missing/404ing file degrades to the placeholder grammar instead of breaking.
 */
function heroIconTile(slug, initials) {
  const tile = initialsTile(initials, 'hv2-tile-lg hv2-tile-icon');
  if (!slug) return tile;
  const img = document.createElement('img');
  img.src = new URL(`assets/hero-icons/${encodeURIComponent(slug)}.png`, SITE_ROOT_URL).href;
  img.alt = '';
  img.addEventListener('error', () => img.remove());
  tile.appendChild(img);
  return tile;
}

/** Diamond-bulleted list row with optional bold lead. */
function bulletRow(lead, text) {
  const row = el('div', 'hv2-bullet');
  row.appendChild(diamond());
  const body = el('span', 'hv2-bullet-text');
  if (lead) {
    body.appendChild(el('b', 'hv2-bullet-lead', `${lead} `));
  }
  body.appendChild(document.createTextNode(String(text)));
  row.appendChild(body);
  return row;
}

// ---- Eyebrow -------------------------------------------------------------------------------------

function renderEyebrow() {
  const row = el('div', 'hv2-eyebrow');
  const crest = el('span', 'hv2-crest');
  crest.setAttribute('aria-hidden', 'true');
  const img = document.createElement('img');
  img.src = new URL('assets/immortals-crest.png', SITE_ROOT_URL).href;
  img.alt = '';
  img.addEventListener('error', () => {
    crest.classList.add('is-ph');
    img.remove();
  });
  crest.appendChild(img);
  row.appendChild(crest);
  row.appendChild(el('span', 'hv2-eyebrow-brand', 'IMMORTALS'));
  row.appendChild(el('span', 'hv2-eyebrow-dim', 'HERO GUIDE'));
  row.appendChild(el('span', 'hv2-eyebrow-line'));
  return row;
}

// ---- Block 1 · Header ------------------------------------------------------------------------------

function renderHeader(header) {
  const panel = el('section', 'hv2-panel hv2-header');
  panel.id = 'hero';

  const top = el('div', 'hv2-header-top');
  const identity = el('div', 'hv2-header-identity');
  identity.appendChild(heroIconTile(header.slug, header.iconCode));
  const nameWrap = el('div');
  nameWrap.appendChild(el('h1', 'hv2-name', header.className));
  if (header.weaponArchetype) nameWrap.appendChild(el('p', 'hv2-archetype', header.weaponArchetype));
  identity.appendChild(nameWrap);
  top.appendChild(identity);

  const chips = el('div', 'hv2-chip-row');
  for (const tierChip of header.tierChips) {
    const chip = el('div', 'hv2-chip hv2-chip-gold');
    chip.appendChild(el('span', 'hv2-chip-value', tierChip.value));
    chip.appendChild(el('span', 'hv2-chip-label', tierChip.label.toUpperCase()));
    chips.appendChild(chip);
  }
  if (header.armorClassChip) {
    const chip = el('div', 'hv2-chip');
    chip.appendChild(el('span', 'hv2-chip-value', header.armorClassChip));
    chip.appendChild(el('span', 'hv2-chip-label', 'ARMOR CLASS'));
    chips.appendChild(chip);
  }
  if (header.epicChip) {
    const chip = el('div', 'hv2-chip');
    chip.appendChild(el('span', 'hv2-chip-value', header.epicChip));
    chip.appendChild(el('span', 'hv2-chip-label', 'EPIC SCHEM'));
    chips.appendChild(chip);
  }
  top.appendChild(chips);
  panel.appendChild(top);

  panel.appendChild(divider());

  const lines = el('div', 'hv2-header-lines');
  if (header.tierLine) {
    const line = el('div', 'hv2-header-line');
    line.appendChild(el('span', 'hv2-header-line-dim', 'Tier: '));
    line.appendChild(el('b', 'hv2-header-line-strong', header.tierLine));
    line.appendChild(document.createTextNode(" on Amya's tierlist"));
    if (header.tierlistUpdated) line.appendChild(document.createTextNode(`, updated ${header.tierlistUpdated}`));
    lines.appendChild(line);
  }
  if (header.epicSchemLine) {
    const line = el('div', 'hv2-header-line');
    line.appendChild(el('span', 'hv2-header-line-gold', 'Epic Schematic: '));
    line.appendChild(document.createTextNode(header.epicSchemLine.needed));
    if (header.epicSchemLine.name) {
      line.appendChild(document.createTextNode(' - '));
      line.appendChild(el('b', 'hv2-header-line-strong', header.epicSchemLine.name));
    }
    lines.appendChild(line);
  }
  if (header.tierDropNote) lines.appendChild(el('div', 'hv2-header-line hv2-header-drop-note', header.tierDropNote));
  if (header.freshnessLine) lines.appendChild(el('div', 'hv2-header-freshness', header.freshnessLine));
  panel.appendChild(lines);

  return panel;
}

// ---- Block 2 · Battle role ---------------------------------------------------------------------------

function renderBattleRole(battleRole) {
  const panel = el('section', 'hv2-panel');
  panel.id = 'role';
  panel.appendChild(sectionTitle('BATTLE ROLE', { anchor: '#role' }));

  if (battleRole.roleLabel) {
    const line = el('div', 'hv2-role-line');
    line.appendChild(diamond());
    const text = el('span', 'hv2-role-line-text');
    text.appendChild(el('span', 'hv2-role-line-lead', 'Role: '));
    text.appendChild(document.createTextNode(battleRole.roleLabel));
    line.appendChild(text);
    panel.appendChild(line);
  }

  if (battleRole.paragraphs.length === 0) {
    panel.appendChild(emptyRow('Role prose not written for this class yet.'));
    return panel;
  }

  const quotePanel = el('div', 'hv2-role-quotes');
  for (const para of battleRole.paragraphs) {
    const p = el('p', 'hv2-role-quote');
    appendAttributed(p, para.text, para.attribution);
    quotePanel.appendChild(p);
  }
  panel.appendChild(quotePanel);
  return panel;
}

// ---- Blocks 3 + 4 · Positioning | Tips & tricks ---------------------------------------------------------

function renderBulletBlock(id, label, anchor, defaultIntro, emptyText, model) {
  const panel = el('section', 'hv2-panel');
  panel.id = id;
  panel.appendChild(sectionTitle(label, { anchor }));
  if (model.bullets.length === 0) {
    panel.appendChild(emptyRow(emptyText));
    return panel;
  }
  panel.appendChild(el('p', 'hv2-block-intro', model.intro || defaultIntro));
  const list = el('div', 'hv2-bullets');
  for (const bullet of model.bullets) {
    if (isGapText(bullet.text)) list.appendChild(gapLine(bullet.text));
    else list.appendChild(bulletRow(bullet.lead, bullet.text));
  }
  panel.appendChild(list);
  return panel;
}

function renderPositioningAndTips(positioning, tips) {
  const grid = el('div', 'hv2-cols-2');
  grid.appendChild(
    renderBulletBlock(
      'positioning',
      'POSITIONING',
      '#positioning',
      'Where to be during a fight:',
      'Nothing here yet - positioning notes for this class are still being collected.',
      positioning,
    ),
  );
  grid.appendChild(
    renderBulletBlock(
      'tips',
      'TIPS & TRICKS',
      '#tips',
      "Know-how that isn't about where you stand:",
      'Nothing here yet - tips for this class are still being collected.',
      tips,
    ),
  );
  return grid;
}

// ---- Block 5 · Armor & stats -----------------------------------------------------------------------------

function renderArmorSetsColumn(armorStats) {
  const col = el('div', 'hv2-armor-col');

  col.appendChild(microLabel('ATTRIBUTE POINTS'));
  if (armorStats.attribute) col.appendChild(el('p', 'hv2-prose', armorStats.attribute));
  else col.appendChild(emptyRow('No attribute recommendation captured yet.'));

  col.appendChild(divider());
  col.appendChild(microLabel('ARMOR SETS'));
  if (armorStats.armorSets.length === 0) {
    col.appendChild(emptyRow('No armor sets captured yet.'));
  } else {
    const list = el('div', 'hv2-set-list');
    for (const set of armorStats.armorSets) {
      const row = el('div', 'hv2-set-row');
      row.appendChild(initialsTile(set.initials, 'hv2-tile-sm', set.isEpic));
      const body = el('div');
      const nameRow = el('div', 'hv2-set-name-row');
      nameRow.appendChild(el('span', 'hv2-set-name', set.name));
      if (set.isEpic) nameRow.appendChild(el('span', 'hv2-badge hv2-badge-gold', 'epic schem'));
      body.appendChild(nameRow);
      if (set.desc) body.appendChild(el('div', 'hv2-set-desc', set.desc));
      row.appendChild(body);
      list.appendChild(row);
    }
    col.appendChild(list);
  }

  col.appendChild(divider());
  col.appendChild(microLabel('STAT SPREADS PER BUILD'));
  if (armorStats.statSpreads.length === 0) {
    col.appendChild(emptyRow('No per-build stat spreads captured yet.'));
  } else {
    const list = el('div', 'hv2-spread-list');
    for (const spread of armorStats.statSpreads) {
      const row = el('div', 'hv2-spread-row');
      row.appendChild(el('span', 'hv2-spread-build', spread.build));
      const value = el('span', 'hv2-spread-value');
      value.appendChild(document.createTextNode(String(spread.spread)));
      if (spread.note) value.appendChild(el('span', 'hv2-spread-note', ` ${spread.note}`));
      row.appendChild(value);
      list.appendChild(row);
    }
    col.appendChild(list);
  }

  return col;
}

function renderStatPriorityColumn(armorStats) {
  const col = el('div', 'hv2-armor-col');

  col.appendChild(microLabel('ARMOR STAT PRIORITY'));
  const priority = armorStats.statPriority;
  if (!priority) {
    col.appendChild(emptyRow('Armor stat ladder not captured for this class yet.'));
  } else {
    if (priority.intro) col.appendChild(el('p', 'hv2-block-intro', priority.intro));
    const ladder = el('div', 'hv2-ladder');
    for (const tier of priority.tiers) {
      const grade = String(tier.grade || '').toUpperCase();
      const row = el('div', `hv2-ladder-row hv2-ladder-${grade.toLowerCase() || 'b'}`);
      row.appendChild(el('span', 'hv2-ladder-grade', grade));
      row.appendChild(el('span', 'hv2-ladder-label', tier.label));
      ladder.appendChild(row);
    }
    col.appendChild(ladder);
    if (priority.quote) {
      const quote = el('p', 'hv2-serif-quote');
      appendAttributed(quote, `"${priority.quote.text}"`, priority.quote.attribution);
      col.appendChild(quote);
    }
    if (priority.craftNote) {
      const note = el('p', 'hv2-note hv2-craft-note');
      if (priority.craftNote.lead) note.appendChild(el('b', 'hv2-strong', `${priority.craftNote.lead} - `));
      appendAttributed(note, priority.craftNote.text, priority.craftNote.attribution);
      col.appendChild(note);
    }
  }

  col.appendChild(divider());
  col.appendChild(microLabel('WEAPON STATS'));
  if (armorStats.weaponStatsNeed.length === 0 && armorStats.weaponStatsBonus.length === 0) {
    col.appendChild(emptyRow('No weapon stat priorities captured yet.'));
  } else {
    const rows = el('div', 'hv2-weapon-stats');
    const chipLine = (badge, badgeClass, items, chipClass) => {
      const line = el('div', 'hv2-chipline');
      line.appendChild(el('span', `hv2-badge ${badgeClass}`, badge));
      for (const item of items) line.appendChild(el('span', `hv2-pill ${chipClass}`, item));
      return line;
    };
    if (armorStats.weaponStatsNeed.length > 0)
      rows.appendChild(chipLine('NEED', 'hv2-badge-gold', armorStats.weaponStatsNeed, 'hv2-pill-strong'));
    if (armorStats.weaponStatsBonus.length > 0)
      rows.appendChild(chipLine('BONUS', 'hv2-badge-dim', armorStats.weaponStatsBonus, ''));
    col.appendChild(rows);
  }

  if (armorStats.gender) {
    col.appendChild(divider());
    col.appendChild(microLabel('CHARACTER GENDER'));
    const p = el('p', 'hv2-prose');
    p.appendChild(el('b', 'hv2-strong', armorStats.gender.best));
    if (armorStats.gender.note) p.appendChild(document.createTextNode(` - ${armorStats.gender.note}`));
    col.appendChild(p);
  }

  return col;
}

function renderRunesColumn(armorStats) {
  const panel = el('div', 'hv2-runes-panel');

  const head = el('div', 'hv2-runes-head');
  head.appendChild(el('span', 'hv2-micro-label hv2-micro-inline', 'RUNES'));
  head.appendChild(el('span', 'hv2-sec-spacer'));
  panel.appendChild(head);

  const weaponHead = el('div', 'hv2-runes-row-head');
  weaponHead.appendChild(el('span', 'hv2-runes-title', 'Weapon runes'));
  weaponHead.appendChild(el('span', 'hv2-badge hv2-badge-gold', 'class-specific'));
  panel.appendChild(weaponHead);

  const runes = armorStats.runes;
  const weaponRunes = armorStats.weaponRunes;
  if (weaponRunes) {
    // v2 detail: the seasonal class trio, name + verbatim effect per rune (data-provenance
    // season stamp on top — rune sets rotate every season, an undated list is not ground truth).
    if (weaponRunes.seasonLine) panel.appendChild(el('p', 'hv2-runes-season', weaponRunes.seasonLine));
    if (runes.note) panel.appendChild(el('p', 'hv2-note', runes.note));
    const list = el('div', 'hv2-rune-list');
    for (const item of weaponRunes.items) {
      const row = el('div', 'hv2-rune-row');
      row.appendChild(initialsTile(tileInitials(item.name), 'hv2-tile-sm', true));
      const body = el('div');
      body.appendChild(el('div', 'hv2-set-name', item.name));
      if (item.effect) body.appendChild(el('div', 'hv2-set-desc', item.effect));
      row.appendChild(body);
      list.appendChild(row);
    }
    panel.appendChild(list);
  } else {
    const value = typeof runes.value === 'string' && runes.value.trim() !== '' ? runes.value : 'unknown';
    const valueLine = el('p', 'hv2-runes-value');
    valueLine.appendChild(el('span', value.toLowerCase() === 'unknown' ? 'hv2-unknown' : 'hv2-strong', value));
    if (runes.note) valueLine.appendChild(document.createTextNode(` - ${runes.note}`));
    panel.appendChild(valueLine);
  }
  if (runes.gapNote) panel.appendChild(gapLine(runes.gapNote));

  panel.appendChild(divider());

  const armorHead = el('div', 'hv2-runes-row-head');
  armorHead.appendChild(el('span', 'hv2-runes-title', 'Armor runes'));
  const armorRunes = armorStats.armorRunes;
  if (armorRunes?.badge) armorHead.appendChild(el('span', 'hv2-badge hv2-badge-dim', armorRunes.badge));
  panel.appendChild(armorHead);

  if (!armorRunes) {
    panel.appendChild(emptyRow('Armor rune build not captured yet - needs the runes-guides pass.'));
    return panel;
  }

  if (armorRunes.intro) panel.appendChild(el('p', 'hv2-runes-intro', armorRunes.intro));
  if (armorRunes.mandatoryNote) {
    const p = el('p', 'hv2-runes-mandatory');
    appendAttributed(p, armorRunes.mandatoryNote, null);
    panel.appendChild(p);
  }
  const list = el('div', 'hv2-rune-list');
  for (const item of armorRunes.items) {
    const row = el('div', 'hv2-rune-row');
    row.appendChild(initialsTile(tileInitials(item.slot), 'hv2-tile-sm'));
    const body = el('div');
    const nameRow = el('div', 'hv2-set-name-row');
    nameRow.appendChild(el('span', 'hv2-set-name', item.slot));
    if (item.updated) nameRow.appendChild(el('span', 'hv2-badge hv2-badge-dim', `UPD ${item.updated}`));
    body.appendChild(nameRow);
    if (item.note) body.appendChild(isGapText(item.note) ? gapLine(item.note) : el('div', 'hv2-set-desc', item.note));
    if (Array.isArray(item.runes) && item.runes.length > 0) {
      // v2 detail: the named picks for this slot — mandatory ones carry the gold badge.
      const subList = el('div', 'hv2-rune-sublist');
      for (const rune of item.runes) {
        const subRow = el('div', 'hv2-rune-sub');
        const subName = el('div', 'hv2-set-name-row');
        subName.appendChild(el('span', 'hv2-rune-sub-name', rune.name));
        if (rune.mandatory) subName.appendChild(el('span', 'hv2-badge hv2-badge-gold', 'mandatory'));
        subRow.appendChild(subName);
        if (rune.effect) subRow.appendChild(el('div', 'hv2-set-desc', rune.effect));
        subList.appendChild(subRow);
      }
      body.appendChild(subList);
    }
    row.appendChild(body);
    list.appendChild(row);
  }
  panel.appendChild(list);
  if (armorRunes.seasonNote) panel.appendChild(el('p', 'hv2-note hv2-runes-season-note', armorRunes.seasonNote));
  return panel;
}

function renderArmorStats(armorStats) {
  const panel = el('section', 'hv2-panel');
  panel.id = 'armor';
  panel.appendChild(sectionTitle('ARMOR & STATS', { anchor: '#armor' }));
  const grid = el('div', 'hv2-armor-grid');
  grid.appendChild(renderArmorSetsColumn(armorStats));
  grid.appendChild(renderStatPriorityColumn(armorStats));
  grid.appendChild(renderRunesColumn(armorStats));
  panel.appendChild(grid);
  return panel;
}

// ---- Block 6 · Controls & combos ---------------------------------------------------------------------------

/** ON/OFF chip with a non-color signal (check/x glyph + the word itself). */
function onOffChip(on) {
  const chip = el('span', on ? 'hv2-onoff hv2-on' : 'hv2-onoff');
  chip.appendChild(icon(on ? 'check' : 'x'));
  chip.appendChild(document.createTextNode(on ? 'ON' : 'OFF'));
  return chip;
}

/** Key-chip step chain: chip → chip → chip (arrows are UI grammar, allowed by the copy-voice rule). */
function stepChain(steps, chipClass) {
  const wrap = el('div', 'hv2-keys');
  steps.forEach((step, i) => {
    if (i > 0) wrap.appendChild(el('span', 'hv2-key-arrow', '→'));
    wrap.appendChild(el('span', chipClass || 'hv2-key', step));
  });
  return wrap;
}

function renderControlsLeft(controls) {
  const col = el('div', 'hv2-controls-col');

  col.appendChild(microLabel('AIMING SETTINGS'));
  if (!controls.aiming) {
    col.appendChild(emptyRow('No aiming settings captured for this class yet.'));
  } else {
    const list = el('div', 'hv2-aim-list');
    for (const row of controls.aiming) {
      const aimRow = el('div', 'hv2-aim-row');
      const labelWrap = el('span', 'hv2-aim-label');
      labelWrap.appendChild(document.createTextNode(row.label));
      aimRow.appendChild(labelWrap);
      aimRow.appendChild(onOffChip(row.on));
      list.appendChild(aimRow);
      if (row.note) list.appendChild(el('div', 'hv2-aim-note', row.note));
    }
    col.appendChild(list);
  }

  col.appendChild(divider());
  col.appendChild(microLabel('SKILL LOADOUT'));
  if (controls.skillCore.length === 0) {
    col.appendChild(emptyRow('No core skill picks captured yet.'));
  } else {
    const line = el('div', 'hv2-chipline hv2-skill-line');
    line.appendChild(el('span', 'hv2-badge hv2-badge-gold', 'CORE'));
    for (const skill of controls.skillCore) line.appendChild(el('span', 'hv2-pill hv2-pill-strong', skill));
    col.appendChild(line);
  }
  if (controls.fillerNotes) col.appendChild(el('p', 'hv2-note', controls.fillerNotes));

  col.appendChild(divider());
  col.appendChild(microLabel('CLIPS'));
  if (controls.clips.length === 0) {
    col.appendChild(emptyRow('No clips linked for this class yet.', 'video'));
  } else {
    const list = el('div', 'hv2-clip-list');
    for (const clip of controls.clips) {
      if (clip.href) {
        const a = document.createElement('a');
        a.className = 'hv2-clip';
        a.href = clip.href;
        a.textContent = clip.label;
        list.appendChild(a);
      } else {
        list.appendChild(el('span', 'hv2-clip', clip.label));
      }
    }
    col.appendChild(list);
  }

  return col;
}

function renderControlsRight(controls) {
  const col = el('div', 'hv2-controls-col');

  if (controls.techniques.length === 0) {
    col.appendChild(microLabel('TECHNIQUES'));
    col.appendChild(emptyRow('No technique write-ups in the guide yet.'));
  } else {
    controls.techniques.forEach((technique, i) => {
      if (i > 0) col.appendChild(divider());
      col.appendChild(microLabel(String(technique.name || 'TECHNIQUE').toUpperCase()));
      // First steps that read as key inputs render as the chip chain; longer sentences render as
      // diamond bullets underneath (the design's stagger block does exactly this split).
      const chipSteps = technique.steps.filter((s) => String(s).length <= 28);
      const proseSteps = technique.steps.filter((s) => String(s).length > 28);
      if (chipSteps.length > 0) col.appendChild(stepChain(chipSteps));
      if (technique.rhythm) col.appendChild(el('p', 'hv2-prose', technique.rhythm));
      if (proseSteps.length > 0) {
        const list = el('div', 'hv2-bullets hv2-bullets-tight');
        for (const step of proseSteps) list.appendChild(bulletRow(null, step));
        col.appendChild(list);
      }
    });
  }

  col.appendChild(divider());
  col.appendChild(microLabel('COMBOS'));
  if (controls.combos.length === 0) {
    col.appendChild(emptyRow('No named combos in the guide yet.'));
  } else {
    const list = el('div', 'hv2-combo-list');
    for (const combo of controls.combos) {
      const row = el('div', 'hv2-combo-row');
      row.appendChild(el('span', 'hv2-combo-name', combo.name));
      const chain = el('span', 'hv2-combo-chain');
      combo.steps.forEach((step, i) => {
        if (i > 0) chain.appendChild(el('span', 'hv2-key-arrow', ' → '));
        chain.appendChild(document.createTextNode(String(step)));
      });
      if (combo.note) chain.appendChild(el('span', 'hv2-combo-note', ` ${combo.note}`));
      row.appendChild(chain);
      list.appendChild(row);
    }
    col.appendChild(list);
  }

  if (controls.combosSignoff) {
    const signoff = el('div', 'hv2-combo-signoff');
    signoff.appendChild(authorSuffix(controls.combosSignoff));
    col.appendChild(signoff);
  }

  if (controls.gapNote) col.appendChild(gapLine(controls.gapNote));
  return col;
}

function renderControls(controls) {
  const panel = el('section', 'hv2-panel');
  panel.id = 'controls';
  panel.appendChild(sectionTitle('CONTROLS & COMBOS', { anchor: '#controls' }));
  const grid = el('div', 'hv2-controls-grid');
  grid.appendChild(renderControlsLeft(controls));
  grid.appendChild(renderControlsRight(controls));
  panel.appendChild(grid);
  return panel;
}

// ---- Block 7 · Builds ---------------------------------------------------------------------------------------

function renderBuilds(builds) {
  const panel = el('section', 'hv2-panel');
  panel.id = 'builds';
  panel.appendChild(sectionTitle('BUILDS', { meta: String(builds.length || ''), anchor: '#builds' }));

  if (builds.length === 0) {
    panel.appendChild(emptyRow('No builds captured for this class yet.'));
    return panel;
  }

  const grid = el('div', 'hv2-build-grid');
  for (const build of builds) {
    const card = el('div', build.recommended ? 'hv2-build-card hv2-build-rec' : 'hv2-build-card');

    const head = el('div', 'hv2-build-head');
    const title = el('div');
    title.appendChild(el('div', 'hv2-build-name', build.name));
    if (build.typeLabel) title.appendChild(el('div', 'hv2-build-type', build.typeLabel.toUpperCase()));
    head.appendChild(title);
    if (build.recommended) {
      const badge = el('span', 'hv2-badge hv2-badge-gold hv2-badge-rec');
      badge.appendChild(icon('star'));
      badge.appendChild(document.createTextNode('recommended'));
      head.appendChild(badge);
    } else if (build.linkedVariantTierLabel) {
      head.appendChild(el('span', 'hv2-badge hv2-badge-dim', build.linkedVariantTierLabel));
    }
    card.appendChild(head);

    if (build.summary) card.appendChild(el('p', 'hv2-build-summary', build.summary));

    const foot = el('div', 'hv2-build-foot');
    if (build.strongVs) {
      const line = el('p', 'hv2-build-foot-line');
      line.appendChild(el('b', 'hv2-strong', 'Strong vs: '));
      line.appendChild(document.createTextNode(build.strongVs));
      foot.appendChild(line);
    }
    if (build.forWhom) {
      const line = el('p', 'hv2-build-foot-line');
      line.appendChild(el('b', 'hv2-strong', 'For: '));
      line.appendChild(document.createTextNode(build.forWhom));
      foot.appendChild(line);
    }
    if (build.altSkill) {
      foot.appendChild(el('div', 'hv2-build-alt-label', 'ALT SKILL'));
      foot.appendChild(el('p', 'hv2-build-foot-line', build.altSkill));
    }
    if (foot.childNodes.length > 0) card.appendChild(foot);

    grid.appendChild(card);
  }
  panel.appendChild(grid);
  return panel;
}

// ---- Block 8 · Matchups --------------------------------------------------------------------------------------

function matchupGroup(headingIcon, headingClass, headingText, cards, cardClass) {
  const col = el('div', 'hv2-mu-col');
  const head = el('div', 'hv2-mu-head');
  head.appendChild(icon(headingIcon, headingClass));
  head.appendChild(el('span', `hv2-mu-head-label ${headingClass}`, headingText));
  head.appendChild(el('span', 'hv2-sec-meta', String(cards.length)));
  col.appendChild(head);

  if (cards.length === 0) {
    col.appendChild(emptyRow('None captured.'));
    return col;
  }
  const list = el('div', 'hv2-mu-list');
  for (const card of cards) {
    const item = el('div', `hv2-mu-card ${cardClass}`);
    const nameRow = el('div', 'hv2-set-name-row');
    nameRow.appendChild(el('span', 'hv2-mu-vs', card.vs));
    if (card.badge) nameRow.appendChild(el('span', 'hv2-badge hv2-badge-dim', String(card.badge).toUpperCase()));
    item.appendChild(nameRow);
    if (card.why) item.appendChild(el('div', 'hv2-mu-why', card.why));
    list.appendChild(item);
  }
  col.appendChild(list);
  return col;
}

function renderMatchups(matchups) {
  const panel = el('section', 'hv2-panel');
  panel.id = 'matchups';
  panel.appendChild(sectionTitle('MATCHUPS', { meta: 'armor-class based', anchor: '#matchups' }));
  const grid = el('div', 'hv2-mu-grid');
  grid.appendChild(matchupGroup('trendUp', 'hv2-green', 'STRONG VS', matchups.strong, 'hv2-mu-strong'));
  grid.appendChild(matchupGroup('trendDown', 'hv2-red', 'WEAK VS', matchups.weak, 'hv2-mu-weak'));
  grid.appendChild(matchupGroup('link', 'hv2-goldc', 'UNIT SYNERGY', matchups.synergy, 'hv2-mu-syn'));
  panel.appendChild(grid);
  return panel;
}

// ---- Block 8b · Learn more --------------------------------------------------------------------------------------

/** External study links (v2 extension) — omitted entirely when the record carries none (an
 * add-on block outside the designed nine; no empty state needed). */
function renderLearnMore(learnMore) {
  if (!learnMore || learnMore.links.length === 0) return null;
  const panel = el('section', 'hv2-panel');
  panel.id = 'learn-more';
  panel.appendChild(sectionTitle('LEARN MORE', { anchor: '#learn-more' }));
  if (learnMore.intro) panel.appendChild(el('p', 'hv2-block-intro', learnMore.intro));
  const list = el('div', 'hv2-learn-list');
  for (const link of learnMore.links) {
    const row = el('div', 'hv2-learn-row');
    const a = document.createElement('a');
    a.className = 'hv2-clip';
    a.href = link.href;
    a.target = '_blank';
    a.rel = 'noopener';
    a.appendChild(icon('link'));
    a.appendChild(document.createTextNode(link.label));
    row.appendChild(a);
    if (link.desc) row.appendChild(el('span', 'hv2-set-desc hv2-learn-desc', link.desc));
    list.appendChild(row);
  }
  panel.appendChild(list);
  return panel;
}

// ---- Block 9 · Footer -----------------------------------------------------------------------------------------

function renderFooter(footer) {
  const wrap = el('div', 'hv2-footer');
  const creditRow = el('div', 'hv2-footer-credit');
  if (footer.creditLine) creditRow.appendChild(el('span', 'hv2-footer-mono', footer.creditLine));
  creditRow.appendChild(el('span', 'hv2-eyebrow-line'));
  if (footer.datesLine) creditRow.appendChild(el('span', 'hv2-footer-mono', footer.datesLine));
  wrap.appendChild(creditRow);
  if (footer.philosophyQuote) {
    const quote = el('p', 'hv2-philosophy');
    appendAttributed(quote, `"${footer.philosophyQuote.text}"`, footer.philosophyQuote.attribution);
    wrap.appendChild(quote);
  }
  return wrap;
}

// ---- Page assembly ----------------------------------------------------------------------------------------------

/**
 * Renders the full nine-block page model into `root` (cleared first — idempotent). Exported for
 * the DOM tests; boot() below is the page entry.
 */
export function renderHeroPageV2(model, root) {
  root.textContent = '';
  root.appendChild(renderEyebrow());
  root.appendChild(renderHeader(model.header));
  root.appendChild(renderBattleRole(model.battleRole));
  root.appendChild(renderPositioningAndTips(model.positioning, model.tips));
  root.appendChild(renderArmorStats(model.armorStats));
  root.appendChild(renderControls(model.controls));
  root.appendChild(renderBuilds(model.builds));
  root.appendChild(renderMatchups(model.matchups));
  const learnMore = renderLearnMore(model.learnMore);
  if (learnMore) root.appendChild(learnMore);
  root.appendChild(renderFooter(model.footer));
}

/** Fetches one hero record by slug (same URL grammar + result envelope as the v1 boot). */
function fetchHeroRecord(slug) {
  const url = new URL(`${encodeURIComponent(slug)}.json`, HERO_RECORD_DIR_URL).href;
  return fetchJson(withCacheBust(url));
}

/** Fetches the heroes index — only its intro.microcopy philosophy quote is used here. */
function fetchHeroIndexForPhilosophy() {
  const url = new URL('index.json', HERO_RECORD_DIR_URL).href;
  return fetchJson(withCacheBust(url));
}

/** The same footer quote the v1 page and heroes index use (one consistent voice). */
function pickPhilosophyQuote(indexData) {
  const microcopy = indexData && typeof indexData === 'object' ? indexData.intro?.microcopy : null;
  return microcopy && typeof microcopy.text === 'string' ? microcopy : null;
}

/**
 * Page boot: reads `?h=<slug>`, fetches record + index, renders the v2 page into #hero-v2-page.
 * The v1 tree (#hero-content) stays hidden. Not-found states reuse #hero-not-found with the v1
 * boot's exact copy.
 */
export async function boot() {
  const notFoundEl = document.getElementById('hero-not-found');
  const rootEl = document.getElementById('hero-v2-page');
  const v1TreeEl = document.getElementById('hero-content');
  if (v1TreeEl) v1TreeEl.hidden = true;

  const slug = slugFromSearch(window.location.search);
  if (!slug) {
    if (rootEl) rootEl.hidden = true;
    if (notFoundEl) {
      notFoundEl.hidden = false;
      notFoundEl.textContent = 'No hero class specified - head back to the Heroes index and pick one.';
    }
    return;
  }

  const [recordResult, indexResult] = await Promise.all([fetchHeroRecord(slug), fetchHeroIndexForPhilosophy()]);

  if (!recordResult.ok || !recordResult.data) {
    if (rootEl) rootEl.hidden = true;
    if (notFoundEl) {
      notFoundEl.hidden = false;
      notFoundEl.textContent = `No guide found for "${slug}" - it may not be written yet.`;
    }
    return;
  }

  if (notFoundEl) notFoundEl.hidden = true;
  const record = /** @type {Record<string, unknown>} */ (recordResult.data);
  if (record.className) document.title = `${record.className} — Immortals Academy`;

  const model = buildHeroPageV2Model(record, pickPhilosophyQuote(indexResult.data));
  if (rootEl) {
    renderHeroPageV2(model, rootEl);
    rootEl.hidden = false;
  }
}
