// commands.mjs — TACTICA undo/redo history [core-state]
// Snapshot-based undo of DocState only (contract §4). Pure data structure,
// no DOM, no timers — the UI is responsible for calling history.push(doc)
// before dispatching any doc/* action.
//
// @typedef {import('./store.mjs').DocState} DocState

const DEFAULT_LIMIT = 100;

/**
 * Creates an undo/redo snapshot stack over DocState.
 * `push` stores the pre-change doc; `undo(current)` returns the previous doc
 * and moves `current` onto the redo stack; `redo(current)` reverses that.
 * New pushes clear the redo stack. Oldest entries are evicted past `limit`.
 * @param {number} [limit=100]
 */
export function createHistory(limit = DEFAULT_LIMIT) {
  /** @type {DocState[]} */
  let undoStack = [];
  /** @type {DocState[]} */
  let redoStack = [];

  function push(doc) {
    undoStack = [...undoStack, doc];
    if (undoStack.length > limit) {
      undoStack = undoStack.slice(undoStack.length - limit);
    }
    redoStack = [];
  }

  function undo(current) {
    if (undoStack.length === 0) return current;
    const previous = undoStack[undoStack.length - 1];
    undoStack = undoStack.slice(0, -1);
    redoStack = [...redoStack, current];
    return previous;
  }

  function redo(current) {
    if (redoStack.length === 0) return current;
    const next = redoStack[redoStack.length - 1];
    redoStack = redoStack.slice(0, -1);
    undoStack = [...undoStack, current];
    return next;
  }

  function canUndo() {
    return undoStack.length > 0;
  }

  function canRedo() {
    return redoStack.length > 0;
  }

  // Clears both stacks. Used by app.mjs's map switch: undo must never cross a map boundary
  // (an undo snapshot of one map's doc replayed onto another map is nonsense/corruption), so
  // switching maps starts each map with a clean, empty history.
  function reset() {
    undoStack = [];
    redoStack = [];
  }

  return { push, undo, redo, canUndo, canRedo, reset };
}
