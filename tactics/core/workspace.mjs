// core/workspace.mjs — per-map document routing [core-state]
// Each map owns its OWN DocState. Switching maps swaps the whole doc via the existing
// doc/replace seam (store.mjs docHandlers['doc/replace']) rather than reshaping the doc —
// so persist.mjs's security whitelist, the exporter, and the object model stay untouched.
//
// Pure + IO-injected: the switch logic (which slot to read, what a fresh map looks like, how
// the view re-anchors) lives here and is unit-tested with fakes; app.mjs supplies the real
// localStorage read + persist.deserialize + freshDoc(mapId). No DOM, no localStorage, no
// Date.now()/Math.random() — deterministic for tests, same discipline as the rest of core/.
//
// Jasper 2026-07-06 rulings baked in: NO migration of the pre-per-map single doc (wipe, start
// fresh — see LEGACY_DOC_KEY cleanup in app.mjs); recenter the camera on switch; each map's
// layers are independent (a fresh map gets the standard default layers, never a carry-over of
// the map you're leaving — that independence is a property of freshDoc, injected here).

/** Per-map localStorage key namespace: one serialized DocState envelope per map slot. */
export const DOC_KEY_PREFIX = 'tactica:doc:';

/** The pre-per-map single-doc key. Wiped (not migrated) on boot — kept as a named constant so
 *  app.mjs's one-time cleanup and this module agree on exactly which key is obsolete. */
export const LEGACY_DOC_KEY = 'tactica:doc';

/** @param {string} mapId @returns {string} */
export function docKey(mapId) {
  return DOC_KEY_PREFIX + mapId;
}

/**
 * The saved DocState for `mapId`, or a fresh one if the map has never been visited (or its slot
 * is corrupt/unreadable). Injected deps keep this pure and testable:
 *   read(key) -> string|null        localStorage.getItem (may throw -> treated as null)
 *   deserialize(str) -> DocState    persist.deserialize (may throw on corrupt/hostile input)
 *   freshDoc(mapId) -> DocState     app.freshDoc — seeds the standard layers + one tactic
 * The returned doc's `mapId` is FORCED to match its slot key, so a mislabeled/relocated slot can
 * never load the wrong map's terrain under the wrong picker selection.
 * @param {string} mapId
 * @param {{read:(key:string)=>(string|null), deserialize:(s:string)=>object, freshDoc:(mapId:string)=>object}} deps
 * @returns {object} DocState
 */
export function loadDocForMap(mapId, { read, deserialize, freshDoc }) {
  let raw = null;
  try {
    raw = read(docKey(mapId));
  } catch {
    raw = null; // storage blocked/disabled — fall through to a fresh doc
  }
  if (raw) {
    try {
      const doc = deserialize(raw);
      return { ...doc, mapId }; // force the doc's mapId to agree with its slot key
    } catch {
      /* corrupt/version-mismatched slot — fall through to a fresh doc, never throw */
    }
  }
  return freshDoc(mapId);
}

/**
 * View actions to dispatch (in order) immediately after a map switch's doc/replace. The outgoing
 * doc's selection ids and keyframe number reference objects/frames that no longer exist, and the
 * camera + active layer must re-anchor to the INCOMING doc:
 *   - selection cleared (its ids belong to the old map's objects)
 *   - keyframe -> 1 (the incoming tactic may have fewer frames than the old currentKeyframe)
 *   - camera reset to the fresh-view default (zoom 100 / pan 0,0) — maps differ in size, so
 *     preserving the old camera can strand you off-canvas (Jasper: recenter on switch)
 *   - active layer -> the incoming doc's first layer, so interactableObjects() (which gates ALL
 *     interaction on activeLayerId) never points at a layer id that existed only on the old map
 * @param {{layers:{id:string}[]}} incomingDoc
 * @returns {Array<{type:string, [k:string]:unknown}>}
 */
export function switchViewActions(incomingDoc) {
  const firstLayerId = incomingDoc.layers[0]?.id ?? 'units';
  return [
    { type: 'view/select', ids: [] },
    { type: 'view/setKeyframe', kf: 1 },
    { type: 'view/setZoom', zoom: 100 },
    { type: 'view/setPan', pan: { x: 0, y: 0 } },
    { type: 'view/setActiveLayer', layerId: firstLayerId },
  ];
}
