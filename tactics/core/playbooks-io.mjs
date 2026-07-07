// core/playbooks-io.mjs — pure JSON import/export + hydration helpers [core-io]
// The DOM-free half of the topbar's Export/Import controls (SP2) and boot-time global-save
// hydration (H2). Everything here is a pure (string|bytes) <-> doc transform on top of
// core/persist.mjs's versioned envelope — NO localStorage, NO fetch, NO Blob/anchor/download
// side effects. app.mjs owns the FileReader read, the Blob download, and the fetch of the
// shipped canonical file; this module only turns their raw text into a validated doc (or a
// serialized doc into a filename + text pair), so it stays unit-testable with mock strings.
//
// SECURITY: an imported .json and a shipped canonical .json are BOTH untrusted-input paths
// (the same threat class as the #pb= share link and the localStorage boot doc). They route
// through persist.deserialize — the single sanitization choke point — so a hostile/corrupt
// file is either sanitized field-by-field or rejected (fail-closed). This module never hands
// raw parsed JSON to a caller; it only ever returns what deserialize produced.

import { serialize, deserialize } from './persist.mjs';

// Navigation/creation actions — NEVER a content edit of a locked tactic, so always allowed even
// when the active tactic is locked. Blocking these soft-traps the playbook bar: you could lock the
// playbook you're on and then be unable to switch away, create a new one, or fork it (the designed
// "duplicate a locked playbook to edit a copy" path). doc/replace is a wholesale doc swap
// (import / map switch / undo-redo replay), not an edit of the locked tactic.
const LOCK_EXEMPT_ACTIONS = new Set([
  'doc/setTacticLock', // the unlock/relock action itself — otherwise you could never unlock
  'doc/setActiveTactic',
  'doc/newTactic',
  'doc/duplicateTactic',
  'doc/replace',
]);

// Actions that target ONE tactic by action.id (not the active one). These are blocked when the
// TARGET tactic is locked, regardless of which tactic is active — so a locked playbook can't be
// deleted or renamed with no password just because you switched to a different (unlocked) one.
// (delete is the worst "accidental edit" the lock exists to prevent.)
const TACTIC_TARGETED_ACTIONS = new Set(['doc/deleteTactic', 'doc/renameTactic']);

/**
 * Pure predicate: should app.mjs's exec() BLOCK this action because a lock applies?
 * (Password-lock enforcement — the write-guard half of the playbook lock.) Two axes:
 *   • CONTENT edits (place, move, resize, recolor, setObjectProps, deletes, clears, keyframe ops,
 *     setNote, layer ops, setMap) are blocked when the ACTIVE tactic is locked — you're editing what
 *     you're viewing, and that's locked.
 *   • TACTIC-TARGETED edits (delete/rename a specific playbook by id) are blocked when the TARGET
 *     tactic is locked, whichever tactic is active — otherwise a locked playbook is deletable/
 *     renamable no-password from another playbook.
 *   • Navigation/creation (switch/new/duplicate/replace) and non-doc actions (view/*) are never
 *     blocked. setTacticLock always passes so a lock can be undone.
 * Password verification is the lock-UI's job (PLAYBOOK lane), which only sets locked=false once the
 * hash matches. A missing tactic → not locked → not blocked.
 * @param {{type?:string, id?:string}} action
 * @param {{tactics?:Array<{id:string, locked?:boolean}>, activeTacticId?:string}} doc
 * @returns {boolean}
 */
export function isBlockedByLock(action, doc) {
  const type = action?.type;
  if (typeof type !== 'string' || !type.startsWith('doc/')) return false;
  if (LOCK_EXEMPT_ACTIONS.has(type)) return false;
  const tactics = doc?.tactics ?? [];
  const isLocked = (id) => Boolean(tactics.find((t) => t.id === id)?.locked);
  if (TACTIC_TARGETED_ACTIONS.has(type)) return isLocked(action?.id);
  return isLocked(doc?.activeTacticId);
}

/** A cross-platform-safe basename for the exported file: the mapId with anything outside
 *  [A-Za-z0-9._-] collapsed to a dash so an odd mapId can't produce an invalid download name. */
function safeMapSlug(mapId) {
  const slug = String(mapId ?? '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'map';
}

/**
 * Turns a DocState into the { fileName, text } pair the caller downloads. Pure — the caller
 * builds the Blob + anchor. text is the SAME versioned envelope persist.serialize writes to
 * localStorage, so an exported file is byte-for-byte a valid saved slot (round-trips through
 * importDocFromText below and through the boot loader).
 * @param {{mapId:string}} doc
 * @returns {{fileName:string, text:string}}
 */
export function exportDocToFile(doc) {
  return {
    fileName: `tactica-${safeMapSlug(doc.mapId)}.json`,
    text: serialize(doc),
  };
}

/**
 * Parses + sanitizes raw imported file text into a doc via persist.deserialize. Returns a
 * discriminated result rather than throwing so the caller can show an inline error and NEVER
 * crash the app on a malformed/hostile file (fail-closed per the SP2 brief). On success the
 * doc is fully sanitized (safe to doc/replace into the store).
 * @param {string} text
 * @returns {{ok:true, doc:object} | {ok:false, error:string}}
 */
export function importDocFromText(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    return { ok: false, error: 'The file is empty or could not be read as text.' };
  }
  try {
    return { ok: true, doc: deserialize(text) };
  } catch (err) {
    // persist.deserialize throws descriptive Errors for invalid JSON / bad schema / irrecoverable
    // shape; surface the message so the user knows WHY the import was rejected, not just that it was.
    return { ok: false, error: err instanceof Error ? err.message : 'Invalid playbook file.' };
  }
}

/**
 * Boot-time hydration of a shipped canonical playbook file (H2 — "1 house global state"): the
 * text fetched from data/playbooks/<mapId>.json. Same sanitization + fail-closed contract as
 * importDocFromText, but forces the resulting doc's mapId to agree with the slot it hydrates
 * (a canonical file mislabeled with the wrong mapId can never load the wrong terrain — mirrors
 * core/workspace.loadDocForMap's mapId-forcing).
 * @param {string} text
 * @param {string} mapId
 * @returns {{ok:true, doc:object} | {ok:false, error:string}}
 */
export function hydrateDocFromCanonicalText(text, mapId) {
  const result = importDocFromText(text);
  if (!result.ok) return result;
  return { ok: true, doc: { ...result.doc, mapId } };
}
