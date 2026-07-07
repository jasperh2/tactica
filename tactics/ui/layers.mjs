// ui/layers.mjs — [ui-layers] Layers panel (contract §5, handoff README §2).
// Figma-style layer list: color dot, name, object count, lock, visibility.
// Renders from store state only; communicates via doc/view actions + ctx.exec.
// No cross-panel imports, no DOM access outside #layers.

import { activeTactic, objectCountForLayer, pickActiveLayerAfterDelete } from '../core/playbook.mjs';
import { safeColor, escapeAttr } from './sanitize.mjs';

// Palette handed to newly-added custom layers, cycled once the 5 defaults are exhausted
// (verbatim order from the design prototype's addLayer()). Doubles as the swatch palette the
// editable color dot offers (LY4).
const NEW_LAYER_PALETTE = ['#e5484d', '#f2801f', '#f5c518', '#38b26b', '#33b7d4', '#6ea0ff', '#b070f0'];

// ---- pure helpers (exported for tests) --------------------------------------

/**
 * Confirm-dialog copy for deleting a layer. Independent-frames + cascade-delete model
 * (LY1): a layer's objects are DELETED with it — they no longer move to Deployments.
 * @param {string} name @returns {string}
 */
export function deleteConfirmMessage(name) {
  return `Delete layer "${name}"? Its objects on this layer are permanently deleted with it.`;
}

/**
 * Returns `name` unchanged when it collides with no OTHER layer's name (case-insensitive),
 * else appends " 2", " 3", … until unique (LY5 dup-name guard). `existingNames` is every
 * OTHER layer's name (exclude the layer being renamed so it can keep its own name).
 * @param {string} name @param {string[]} existingNames @returns {string}
 */
export function uniqueLayerName(name, existingNames) {
  const taken = new Set(existingNames.map((n) => String(n).trim().toLowerCase()));
  const base = String(name).trim();
  if (!taken.has(base.toLowerCase())) return base;
  let suffix = 2;
  while (taken.has(`${base} ${suffix}`.toLowerCase())) suffix += 1;
  return `${base} ${suffix}`;
}

/**
 * @param {HTMLElement} el
 * @param {{store:object, history:object, roster:object, maps:object, exec:function}} ctx
 */
export function mount(el, ctx) {
  el.classList.add('layers-panel');

  /** @type {{layerId:string|null, mode:'rename', draft:string}|null} */
  let editState = null;
  /** @type {string|null} layerId whose color palette popover is open (LY4) */
  let colorEditId = null;
  /** @type {string|null} layerId currently being dragged */
  let dragLayerId = null;

  render();
  // Collapse (item d) is a view-pref, not a store change, so it won't come through
  // store.subscribe — re-render on the layout api's collapse callback to flip the chevron +
  // toggle the .is-collapsed rail styling. ctx.layout is absent only in a stripped test harness.
  if (ctx.layout && typeof ctx.layout.onCollapseChange === 'function') {
    ctx.layout.onCollapseChange(() => render());
  }
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
    const isCollapsed = !!(ctx.layout && ctx.layout.isLayersCollapsed && ctx.layout.isLayersCollapsed());

    el.classList.toggle('is-collapsed', isCollapsed);

    // Collapse chevron (item d): points left ("collapse") when open, right ("expand") when the
    // panel is a slim rail. It stays visible in both states — it's the only way back out of the
    // rail. Placed before the "Layers" label so it anchors the panel's leading edge, and it's the
    // one header control that survives into the collapsed rail (add + label hide via CSS).
    el.innerHTML = `
      <div class="layers-panel__header">
        <button type="button" class="layers-panel__collapse" data-action="toggle-collapse"
                title="${isCollapsed ? 'Expand layers panel' : 'Collapse layers panel'}"
                aria-label="${isCollapsed ? 'Expand layers panel' : 'Collapse layers panel'}"
                aria-expanded="${!isCollapsed}">
          <i class="ph ${isCollapsed ? 'ph-caret-right' : 'ph-caret-left'}"></i>
        </button>
        <span class="section-label">Layers</span>
        <button type="button" class="layers-panel__add" data-action="add-layer" title="Add layer">
          <i class="ph ph-plus"></i>
        </button>
      </div>
      <div class="layers-panel__list">
        ${doc.layers.map((layer) => renderRow(layer, tactic, kf, view, doc.layers.length > 1)).join('')}
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

  function renderRow(layer, tactic, kf, view, canDelete) {
    const isActive = layer.id === view.activeLayerId;
    const isHidden = !layer.visible;
    const isLocked = layer.locked;
    const count = tactic ? objectCountForLayer(tactic, layer.id, kf) : 0;
    const isEditing = editState && editState.layerId === layer.id;
    const isColorOpen = colorEditId === layer.id;
    const eyeIcon = layer.visible ? 'ph-eye' : 'ph-eye-slash';
    const lockIcon = isLocked ? 'ph-lock-simple' : 'ph-lock-simple-open';
    const dotColor = safeColor(layer.color);

    const nameHtml = isEditing
      ? `<input type="text" class="layer-row__name-input" value="${escapeHtml(layer.name)}" maxlength="40" />`
      : `<span class="layer-row__name" title="Double-click to rename">${escapeHtml(layer.name)}</span>`;

    // Editable color dot (LY4): a button that opens an inline swatch palette + native picker.
    const dotHtml = `
      <button type="button" class="layer-row__dot" data-action="edit-color"
              style="background:${dotColor}" title="Change layer color" aria-label="Change layer color">
      </button>
      ${isColorOpen ? renderColorPopover(layer, dotColor) : ''}`;

    return `
      <div
        class="layer-row${isActive ? ' is-active' : ''}${isHidden ? ' is-hidden' : ''}${isLocked ? ' is-locked' : ''}"
        data-layer-id="${escapeAttr(layer.id)}"
        draggable="${isEditing || isColorOpen ? 'false' : 'true'}"
      >
        ${dotHtml}
        ${nameHtml}
        <span class="layer-row__count chip-mono">${count}</span>
        ${isEditing ? '' : `<button type="button" class="layer-row__icon-btn layer-row__rename" data-action="rename-layer" title="Rename layer" ${isLocked ? 'disabled' : ''}>
          <i class="ph ph-pencil-simple"></i>
        </button>`}
        <button type="button" class="layer-row__icon-btn" data-action="toggle-lock" title="Lock">
          <i class="ph ${lockIcon}"></i>
        </button>
        <button type="button" class="layer-row__icon-btn" data-action="toggle-visible" title="Show / hide">
          <i class="ph ${eyeIcon}"></i>
        </button>
        ${canDelete ? `<button type="button" class="layer-row__icon-btn layer-row__delete" data-action="delete-layer" title="Delete layer">
          <i class="ph ph-trash"></i>
        </button>` : ''}
      </div>
    `;
  }

  // Inline color palette (LY4): the 7 preset swatches plus a native picker for arbitrary hues.
  // No naming here, so no dark-theme window.prompt concern; the popover is themed via tokens.
  function renderColorPopover(layer, dotColor) {
    const swatches = NEW_LAYER_PALETTE.map((color) => {
      const isCurrent = color.toLowerCase() === dotColor.toLowerCase();
      return `<button type="button" class="layer-color__swatch${isCurrent ? ' is-current' : ''}"
                data-action="pick-color" data-color="${escapeAttr(color)}"
                style="background:${safeColor(color)}" title="${escapeAttr(color)}"
                aria-label="Use color ${escapeAttr(color)}"></button>`;
    }).join('');
    return `
      <div class="layer-color-popover" role="dialog" aria-label="Layer color">
        <div class="layer-color__swatches">${swatches}</div>
        <label class="layer-color__custom">
          <input type="color" class="layer-color__input" data-action="custom-color"
                 value="${escapeAttr(dotColor)}" title="Custom color" />
          <span class="layer-color__custom-label">Custom</span>
        </label>
      </div>`;
  }

  // ---- event handling ---------------------------------------------------------

  function onClick(event) {
    const actionEl = event.target.closest('[data-action]');

    // Header controls live outside any .layer-row — handle them before the row guard below
    // (which would otherwise never see the click).
    if (actionEl && actionEl.dataset.action === 'add-layer') {
      event.stopPropagation();
      addLayer();
      return;
    }
    if (actionEl && actionEl.dataset.action === 'toggle-collapse') {
      event.stopPropagation();
      if (ctx.layout && typeof ctx.layout.toggleLayersCollapsed === 'function') {
        ctx.layout.toggleLayersCollapsed();
      }
      return;
    }

    const row = event.target.closest('.layer-row');
    if (!row) {
      // A click anywhere outside a row (and not on a header control) dismisses an open
      // color popover so it behaves like a light-dismiss menu.
      if (colorEditId) {
        colorEditId = null;
        render();
      }
      return;
    }
    const layerId = row.dataset.layerId;

    if (actionEl) {
      event.stopPropagation();
      handleAction(actionEl.dataset.action, layerId, actionEl);
      return;
    }

    // Clicking a different row's body closes any open popover before selecting.
    if (colorEditId && colorEditId !== layerId) colorEditId = null;
    if (editState && editState.layerId === layerId) return;
    ctx.exec({ type: 'view/setActiveLayer', layerId });
  }

  function handleAction(action, layerId, actionEl) {
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
      return;
    }
    if (action === 'rename-layer') {
      startRename(layerId);
      return;
    }
    if (action === 'edit-color') {
      colorEditId = colorEditId === layerId ? null : layerId;
      render();
      return;
    }
    if (action === 'pick-color') {
      applyColor(layerId, actionEl && actionEl.dataset.color);
    }
  }

  function applyColor(layerId, color) {
    const next = safeColor(color);
    colorEditId = null;
    ctx.exec({ type: 'doc/setLayerColor', id: layerId, color: next });
  }

  function addLayer() {
    const doc = ctx.store.getDoc();
    const defaultIds = new Set(['units', 'arty', 'routes', 'zones', 'notes']);
    const customCount = doc.layers.filter((layer) => !defaultIds.has(layer.id)).length;
    const color = NEW_LAYER_PALETTE[customCount % NEW_LAYER_PALETTE.length];
    const id = `ly${Date.now()}`;
    // Dup-name guard (LY5): auto-suffix if "Layer N" already exists (case-insensitive).
    const name = uniqueLayerName(`Layer ${customCount + 1}`, doc.layers.map((l) => l.name));
    const layer = { id, name, color, visible: true, locked: false };

    ctx.exec({ type: 'doc/addLayer', layer });
    ctx.exec({ type: 'view/setActiveLayer', layerId: id });
  }

  function deleteLayer(layerId) {
    const doc = ctx.store.getDoc();
    // Min-1 guard (LY3): never delete the last remaining layer (the delete control is also
    // hidden when only one layer remains — this is the defence-in-depth backstop).
    if (doc.layers.length <= 1) return;
    const layer = doc.layers.find((l) => l.id === layerId);
    if (!layer) return;
    // eslint-disable-next-line no-alert -- deliberate destructive-delete confirm (cascade wipes objects)
    if (!confirm(deleteConfirmMessage(layer.name))) return;

    if (colorEditId === layerId) colorEditId = null;
    ctx.exec({ type: 'doc/deleteLayer', id: layerId });

    // Re-anchor the active layer (LY2): doc/deleteLayer cascade-removes the layer + its objects
    // but does NOT touch view.activeLayerId — if the deleted layer was active, the next draw would
    // stamp a dead layerId (invisible). Recompute from the POST-delete layers.
    const after = ctx.store.getDoc();
    const currentActiveId = ctx.store.getView().activeLayerId;
    const layerId2 = pickActiveLayerAfterDelete(after.layers, layerId, currentActiveId);
    if (layerId2 !== currentActiveId) {
      ctx.exec({ type: 'view/setActiveLayer', layerId: layerId2 });
    }
  }

  // ---- rename (double-click) ---------------------------------------------------

  function onDblClick(event) {
    const nameEl = event.target.closest('.layer-row__name');
    if (!nameEl) return;
    const row = event.target.closest('.layer-row');
    startRename(row.dataset.layerId);
  }

  function startRename(layerId) {
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

  // Native color picker (LY4) commits on `change` (fires when the picker closes / a hue is
  // chosen). The row it belongs to owns the layerId.
  el.addEventListener('change', (event) => {
    const input = event.target.closest('.layer-color__input');
    if (!input) return;
    const row = event.target.closest('.layer-row');
    if (!row) return;
    applyColor(row.dataset.layerId, input.value);
  });

  function commitRename(rawValue) {
    if (!editState) return;
    const { layerId } = editState;
    const name = rawValue.trim();
    editState = null;
    if (name) {
      // Dup-name guard (LY5): auto-suffix against every OTHER layer's name (the renamed layer is
      // excluded so re-committing its own unchanged name never suffixes it).
      const doc = ctx.store.getDoc();
      const otherNames = doc.layers.filter((l) => l.id !== layerId).map((l) => l.name);
      const uniqueName = uniqueLayerName(name, otherNames);
      ctx.exec({ type: 'doc/renameLayer', id: layerId, name: uniqueName });
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
