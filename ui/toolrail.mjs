// ui/toolrail.mjs — TACTICA tool rail [ui-inspector]
// 13 tool buttons (Select..Erase), Phosphor icon + mono shortcut badge, active state.
// Clicking a tool dispatches view/setTool. Keyboard shortcuts themselves belong to the
// integrator (app.mjs) — this module only renders the buttons and handles clicks.
//
// Contract §5: export function mount(el, ctx). Re-render from store.subscribe. Event
// delegation on the panel root. No cross-panel imports, no console.log.

/** @typedef {{id:string, icon:string, key:string, label:string}} ToolDef */

/** @type {ToolDef[]} */
const TOOLS = [
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
  { id: 'measure', icon: 'ph-ruler', key: 'U', label: 'Measure' },
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
  return TOOLS.map((tool) => renderButton(tool, view.tool)).join('');
}

/**
 * Mounts the tool rail panel.
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
