// ui/layers.mjs — [ui-layers] Layers panel (contract §5, handoff README §2).
// Figma-style layer list: color dot, name, object count, lock, visibility.
// Renders from store state only; communicates via doc/view actions + ctx.exec.
// No cross-panel imports, no DOM access outside #layers.

import { activeTactic, objectCountForLayer } from '../core/playbook.mjs';
import { safeColor, escapeAttr } from './sanitize.mjs';

// Palette handed to newly-added custom layers, cycled once the 5 defaults are exhausted
// (verbatim order from the design prototype's addLayer()).
const NEW_LAYER_PALETTE = ['#e5484d', '#f2801f', '#f5c518', '#38b26b', '#33b7d4', '#6ea0ff', '#b070f0'];

/**
 * @param {HTMLElement} el
 * @param {{store:object, history:object, roster:object, maps:object, exec:function}} ctx
 */
export function mount(el, ctx) {
  el.classList.add('layers-panel');

  /** @type {{layerId:string|null, mode:'rename', draft:string}|null} */
  let editState = null;
  /** @type {string|null} layerId currently being dragged */
  let dragLayerId = null;

  render();
  el.addEventListener('click', onClick);
  el.addEventListener('dblclick', onDblClick);
  el.addEventListener('keydown', onKeydown);
  el.addEventListener('dragstart', onDragStart);
  el.addEventListener('dragover', onDragOver);
  el.addEventListener('dragleave', onDragLeave);
  el.addEventListener('drop', onDrop);
  el.addEventListener('dragend', onDragEnd);

  ctx.store.subscribe(() => render());

  // ---- rendering ------------------------------------------------------------

  function render() {
    const doc = ctx.store.getDoc();
    const view = ctx.store.getView();
    const tactic = activeTactic(doc);
    const kf = view.currentKeyframe;
    const activeLayer = doc.layers.find((layer) => layer.id === view.activeLayerId);

    el.innerHTML = `
      <div class="layers-panel__header">
        <span class="section-label">Layers</span>
        <button type="button" class="layers-panel__add" data-action="add-layer" title="Add layer">
          <i class="ph ph-plus"></i>
        </button>
      </div>
      <div class="layers-panel__list">
        ${doc.layers.map((layer) => renderRow(layer, tactic, kf, view)).join('')}
      </div>
      <div class="layers-panel__footer">
        <span class="layers-panel__footer-dot" style="background:${activeLayer ? safeColor(activeLayer.color) : 'var(--text-secondary)'}"></span>
        <span class="layers-panel__footer-label">ACTIVE</span>
        <span class="layers-panel__footer-name">${escapeHtml(activeLayer ? activeLayer.name : '—')}</span>
      </div>
    `;

    if (editState) {
      const input = el.querySelector(`.layer-row[data-layer-id="${editState.layerId}"] .layer-row__name-input`);
      if (input) {
        input.focus();
        input.select();
      }
    }
  }

  function renderRow(layer, tactic, kf, view) {
    const isActive = layer.id === view.activeLayerId;
    const isHidden = !layer.visible;
    const isLocked = layer.locked;
    const count = tactic ? objectCountForLayer(tactic, layer.id, kf) : 0;
    const isEditing = editState && editState.layerId === layer.id;
    const eyeIcon = layer.visible ? 'ph-eye' : 'ph-eye-slash';
    const lockIcon = isLocked ? 'ph-lock-simple' : 'ph-lock-simple-open';

    const nameHtml = isEditing
      ? `<input type="text" class="layer-row__name-input" value="${escapeHtml(layer.name)}" maxlength="40" />`
      : `<span class="layer-row__name">${escapeHtml(layer.name)}</span>`;

    return `
      <div
        class="layer-row${isActive ? ' is-active' : ''}${isHidden ? ' is-hidden' : ''}${isLocked ? ' is-locked' : ''}"
        data-layer-id="${escapeAttr(layer.id)}"
        draggable="${isEditing ? 'false' : 'true'}"
      >
        <span class="layer-row__dot" style="background:${safeColor(layer.color)}"></span>
        ${nameHtml}
        <span class="layer-row__count chip-mono">${count}</span>
        <button type="button" class="layer-row__icon-btn" data-action="toggle-lock" title="Lock">
          <i class="ph ${lockIcon}"></i>
        </button>
        <button type="button" class="layer-row__icon-btn" data-action="toggle-visible" title="Show / hide">
          <i class="ph ${eyeIcon}"></i>
        </button>
        <button type="button" class="layer-row__icon-btn layer-row__delete" data-action="delete-layer" title="Delete layer">
          <i class="ph ph-trash"></i>
        </button>
      </div>
    `;
  }

  // ---- event handling ---------------------------------------------------------

  function onClick(event) {
    const actionEl = event.target.closest('[data-action]');

    // Add-layer lives in the panel header, outside any .layer-row — handle it before the
    // row guard below (which would otherwise swallow the click and it would never fire).
    if (actionEl && actionEl.dataset.action === 'add-layer') {
      event.stopPropagation();
      addLayer();
      return;
    }

    const row = event.target.closest('.layer-row');
    if (!row) return;
    const layerId = row.dataset.layerId;

    if (actionEl) {
      event.stopPropagation();
      handleAction(actionEl.dataset.action, layerId);
      return;
    }

    if (editState && editState.layerId === layerId) return;
    ctx.exec({ type: 'view/setActiveLayer', layerId });
  }

  function handleAction(action, layerId) {
    if (action === 'add-layer') {
      addLayer();
      return;
    }
    if (action === 'toggle-lock') {
      ctx.exec({ type: 'doc/toggleLayerLock', id: layerId });
      return;
    }
    if (action === 'toggle-visible') {
      ctx.exec({ type: 'doc/toggleLayerVisible', id: layerId });
      return;
    }
    if (action === 'delete-layer') {
      deleteLayer(layerId);
    }
  }

  function addLayer() {
    const doc = ctx.store.getDoc();
    const defaultIds = new Set(['units', 'arty', 'routes', 'zones', 'notes']);
    const customCount = doc.layers.filter((layer) => !defaultIds.has(layer.id)).length;
    const color = NEW_LAYER_PALETTE[customCount % NEW_LAYER_PALETTE.length];
    const id = `ly${Date.now()}`;
    const layer = { id, name: `Layer ${customCount + 1}`, color, visible: true, locked: false };

    ctx.exec({ type: 'doc/addLayer', layer });
    ctx.exec({ type: 'view/setActiveLayer', layerId: id });
  }

  function deleteLayer(layerId) {
    const doc = ctx.store.getDoc();
    const layer = doc.layers.find((l) => l.id === layerId);
    if (!layer) return;
    // eslint-disable-next-line no-alert -- deliberate confirm per contract (BUILD: delete layer)
    if (!confirm(`Delete layer "${layer.name}"? Its objects move to Deployments.`)) return;
    ctx.exec({ type: 'doc/deleteLayer', id: layerId });
  }

  // ---- rename (double-click) ---------------------------------------------------

  function onDblClick(event) {
    const nameEl = event.target.closest('.layer-row__name');
    if (!nameEl) return;
    const row = event.target.closest('.layer-row');
    const layerId = row.dataset.layerId;
    if (isLayerLocked(layerId)) return;

    editState = { layerId, mode: 'rename' };
    render();
  }

  function onKeydown(event) {
    const input = event.target.closest('.layer-row__name-input');
    if (!input || !editState) return;

    if (event.key === 'Enter') {
      commitRename(input.value);
    } else if (event.key === 'Escape') {
      editState = null;
      render();
    }
  }

  // blur commits too (input loses focus without Enter) — delegate via focusout
  el.addEventListener('focusout', (event) => {
    const input = event.target.closest('.layer-row__name-input');
    if (!input || !editState) return;
    commitRename(input.value);
  });

  function commitRename(rawValue) {
    if (!editState) return;
    const { layerId } = editState;
    const name = rawValue.trim();
    editState = null;
    if (name) {
      ctx.exec({ type: 'doc/renameLayer', id: layerId, name });
    } else {
      render();
    }
  }

  function isLayerLocked(layerId) {
    const doc = ctx.store.getDoc();
    const layer = doc.layers.find((l) => l.id === layerId);
    return !!(layer && layer.locked);
  }

  // ---- drag to reorder ----------------------------------------------------------

  function onDragStart(event) {
    const row = event.target.closest('.layer-row');
    if (!row) return;
    dragLayerId = row.dataset.layerId;
    event.dataTransfer.effectAllowed = 'move';
    // Firefox requires data to be set for drag to initiate.
    event.dataTransfer.setData('text/plain', dragLayerId);
    row.classList.add('is-dragging');
  }

  function onDragOver(event) {
    if (!dragLayerId) return;
    const row = event.target.closest('.layer-row');
    if (!row) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';

    const rect = row.getBoundingClientRect();
    const isAfter = event.clientY - rect.top > rect.height / 2;
    row.classList.toggle('drop-before', !isAfter);
    row.classList.toggle('drop-after', isAfter);
  }

  function onDragLeave(event) {
    const row = event.target.closest('.layer-row');
    if (!row) return;
    row.classList.remove('drop-before', 'drop-after');
  }

  function onDrop(event) {
    if (!dragLayerId) return;
    const row = event.target.closest('.layer-row');
    clearDropMarkers();
    if (!row) return;
    event.preventDefault();

    const targetId = row.dataset.layerId;
    if (targetId === dragLayerId) return;

    const rect = row.getBoundingClientRect();
    const isAfter = event.clientY - rect.top > rect.height / 2;

    const doc = ctx.store.getDoc();
    const fromIndex = doc.layers.findIndex((l) => l.id === dragLayerId);
    let targetIndex = doc.layers.findIndex((l) => l.id === targetId);
    if (isAfter) targetIndex += 1;
    // Account for the source row being removed before the splice-insert (core's
    // doc/reorderLayer does layers.splice(fromIndex,1) then splice(toIndex,0,moved) —
    // toIndex is the position in the array AFTER removal, per contract note).
    let toIndex = targetIndex;
    if (fromIndex < targetIndex) toIndex -= 1;

    ctx.exec({ type: 'doc/reorderLayer', id: dragLayerId, toIndex });
  }

  function onDragEnd() {
    dragLayerId = null;
    clearDropMarkers();
    const dragging = el.querySelector('.is-dragging');
    if (dragging) dragging.classList.remove('is-dragging');
  }

  function clearDropMarkers() {
    el.querySelectorAll('.drop-before, .drop-after').forEach((rowEl) => {
      rowEl.classList.remove('drop-before', 'drop-after');
    });
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
