// ui/playbookbar.mjs — [ui-playbook]
// Playbook bar (118px): tactic dropdown, play engine, export trigger, keyframe strip.
// Handoff README §6. Contract §5 conventions: mount(el, ctx), re-render from
// store.subscribe, event delegation on the panel root, no cross-panel imports.
// Render-to-HTML-string helpers live in ./playbookbar-helpers.mjs (still this panel's
// ownership) to keep this file under the 200-400 line target.
import { newTactic, activeTactic as getActiveTactic } from '../core/playbook.mjs';
import { fmtClock } from '../core/geometry.mjs';
import {
  renderTacticControl,
  renderKeyframeCards,
  renderEmptyState,
  parseClock,
  hashPassword,
  uniqueTacticName,
} from './playbookbar-helpers.mjs';

const PLAY_INTERVAL_MS = 1050;
const DEFAULT_FRAME_GAP_SECONDS = 30;

/**
 * @param {HTMLElement} el
 * @param {{store:object, history:object, roster:object, maps:object, exec:Function, openExport?:Function}} ctx
 */
export function mount(el, ctx) {
  el.classList.add('playbookbar');
  el.innerHTML = '';

  /** @type {number|null} */
  let playTimer = null;
  let dropdownOpen = false;
  /** @type {string|null} */
  let renamingTacticId = null;
  /** @type {string|null} */
  let lockPromptId = null; // tactic id currently showing an inline lock/unlock password field
  /** @type {'lock'|'unlock'|null} */
  let lockPromptMode = null;
  /** @type {string|null} */
  let lockPromptError = null; // set to a message when an unlock password did not match
  /** @type {number|null} */
  let renamingFrameN = null; // keyframe n currently showing the inline rename input
  /** @type {number|null} */
  let contextMenuN = null; // keyframe n with an open right-click menu
  /** @type {number|null} */
  let dragFromIndex = null; // 1-based position currently being dragged
  let lastTacticId = ctx.store.getDoc().activeTacticId;
  // The re-render inside commitRenameTactic/cancelRenameTactic replaces the focused rename
  // input's innerHTML, which fires a native blur on it — without this guard that blur would
  // re-enter onBlurCapture and commit stale/cancelled input.value a second time.
  let suppressNextBlur = false;

  render(ctx.store.getDoc(), ctx.store.getView());

  ctx.store.subscribe((doc, view) => {
    if (doc.activeTacticId !== lastTacticId) {
      lastTacticId = doc.activeTacticId;
      stopPlayback();
    }
    render(doc, view);
  });

  el.addEventListener('click', onClick);
  el.addEventListener('contextmenu', onContextMenu);
  el.addEventListener('dblclick', onDblClick);
  el.addEventListener('keydown', onKeydown);
  el.addEventListener('dragstart', onDragStart);
  el.addEventListener('dragover', onDragOver);
  el.addEventListener('drop', onDrop);
  el.addEventListener('dragend', onDragEnd);
  el.addEventListener('blur', onBlurCapture, true);
  document.addEventListener('click', onDocumentClick, true);

  // ---- render --------------------------------------------------------------

  function render(doc, view) {
    const tactic = getActiveTactic(doc);
    el.innerHTML = `
      <div class="pb-left">
        <div class="pb-brandrow">
          <span class="pb-label">PLAYBOOK</span>
          <span class="chip chip-mono pb-linear-chip">LINEAR</span>
        </div>
        ${renderTacticControl(doc, tactic, { dropdownOpen, renamingTacticId, lockPromptId, lockPromptMode, lockPromptError })}
        <div class="pb-transport">
          <button type="button" class="btn-icon pb-play-btn" data-action="toggle-play" ${tactic ? '' : 'disabled'}
            aria-label="${view.playing ? 'Pause' : 'Play'}" title="${view.playing ? 'Pause' : 'Play'}">
            <i class="ph-fill ${view.playing ? 'ph-pause' : 'ph-play'}"></i>
          </button>
          <button type="button" class="btn btn-primary pb-export-btn" data-action="export" ${tactic ? '' : 'disabled'}>
            <i class="ph-bold ph-export"></i> Export
          </button>
        </div>
      </div>
      <div class="pb-keyframes" role="list" aria-label="Keyframes">
        ${tactic ? renderKeyframeCards(tactic, view, contextMenuN, renamingFrameN) : renderEmptyState()}
      </div>
    `;
  }

  // ---- event delegation ------------------------------------------------------

  function onClick(event) {
    if (event.target.closest('[data-role="rename-frame-input"]')) return;
    const target = event.target.closest('[data-action]');
    if (!target) return;
    const action = target.dataset.action;

    if (action === 'toggle-dropdown') return toggleDropdown();
    if (action === 'select-tactic') return selectTactic(target.dataset.tacticId);
    if (action === 'new-tactic') return createNewTactic();
    if (action === 'rename-tactic-start') return startRenameTactic(event);
    if (action === 'delete-tactic') return deleteTactic(target.dataset.tacticId);
    if (action === 'duplicate-tactic') return duplicateTactic(target.dataset.tacticId);
    if (action === 'toggle-lock') return toggleLock(event, target.dataset.tacticId);
    if (action === 'lock-confirm') return confirmLock(target.dataset.tacticId);
    if (action === 'toggle-play') return togglePlay();
    if (action === 'export') return triggerExport();
    if (action === 'jump-keyframe') return jumpToKeyframe(target);
    if (action === 'add-frame') return addFrame();
    if (action === 'rename-frame') return renameFrame(Number(target.dataset.kfN));
    if (action === 'duplicate-frame') return duplicateFrame(Number(target.dataset.kfN));
    if (action === 'delete-frame') return deleteFrame(Number(target.dataset.kfN));
  }

  function onDocumentClick(event) {
    if (!el.contains(event.target)) {
      closeDropdown();
      closeContextMenu();
    }
  }

  function onContextMenu(event) {
    const card = event.target.closest('[data-kf-n]');
    if (!card) return;
    event.preventDefault();
    contextMenuN = Number(card.dataset.kfN);
    render(ctx.store.getDoc(), ctx.store.getView());
  }

  function onDblClick(event) {
    if (event.target.closest('[data-role="rename-tactic-input"]')) return;
    if (event.target.closest('[data-role="rename-tactic-subtitle"]')) return;
    if (event.target.closest('[data-action="rename-tactic-start"]')) return startRenameTactic(event);
    if (event.target.closest('[data-role="rename-frame-input"]')) return;
    const kfName = event.target.closest('.pb-kf-name');
    if (kfName) startRenameFrame(event, kfName);
  }

  function onKeydown(event) {
    const lockInput = event.target.closest('[data-role="lock-input"]');
    if (lockInput) {
      if (event.key === 'Enter') confirmLock(lockInput.dataset.tacticId);
      if (event.key === 'Escape') closeLockPrompt();
      return;
    }
    const tacticInput = event.target.closest('[data-role="rename-tactic-input"]');
    const subtitleInput = event.target.closest('[data-role="rename-tactic-subtitle"]');
    if (tacticInput || subtitleInput) {
      if (event.key === 'Enter') commitRenameTactic(readRenameInputs());
      if (event.key === 'Escape') cancelRenameTactic();
      return;
    }
    const frameInput = event.target.closest('[data-role="rename-frame-input"]');
    if (frameInput) {
      if (event.key === 'Enter') commitRenameFrame(Number(frameInput.dataset.kfN), frameInput.value);
      if (event.key === 'Escape') cancelRenameFrame();
      return;
    }
    const card = event.target.closest('[data-action="jump-keyframe"]');
    if (card && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      jumpToKeyframe(card);
    }
  }

  function onBlurCapture(event) {
    const target = event.target;
    if (!target || !target.closest) return;
    const tacticInput = target.closest('[data-role="rename-tactic-input"]');
    const subtitleInput = target.closest('[data-role="rename-tactic-subtitle"]');
    const frameInput = target.closest('[data-role="rename-frame-input"]');
    if (!tacticInput && !subtitleInput && !frameInput) return;
    if (suppressNextBlur) {
      suppressNextBlur = false;
      return;
    }
    // The tactic rename group has TWO fields (name + subtitle) — tabbing from one to the other must
    // NOT commit. Only commit when focus is leaving the whole rename group (relatedTarget outside it).
    if (tacticInput || subtitleInput) {
      const next = event.relatedTarget;
      if (next && next.closest && (next.closest('[data-role="rename-tactic-input"]') || next.closest('[data-role="rename-tactic-subtitle"]'))) {
        return;
      }
      return commitRenameTactic(readRenameInputs());
    }
    commitRenameFrame(Number(frameInput.dataset.kfN), frameInput.value);
  }

  /** Reads the current name+subtitle from the live rename inputs (falls back to '' if gone). */
  function readRenameInputs() {
    const nameEl = el.querySelector('[data-role="rename-tactic-input"]');
    const subtitleEl = el.querySelector('[data-role="rename-tactic-subtitle"]');
    return { name: nameEl ? nameEl.value : '', subtitle: subtitleEl ? subtitleEl.value : '' };
  }

  // ---- drag-to-reorder ---------------------------------------------------

  function onDragStart(event) {
    const card = event.target.closest('[data-kf-n]');
    if (!card) return;
    dragFromIndex = Number(card.dataset.kfN);
    event.dataTransfer.effectAllowed = 'move';
    try {
      event.dataTransfer.setData('text/plain', String(dragFromIndex));
    } catch {
      // some browsers require setData to be called at all; a failure here has no UX impact
    }
  }

  function onDragOver(event) {
    if (dragFromIndex === null) return;
    if (event.target.closest('[data-kf-n]')) event.preventDefault();
  }

  function onDrop(event) {
    const card = event.target.closest('[data-kf-n]');
    if (!card || dragFromIndex === null) return;
    event.preventDefault();
    const toIndex = Number(card.dataset.kfN);
    if (toIndex !== dragFromIndex) {
      ctx.exec({ type: 'doc/reorderKeyframe', n: dragFromIndex, toIndex });
    }
    dragFromIndex = null;
  }

  function onDragEnd() {
    dragFromIndex = null;
  }

  // ---- tactic dropdown / rename -------------------------------------------

  function toggleDropdown() {
    dropdownOpen = !dropdownOpen;
    if (!dropdownOpen) resetLockPromptState();
    render(ctx.store.getDoc(), ctx.store.getView());
  }

  function closeDropdown() {
    if (!dropdownOpen) return;
    dropdownOpen = false;
    resetLockPromptState();
    render(ctx.store.getDoc(), ctx.store.getView());
  }

  /** Clears lock-prompt fields WITHOUT its own render (callers render). */
  function resetLockPromptState() {
    lockPromptId = null;
    lockPromptMode = null;
    lockPromptError = null;
  }

  function selectTactic(tacticId) {
    dropdownOpen = false;
    ctx.exec({ type: 'doc/setActiveTactic', tacticId });
  }

  function createNewTactic() {
    dropdownOpen = false;
    // No window.prompt for naming (dark-theme seam): create with a deduped default name, then drop
    // straight into the inline rename flow so the user names it in-theme. uniqueTacticName (PB5)
    // keeps two rows from ever sharing a name — "New Playbook", "New Playbook (2)", …
    const tactics = ctx.store.getDoc().tactics;
    const name = uniqueTacticName('New Playbook', tactics);
    // Pass the current doc's tactics so the new id is derived collision-free (see newTactic) —
    // otherwise a reload's reset module counter re-minted an id already in the doc and the new
    // playbook became unselectable. A new playbook is a full empty board: fresh keyframe, no
    // objects, independent of every other playbook on this map.
    const tactic = newTactic(name, '', tactics);
    ctx.exec({ type: 'doc/newTactic', tactic });
    // newTactic dispatch makes it active; open the inline rename on the freshly-active tactic.
    renamingTacticId = tactic.id;
    render(ctx.store.getDoc(), ctx.store.getView());
    focusRenameInput();
  }

  function focusRenameInput() {
    const input = el.querySelector('[data-role="rename-tactic-input"]');
    if (input) {
      input.focus();
      input.select();
    }
  }

  function startRenameTactic(event) {
    event.stopPropagation();
    const tactic = getActiveTactic(ctx.store.getDoc());
    if (!tactic) return;
    dropdownOpen = false;
    renamingTacticId = tactic.id;
    render(ctx.store.getDoc(), ctx.store.getView());
    focusRenameInput();
  }

  function commitRenameTactic(rawValue) {
    const tactic = getActiveTactic(ctx.store.getDoc());
    const renamedId = renamingTacticId;
    renamingTacticId = null;
    suppressNextBlur = true;
    // rawValue is { name, subtitle } from readRenameInputs. Guard against an empty name (revert).
    const rawName = ((rawValue && rawValue.name) || '').trim();
    const subtitle = ((rawValue && rawValue.subtitle) || '').trim();
    if (!tactic || tactic.id !== renamedId || !rawName) {
      render(ctx.store.getDoc(), ctx.store.getView());
      return;
    }
    // PB5: dedupe the name against the OTHER tactics on this map (case-insensitive, auto-suffix).
    const name = uniqueTacticName(rawName, ctx.store.getDoc().tactics, tactic.id);
    if (name === tactic.name && subtitle === (tactic.subtitle || '')) {
      render(ctx.store.getDoc(), ctx.store.getView());
      return;
    }
    ctx.exec({ type: 'doc/renameTactic', id: tactic.id, name, subtitle });
  }

  function cancelRenameTactic() {
    renamingTacticId = null;
    suppressNextBlur = true;
    render(ctx.store.getDoc(), ctx.store.getView());
  }

  // ---- delete / duplicate playbook (PB1 / PB2) ----------------------------

  function deleteTactic(tacticId) {
    const doc = ctx.store.getDoc();
    if (doc.tactics.length <= 1) return; // never delete the last playbook (reducer also no-ops)
    const tactic = doc.tactics.find((t) => t.id === tacticId);
    if (!tactic) return;
    // A destructive delete is the one place a window.confirm is sanctioned (not a naming prompt).
    const ok = window.confirm(`Delete playbook '${tactic.name}'? This removes its frames and objects.`);
    if (!ok) return;
    closeLockPrompt();
    ctx.exec({ type: 'doc/deleteTactic', id: tacticId });
  }

  function duplicateTactic(tacticId) {
    closeLockPrompt();
    ctx.exec({ type: 'doc/duplicateTactic', id: tacticId });
  }

  // ---- password lock / unlock (accidental-edit guard) ---------------------

  function toggleLock(event, tacticId) {
    event.stopPropagation();
    const tactic = ctx.store.getDoc().tactics.find((t) => t.id === tacticId);
    if (!tactic) return;
    // Toggling the SAME row's prompt closed acts as a cancel.
    if (lockPromptId === tacticId) return closeLockPrompt();
    lockPromptId = tacticId;
    lockPromptMode = tactic.locked ? 'unlock' : 'lock';
    lockPromptError = null;
    render(ctx.store.getDoc(), ctx.store.getView());
    const input = el.querySelector('[data-role="lock-input"]');
    if (input) input.focus();
  }

  function confirmLock(tacticId) {
    const input = el.querySelector(`[data-role="lock-input"][data-tactic-id="${cssEscape(tacticId)}"]`);
    const value = input ? input.value : '';
    const tactic = ctx.store.getDoc().tactics.find((t) => t.id === tacticId);
    if (!tactic) return closeLockPrompt();
    if (lockPromptMode === 'lock') {
      if (!value) return; // require a non-empty password to lock; leave the prompt open
      ctx.exec({ type: 'doc/setTacticLock', id: tacticId, locked: true, passwordHash: hashPassword(value) });
      closeLockPrompt();
      return;
    }
    // unlock: compare the entered password's hash against the stored one.
    if (tactic.passwordHash && hashPassword(value) !== tactic.passwordHash) {
      lockPromptError = 'Incorrect password';
      render(ctx.store.getDoc(), ctx.store.getView());
      const retry = el.querySelector('[data-role="lock-input"]');
      if (retry) retry.focus();
      return;
    }
    ctx.exec({ type: 'doc/setTacticLock', id: tacticId, locked: false });
    closeLockPrompt();
  }

  function closeLockPrompt() {
    if (lockPromptId === null) return;
    resetLockPromptState();
    render(ctx.store.getDoc(), ctx.store.getView());
  }

  /** Minimal CSS.escape shim for attribute selectors (tactic ids are "t\\d+", so this suffices). */
  function cssEscape(value) {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
    return String(value).replace(/["\\]/g, '\\$&');
  }

  // ---- play engine ---------------------------------------------------------

  function togglePlay() {
    if (ctx.store.getView().playing) {
      stopPlayback();
    } else {
      startPlayback();
    }
  }

  function startPlayback() {
    const tactic = getActiveTactic(ctx.store.getDoc());
    if (!tactic || tactic.keyframes.length === 0) return;

    const atLastFrame = ctx.store.getView().currentKeyframe >= tactic.keyframes.length;
    if (atLastFrame) {
      ctx.store.dispatch({ type: 'view/setKeyframe', kf: 1 });
    }
    ctx.store.dispatch({ type: 'view/setPlaying', playing: true });

    playTimer = window.setInterval(() => {
      const currentTactic = getActiveTactic(ctx.store.getDoc());
      const currentView = ctx.store.getView();
      if (!currentTactic || currentView.currentKeyframe >= currentTactic.keyframes.length) {
        stopPlayback();
        return;
      }
      ctx.store.dispatch({ type: 'view/setKeyframe', kf: currentView.currentKeyframe + 1 });
    }, PLAY_INTERVAL_MS);
  }

  function stopPlayback() {
    if (playTimer !== null) {
      window.clearInterval(playTimer);
      playTimer = null;
    }
    if (ctx.store.getView().playing) {
      ctx.store.dispatch({ type: 'view/setPlaying', playing: false });
    }
  }

  // ---- export ----------------------------------------------------------------

  function triggerExport() {
    // Seam: the integrator provides ctx.openExport() to open the export modal
    // (exportmodal.mjs owns #modal-root content — no cross-panel DOM access from here).
    // A view/setToolOption('exportOpen', true) dispatch was flagged HACKY in the brief;
    // this panel just calls the callback and no-ops if it isn't wired yet (see final notes).
    if (typeof ctx.openExport === 'function') {
      ctx.openExport();
    }
  }

  // ---- keyframes -------------------------------------------------------------

  function jumpToKeyframe(cardEl) {
    const n = Number(cardEl.dataset.kfN);
    if (Number.isNaN(n)) return;
    stopPlayback();
    ctx.store.dispatch({ type: 'view/setKeyframe', kf: n });
  }

  function addFrame() {
    const tactic = getActiveTactic(ctx.store.getDoc());
    if (!tactic) return;
    const lastKf = tactic.keyframes[tactic.keyframes.length - 1];
    const name = window.prompt('Keyframe name', `Frame ${tactic.keyframes.length + 1}`);
    if (!name) return;
    const t = fmtClock(parseClock(lastKf ? lastKf.t : '0:00') + DEFAULT_FRAME_GAP_SECONDS);
    ctx.exec({ type: 'doc/addKeyframe', name: name.trim(), t });
  }

  function renameFrame(n) {
    closeContextMenu();
    setRenamingFrame(n);
  }

  function startRenameFrame(event, kfNameEl) {
    const card = kfNameEl.closest('[data-kf-n]');
    if (!card) return;
    event.stopPropagation();
    setRenamingFrame(Number(card.dataset.kfN));
  }

  function setRenamingFrame(n) {
    const tactic = getActiveTactic(ctx.store.getDoc());
    const kf = tactic && tactic.keyframes.find((k) => k.n === n);
    if (!kf) return;
    renamingFrameN = n;
    render(ctx.store.getDoc(), ctx.store.getView());
    const input = el.querySelector('[data-role="rename-frame-input"]');
    if (input) {
      input.focus();
      input.select();
    }
  }

  function commitRenameFrame(n, rawValue) {
    const tactic = getActiveTactic(ctx.store.getDoc());
    const kf = tactic && tactic.keyframes.find((k) => k.n === n);
    renamingFrameN = null;
    suppressNextBlur = true;
    const name = (rawValue || '').trim();
    if (!kf || !name || name === kf.name) {
      render(ctx.store.getDoc(), ctx.store.getView());
      return;
    }
    ctx.exec({ type: 'doc/renameKeyframe', n, name });
  }

  function cancelRenameFrame() {
    renamingFrameN = null;
    suppressNextBlur = true;
    render(ctx.store.getDoc(), ctx.store.getView());
  }

  function duplicateFrame(n) {
    closeContextMenu();
    // core note: keyframeOps.duplicate keeps the source name verbatim — this UI follows up
    // with a rename appending " copy" so the duplicate is visually distinguishable.
    ctx.exec({ type: 'doc/duplicateKeyframe', n });
    const tactic = getActiveTactic(ctx.store.getDoc());
    const dup = tactic && tactic.keyframes.find((k) => k.n === n + 1);
    if (dup) {
      ctx.exec({ type: 'doc/renameKeyframe', n: dup.n, name: `${dup.name} copy` });
    }
  }

  function deleteFrame(n) {
    closeContextMenu();
    const tactic = getActiveTactic(ctx.store.getDoc());
    if (!tactic || tactic.keyframes.length <= 1) return; // last keyframe is not deletable
    const referenced = tactic.objects.some((obj) => obj.appearsAt === n);
    const ok = referenced
      ? window.confirm('Objects placed at this keyframe will shift to a neighboring frame. Delete anyway?')
      : true;
    if (!ok) return;
    ctx.exec({ type: 'doc/deleteKeyframe', n });
  }

  function closeContextMenu() {
    if (contextMenuN === null) return;
    contextMenuN = null;
    render(ctx.store.getDoc(), ctx.store.getView());
  }
}
