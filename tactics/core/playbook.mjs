// core/playbook.mjs — pure helpers over DocState. [core-model]
// No DOM, no fetch, no Date.now()/Math.random() — deterministic, tree-shaped like the
// contract's DocState/Tactic/Keyframe/MapObject shapes (docs/specs/tactics-tool-architecture.md §3-4).
//
// Every function here returns NEW objects; inputs are never mutated.

/** @typedef {{n:number, name:string, t:string}} Keyframe */
/** @typedef {{id:string, name:string, color:string, visible:boolean, locked:boolean}} Layer */
/**
 * @typedef {{id:string, name:string, subtitle:string, nextId:number,
 *   keyframes:Keyframe[], objects:object[], notes:Record<number,string>}} Tactic
 */

/**
 * @param {{tactics:Tactic[], activeTacticId:string}} doc
 * @returns {Tactic|undefined}
 */
export function activeTactic(doc) {
  return doc.tactics.find((tactic) => tactic.id === doc.activeTacticId);
}

/**
 * Objects OWNED by frame `kf` (independent-frames model, Jasper 2026-07-06): appearsAt === kf
 * AND their layer is visible. Each frame is its own board — an object placed while viewing frame
 * N belongs to frame N alone and never bleeds into N+1 (the pre-2026-07-06 model used
 * appearsAt <= kf, so everything placed on frame 1 also showed on every later frame, and deleting
 * it there deleted it everywhere — the "frames aren't unique" bug). Carry content across frames
 * deliberately via the "Duplicate frame" gesture (keyframeOps.duplicate), which clones a frame's
 * objects onto the next one. Marker objects get their resolved {x,y} merged in via positionAt.
 * @param {Tactic} tactic
 * @param {Layer[]} layers
 * @param {number} kf
 * @returns {object[]}
 */
export function visibleObjects(tactic, layers, kf) {
  const visibleLayerIds = new Set(layers.filter((layer) => layer.visible).map((layer) => layer.id));

  return tactic.objects
    .filter((obj) => obj.appearsAt === kf && visibleLayerIds.has(obj.layerId))
    .map((obj) => resolveObject(obj, kf));
}

function resolveObject(obj, kf) {
  if (obj.kind !== 'unit') return { ...obj };
  const { x, y } = positionAt(obj, kf);
  return { ...obj, x, y };
}

/**
 * Objects the ACTIVE layer's tools may interact with (Jasper's standing ruling: "you cannot
 * ever interact with another layer if its not active thats the point of layers" — the active
 * layer is the WHOLE interaction scope, non-active layers are strictly view-only). This is the
 * ONE shared gate every interaction path routes through — select/click, marquee, drag-move,
 * corner-resize, erase, Delete key, inspector single-object edits, and text-note inline
 * editing — so "what can this gesture touch" is defined exactly once, not re-derived per panel.
 *
 * Built as visibleObjects() (kf-appearance + layer-visibility, already resolved-position) plus
 * TWO additional narrowings, in order:
 *   1. active-layer scope — `obj.layerId === activeLayerId`, dropping every other layer's
 *      objects entirely (not merely refusing an action on them — they never become candidates,
 *      so a click that would land on a non-active-layer object behaves exactly like clicking
 *      empty ground: it starts a marquee / clears selection, same as the pre-existing
 *      locked-layer exclusion already worked).
 *   2. locked-OR-hidden guard on the active layer itself — kept from the pre-existing
 *      selectableObjects()/eraseCandidates()/clearableObjects() precedent: a locked or hidden
 *      ACTIVE layer yields an empty list (all its own objects become uninteractable too), not
 *      just "other layers are excluded."
 *
 * A layer that isn't `visible` was already excluded by visibleObjects() itself before this
 * function's own filters run, so hiding the active layer already empties the result via that
 * upstream check; the explicit `layer.visible === false` re-check here exists only so a caller
 * never has to special-case "what if activeLayerId itself resolves to no live layer" (a
 * malformed/missing activeLayerId falls through `layerById.get` to `undefined`, and
 * `!(undefined && ...)` is `true` — i.e. defensively NOT blocked — so an unresolvable
 * activeLayerId still gates purely on step 1's equality check, never throws, never mistakenly
 * unlocks everything).
 * @param {Tactic} tactic
 * @param {Layer[]} layers
 * @param {number} kf
 * @param {string} activeLayerId view.activeLayerId — the sole interaction scope
 * @returns {object[]}
 */
export function interactableObjects(tactic, layers, kf, activeLayerId) {
  const layerById = new Map(layers.map((layer) => [layer.id, layer]));
  return visibleObjects(tactic, layers, kf).filter((obj) => {
    if (obj.layerId !== activeLayerId) return false; // non-active layers are view-only
    const layer = layerById.get(obj.layerId);
    return !(layer && (layer.locked || layer.visible === false));
  });
}

/** Map-center fallback for a marker with no usable position data (contract: never throw). */
const POSITION_FALLBACK = { x: 50, y: 50 };

/**
 * Last positions[k] with k <= kf; falls back to positions[appearsAt]. Guards against a
 * malformed marker whose `positions` is missing, null, or empty — a hostile/corrupt doc that
 * slipped past persist.mjs's deserialize() (e.g. via a direct-construction path that doesn't
 * route through it) must degrade to a rendered-but-centered marker, not brick the first render
 * of the whole canvas.
 * @param {{appearsAt:number, positions:Record<number,{x:number,y:number}>}} marker
 * @param {number} kf
 * @returns {{x:number,y:number}}
 */
export function positionAt(marker, kf) {
  if (!marker.positions || Object.keys(marker.positions).length === 0) {
    return { ...POSITION_FALLBACK };
  }

  const bestKey = Object.keys(marker.positions)
    .map(Number)
    .filter((k) => k <= kf)
    .sort((a, b) => a - b)
    .pop();

  const key = bestKey !== undefined ? bestKey : marker.appearsAt;
  const resolved = marker.positions[key];
  return resolved ? { ...resolved } : { ...POSITION_FALLBACK };
}

/**
 * Count of objects on `layerId` OWNED by keyframe `kf` (layer-scoped, ignores visibility flag —
 * this is the layers-panel row count, distinct from visibleObjects). Independent-frames model:
 * appearsAt === kf, so the count reflects only what lives on the frame you are viewing.
 * @param {Tactic} tactic
 * @param {string} layerId
 * @param {number} kf
 * @returns {number}
 */
export function objectCountForLayer(tactic, layerId, kf) {
  return tactic.objects.filter((obj) => obj.layerId === layerId && obj.appearsAt === kf).length;
}

/**
 * Next collision-free tactic id ("t" + (max existing numeric suffix + 1)). Derived from the
 * CURRENT doc's tactics rather than a module counter: the old module counter reset to 0 on every
 * page reload, so the first playbook created after reloading a saved doc re-minted `t1` and
 * collided with the persisted starter tactic — two rows shared an id, activeTactic() always
 * resolved the first, and the new playbook could not be selected (Jasper 2026-07-06). Pure and
 * deterministic (no Date/Math.random).
 * @param {Tactic[]} existingTactics
 * @returns {string}
 */
function nextTacticId(existingTactics) {
  const maxNum = existingTactics.reduce((max, t) => {
    const match = /^t(\d+)$/.exec(t.id ?? '');
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
  return `t${maxNum + 1}`;
}

/**
 * Fresh Tactic with one keyframe "Deploy" at "0:00". Its id is derived from `existingTactics` so
 * it never collides with a tactic already in the doc (see nextTacticId). Callers MUST pass the
 * current doc's tactics; the default `[]` only fits the first-tactic-in-a-fresh-doc case.
 * @param {string} name
 * @param {string} subtitle
 * @param {Tactic[]} [existingTactics]
 * @returns {Tactic}
 */
export function newTactic(name, subtitle, existingTactics = []) {
  return {
    id: nextTacticId(existingTactics),
    name,
    subtitle,
    nextId: 1,
    keyframes: [{ n: 1, name: 'Deploy', t: '0:00' }],
    objects: [],
    notes: {},
  };
}

/**
 * Appends `obj` to the tactic, assigning id via tactic.nextId ("o" + counter).
 * @param {Tactic} tactic
 * @param {object} obj
 * @returns {Tactic}
 */
export function addObject(tactic, obj) {
  const id = `o${tactic.nextId}`;
  return {
    ...tactic,
    nextId: tactic.nextId + 1,
    objects: [...tactic.objects, { ...obj, id }],
  };
}

/**
 * Writes positions[kf] = xy for the marker matching id.
 * @param {Tactic} tactic
 * @param {string} id
 * @param {number} kf
 * @param {{x:number,y:number}} xy
 * @returns {Tactic}
 */
export function moveMarker(tactic, id, kf, xy) {
  return {
    ...tactic,
    objects: tactic.objects.map((obj) =>
      obj.id === id ? { ...obj, positions: { ...obj.positions, [kf]: { ...xy } } } : obj
    ),
  };
}

/**
 * Deep-clones a MapObject under a new id (positions/points get fresh nested copies so the clone
 * shares no reference with the source — editing one never mutates the other).
 * @param {object} obj @param {string} newId @returns {object}
 */
function deepCloneObject(obj, newId) {
  const clone = { ...obj, id: newId };
  if (obj.positions) {
    clone.positions = Object.fromEntries(
      Object.entries(obj.positions).map(([k, v]) => [k, { ...v }])
    );
  }
  if (obj.points) clone.points = obj.points.map((p) => [...p]);
  return clone;
}

/** Shifts whatever geometry an object carries by (dx,dy) IN PLACE on an already-cloned object. */
function offsetObjectGeometry(clone, kf, dx, dy) {
  if (clone.positions) {
    const at = positionAt(clone, kf);
    clone.positions = { [kf]: { x: at.x + dx, y: at.y + dy } };
  }
  if (clone.points) clone.points = clone.points.map(([x, y]) => [x + dx, y + dy]);
  if (typeof clone.x === 'number') clone.x += dx;
  if (typeof clone.y === 'number') clone.y += dy;
  if (typeof clone.cx === 'number') clone.cx += dx;
  if (typeof clone.cy === 'number') clone.cy += dy;
}

/**
 * Clones a whole tactic (playbook) as an independent copy: a collision-free id derived from
 * `existingTactics`, every object re-id'd from a fresh o1.. counter, and keyframes/notes deep-
 * copied. The clone starts UNLOCKED (a fork is meant to be edited) regardless of the source's
 * lock state. Pure — the source is never mutated.
 * @param {Tactic} source @param {Tactic[]} existingTactics @param {string} [name]
 * @returns {Tactic}
 */
export function cloneTactic(source, existingTactics, name) {
  let counter = 1;
  const objects = (source.objects ?? []).map((obj) => deepCloneObject(obj, `o${counter++}`));
  return {
    id: nextTacticId(existingTactics),
    name: name && name.trim() ? name.trim() : `${source.name} copy`,
    subtitle: source.subtitle ?? '',
    nextId: counter,
    keyframes: (source.keyframes ?? []).map((kf) => ({ ...kf })),
    objects,
    notes: { ...(source.notes ?? {}) },
  };
}

/**
 * Clones the objects with ids in `ids` into frame `kf` as independent copies (fresh ids from the
 * tactic's nextId counter, geometry offset by (dx,dy) so a paste doesn't perfectly overlap the
 * source). Used by copy/paste/duplicate. Returns a new tactic; unknown ids are skipped.
 * @param {Tactic} tactic @param {string[]} ids @param {number} kf @param {number} dx @param {number} dy
 * @returns {Tactic}
 */
export function duplicateObjectsInTactic(tactic, ids, kf, dx = 3, dy = 3) {
  const idSet = new Set(ids);
  const sources = tactic.objects.filter((o) => idSet.has(o.id));
  if (sources.length === 0) return tactic;
  let nextId = tactic.nextId;
  const clones = sources.map((obj) => {
    const clone = deepCloneObject(obj, `o${nextId++}`);
    clone.appearsAt = kf;
    offsetObjectGeometry(clone, kf, dx, dy);
    return clone;
  });
  return { ...tactic, nextId, objects: [...tactic.objects, ...clones] };
}

/**
 * Picks the layer id the view should re-anchor to after `deletedId` is removed (fixes the
 * dangling-active-layer bug: a deleted active layer would otherwise leave the draw tools stamping
 * a dead layerId). Returns the current active id when it survives, else the layer that took the
 * deleted one's slot (or the first remaining layer). `layers` is the list AFTER deletion.
 * @param {Layer[]} layers @param {string} deletedId @param {string} currentActiveId @returns {string}
 */
export function pickActiveLayerAfterDelete(layers, deletedId, currentActiveId) {
  if (currentActiveId !== deletedId && layers.some((l) => l.id === currentActiveId)) {
    return currentActiveId;
  }
  return layers[0]?.id ?? 'units';
}

// ---- keyframeOps ------------------------------------------------------------
// Keyframes are 1-based contiguous. Every op below remaps object appearsAt/positions keys
// so they stay consistent with the renumbered keyframe list — this is the classic corruption
// spot the contract flags explicitly.

/**
 * Remap a single frame-number key using `mapFn(oldN) -> newN|undefined`. Drops keys that map
 * to undefined. Used for appearsAt (scalar) and positions (object-keyed) remapping.
 */
function remapObjects(objects, mapAppearsAt, mapPositionsKey) {
  return objects.map((obj) => {
    const appearsAt = mapAppearsAt(obj.appearsAt);
    const positions = {};
    Object.entries(obj.positions ?? {}).forEach(([k, v]) => {
      const newKey = mapPositionsKey(Number(k));
      if (newKey !== undefined) positions[newKey] = v;
    });
    return { ...obj, appearsAt, ...(obj.positions ? { positions } : {}) };
  });
}

/**
 * Remap a frame-number-keyed record (tactic.notes shape) using the same `mapKey(oldN) ->
 * newN|undefined` convention as `remapObjects`'s positions remapping. Drops keys that map to
 * undefined. Keeps notes attached to their originating keyframe's content across renumbering —
 * the same corruption spot as object appearsAt/positions, just for tactic.notes.
 * @param {Record<number,string>} notes @param {(oldN:number) => number|undefined} mapKey
 * @returns {Record<number,string>}
 */
function remapNotes(notes, mapKey) {
  const result = {};
  Object.entries(notes ?? {}).forEach(([k, v]) => {
    const newKey = mapKey(Number(k));
    if (newKey !== undefined) result[newKey] = v;
  });
  return result;
}

function renumberKeyframes(keyframes) {
  return keyframes.map((kf, idx) => ({ ...kf, n: idx + 1 }));
}

/** @param {Tactic} tactic @param {{name:string,t:string}} spec @returns {Tactic} */
function add(tactic, spec) {
  const n = tactic.keyframes.length + 1;
  return {
    ...tactic,
    keyframes: [...tactic.keyframes, { n, name: spec.name, t: spec.t }],
  };
}

/** @param {Tactic} tactic @param {number} n @param {string} name @returns {Tactic} */
function rename(tactic, n, name) {
  return {
    ...tactic,
    keyframes: tactic.keyframes.map((kf) => (kf.n === n ? { ...kf, name } : kf)),
  };
}

/**
 * Insert a copy of keyframe `n` immediately after it. Every keyframe after `n` shifts up by one.
 * Independent-frames model (Jasper 2026-07-06): the inserted frame (n+1) receives its OWN CLONES
 * of frame n's objects — each a new object with a fresh id (from tactic.nextId) and its position
 * rekeyed to n+1 — so editing or deleting on the duplicate never reaches back into the source
 * frame. This is the deliberate "carry content to the next frame" gesture (contrast keyframeOps.add,
 * which makes an empty frame). Objects on frames strictly after `n` shift appearsAt/positions +1 to
 * make room. The source keyframe's note (if any) is COPIED onto the duplicate.
 * @param {Tactic} tactic @param {number} n @returns {Tactic}
 */
function duplicate(tactic, n) {
  const source = tactic.keyframes.find((kf) => kf.n === n);
  const before = tactic.keyframes.filter((kf) => kf.n <= n);
  const after = tactic.keyframes.filter((kf) => kf.n > n);
  const copy = { ...source, name: source.name };
  const keyframes = renumberKeyframes([...before, copy, ...after]);

  // Shift objects on frames strictly after n up by one to make room for the inserted frame.
  const mapAppearsAt = (old) => (old > n ? old + 1 : old);
  const mapPositionsKey = (old) => (old > n ? old + 1 : old);
  const shifted = remapObjects(tactic.objects, mapAppearsAt, mapPositionsKey);

  // Clone frame n's objects onto the new frame n+1 with fresh ids and rekeyed positions.
  let nextId = tactic.nextId;
  const clones = [];
  for (const obj of tactic.objects) {
    if (obj.appearsAt !== n) continue;
    const clone = { ...obj, id: `o${nextId}`, appearsAt: n + 1 };
    nextId += 1;
    if (obj.positions) {
      const pos = obj.positions[n];
      clone.positions = pos ? { [n + 1]: { ...pos } } : {};
    }
    clones.push(clone);
  }

  const objects = [...shifted, ...clones];
  const notes = remapNotes(tactic.notes, mapPositionsKey);
  if (tactic.notes?.[n] !== undefined) notes[n + 1] = tactic.notes[n]; // copy onto the duplicate

  return { ...tactic, keyframes, objects, nextId, notes };
}

/**
 * Remove keyframe `n`. Never removes the last remaining keyframe. Independent-frames model
 * (Jasper 2026-07-06): objects that lived ON the removed frame (appearsAt === n) are removed WITH
 * it — they were that frame's own content, so clamping them onto a neighbouring frame (the old
 * cumulative behaviour) would re-introduce the exact cross-frame bleed this model exists to
 * prevent. Objects on later frames shift appearsAt/positions down by one. The removed keyframe's
 * note is deleted along with it; notes on later frames shift down the same way.
 * @param {Tactic} tactic @param {number} n @returns {Tactic}
 */
function remove(tactic, n) {
  if (tactic.keyframes.length <= 1) {
    return { ...tactic, keyframes: tactic.keyframes.map((kf) => ({ ...kf })), notes: { ...tactic.notes } };
  }

  const survivors = tactic.keyframes.filter((kf) => kf.n !== n);
  const keyframes = renumberKeyframes(survivors);

  const kept = tactic.objects.filter((obj) => obj.appearsAt !== n);

  const mapAppearsAt = (old) => (old < n ? old : old - 1);
  const mapPositionsKey = (old) => (old === n ? undefined : old < n ? old : old - 1);

  const objects = remapObjects(kept, mapAppearsAt, mapPositionsKey);
  const notes = remapNotes(tactic.notes, mapPositionsKey);

  return { ...tactic, keyframes, objects, notes };
}

/**
 * Move the keyframe currently at position `from` to position `to` (1-based). Objects follow
 * their keyframe's CONTENT to its new number — i.e. remap by old-n -> new-n using the same
 * permutation applied to the keyframe list. Notes travel with their frame the same way.
 * @param {Tactic} tactic @param {number} from @param {number} to @returns {Tactic}
 */
function reorder(tactic, from, to) {
  if (from === to) {
    return { ...tactic, keyframes: tactic.keyframes.map((kf) => ({ ...kf })), notes: { ...tactic.notes } };
  }

  const list = [...tactic.keyframes];
  const [moved] = list.splice(from - 1, 1);
  list.splice(to - 1, 0, moved);

  // oldNToNewN[oldN] = newN, derived from where each original keyframe object landed in `list`.
  const oldNToNewN = new Map();
  list.forEach((kf, idx) => oldNToNewN.set(kf.n, idx + 1));

  const keyframes = renumberKeyframes(list);

  const mapAppearsAt = (old) => oldNToNewN.get(old) ?? old;
  const mapPositionsKey = (old) => oldNToNewN.get(old);

  const objects = remapObjects(tactic.objects, mapAppearsAt, mapPositionsKey);
  const notes = remapNotes(tactic.notes, mapPositionsKey);

  return { ...tactic, keyframes, objects, notes };
}

export const keyframeOps = { add, rename, duplicate, remove, reorder };
