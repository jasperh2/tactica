// ui/inspector.mjs — TACTICA contextual inspector [ui-inspector]
// Content swaps per view.tool (contract §5 / handoff README §5). Rebuilds innerHTML from
// state on every store change; event delegation on the panel root. No cross-panel imports.
//
// Text-note editing + zone labels both go through doc/setObjectProps (core/store.mjs), a
// single whitelisted action for the small set of kind-specific editable props that don't
// warrant their own doc/* action (TextNote text/size/chip; Zone label — contract §3). The
// text panel dispatches it when an existing text object is selected (editingTextNote());
// the select/move panel dispatches it for a selected zone's label field. Both are debounced
// 300ms like the existing frame-notes textarea.

import { activeTactic, positionAt } from '../core/playbook.mjs';
import {
  toolMeta,
  isLineLikeTool,
  isShapeTool,
  escapeHtml,
  normalizeEntry,
  filterRoster,
  renderRarityLegend,
  renderRosterGrid,
  renderStatChips,
  renderMatchupChips,
  renderRoleSwatches,
  rarityHex,
  rarityName,
  fmtCoordPair,
} from './inspector-helpers.mjs';

const NOTE_DEBOUNCE_MS = 300;
const MIN_MARKER_SIZE = 16;
const MAX_MARKER_SIZE = 54;
const MIN_TEXT_SIZE = 8;
const MAX_TEXT_SIZE = 40;
const MIN_THICKNESS = 1;
const MAX_THICKNESS = 10;

function header(toolId) {
  const meta = toolMeta(toolId);
  return `
    <div class="inspector-header">
      <div class="inspector-header-tile"><i class="ph-bold ${escapeHtml(meta.icon)}" aria-hidden="true"></i></div>
      <div class="inspector-header-text">
        <div class="inspector-header-name">${escapeHtml(meta.name)}</div>
        <div class="inspector-header-hint">Panel follows the active tool</div>
      </div>
      <span class="chip chip-mono chip-neutral inspector-header-key">${escapeHtml(meta.key)}</span>
    </div>
  `;
}

// ---- Place tool --------------------------------------------------------------

function findObject(tactic, id) {
  return tactic?.objects.find((o) => o.id === id) ?? null;
}

/**
 * The selected text object, IF the text tool is active and the current selection resolves to
 * a `kind:'text'` object — i.e. exactly the "editing existing note" state renderTextToolPanel
 * computes for display. Re-derived fresh from live store state in event handlers (same style
 * as applyRoleColor's isTransformContext) rather than threaded through as DOM dataset state.
 * @param {{getDoc:Function, getView:Function}} store
 * @returns {object|null}
 */
function editingTextNote(store) {
  const view = store.getView();
  if (view.tool !== 'text' || !view.selection) return null;
  const tactic = activeTactic(store.getDoc());
  const obj = findObject(tactic, view.selection);
  return obj?.kind === 'text' ? obj : null;
}

function rosterEntriesForTab(roster, tab) {
  return roster[tab] ?? [];
}

function findRosterEntry(roster, tab, code) {
  return rosterEntriesForTab(roster, tab).find((e) => e.code === code) ?? null;
}

function renderArmedCard(tab, entry, rarityTable) {
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

function renderPlacePanel(doc, view, roster) {
  const activeLayer = doc.layers.find((l) => l.id === view.activeLayerId);
  const tab = view.rosterTab;
  const entries = filterRoster(rosterEntriesForTab(roster, tab), view.query);
  const armedCode = view.armedUnit?.code ?? null;

  const tabs = ['units', 'heroes', 'artillery', 'extra'].map(
    (t) => `
      <button type="button" class="roster-tab${t === tab ? ' is-active' : ''}" data-tab="${t}">
        ${escapeHtml(t[0].toUpperCase() + t.slice(1))}
      </button>`
  ).join('');

  return `
    <div class="inspector-content">
      <div class="place-hint-chip">New units → ${escapeHtml(activeLayer?.name ?? '—')}</div>
      <div class="roster-tabs">${tabs}</div>
      <input type="text" class="input roster-search" data-field="roster-search" placeholder="Search name or code…" value="${escapeHtml(view.query)}" />
      ${renderRarityLegend(roster.rarity)}
      ${renderRosterGrid(tab, entries, armedCode, roster.rarity)}
      ${view.armedUnit ? renderArmedCard(tab, view.armedUnit.entry, roster.rarity) : ''}
    </div>
  `;
}

// ---- Select / Move tool -------------------------------------------------------

const SKETCH_SHAPE_LABEL = {
  arrow: 'Arrow',
  line: 'Line',
  free: 'Freehand',
  rect: 'Box',
  ellipse: 'Circle',
};

function objectKindLabel(obj) {
  if (obj.kind === 'unit') return obj.name ?? obj.code;
  if (obj.kind === 'route') return 'Route';
  if (obj.kind === 'sketch') return SKETCH_SHAPE_LABEL[obj.shape] ?? 'Sketch';
  if (obj.kind === 'zone') return 'Zone';
  if (obj.kind === 'text') return 'Text note';
  return obj.kind;
}

function renderSelectPanel(doc, view, roster) {
  const tactic = activeTactic(doc);
  const obj = view.selection ? findObject(tactic, view.selection) : null;

  if (!obj) {
    return `
      <div class="inspector-content">
        <div class="inspector-empty">
          Click an object on the map to select it. Drag to move it once selected.
        </div>
      </div>
    `;
  }

  const isUnit = obj.kind === 'unit';
  const sizeRow = isUnit
    ? `
      <div class="inspector-section">
        <div class="section-label">Size</div>
        <input type="range" class="slider" data-slider="size" min="${MIN_MARKER_SIZE}" max="${MAX_MARKER_SIZE}" value="${obj.size}" />
        <div class="slider-value chip-mono">${obj.size}px</div>
      </div>
    `
    : '';

  // Zones get an optional label (contract §5, buildPlaybook's zoneEntry exports it when
  // present) — edits go through doc/setObjectProps, same seam as text-note editing.
  const zoneLabelRow = obj.kind === 'zone'
    ? `
      <div class="inspector-section">
        <div class="section-label">Label (optional)</div>
        <input type="text" class="input" data-zone-label-input data-field="zone-label" placeholder="e.g. Hold line" value="${escapeHtml(obj.label ?? '')}" />
      </div>
    `
    : '';

  return `
    <div class="inspector-content">
      <div class="object-card">
        <div class="object-card-top">
          <span class="object-card-kind">${escapeHtml(objectKindLabel(obj))}</span>
          <button type="button" class="btn-icon" data-action="delete-object" title="Delete" aria-label="Delete object">
            <i class="ph-bold ph-trash" aria-hidden="true"></i>
          </button>
        </div>
      </div>
      ${sizeRow}
      ${zoneLabelRow}
      ${renderRoleSwatches(roster.roles, obj.role, 'select')}
    </div>
  `;
}

// ---- Line-like tools (arrow/draw/line) ----------------------------------------

function renderLineToolPanel(toolId, view, roster) {
  const opts = view.toolOptions;
  const headRow = toolId === 'arrow'
    ? `
      <div class="inspector-section">
        <div class="section-label">Arrowhead</div>
        <div class="segmented" data-segmented="head">
          ${['solid', 'open', 'none']
            .map(
              (h) => `<button type="button" class="segmented-btn${opts.head === h ? ' is-active' : ''}" data-value="${h}">${h[0].toUpperCase()}${h.slice(1)}</button>`
            )
            .join('')}
        </div>
      </div>
    `
    : '';

  return `
    <div class="inspector-content">
      <div class="inspector-section">
        <div class="section-label">Thickness</div>
        <input type="range" class="slider" data-slider="thickness" min="${MIN_THICKNESS}" max="${MAX_THICKNESS}" value="${opts.thickness}" />
        <div class="slider-value chip-mono">${opts.thickness}px</div>
      </div>
      <label class="toggle-row">
        <input type="checkbox" data-toggle="dashed" ${opts.dashed ? 'checked' : ''} />
        <span>Dashed</span>
      </label>
      ${headRow}
      ${renderRoleSwatches(roster.roles, view.roleColor, 'create')}
      ${renderLabelField()}
    </div>
  `;
}

// ---- Shape tools (box/circle/zone) --------------------------------------------

function renderShapeToolPanel(view, roster) {
  const opts = view.toolOptions;
  return `
    <div class="inspector-content">
      <div class="inspector-section">
        <div class="section-label">Fill opacity</div>
        <input type="range" class="slider" data-slider="fillOpacity" min="0" max="100" value="${opts.fillOpacity}" />
        <div class="slider-value chip-mono">${opts.fillOpacity}%</div>
      </div>
      <div class="inspector-section">
        <div class="section-label">Border width</div>
        <input type="range" class="slider" data-slider="border" min="0" max="10" value="${opts.border}" />
        <div class="slider-value chip-mono">${opts.border}px</div>
      </div>
      <label class="toggle-row">
        <input type="checkbox" data-toggle="dashed" ${opts.dashed ? 'checked' : ''} />
        <span>Dashed</span>
      </label>
      ${renderRoleSwatches(roster.roles, view.roleColor, 'create')}
      ${renderLabelField()}
    </div>
  `;
}

// ---- Text tool -----------------------------------------------------------------

function renderTextToolPanel(doc, view, roster) {
  const tactic = activeTactic(doc);
  const selected = view.selection ? findObject(tactic, view.selection) : null;
  const editingExisting = selected?.kind === 'text' ? selected : null;
  const opts = view.toolOptions;
  const textValue = editingExisting ? editingExisting.text : '';
  const sizeValue = editingExisting ? editingExisting.size : opts.textSize;
  const chipValue = editingExisting ? editingExisting.chip : opts.textChip;

  return `
    <div class="inspector-content">
      ${editingExisting ? '<div class="inspector-empty inspector-note-hint">Editing selected text note.</div>' : ''}
      <div class="inspector-section">
        <div class="section-label">Text</div>
        <textarea class="input textarea" data-text-input data-field="text-body" rows="3" placeholder="Label…">${escapeHtml(textValue)}</textarea>
      </div>
      <div class="inspector-section">
        <div class="section-label">Size</div>
        <input type="range" class="slider" data-slider="textSize" min="${MIN_TEXT_SIZE}" max="${MAX_TEXT_SIZE}" value="${sizeValue}" />
        <div class="slider-value chip-mono">${sizeValue}px</div>
      </div>
      <label class="toggle-row">
        <input type="checkbox" data-toggle="textChip" ${chipValue ? 'checked' : ''} />
        <span>Background chip</span>
      </label>
      ${renderRoleSwatches(roster.roles, view.roleColor, 'create')}
    </div>
  `;
}

// ---- Measure / Erase / Pan -----------------------------------------------------

function renderMeasurePanel(view) {
  return `
    <div class="inspector-content">
      <label class="toggle-row">
        <input type="checkbox" data-toggle="snap" ${view.toolOptions.snap ? 'checked' : ''} />
        <span>Snap to grid</span>
      </label>
      <div class="inspector-empty">Drag on the map for a live distance readout (world units + meters). Not persisted.</div>
    </div>
  `;
}

function renderErasePanel(doc) {
  const tactic = activeTactic(doc);
  const count = tactic?.objects.length ?? 0;
  return `
    <div class="inspector-content">
      <div class="inspector-empty">Click an object on the map to delete it.</div>
      <button type="button" class="btn btn-danger" data-action="clear-placed">
        <i class="ph-bold ph-trash" aria-hidden="true"></i> Clear placed (${count})
      </button>
    </div>
  `;
}

function renderPanPanel() {
  return `
    <div class="inspector-content">
      <div class="inspector-empty">Drag the map to pan, or hold Space in any tool.</div>
    </div>
  `;
}

function renderLabelField() {
  return `
    <div class="inspector-section">
      <div class="section-label">Label (optional)</div>
      <input type="text" class="input" data-label-input data-field="create-label" placeholder="Applies to the next created object…" />
    </div>
  `;
}

// ---- Persistent bottom: selection mini-card + frame notes ----------------------

function renderFrameNotes(doc, view) {
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

const TRANSFORM_TOOLS = new Set(['select', 'move']);

/**
 * Role-color input (swatch click or custom `<input type=color>`) means two different things
 * depending on tool: in Select/Move (and Text, when a text object is selected — TextNote
 * carries a `role` field per contract §3) it recolors the selected object; in every creation
 * tool it sets the "next object" role color used at placement/draw time.
 */
function applyRoleColor(store, ctx, hex) {
  const view = store.getView();
  const isTransformContext = TRANSFORM_TOOLS.has(view.tool) || (view.tool === 'text' && view.selection);
  if (isTransformContext) {
    if (view.selection) ctx.exec({ type: 'doc/recolorObject', id: view.selection, role: hex });
    return;
  }
  ctx.exec({ type: 'view/setRoleColor', color: hex });
}

function renderMiniSelectionCard(doc, view) {
  if (TRANSFORM_TOOLS.has(view.tool)) return '';
  const tactic = activeTactic(doc);
  const obj = view.selection ? findObject(tactic, view.selection) : null;
  if (!obj) return '';
  // Markers store per-keyframe positions[kf], not a flat x/y (contract §3) — resolve via
  // playbook.positionAt the same way canvas.mjs / playbook.visibleObjects would, rather than
  // reading a field that only exists on the *resolved* view of an object.
  const coords = obj.kind === 'unit' ? fmtCoordPair(positionAt(obj, view.currentKeyframe)) : '';
  return `
    <div class="mini-selection-card">
      <span class="chip chip-mono chip-neutral">${escapeHtml(objectKindLabel(obj))}</span>
      ${coords ? `<span class="chip-mono mini-selection-coords">${coords}</span>` : ''}
    </div>
  `;
}

// ---- Top-level dispatch ---------------------------------------------------------

function renderBody(doc, view, roster) {
  const tool = view.tool;
  if (tool === 'place') return renderPlacePanel(doc, view, roster);
  if (tool === 'select' || tool === 'move') return renderSelectPanel(doc, view, roster);
  if (isLineLikeTool(tool)) return renderLineToolPanel(tool, view, roster);
  if (isShapeTool(tool)) return renderShapeToolPanel(view, roster);
  if (tool === 'text') return renderTextToolPanel(doc, view, roster);
  if (tool === 'measure') return renderMeasurePanel(view);
  if (tool === 'erase') return renderErasePanel(doc);
  if (tool === 'pan') return renderPanPanel();
  return `<div class="inspector-content"><div class="inspector-empty">Select a tool from the rail.</div></div>`;
}

function render(doc, view, roster) {
  return `
    ${header(view.tool)}
    ${renderBody(doc, view, roster)}
    ${renderMiniSelectionCard(doc, view)}
    ${renderFrameNotes(doc, view)}
  `;
}

// ---- Event wiring -----------------------------------------------------------------

function wirePlaceEvents(el, ctx, roster) {
  const view = ctx.store.getView();

  el.querySelectorAll('.roster-tab').forEach((btn) => {
    btn.addEventListener('click', () => ctx.exec({ type: 'view/setTab', tab: btn.dataset.tab }));
  });

  el.querySelectorAll('.roster-tile').forEach((tile) => {
    tile.addEventListener('click', () => {
      const tab = tile.dataset.refTab;
      const code = tile.dataset.refCode;
      const entry = findRosterEntry(roster, tab, code);
      if (!entry) return;
      if (view.armedUnit?.code === code) {
        ctx.exec({ type: 'view/disarm' });
        return;
      }
      ctx.exec({ type: 'view/armUnit', unit: { code, tab, entry } });
    });
  });
}

function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/**
 * A debouncer for doc/setObjectProps specifically: merges props across rapid-fire calls for
 * the SAME object id instead of a plain debounce()'s last-call-wins. Needed because the text
 * panel exposes three independent controls (text/size/chip) that all funnel through this one
 * dispatcher — dragging the size slider and toggling the chip checkbox within the debounce
 * window would otherwise silently drop whichever call didn't fire last, even though both are
 * genuine, distinct edits. If the selected object changes mid-debounce (different id), the
 * pending buffer flushes immediately first so it isn't merged into or lost under the new id.
 * @param {Function} exec
 * @param {number} ms
 * @returns {(id:string, props:object) => void}
 */
function createObjectPropsDebouncer(exec, ms) {
  let timer = null;
  let pendingId = null;
  let pendingProps = null;

  function flush() {
    if (timer) clearTimeout(timer);
    timer = null;
    if (pendingId) exec({ type: 'doc/setObjectProps', id: pendingId, props: pendingProps });
    pendingId = null;
    pendingProps = null;
  }

  return (id, props) => {
    if (pendingId && pendingId !== id) flush();
    pendingId = id;
    pendingProps = { ...pendingProps, ...props };
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, ms);
  };
}

/**
 * Mounts the contextual inspector panel.
 * @param {HTMLElement} el
 * @param {{store:object, history:object, roster:object, maps:object, exec:Function}} ctx
 */
export function mount(el, ctx) {
  const { store, roster } = ctx;

  const debouncedSetNote = debounce((kf, text) => {
    ctx.exec({ type: 'doc/setNote', kf, text });
  }, NOTE_DEBOUNCE_MS);

  const debouncedSetObjectProps = createObjectPropsDebouncer(ctx.exec, NOTE_DEBOUNCE_MS);

  function draw() {
    el.innerHTML = render(store.getDoc(), store.getView(), roster);
    wirePlaceEvents(el, ctx, roster);
  }

  el.addEventListener('click', (event) => {
    const target = event.target;

    const disarmBtn = target.closest('[data-action="disarm"]');
    if (disarmBtn) {
      ctx.exec({ type: 'view/disarm' });
      return;
    }

    const deleteBtn = target.closest('[data-action="delete-object"]');
    if (deleteBtn) {
      const view = store.getView();
      if (view.selection) ctx.exec({ type: 'doc/deleteObject', id: view.selection });
      return;
    }

    const clearBtn = target.closest('[data-action="clear-placed"]');
    if (clearBtn) {
      ctx.exec({ type: 'doc/clearPlaced' });
      return;
    }

    const roleSwatch = target.closest('.role-swatch');
    if (roleSwatch) {
      applyRoleColor(store, ctx, roleSwatch.dataset.roleHex);
      return;
    }

    const segBtn = target.closest('.segmented-btn');
    if (segBtn) {
      const group = segBtn.closest('[data-segmented]');
      ctx.exec({ type: 'view/setToolOption', key: group.dataset.segmented, value: segBtn.dataset.value });
    }
  });

  el.addEventListener('input', (event) => {
    const target = event.target;

    if (target.matches('.roster-search')) {
      ctx.exec({ type: 'view/setQuery', query: target.value });
      return;
    }

    if (target.matches('[data-slider]')) {
      const key = target.dataset.slider;
      const value = Number(target.value);
      const view = store.getView();
      if (key === 'size') {
        if (view.selection) ctx.exec({ type: 'doc/resizeMarker', id: view.selection, size: value });
        return;
      }
      const editing = key === 'textSize' ? editingTextNote(store) : null;
      if (editing) {
        debouncedSetObjectProps(editing.id, { size: value });
      } else {
        ctx.exec({ type: 'view/setToolOption', key, value });
      }
      return;
    }

    if (target.matches('[data-toggle]')) {
      const key = target.dataset.toggle;
      const editing = key === 'textChip' ? editingTextNote(store) : null;
      if (editing) {
        debouncedSetObjectProps(editing.id, { chip: target.checked });
      } else {
        ctx.exec({ type: 'view/setToolOption', key, value: target.checked });
      }
      return;
    }

    if (target.matches('.role-custom-input')) {
      applyRoleColor(store, ctx, target.value);
      return;
    }

    if (target.matches('[data-notes-input]')) {
      const view = store.getView();
      debouncedSetNote(view.currentKeyframe, target.value);
      return;
    }

    if (target.matches('[data-text-input]')) {
      const editing = editingTextNote(store);
      if (editing) debouncedSetObjectProps(editing.id, { text: target.value });
      return;
    }

    if (target.matches('[data-zone-label-input]')) {
      const view = store.getView();
      if (view.selection) debouncedSetObjectProps(view.selection, { label: target.value });
    }
  });

  draw();
  store.subscribe(() => {
    // Full rebuild (contract §5: "rebuild innerHTML from state"), but if a text field inside
    // this panel is focused, redrawing would steal focus and caret position mid-typing
    // (view/setQuery and the debounced doc/setNote both dispatch on every keystroke). Every
    // focusable text field carries a stable `data-field` id so we can find its replacement
    // after the rebuild and restore focus + caret there.
    const active = document.activeElement;
    const fieldId = active && el.contains(active) ? active.dataset?.field : null;
    const selection = fieldId ? { start: active.selectionStart, end: active.selectionEnd } : null;

    draw();

    if (fieldId) {
      const restored = el.querySelector(`[data-field="${fieldId}"]`);
      if (restored) {
        restored.focus();
        if (typeof selection.start === 'number' && restored.setSelectionRange) {
          restored.setSelectionRange(selection.start, selection.end);
        }
      }
    }
  });
}
