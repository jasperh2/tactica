// ui/playbookbar-helpers.mjs — [ui-playbook]
// Pure render-to-HTML-string helpers + tiny formatting utilities for playbookbar.mjs.
// No DOM access, no store access — everything here is (state) -> string.

/**
 * @param {{tactics:Array<{id:string,name:string,subtitle:string}>}} doc
 * @param {object|undefined} tactic
 * @param {{dropdownOpen:boolean, renamingTacticId:(string|null)}} uiState
 * @returns {string}
 */
export function renderTacticControl(doc, tactic, uiState) {
  if (uiState.renamingTacticId !== null && tactic && tactic.id === uiState.renamingTacticId) {
    return `
      <div class="pb-tactic-control">
        <input type="text" class="input pb-tactic-rename-input" value="${escapeAttr(tactic.name)}"
          data-role="rename-tactic-input" autofocus />
      </div>
    `;
  }

  const triggerLabel = tactic ? escapeHtml(tactic.name) : 'Select a playbook';
  const subtitle =
    tactic && tactic.subtitle ? `<span class="pb-tactic-subtitle">${escapeHtml(tactic.subtitle)}</span>` : '';

  return `
    <div class="pb-tactic-control">
      <button type="button" class="pb-tactic-trigger" data-action="toggle-dropdown" aria-haspopup="listbox"
        aria-expanded="${uiState.dropdownOpen ? 'true' : 'false'}">
        <span class="pb-tactic-name" data-action="rename-tactic-start" title="Double-click to rename">${triggerLabel}</span>
        ${subtitle}
        <i class="ph-bold ph-caret-up"></i>
      </button>
      ${uiState.dropdownOpen ? renderDropdown(doc, tactic) : ''}
    </div>
  `;
}

function renderDropdown(doc, activeTacticRef) {
  const rows = doc.tactics
    .map((t) => {
      const isActive = activeTacticRef && t.id === activeTacticRef.id;
      return `
        <button type="button" class="pb-dropdown-row ${isActive ? 'is-active' : ''}" data-action="select-tactic" data-tactic-id="${escapeAttr(t.id)}" role="option" aria-selected="${isActive}">
          <span class="pb-dropdown-row-name">${escapeHtml(t.name)}</span>
          ${t.subtitle ? `<span class="pb-dropdown-row-subtitle">${escapeHtml(t.subtitle)}</span>` : ''}
        </button>
      `;
    })
    .join('');

  return `
    <div class="pb-dropdown" role="listbox">
      <div class="pb-dropdown-header">SELECT A PLAYBOOK</div>
      <div class="pb-dropdown-list">${rows || '<div class="pb-dropdown-empty">No playbooks yet</div>'}</div>
      <button type="button" class="pb-dropdown-new" data-action="new-tactic">
        <i class="ph-bold ph-plus"></i> New playbook
      </button>
    </div>
  `;
}

/**
 * @param {object} tactic
 * @param {{currentKeyframe:number}} view
 * @param {number|null} contextMenuN
 * @param {number|null} renamingFrameN
 * @returns {string}
 */
export function renderKeyframeCards(tactic, view, contextMenuN, renamingFrameN) {
  const cards = tactic.keyframes
    .map((kf) => {
      const n = Number(kf.n) || 0;
      const state = n < view.currentKeyframe ? 'past' : n > view.currentKeyframe ? 'future' : 'active';
      const hasNote = Boolean(tactic.notes && tactic.notes[n]);
      const isRenaming = renamingFrameN === n;
      const nameHtml = isRenaming
        ? `<input type="text" class="input pb-kf-rename-input" value="${escapeAttr(kf.name)}"
            data-role="rename-frame-input" data-kf-n="${escapeAttr(n)}" autofocus />`
        : `<div class="pb-kf-name" title="Double-click to rename">${escapeHtml(kf.name)}</div>`;
      return `
        <div class="pb-kf-card is-${state}" role="listitem" draggable="${isRenaming ? 'false' : 'true'}"
          data-kf-n="${escapeAttr(n)}" data-action="jump-keyframe" tabindex="0">
          <div class="pb-kf-top">
            <span class="pb-kf-number ${n <= view.currentKeyframe ? 'is-reached' : ''}">${n}</span>
            ${hasNote ? '<span class="pb-kf-notedot" title="Has a frame note"></span>' : ''}
          </div>
          ${nameHtml}
          <div class="pb-kf-meta chip-mono">KEYFRAME · T+${escapeHtml(kf.t)}</div>
          ${contextMenuN === n ? renderContextMenu(tactic, { ...kf, n }) : ''}
        </div>
      `;
    })
    .join('');

  return `${cards}
    <button type="button" class="pb-add-frame" data-action="add-frame">
      <i class="ph-bold ph-plus"></i> Add frame
    </button>`;
}

function renderContextMenu(tactic, kf) {
  const canDelete = tactic.keyframes.length > 1;
  const n = escapeAttr(Number(kf.n) || 0);
  return `
    <div class="pb-kf-menu" role="menu">
      <button type="button" class="pb-kf-menu-item" role="menuitem" data-action="rename-frame" data-kf-n="${n}">
        <i class="ph-bold ph-note-pencil"></i> Rename
      </button>
      <button type="button" class="pb-kf-menu-item" role="menuitem" data-action="duplicate-frame" data-kf-n="${n}">
        <i class="ph-bold ph-copy"></i> Duplicate
      </button>
      <button type="button" class="pb-kf-menu-item pb-kf-menu-item-danger" role="menuitem" data-action="delete-frame"
        data-kf-n="${n}" ${canDelete ? '' : 'disabled'}>
        <i class="ph-bold ph-x"></i> Delete
      </button>
    </div>
  `;
}

export function renderEmptyState() {
  return `
    <div class="pb-empty">
      <span>No playbook selected — pick one or start a new one.</span>
      <button type="button" class="btn btn-primary" data-action="new-tactic">
        <i class="ph-bold ph-plus"></i> New playbook
      </button>
    </div>
  `;
}

/** "m:ss" -> total seconds. Inverse of geometry.fmtClock; local to this panel's UI concern. */
export function parseClock(clock) {
  const [mins, secs] = String(clock).split(':').map(Number);
  if (Number.isNaN(mins) || Number.isNaN(secs)) return 0;
  return mins * 60 + secs;
}

export function escapeHtml(str) {
  return String(str).replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]
  );
}

export function escapeAttr(str) {
  return escapeHtml(str);
}
