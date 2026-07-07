// ui/playbookbar-helpers.mjs — [ui-playbook]
// Pure render-to-HTML-string helpers + tiny formatting utilities for playbookbar.mjs.
// No DOM access, no store access — everything here is (state) -> string.

/**
 * djb2 string hash → unsigned base-36 string. NOT a cryptographic hash: this is an
 * accidental-edit guard for shared house playbooks ("did you mean to edit this locked one?"),
 * never real security. Exported so app.mjs (the APP lane) can reuse the SAME hash when it verifies
 * a lock before allowing an edit — both sides must agree on the digest for compare-on-unlock to work.
 * Deterministic, pure (no Date/Math.random). Empty string hashes to a stable non-empty digest.
 * @param {string} str
 * @returns {string}
 */
export function hashPassword(str) {
  const source = String(str);
  let hash = 5381;
  for (let i = 0; i < source.length; i += 1) {
    // hash * 33 + charCode, kept in 32-bit unsigned space so the digest is stable across engines.
    hash = (hash * 33 + source.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

/**
 * Returns `name` (trimmed) made unique against every OTHER tactic on the map (case-insensitive):
 * if it collides, auto-suffixes " (2)", " (3)", … until free, so two rows are never identical
 * (PB5). `excludeId` is the tactic being renamed — its own current name must not count as a
 * collision with itself. Pure; does not mutate `tactics`.
 * @param {string} name
 * @param {Array<{id:string,name:string}>} tactics
 * @param {string|null} [excludeId]
 * @returns {string}
 */
export function uniqueTacticName(name, tactics, excludeId = null) {
  const base = String(name).trim();
  const taken = new Set(
    tactics
      .filter((t) => t.id !== excludeId)
      .map((t) => String(t.name).trim().toLowerCase())
  );
  if (!taken.has(base.toLowerCase())) return base;
  let suffix = 2;
  // Bound the loop by the number of tactics + 2 — with N existing names at most N+1 candidates can
  // be taken, so a free "(k)" is guaranteed within that many tries (defensive against an infinite loop).
  const maxTries = tactics.length + 2;
  for (let i = 0; i < maxTries; i += 1) {
    const candidate = `${base} (${suffix})`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
    suffix += 1;
  }
  return `${base} (${suffix})`;
}

/**
 * @param {{tactics:Array<{id:string,name:string,subtitle:string}>}} doc
 * @param {object|undefined} tactic
 * @param {{dropdownOpen:boolean, renamingTacticId:(string|null), lockPromptId:(string|null), lockPromptMode:(string|null)}} uiState
 * @returns {string}
 */
export function renderTacticControl(doc, tactic, uiState) {
  if (uiState.renamingTacticId !== null && tactic && tactic.id === uiState.renamingTacticId) {
    return `
      <div class="pb-tactic-control">
        <div class="pb-tactic-rename">
          <input type="text" class="input pb-tactic-rename-input" value="${escapeAttr(tactic.name)}"
            data-role="rename-tactic-input" placeholder="Playbook name" autofocus />
          <input type="text" class="input pb-tactic-subtitle-input" value="${escapeAttr(tactic.subtitle || '')}"
            data-role="rename-tactic-subtitle" placeholder="Subtitle (optional)" />
        </div>
      </div>
    `;
  }

  const triggerLabel = tactic ? escapeHtml(tactic.name) : 'Select a playbook';
  const subtitle =
    tactic && tactic.subtitle ? `<span class="pb-tactic-subtitle">${escapeHtml(tactic.subtitle)}</span>` : '';
  const lockIndicator =
    tactic && tactic.locked ? '<i class="ph-fill ph-lock pb-tactic-lockicon" title="Locked"></i>' : '';

  return `
    <div class="pb-tactic-control">
      <button type="button" class="pb-tactic-trigger" data-action="toggle-dropdown" aria-haspopup="listbox"
        aria-expanded="${uiState.dropdownOpen ? 'true' : 'false'}">
        ${lockIndicator}
        <span class="pb-tactic-name" data-action="rename-tactic-start" title="Double-click to rename">${triggerLabel}</span>
        ${subtitle}
        <i class="ph-bold ph-caret-up"></i>
      </button>
      ${uiState.dropdownOpen ? renderDropdown(doc, tactic, uiState) : ''}
    </div>
  `;
}

function renderDropdown(doc, activeTacticRef, uiState) {
  const canDelete = doc.tactics.length > 1;
  const rows = doc.tactics
    .map((t) => {
      const isActive = activeTacticRef && t.id === activeTacticRef.id;
      const isLocked = Boolean(t.locked);
      const isPrompting = uiState.lockPromptId === t.id;
      return `
        <div class="pb-dropdown-row ${isActive ? 'is-active' : ''}" role="option" aria-selected="${isActive}" data-tactic-id="${escapeAttr(t.id)}">
          <button type="button" class="pb-dropdown-row-main" data-action="select-tactic" data-tactic-id="${escapeAttr(t.id)}">
            <span class="pb-dropdown-row-name">
              ${isLocked ? '<i class="ph-fill ph-lock pb-dropdown-row-lockicon"></i>' : ''}${escapeHtml(t.name)}
            </span>
            ${t.subtitle ? `<span class="pb-dropdown-row-subtitle">${escapeHtml(t.subtitle)}</span>` : ''}
          </button>
          <div class="pb-dropdown-row-actions">
            <button type="button" class="pb-row-action" data-action="toggle-lock" data-tactic-id="${escapeAttr(t.id)}"
              aria-label="${isLocked ? 'Unlock playbook' : 'Lock playbook'}" title="${isLocked ? 'Unlock' : 'Lock'}">
              <i class="ph-bold ${isLocked ? 'ph-lock' : 'ph-lock-open'}"></i>
            </button>
            <button type="button" class="pb-row-action" data-action="duplicate-tactic" data-tactic-id="${escapeAttr(t.id)}"
              aria-label="Duplicate playbook" title="Duplicate">
              <i class="ph-bold ph-copy"></i>
            </button>
            <button type="button" class="pb-row-action pb-row-action-danger" data-action="delete-tactic" data-tactic-id="${escapeAttr(t.id)}"
              aria-label="Delete playbook" title="Delete" ${canDelete ? '' : 'disabled'}>
              <i class="ph-bold ph-trash"></i>
            </button>
          </div>
          ${isPrompting ? renderLockPrompt(t, uiState.lockPromptMode, uiState.lockPromptError) : ''}
        </div>
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
 * Inline password field shown under a row while locking/unlocking. `mode` is 'lock' or 'unlock';
 * `error` is a non-empty string when a prior unlock attempt's password did not match.
 * @param {{id:string}} tactic @param {'lock'|'unlock'} mode @param {string} [error]
 * @returns {string}
 */
function renderLockPrompt(tactic, mode, error) {
  const isLock = mode === 'lock';
  return `
    <div class="pb-lock-prompt" data-tactic-id="${escapeAttr(tactic.id)}">
      <input type="password" class="input pb-lock-input" data-role="lock-input" data-tactic-id="${escapeAttr(tactic.id)}"
        placeholder="${isLock ? 'Set a password' : 'Enter password'}" autofocus />
      <button type="button" class="btn btn-primary pb-lock-confirm" data-action="lock-confirm" data-tactic-id="${escapeAttr(tactic.id)}">
        ${isLock ? 'Lock' : 'Unlock'}
      </button>
      ${error ? `<span class="pb-lock-error">${escapeHtml(error)}</span>` : ''}
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
