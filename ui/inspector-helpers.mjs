// ui/inspector-helpers.mjs — pure render-fragment builders for inspector.mjs [ui-inspector]
// No DOM access — role/rarity color data is read from data/roster.json (via ctx.roster) rather
// than duplicated here: roster.roles is the same 8-entry {hex,name} list the handoff README
// lists inline, and roster.rarity is keyed "1".."4" -> {name,color}. Reading it keeps this
// module correct if the seed data ever changes without a matching code edit.
// Kept separate from inspector.mjs to respect the 200-400 line file-size target (800 hard cap).
import { activeTactic } from '../core/playbook.mjs';

const TOOL_META = {
  select: { icon: 'ph-cursor', name: 'Select', key: 'V' },
  move: { icon: 'ph-arrows-out-cardinal', name: 'Move / Resize', key: 'G' },
  pan: { icon: 'ph-hand', name: 'Pan', key: 'H' },
  place: { icon: 'ph-map-pin', name: 'Place Unit', key: 'M' },
  arrow: { icon: 'ph-arrow-up-right', name: 'Arrow', key: 'A' },
  draw: { icon: 'ph-pencil-simple', name: 'Draw', key: 'P' },
  line: { icon: 'ph-line-segment', name: 'Line', key: 'L' },
  box: { icon: 'ph-square', name: 'Box', key: 'R' },
  circle: { icon: 'ph-circle', name: 'Circle', key: 'C' },
  zone: { icon: 'ph-polygon', name: 'Zone', key: 'Z' },
  text: { icon: 'ph-text-t', name: 'Text', key: 'T' },
  erase: { icon: 'ph-eraser', name: 'Erase', key: 'E' },
};

const LINE_LIKE_TOOLS = new Set(['arrow', 'draw', 'line']);
const SHAPE_TOOLS = new Set(['box', 'circle', 'zone']);

export function toolMeta(toolId) {
  return TOOL_META[toolId] ?? { icon: 'ph-cursor', name: toolId, key: '' };
}

export function isLineLikeTool(toolId) {
  return LINE_LIKE_TOOLS.has(toolId);
}

export function isShapeTool(toolId) {
  return SHAPE_TOOLS.has(toolId);
}

// Sketch-tool shape -> display label, for objectKindLabel below (a placed sketch's `.shape`
// field, not its `kind` — moved here from inspector.mjs alongside objectKindLabel, 200-800
// line file cap).
const SKETCH_SHAPE_LABEL = {
  arrow: 'Arrow',
  line: 'Line',
  free: 'Freehand',
  rect: 'Box',
  ellipse: 'Circle',
};

/** Human label for a placed object's kind (Select/Move panel's object-card header). */
export function objectKindLabel(obj) {
  if (obj.kind === 'unit') return obj.name ?? obj.code;
  if (obj.kind === 'route') return 'Route';
  if (obj.kind === 'sketch') return SKETCH_SHAPE_LABEL[obj.shape] ?? 'Sketch';
  if (obj.kind === 'zone') return 'Zone';
  if (obj.kind === 'text') return 'Text note';
  return obj.kind;
}

/** The generic "Label (optional)" field creation tools (Arrow/Line/Box/Circle/Zone) share. */
export function renderLabelField() {
  return `
    <div class="inspector-section">
      <div class="section-label">Label (optional)</div>
      <input type="text" class="input" data-label-input data-field="create-label" placeholder="Applies to the next created object…" />
    </div>
  `;
}

export function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[ch]);
}

/** @param {object} rarityTable roster.rarity, keyed "1".."4" @param {number} tier */
export function rarityHex(rarityTable, tier) {
  return rarityTable[tier]?.color ?? rarityTable[1]?.color ?? '#46c46e';
}

/** @param {object} rarityTable roster.rarity, keyed "1".."4" @param {number} tier */
export function rarityName(rarityTable, tier) {
  return rarityTable[tier]?.name ?? rarityTable[1]?.name ?? 'Uncommon';
}

/**
 * Given a roster entry from any of the 4 tabs, returns display fields normalized across
 * shapes (units have class/leadership/tier, heroes have weapon/style, artillery has
 * type/range, extra has desc only — no stat chips).
 * @param {string} tab
 * @param {object} entry
 */
export function normalizeEntry(tab, entry) {
  if (tab === 'units') {
    return {
      statChips: [
        { label: 'CLASS', value: entry.class },
        { label: 'LEAD', value: String(entry.leadership) },
        { label: 'TIER', value: `T${entry.tier}` },
      ],
      strongVs: entry.strongVs,
      weakVs: entry.weakVs,
    };
  }
  if (tab === 'heroes') {
    return {
      statChips: [
        { label: 'WEAPON', value: entry.weapon },
        { label: 'STYLE', value: entry.style },
      ],
      strongVs: entry.strongVs,
      weakVs: entry.weakVs,
    };
  }
  if (tab === 'artillery') {
    return {
      statChips: [
        { label: 'TYPE', value: entry.type },
        { label: 'RANGE', value: entry.range },
      ],
      strongVs: null,
      weakVs: null,
    };
  }
  // extra: no stat chips, no strong/weak — just a description
  return { statChips: [], strongVs: null, weakVs: null, desc: entry.desc };
}

/**
 * Filters a roster tab's entries by the live search query against name + code.
 * @param {object[]} entries
 * @param {string} query
 */
export function filterRoster(entries, query) {
  const q = query.trim().toLowerCase();
  if (!q) return entries;
  return entries.filter(
    (entry) => entry.name.toLowerCase().includes(q) || entry.code.toLowerCase().includes(q)
  );
}

// ---------------------------------------------------------------------------
// Sort control (Jasper bug 3, ruling 2026-07-05) — default sort is rarity DESCENDING
// (the roster's "rarity" int 1-4 field — NEVER the separate "tier" field); the second mode
// buckets Units by gameClass into exactly 3 groups (melee/ranged/cavalry, no pike/special 4th
// bucket per the same-day ruling: "no pike is not a 4th bucket neither is special just do
// melee ranged cavalry"). Heroes/artillery/extra have no gameClass and always sort by rarity,
// in both sort modes — the Units tab is the only one type mode applies to (inspector.mjs only
// ever calls sortRosterEntries(entries, 'type') when tab === 'units').
// ---------------------------------------------------------------------------

/** @typedef {'rarity'|'type'} SortMode */

// gameClass string -> bucket id. "Pike/Polearm Infantry" folds into 'melee' (anti-cav gameplay
// role, but the ruling explicitly rejected giving it — or a "special" catch-all — its own
// bucket). Any gameClass not listed here (including undefined, for heroes/artillery/extra)
// yields no bucket at all, rather than inventing a 4th/5th bucket.
const TYPE_BUCKET_BY_GAME_CLASS = {
  'Melee Infantry': 'melee',
  'Pike/Polearm Infantry': 'melee',
  'Ranged Infantry': 'ranged',
  Cavalry: 'cavalry',
};

// Display order for type mode's bucket headers (melee -> ranged -> cavalry).
const TYPE_BUCKET_ORDER = ['melee', 'ranged', 'cavalry'];

/**
 * The type-sort bucket id for a single roster entry, or null if the entry has no gameClass
 * (heroes/artillery/extra) or an unrecognized gameClass value (defensive — never fabricates a
 * new bucket for an unexpected string).
 * @param {{gameClass?:string}} entry
 * @returns {'melee'|'ranged'|'cavalry'|null}
 */
export function bucketForEntry(entry) {
  return TYPE_BUCKET_BY_GAME_CLASS[entry.gameClass] ?? null;
}

/**
 * Comparator for two roster entries. Sorts strictly by the `rarity` int field descending
 * (Legendary=4 first, Uncommon=1 last) — NEVER reads `tier`, a different field units also
 * carry — tiebreaking by name ascending. This is the whole order for 'rarity' mode, and also
 * the within-bucket order for 'type' mode (sortRosterEntries groups by bucket first, then
 * applies this same rule inside each group), so one comparator body serves both call sites;
 * the `mode` param exists only so call sites read intent-first rather than needing a comment.
 * @param {{name:string, rarity:number}} a
 * @param {{name:string, rarity:number}} b
 * @param {SortMode} [mode] documentation-only — the comparison itself does not vary by mode
 * @returns {number}
 */
export function compareRosterEntries(a, b, mode = 'rarity') {
  void mode;
  if (a.rarity !== b.rarity) return b.rarity - a.rarity;
  return a.name.localeCompare(b.name);
}

/**
 * Sorts a roster tab's entries for display. In 'rarity' mode, returns a flat list ordered
 * rarity-desc/name-asc (no bucket annotation) — this is the ONLY mode heroes/artillery/extra
 * ever use, since they have no gameClass. In 'type' mode, entries are grouped into the 3
 * melee/ranged/cavalry buckets (order: melee, ranged, cavalry), each internally sorted
 * rarity-desc/name-asc, and every returned entry carries a `bucket` field so the renderer can
 * emit section headers; entries with no resolvable bucket (no gameClass) are silently dropped
 * from 'type' mode output — callers only invoke 'type' for the Units tab, where every entry
 * has a gameClass, so in practice nothing is lost.
 * @param {object[]} entries
 * @param {SortMode} mode
 * @returns {object[]}
 */
export function sortRosterEntries(entries, mode) {
  if (mode !== 'type') {
    return [...entries].sort((a, b) => compareRosterEntries(a, b, 'rarity'));
  }

  const byBucket = new Map(TYPE_BUCKET_ORDER.map((b) => [b, []]));
  for (const entry of entries) {
    const bucket = bucketForEntry(entry);
    if (!bucket) continue; // no gameClass — excluded from type-mode output (see docstring)
    byBucket.get(bucket).push({ ...entry, bucket });
  }

  return TYPE_BUCKET_ORDER.flatMap((bucket) =>
    byBucket.get(bucket).sort((a, b) => compareRosterEntries(a, b, 'rarity'))
  );
}

/** Renders the 4-tier legend in fixed Legendary→Uncommon display order (README order). */
export function renderRarityLegend(rarityTable) {
  const displayOrder = [4, 3, 2, 1].filter((tier) => rarityTable[tier]);
  const swatches = displayOrder
    .map((tier) => {
      const r = rarityTable[tier];
      return `
      <span class="rarity-legend-item">
        <span class="rarity-dot" style="background:${r.color}"></span>${escapeHtml(r.name)}
      </span>`;
    })
    .join('');
  return `<div class="rarity-legend">${swatches}</div>`;
}

function rosterTileInner(tab, entry, rarity) {
  if (entry.icon) {
    // entry.icon is "assets/units/<CODE>.png", already relative to site/tactics/index.html
    // (the document this panel is mounted into) — no "../" prefix needed.
    return `<img src="${escapeHtml(entry.icon)}" alt="" class="roster-tile-icon" />`;
  }
  // Coded tile (mission item 7): rarity-colored code text on a solid dark well, matching the
  // mockup's own coded-tile treatment (rgba border + rarity-hex text on #12151b) rather than
  // the light rarity-tint chip background icon-bearing tiles use — the tint reads correctly
  // behind a real image but washes out flat monospace code text.
  return `<span class="roster-tile-code-text" style="color:${rarity}">${escapeHtml(entry.code)}</span>`;
}

/**
 * Mission item 7 / CHANGES-sidebar-v2.md §5 Open items: "48 real unit icon PNGs replace the
 * striped placeholder wells; 8 coded tiles (e.g. CC, VG) keep the dashed treatment until art
 * lands." The mockup's OTHER units also show a striped repeating-linear-gradient chip, but
 * that's the Design prototype's own placeholder for every tile (it has no real image loading) —
 * in the real roster 48/56 units already carry a real `icon` path, so the striped look does not
 * apply here. Only entries with NO icon at all (8 units, plus some heroes/artillery) get the
 * dashed-border "coded tile" treatment; every icon-bearing entry renders exactly as before.
 * @param {object} entry
 */
export function isCodedTile(entry) {
  return !entry.icon;
}

export function renderRosterTile(tab, entry, isArmed, rarityTable) {
  const rarity = rarityHex(rarityTable, entry.rarity);
  const coded = isCodedTile(entry);
  // Coded tiles get the mockup's solid dark well (--bg-well, via the .roster-tile-chip.is-coded
  // CSS rule) instead of the light rarity-tint icon-bearing tiles use — set via a class, not an
  // inline override, so it still routes through the light/dark token.
  const chipClass = coded ? ' is-coded' : '';
  const chipStyle = coded ? '' : ` style="background:${rarity}29"`;
  return `
    <button
      type="button"
      class="roster-tile${isArmed ? ' is-armed' : ''}${coded ? ' is-coded' : ''}"
      style="border-color:${rarity}"
      data-ref-tab="${escapeHtml(tab)}"
      data-ref-code="${escapeHtml(entry.code)}"
      title="${escapeHtml(entry.name)}${coded ? ' — coded tile, no icon art yet' : ''}"
    >
      <span class="roster-tile-chip${chipClass}"${chipStyle}>
        ${rosterTileInner(tab, entry, rarity)}
      </span>
      <span class="roster-tile-name">${escapeHtml(entry.name)}</span>
    </button>
  `;
}

// Display labels for the type-sort buckets (mission item 6: "Render bucket headers in type
// mode"). Keys match TYPE_BUCKET_BY_GAME_CLASS's/TYPE_BUCKET_ORDER's bucket ids exactly.
const BUCKET_HEADER_LABEL = {
  melee: 'Melee',
  ranged: 'Ranged',
  cavalry: 'Cavalry',
};

/**
 * @param {string} tab
 * @param {object[]} entries roster entries, optionally carrying a `bucket` field
 *   (sortRosterEntries(..., 'type') output) — when present, a header row is inserted before
 *   the first tile of each new bucket. Entries with no `bucket` field (rarity mode, or every
 *   non-Units tab) render exactly as before this feature — zero headers.
 * @param {string|null} armedCode
 * @param {object} rarityTable
 */
export function renderRosterGrid(tab, entries, armedCode, rarityTable) {
  if (entries.length === 0) {
    return `<div class="inspector-empty">No matches for that search.</div>`;
  }
  let lastBucket = undefined;
  const tiles = entries
    .map((entry) => {
      const header = entry.bucket && entry.bucket !== lastBucket
        ? `<div class="roster-bucket-header">${escapeHtml(BUCKET_HEADER_LABEL[entry.bucket] ?? entry.bucket)}</div>`
        : '';
      lastBucket = entry.bucket ?? lastBucket;
      return header + renderRosterTile(tab, entry, entry.code === armedCode, rarityTable);
    })
    .join('');
  return `<div class="roster-grid">${tiles}</div>`;
}

export function renderStatChips(statChips) {
  if (!statChips.length) return '';
  return `
    <div class="armed-stat-row">
      ${statChips
        .map(
          (c) => `<span class="chip chip-mono chip-neutral">${escapeHtml(c.label)} ${escapeHtml(c.value)}</span>`
        )
        .join('')}
    </div>
  `;
}

export function renderMatchupChips(strongVs, weakVs) {
  if (!strongVs && !weakVs) return '';
  const strong = strongVs
    ? `<span class="chip matchup-chip matchup-strong"><i class="ph-bold ph-trend-up" aria-hidden="true"></i>Strong vs ${escapeHtml(strongVs)}</span>`
    : '';
  const weak = weakVs
    ? `<span class="chip matchup-chip matchup-weak"><i class="ph-bold ph-trend-down" aria-hidden="true"></i>Weak vs ${escapeHtml(weakVs)}</span>`
    : '';
  return `<div class="armed-matchup-row">${strong}${weak}</div>`;
}

/** Armed-unit card (Place panel, mission item 8) — moved here from inspector.mjs (200-800
 * line file cap) since it only calls functions already native to this module. */
export function renderArmedCard(tab, entry, rarityTable) {
  const info = normalizeEntry(tab, entry);
  const rarity = rarityHex(rarityTable, entry.rarity);
  return `
    <div class="armed-card">
      <div class="armed-card-top">
        <span class="armed-code-chip" style="background:${rarity}29;color:${rarity}">${escapeHtml(entry.code)}</span>
        <div class="armed-card-titles">
          <div class="armed-card-name">${escapeHtml(entry.name)}</div>
          <span class="rarity-pill" style="color:${rarity};border-color:${rarity}4d">${escapeHtml(rarityName(rarityTable, entry.rarity))}</span>
        </div>
        <button type="button" class="btn-icon armed-disarm" data-action="disarm" title="Disarm" aria-label="Disarm">
          <i class="ph-bold ph-x" aria-hidden="true"></i>
        </button>
      </div>
      ${renderStatChips(info.statChips)}
      ${renderMatchupChips(info.strongVs, info.weakVs)}
      ${info.desc ? `<div class="armed-desc">${escapeHtml(info.desc)}</div>` : ''}
    </div>
  `;
}

/**
 * @param {{hex:string,name:string}[]} roles roster.roles, README order (Vanguard..Ping)
 * @param {string} activeColor
 * @param {string} [prefix]
 * @param {{showCurrentName?:boolean}} [opts] showCurrentName renders the current role's name
 *   beside the section label (design 1a §9 "ROLE COLOR" row) — off by default so the 3
 *   pre-existing call sites (select/create/text) render exactly as before.
 */
export function renderRoleSwatches(roles, activeColor, prefix = 'role', opts = {}) {
  const activeRole = roles.find((r) => r.hex.toLowerCase() === (activeColor ?? '').toLowerCase());
  const swatches = roles.map((role) => {
    const isActive = role.hex.toLowerCase() === (activeColor ?? '').toLowerCase();
    const check = isActive ? '<i class="ph-bold ph-check role-swatch-check" aria-hidden="true"></i>' : '';
    return `
      <button
        type="button"
        class="role-swatch${isActive ? ' is-active' : ''}"
        style="background:${role.hex}"
        data-role-hex="${role.hex}"
        title="${escapeHtml(role.name)}"
        aria-label="${escapeHtml(role.name)}"
      >${check}</button>
    `;
  }).join('');
  const currentName = opts.showCurrentName && activeRole
    ? `<span class="role-current-name"><span class="role-current-dot" style="background:${activeRole.hex}"></span>${escapeHtml(activeRole.name)}</span>`
    : '';
  return `
    <div class="inspector-section">
      <div class="section-label-row">
        <div class="section-label">Role color</div>
        ${currentName}
      </div>
      <div class="role-swatch-row" data-swatch-group="${prefix}">
        ${swatches}
        <input type="color" class="role-custom-input" data-role-custom="${prefix}" value="${activeColor ?? '#4c8dff'}" title="Custom color" />
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Self-contained tool-panel bodies (no ctx/store access) — moved here from inspector.mjs
// (200-800 line file cap). Each only needs doc/view/roster, exactly like this module's other
// render helpers.
// ---------------------------------------------------------------------------

/** Select/Move panel's multi-select summary card. */
export function renderMultiSelectPanel(count) {
  return `
    <div class="inspector-content">
      <div class="object-card">
        <div class="object-card-top">
          <span class="object-card-kind">${count} objects selected</span>
          <button type="button" class="btn-icon" data-action="delete-object" title="Delete all" aria-label="Delete selected objects">
            <i class="ph-bold ph-trash" aria-hidden="true"></i>
          </button>
        </div>
      </div>
      <div class="inspector-empty">Drag any selected unit to move the whole group. Drag the group handle to resize.</div>
    </div>
  `;
}

/** Live per-kind counts on the active tactic, for the Erase panel's category rows. */
export function objectCountsByKind(doc) {
  const tactic = activeTactic(doc);
  const counts = {};
  for (const obj of tactic?.objects ?? []) {
    counts[obj.kind] = (counts[obj.kind] ?? 0) + 1;
  }
  return counts;
}

export function renderErasePanel(doc) {
  const tactic = activeTactic(doc);
  const count = tactic?.objects.length ?? 0;
  return `
    <div class="inspector-content">
      <div class="inspector-empty">Click an object on the map to delete it.</div>
      <div class="section-label">Clear by category</div>
      <div class="erase-category-list">${renderEraseCategories(objectCountsByKind(doc))}</div>
      <button type="button" class="btn btn-danger" data-action="clear-placed" ${count === 0 ? 'disabled' : ''}>
        <i class="ph-bold ph-trash" aria-hidden="true"></i> Clear all (${count})
      </button>
      <div class="erase-undo-hint"><i class="ph ph-arrow-counter-clockwise" aria-hidden="true"></i>Every clear is undoable.</div>
    </div>
  `;
}

export function renderPanPanel() {
  return `
    <div class="inspector-content">
      <div class="inspector-empty">Drag the map to pan, or hold Space in any tool.</div>
    </div>
  `;
}

/** Pinned-bottom frame-notes textarea (present in every tool's panel). */
export function renderFrameNotes(doc, view) {
  const tactic = activeTactic(doc);
  const kf = view.currentKeyframe;
  const kfDef = tactic?.keyframes.find((k) => k.n === kf);
  const note = tactic?.notes?.[kf] ?? '';
  return `
    <div class="inspector-notes">
      <div class="inspector-notes-head">
        <span class="section-label">Frame notes</span>
        <span class="chip chip-mono chip-neutral">KF${kf} · ${escapeHtml(kfDef?.name ?? '')}</span>
      </div>
      <textarea class="input textarea notes-textarea" data-notes-input data-field="frame-notes" rows="3" placeholder="What happens on this keyframe…">${escapeHtml(note)}</textarea>
      <div class="inspector-notes-hint">Ships in the .zip</div>
    </div>
  `;
}

export function fmtCoord(n) {
  return Number(n).toFixed(1);
}

/** @param {{x:number,y:number}} xy */
export function fmtCoordPair(xy) {
  return `${fmtCoord(xy.x)}, ${fmtCoord(xy.y)}`;
}

// ---------------------------------------------------------------------------
// Sort control (mission item 6) — 2-mode segmented control, Rarity (default) | Type.
// ---------------------------------------------------------------------------

const SORT_MODES = [
  { id: 'rarity', label: 'Rarity' },
  { id: 'type', label: 'Type' },
];

/**
 * Renders the Unit options panel's sort-mode segmented control (rarity-desc default vs.
 * type-bucketed). Reuses the existing .segmented/.segmented-btn classes (same visual family as
 * the Arrow tool's arrowhead control) rather than inventing a new control style.
 * @param {'rarity'|'type'} sortMode
 */
export function renderSortControl(sortMode) {
  const buttons = SORT_MODES.map(
    (m) => `<button type="button" class="segmented-btn${m.id === sortMode ? ' is-active' : ''}" data-sort-mode="${m.id}">${escapeHtml(m.label)}</button>`
  ).join('');
  return `
    <div class="inspector-section">
      <div class="section-label">Sort</div>
      <div class="segmented" data-segmented="sort">${buttons}</div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Generic slider + typed-value row (CHANGES-sidebar-v2.md §1 G5: "every numeric control =
// slider + typed value with unit"). Both inputs share one data-slider/data-slider-typed key so
// inspector.mjs's event wiring can dispatch the same action from either control.
// ---------------------------------------------------------------------------

/**
 * @param {{label:string, dataKey:string, min:number, max:number, value:number, unit:string}} opts
 */
export function renderSliderWithValue({ label, dataKey, min, max, value, unit }) {
  const key = escapeHtml(dataKey);
  const ariaLabel = `${label}, ${min} to ${max}${unit ? ` ${unit}` : ''}`;
  return `
    <div class="slider-row">
      <span class="slider-row-label">${escapeHtml(label)}</span>
      <input type="range" class="slider" aria-label="${escapeHtml(ariaLabel)}" data-slider="${key}" min="${min}" max="${max}" value="${value}" />
      <span class="slider-typed-wrap">
        <input type="text" inputmode="numeric" class="input slider-typed-input" aria-label="${escapeHtml(`${label}, typed value`)}" data-slider-typed="${key}" data-min="${min}" data-max="${max}" value="${value}" />
        ${unit ? `<span class="slider-typed-unit">${escapeHtml(unit)}</span>` : ''}
      </span>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// LABEL — NEXT PLACEMENT — 3x3 compass position grid (mission item 11: "8 compass positions
// grid incl. center"). Grid is emitted row-major NW..SE with center in the middle slot,
// matching the mockup's visual layout exactly (design 1a, position picker).
// ---------------------------------------------------------------------------

/** @type {{id:string, label:string, short:string}[]} */
export const LABEL_POSITIONS = [
  { id: 'NW', label: 'North-west', short: 'NW' },
  { id: 'N', label: 'North', short: 'N' },
  { id: 'NE', label: 'North-east', short: 'NE' },
  { id: 'W', label: 'West', short: 'W' },
  { id: 'center', label: 'Center — on the marker', short: '' },
  { id: 'E', label: 'East', short: 'E' },
  { id: 'SW', label: 'South-west', short: 'SW' },
  { id: 'S', label: 'South', short: 'S' },
  { id: 'SE', label: 'South-east', short: 'SE' },
];

/** @param {string} activePosition one of LABEL_POSITIONS[].id */
export function renderLabelPositionGrid(activePosition) {
  const cells = LABEL_POSITIONS.map((pos) => {
    const isActive = pos.id === activePosition;
    const inner = pos.id === 'center'
      ? '<span class="label-position-center-dot" aria-hidden="true"></span>'
      : escapeHtml(pos.short);
    return `<button type="button" class="label-position-btn${isActive ? ' is-active' : ''}" data-position="${pos.id}" title="${escapeHtml(pos.label)}">${inner}</button>`;
  }).join('');
  return `<div class="label-position-grid" data-label-position-grid>${cells}</div>`;
}

/**
 * LABEL — NEXT PLACEMENT block (mission item 11): text, background toggle, size, 3x3 compass.
 * Moved here from inspector.mjs (200-800 line file cap) — min/max are passed in rather than
 * read from inspector.mjs's local consts, keeping this module free of a reverse dependency.
 * @param {{text:string, background:boolean, size:number, position:string}} nextLabel
 * @param {{minSize:number, maxSize:number}} bounds
 */
export function renderNextLabelBlock(nextLabel, { minSize, maxSize }) {
  return `
    <div class="next-label-block">
      <div class="section-label">Label — next placement</div>
      <input type="text" class="input" data-field="next-label-text" data-next-label-text placeholder="Label text (player name…)" value="${escapeHtml(nextLabel.text)}" />
      <div class="toggle-row-split">
        <span>Background</span>
        <button type="button" class="toggle-switch${nextLabel.background ? ' is-on' : ''}" data-action="toggle-label-bg" role="switch" aria-checked="${nextLabel.background}" aria-label="Background: ${nextLabel.background ? 'on' : 'off'}">
          <span class="toggle-switch-track"><span class="toggle-switch-onlabel">${nextLabel.background ? 'ON' : ''}</span><span class="toggle-switch-knob"></span></span>
        </button>
      </div>
      ${renderSliderWithValue({ label: 'Label size', dataKey: 'labelSize', min: minSize, max: maxSize, value: nextLabel.size, unit: 'px' })}
      <div class="label-position-row">
        <span class="label-position-caption">Position</span>
        ${renderLabelPositionGrid(nextLabel.position)}
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Erase — clear by category (mission: "per-category clear buttons with live counts, each
// undoable"). The 5 categories mirror playbook.mjs's buildPlaybook object-kind split exactly
// (unit/route/sketch/zone/text) — see that module's markers/routes/sketches/zones/textNotes
// filter-by-kind grouping, which this intentionally matches so "category" means the same thing
// everywhere in the codebase.
// ---------------------------------------------------------------------------

/** @type {{kind:string, label:string, icon:string}[]} */
export const ERASE_CATEGORIES = [
  { kind: 'unit', label: 'Units', icon: 'ph-map-pin' },
  { kind: 'route', label: 'Routes', icon: 'ph-arrow-up-right' },
  { kind: 'sketch', label: 'Sketches', icon: 'ph-pencil-simple' },
  { kind: 'zone', label: 'Zones', icon: 'ph-polygon' },
  { kind: 'text', label: 'Text', icon: 'ph-text-t' },
];

/**
 * @param {Record<string, number>} counts kind -> live count on the active tactic; a category
 *   missing from this map renders as 0 (design note: "counts also read at zero").
 */
export function renderEraseCategories(counts) {
  return ERASE_CATEGORIES.map((cat) => {
    const count = counts[cat.kind] ?? 0;
    return `
      <div class="erase-category-row">
        <i class="ph ${escapeHtml(cat.icon)}" aria-hidden="true"></i>
        <span class="erase-category-label">${escapeHtml(cat.label)}</span>
        <span class="chip chip-mono chip-neutral" data-clear-kind="${cat.kind}">${count}</span>
        <button type="button" class="btn-clear-category" data-action="clear-kind" data-kind="${cat.kind}" ${count === 0 ? 'disabled' : ''}>Clear</button>
      </div>
    `;
  }).join('');
}
