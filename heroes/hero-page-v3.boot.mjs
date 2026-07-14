// heroes/hero-page-v3.boot.mjs — DOM rendering for the hero detail page v3, the layout from
// design/handoff-hero-page-v3/Hero Page v3 Shortsword.dc.html (Claude Design project "Tzsum:
// Home Point Push", imported 2026-07-14; Tips & Tricks re-imported same day after Jasper moved
// it in the design). This renderer drives ALL hero pages: eyebrow (+season) → header → battle
// role → controls & combos → [armor & stats | positioning] → runes band → build cards →
// matchups → tips & tricks (full-width, 3-col) → learn more (replays / TW recordings / who to
// ask) → footer.
//
// v3 deltas over the v2 renderer (which stays on disk as the rollback path):
//   - Tips & Tricks carries the class-specific / GENERAL separator (Jasper, 2026-07-14):
//     class-specific tips on top, cross-class advice (general-flagged bullets + the universal
//     techniques) below a labeled hairline. Controls & Combos consequently shows only
//     class-specific techniques.
//   - Runes leave the Armor & Stats panel for their own horizontal band (weapon runes tagged
//     class-specific, armor runes tagged shared · all <weight> classes, then the slot cards).
//   - Clips move from Controls to Learn More's replays column; Learn More becomes the design's
//     three columns and always renders (it has designed empty states).
//
// The whole tree is built into ONE root element (hero.html's `#hero-v3-page`). The v2 and v1
// trees stay available as rollback paths — swap hero.html's boot import + stylesheet to go back.
//
// ESCAPING: every record-derived value is written via `.textContent` / createTextNode, never
// `.innerHTML` — the only innerHTML use is icon()'s compile-time-constant SVG strings (same
// static-markup carve-out as the v2 boot).

import { fetchJson, withCacheBust } from '../shared/data.mjs';
import { slugFromSearch, buildHeroPageV3Model, isGapText, tileInitials } from './hero-page-v3.mjs';

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
  flag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 21V4"/><path d="M5 4c4-2.5 8 2.5 12 0v9c-4 2.5-8-2.5-12 0"/></svg>',
  chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-8 8H4l2.3-2.7A8 8 0 1 1 21 12z"/></svg>',
};

/** Decorative inline-SVG glyph span; `name` selects a SVG_ICONS constant (never record data). */
function icon(name, className) {
  const span = document.createElement('span');
  span.className = className ? `hv3-ic ${className}` : 'hv3-ic';
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
  return el('span', className ? `hv3-diamond ${className}` : 'hv3-diamond');
}

/** Panel section-title bar: gold accent tick + tracked label + optional mono meta + #anchor. */
function sectionTitle(label, { meta = null, anchor = null } = {}) {
  const bar = el('div', 'hv3-sec-title');
  bar.appendChild(el('span', 'hv3-sec-accent'));
  bar.appendChild(el('span', 'hv3-sec-label', label));
  if (meta) bar.appendChild(el('span', 'hv3-sec-meta', meta));
  bar.appendChild(el('span', 'hv3-sec-spacer'));
  if (anchor) bar.appendChild(el('span', 'hv3-sec-anchor', anchor));
  return bar;
}

/** 10px tracked mono sub-group label (ATTRIBUTE POINTS, ARMOR SETS, ...). */
function microLabel(text) {
  return el('div', 'hv3-micro-label', text);
}

/** Hairline divider between sub-groups. */
function divider() {
  return el('div', 'hv3-divider');
}

/** Mono gold author sign-off: "- SanY" (copy-voice rule: hyphen, never an em-dash). */
function authorSuffix(name) {
  return el('span', 'hv3-author', ` - ${name}`);
}

/** Appends prose + optional author sign-off to a parent. */
function appendAttributed(parent, text, attribution) {
  parent.appendChild(document.createTextNode(String(text)));
  if (attribution) {
    parent.appendChild(document.createTextNode(' '));
    parent.appendChild(authorSuffix(attribution));
  }
}

/** Honest labeled empty state — dashed quiet row (the design's own "None linked yet" grammar). */
function emptyRow(text, iconName = null) {
  const row = el('div', 'hv3-empty');
  if (iconName) row.appendChild(icon(iconName));
  row.appendChild(document.createTextNode(text));
  return row;
}

/** Supplied [GAP: ...] honesty line — quiet mono register, visible where it occurs (taxonomy §1). */
function gapLine(text) {
  return el('div', 'hv3-gap', text);
}

/** Square placeholder tile with coded initials (the handoff's no-icon grammar). */
function initialsTile(initials, className, accent = false) {
  const tile = el('span', `hv3-tile ${className || ''}${accent ? ' hv3-tile-gold' : ''}`, initials);
  tile.setAttribute('aria-hidden', 'true');
  return tile;
}

/** Header weapon-class icon tile: real art layered over the coded initials (404 -> placeholder). */
function heroIconTile(slug, initials) {
  const tile = initialsTile(initials, 'hv3-tile-lg hv3-tile-icon');
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
  const row = el('div', 'hv3-bullet');
  row.appendChild(diamond());
  const body = el('span', 'hv3-bullet-text');
  if (lead) {
    body.appendChild(el('b', 'hv3-bullet-lead', `${lead} `));
  }
  body.appendChild(document.createTextNode(String(text)));
  row.appendChild(body);
  return row;
}

/** The mono ask-channel chip ("#heroes"). */
function askChip(channel) {
  return el('span', 'hv3-ask-chip', channel);
}

// ---- Eyebrow -------------------------------------------------------------------------------------

function renderEyebrow(seasonLabel) {
  const row = el('div', 'hv3-eyebrow');
  const crest = el('span', 'hv3-crest');
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
  row.appendChild(el('span', 'hv3-eyebrow-brand', 'IMMORTALS'));
  row.appendChild(el('span', 'hv3-eyebrow-dim', 'HERO GUIDE'));
  row.appendChild(el('span', 'hv3-eyebrow-line'));
  if (seasonLabel) row.appendChild(el('span', 'hv3-eyebrow-season', seasonLabel));
  return row;
}

// ---- Block 1 · Header ------------------------------------------------------------------------------

function renderHeader(header) {
  const panel = el('section', 'hv3-panel hv3-header');
  panel.id = 'hero';

  const top = el('div', 'hv3-header-top');
  const identity = el('div', 'hv3-header-identity');
  identity.appendChild(heroIconTile(header.slug, header.iconCode));
  const nameWrap = el('div');
  nameWrap.appendChild(el('h1', 'hv3-name', header.className));
  if (header.weaponArchetype) nameWrap.appendChild(el('p', 'hv3-archetype', header.weaponArchetype));
  identity.appendChild(nameWrap);
  top.appendChild(identity);

  const chips = el('div', 'hv3-chip-row');
  for (const tierChip of header.tierChips) {
    const chip = el('div', 'hv3-chip hv3-chip-gold');
    chip.appendChild(el('span', 'hv3-chip-value', tierChip.value));
    chip.appendChild(el('span', 'hv3-chip-label', tierChip.label.toUpperCase()));
    chips.appendChild(chip);
  }
  if (header.armorClassChip) {
    const chip = el('div', 'hv3-chip');
    chip.appendChild(el('span', 'hv3-chip-value', header.armorClassChip));
    chip.appendChild(el('span', 'hv3-chip-label', 'ARMOR CLASS'));
    chips.appendChild(chip);
  }
  if (header.epicChip) {
    const chip = el('div', 'hv3-chip');
    chip.appendChild(el('span', 'hv3-chip-value', header.epicChip));
    chip.appendChild(el('span', 'hv3-chip-label', 'EPIC SCHEM'));
    chips.appendChild(chip);
  }
  top.appendChild(chips);
  panel.appendChild(top);

  panel.appendChild(divider());

  const lines = el('div', 'hv3-header-lines');
  if (header.tierLine) {
    const line = el('div', 'hv3-header-line');
    line.appendChild(el('span', 'hv3-header-line-dim', 'Tier: '));
    line.appendChild(el('b', 'hv3-header-line-strong', header.tierLine));
    line.appendChild(document.createTextNode(" on Amya's tierlist"));
    if (header.tierlistUpdated) line.appendChild(document.createTextNode(`, updated ${header.tierlistUpdated}`));
    lines.appendChild(line);
  }
  if (header.epicSchemLine) {
    const line = el('div', 'hv3-header-line');
    line.appendChild(el('span', 'hv3-header-line-gold', 'Epic Schematic: '));
    line.appendChild(document.createTextNode(header.epicSchemLine.needed));
    if (header.epicSchemLine.name) {
      line.appendChild(document.createTextNode(' - '));
      line.appendChild(el('b', 'hv3-header-line-strong', header.epicSchemLine.name));
    }
    lines.appendChild(line);
  }
  if (header.tierDropNote) lines.appendChild(el('div', 'hv3-header-line hv3-header-drop-note', header.tierDropNote));
  if (header.freshnessLine) lines.appendChild(el('div', 'hv3-header-freshness', header.freshnessLine));
  panel.appendChild(lines);

  return panel;
}

// ---- Block 2 · Battle role ---------------------------------------------------------------------------

function renderBattleRole(battleRole) {
  const panel = el('section', 'hv3-panel');
  panel.id = 'role';
  panel.appendChild(sectionTitle('BATTLE ROLE', { anchor: '#role' }));

  if (battleRole.roleLabel) {
    const line = el('div', 'hv3-role-line');
    line.appendChild(diamond());
    const text = el('span', 'hv3-role-line-text');
    text.appendChild(el('span', 'hv3-role-line-lead', 'Role: '));
    text.appendChild(document.createTextNode(battleRole.roleLabel));
    line.appendChild(text);
    panel.appendChild(line);
  }

  if (battleRole.paragraphs.length === 0) {
    panel.appendChild(emptyRow('Role prose not written for this class yet.'));
    return panel;
  }

  const quotePanel = el('div', 'hv3-role-quotes');
  for (const para of battleRole.paragraphs) {
    const p = el('p', 'hv3-role-quote');
    appendAttributed(p, para.text, para.attribution);
    quotePanel.appendChild(p);
  }
  panel.appendChild(quotePanel);
  return panel;
}

// ---- Block 3 · Controls & combos ----------------------------------------------------------------------

/** ON/OFF chip with a non-color signal (check/x glyph + the word itself). */
function onOffChip(on) {
  const chip = el('span', on ? 'hv3-onoff hv3-on' : 'hv3-onoff');
  chip.appendChild(icon(on ? 'check' : 'x'));
  chip.appendChild(document.createTextNode(on ? 'ON' : 'OFF'));
  return chip;
}

/** Key-chip step chain: chip → chip → chip (arrows are UI grammar, allowed by the copy-voice rule). */
function stepChain(steps, chipClass) {
  const wrap = el('div', 'hv3-keys');
  steps.forEach((step, i) => {
    if (i > 0) wrap.appendChild(el('span', 'hv3-key-arrow', '→'));
    wrap.appendChild(el('span', chipClass || 'hv3-key', step));
  });
  return wrap;
}

function renderControlsLeft(controls) {
  const col = el('div', 'hv3-controls-col');

  col.appendChild(microLabel('AIMING SETTINGS'));
  if (!controls.aiming) {
    col.appendChild(emptyRow('No aiming settings captured for this class yet.'));
  } else {
    const list = el('div', 'hv3-aim-list');
    for (const row of controls.aiming) {
      const aimRow = el('div', 'hv3-aim-row');
      const labelWrap = el('span', 'hv3-aim-label');
      labelWrap.appendChild(document.createTextNode(row.label));
      aimRow.appendChild(labelWrap);
      aimRow.appendChild(onOffChip(row.on));
      list.appendChild(aimRow);
      if (row.note) list.appendChild(el('div', 'hv3-aim-note', row.note));
    }
    col.appendChild(list);
  }

  col.appendChild(divider());
  col.appendChild(microLabel('SKILL LOADOUT'));
  if (controls.skillCore.length === 0) {
    col.appendChild(emptyRow('No core skill picks captured yet.'));
  } else {
    const line = el('div', 'hv3-chipline hv3-skill-line');
    line.appendChild(el('span', 'hv3-badge hv3-badge-gold', 'CORE'));
    for (const skill of controls.skillCore) line.appendChild(el('span', 'hv3-pill hv3-pill-strong', skill));
    col.appendChild(line);
  }
  if (controls.fillerNotes) col.appendChild(el('p', 'hv3-note', controls.fillerNotes));

  return col;
}

function renderControlsRight(controls) {
  const col = el('div', 'hv3-controls-col');

  if (controls.techniques.length === 0) {
    col.appendChild(microLabel('TECHNIQUES'));
    col.appendChild(emptyRow('No class-specific technique write-ups in the guide yet.'));
  } else {
    controls.techniques.forEach((technique, i) => {
      if (i > 0) col.appendChild(divider());
      col.appendChild(microLabel(String(technique.name || 'TECHNIQUE').toUpperCase()));
      // First steps that read as key inputs render as the chip chain; longer sentences render as
      // diamond bullets underneath (the design's stagger block does exactly this split).
      const chipSteps = technique.steps.filter((s) => String(s).length <= 28);
      const proseSteps = technique.steps.filter((s) => String(s).length > 28);
      if (chipSteps.length > 0) col.appendChild(stepChain(chipSteps));
      if (technique.rhythm) col.appendChild(el('p', 'hv3-prose', technique.rhythm));
      if (proseSteps.length > 0) {
        const list = el('div', 'hv3-bullets hv3-bullets-tight');
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
    const list = el('div', 'hv3-combo-list');
    for (const combo of controls.combos) {
      const row = el('div', 'hv3-combo-row');
      row.appendChild(el('span', 'hv3-combo-name', combo.name));
      const chain = el('span', 'hv3-combo-chain');
      combo.steps.forEach((step, i) => {
        if (i > 0) chain.appendChild(el('span', 'hv3-key-arrow', ' → '));
        chain.appendChild(document.createTextNode(String(step)));
      });
      if (combo.note) chain.appendChild(el('span', 'hv3-combo-note', ` ${combo.note}`));
      row.appendChild(chain);
      list.appendChild(row);
    }
    col.appendChild(list);
  }

  if (controls.combosSignoff) {
    const signoff = el('div', 'hv3-combo-signoff');
    signoff.appendChild(authorSuffix(controls.combosSignoff));
    col.appendChild(signoff);
  }

  if (controls.gapNote) col.appendChild(gapLine(controls.gapNote));
  return col;
}

function renderControls(controls) {
  const panel = el('section', 'hv3-panel');
  panel.id = 'controls';
  panel.appendChild(sectionTitle('CONTROLS & COMBOS', { anchor: '#controls' }));
  const grid = el('div', 'hv3-controls-grid');
  grid.appendChild(renderControlsLeft(controls));
  grid.appendChild(renderControlsRight(controls));
  panel.appendChild(grid);
  return panel;
}

// ---- Block 4 · Armor & stats | Positioning & tips -------------------------------------------------------

function renderArmorSetsColumn(armorStats) {
  const col = el('div', 'hv3-armor-col');

  col.appendChild(microLabel('ATTRIBUTE POINTS'));
  if (armorStats.attribute) col.appendChild(el('p', 'hv3-prose', armorStats.attribute));
  else col.appendChild(emptyRow('No attribute recommendation captured yet.'));

  col.appendChild(divider());
  col.appendChild(microLabel('ARMOR SETS'));
  if (armorStats.armorSets.length === 0) {
    col.appendChild(emptyRow('No armor sets captured yet.'));
  } else {
    const list = el('div', 'hv3-set-list');
    for (const set of armorStats.armorSets) {
      const row = el('div', 'hv3-set-row');
      row.appendChild(initialsTile(set.initials, 'hv3-tile-sm', set.isEpic));
      const body = el('div');
      const nameRow = el('div', 'hv3-set-name-row');
      nameRow.appendChild(el('span', 'hv3-set-name', set.name));
      if (set.isEpic) nameRow.appendChild(el('span', 'hv3-badge hv3-badge-gold', 'epic schem'));
      body.appendChild(nameRow);
      if (set.desc) body.appendChild(el('div', 'hv3-set-desc', set.desc));
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
    const list = el('div', 'hv3-spread-list');
    for (const spread of armorStats.statSpreads) {
      const row = el('div', 'hv3-spread-row');
      row.appendChild(el('span', 'hv3-spread-build', spread.build));
      const value = el('span', 'hv3-spread-value');
      value.appendChild(document.createTextNode(String(spread.spread)));
      if (spread.note) value.appendChild(el('span', 'hv3-spread-note', ` ${spread.note}`));
      row.appendChild(value);
      list.appendChild(row);
    }
    col.appendChild(list);
  }

  return col;
}

function renderStatPriorityColumn(armorStats) {
  const col = el('div', 'hv3-armor-col');

  col.appendChild(microLabel('ARMOR STAT PRIORITY'));
  const priority = armorStats.statPriority;
  if (!priority) {
    col.appendChild(emptyRow('Armor stat ladder not captured for this class yet.'));
  } else {
    if (priority.intro) col.appendChild(el('p', 'hv3-block-intro', priority.intro));
    const ladder = el('div', 'hv3-ladder');
    for (const tier of priority.tiers) {
      const grade = String(tier.grade || '').toUpperCase();
      const row = el('div', `hv3-ladder-row hv3-ladder-${grade.toLowerCase() || 'b'}`);
      row.appendChild(el('span', 'hv3-ladder-grade', grade));
      row.appendChild(el('span', 'hv3-ladder-label', tier.label));
      ladder.appendChild(row);
    }
    col.appendChild(ladder);
    if (priority.quote) {
      const quote = el('p', 'hv3-serif-quote');
      appendAttributed(quote, `"${priority.quote.text}"`, priority.quote.attribution);
      col.appendChild(quote);
    }
    if (priority.craftNote) {
      const note = el('p', 'hv3-note hv3-craft-note');
      if (priority.craftNote.lead) note.appendChild(el('b', 'hv3-strong', `${priority.craftNote.lead} - `));
      appendAttributed(note, priority.craftNote.text, priority.craftNote.attribution);
      col.appendChild(note);
    }
  }

  col.appendChild(divider());
  col.appendChild(microLabel('WEAPON STATS'));
  if (armorStats.weaponStatsNeed.length === 0 && armorStats.weaponStatsBonus.length === 0) {
    col.appendChild(emptyRow('No weapon stat priorities captured yet.'));
  } else {
    const rows = el('div', 'hv3-weapon-stats');
    const chipLine = (badge, badgeClass, items, chipClass) => {
      const line = el('div', 'hv3-chipline');
      line.appendChild(el('span', `hv3-badge ${badgeClass}`, badge));
      for (const item of items) line.appendChild(el('span', `hv3-pill ${chipClass}`, item));
      return line;
    };
    if (armorStats.weaponStatsNeed.length > 0)
      rows.appendChild(chipLine('NEED', 'hv3-badge-gold', armorStats.weaponStatsNeed, 'hv3-pill-strong'));
    if (armorStats.weaponStatsBonus.length > 0)
      rows.appendChild(chipLine('BONUS', 'hv3-badge-dim', armorStats.weaponStatsBonus, ''));
    col.appendChild(rows);
  }

  if (armorStats.gender) {
    col.appendChild(divider());
    col.appendChild(microLabel('CHARACTER GENDER'));
    const p = el('p', 'hv3-prose');
    p.appendChild(el('b', 'hv3-strong', armorStats.gender.best));
    if (armorStats.gender.note) p.appendChild(document.createTextNode(` - ${armorStats.gender.note}`));
    col.appendChild(p);
  }

  return col;
}

function renderArmorStats(armorStats) {
  const panel = el('section', 'hv3-panel');
  panel.id = 'armor';
  panel.appendChild(sectionTitle('ARMOR & STATS', { anchor: '#armor' }));
  const grid = el('div', 'hv3-armor-grid');
  grid.appendChild(renderArmorSetsColumn(armorStats));
  grid.appendChild(renderStatPriorityColumn(armorStats));
  panel.appendChild(grid);
  return panel;
}

/** One general (cross-class) technique rendered compactly in the tips GENERAL section. */
function generalTechniqueRow(technique) {
  const wrap = el('div', 'hv3-general-item');
  wrap.appendChild(bulletRow(technique.name, technique.rhythm || ''));
  if (technique.steps.length > 0) {
    wrap.appendChild(el('div', 'hv3-general-chain', technique.steps.join(' → ')));
  }
  return wrap;
}

/** The POSITIONING panel (design Block 4 right — Tips & Tricks moved to its own full-width
 * section in the 2026-07-14 design update, see renderTips). */
function renderPositioning(positioning) {
  const panel = el('section', 'hv3-panel');
  panel.id = 'positioning';
  panel.appendChild(sectionTitle('POSITIONING', { anchor: '#positioning' }));

  if (positioning.bullets.length === 0) {
    panel.appendChild(emptyRow('Nothing here yet - positioning notes for this class are still being collected.'));
    return panel;
  }
  panel.appendChild(el('p', 'hv3-block-intro', positioning.intro || 'Where to be during a fight:'));
  const list = el('div', 'hv3-bullets');
  for (const bullet of positioning.bullets) {
    if (isGapText(bullet.text)) list.appendChild(gapLine(bullet.text));
    else list.appendChild(bulletRow(bullet.lead, bullet.text));
  }
  panel.appendChild(list);
  return panel;
}

/**
 * The full-width TIPS & TRICKS panel between Matchups and Learn More (2026-07-14 design
 * update): tip bullets flow in a three-column grid. Class-specific tips render first, then
 * the GENERAL separator spanning the grid, then cross-class advice (general-flagged bullets +
 * the universal techniques). — Jasper, 2026-07-14
 */
function renderTips(tips) {
  const panel = el('section', 'hv3-panel');
  panel.id = 'tips';
  panel.appendChild(sectionTitle('TIPS & TRICKS', { anchor: '#tips' }));

  const hasSpecific = tips.bullets.length > 0;
  const hasGeneral = tips.general.bullets.length > 0 || tips.general.techniques.length > 0;

  if (!hasSpecific && !hasGeneral) {
    panel.appendChild(emptyRow('Nothing here yet - tips for this class are still being collected.'));
    return panel;
  }

  const grid = el('div', 'hv3-tips-grid');
  if (hasSpecific) {
    for (const bullet of tips.bullets) {
      if (isGapText(bullet.text)) grid.appendChild(gapLine(bullet.text));
      else grid.appendChild(bulletRow(bullet.lead, bullet.text));
    }
  } else {
    grid.appendChild(emptyRow('No class-specific tips captured yet.'));
  }

  if (hasGeneral) {
    const sep = el('div', 'hv3-general-sep hv3-grid-span');
    sep.appendChild(el('span', 'hv3-general-sep-label', 'GENERAL · APPLIES TO MOST CLASSES'));
    grid.appendChild(sep);
    for (const bullet of tips.general.bullets) {
      if (isGapText(bullet.text)) grid.appendChild(gapLine(bullet.text));
      else grid.appendChild(bulletRow(bullet.lead, bullet.text));
    }
    for (const technique of tips.general.techniques) {
      grid.appendChild(generalTechniqueRow(technique));
    }
  }
  panel.appendChild(grid);
  return panel;
}

// ---- Block 5 · Runes band --------------------------------------------------------------------------------

function renderRunesBand(armorStats, className, armorClassChip) {
  const panel = el('section', 'hv3-panel');
  panel.id = 'runes';
  const armorRunes = armorStats.armorRunes;
  panel.appendChild(sectionTitle('RUNES', { meta: armorRunes?.badge || null, anchor: '#runes' }));

  const introGrid = el('div', 'hv3-runes-intro-grid');

  // -- weapon runes card (class-specific) --
  const weaponCard = el('div', 'hv3-runes-card');
  const weaponHead = el('div', 'hv3-runes-card-head');
  weaponHead.appendChild(el('span', 'hv3-runes-card-title', `Weapon runes · ${className}`));
  weaponHead.appendChild(el('span', 'hv3-badge hv3-badge-gold', 'class-specific'));
  weaponCard.appendChild(weaponHead);
  const weaponRunes = armorStats.weaponRunes;
  if (weaponRunes) {
    // the seasonal class trio, name + verbatim effect per rune (data-provenance season stamp on
    // top — rune sets rotate every season, an undated list is not ground truth).
    if (weaponRunes.seasonLine) weaponCard.appendChild(el('p', 'hv3-runes-season', weaponRunes.seasonLine));
    if (armorStats.runes.note) weaponCard.appendChild(el('p', 'hv3-note', armorStats.runes.note));
    const list = el('div', 'hv3-rune-list');
    for (const item of weaponRunes.items) {
      const row = el('div', 'hv3-rune-row');
      row.appendChild(initialsTile(tileInitials(item.name), 'hv3-tile-sm', true));
      const body = el('div');
      body.appendChild(el('div', 'hv3-set-name', item.name));
      if (item.effect) body.appendChild(el('div', 'hv3-set-desc', item.effect));
      row.appendChild(body);
      list.appendChild(row);
    }
    weaponCard.appendChild(list);
  } else {
    const value =
      typeof armorStats.runes.value === 'string' && armorStats.runes.value.trim() !== ''
        ? armorStats.runes.value
        : 'unknown';
    const valueLine = el('p', 'hv3-runes-value');
    valueLine.appendChild(el('span', value.toLowerCase() === 'unknown' ? 'hv3-unknown' : 'hv3-strong', value));
    if (armorStats.runes.note) valueLine.appendChild(document.createTextNode(` - ${armorStats.runes.note}`));
    weaponCard.appendChild(valueLine);
  }
  if (armorStats.runes.gapNote) weaponCard.appendChild(gapLine(armorStats.runes.gapNote));
  introGrid.appendChild(weaponCard);

  // -- armor runes card (shared across the weight class) --
  const armorCard = el('div', 'hv3-runes-card');
  const armorHead = el('div', 'hv3-runes-card-head');
  armorHead.appendChild(
    el('span', 'hv3-runes-card-title', armorClassChip ? `Armor runes · ${armorClassChip}` : 'Armor runes'),
  );
  if (armorClassChip) {
    armorHead.appendChild(el('span', 'hv3-badge hv3-badge-dim', `shared · all ${armorClassChip.toLowerCase()} classes`));
  }
  armorCard.appendChild(armorHead);
  if (!armorRunes) {
    armorCard.appendChild(emptyRow('Armor rune build not captured yet - needs the runes-guides pass.'));
  } else {
    if (armorRunes.intro) armorCard.appendChild(el('p', 'hv3-runes-intro', armorRunes.intro));
    if (armorRunes.mandatoryNote) armorCard.appendChild(el('p', 'hv3-runes-mandatory', armorRunes.mandatoryNote));
    if (armorRunes.seasonNote) armorCard.appendChild(el('p', 'hv3-note hv3-runes-season-note', armorRunes.seasonNote));
  }
  introGrid.appendChild(armorCard);
  panel.appendChild(introGrid);

  // -- per-slot cards --
  if (armorRunes && Array.isArray(armorRunes.items) && armorRunes.items.length > 0) {
    const slotGrid = el('div', 'hv3-rune-slot-grid');
    for (const item of armorRunes.items) {
      const card = el('div', 'hv3-rune-slot-card');
      const nameRow = el('div', 'hv3-set-name-row');
      nameRow.appendChild(el('span', 'hv3-rune-slot-name', item.slot));
      if (item.updated) nameRow.appendChild(el('span', 'hv3-badge hv3-badge-dim', `UPD ${item.updated}`));
      card.appendChild(nameRow);
      if (item.note) card.appendChild(isGapText(item.note) ? gapLine(item.note) : el('div', 'hv3-set-desc', item.note));
      if (Array.isArray(item.runes) && item.runes.length > 0) {
        const subList = el('div', 'hv3-rune-sublist');
        for (const rune of item.runes) {
          const subRow = el('div', 'hv3-rune-sub');
          const subName = el('div', 'hv3-set-name-row');
          subName.appendChild(el('span', 'hv3-rune-sub-name', rune.name));
          if (rune.mandatory) subName.appendChild(el('span', 'hv3-badge hv3-badge-gold', 'mandatory'));
          subRow.appendChild(subName);
          if (rune.effect) subRow.appendChild(el('div', 'hv3-set-desc', rune.effect));
          subList.appendChild(subRow);
        }
        card.appendChild(subList);
      }
      slotGrid.appendChild(card);
    }
    panel.appendChild(slotGrid);
  }

  return panel;
}

// ---- Block 6 · Builds ---------------------------------------------------------------------------------------

function renderBuilds(builds) {
  const panel = el('section', 'hv3-panel');
  panel.id = 'builds';
  panel.appendChild(sectionTitle('BUILDS', { meta: String(builds.length || ''), anchor: '#builds' }));

  if (builds.length === 0) {
    panel.appendChild(emptyRow('No builds captured for this class yet.'));
    return panel;
  }

  const grid = el('div', 'hv3-build-grid');
  for (const build of builds) {
    const card = el('div', build.recommended ? 'hv3-build-card hv3-build-rec' : 'hv3-build-card');

    const head = el('div', 'hv3-build-head');
    const title = el('div');
    title.appendChild(el('div', 'hv3-build-name', build.name));
    if (build.typeLabel) title.appendChild(el('div', 'hv3-build-type', build.typeLabel.toUpperCase()));
    head.appendChild(title);
    if (build.recommended) {
      const badge = el('span', 'hv3-badge hv3-badge-gold hv3-badge-rec');
      badge.appendChild(icon('star'));
      badge.appendChild(document.createTextNode('recommended'));
      head.appendChild(badge);
    } else if (build.linkedVariantTierLabel) {
      head.appendChild(el('span', 'hv3-badge hv3-badge-dim', build.linkedVariantTierLabel));
    }
    card.appendChild(head);

    if (build.summary) card.appendChild(el('p', 'hv3-build-summary', build.summary));

    const foot = el('div', 'hv3-build-foot');
    if (build.strongVs) {
      const line = el('p', 'hv3-build-foot-line');
      line.appendChild(el('b', 'hv3-strong', 'Strong vs: '));
      line.appendChild(document.createTextNode(build.strongVs));
      foot.appendChild(line);
    }
    if (build.forWhom) {
      const line = el('p', 'hv3-build-foot-line');
      line.appendChild(el('b', 'hv3-strong', 'For: '));
      line.appendChild(document.createTextNode(build.forWhom));
      foot.appendChild(line);
    }
    if (build.altSkill) {
      foot.appendChild(el('div', 'hv3-build-alt-label', 'ALT SKILL'));
      foot.appendChild(el('p', 'hv3-build-foot-line', build.altSkill));
    }
    if (foot.childNodes.length > 0) card.appendChild(foot);

    grid.appendChild(card);
  }
  panel.appendChild(grid);
  return panel;
}

// ---- Block 7 · Matchups --------------------------------------------------------------------------------------

function matchupGroup(headingIcon, headingClass, headingText, cards, cardClass) {
  const col = el('div', 'hv3-mu-col');
  const head = el('div', 'hv3-mu-head');
  head.appendChild(icon(headingIcon, headingClass));
  head.appendChild(el('span', `hv3-mu-head-label ${headingClass}`, headingText));
  head.appendChild(el('span', 'hv3-sec-meta', String(cards.length)));
  col.appendChild(head);

  if (cards.length === 0) {
    col.appendChild(emptyRow('None captured.'));
    return col;
  }
  const list = el('div', 'hv3-mu-list');
  for (const card of cards) {
    const item = el('div', `hv3-mu-card ${cardClass}`);
    const nameRow = el('div', 'hv3-set-name-row');
    nameRow.appendChild(el('span', 'hv3-mu-vs', card.vs));
    if (card.badge) nameRow.appendChild(el('span', 'hv3-badge hv3-badge-dim', String(card.badge).toUpperCase()));
    item.appendChild(nameRow);
    if (card.why) item.appendChild(el('div', 'hv3-mu-why', card.why));
    list.appendChild(item);
  }
  col.appendChild(list);
  return col;
}

function renderMatchups(matchups) {
  const panel = el('section', 'hv3-panel');
  panel.id = 'matchups';
  panel.appendChild(sectionTitle('MATCHUPS', { meta: 'armor-class based', anchor: '#matchups' }));
  const grid = el('div', 'hv3-mu-grid');
  grid.appendChild(matchupGroup('trendUp', 'hv3-green', 'STRONG VS', matchups.strong, 'hv3-mu-strong'));
  grid.appendChild(matchupGroup('trendDown', 'hv3-red', 'WEAK VS', matchups.weak, 'hv3-mu-weak'));
  grid.appendChild(matchupGroup('link', 'hv3-goldc', 'UNIT SYNERGY', matchups.synergy, 'hv3-mu-syn'));
  panel.appendChild(grid);
  return panel;
}

// ---- Block 8 · Learn more --------------------------------------------------------------------------------------

/** The design's three-column Learn More. Always rendered — each column has a designed honest
 * empty state (dashed rows), so absence stays visible instead of the panel vanishing. */
function renderLearnMore(learnMore, className) {
  const panel = el('section', 'hv3-panel');
  panel.id = 'learn-more';
  panel.appendChild(sectionTitle('LEARN MORE', { anchor: '#learn-more' }));
  const grid = el('div', 'hv3-learn-grid');

  // -- column 1: replays & study links --
  const replayCol = el('div', 'hv3-learn-col');
  const replayHead = el('div', 'hv3-learn-col-head');
  replayHead.appendChild(icon('video', 'hv3-goldc'));
  replayHead.appendChild(el('span', 'hv3-learn-col-label', 'REPLAYS & STUDY LINKS'));
  replayCol.appendChild(replayHead);
  if (learnMore.intro) replayCol.appendChild(el('p', 'hv3-note', learnMore.intro));
  if (learnMore.replays.length === 0) {
    replayCol.appendChild(emptyRow('None linked yet - drop replay/VOD links from #Heroes-Forum here.', 'video'));
  } else {
    const list = el('div', 'hv3-learn-list');
    for (const link of learnMore.replays) {
      const row = el('div', 'hv3-learn-row');
      if (link.href) {
        const a = document.createElement('a');
        a.className = 'hv3-clip';
        a.href = link.href;
        a.target = '_blank';
        a.rel = 'noopener';
        a.appendChild(icon('link'));
        a.appendChild(document.createTextNode(link.label));
        row.appendChild(a);
      } else {
        row.appendChild(el('span', 'hv3-clip', link.label));
      }
      if (link.desc) row.appendChild(el('span', 'hv3-set-desc hv3-learn-desc', link.desc));
      list.appendChild(row);
    }
    replayCol.appendChild(list);
  }
  grid.appendChild(replayCol);

  // -- column 2: territory war recordings (no data field yet — honest empty state) --
  const twCol = el('div', 'hv3-learn-col');
  const twHead = el('div', 'hv3-learn-col-head');
  twHead.appendChild(icon('flag', 'hv3-goldc'));
  twHead.appendChild(el('span', 'hv3-learn-col-label', 'TERRITORY WAR RECORDINGS'));
  twCol.appendChild(twHead);
  twCol.appendChild(el('p', 'hv3-note', `TW casts and recordings showing ${className} in organized 15v15 play.`));
  twCol.appendChild(emptyRow('None linked yet - add TW recording links per season.', 'video'));
  grid.appendChild(twCol);

  // -- column 3: who to ask --
  const askCol = el('div', 'hv3-learn-col');
  const askHead = el('div', 'hv3-learn-col-head');
  askHead.appendChild(icon('chat', 'hv3-goldc'));
  askHead.appendChild(el('span', 'hv3-learn-col-label', 'WHO TO ASK'));
  askCol.appendChild(askHead);
  let askHasContent = false;
  if (learnMore.askChannel) {
    const card = el('div', 'hv3-ask-card hv3-ask-primary');
    const chipRow = el('div', 'hv3-ask-name');
    chipRow.appendChild(askChip(learnMore.askChannel));
    card.appendChild(chipRow);
    card.appendChild(el('div', 'hv3-ask-desc', 'Build, rune and matchup questions - fastest answer.'));
    askCol.appendChild(card);
    askHasContent = true;
  }
  for (const author of learnMore.authors) {
    const card = el('div', 'hv3-ask-card');
    card.appendChild(el('div', 'hv3-ask-name', author.name));
    if (author.desc) card.appendChild(el('div', 'hv3-ask-desc', author.desc));
    askCol.appendChild(card);
    askHasContent = true;
  }
  if (!askHasContent) askCol.appendChild(emptyRow('No contacts recorded for this guide.'));
  grid.appendChild(askCol);

  panel.appendChild(grid);
  return panel;
}

// ---- Block 9 · Footer -----------------------------------------------------------------------------------------

function renderFooter(footer) {
  const wrap = el('div', 'hv3-footer');
  const creditRow = el('div', 'hv3-footer-credit');
  if (footer.creditLine) creditRow.appendChild(el('span', 'hv3-footer-mono', footer.creditLine));
  creditRow.appendChild(el('span', 'hv3-eyebrow-line'));
  if (footer.datesLine) creditRow.appendChild(el('span', 'hv3-footer-mono', footer.datesLine));
  wrap.appendChild(creditRow);
  if (footer.philosophyQuote) {
    const quote = el('p', 'hv3-philosophy');
    appendAttributed(quote, `"${footer.philosophyQuote.text}"`, footer.philosophyQuote.attribution);
    wrap.appendChild(quote);
  }
  return wrap;
}

// ---- Page assembly ----------------------------------------------------------------------------------------------

/**
 * Renders the full v3 page model into `root` (cleared first — idempotent). Exported for the DOM
 * tests; boot() below is the page entry.
 */
export function renderHeroPageV3(model, root) {
  root.textContent = '';
  root.appendChild(renderEyebrow(model.seasonLabel));
  root.appendChild(renderHeader(model.header));
  root.appendChild(renderBattleRole(model.battleRole));
  root.appendChild(renderControls(model.controls));
  const mainGrid = el('div', 'hv3-main-grid');
  mainGrid.appendChild(renderArmorStats(model.armorStats));
  mainGrid.appendChild(renderPositioning(model.positioning));
  root.appendChild(mainGrid);
  root.appendChild(renderRunesBand(model.armorStats, model.header.className, model.header.armorClassChip));
  root.appendChild(renderBuilds(model.builds));
  root.appendChild(renderMatchups(model.matchups));
  root.appendChild(renderTips(model.tips));
  root.appendChild(renderLearnMore(model.learnMore, model.header.className));
  root.appendChild(renderFooter(model.footer));
}

/** Fetches one hero record by slug (same URL grammar + result envelope as the v1/v2 boots). */
function fetchHeroRecord(slug) {
  const url = new URL(`${encodeURIComponent(slug)}.json`, HERO_RECORD_DIR_URL).href;
  return fetchJson(withCacheBust(url));
}

/** Fetches the heroes index — only its intro.microcopy philosophy quote is used here. */
function fetchHeroIndexForPhilosophy() {
  const url = new URL('index.json', HERO_RECORD_DIR_URL).href;
  return fetchJson(withCacheBust(url));
}

/** The same footer quote the v1/v2 pages and heroes index use (one consistent voice). */
function pickPhilosophyQuote(indexData) {
  const microcopy = indexData && typeof indexData === 'object' ? indexData.intro?.microcopy : null;
  return microcopy && typeof microcopy.text === 'string' ? microcopy : null;
}

/**
 * Page boot: reads `?h=<slug>`, fetches record + index, renders the v3 page into #hero-v3-page.
 * The v2 (#hero-v2-page) and v1 (#hero-content) trees stay hidden as rollback paths.
 */
export async function boot() {
  const notFoundEl = document.getElementById('hero-not-found');
  const rootEl = document.getElementById('hero-v3-page');
  for (const legacyId of ['hero-v2-page', 'hero-content']) {
    const legacyEl = document.getElementById(legacyId);
    if (legacyEl) legacyEl.hidden = true;
  }

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

  const model = buildHeroPageV3Model(record, pickPhilosophyQuote(indexResult.data));
  if (rootEl) {
    renderHeroPageV3(model, rootEl);
    rootEl.hidden = false;
  }
}
