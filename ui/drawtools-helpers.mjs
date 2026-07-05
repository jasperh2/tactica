// ui/drawtools-helpers.mjs — pure gesture math + ghost markup for drawtools.mjs [ui-draw]
// No DOM mutation happens here; callers own writing the returned strings into previewEl.
// Complex numeric work (arrowheads, simplification, distance) stays in core/geometry.mjs —
// this file only shapes those results into SVG fragments and small drag-state helpers.
import { arrowhead, hitTest } from '../core/geometry.mjs';
import { safeColor } from './sanitize.mjs';

const MIN_DRAG_PCT = 0.3; // ignore drags shorter than this (accidental click-drags)
const METERS_PER_WORLD_UNIT = 1; // README: world units ARE the "in-game units" meters figure
const CLOSE_VERTEX_TOL_PCT = 1.5; // "click near the first vertex" close-gesture radius (% of map width)
// Erase-by-click hit tolerance (bug-hunt fix): matches canvas.mjs's HIT_TOLERANCE_PCT so the
// erase tool's forgiving click radius feels identical to the Select tool's — a click that would
// select an object also erases it. Kept as this module's own constant (not imported from
// canvas-helpers.mjs, a different panel's owned file) per the no-cross-panel-imports rule.
const ERASE_HIT_TOLERANCE_PCT = 1.6;

/**
 * @typedef {[number, number]} Point
 */

/** True when a drag from `a` to `b` is long enough to commit (not a stray click). */
export function isMeaningfulDrag(a, b) {
  return Math.hypot(b[0] - a[0], b[1] - a[1]) >= MIN_DRAG_PCT;
}

/**
 * True when `candidate` is within the polygon-closing tolerance radius of `points[0]` — the
 * Zone tool's "click near the first vertex to close" gesture (bug 4 fix). Deliberately a small,
 * fixed radius (distinct from MIN_DRAG_PCT, which governs a different gesture — "was this drag
 * long enough to count") so an ordinary next-vertex click elsewhere on the map is never
 * mistaken for a close. Returns false for an empty points array rather than throwing.
 * @param {Point[]} points
 * @param {Point} candidate
 * @returns {boolean}
 */
export function isNearFirstVertex(points, candidate) {
  if (points.length === 0) return false;
  const [fx, fy] = points[0];
  const [cx, cy] = candidate;
  return Math.hypot(cx - fx, cy - fy) <= CLOSE_VERTEX_TOL_PCT;
}

/** Axis-aligned rect {x,y,w,h} (percent space) spanning two corner points. */
export function rectFromCorners([x1, y1], [x2, y2]) {
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
}

/** Ellipse {cx,cy,rx,ry} centered between two drag corners (drag = bounding box, not radius). */
export function ellipseFromCorners([x1, y1], [x2, y2]) {
  return { cx: (x1 + x2) / 2, cy: (y1 + y2) / 2, rx: Math.abs(x2 - x1) / 2, ry: Math.abs(y2 - y1) / 2 };
}

/** Builds the polyline `points` attribute string for an SVG element from percent-space points.
 * Number()-coerces each coordinate at the interpolation site (belt-and-suspenders — these
 * points originate from live pointer-drag gestures, always numeric in practice, but the
 * coercion is free and keeps this module consistent with every other attribute sink). */
function pointsAttr(points) {
  return points.map(([x, y]) => `${Number(x)},${Number(y)}`).join(' ');
}

/**
 * SVG markup for a straight/polyline stroke ghost or commit, with an optional arrowhead.
 * @param {Point[]} points
 * @param {{color:string, thickness:number, dashed:boolean, head:'solid'|'open'|'none', aspect:number}} opts
 * @returns {string}
 */
export function strokeMarkup(points, { color, thickness, dashed, head, aspect }) {
  if (points.length < 2) return '';
  const safe = safeColor(color);
  const dash = dashed ? ` stroke-dasharray="${thickness * 2.2},${thickness * 1.6}"` : '';
  const { tri, trimmed } = head === 'none' ? { tri: null, trimmed: points } : arrowhead(points, { aspect });
  const linePts = tri ? trimmed : points;

  const line = `<polyline points="${pointsAttr(linePts)}" fill="none" stroke="${safe}" stroke-width="${thickness}" stroke-linecap="round" stroke-linejoin="round"${dash}/>`;

  if (!tri || head === 'none') return line;

  const fill = head === 'open' ? 'none' : safe;
  const strokeAttr = head === 'open' ? ` stroke="${safe}" stroke-width="${Math.max(1, thickness * 0.5)}"` : '';
  const triMarkup = `<polygon points="${pointsAttr(tri)}" fill="${fill}"${strokeAttr}/>`;
  return line + triMarkup;
}

/** SVG markup for a rect ghost/commit (percent-space corner points). */
export function rectMarkup(a, b, { color, fillOpacity, border, dashed }) {
  const { x, y, w, h } = rectFromCorners(a, b);
  const safe = safeColor(color);
  const dash = dashed ? ` stroke-dasharray="${border * 2.5},${border * 2}"` : '';
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${safe}" fill-opacity="${fillOpacity / 100}" stroke="${safe}" stroke-width="${border}"${dash}/>`;
}

/** SVG markup for an ellipse ghost/commit (percent-space corner points). */
export function ellipseMarkup(a, b, { color, fillOpacity, border, dashed }) {
  const { cx, cy, rx, ry } = ellipseFromCorners(a, b);
  const safe = safeColor(color);
  const dash = dashed ? ` stroke-dasharray="${border * 2.5},${border * 2}"` : '';
  return `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${safe}" fill-opacity="${fillOpacity / 100}" stroke="${safe}" stroke-width="${border}"${dash}/>`;
}

/** SVG markup for a zone ghost/commit: dashed ellipse, fill @ fixed 13% per handoff README §3. */
const ZONE_FILL_OPACITY_PCT = 13;
const ZONE_BORDER_PX = 2;

export function zoneMarkup(a, b, { color }) {
  const { cx, cy, rx, ry } = ellipseFromCorners(a, b);
  const safe = safeColor(color);
  return `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${safe}" fill-opacity="${ZONE_FILL_OPACITY_PCT / 100}" stroke="${safe}" stroke-width="${ZONE_BORDER_PX}" stroke-dasharray="6,4"/>`;
}

/**
 * SVG markup for a polygon zone ghost/commit: dashed closed polygon, same 13% fill treatment
 * as zoneMarkup (sibling helper — click-vertex zone authoring, bug 4 fix). Used both for the
 * in-progress rubber-band preview (as few as 2 points, an open-looking shape since a real
 * `<polygon>` element auto-closes visually) and the final commit markup.
 * @param {Point[]} points
 * @param {{color:string}} opts
 * @returns {string} empty string when fewer than 2 points (nothing meaningful to preview yet)
 */
export function polygonMarkup(points, { color }) {
  if (points.length < 2) return '';
  const safe = safeColor(color);
  return `<polygon points="${pointsAttr(points)}" fill="${safe}" fill-opacity="${ZONE_FILL_OPACITY_PCT / 100}" stroke="${safe}" stroke-width="${ZONE_BORDER_PX}" stroke-dasharray="6,4"/>`;
}

/**
 * Live measure-tool overlay: a plain line + a distance label near the midpoint.
 * Distance shown in world units (README: "world units 48000 across the map") and meters.
 * @param {Point} a @param {Point} b @param {number} worldDistancePct value already converted by geometry.worldDistance
 * @returns {string}
 */
export function measureMarkup(a, b, worldDistanceValue) {
  const midX = (a[0] + b[0]) / 2;
  const midY = (a[1] + b[1]) / 2;
  const meters = Math.round(worldDistanceValue * METERS_PER_WORLD_UNIT);
  const label = `${Math.round(worldDistanceValue)} units / ~${meters}m`;
  return (
    `<polyline points="${pointsAttr([a, b])}" fill="none" stroke="#ffffff" stroke-width="1.5" stroke-dasharray="4,3"/>` +
    `<text x="${midX}" y="${midY}" fill="#ffffff" font-size="3" font-family="monospace" text-anchor="middle" dominant-baseline="text-after-edge">${label}</text>`
  );
}

/** Adapts a resolved unit marker {x,y,size} into geometry.hitTest's marker contract
 * ({size, resolved:{x,y}}) — every other kind's shape already matches hitTest's expectations
 * as-is (route/sketch read .points, zone reads its shape-specific fields, text reads x/y).
 * Mirrors canvas-helpers.mjs's toHitTestShape (a different panel's owned file) — duplicated
 * here rather than imported, per the no-cross-panel-imports rule; core/playbook.mjs's
 * visibleObjects() merges plain {x,y} onto unit objects the same way in both callers, so the
 * two copies read identical input shapes. */
function toEraseHitTestShape(obj) {
  if (obj.kind !== 'unit') return obj;
  return { ...obj, resolved: { x: obj.resolved?.x ?? obj.x, y: obj.resolved?.y ?? obj.y } };
}

/**
 * Resolves the id of the topmost (last-in-array-wins, matching render z-order) object under
 * `pt` within the erase tool's forgiving hit tolerance — geometry-based via core/geometry.mjs's
 * hitTest, exactly mirroring the Select tool's click-resolution approach (canvas.mjs's
 * resolvePointerHit / canvas-helpers.mjs's resolveHitId) instead of the erase tool's old DOM
 * `event.target.closest('[data-id]')` lookup.
 *
 * Bug-hunt fix: the SVG annotation overlay sits visually above the markers layer, so a real
 * click on a unit marker's screen position often lands its `event.target` on the (pointer-
 * events-enabled) overlay `<svg>` element instead of the marker's own DOM node — closest()
 * from there never finds a `[data-id]` ancestor, and the erase click silently does nothing. This
 * resolves purely from the object list + a percent-space point, independent of DOM stacking, so
 * it hits kind:'unit' markers exactly as reliably as routes/zones/sketches/text.
 * @param {object[]} objects objects already visibility/lock-filtered by the caller, in RENDER
 *   order (last = drawn on top = highest erase priority) — same contract as canvas-helpers.mjs's
 *   resolveHitId.
 * @param {[number,number]} pt percent-space point (canvasApi.toPct's output shape)
 * @returns {string|null}
 */
export function resolveEraseTargetId(objects, pt) {
  for (let i = objects.length - 1; i >= 0; i -= 1) {
    const obj = objects[i];
    if (hitTest(toEraseHitTestShape(obj), pt, ERASE_HIT_TOLERANCE_PCT)) return obj.id;
  }
  return null;
}
