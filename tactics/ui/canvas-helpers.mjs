// ui/canvas-helpers.mjs — pure selection/marquee/group-transform math for canvas.mjs
// [ui-canvas]. No DOM here — canvas.mjs wires these into pointer events; kept separate so
// this non-trivial math (hit-test resolution, marquee bbox sweep, group-resize scaling) is
// unit-testable the same way drawtools-helpers.mjs/inspector-helpers.mjs already are, and to
// respect the file-size target on canvas.mjs (the biggest panel in the tool).
//
// Bugs 5/6 diagnosis (selection/multi-select/resize): the old click-select path resolved
// hits via DOM `event.target.closest('[data-id]')` with zero forgiving hit-radius — a click a
// few px outside a 26px marker silently cleared the selection instead of hitting it. This
// module's resolveHitId() replaces that with core/geometry.mjs's already-tested hitTest(),
// widened by a tolerance, so a near-miss still resolves.
import { hitTest } from '../core/geometry.mjs';

/**
 * Resolves the id of the top-most (last-drawn-wins, matching render z-order) object under
 * `pt` within `tolPct` tolerance. Objects must already carry a resolved position — markers
 * need `resolved:{x,y}` (geometry.hitTest's marker contract); routes/sketches/zones/text read
 * their own native shape fields directly, same as playbook.visibleObjects() already resolves
 * them for rendering.
 * @param {object[]} objects objects in RENDER order (last = drawn on top = highest priority)
 * @param {[number,number]} pt percent-space point
 * @param {number} tolPct hit-tolerance in percent-of-map-width units
 * @param {number} [boxWidthPx] on-screen map-box layout width; when given, unit marker `size`
 *   (stored in PX) is converted into percent-of-map-width before hit-testing. Without it a
 *   26px marker reads as a ±13%-of-map hit box and the top-most marker steals clicks map-wide.
 * @returns {string|null}
 */
export function resolveHitId(objects, pt, tolPct, boxWidthPx) {
  for (let i = objects.length - 1; i >= 0; i -= 1) {
    const obj = objects[i];
    if (hitTest(toHitTestShape(obj, boxWidthPx), pt, tolPct)) return obj.id;
  }
  return null;
}

/** Adapts a resolved unit marker {x,y,size} into geometry.hitTest's marker contract
 * ({size, resolved:{x,y}}, size in PERCENT units per its documented contract) — every other
 * kind's shape already matches hitTest's expectations as-is (route/sketch read .points, zone
 * reads cx/cy/rx/ry or .points, text reads x/y). Marker `size` is authored/stored in map-box
 * px, so it is scaled into percent space whenever the caller supplies the box width. */
function toHitTestShape(obj, boxWidthPx) {
  if (obj.kind !== 'unit') return obj;
  const size = boxWidthPx > 0 ? (obj.size / boxWidthPx) * 100 : obj.size;
  return { ...obj, size, resolved: { x: obj.resolved?.x ?? obj.x, y: obj.resolved?.y ?? obj.y } };
}

/**
 * Normalizes a drag gesture's two corner points into an axis-aligned rect, regardless of drag
 * direction (bottom-right-to-top-left drags are just as valid as the natural direction).
 * @param {[number,number]} start
 * @param {[number,number]} end
 * @returns {{x:number,y:number,w:number,h:number}}
 */
export function rectFromDrag([x1, y1], [x2, y2]) {
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
}

/**
 * True when `point` falls inside (or exactly on the boundary of) `rect`.
 * @param {{x:number,y:number,w:number,h:number}} rect
 * @param {[number,number]} point
 * @returns {boolean}
 */
export function rectIntersectsPoint(rect, [px, py]) {
  return px >= rect.x && px <= rect.x + rect.w && py >= rect.y && py <= rect.y + rect.h;
}

/** Per-kind anchor point used for the marquee-select sweep (point-in-rect, not full bbox
 * overlap — a lighter first pass per the fix plan; full bbox-overlap for large sketches/zones
 * is a documented fast-follow, not required for this increment). */
function anchorPoint(obj) {
  if (obj.kind === 'zone') return [obj.cx, obj.cy];
  if (obj.kind === 'route' || obj.kind === 'sketch') return obj.points[0];
  return [obj.x, obj.y]; // unit, text
}

/**
 * Sweeps `objects` (already resolved, already layer-visibility/lock filtered by the caller —
 * see canvas.mjs's marquee handler, which additionally excludes locked-layer objects before
 * calling this) and returns the ids whose anchor point falls inside `rect`.
 * @param {object[]} objects
 * @param {{x:number,y:number,w:number,h:number}} rect
 * @returns {string[]}
 */
export function marqueeMatches(objects, rect) {
  return objects.filter((obj) => rectIntersectsPoint(rect, anchorPoint(obj))).map((obj) => obj.id);
}

/**
 * Bounding box of a set of resolved {x,y} points — used for the multi-select group outline
 * and as the default anchor for group-resize ("scale about the selection bbox"). Point-only;
 * marker `size` is deliberately not factored in here (the outline is drawn a little outside
 * the tightest point-box by the caller's own render-time padding, keeping this helper simple
 * and reusable for non-unit kinds later).
 * @param {{x:number,y:number}[]} objects
 * @returns {{minX:number,minY:number,maxX:number,maxY:number}}
 */
export function groupBBox(objects) {
  const xs = objects.map((o) => o.x);
  const ys = objects.map((o) => o.y);
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

/**
 * Inflates a point-only group bbox outward by `padX`/`padY` (percent-of-map units) on every
 * side. The raw groupBBox is point-only (marker `size` deliberately not factored in there), so a
 * SINGLE selected unit collapses to a zero-area box at its own center — which is exactly the
 * "blue blob dead-center on the marker" defect. Padding by the selection's marker half-size (plus
 * a small margin) turns that into a real box framing the marker, and gives multi-select a little
 * breathing room outside its tightest point-box so corner handles sit clear of the outermost
 * markers. Pure geometry; the caller supplies the pad derived from marker size / map width.
 * @param {{minX:number,minY:number,maxX:number,maxY:number}} bbox
 * @param {number} padX percent-of-map-width padding per side
 * @param {number} padY percent-of-map-width padding per side (usually padX scaled by aspect)
 * @returns {{minX:number,minY:number,maxX:number,maxY:number}}
 */
export function padBBox(bbox, padX, padY = padX) {
  return {
    minX: bbox.minX - padX,
    minY: bbox.minY - padY,
    maxX: bbox.maxX + padX,
    maxY: bbox.maxY + padY,
  };
}

/**
 * The four named corners of a bbox, keyed nw/ne/sw/se (n=top/small-y, w=left/small-x — screen
 * convention). Used to (a) position the corner resize handles and (b) look up the OPPOSITE corner
 * as the scale anchor for a corner-grab resize.
 * @param {{minX:number,minY:number,maxX:number,maxY:number}} bbox
 * @returns {{nw:{x,y}, ne:{x,y}, sw:{x,y}, se:{x,y}}}
 */
export function bboxCorners(bbox) {
  return {
    nw: { x: bbox.minX, y: bbox.minY },
    ne: { x: bbox.maxX, y: bbox.minY },
    sw: { x: bbox.minX, y: bbox.maxY },
    se: { x: bbox.maxX, y: bbox.maxY },
  };
}

const OPPOSITE_CORNER = { nw: 'se', ne: 'sw', sw: 'ne', se: 'nw' };

/**
 * The point a corner-grab resize should scale ABOUT: the corner diagonally opposite the grabbed
 * one, which stays pinned while the grabbed corner tracks the pointer (standard editor resize —
 * tldraw/Excalidraw). Feed the result straight into scaleAboutAnchor as its `anchor`.
 * @param {{minX:number,minY:number,maxX:number,maxY:number}} bbox padded selection bbox
 * @param {'nw'|'ne'|'sw'|'se'} corner the grabbed corner
 * @returns {{x:number,y:number}}
 */
export function oppositeCornerAnchor(bbox, corner) {
  return bboxCorners(bbox)[OPPOSITE_CORNER[corner]];
}

/**
 * Pure decision for what a select/move pointerdown over the map should DO, given the current
 * selection, the id under the pointer (or null for empty ground), and whether Shift is held.
 * This is the fix for the "select-lock" defect: selection must switch on pointerDOWN (so the same
 * gesture can drag the freshly-selected object), empty ground must ALWAYS be able to marquee, and
 * shift is toggle-only (no drag) — the tldraw/Excalidraw model (see
 * knowledge/research/canvas-tool-interaction-patterns.md §1). Extracted as a pure function so the
 * routing contract is locked by a unit test and a future refactor can't silently reintroduce the
 * lock.
 *
 *   - hitId null                      -> 'marquee'      (empty ground: clear-or-marquee, movement
 *                                                        threshold decides which at commit time)
 *   - shift held, hitId set           -> 'toggle'       (add/remove from selection, never drags)
 *   - hitId already in selection      -> 'drag'         (drag the existing single/group selection)
 *   - hitId NOT in selection, no shift -> 'reselect-drag' (switch selection to it, THEN drag it)
 *
 * @param {string[]} selection current view.selection
 * @param {string|null} hitId id under the pointer, or null for empty ground
 * @param {boolean} shiftKey
 * @returns {'marquee'|'toggle'|'drag'|'reselect-drag'}
 */
export function selectGestureIntent(selection, hitId, shiftKey) {
  if (hitId === null || hitId === undefined) return 'marquee';
  if (shiftKey) return 'toggle';
  if (selection.includes(hitId)) return 'drag';
  return 'reselect-drag';
}

/**
 * Scales every object's position AND size outward/inward from `anchor` by `scaleFactor` —
 * the "scale about the selection bbox" group-resize math (increment 6). Distance-from-anchor
 * scales for x/y; size scales by the same factor, clamped to `opts.minSize`/`maxSize` if given
 * (matching inspector.mjs's MIN_MARKER_SIZE/MAX_MARKER_SIZE so a group-resize drag can't push
 * a marker's size outside what the single-object slider would ever allow).
 * @param {{id:string,x:number,y:number,size:number}[]} objects
 * @param {{x:number,y:number}} anchor
 * @param {number} scaleFactor
 * @param {{minSize?:number, maxSize?:number}} [opts]
 * @returns {{id:string,x:number,y:number,size:number}[]}
 */
export function scaleAboutAnchor(objects, anchor, scaleFactor, opts = {}) {
  const { minSize = -Infinity, maxSize = Infinity } = opts;
  return objects.map((obj) => {
    const x = anchor.x + (obj.x - anchor.x) * scaleFactor;
    const y = anchor.y + (obj.y - anchor.y) * scaleFactor;
    const size = Math.min(maxSize, Math.max(minSize, obj.size * scaleFactor));
    return { id: obj.id, x, y, size };
  });
}
