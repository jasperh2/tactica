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

let tacticCounter = 0;

/**
 * @param {{tactics:Tactic[], activeTacticId:string}} doc
 * @returns {Tactic|undefined}
 */
export function activeTactic(doc) {
  return doc.tactics.find((tactic) => tactic.id === doc.activeTacticId);
}

/**
 * Objects visible at `kf`: appearsAt <= kf AND their layer is visible.
 * Marker objects get their resolved {x,y} merged in via positionAt.
 * @param {Tactic} tactic
 * @param {Layer[]} layers
 * @param {number} kf
 * @returns {object[]}
 */
export function visibleObjects(tactic, layers, kf) {
  const visibleLayerIds = new Set(layers.filter((layer) => layer.visible).map((layer) => layer.id));

  return tactic.objects
    .filter((obj) => obj.appearsAt <= kf && visibleLayerIds.has(obj.layerId))
    .map((obj) => resolveObject(obj, kf));
}

function resolveObject(obj, kf) {
  if (obj.kind !== 'unit') return { ...obj };
  const { x, y } = positionAt(obj, kf);
  return { ...obj, x, y };
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
 * Count of objects on `layerId` visible by keyframe `kf` (layer-scoped, ignores visibility flag —
 * this is the layers-panel row count, distinct from visibleObjects).
 * @param {Tactic} tactic
 * @param {string} layerId
 * @param {number} kf
 * @returns {number}
 */
export function objectCountForLayer(tactic, layerId, kf) {
  return tactic.objects.filter((obj) => obj.layerId === layerId && obj.appearsAt <= kf).length;
}

/**
 * Fresh Tactic with one keyframe "Deploy" at "0:00".
 * @param {string} name
 * @param {string} subtitle
 * @returns {Tactic}
 */
export function newTactic(name, subtitle) {
  tacticCounter += 1;
  return {
    id: `t${tacticCounter}`,
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
 * Insert a copy of keyframe `n` immediately after it. Every keyframe after `n` shifts up by
 * one. Objects appearing strictly after `n` get appearsAt+1; positions keys > n shift up by
 * one, and the duplicated frame (new number n+1) inherits the position from frame n if present.
 * The source keyframe's note (if any) is likewise COPIED onto the duplicate — the useful
 * default for a "duplicate frame" authoring gesture, since the note likely still applies.
 * @param {Tactic} tactic @param {number} n @returns {Tactic}
 */
function duplicate(tactic, n) {
  const source = tactic.keyframes.find((kf) => kf.n === n);
  const before = tactic.keyframes.filter((kf) => kf.n <= n);
  const after = tactic.keyframes.filter((kf) => kf.n > n);
  const copy = { ...source, name: source.name };
  const keyframes = renumberKeyframes([...before, copy, ...after]);

  const mapAppearsAt = (old) => (old > n ? old + 1 : old);
  const mapPositionsKey = (old) => (old > n ? old + 1 : old);

  const objects = remapObjects(tactic.objects, mapAppearsAt, mapPositionsKey).map((obj) => {
    if (!obj.positions || obj.positions[n] === undefined) return obj;
    // duplicated frame is numbered n+1 after the shift above
    return { ...obj, positions: { ...obj.positions, [n + 1]: { ...obj.positions[n] } } };
  });

  const notes = remapNotes(tactic.notes, mapPositionsKey);
  if (tactic.notes?.[n] !== undefined) notes[n + 1] = tactic.notes[n]; // copy onto the duplicate

  return { ...tactic, keyframes, objects, notes };
}

/**
 * Remove keyframe `n`. Never removes the last remaining keyframe. Objects appearing after `n`
 * shift appearsAt down by one; objects appearing exactly at `n` clamp to the nearest surviving
 * frame. positions[n] is dropped; keys > n shift down by one. The removed keyframe's note (if
 * any) is deleted along with it; notes on later frames shift down the same way.
 * @param {Tactic} tactic @param {number} n @returns {Tactic}
 */
function remove(tactic, n) {
  if (tactic.keyframes.length <= 1) {
    return { ...tactic, keyframes: tactic.keyframes.map((kf) => ({ ...kf })), notes: { ...tactic.notes } };
  }

  const survivors = tactic.keyframes.filter((kf) => kf.n !== n);
  const keyframes = renumberKeyframes(survivors);
  const maxN = keyframes.length;

  const mapAppearsAt = (old) => {
    if (old < n) return old;
    if (old === n) return Math.max(1, Math.min(n, maxN));
    return Math.min(old - 1, maxN);
  };
  const mapPositionsKey = (old) => {
    if (old === n) return undefined; // dropped
    return old < n ? old : old - 1;
  };

  const objects = remapObjects(tactic.objects, mapAppearsAt, mapPositionsKey);
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
