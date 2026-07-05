// Pure geometry helpers for TACTICA's map overlay: arrowheads, freehand thinning,
// world-unit distance conversion, and hit-testing. No DOM, no fetch, no Date/Math.random —
// deterministic by contract (core/ modules are imported by tools/ scripts too).

const ARROWHEAD_BASE_OFFSET = 2.0; // units back along the last segment (% of map width)
const ARROWHEAD_HALF_WIDTH = 1.25; // perpendicular half-width (% of map width)
const WORLD_SIZE_DEFAULT = 48000; // in-game units across the map (square world)
const PERCENT_SCALE = 100;
const TEXT_HIT_HALF_BOX = 2; // % — small fixed box around a text note's anchor
const EPSILON = 1e-9;

/**
 * @typedef {[number, number]} Point
 */

/**
 * Converts a percent-space point to "aspect-corrected" space where Euclidean distance
 * matches the visual distance on a non-square map (Y is compressed/expanded by aspect = h/w).
 * @param {Point} p
 * @param {number} aspect
 * @returns {Point}
 */
function toCorrected([x, y], aspect) {
  return [x, y / aspect];
}

/**
 * Converts an aspect-corrected point back to percent space.
 * @param {Point} p
 * @param {number} aspect
 * @returns {Point}
 */
function toPercent([x, y], aspect) {
  return [x, y * aspect];
}

/**
 * Walks backward from the end of a corrected-space polyline, returning the point that sits
 * exactly `distance` back from the tip (measured along the polyline), plus every corrected
 * point strictly before that landing point (for rebuilding the trimmed polyline).
 * Returns null if the polyline's total length is shorter than `distance` (degenerate: every
 * segment collapses, i.e. all points coincide).
 * @param {Point[]} corrected
 * @param {number} distance
 * @returns {{ base: Point, dir: Point, kept: Point[] } | null}
 */
function walkBackAlong(corrected, distance) {
  const tip = corrected[corrected.length - 1];
  let remaining = distance;
  let cursor = tip;

  for (let i = corrected.length - 2; i >= 0; i -= 1) {
    const prev = corrected[i];
    const segX = cursor[0] - prev[0];
    const segY = cursor[1] - prev[1];
    const segLen = Math.hypot(segX, segY);

    if (segLen < EPSILON) {
      // zero-length segment — skip it, keep walking back
      continue;
    }

    if (segLen >= remaining) {
      const ux = segX / segLen;
      const uy = segY / segLen;
      const base = [cursor[0] - ux * remaining, cursor[1] - uy * remaining];
      return { base, dir: [ux, uy], kept: corrected.slice(0, i + 1) };
    }

    remaining -= segLen;
    cursor = prev;
  }

  return null; // ran out of polyline before covering `distance`
}

/**
 * Computes a triangular arrowhead for the last segment of a route/sketch polyline, per
 * SPEC-export-package.md: tip at the last point, base 2.0 units back along the segment,
 * half-width 1.25 units. Coordinates are percent of map width; y is aspect-corrected so the
 * head renders visually symmetric on non-square maps. Degenerate last segments (zero-length,
 * or shorter than the head) walk back through earlier segments/points.
 * @param {Point[]} points
 * @param {{ aspect?: number, size?: number }} [opts]
 * @returns {{ tri: [Point, Point, Point] | null, trimmed: Point[] }}
 */
export function arrowhead(points, opts = {}) {
  const aspect = opts.aspect ?? 1;
  const size = opts.size ?? 1;

  if (points.length < 2) {
    return { tri: null, trimmed: points };
  }

  const corrected = points.map((p) => toCorrected(p, aspect));
  const baseOffset = ARROWHEAD_BASE_OFFSET * size;
  const halfWidth = ARROWHEAD_HALF_WIDTH * size;

  const walked = walkBackAlong(corrected, baseOffset);
  if (!walked) {
    return { tri: null, trimmed: points };
  }

  const { base, dir, kept } = walked;
  const tipCorrected = corrected[corrected.length - 1];
  const [ux, uy] = dir;
  // perpendicular to (ux,uy) is (-uy,ux)
  const leftCorrected = [base[0] - uy * halfWidth, base[1] + ux * halfWidth];
  const rightCorrected = [base[0] + uy * halfWidth, base[1] - ux * halfWidth];

  const tip = toPercent(tipCorrected, aspect);
  const left = toPercent(leftCorrected, aspect);
  const right = toPercent(rightCorrected, aspect);
  const baseP = toPercent(base, aspect);

  const trimmed = [...kept.map((p) => toPercent(p, aspect)), baseP];

  return { tri: [tip, left, right], trimmed };
}

/**
 * Perpendicular distance from point `p` to the line through `a`-`b` (or to `a` itself when
 * `a` and `b` coincide).
 * @param {Point} p
 * @param {Point} a
 * @param {Point} b
 * @returns {number}
 */
function perpendicularDistance([px, py], [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < EPSILON) {
    return Math.hypot(px - ax, py - ay);
  }
  // |cross product| / |base vector|
  const cross = Math.abs(dx * (ay - py) - (ax - px) * dy);
  return cross / Math.sqrt(lenSq);
}

/**
 * Douglas-Peucker recursive core: finds the point in points[start+1..end-1] farthest from the
 * chord points[start]-points[end]; if beyond epsilon, keeps it and recurses both halves.
 * @param {Point[]} points
 * @param {number} start
 * @param {number} end
 * @param {number} epsilon
 * @param {Set<number>} keepIndices
 */
function simplifySegment(points, start, end, epsilon, keepIndices) {
  if (end <= start + 1) {
    return;
  }

  let maxDist = -1;
  let maxIndex = -1;
  for (let i = start + 1; i < end; i += 1) {
    const dist = perpendicularDistance(points[i], points[start], points[end]);
    if (dist > maxDist) {
      maxDist = dist;
      maxIndex = i;
    }
  }

  if (maxDist > epsilon) {
    keepIndices.add(maxIndex);
    simplifySegment(points, start, maxIndex, epsilon, keepIndices);
    simplifySegment(points, maxIndex, end, epsilon, keepIndices);
  }
}

/**
 * Thins a freehand/route polyline via Douglas-Peucker perpendicular-distance simplification.
 * Endpoints are always preserved.
 * @param {Point[]} points
 * @param {number} [epsilon=0.35]
 * @returns {Point[]}
 */
export function simplify(points, epsilon = 0.35) {
  if (points.length < 3) {
    return points;
  }

  const lastIndex = points.length - 1;
  const keepIndices = new Set([0, lastIndex]);
  simplifySegment(points, 0, lastIndex, epsilon, keepIndices);

  return [...keepIndices].sort((a, b) => a - b).map((i) => points[i]);
}

/**
 * Converts a percent-space distance between two points into in-game world units. X and Y
 * share the same scale (the world is square).
 * @param {Point} a
 * @param {Point} b
 * @param {number} [worldSize=48000]
 * @returns {number}
 */
export function worldDistance(a, b, worldSize = WORLD_SIZE_DEFAULT) {
  const scale = worldSize / PERCENT_SCALE;
  const dx = (b[0] - a[0]) * scale;
  const dy = (b[1] - a[1]) * scale;
  return Math.hypot(dx, dy);
}

/**
 * Minimum distance from a point to any segment of a polyline.
 * @param {Point[]} points
 * @param {Point} pt
 * @returns {number}
 */
function minDistanceToPolyline(points, pt) {
  let min = Infinity;
  for (let i = 0; i < points.length - 1; i += 1) {
    min = Math.min(min, distanceToSegment(pt, points[i], points[i + 1]));
  }
  return min;
}

/**
 * Distance from point `p` to segment `a`-`b` (clamped to the segment, not the infinite line).
 * @param {Point} p
 * @param {Point} a
 * @param {Point} b
 * @returns {number}
 */
function distanceToSegment([px, py], [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < EPSILON) {
    return Math.hypot(px - ax, py - ay);
  }
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  const closestX = ax + t * dx;
  const closestY = ay + t * dy;
  return Math.hypot(px - closestX, py - closestY);
}

/**
 * Hit-tests a marker: size-aware box around its pre-resolved {x,y}. `tolPct` widens the box.
 * @param {{ size: number, resolved: {x:number,y:number} }} marker
 * @param {Point} pt
 * @param {number} tolPct
 * @returns {boolean}
 */
function hitTestMarker(marker, [px, py], tolPct) {
  // marker.size is in map-box px in the UI layer; core stays unit-agnostic and treats it as a
  // percent-equivalent half-box footprint scaled down, per the resolved-position contract —
  // callers pass a `size` already meaningful in the same units as `resolved`/`pt` (percent).
  const halfBox = marker.size / 2 + tolPct;
  const { x, y } = marker.resolved;
  return Math.abs(px - x) <= halfBox && Math.abs(py - y) <= halfBox;
}

/**
 * Hit-tests a route/sketch polyline: true when `pt` is within `tolPct` of any segment.
 * @param {{ points: Point[] }} obj
 * @param {Point} pt
 * @param {number} tolPct
 * @returns {boolean}
 */
function hitTestPolyline(obj, pt, tolPct) {
  if (obj.points.length < 2) {
    return false;
  }
  return minDistanceToPolyline(obj.points, pt) <= tolPct;
}

/**
 * Hit-tests a zone ellipse: true on fill (inside/on the ellipse) OR within `tolPct` of the
 * edge (so a thin-stroked zone with no fill is still clickable near its boundary).
 * @param {{ cx:number, cy:number, rx:number, ry:number }} zone
 * @param {Point} pt
 * @param {number} tolPct
 * @returns {boolean}
 */
function hitTestZoneEllipse(zone, [px, py], tolPct) {
  const { cx, cy, rx, ry } = zone;
  const dx = px - cx;
  const dy = py - cy;
  const norm = (dx / rx) ** 2 + (dy / ry) ** 2;
  if (norm <= 1) {
    return true; // fill hit
  }
  // approximate edge-distance tolerance: shrink tolerance into ellipse-normalized space by
  // checking against an ellipse expanded by tolPct on both radii
  const expanded = (dx / (rx + tolPct)) ** 2 + (dy / (ry + tolPct)) ** 2;
  return expanded <= 1;
}

/**
 * Point-in-polygon test via ray casting (even-odd rule), correct for both convex and concave
 * simple polygons (verified against a concave L-shape's notch). `points` need at least 3
 * vertices; the polygon is treated as implicitly closed (last vertex connects back to the
 * first) — callers do not need to repeat the first point at the end of the array.
 * @param {Point[]} points
 * @param {Point} pt
 * @returns {boolean}
 */
function pointInPolygon(points, [px, py]) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    const crosses = yi > py !== yj > py;
    if (!crosses) continue;
    const xIntersect = ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (px < xIntersect) inside = !inside;
  }
  return inside;
}

/**
 * Hit-tests a zone polygon: true when `pt` is inside the fill (ray-casting point-in-polygon,
 * correct on concave shapes) OR within `tolPct` of any edge — including the implicit closing
 * edge from the last vertex back to the first — mirroring hitTestZoneEllipse's fill-OR-edge-
 * tolerance behavior. Degenerate polygons (fewer than 3 points) always miss rather than throw.
 * @param {{ points: Point[] }} zone
 * @param {Point} pt
 * @param {number} tolPct
 * @returns {boolean}
 */
function hitTestZonePolygon(zone, pt, tolPct) {
  const points = zone.points;
  if (!Array.isArray(points) || points.length < 3) {
    return false;
  }
  if (pointInPolygon(points, pt)) {
    return true;
  }
  const closed = [...points, points[0]];
  return minDistanceToPolyline(closed, pt) <= tolPct;
}

/**
 * Dispatches zone hit-testing by `zone.shape`: 'polygon' uses point-in-polygon + edge
 * tolerance; anything else (including a missing `shape` field, for backward compatibility with
 * zone objects that predate the shape discriminator) falls back to the ellipse path.
 * @param {{ shape?: string }} zone
 * @param {Point} pt
 * @param {number} tolPct
 * @returns {boolean}
 */
function hitTestZone(zone, pt, tolPct) {
  if (zone.shape === 'polygon') {
    return hitTestZonePolygon(zone, pt, tolPct);
  }
  return hitTestZoneEllipse(zone, pt, tolPct);
}

/**
 * Hit-tests a text note: small fixed box around its anchor point.
 * @param {{ x:number, y:number }} text
 * @param {Point} pt
 * @param {number} tolPct
 * @returns {boolean}
 */
function hitTestText(text, [px, py], tolPct) {
  const halfBox = TEXT_HIT_HALF_BOX + tolPct;
  return Math.abs(px - text.x) <= halfBox && Math.abs(py - text.y) <= halfBox;
}

/**
 * Dispatches hit-testing by object kind: marker (size-aware box on a pre-resolved position),
 * route/sketch (polyline segment distance), zone (ellipse fill or edge), text (small box).
 * Unknown kinds return false rather than throwing.
 * @param {object} obj
 * @param {Point} pt
 * @param {number} tolPct
 * @returns {boolean}
 */
export function hitTest(obj, pt, tolPct) {
  switch (obj.kind) {
    case 'unit':
      return hitTestMarker(obj, pt, tolPct);
    case 'route':
    case 'sketch':
      return hitTestPolyline(obj, pt, tolPct);
    case 'zone':
      return hitTestZone(obj, pt, tolPct);
    case 'text':
      return hitTestText(obj, pt, tolPct);
    default:
      return false;
  }
}

/**
 * Bounding box of a polygon's vertices, plus the box's horizontal midpoint (`cx`) — the label
 * anchor for a polygon zone (renderZoneLabel-equivalent logic needs an {cx, top} pair to
 * position the label pill above the shape, mirroring how an ellipse zone anchors above
 * `cy - ry`). Deliberately the bounding-box midpoint rather than a full signed-area centroid:
 * simpler, no div-by-zero risk on a degenerate (near-zero-area) polygon, and visually
 * equivalent for the label-placement use case. Returns NaN bounds for an empty array rather
 * than throwing — callers should guard on `points.length` same as hitTestZonePolygon does.
 * @param {Point[]} points
 * @returns {{ minX:number, maxX:number, minY:number, maxY:number, cx:number }}
 */
export function polygonBounds(points) {
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return { minX, maxX, minY, maxY, cx: (minX + maxX) / 2 };
}

/**
 * Formats a battle-clock timestamp as "m:ss". Negative input clamps to "0:00".
 * @param {number} seconds
 * @returns {string}
 */
export function fmtClock(seconds) {
  const clamped = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(clamped / 60);
  const secs = clamped % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}
