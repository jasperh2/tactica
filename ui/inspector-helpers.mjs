// ui/inspector-helpers.mjs — pure render-fragment builders for inspector.mjs [ui-inspector]
// No DOM access — role/rarity color data is read from data/roster.json (via ctx.roster) rather
// than duplicated here: roster.roles is the same 8-entry {hex,name} list the handoff README
// lists inline, and roster.rarity is keyed "1".."4" -> {name,color}. Reading it keeps this
// module correct if the seed data ever changes without a matching code edit.
// Kept separate from inspector.mjs to respect the 200-400 line file-size target.

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
  measure: { icon: 'ph-ruler', name: 'Measure', key: 'U' },
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

function rosterTileInner(tab, entry) {
  if (entry.icon) {
    // entry.icon is "assets/units/<CODE>.png", already relative to site/tactics/index.html
    // (the document this panel is mounted into) — no "../" prefix needed.
    return `<img src="${escapeHtml(entry.icon)}" alt="" class="roster-tile-icon" />`;
  }
  return `<span class="roster-tile-code-text">${escapeHtml(entry.code)}</span>`;
}

export function renderRosterTile(tab, entry, isArmed, rarityTable) {
  const rarity = rarityHex(rarityTable, entry.rarity);
  return `
    <button
      type="button"
      class="roster-tile${isArmed ? ' is-armed' : ''}"
      style="border-color:${rarity}"
      data-ref-tab="${escapeHtml(tab)}"
      data-ref-code="${escapeHtml(entry.code)}"
      title="${escapeHtml(entry.name)}"
    >
      <span class="roster-tile-chip" style="background:${rarity}29">
        ${rosterTileInner(tab, entry)}
      </span>
      <span class="roster-tile-name">${escapeHtml(entry.name)}</span>
    </button>
  `;
}

export function renderRosterGrid(tab, entries, armedCode, rarityTable) {
  if (entries.length === 0) {
    return `<div class="inspector-empty">No matches for that search.</div>`;
  }
  const tiles = entries
    .map((entry) => renderRosterTile(tab, entry, entry.code === armedCode, rarityTable))
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

/**
 * @param {{hex:string,name:string}[]} roles roster.roles, README order (Vanguard..Ping)
 * @param {string} activeColor
 * @param {string} [prefix]
 */
export function renderRoleSwatches(roles, activeColor, prefix = 'role') {
  const swatches = roles.map((role) => {
    const isActive = role.hex.toLowerCase() === (activeColor ?? '').toLowerCase();
    return `
      <button
        type="button"
        class="role-swatch${isActive ? ' is-active' : ''}"
        style="background:${role.hex}"
        data-role-hex="${role.hex}"
        title="${escapeHtml(role.name)}"
        aria-label="${escapeHtml(role.name)}"
      ></button>
    `;
  }).join('');
  return `
    <div class="inspector-section">
      <div class="section-label">Role color</div>
      <div class="role-swatch-row" data-swatch-group="${prefix}">
        ${swatches}
        <input type="color" class="role-custom-input" data-role-custom="${prefix}" value="${activeColor ?? '#4c8dff'}" title="Custom color" />
      </div>
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
