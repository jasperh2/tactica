// ui/toolrail.mjs — TACTICA dock tools cluster [ui-inspector / sidebar-v2 S1]
// 12 tool buttons (Select..Erase; Measure removed in v2 — Jasper cut the tool) in the fixed
// TOOLS cluster atop the dock (design
// sidebar-v2 §2a), Phosphor icon + mono shortcut badge, active state. Clicking a tool
// dispatches view/setTool. Keyboard shortcuts themselves belong to the integrator
// (app.mjs) — this module only renders the buttons and handles clicks.
//
// Contract §5: export function mount(el, ctx). Re-render from store.subscribe. Event
// delegation on the panel root. No cross-panel imports, no console.log.

/** @typedef {{id:string, icon:string, key:string, label:string}} ToolDef */

/** @type {ToolDef[]} */
const TOOLS = [
  { id: 'locator', icon: 'ph-cursor-click', key: 'Q', label: 'Pointer' },
  { id: 'select', icon: 'ph-cursor', key: 'V', label: 'Select' },
  { id: 'move', icon: 'ph-arrows-out-cardinal', key: 'G', label: 'Move / Resize' },
  { id: 'pan', icon: 'ph-hand', key: 'H', label: 'Pan' },
  { id: 'place', icon: 'ph-map-pin', key: 'M', label: 'Place Unit' },
  { id: 'arrow', icon: 'ph-arrow-up-right', key: 'A', label: 'Arrow' },
  { id: 'draw', icon: 'ph-pencil-simple', key: 'P', label: 'Draw' },
  { id: 'line', icon: 'ph-line-segment', key: 'L', label: 'Line' },
  { id: 'box', icon: 'ph-square', key: 'R', label: 'Box' },
  { id: 'circle', icon: 'ph-circle', key: 'C', label: 'Circle' },
  { id: 'zone', icon: 'ph-polygon', key: 'Z', label: 'Zone' },
  { id: 'text', icon: 'ph-text-t', key: 'T', label: 'Text' },
  { id: 'erase', icon: 'ph-eraser', key: 'E', label: 'Erase' },
];

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[ch]);
}

function renderButton(tool, activeToolId) {
  const isActive = tool.id === activeToolId;
  return `
    <button
      type="button"
      class="toolrail-btn${isActive ? ' is-active' : ''}"
      data-tool-id="${escapeHtml(tool.id)}"
      title="${escapeHtml(tool.label)} (${escapeHtml(tool.key)})"
      aria-label="${escapeHtml(tool.label)}"
      aria-pressed="${isActive}"
    >
      <i class="ph-bold ${escapeHtml(tool.icon)}" aria-hidden="true"></i>
      <span class="toolrail-badge">${escapeHtml(tool.key)}</span>
    </button>
  `;
}

function render(view) {
  return `
    <div class="section-label toolrail-label">Tools</div>
    <div class="toolrail-grid">${TOOLS.map((tool) => renderButton(tool, view.tool)).join('')}</div>
  `;
}

/**
 * Mounts the dock's fixed TOOLS cluster.
 * @param {HTMLElement} el
 * @param {{store:object, history:object, roster:object, maps:object, exec:Function}} ctx
 */
export function mount(el, ctx) {
  const { store } = ctx;

  el.innerHTML = render(store.getView());

  el.addEventListener('click', (event) => {
    const btn = event.target.closest('.toolrail-btn');
    if (!btn || !el.contains(btn)) return;
    ctx.exec({ type: 'view/setTool', tool: btn.dataset.toolId });
  });

  store.subscribe((doc, view) => {
    el.innerHTML = render(view);
  });
}
