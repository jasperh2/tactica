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
 * @returns {string|null}
 */
export function resolveHitId(objects, pt, tolPct) {
  for (let i = objects.length - 1; i >= 0; i -= 1) {
    const obj = objects[i];
    if (hitTest(toHitTestShape(obj), pt, tolPct)) return obj.id;
  }
  return null;
}

/** Adapts a resolved unit marker {x,y,size} into geometry.hitTest's marker contract
 * ({size, resolved:{x,y}}) — every other kind's shape already matches hitTest's expectations
 * as-is (route/sketch read .points, zone reads cx/cy/rx/ry, text reads x/y). */
function toHitTestShape(obj) {
  if (obj.kind !== 'unit') return obj;
  return { ...obj, resolved: { x: obj.resolved?.x ?? obj.x, y: obj.resolved?.y ?? obj.y } };
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
