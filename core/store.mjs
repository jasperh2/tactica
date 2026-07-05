// store.mjs — TACTICA core state store [core-state]
// Pure, dependency-free doc/view reducers + a tiny pub-sub store on top.
// No DOM, no fetch, no Date.now()/Math.random() — determinism for tests.
//
// Model logic that the contract flags as "don't reimplement" (id assignment,
// keyframe renumbering) delegates to ./playbook.mjs [core-model]. newTactic()
// is deliberately NOT called from inside reduceDoc: it has its own internal
// id counter, so calling it from the reducer would make reduceDoc impure
// (same (doc, action) input could yield different output). The UI calls
// playbook.newTactic(name, subtitle) itself and dispatches the built tactic.
import { keyframeOps, addObject, moveMarker } from './playbook.mjs';

// @typedef {import('./playbook.mjs').Tactic} Tactic
// @typedef {{ id:string, name:string, color:string, visible:boolean, locked:boolean }} Layer
// @typedef {{ mapId:string, layers:Layer[], tactics:Tactic[], activeTacticId:string }} DocState
// @typedef {{ thickness:number, dashed:boolean, head:'solid'|'open'|'none',
//             fillOpacity:number, border:number, textSize:number,
//             textChip:boolean, snap:boolean }} ToolOptions
// @typedef {{ tool:string, roleColor:string, activeLayerId:string,
//             currentKeyframe:number, playing:boolean, selection:(string|null),
//             armedUnit:(object|null), query:string,
//             rosterTab:'units'|'heroes'|'artillery'|'extra',
//             zoom:number, pan:{x:number,y:number}, toolOptions:ToolOptions }} ViewState

const DOC_PREFIX = 'doc/';
const VIEW_PREFIX = 'view/';

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

// Per-kind editable-property whitelist for doc/setObjectProps. Kinds not listed here
// (unit, route, sketch) have no editable-props seam yet — the action no-ops for them.
const OBJECT_PROPS_WHITELIST = {
  text: new Set(['text', 'size', 'chip']),
  zone: new Set(['label']),
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

  [`${DOC_PREFIX}moveObject`](doc, action) {
    return withActiveTactic(doc, (tactic) =>
      moveMarker(tactic, action.id, action.kf, { x: action.x, y: action.y })
    );
  },

  [`${DOC_PREFIX}resizeMarker`](doc, action) {
    return withActiveTactic(doc, (tactic) =>
      withObject(tactic, action.id, (obj) => ({ ...obj, size: action.size }))
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

  [`${DOC_PREFIX}clearPlaced`](doc) {
    return withActiveTactic(doc, (tactic) => ({ ...tactic, objects: [] }));
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

  [`${DOC_PREFIX}deleteLayer`](doc, action) {
    const fallbackLayerId = 'units';
    const layers = doc.layers.filter((l) => l.id !== action.id);
    const tactics = doc.tactics.map((tactic) => ({
      ...tactic,
      objects: tactic.objects.map((obj) =>
        obj.layerId === action.id ? { ...obj, layerId: fallbackLayerId } : obj
      ),
    }));
    return { ...doc, layers, tactics };
  },

  [`${DOC_PREFIX}newTactic`](doc, action) {
    return {
      ...doc,
      tactics: [...doc.tactics, action.tactic],
      activeTacticId: action.tactic.id,
    };
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
    return { ...view, selection: action.id };
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
