// ui/render.mjs — TACTICA export frame/overlay renderer [ui-export]
// Draws one keyframe (map + all annotations, OR annotations alone for overlays/) onto a
// <canvas> at SHIPPED_FRAME_WIDTH_PX wide, matching the DOM look closely: rounded-square
// markers with role color + icon/code, routes/line/free sketches via geometry.arrowhead,
// rect/ellipse sketches as filled+bordered shapes (dispatch ported from canvas-objects.mjs's
// renderSketch/renderSketchShape — see drawRouteOrSketch), dashed zone ellipses + label pill,
// text notes. Export renders ALL objects regardless of layer.visible — the core exporter
// deliberately ignores layer visibility for playbook.json, and frames must match playbook.json
// 1:1 (per contract §5), so this module does the same (independent-frames appearsAt===kf model,
// no layer-visibility filter).
//
// Not pure (draws to a real <canvas> and loads <img> elements) but holds no store/DOM-panel
// state of its own — a self-contained function of (doc-derived args) -> canvas.
import { arrowhead, polygonBounds } from '../core/geometry.mjs';
import { strokeWidthExportPx, dashArray, arrowheadSize } from '../core/stroke.mjs';

const SHIPPED_FRAME_WIDTH_PX = 900;
// Bug-hunt fix: overlays/ pass mapImg=null (exportmodal-helpers.mjs's renderAllFrames always
// calls renderFrame(..., null, roster) for the overlay half of each keyframe), so the OLD
// fallback here — Western City's own 786/822 asset ratio — silently applied to every map
// EXCEPT Western City, a ~4% height mismatch vs. frames/ (which DOES get the real ratio via
// mapImg.naturalHeight/naturalWidth) for 16 of the 17 maps in data/maps.json. Per that file,
// every map other than western-city (822x786) ships at 2071x2064 — this constant is that
// majority ratio, used only when the caller has NOT supplied an explicit mapAspect (see
// renderFrame's new parameter) and there is no mapImg to derive it from either. Once a caller
// threads the active map's real assetSize through as mapAspect, this constant stops mattering
// for that call; it remains the best available default for callers that don't (yet).
const MAJORITY_MAP_ASPECT = 2064 / 2071;
const MARKER_SIZE_PX = 26; // matches handoff default marker size (16-54 resizable range)
const MARKER_RADIUS_PX = 7;
const MARKER_BORDER_PX = 1.5;
const MARKER_FILL_ALPHA = 0.9;
const MARKER_FONT_PX = 9;
const ROUTE_ROUND = 'round';
const ZONE_DASH = [5, 4];
const ZONE_STROKE_PX = 2; // authored screen-px zone border (matches on-screen DEFAULT_BORDER_PX);
// scaled onto the export canvas via strokeWidthExportPx so it looks proportional to the editor.
const ZONE_FILL_ALPHA = 0.13;
const ZONE_LABEL_FONT_PX = 8.5;
const ZONE_LABEL_PAD_X = 6;
const ZONE_LABEL_PAD_Y = 4;
const ZONE_LABEL_GAP_PX = 6;
const MARKER_LABEL_GAP_PX = 3; // gap between marker bottom edge and its label pill (OB1)
const MARKER_LABEL_BOX_H = ZONE_LABEL_FONT_PX + ZONE_LABEL_PAD_Y * 2; // pill height (same pill metrics)
const ROUTE_LABEL_GAP_PX = 6; // gap above a route's last point for its label pill (OB1)
const TEXT_DEFAULT_SIZE_PX = 14;
const TEXT_CHIP_PAD_X = 6;
const TEXT_CHIP_PAD_Y = 4;
const FONT_UI = 'Hanken Grotesk, system-ui, -apple-system, sans-serif';
const FONT_MONO = 'JetBrains Mono, ui-monospace, monospace';
const ICON_LOAD_TIMEOUT_MS = 4000;
const SKETCH_FILL_OPACITY_DEFAULT = 14; // matches canvas-objects.mjs renderSketchShape default
const DEFAULT_ROUTE_THICKNESS_PX = 3; // matches app.mjs DEFAULT_TOOL_OPTIONS.thickness
const DEFAULT_SKETCH_BORDER_PX = 2; // matches app.mjs DEFAULT_TOOL_OPTIONS.border

const iconImageCache = new Map();

/**
 * Objects OWNED by frame `kf` (independent-frames model: appearsAt === kf), ignoring layer.visible
 * — matches core/exporter.mjs's frameObjects so the rendered frame PNG == that keyframe's
 * playbook.json state (see module note above).
 * @param {{objects:object[]}} tactic
 * @param {number} kf
 * @returns {object[]}
 */
function frameVisible(tactic, kf) {
  return tactic.objects.filter((obj) => obj.appearsAt === kf);
}

/** Last positions[k] with k<=kf, falling back to positions[appearsAt] (mirrors core/playbook.mjs). */
function resolvedPosition(marker, kf) {
  const keys = Object.keys(marker.positions ?? {})
    .map(Number)
    .filter((k) => k <= kf)
    .sort((a, b) => a - b);
  const key = keys.length ? keys[keys.length - 1] : marker.appearsAt;
  return marker.positions?.[key] ?? { x: 0, y: 0 };
}

/** Finds a roster entry (with its icon path, if any) across units/heroes/artillery/extra. */
function findRosterEntry(roster, code) {
  for (const key of ['units', 'heroes', 'artillery', 'extra']) {
    const entry = (roster?.[key] ?? []).find((r) => r.code === code);
    if (entry) return entry;
  }
  return null;
}

/**
 * Loads (and caches) a unit icon <img> by asset path. Resolves null on error/timeout so
 * callers fall back to the coded-tile drawing without failing the whole render.
 * @param {string} path
 * @returns {Promise<HTMLImageElement|null>}
 */
function loadIcon(path) {
  if (iconImageCache.has(path)) return iconImageCache.get(path);

  const promise = new Promise((resolve) => {
    const img = new Image();
    const timer = setTimeout(() => resolve(null), ICON_LOAD_TIMEOUT_MS);
    img.onload = () => {
      clearTimeout(timer);
      resolve(img);
    };
    img.onerror = () => {
      clearTimeout(timer);
      resolve(null);
    };
    img.src = path;
  });

  iconImageCache.set(path, promise);
  return promise;
}

/** Document-relative asset path, matching ui/topbar.mjs's convention (page root = index.html). */
function resolveAssetPath(assetPath) {
  return `./${assetPath}`;
}

/** Preloads every unit icon referenced by markers in `tactic`, so drawMarker can stay sync. */
async function preloadIcons(tactic, roster) {
  const codes = new Set(tactic.objects.filter((o) => o.kind === 'unit').map((o) => o.code));
  const loaded = new Map();
  await Promise.all(
    [...codes].map(async (code) => {
      const entry = findRosterEntry(roster, code);
      if (!entry?.icon) return;
      const img = await loadIcon(resolveAssetPath(entry.icon));
      if (img) loaded.set(code, img);
    })
  );
  return loaded;
}

/** px = percent * (dimension/100).
 *
 * Y-UNIT CONTRACT (Bug A, 2026-07-06): this export path is DELIBERATELY exempt from the
 * geometry.svgEmitY conversion the on-screen SVG overlay uses. The on-screen overlay draws into a
 * viewBox="0 0 100 (100*aspect)" WIDTH-unit space, so a stored height-percent y must be scaled by
 * aspect there. This canvas2d path instead maps y over the real height PX directly: toPx(py, h)
 * with h = size*aspect gives py/100 * h = py% of the height — already the correct height-percent
 * reading. Applying svgEmitY here too would DOUBLE-convert and reintroduce the ~4.6% drop. Stored
 * y is percent-of-height on BOTH axes' callers; only the width-unit viewBox needed the fix. */
function toPx(pct, dimPx) {
  return (pct / 100) * dimPx;
}

function withAlpha(hex, alpha) {
  const n = parseInt(hex.replace('#', ''), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Draws one unit marker: rounded square, role fill, icon image or mono code fallback. When the
 * marker carries a `label` (OB1 — now exported into playbook.json units[]), a mono pill is drawn
 * beneath it so the frame PNG stays faithful to the machine-readable spec (module header: frames
 * match playbook.json 1:1). */
function drawMarker(ctx, obj, kf, w, h, icons) {
  const pos = resolvedPosition(obj, kf);
  const cx = toPx(pos.x, w);
  const cy = toPx(pos.y, h);
  const size = MARKER_SIZE_PX;
  const x = cx - size / 2;
  const y = cy - size / 2;

  ctx.save();
  roundRectPath(ctx, x, y, size, size, MARKER_RADIUS_PX);
  ctx.fillStyle = withAlpha(obj.role, MARKER_FILL_ALPHA);
  ctx.fill();
  ctx.lineWidth = MARKER_BORDER_PX;
  ctx.strokeStyle = obj.role;
  ctx.stroke();

  const icon = icons.get(obj.code);
  if (icon) {
    ctx.save();
    roundRectPath(ctx, x, y, size, size, MARKER_RADIUS_PX);
    ctx.clip();
    ctx.drawImage(icon, x, y, size, size);
    ctx.restore();
  } else {
    ctx.fillStyle = '#ffffff';
    ctx.font = `700 ${MARKER_FONT_PX}px ${FONT_MONO}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(obj.code, cx, cy + 0.5);
  }
  ctx.restore();

  if (obj.label) {
    // Pill hangs BELOW the marker; drawLabelPill grows upward from its baselineY, so offset by the
    // pill height to sit clear of the marker bottom edge.
    const belowY = cy + size / 2 + MARKER_LABEL_GAP_PX + MARKER_LABEL_BOX_H;
    drawLabelPill(ctx, obj.label, cx, belowY);
  }
}

/**
 * Draws one route or sketch object, dispatching by kind/shape — ported from
 * canvas-objects.mjs's renderSketch()/renderSketchShape() so frames/overlays match the DOM
 * look exactly instead of routing every kind:'sketch' shape through the polyline-arrowhead
 * path (that bug drew rect/ellipse sketches as corner-to-corner diagonal arrows).
 *   - kind:'route' (the Arrow tool's movement-arrow output) and kind:'sketch' shape 'line'/
 *     'free': polyline + optional triangular arrowhead (route.head, default 'solid'; line/free
 *     sketches carry head:'none' already, but the dispatch mirrors canvas-objects.mjs by only
 *     drawing a head for kind:'route').
 *   - kind:'sketch' shape 'rect'/'ellipse': filled+bordered shape from the two corner points
 *     in `points`, no arrowhead — matches renderSketchShape's fill-opacity/border/dashed
 *     handling.
 * @param {object} obj route or sketch object
 * @param {number} w output width px
 * @param {number} h output height px
 */
function drawRouteOrSketch(ctx, obj, w, h) {
  if (obj.kind === 'sketch' && (obj.shape === 'rect' || obj.shape === 'ellipse')) {
    drawSketchShape(ctx, obj, w, h);
    return;
  }
  drawPolylineStroke(ctx, obj, w, h);
}

// drawPolylineStroke / drawSketchShape are exported ONLY so ui/render.test.mjs can drive them with
// a captured canvas2d stub (they mutate a real 2d context, so this is the only node-testable seam
// for the shared-stroke-model export widths); they are otherwise module-internal helpers.
/**
 * Draws a polyline stroke (route or line/free sketch) with an optional triangular arrowhead.
 * Stroke width + arrowhead size both flow through the shared core/stroke.mjs model so the exported
 * frame matches the on-screen editor by construction: the authored px thickness scales onto the
 * fixed export-canvas width (strokeWidthExportPx), and the arrowhead scales with the equivalent
 * stroke width the same way the on-screen head does (fixes the pre-fix pinned-tiny-head, which
 * always used the size=1 default here). */
export function drawPolylineStroke(ctx, obj, w, h) {
  if (!obj.points || obj.points.length < 2) return;
  const aspect = h / w;
  const thickness = obj.thickness ?? DEFAULT_ROUTE_THICKNESS_PX;
  // Arrowhead size scales with the authored px thickness — the SAME arrowheadSize(thicknessPx) the
  // on-screen surfaces use, so the exported head matches the editor head for a given thickness.
  const { tri, trimmed } = arrowhead(obj.points, { aspect, size: arrowheadSize(thickness) });
  const head = obj.head || 'solid'; // matches canvas-objects.mjs renderRoute's default

  ctx.save();
  ctx.strokeStyle = obj.role;
  ctx.lineWidth = strokeWidthExportPx(thickness, w);
  ctx.lineCap = ROUTE_ROUND;
  ctx.lineJoin = ROUTE_ROUND;
  if (obj.dashed) {
    const [dashOn, dashOff] = dashArray(ctx.lineWidth);
    ctx.setLineDash([dashOn, dashOff]);
  }

  const linePoints = tri && head !== 'none' ? trimmed : obj.points;
  ctx.beginPath();
  linePoints.forEach(([px, py], i) => {
    const X = toPx(px, w);
    const Y = toPx(py, h);
    if (i === 0) ctx.moveTo(X, Y);
    else ctx.lineTo(X, Y);
  });
  ctx.stroke();

  if (tri && head !== 'none') {
    ctx.setLineDash([]);
    ctx.beginPath();
    tri.forEach(([px, py], i) => {
      const X = toPx(px, w);
      const Y = toPx(py, h);
      if (i === 0) ctx.moveTo(X, Y);
      else ctx.lineTo(X, Y);
    });
    ctx.closePath();
    if (head === 'open') {
      ctx.stroke();
    } else {
      ctx.fillStyle = obj.role;
      ctx.fill();
    }
  }
  ctx.restore();

  // Route label (OB1 — now exported into playbook.json routes[]): mono pill above the last point,
  // so the frame PNG carries the same authored label as the machine-readable spec.
  if (obj.label) {
    const [lastX, lastY] = obj.points[obj.points.length - 1];
    drawLabelPill(ctx, obj.label, toPx(lastX, w), toPx(lastY, h) - ROUTE_LABEL_GAP_PX);
  }
}

/**
 * Draws a rect/ellipse sketch from its two corner points: filled at `fillOpacity` (default 14%),
 * bordered at `border` width, optionally dashed. Ported from canvas-objects.mjs's
 * renderSketchShape (SVG) to canvas2d — same corner math, same fill/border/dash defaults.
 */
export function drawSketchShape(ctx, sketch, w, h) {
  const [[x1pct, y1pct], [x2pct, y2pct]] = sketch.points;
  const x1 = toPx(x1pct, w);
  const y1 = toPx(y1pct, h);
  const x2 = toPx(x2pct, w);
  const y2 = toPx(y2pct, h);
  const fillAlpha = (sketch.fillOpacity ?? SKETCH_FILL_OPACITY_DEFAULT) / 100;
  // Border authored in screen px -> export device px via the shared model, SAME seam as the route
  // stroke and the on-screen border (pre-fix this drew the raw px border on the 900px canvas,
  // decoupled from the on-screen look).
  const borderWidth = strokeWidthExportPx(sketch.border ?? DEFAULT_SKETCH_BORDER_PX, w);

  ctx.save();
  ctx.fillStyle = withAlpha(sketch.role, fillAlpha);
  ctx.strokeStyle = sketch.role;
  ctx.lineWidth = borderWidth;
  if (sketch.dashed) {
    const [dashOn, dashOff] = dashArray(borderWidth);
    ctx.setLineDash([dashOn, dashOff]);
  }

  ctx.beginPath();
  if (sketch.shape === 'ellipse') {
    const cx = (x1 + x2) / 2;
    const cy = (y1 + y2) / 2;
    const rx = Math.abs(x2 - x1) / 2;
    const ry = Math.abs(y2 - y1) / 2;
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  } else {
    const x = Math.min(x1, x2);
    const y = Math.min(y1, y2);
    ctx.rect(x, y, Math.abs(x2 - x1), Math.abs(y2 - y1));
  }
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

/**
 * Draws one zone, dispatching on `zone.shape`: 'ellipse' (or a missing shape field, for
 * backward compat with zone objects that predate the shape discriminator) draws a dashed fill
 * ellipse; 'polygon' draws a dashed closed polygon path from `zone.points`. Both get a mono
 * label pill above the shape (if labeled) — ported from canvas-objects.mjs's renderZone/
 * renderPolygonZone dispatch so frames/overlays match the DOM look exactly (see module header).
 */
function drawZone(ctx, zone, w, h) {
  if (zone.shape === 'polygon') {
    drawPolygonZone(ctx, zone, w, h);
    return;
  }
  drawEllipseZone(ctx, zone, w, h);
}

function drawEllipseZone(ctx, zone, w, h) {
  const cx = toPx(zone.cx, w);
  const cy = toPx(zone.cy, h);
  const rx = toPx(zone.rx, w);
  const ry = toPx(zone.ry, h);

  ctx.save();
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  ctx.fillStyle = withAlpha(zone.role, ZONE_FILL_ALPHA);
  ctx.fill();
  ctx.setLineDash(ZONE_DASH);
  ctx.lineWidth = strokeWidthExportPx(ZONE_STROKE_PX, w);
  ctx.strokeStyle = zone.role;
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();

  if (zone.label) {
    drawLabelPill(ctx, zone.label, cx, cy - ry - ZONE_LABEL_GAP_PX);
  }
}

/**
 * Draws a polygon zone: dashed fill/stroke closed path from `zone.points` (percent-space,
 * converted to output px via toPx) + the same label-pill treatment as an ellipse zone. Label
 * anchors above the polygon's bounding-box top, horizontally centered on the bbox midpoint
 * (geometry.polygonBounds, converted to px) — matches canvas-objects.mjs's renderPolygonZone
 * label placement exactly.
 */
function drawPolygonZone(ctx, zone, w, h) {
  const points = Array.isArray(zone.points) ? zone.points : [];
  if (points.length < 3) return; // degenerate — nothing renderable, matches hitTest's guard

  const pxPoints = points.map(([x, y]) => [toPx(x, w), toPx(y, h)]);

  ctx.save();
  ctx.beginPath();
  pxPoints.forEach(([x, y], i) => {
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.closePath();
  ctx.fillStyle = withAlpha(zone.role, ZONE_FILL_ALPHA);
  ctx.fill();
  ctx.setLineDash(ZONE_DASH);
  ctx.lineWidth = strokeWidthExportPx(ZONE_STROKE_PX, w);
  ctx.strokeStyle = zone.role;
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();

  if (zone.label) {
    const bounds = polygonBounds(pxPoints);
    drawLabelPill(ctx, zone.label, bounds.cx, bounds.minY - ZONE_LABEL_GAP_PX);
  }
}

/** Draws a dark mono label pill centered horizontally at (cx, baselineY), growing upward. */
function drawLabelPill(ctx, label, cx, baselineY) {
  ctx.save();
  ctx.font = `700 ${ZONE_LABEL_FONT_PX}px ${FONT_MONO}`;
  const textW = ctx.measureText(label).width;
  const boxW = textW + ZONE_LABEL_PAD_X * 2;
  const boxH = ZONE_LABEL_FONT_PX + ZONE_LABEL_PAD_Y * 2;
  const x = cx - boxW / 2;
  const y = baselineY - boxH;

  roundRectPath(ctx, x, y, boxW, boxH, 5);
  ctx.fillStyle = 'rgba(8,10,14,0.8)';
  ctx.fill();

  ctx.fillStyle = '#eef1f6';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, cx, y + boxH / 2 + 0.5);
  ctx.restore();
}

/** Draws a text note: optional dark chip background behind the UI-font label. */
function drawTextNote(ctx, note, w, h) {
  const x = toPx(note.x, w);
  const y = toPx(note.y, h);
  const size = note.size || TEXT_DEFAULT_SIZE_PX;

  ctx.save();
  ctx.font = `600 ${size}px ${FONT_UI}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';

  if (note.chip) {
    const textW = ctx.measureText(note.text).width;
    const boxW = textW + TEXT_CHIP_PAD_X * 2;
    const boxH = size + TEXT_CHIP_PAD_Y * 2;
    roundRectPath(ctx, x - TEXT_CHIP_PAD_X, y - TEXT_CHIP_PAD_Y, boxW, boxH, 5);
    ctx.fillStyle = 'rgba(8,10,14,0.8)';
    ctx.fill();
  }

  ctx.fillStyle = note.role || '#eef1f6';
  ctx.fillText(note.text, x, y);
  ctx.restore();
}

/**
 * Resolves the h/w aspect ratio a rendered frame/overlay canvas should use (bug-hunt fix — pure
 * function, no DOM, so it is unit-testable without a browser). Priority order:
 *   1. `mapImg`'s own natural dimensions, when present (the frames/ case — always correct for
 *      whichever map is actually active, since it's the real loaded asset).
 *   2. An explicit `mapAspect` (h/w) the caller resolved from the active map's real
 *      `assetSize` (e.g. data/maps.json), when supplied — this is what lets the overlays/ case
 *      (which always passes `mapImg=null`) match frames/ for every map, not just Western City.
 *   3. MAJORITY_MAP_ASPECT — the best available default when neither of the above is present;
 *      correct for 16 of the 17 maps in data/maps.json (every one except western-city itself).
 * @param {{naturalWidth:number, naturalHeight:number}|null} mapImg
 * @param {number|null|undefined} mapAspect
 * @returns {number}
 */
export function resolveFrameAspect(mapImg, mapAspect) {
  if (mapImg) return mapImg.naturalHeight / mapImg.naturalWidth;
  if (typeof mapAspect === 'number' && Number.isFinite(mapAspect) && mapAspect > 0) return mapAspect;
  return MAJORITY_MAP_ASPECT;
}

/**
 * Renders one keyframe of `tactic` onto a fresh canvas. Draws the map image for frames/
 * (pass `mapImg`), or leaves the canvas transparent for overlays/ (pass `null`).
 * @param {object} doc unused directly (kept for API symmetry / future doc-level needs)
 * @param {object[]} layers unused — export ignores layer visibility (see module note)
 * @param {{objects:object[]}} tactic the active tactic
 * @param {number} kf 1-based keyframe number
 * @param {HTMLImageElement|null} mapImg preloaded map image, or null for a transparent overlay
 * @param {object} roster {units,heroes,artillery,extra} — resolves marker icons
 * @param {number} [size=900] output width in px; height derives from the resolved aspect ratio
 *   (see resolveFrameAspect) so overlay renders (mapImg=null) match their paired frame render
 *   for whichever map is actually active, not just Western City (bug-hunt fix).
 * @param {number} [mapAspect] the active map's real h/w aspect (e.g. from
 *   mapMeta.assetSize.h/assetSize.w in data/maps.json) — a caller that has this on hand should
 *   pass it for the overlay render (mapImg=null) so it doesn't silently fall back to
 *   MAJORITY_MAP_ASPECT. Ignored when `mapImg` is present (its natural size is authoritative).
 * @returns {Promise<HTMLCanvasElement>}
 */
export async function renderFrame(doc, layers, tactic, kf, mapImg, roster, size = SHIPPED_FRAME_WIDTH_PX, mapAspect) {
  const aspect = resolveFrameAspect(mapImg, mapAspect);
  const w = size;
  const h = Math.round(size * aspect);

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');

  if (mapImg) {
    ctx.drawImage(mapImg, 0, 0, w, h);
  }

  const visible = frameVisible(tactic, kf);
  const icons = await preloadIcons(tactic, roster);

  for (const zone of visible.filter((o) => o.kind === 'zone')) drawZone(ctx, zone, w, h);
  for (const obj of visible.filter((o) => o.kind === 'route' || o.kind === 'sketch')) {
    drawRouteOrSketch(ctx, obj, w, h);
  }
  for (const marker of visible.filter((o) => o.kind === 'unit')) drawMarker(ctx, marker, kf, w, h, icons);
  for (const note of visible.filter((o) => o.kind === 'text')) drawTextNote(ctx, note, w, h);

  void doc;
  void layers;
  return canvas;
}
