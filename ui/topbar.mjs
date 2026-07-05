// ui/topbar.mjs — TACTICA top bar [ui-topbar]
// Handoff README §1 Top bar (52px). Brand tile + map picker (dropdown w/ live search,
// placeholder tiles for unavailable maps) + undo/redo (history seam) + static avatars +
// share (seam). Contract §5: mount(el, ctx), re-render from store.subscribe, event
// delegation on the panel root, no cross-panel imports, no direct doc/view mutation.
//
// @typedef {import('../core/store.mjs').DocState} DocState
// @typedef {{id:string, name:string, asset?:string, assetSize?:{w:number,h:number}, available:boolean}} MapEntry

const AVATAR_SEED = [
  { initials: 'JH', color: '#4c8dff' },
  { initials: 'MK', color: '#f2801f' },
  { initials: 'SR', color: '#38b26b' },
];

/**
 * @param {HTMLElement} el
 * @param {{store:object, history:object, roster:object, maps:{worldSize:number, maps:MapEntry[]},
 *   exec:(action:object)=>void, undo?:Function, redo?:Function, share?:Function}} ctx
 */
export function mount(el, ctx) {
  el.id = 'topbar-root';

  /** @type {{dropdownOpen:boolean, search:string}} */
  const local = { dropdownOpen: false, search: '' };

  render();
  const unsubscribe = ctx.store.subscribe(render);

  el.addEventListener('click', onClick);
  el.addEventListener('input', onInput);
  document.addEventListener('click', onOutsideClick, true);
  document.addEventListener('keydown', onKeydown, true);

  // No teardown hook exists in the mount contract yet; expose one defensively in case the
  // integrator adds unmount support later without needing another pass over this file.
  return function unmount() {
    unsubscribe();
    document.removeEventListener('click', onOutsideClick, true);
    document.removeEventListener('keydown', onKeydown, true);
  };

  // ---- rendering ------------------------------------------------------------

  function render() {
    const doc = ctx.store.getDoc();
    const currentMap = findMap(ctx.maps.maps, doc.mapId);

    el.innerHTML = `
      <div class="tb-brand">
        <div class="tb-brand-tile">◈</div>
        <span class="tb-brand-name">TACTICA</span>
        <span class="tb-brand-chip chip-mono">CB</span>
      </div>

      <div class="tb-mappicker">
        <button type="button" class="tb-map-btn${local.dropdownOpen ? ' is-open' : ''}"
                data-action="toggle-dropdown" aria-haspopup="listbox" aria-expanded="${local.dropdownOpen}">
          <span class="tb-map-name">${escapeHtml(currentMap ? currentMap.name : 'Select a map')}</span>
          <span class="tb-map-worldsize chip-mono">${ctx.maps.worldSize}²</span>
          <i class="ph ph-caret-down"></i>
        </button>
        ${local.dropdownOpen ? renderDropdown(doc) : ''}
      </div>

      <div class="tb-right">
        <div class="tb-history">
          <button type="button" class="btn-icon" data-action="undo"
                  title="Undo (Ctrl+Z)" aria-label="Undo" ${ctx.history.canUndo() ? '' : 'disabled'}>
            <i class="ph ph-arrow-counter-clockwise"></i>
          </button>
          <button type="button" class="btn-icon" data-action="redo"
                  title="Redo (Ctrl+Shift+Z)" aria-label="Redo" ${ctx.history.canRedo() ? '' : 'disabled'}>
            <i class="ph ph-arrow-clockwise"></i>
          </button>
        </div>

        <div class="tb-avatars" aria-hidden="true">
          ${AVATAR_SEED.map(
            (a) => `<div class="tb-avatar" style="background:${a.color}">${a.initials}</div>`
          ).join('')}
        </div>

        <button type="button" class="btn tb-share-btn" data-action="share"
                ${ctx.share ? '' : 'title="share coming at integration"'}>
          <i class="ph ph-share"></i>
          <span>Share</span>
        </button>
      </div>
    `;
  }

  function renderDropdown(doc) {
    const q = local.search.trim().toLowerCase();
    const list = ctx.maps.maps.filter((m) => !q || m.name.toLowerCase().includes(q));

    const rows = list.length
      ? list.map((m) => renderMapRow(m, m.id === doc.mapId)).join('')
      : `<div class="tb-map-empty">No maps match "${escapeHtml(local.search)}"</div>`;

    return `
      <div class="tb-map-dropdown" role="listbox" aria-label="Select map">
        <div class="tb-map-search-wrap">
          <input type="text" class="input tb-map-search" data-role="map-search"
                 placeholder="Search maps…" value="${escapeHtml(local.search)}" autofocus />
        </div>
        <div class="tb-map-list">${rows}</div>
      </div>
    `;
  }

  function renderMapRow(map, isActive) {
    const tile = map.available && map.asset
      ? `<div class="tb-map-row-tile" style="background-image:url('${escapeHtml(resolveAssetPath(map.asset))}')"></div>`
      : `<div class="tb-map-row-tile" title="map art needed"><i class="ph ph-image"></i></div>`;
    const meta = map.assetSize ? `${map.assetSize.w}×${map.assetSize.h}` : 'map art needed';

    return `
      <button type="button" class="tb-map-row${isActive ? ' is-active' : ''}"
              role="option" aria-selected="${isActive}" data-action="select-map" data-map-id="${escapeHtml(map.id)}">
        ${tile}
        <div class="tb-map-row-body">
          <span class="tb-map-row-name">${escapeHtml(map.name)}</span>
          <span class="tb-map-row-meta chip-mono">${escapeHtml(meta)}</span>
        </div>
        ${isActive ? '<i class="ph ph-check tb-map-row-check"></i>' : ''}
      </button>
    `;
  }

  // ---- events -----------------------------------------------------------

  function onClick(evt) {
    const actionEl = evt.target.closest('[data-action]');
    if (!actionEl || !el.contains(actionEl)) return;

    const action = actionEl.dataset.action;
    if (action === 'toggle-dropdown') {
      local.dropdownOpen = !local.dropdownOpen;
      if (local.dropdownOpen) local.search = '';
      render();
      focusSearchIfOpen();
      return;
    }
    if (action === 'select-map') {
      ctx.exec({ type: 'doc/setMap', mapId: actionEl.dataset.mapId });
      closeDropdown();
      return;
    }
    if (action === 'undo') {
      // Undo/redo are NOT dispatched as doc/view actions — the integrator-provided
      // callbacks own the history <-> store wiring seam (per brief: "dispatch nothing
      // yourself for undo/redo").
      if (typeof ctx.undo === 'function') ctx.undo();
      return;
    }
    if (action === 'redo') {
      if (typeof ctx.redo === 'function') ctx.redo();
      return;
    }
    if (action === 'share') {
      if (typeof ctx.share === 'function') ctx.share();
      return;
    }
  }

  function onInput(evt) {
    if (evt.target.dataset.role !== 'map-search') return;
    local.search = evt.target.value;
    render();
    focusSearchIfOpen();
  }

  function onOutsideClick(evt) {
    if (!local.dropdownOpen) return;
    if (el.contains(evt.target)) return;
    closeDropdown();
  }

  function onKeydown(evt) {
    if (evt.key === 'Escape' && local.dropdownOpen) {
      closeDropdown();
    }
  }

  function closeDropdown() {
    if (!local.dropdownOpen) return;
    local.dropdownOpen = false;
    render();
  }

  function focusSearchIfOpen() {
    if (!local.dropdownOpen) return;
    const input = el.querySelector('[data-role="map-search"]');
    if (input) {
      input.focus();
      const len = input.value.length;
      input.setSelectionRange(len, len);
    }
  }
}

// ---- pure helpers ---------------------------------------------------------

/** @param {MapEntry[]} maps @param {string} mapId @returns {MapEntry|undefined} */
function findMap(maps, mapId) {
  return maps.find((m) => m.id === mapId);
}

/** maps.json asset paths are relative to site/tactics/ (data-maps ownership); topbar
 * only reads them, so resolve relative to the page root the same way index.html does. */
function resolveAssetPath(assetPath) {
  return `./${assetPath}`;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}
