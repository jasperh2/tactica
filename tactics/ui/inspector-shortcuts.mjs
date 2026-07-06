// ui/inspector-shortcuts.mjs — global-window keyboard seam for the inspector [ui-inspector]
// Split out of inspector.mjs to keep that file under the 800-line cap (same -helpers-sibling
// convention as canvas-helpers.mjs/drawtools-helpers.mjs/exportmodal-helpers.mjs). Unlike
// inspector-helpers.mjs ("no DOM access" — pure render-fragment builders), this file's whole
// job IS touching window/document, so it stays separate from that module's contract.
//
// "/" focuses the roster search (mission item 4 / CHANGES-sidebar-v2.md §"[NEW]
// recommendations": "focuses the roster search from anywhere"). Guards mirror app.mjs's own
// isTypingTarget/isModalOpen (duplicated, not imported — no cross-panel imports; app.mjs is
// S1's owned file, not touched by this stage).

/**
 * True when "/" should NOT trigger the search-focus shortcut: already typing in an
 * input/textarea/contenteditable, or a modal is open (export modal etc. take priority).
 * @param {EventTarget|null} target
 */
function isSearchFocusBlocked(target) {
  if (['INPUT', 'TEXTAREA'].includes(target?.tagName) || target?.isContentEditable === true) {
    return true;
  }
  const modalRoot = typeof document !== 'undefined' ? document.getElementById('modal-root') : null;
  return !!modalRoot && modalRoot.childElementCount > 0;
}

/**
 * Registers the global "/" -> focus-roster-search shortcut. No-op under node:test (typeof
 * window is undefined there — same guard convention inspector.mjs's own document.activeElement
 * read already uses). One listener per call; every mount() in this codebase lives for the whole
 * page load (no unmount/remount lifecycle anywhere), so no teardown is needed.
 * @param {HTMLElement} el the inspector panel root, to query its live .roster-search input
 * @param {{store:{getView:Function}, exec:Function}} ctx
 */
export function installGlobalSearchFocus(el, ctx) {
  if (typeof window === 'undefined') return;
  window.addEventListener('keydown', (event) => {
    if (event.key !== '/' || isSearchFocusBlocked(event.target)) return;
    event.preventDefault();
    // Switch to Place first if needed — the search box only exists in that panel's markup.
    // exec()'s dispatch->subscribe->draw() chain is synchronous, so by the time exec() returns
    // the rebuilt innerHTML (with the search input) is already sitting in `el`.
    if (ctx.store.getView().tool !== 'place') ctx.exec({ type: 'view/setTool', tool: 'place' });
    el.querySelector('.roster-search')?.focus();
  });
}
