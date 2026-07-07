// store.mjs — TACTICA core state store [core-state]
// Pure, dependency-free doc/view reducers + a tiny pub-sub store on top.
// No DOM, no fetch, no Date.now()/Math.random() — determinism for tests.
//
// Model logic that the contract flags as "don't reimplement" (id assignment,
// keyframe renumbering) delegates to ./playbook.mjs [core-model]. newTactic()
// is deliberately NOT called from inside reduceDoc: it derives the new tactic id
// from the CURRENT doc's tactics (collision-free), which is the UI's job to supply
// — the UI calls playbook.newTactic(name, subtitle, doc.tactics) itself and
// dispatches the built tactic, keeping reduceDoc a pure (doc, action) -> doc.
import { keyframeOps, addObject, moveMarker, cloneTactic, duplicateObjectsInTactic } from './playbook.mjs';

// @typedef {import('./playbook.mjs').Tactic} Tactic
// @typedef {{ id:string, name:string, color:string, visible:boolean, locked:boolean }} Layer
// @typedef {{ mapId:string, layers:Layer[], tactics:Tactic[], activeTacticId:string }} DocState
// @typedef {{ thickness:number, dashed:boolean, head:'solid'|'open'|'none',
//             fillOpacity:number, border:number, textSize:number,
//             textChip:boolean, textPrefill:string, snap:boolean }} ToolOptions
// textPrefill (v2) is the Text tool's "next placement" label string — a VIEW preference only
// (set via view/setToolOption, read by drawtools' Text tool at click time), never a doc field,
// never persisted. Absent on a pre-v2 view seed; drawtools + the inspector both `?? ''` it.
// @typedef {{ text:string, background:boolean, size:number, position:string }} NextLabel
// @typedef {{ tool:string, roleColor:string, activeLayerId:string,
//             currentKeyframe:number, playing:boolean, selection:string[],
//             armedUnit:(object|null), query:string,
//             rosterTab:'units'|'heroes'|'artillery'|'extra',
//             sortMode:('rarity'|'type'), markerSize:number, nextLabel:NextLabel,
//             zoom:number, pan:{x:number,y:number}, toolOptions:ToolOptions }} ViewState
// sortMode is the Unit options panel's roster sort preference (sidebar-v2 S4, Jasper bug 3
// ruling 2026-07-05): 'rarity' (default, rarity-desc/name-asc, applies to every tab) or 'type'
// (Units tab only — 3 gameClass buckets melee/ranged/cavalry, see inspector-helpers.mjs).
// markerSize/nextLabel are the Unit options panel's "applies at next placement" preferences
// (design 1a U8/U9). NOTE for the next integration pass: canvas.mjs's handlePlaceClick
// currently hardcodes a local MARKER_SIZE_DEFAULT and has no label concept at all in the
// object model (units carry no `label` field — only zones do, via the setObjectProps
// whitelist) — wiring these view preferences into the actual placed-object shape is a
// cross-cutting change spanning canvas.mjs/playbook.mjs/exporter.mjs, none of which this
// stage owns (already flagged as an open build-scope delta in DECISIONS.md 2026-07-04: "unit
// label block (props + playbook export)"). This stage builds the view-state seam + UI only.
// selection is ALWAYS an array (empty = nothing selected) — multi-select rework, bug 5/6
// diagnosis. view/select accepts either the legacy {id} single-object payload (kept for
// drawtools.mjs's selectLatest(), which this store.mjs owner doesn't touch) or the new
// {ids, mode} payload; see the view/select reducer case below for exact semantics.

const DOC_PREFIX = 'doc/';
const VIEW_PREFIX = 'view/';

// Mirrors inspector.mjs's own DEFAULT_NEXT_LABEL (mockup defaults: 26px marker, 9px label,
// background on, south position) — kept here too, not imported (core must not depend on ui),
// so view/setNextLabel can merge against a COMPLETE object even on a real fresh boot where
// app.mjs's freshView() doesn't yet seed view.nextLabel (open seam, noted above). Spreading
// `undefined` (`{...view.nextLabel}` when nextLabel was never set) silently produces `{}`, not
// a throw — so before this fix, the FIRST setNextLabel dispatch of a session ever would leave
// nextLabel with only the one just-set key, permanently missing the other three defaults.
const DEFAULT_NEXT_LABEL = { text: '', background: true, size: 9, position: 'S' };

/**
 * Creates a minimal pub-sub store wrapping the pure doc/view reducers.
 * @param {DocState} doc
 * @param {ViewState} view
 */
export function createStore(doc, view) {
  let currentDoc = doc;
  let currentView = view;
  const listeners = new Set();

  function getDoc() {
    return currentDoc;
  }

  function getView() {
    return currentView;
  }

  function dispatch(action) {
    if (action && typeof action.type === 'string' && action.type.startsWith(DOC_PREFIX)) {
      currentDoc = reduceDoc(currentDoc, action);
    } else if (action && typeof action.type === 'string' && action.type.startsWith(VIEW_PREFIX)) {
      currentView = reduceView(currentView, action);
    }
    for (const listener of listeners) {
      listener(currentDoc, currentView, action);
    }
    return action;
  }

  function subscribe(fn) {
    listeners.add(fn);
    return function unsubscribe() {
      listeners.delete(fn);
    };
  }

  return { getDoc, getView, dispatch, subscribe };
}

// =============================================================================
// reduceDoc — pure DocState transitions
// =============================================================================

/**
 * @param {DocState} doc
 * @param {{type:string, [key:string]:unknown}} action
 * @returns {DocState}
 */
export function reduceDoc(doc, action) {
  const handler = docHandlers[action.type];
  return handler ? handler(doc, action) : doc;
}

function activeTacticIndex(doc) {
  return doc.tactics.findIndex((t) => t.id === doc.activeTacticId);
}

/** Replace the tactic at `index` with the result of `updater(tactic)`; no-op if not found. */
function withActiveTactic(doc, updater) {
  const index = activeTacticIndex(doc);
  if (index === -1) return doc;
  const nextTactic = updater(doc.tactics[index]);
  if (nextTactic === doc.tactics[index]) return doc;
  const tactics = doc.tactics.slice();
  tactics[index] = nextTactic;
  return { ...doc, tactics };
}

/**
 * Replace the object with `id` inside `tactic.objects` via `updater`; no-op (same tactic
 * reference) if not found OR if `updater` returns the same object reference back (e.g.
 * applyWhitelistedProps rejecting every key in props) — mirrors withActiveTactic's
 * reference-stability check so no-op dispatches stay cheap up the whole chain.
 */
function withObject(tactic, id, updater) {
  const index = tactic.objects.findIndex((o) => o.id === id);
  if (index === -1) return tactic;
  const nextObject = updater(tactic.objects[index]);
  if (nextObject === tactic.objects[index]) return tactic;
  const objects = tactic.objects.slice();
  objects[index] = nextObject;
  return { ...tactic, objects };
}

/** Replace the layer with `id` via `updater`; no-op if not found. */
function withLayer(doc, id, updater) {
  const index = doc.layers.findIndex((l) => l.id === id);
  if (index === -1) return doc;
  const nextLayer = updater(doc.layers[index]);
  const layers = doc.layers.slice();
  layers[index] = nextLayer;
  return { ...doc, layers };
}

// Per-kind editable-property whitelist for doc/setObjectProps. A kind absent here (or a props
// object with nothing whitelisted) no-ops. Extended 2026-07-06 so placed objects are editable
// after creation (audit OB1/OB2/OB3): unit gains a `label`; route/sketch gain their stroke/fill
// props + a `label`; zone gains fill/border/dashed alongside its label. The matching persist.mjs
// OBJECT_FIELD_KINDS whitelist must list any field added here or it is stripped on reload.
const OBJECT_PROPS_WHITELIST = {
  unit: new Set(['label']),
  text: new Set(['text', 'size', 'chip']),
  zone: new Set(['label', 'fillOpacity', 'border', 'dashed']),
  route: new Set(['thickness', 'dashed', 'head', 'label']),
  sketch: new Set(['thickness', 'dashed', 'head', 'fillOpacity', 'border', 'label']),
};

/**
 * Builds a new object from `obj` with only the keys in `props` that are on `obj.kind`'s
 * whitelist applied. Returns `obj` unchanged (same reference) if nothing qualifies, so
 * callers can no-op cheaply via reference-equality checks.
 * @param {{kind:string}} obj
 * @param {Record<string, unknown>} props
 * @returns {object}
 */
function applyWhitelistedProps(obj, props) {
  const whitelist = OBJECT_PROPS_WHITELIST[obj.kind];
  if (!whitelist) return obj;

  const allowedEntries = Object.entries(props).filter(([key]) => whitelist.has(key));
  if (allowedEntries.length === 0) return obj;

  return { ...obj, ...Object.fromEntries(allowedEntries) };
}

const docHandlers = {
  // Wholesale doc replacement — the undo/redo seam. commands.mjs snapshots whole DocStates,
  // so restoring one means swapping the store's doc entirely rather than field-patching it.
  // Also used to hydrate a doc restored from localStorage or a shared #pb= link at boot.
  [`${DOC_PREFIX}replace`](doc, action) {
    return action.doc;
  },

  [`${DOC_PREFIX}setMap`](doc, action) {
    return { ...doc, mapId: action.mapId };
  },

  [`${DOC_PREFIX}setActiveTactic`](doc, action) {
    return { ...doc, activeTacticId: action.tacticId };
  },

  [`${DOC_PREFIX}placeObject`](doc, action) {
    // Delegates id assignment to playbook.addObject (tactic.nextId counter) —
    // any id on action.object is ignored/overwritten, matching that contract.
    return withActiveTactic(doc, (tactic) => addObject(tactic, action.object));
  },

  // Copy/paste + duplicate objects: clone the given ids into keyframe `kf` with fresh ids and a
  // small offset (playbook.duplicateObjectsInTactic). One dispatch = one undo step for the paste.
  [`${DOC_PREFIX}duplicateObjects`](doc, action) {
    return withActiveTactic(doc, (tactic) =>
      duplicateObjectsInTactic(tactic, action.ids, action.kf, action.dx, action.dy)
    );
  },

  [`${DOC_PREFIX}moveObject`](doc, action) {
    return withActiveTactic(doc, (tactic) =>
      moveMarker(tactic, action.id, action.kf, { x: action.x, y: action.y })
    );
  },

  // Batched group-move (increment 5) — one dispatch for the whole gesture so app.mjs's
  // history-aware exec() pushes exactly one undo snapshot per drag, not one per object.
  [`${DOC_PREFIX}moveObjects`](doc, action) {
    return withActiveTactic(doc, (tactic) =>
      action.moves.reduce((t, move) => moveMarker(t, move.id, move.kf, { x: move.x, y: move.y }), tactic)
    );
  },

  [`${DOC_PREFIX}resizeMarker`](doc, action) {
    return withActiveTactic(doc, (tactic) =>
      withObject(tactic, action.id, (obj) => ({ ...obj, size: action.size }))
    );
  },

  // Batched group-resize (increment 6) — same one-snapshot rationale as moveObjects. Each
  // entry may also carry {kf, x, y} for the "scale about the selection bbox" case, so a
  // group-resize that repositions markers stays a single undo step.
  [`${DOC_PREFIX}resizeMarkers`](doc, action) {
    return withActiveTactic(doc, (tactic) =>
      action.resizes.reduce((t, resize) => {
        const sized = withObject(t, resize.id, (obj) => ({ ...obj, size: resize.size }));
        if (resize.kf === undefined) return sized;
        return { ...sized, objects: sized.objects.map((obj) =>
          obj.id === resize.id
            ? { ...obj, positions: { ...obj.positions, [resize.kf]: { x: resize.x, y: resize.y } } }
            : obj
        ) };
      }, tactic)
    );
  },

  [`${DOC_PREFIX}recolorObject`](doc, action) {
    return withActiveTactic(doc, (tactic) =>
      withObject(tactic, action.id, (obj) => ({ ...obj, role: action.role }))
    );
  },

  [`${DOC_PREFIX}setObjectProps`](doc, action) {
    // withActiveTactic/withObject already no-op (return the same reference) when the active
    // tactic or the object id isn't found; applyWhitelistedProps adds the third no-op case
    // (kind has no whitelist, or props contains nothing whitelisted) on the same contract,
    // so an unknown id / unknown kind / all-rejected-props dispatch returns `doc` unchanged.
    return withActiveTactic(doc, (tactic) =>
      withObject(tactic, action.id, (obj) => applyWhitelistedProps(obj, action.props))
    );
  },

  [`${DOC_PREFIX}deleteObject`](doc, action) {
    return withActiveTactic(doc, (tactic) => ({
      ...tactic,
      objects: tactic.objects.filter((o) => o.id !== action.id),
    }));
  },

  // Batched multi-select delete (increment 6) — one dispatch, one undo step for the whole
  // selection instead of N.
  [`${DOC_PREFIX}deleteObjects`](doc, action) {
    const idsToDelete = new Set(action.ids);
    return withActiveTactic(doc, (tactic) => ({
      ...tactic,
      objects: tactic.objects.filter((o) => !idsToDelete.has(o.id)),
    }));
  },

  [`${DOC_PREFIX}clearPlaced`](doc) {
    return withActiveTactic(doc, (tactic) => ({ ...tactic, objects: [] }));
  },

  // Erase panel's per-category "Clear" buttons (sidebar-v2 design 1c / CHANGES §3): removes
  // every object of one `kind` (unit/route/sketch/zone/text) from the active tactic, leaving
  // every other kind untouched. Undoable "for free" — app.mjs's exec() snapshots history for
  // any doc/*-prefixed action before dispatching it, same as clearPlaced/deleteObjects above.
  [`${DOC_PREFIX}clearByKind`](doc, action) {
    return withActiveTactic(doc, (tactic) => ({
      ...tactic,
      objects: tactic.objects.filter((o) => o.kind !== action.kind),
    }));
  },

  [`${DOC_PREFIX}addLayer`](doc, action) {
    return { ...doc, layers: [...doc.layers, action.layer] };
  },

  [`${DOC_PREFIX}renameLayer`](doc, action) {
    return withLayer(doc, action.id, (layer) => ({ ...layer, name: action.name }));
  },

  [`${DOC_PREFIX}toggleLayerVisible`](doc, action) {
    return withLayer(doc, action.id, (layer) => ({ ...layer, visible: !layer.visible }));
  },

  [`${DOC_PREFIX}toggleLayerLock`](doc, action) {
    return withLayer(doc, action.id, (layer) => ({ ...layer, locked: !layer.locked }));
  },

  [`${DOC_PREFIX}reorderLayer`](doc, action) {
    const fromIndex = doc.layers.findIndex((l) => l.id === action.id);
    if (fromIndex === -1) return doc;
    const layers = doc.layers.slice();
    const [moved] = layers.splice(fromIndex, 1);
    layers.splice(action.toIndex, 0, moved);
    return { ...doc, layers };
  },

  // Delete a layer. Never removes the LAST layer (persist.mjs treats a zero-layer doc as
  // irrecoverable and throws on reload — the UI must keep >=1; this reducer enforces the same
  // floor so a stray dispatch can't brick a saved playbook). CASCADE: every object on the removed
  // layer is DELETED with it (Jasper's "deletes cascade to children" rule) — NOT reassigned to a
  // fallback layer. The old reassign-to-'units' behaviour silently relocated content and, when
  // 'units' itself was the deleted layer, left objects pointing at a nonexistent id (they vanished
  // unannounced). The view must re-anchor activeLayerId separately via
  // playbook.pickActiveLayerAfterDelete — a reducer can't touch view state.
  [`${DOC_PREFIX}deleteLayer`](doc, action) {
    if (doc.layers.length <= 1) return doc;
    const layers = doc.layers.filter((l) => l.id !== action.id);
    if (layers.length === doc.layers.length) return doc; // unknown id — no-op
    const tactics = doc.tactics.map((tactic) => ({
      ...tactic,
      objects: tactic.objects.filter((obj) => obj.layerId !== action.id),
    }));
    return { ...doc, layers, tactics };
  },

  [`${DOC_PREFIX}setLayerColor`](doc, action) {
    return withLayer(doc, action.id, (layer) => ({ ...layer, color: action.color }));
  },

  [`${DOC_PREFIX}newTactic`](doc, action) {
    return {
      ...doc,
      tactics: [...doc.tactics, action.tactic],
      activeTacticId: action.tactic.id,
    };
  },

  // Delete a playbook. Never removes the LAST one (a doc always keeps >=1 tactic, same invariant
  // keyframes/layers hold). Deleting the active tactic re-anchors activeTacticId to a neighbour
  // (prefer the previous row). Cascade is implicit: a tactic owns its frames+objects, so removing
  // it removes them too — matching Jasper's "deletes cascade to children" rule.
  [`${DOC_PREFIX}deleteTactic`](doc, action) {
    if (doc.tactics.length <= 1) return doc;
    const index = doc.tactics.findIndex((t) => t.id === action.id);
    if (index === -1) return doc;
    const tactics = doc.tactics.filter((t) => t.id !== action.id);
    let activeTacticId = doc.activeTacticId;
    if (activeTacticId === action.id) {
      activeTacticId = (tactics[index - 1] ?? tactics[0]).id;
    }
    return { ...doc, tactics, activeTacticId };
  },

  // Duplicate a playbook as an independent, editable fork (collision-free id, all objects re-id'd,
  // starts unlocked). Becomes the active tactic. See playbook.cloneTactic.
  [`${DOC_PREFIX}duplicateTactic`](doc, action) {
    const source = doc.tactics.find((t) => t.id === action.id);
    if (!source) return doc;
    const clone = cloneTactic(source, doc.tactics, action.name);
    return { ...doc, tactics: [...doc.tactics, clone], activeTacticId: clone.id };
  },

  // Lock/unlock a playbook (NEW — accidental-edit guard for shared house playbooks). passwordHash
  // is set when provided (locking with a password) and preserved otherwise (a plain lock toggle).
  [`${DOC_PREFIX}setTacticLock`](doc, action) {
    const index = doc.tactics.findIndex((t) => t.id === action.id);
    if (index === -1) return doc;
    const tactics = doc.tactics.slice();
    tactics[index] = {
      ...tactics[index],
      locked: action.locked,
      passwordHash: action.passwordHash !== undefined ? action.passwordHash : tactics[index].passwordHash,
    };
    return { ...doc, tactics };
  },

  [`${DOC_PREFIX}renameTactic`](doc, action) {
    const index = doc.tactics.findIndex((t) => t.id === action.id);
    if (index === -1) return doc;
    const tactics = doc.tactics.slice();
    tactics[index] = { ...tactics[index], name: action.name, subtitle: action.subtitle };
    return { ...doc, tactics };
  },

  [`${DOC_PREFIX}addKeyframe`](doc, action) {
    return withActiveTactic(doc, (tactic) =>
      keyframeOps.add(tactic, { name: action.name, t: action.t })
    );
  },

  [`${DOC_PREFIX}renameKeyframe`](doc, action) {
    return withActiveTactic(doc, (tactic) => keyframeOps.rename(tactic, action.n, action.name));
  },

  [`${DOC_PREFIX}duplicateKeyframe`](doc, action) {
    return withActiveTactic(doc, (tactic) => keyframeOps.duplicate(tactic, action.n));
  },

  [`${DOC_PREFIX}deleteKeyframe`](doc, action) {
    return withActiveTactic(doc, (tactic) => keyframeOps.remove(tactic, action.n));
  },

  [`${DOC_PREFIX}reorderKeyframe`](doc, action) {
    // keyframeOps.reorder takes 1-based (from, to) POSITIONS, not array indices.
    // action.toIndex is documented/tested here as the 1-based target position.
    return withActiveTactic(doc, (tactic) => keyframeOps.reorder(tactic, action.n, action.toIndex));
  },

  [`${DOC_PREFIX}setNote`](doc, action) {
    return withActiveTactic(doc, (tactic) => ({
      ...tactic,
      notes: { ...tactic.notes, [action.kf]: action.text },
    }));
  },
};

// =============================================================================
// reduceView — pure ViewState transitions
// =============================================================================

/**
 * @param {ViewState} view
 * @param {{type:string, [key:string]:unknown}} action
 * @returns {ViewState}
 */
export function reduceView(view, action) {
  const handler = viewHandlers[action.type];
  return handler ? handler(view, action) : view;
}

/**
 * Computes the next selection array for a view/select dispatch. `ids` (new multi-select
 * payload) takes precedence over the legacy single-id `id` payload when both are present.
 * `mode` only applies to the `ids` payload — the legacy `id` payload is always a replace
 * (matches its old single-scalar-assignment behavior exactly, just array-shaped now).
 * @param {string[]} current
 * @param {{id?:(string|null), ids?:string[], mode?:('replace'|'add'|'toggle')}} action
 * @returns {string[]}
 */
function nextSelection(current, action) {
  if (action.ids !== undefined) {
    const mode = action.mode ?? 'replace';
    if (mode === 'add') {
      return [...current, ...action.ids.filter((id) => !current.includes(id))];
    }
    if (mode === 'toggle') {
      const toRemove = new Set(action.ids.filter((id) => current.includes(id)));
      const toAdd = action.ids.filter((id) => !current.includes(id));
      return [...current.filter((id) => !toRemove.has(id)), ...toAdd];
    }
    return [...action.ids];
  }
  return action.id ? [action.id] : [];
}

const viewHandlers = {
  [`${VIEW_PREFIX}setTool`](view, action) {
    return { ...view, tool: action.tool };
  },
  [`${VIEW_PREFIX}setRoleColor`](view, action) {
    return { ...view, roleColor: action.color };
  },
  [`${VIEW_PREFIX}setActiveLayer`](view, action) {
    return { ...view, activeLayerId: action.layerId };
  },
  [`${VIEW_PREFIX}select`](view, action) {
    return { ...view, selection: nextSelection(view.selection, action) };
  },
  [`${VIEW_PREFIX}armUnit`](view, action) {
    return { ...view, armedUnit: action.unit };
  },
  [`${VIEW_PREFIX}disarm`](view) {
    return { ...view, armedUnit: null };
  },
  [`${VIEW_PREFIX}setQuery`](view, action) {
    return { ...view, query: action.query };
  },
  [`${VIEW_PREFIX}setTab`](view, action) {
    return { ...view, rosterTab: action.tab };
  },
  [`${VIEW_PREFIX}setSortMode`](view, action) {
    return { ...view, sortMode: action.mode };
  },
  [`${VIEW_PREFIX}setMarkerSize`](view, action) {
    return { ...view, markerSize: action.size };
  },
  [`${VIEW_PREFIX}setNextLabel`](view, action) {
    return { ...view, nextLabel: { ...DEFAULT_NEXT_LABEL, ...view.nextLabel, [action.key]: action.value } };
  },
  [`${VIEW_PREFIX}setKeyframe`](view, action) {
    return { ...view, currentKeyframe: action.kf };
  },
  [`${VIEW_PREFIX}setPlaying`](view, action) {
    return { ...view, playing: action.playing };
  },
  [`${VIEW_PREFIX}setZoom`](view, action) {
    return { ...view, zoom: action.zoom };
  },
  [`${VIEW_PREFIX}setPan`](view, action) {
    return { ...view, pan: action.pan };
  },
  [`${VIEW_PREFIX}setToolOption`](view, action) {
    return { ...view, toolOptions: { ...view.toolOptions, [action.key]: action.value } };
  },
};
