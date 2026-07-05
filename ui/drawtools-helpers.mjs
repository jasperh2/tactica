// ui/drawtools-helpers.mjs — pure gesture math + ghost markup for drawtools.mjs [ui-draw]
// No DOM mutation happens here; callers own writing the returned strings into previewEl.
// Complex numeric work (arrowheads, simplification, distance) stays in core/geometry.mjs —
// this file only shapes those results into SVG fragments and small drag-state helpers.
import { arrowhead, hitTest } from '../core/geometry.mjs';
import { strokeWidthViewBox, dashArray, arrowheadSize } from '../core/stroke.mjs';
import { safeColor } from './sanitize.mjs';

const MIN_DRAG_PCT = 0.3; // ignore drags shorter than this (accidental click-drags)
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

const HEAD_OUTLINE_FACTOR = 0.6; // open-arrowhead outline width as a multiple of the stroke width
// — matches canvas-objects.mjs's HEAD_STROKE_FACTOR so the committed open-arrow outline matches
// the ghost's exactly (parity).

/**
 * SVG markup for a straight/polyline stroke ghost, with an optional arrowhead. `thickness` is the
 * authored width in SCREEN PX; it is converted to a viewBox stroke-width via the shared
 * core/stroke.mjs model — the SAME conversion the committed renderer (canvas-objects.mjs
 * renderRoute) applies to the same `thickness`, so the ghost and the committed stroke are
 * pixel-identical by construction. Pre-fix this wrote the raw px thickness straight into the
 * viewBox stroke-width, rendering 8-13x too thick (the ghost-inflation bug). `boxWidthPx` is the
 * on-screen map-box width the conversion needs.
 * @param {Point[]} points
 * @param {{color:string, thickness:number, dashed:boolean, head:'solid'|'open'|'none', aspect:number, boxWidthPx:number}} opts
 * @returns {string}
 */
export function strokeMarkup(points, { color, thickness, dashed, head, aspect, boxWidthPx }) {
  if (points.length < 2) return '';
  const safe = safeColor(color);
  const strokeWidth = strokeWidthViewBox(thickness, boxWidthPx);
  const [dashOn, dashOff] = dashArray(strokeWidth);
  const dash = dashed ? ` stroke-dasharray="${dashOn},${dashOff}"` : '';
  const { tri, trimmed } = head === 'none'
    ? { tri: null, trimmed: points }
    : arrowhead(points, { aspect, size: arrowheadSize(thickness) }); // head scales with px thickness
  const linePts = tri ? trimmed : points;

  const line = `<polyline points="${pointsAttr(linePts)}" fill="none" stroke="${safe}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round"${dash}/>`;

  if (!tri || head === 'none') return line;

  const fill = head === 'open' ? 'none' : safe;
  const strokeAttr = head === 'open' ? ` stroke="${safe}" stroke-width="${strokeWidth * HEAD_OUTLINE_FACTOR}"` : '';
  const triMarkup = `<polygon points="${pointsAttr(tri)}" fill="${fill}"${strokeAttr}/>`;
  return line + triMarkup;
}

/** SVG markup for a rect ghost (percent-space corner points). `border` is authored screen px,
 * converted to a viewBox stroke-width via the shared core/stroke.mjs model so the ghost matches
 * the committed shape (canvas-objects.mjs renderSketchShape) by construction — pre-fix the raw px
 * border went straight into viewBox units and rendered ~8-13x too thick. */
export function rectMarkup(a, b, { color, fillOpacity, border, dashed, boxWidthPx }) {
  const { x, y, w, h } = rectFromCorners(a, b);
  const safe = safeColor(color);
  const strokeWidth = strokeWidthViewBox(border, boxWidthPx);
  const [dashOn, dashOff] = dashArray(strokeWidth);
  const dash = dashed ? ` stroke-dasharray="${dashOn},${dashOff}"` : '';
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${safe}" fill-opacity="${fillOpacity / 100}" stroke="${safe}" stroke-width="${strokeWidth}"${dash}/>`;
}

/** SVG markup for an ellipse ghost (percent-space corner points). `border` screen px -> viewBox
 * via the shared model, matching the committed shape (see rectMarkup). */
export function ellipseMarkup(a, b, { color, fillOpacity, border, dashed, boxWidthPx }) {
  const { cx, cy, rx, ry } = ellipseFromCorners(a, b);
  const safe = safeColor(color);
  const strokeWidth = strokeWidthViewBox(border, boxWidthPx);
  const [dashOn, dashOff] = dashArray(strokeWidth);
  const dash = dashed ? ` stroke-dasharray="${dashOn},${dashOff}"` : '';
  return `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${safe}" fill-opacity="${fillOpacity / 100}" stroke="${safe}" stroke-width="${strokeWidth}"${dash}/>`;
}

/** SVG markup for a zone ghost/commit: dashed ellipse, fill @ fixed 13% per handoff README §3. */
const ZONE_FILL_OPACITY_PCT = 13;
const ZONE_BORDER_PX = 2; // authored screen-px zone border — converted to viewBox units via the
// shared core/stroke.mjs model at render time (matches canvas-objects.mjs's DEFAULT_BORDER_PX).
const ZONE_DASH = '6,4'; // fixed authored dash pattern for the zone's signature dashed outline.

export function zoneMarkup(a, b, { color, boxWidthPx }) {
  const { cx, cy, rx, ry } = ellipseFromCorners(a, b);
  const safe = safeColor(color);
  const strokeWidth = strokeWidthViewBox(ZONE_BORDER_PX, boxWidthPx);
  return `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${safe}" fill-opacity="${ZONE_FILL_OPACITY_PCT / 100}" stroke="${safe}" stroke-width="${strokeWidth}" stroke-dasharray="${ZONE_DASH}"/>`;
}

/**
 * SVG markup for a COMMITTED polygon zone: dashed closed polygon, same 13% fill treatment as
 * zoneMarkup (sibling helper — the committed-zone style, bug 4). A real `<polygon>` element
 * auto-closes visually and fills, which is exactly right for a finished zone but WRONG for the
 * in-progress authoring ghost (Jasper's v2 feedback: the auto-closing edge reads as a phantom
 * box, and the fill/dashes muddy what you're drawing). Authoring now uses polygonGhostMarkup
 * below; this helper is retained for the committed-zone identity (dashed outline + fill) that
 * exporter.mjs/SPEC treat as the zone's visual signature.
 * @param {Point[]} points
 * @param {{color:string}} opts
 * @returns {string} empty string when fewer than 2 points (nothing meaningful to preview yet)
 */
export function polygonMarkup(points, { color, boxWidthPx }) {
  if (points.length < 2) return '';
  const safe = safeColor(color);
  const strokeWidth = strokeWidthViewBox(ZONE_BORDER_PX, boxWidthPx);
  return `<polygon points="${pointsAttr(points)}" fill="${safe}" fill-opacity="${ZONE_FILL_OPACITY_PCT / 100}" stroke="${safe}" stroke-width="${strokeWidth}" stroke-dasharray="${ZONE_DASH}"/>`;
}

/**
 * SVG markup for the in-progress polygon-zone AUTHORING ghost (Jasper v2 fix): an OPEN
 * `<polyline>` over exactly the segments the user has drawn so far plus the single rubber-band
 * segment to the cursor — NO phantom closing edge (a polyline, unlike `<polygon>`, does not
 * auto-close the last vertex back to the first), NO fill (`fill="none"`, no fill-opacity), and a
 * SOLID stroke (no dasharray). This matches Excalidraw/tldraw, which draw an in-progress polygon
 * as a solid open path — you see only the edges you've actually placed, so authoring reads
 * clearly. The committed zone still renders dashed+filled via polygonMarkup / canvas-objects.mjs
 * (unchanged) — only the live authoring preview switches to this open, solid, fill-free form.
 * @param {Point[]} points every placed vertex, plus the cursor as the tentative next vertex
 * @param {{color:string}} opts
 * @returns {string} empty string when fewer than 2 points (a lone vertex has no segment to draw)
 */
export function polygonGhostMarkup(points, { color, boxWidthPx }) {
  if (points.length < 2) return '';
  const safe = safeColor(color);
  const strokeWidth = strokeWidthViewBox(ZONE_BORDER_PX, boxWidthPx);
  return `<polyline points="${pointsAttr(points)}" fill="none" stroke="${safe}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/>`;
}

/** Adapts a resolved unit marker {x,y,size} into geometry.hitTest's marker contract
 * ({size, resolved:{x,y}}) — every other kind's shape already matches hitTest's expectations
 * as-is (route/sketch read .points, zone reads its shape-specific fields, text reads x/y).
 * Mirrors canvas-helpers.mjs's toHitTestShape (a different panel's owned file) — duplicated
 * here rather than imported, per the no-cross-panel-imports rule; core/playbook.mjs's
 * visibleObjects() merges plain {x,y} onto unit objects the same way in both callers, so the
 * two copies read identical input shapes. */
function toEraseHitTestShape(obj, boxWidthPx) {
  if (obj.kind !== 'unit') return obj;
  const size = boxWidthPx > 0 ? (obj.size / boxWidthPx) * 100 : obj.size;
  return { ...obj, size, resolved: { x: obj.resolved?.x ?? obj.x, y: obj.resolved?.y ?? obj.y } };
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
 * @param {number} [boxWidthPx] current map-box layout width — marker `size` is stored in px,
 *   so it must be scaled into percent space exactly like canvas-helpers.mjs's resolveHitId does
 *   (without it, a size-26 marker's hit box spans 26% of the map and steals erase clicks)
 * @returns {string|null}
 */
export function resolveEraseTargetId(objects, pt, boxWidthPx) {
  for (let i = objects.length - 1; i >= 0; i -= 1) {
    const obj = objects[i];
    if (hitTest(toEraseHitTestShape(obj, boxWidthPx), pt, ERASE_HIT_TOLERANCE_PCT)) return obj.id;
  }
  return null;
}
