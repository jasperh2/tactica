// ui/canvas-objects.mjs — [ui-canvas] render pipeline for the map box: markers, SVG overlay,
// HUD pills, and the top-level renderCanvas() orchestrator canvas.mjs calls on every store
// update. canvas.mjs owns all event wiring and DOM element handles; this module only writes
// into the elements it's handed. Split out to keep canvas.mjs under the file-size target.

import { activeTactic, visibleObjects } from '../core/playbook.mjs';
import { arrowhead, polygonBounds, svgEmitY, svgEmitPoints } from '../core/geometry.mjs';
import { strokeWidthViewBox, dashArray, arrowheadSize } from '../core/stroke.mjs';
import { round2, ZOOM_DEFAULT } from './canvas-view.mjs';
import { safeColor } from './sanitize.mjs';

const DEFAULT_THICKNESS_PX = 3; // matches app.mjs DEFAULT_TOOL_OPTIONS.thickness — an object with
// no stored thickness (shouldn't happen post-persist-coercion, defensive) falls back to this.
const DEFAULT_BORDER_PX = 2; // matches app.mjs DEFAULT_TOOL_OPTIONS.border for shape sketches.
const SEL_RING_FACTOR = 2.2; // selection ring width as a multiple of the object's stroke width.
const SEL_RING_SHAPE_FACTOR = 0.7; // thinner ring for filled shapes (zone/box/circle borders).
const HEAD_STROKE_FACTOR = 0.6; // open-arrowhead outline width as a multiple of the stroke width.

const MARKER_SIZE_DEFAULT = 26;
// Clamp bounds for the on-canvas resize handle (increment 2/6) — MUST stay numerically equal
// to inspector.mjs's own MIN_MARKER_SIZE/MAX_MARKER_SIZE (the Size slider's clamp range) so a
// handle-drag or group-resize can never push a marker's size outside what the slider allows.
// Kept as a same-value local const rather than a cross-panel import — this module is
// [ui-canvas], inspector.mjs is [ui-inspector], and both panels' own header comments document
// "no cross-panel imports" as a hard boundary.
export const MIN_MARKER_SIZE = 16;
export const MAX_MARKER_SIZE = 54;
const DEFAULT_ASPECT_W = 822;
const DEFAULT_ASPECT_H = 786;
const MARKER_DROP_MS = 220;

/**
 * @param {string} str
 * @returns {string}
 */
export function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[ch]);
}

/**
 * Finds the roster entry for a marker's unit code (units/heroes/artillery/extra), for icon
 * lookup. Returns undefined if not found (falls back to coded tile — same behavior as a
 * roster unit missing its `icon` field).
 * @param {object} roster
 * @param {string} code
 */
function findRosterEntry(roster, code) {
  return (
    roster.units.find((u) => u.code === code) ||
    roster.heroes.find((u) => u.code === code) ||
    roster.artillery.find((u) => u.code === code) ||
    (roster.extra || []).find((u) => u.code === code)
  );
}

/**
 * Renders one unit marker as an absolutely-positioned div (% left/top of the map box).
 * White selection ring; unit icon <img> when the roster entry has one, else mono code text.
 * @param {object} marker resolved marker (has x,y merged in by playbook.visibleObjects)
 * @param {object} roster
 * @param {string[]} selection
 * @returns {string}
 */
export function renderMarker(marker, roster, selection) {
  const size = Number(marker.size) || MARKER_SIZE_DEFAULT;
  const x = Number(marker.x) || 0;
  const y = Number(marker.y) || 0;
  const role = safeColor(marker.role);
  const isSelected = selection.includes(marker.id);
  const entry = findRosterEntry(roster, marker.code);
  // Icon paths in roster.json are relative to site/tactics/ (where index.html — the served
  // document — lives), so they resolve directly with no prefix.
  const content = entry && entry.icon
    ? `<img src="${escapeHtml(entry.icon)}" alt="" class="canvas-marker__icon" draggable="false" />`
    : `<span class="canvas-marker__code">${escapeHtml(marker.code)}</span>`;

  return `
    <div
      class="canvas-marker${isSelected ? ' is-selected' : ''}"
      data-id="${escapeHtml(marker.id)}"
      data-kind="unit"
      style="left:${x}%; top:${y}%; width:${size}px; height:${size}px;
        background:${hexToRgba(role, 0.9)}; border-color:${role};"
      title="${escapeHtml(marker.name || marker.code)}"
    >${content}</div>
  `;
}

/**
 * Renders a text note as an absolutely-positioned div.
 * @param {object} note
 * @param {string[]} selection
 * @returns {string}
 */
export function renderTextNote(note, selection) {
  const isSelected = selection.includes(note.id);
  const x = Number(note.x) || 0;
  const y = Number(note.y) || 0;
  const size = Number(note.size) || 14;
  const color = note.role ? safeColor(note.role) : '#eef1f6';
  const chipStyle = note.chip
    ? `background:rgba(8,10,14,.8); padding:2px 6px; border-radius:var(--radius-xs);`
    : '';
  return `
    <div
      class="canvas-textnote${isSelected ? ' is-selected' : ''}"
      data-id="${escapeHtml(note.id)}"
      data-kind="text"
      style="left:${x}%; top:${y}%; font-size:${size}px; color:${color}; ${chipStyle}"
    >${escapeHtml(note.text || '')}</div>
  `;
}

/**
 * Converts a #rrggbb hex color to an rgba() string at the given alpha. Falls back to the
 * literal color string if it's a valid-but-non-6-digit hex color (e.g. #rgb shorthand — passed
 * through safeColor() by callers but not this function's own int-math, which only handles
 * 6-digit) — never falls back to a raw unvalidated string: an input that fails safeColor's
 * pattern gets FALLBACK_COLOR, not laundered through untouched. Callers already run role colors
 * through ui/sanitize.mjs's safeColor() before reaching here (canvas-objects.mjs); this is the
 * belt-and-suspenders second check for the same contract, kept local so this module doesn't
 * need a two-hop import.
 * @param {string} hex
 * @param {number} alpha
 * @returns {string}
 */
export function hexToRgba(hex, alpha) {
  const validated = safeColor(hex);
  const match = /^#([0-9a-f]{6})$/i.exec(validated);
  if (!match) return validated;
  const int = parseInt(match[1], 16);
  const r = (int >> 16) & 255;
  const g = (int >> 8) & 255;
  const b = int & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

// ---- SVG overlay (routes, zones, sketches) ---------------------------------------------

/**
 * Builds the arrowhead triangle SVG points attribute from geometry.arrowhead's tri output.
 * @param {[[number,number],[number,number],[number,number]]|null} tri
 * @returns {string}
 */
function triToPoints(tri) {
  if (!tri) return '';
  return tri.map(([x, y]) => `${Number(x)},${Number(y)}`).join(' ');
}

/** Builds an SVG `points` attribute string from a percent-space [[x,y],...] array, coercing
 * every coordinate via Number() at the interpolation site (belt-and-suspenders on top of
 * persist.mjs's own coercion — contract fix-set item 3). */
function pointsAttr(points) {
  return points.map(([x, y]) => `${Number(x)},${Number(y)}`).join(' ');
}

/**
 * Renders a route (unit-to-unit push line): polyline + optional arrowhead triangle. The route's
 * OWN stored `thickness` (screen px) is converted to a viewBox stroke-width via the shared
 * core/stroke.mjs model — the SAME seam the ghost preview and the export path use, so all three
 * are pixel-identical by construction (parity fix). Pre-fix this ignored the object's stored
 * thickness entirely and used the current tool option, so every route rendered at one width that
 * changed live with the slider; now each route renders at its own authored width (matching what
 * the export path already did).
 * @param {object} route {points, role, thickness, dashed, head}
 * @param {function} arrowheadFn geometry.arrowhead, injected so this stays pure/testable-by-eye
 * @param {number} aspect map h/w, for arrowhead visual symmetry
 * @param {number} boxWidthPx on-screen map-box width (getBoundingClientRect().width) for px->viewBox
 * @param {string[]} selection
 * @returns {string}
 */
export function renderRoute(route, arrowheadFn, aspect, boxWidthPx, selection) {
  const isSelected = selection.includes(route.id);
  const head = route.head || 'solid';
  const role = safeColor(route.role);
  const thicknessPx = route.thickness ?? DEFAULT_THICKNESS_PX;
  const strokeWidthPct = strokeWidthViewBox(thicknessPx, boxWidthPx);
  const [dashOn, dashOff] = dashArray(strokeWidthPct);
  const dash = route.dashed ? `stroke-dasharray="${dashOn},${dashOff}"` : '';
  let points = route.points;
  let headMarkup = '';

  if (head !== 'none' && points.length >= 2) {
    // Head size scales with the AUTHORED px thickness (not the tiny viewBox-unit width) — see
    // core/stroke.mjs arrowheadSize, which fixes the old Math.max(...,1) pinned-head floor.
    const { tri, trimmed } = arrowheadFn(points, { aspect, size: arrowheadSize(thicknessPx) });
    if (tri) {
      points = trimmed;
      const fill = head === 'open' ? 'none' : role;
      // tri is in STORED percent space (arrowhead uses aspect for symmetry only); emit its y into
      // the overlay's viewBox width-units at the SVG boundary (Bug A), same as the line points.
      headMarkup = `<polygon points="${triToPoints(svgEmitPoints(tri, aspect))}" fill="${fill}" stroke="${role}" stroke-width="${strokeWidthPct * HEAD_STROKE_FACTOR}" stroke-linejoin="round" />`;
    }
  }

  // Stored points are percent-of-HEIGHT in y; emit into viewBox width-units (Bug A) so committed
  // == ghost == cursor. x is unchanged.
  const pts = pointsAttr(svgEmitPoints(points, aspect));
  const selRing = isSelected
    ? `<polyline points="${pts}" fill="none" stroke="#ffffff" stroke-width="${strokeWidthPct * SEL_RING_FACTOR}" stroke-linecap="round" stroke-linejoin="round" opacity="0.5" />`
    : '';

  return `
    <g data-id="${escapeHtml(route.id)}" data-kind="${escapeHtml(route.kind)}" class="canvas-svg-obj${isSelected ? ' is-selected' : ''}">
      ${selRing}
      <polyline points="${pts}" fill="none" stroke="${role}" stroke-width="${strokeWidthPct}"
        stroke-linecap="round" stroke-linejoin="round" ${dash} />
      ${headMarkup}
    </g>
  `;
}

/**
 * Renders a zone, dispatching on `zone.shape`: 'ellipse' (or a missing shape field, for
 * backward compat with zone objects that predate the shape discriminator) draws a dashed
 * ellipse; 'polygon' draws a dashed closed polygon from `zone.points`. Both get a mono label
 * pill above the shape (SVG text on a dark rect) when `zone.label` is set — the ellipse branch
 * is byte-identical to before this dispatch was added (regression safety).
 * @param {object} zone {shape?, cx,cy,rx,ry, points, role, label}
 * @param {number} boxWidthPx on-screen map-box width for the shared px->viewBox stroke conversion
 * @param {number} aspect map h/w — the SVG Y-unit boundary (Bug A): cy/ry/points y are
 *   percent-of-height and get emitted into viewBox width-units (svgEmitY) here.
 * @param {string[]} selection
 * @returns {string}
 */
export function renderZone(zone, boxWidthPx, aspect, selection) {
  if (zone.shape === 'polygon') {
    return renderPolygonZone(zone, boxWidthPx, aspect, selection);
  }
  return renderEllipseZone(zone, boxWidthPx, aspect, selection);
}

function renderEllipseZone(zone, boxWidthPx, aspect, selection) {
  const isSelected = selection.includes(zone.id);
  const role = safeColor(zone.role);
  const fill = hexToRgba(role, 0.13);
  const cx = Number(zone.cx) || 0;
  // cy/ry are percent-of-HEIGHT; emit into viewBox width-units (Bug A). ry (a height span) scales
  // by aspect just like cy (both linear through svgEmitY's origin). cx/rx (width) are unchanged.
  const cy = svgEmitY(Number(zone.cy) || 0, aspect);
  const rx = Number(zone.rx) || 0;
  const ry = svgEmitY(Number(zone.ry) || 0, aspect);
  const strokeWidthPct = strokeWidthViewBox(DEFAULT_BORDER_PX, boxWidthPx);
  const [dashOn, dashOff] = dashArray(strokeWidthPct);
  const labelMarkup = zone.label ? renderZoneLabelAt(zone.label, cx, cy - ry - 3) : '';

  return `
    <g data-id="${escapeHtml(zone.id)}" data-kind="zone" class="canvas-svg-obj${isSelected ? ' is-selected' : ''}">
      <ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}"
        fill="${fill}" stroke="${role}" stroke-width="${strokeWidthPct}" stroke-dasharray="${dashOn},${dashOff}" />
      ${isSelected ? `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="none" stroke="#ffffff" stroke-width="${strokeWidthPct * SEL_RING_SHAPE_FACTOR}" opacity="0.6" />` : ''}
      ${labelMarkup}
    </g>
  `;
}

/**
 * Renders a polygon zone: dashed closed `<polygon>` from `zone.points` + the same 13%-alpha
 * fill treatment as an ellipse zone. Label pill anchors above the polygon's bounding-box top,
 * horizontally centered on the bbox midpoint (geometry.polygonBounds) — the simplest correct
 * analogue of the ellipse's "anchor above cy-ry" rule, avoiding a full centroid computation for
 * a UI-only label placement.
 */
function renderPolygonZone(zone, boxWidthPx, aspect, selection) {
  const isSelected = selection.includes(zone.id);
  const role = safeColor(zone.role);
  const fill = hexToRgba(role, 0.13);
  const rawPoints = Array.isArray(zone.points) ? zone.points : [];
  // Emit stored height-percent y into viewBox width-units (Bug A) before building attrs / bounds.
  const points = svgEmitPoints(rawPoints, aspect);
  const pts = pointsAttr(points);
  const strokeWidthPct = strokeWidthViewBox(DEFAULT_BORDER_PX, boxWidthPx);
  const [dashOn, dashOff] = dashArray(strokeWidthPct);
  const bounds = points.length > 0 ? polygonBounds(points) : { cx: 0, minY: 0 };
  const labelMarkup = zone.label ? renderZoneLabelAt(zone.label, bounds.cx, bounds.minY - 3) : '';

  return `
    <g data-id="${escapeHtml(zone.id)}" data-kind="zone" class="canvas-svg-obj${isSelected ? ' is-selected' : ''}">
      <polygon points="${pts}"
        fill="${fill}" stroke="${role}" stroke-width="${strokeWidthPct}" stroke-dasharray="${dashOn},${dashOff}" />
      ${isSelected ? `<polygon points="${pts}" fill="none" stroke="#ffffff" stroke-width="${strokeWidthPct * SEL_RING_SHAPE_FACTOR}" opacity="0.6" />` : ''}
      ${labelMarkup}
    </g>
  `;
}

/** Mono label pill (dark rect + centered text) with its baseline gap already applied by the
 * caller — `anchorY` is the bottom edge of the pill, matching both zone shapes' "3 units above
 * the shape's top" convention. */
function renderZoneLabelAt(label, anchorX, anchorY) {
  const text = escapeHtml(label);
  const charWidth = 1.0; // approx width per char in viewBox units at the label font size
  const w = Math.max(8, text.length * charWidth + 2);
  const x = anchorX - w / 2;
  const y = anchorY;
  return `
    <rect x="${x}" y="${y - 2}" width="${w}" height="4" rx="0.6" fill="rgba(8,10,14,.8)" />
    <text x="${anchorX}" y="${y + 1}" text-anchor="middle" font-family="var(--font-mono)" font-size="2.6" font-weight="700" fill="#eef1f6">${text}</text>
  `;
}

/**
 * Renders a sketch shape (arrow/line/free polyline, or rect/ellipse) placed via the drawing
 * tools. Arrow/line/free share the route polyline renderer's look; rect/ellipse get
 * fill-opacity + border + optional dashed border per the inspector's shape options.
 * @param {object} sketch
 * @param {function} arrowheadFn
 * @param {number} aspect
 * @param {number} boxWidthPx on-screen map-box width for the shared px->viewBox conversion
 * @param {string[]} selection
 * @returns {string}
 */
export function renderSketch(sketch, arrowheadFn, aspect, boxWidthPx, selection) {
  if (sketch.shape === 'arrow' || sketch.shape === 'line' || sketch.shape === 'free') {
    return renderRoute(
      { ...sketch, head: sketch.shape === 'arrow' ? (sketch.head || 'solid') : 'none' },
      arrowheadFn,
      aspect,
      boxWidthPx,
      selection
    );
  }
  return renderSketchShape(sketch, boxWidthPx, aspect, selection);
}

function renderSketchShape(sketch, boxWidthPx, aspect, selection) {
  const isSelected = selection.includes(sketch.id);
  const [[rawX1, rawY1], [rawX2, rawY2]] = sketch.points;
  // Emit stored height-percent y into viewBox width-units (Bug A); x unchanged. The rect/ellipse
  // math below derives height/ry from these, so emitting the corners scales the height too.
  const x1 = Number(rawX1) || 0;
  const y1 = svgEmitY(Number(rawY1) || 0, aspect);
  const x2 = Number(rawX2) || 0;
  const y2 = svgEmitY(Number(rawY2) || 0, aspect);
  const role = safeColor(sketch.role);
  const fill = hexToRgba(role, (sketch.fillOpacity ?? 14) / 100);
  // Border authored in screen px (sketch.border / DEFAULT_BORDER_PX) -> viewBox units via the
  // shared model, SAME as ghost + export. Pre-fix this used the raw stored border as viewBox
  // units, so a border=2 rendered at 2*(boxW/100) ~ 16-40px (Jasper's "even 1px looks too thick").
  const borderWidthPct = strokeWidthViewBox(sketch.border ?? DEFAULT_BORDER_PX, boxWidthPx);
  const [dashOn, dashOff] = dashArray(borderWidthPct);
  const dash = sketch.dashed ? `stroke-dasharray="${dashOn},${dashOff}"` : '';

  const shapeMarkup = sketch.shape === 'ellipse'
    ? `<ellipse cx="${(x1 + x2) / 2}" cy="${(y1 + y2) / 2}" rx="${Math.abs(x2 - x1) / 2}" ry="${Math.abs(y2 - y1) / 2}" fill="${fill}" stroke="${role}" stroke-width="${borderWidthPct}" ${dash} />`
    : `<rect x="${Math.min(x1, x2)}" y="${Math.min(y1, y2)}" width="${Math.abs(x2 - x1)}" height="${Math.abs(y2 - y1)}" fill="${fill}" stroke="${role}" stroke-width="${borderWidthPct}" ${dash} />`;

  return `
    <g data-id="${escapeHtml(sketch.id)}" data-kind="sketch" class="canvas-svg-obj${isSelected ? ' is-selected' : ''}">
      ${shapeMarkup}
    </g>
  `;
}

// ---- HUD pills --------------------------------------------------------------------------

/**
 * Placement hint pill shown top-center while a unit is armed: "Place CODE · Role -> Layer".
 * @param {{code:string,name:string}|null} armedUnit
 * @param {string} roleColor
 * @param {string} roleName
 * @param {string} layerName
 * @returns {string} empty string when no unit armed
 */
export function renderPlacementHint(armedUnit, roleColor, roleName, layerName) {
  if (!armedUnit) return '';
  return `
    <div class="canvas-pill canvas-pill--hint pill-accent">
      Place <span class="chip-mono">${escapeHtml(armedUnit.code)}</span>
      <span class="canvas-pill__role-dot" style="background:${safeColor(roleColor)}"></span>
      ${escapeHtml(roleName)} &rarr; ${escapeHtml(layerName)}
    </div>
  `;
}

/**
 * Object counter chip, bottom-left: "N objects".
 * @param {number} count
 * @returns {string}
 */
export function renderObjectCounter(count) {
  return `<div class="canvas-pill canvas-pill--count pill chip-mono">${count} object${count === 1 ? '' : 's'}</div>`;
}

/**
 * Zoom pill, bottom-right: current zoom % + +/- buttons.
 * @param {number} zoom
 * @returns {string}
 */
export function renderZoomPill(zoom) {
  return `
    <div class="canvas-pill canvas-pill--zoom pill">
      <button type="button" class="canvas-zoom-btn" data-action="zoom-out" aria-label="Zoom out">-</button>
      <span class="chip-mono">${Math.round(zoom)}%</span>
      <button type="button" class="canvas-zoom-btn" data-action="zoom-in" aria-label="Zoom in">+</button>
    </div>
  `;
}

// ---- top-level render orchestrator -------------------------------------------------------
// canvas.mjs calls renderCanvas(els, ctx, action) on mount and on every store update, and
// reads the returned aspect back into its own cache (needed for pointer-math helpers like
// canvasApi.getAspect()) without re-deriving it from ctx.maps itself.

/**
 * @typedef {{ viewportEl:HTMLElement, mapEl:HTMLElement, imgEl:HTMLImageElement,
 *   wrapperEl:HTMLElement, markersLayerEl:HTMLElement, svgEl:SVGElement,
 *   hudEl:HTMLElement }} CanvasEls
 */

/**
 * Renders the full canvas panel (map box, objects, HUD, zoom transform) from current store
 * state. Returns the resolved map aspect (h/w) so the caller (canvas.mjs) can keep its
 * pointer-math cache in sync without re-deriving it from maps.json itself.
 * @param {CanvasEls} els
 * @param {{store:object, roster:object, maps:object}} ctx
 * @param {{type:string}|undefined} action the action that triggered this render, if any
 * @returns {{aspect:number}} aspect (h/w) of the active map
 */
export function renderCanvas(els, ctx, action) {
  const doc = ctx.store.getDoc();
  const view = ctx.store.getView();
  const mapMeta = ctx.maps.maps.find((m) => m.id === doc.mapId);
  const size = (mapMeta && mapMeta.assetSize) || { w: DEFAULT_ASPECT_W, h: DEFAULT_ASPECT_H };
  const aspect = size.h / size.w;

  renderMapBox(els, mapMeta, size);
  els.mapEl.classList.toggle('playing', !!view.playing);
  els.viewportEl.dataset.tool = view.tool;
  renderObjects(els, doc, view, ctx.roster, aspect);
  renderHud(els, doc, view, ctx.roster);
  renderZoomTransform(els, view);

  if (action && action.type === 'doc/placeObject') {
    flashNewestMarker(els);
  }

  return { aspect };
}

function renderMapBox(els, mapMeta, size) {
  els.mapEl.style.aspectRatio = `${size.w} / ${size.h}`;
  // --map-aspect (h/w, unitless) drives the fit-on-load contain sizing in canvas.css
  // (item a): box width = min(100cqw, 100cqh / --map-aspect). Replaces the old --map-native-w
  // px cap that froze the default map at native size regardless of monitor. Kept in sync with
  // the inline aspect-ratio above so the box's SHAPE and its width cap agree.
  els.mapEl.style.setProperty('--map-aspect', `${round2(size.h / size.w)}`);
  const available = !!(mapMeta && mapMeta.available && mapMeta.asset);
  els.mapEl.classList.toggle('is-empty', !available);
  if (available) {
    // Asset paths in maps.json are given relative to site/tactics/ (where index.html —
    // the served document — lives), so they resolve directly with no prefix.
    const src = mapMeta.asset;
    if (els.imgEl.getAttribute('src') !== src) els.imgEl.setAttribute('src', src);
    els.imgEl.style.display = '';
  } else {
    els.imgEl.removeAttribute('src');
    els.imgEl.style.display = 'none';
  }
}

function renderObjects(els, doc, view, roster, aspect) {
  // UNZOOMED layout width of the map box — the ONE input the shared core/stroke.mjs model needs
  // to convert each object's authored px thickness/border into viewBox units. Every route/zone/
  // sketch converts its OWN stored width (not the current tool option), so committed weight
  // matches both the ghost preview and the export path by construction. Must be offsetWidth, NOT
  // getBoundingClientRect().width: the rect includes the CSS zoom transform, which (a) breaks the
  // world-space model (strokes must scale WITH the map on zoom, not stay screen-constant) and
  // (b) is one zoom-step stale here because renderObjects runs before renderZoomTransform writes
  // the new scale. Falls back to the default map width if the box is unmeasured (pre-layout first
  // paint) so strokes are never NaN/0.
  const boxWidthPx = els.mapEl.offsetWidth || DEFAULT_ASPECT_W;

  const tactic = activeTactic(doc);
  const viewBoxH = round2(100 * aspect);
  els.svgEl.setAttribute('viewBox', `0 0 100 ${viewBoxH}`);
  // In-drag ghost surface (bug 1 diagnosis): without a matching viewBox, previewEl's 0-100
  // percent-space markup (drawtools-helpers.mjs's strokeMarkup/rectMarkup/etc.) renders as
  // literal 1-unit-per-px shapes pinned to the SVG's own top-left corner instead of scaled
  // across the map box — set unconditionally, same as svgEl above, so it stays correct across
  // map switches (aspect is recomputed every render).
  els.previewEl.setAttribute('viewBox', `0 0 100 ${viewBoxH}`);

  if (!tactic) {
    els.markersLayerEl.innerHTML = '';
    els.svgEl.innerHTML = '';
    return boxWidthPx;
  }

  const objects = visibleObjects(tactic, doc.layers, view.currentKeyframe);
  const markers = objects.filter((o) => o.kind === 'unit');
  const textNotes = objects.filter((o) => o.kind === 'text');
  const routes = objects.filter((o) => o.kind === 'route');
  const zones = objects.filter((o) => o.kind === 'zone');
  const sketches = objects.filter((o) => o.kind === 'sketch');

  els.markersLayerEl.innerHTML = markers.map((m) => renderMarker(m, roster, view.selection)).join('')
    + textNotes.map((t) => renderTextNote(t, view.selection)).join('');

  els.svgEl.innerHTML =
    routes.map((r) => renderRoute(r, arrowhead, aspect, boxWidthPx, view.selection)).join('')
    + zones.map((z) => renderZone(z, boxWidthPx, aspect, view.selection)).join('')
    + sketches.map((s) => renderSketch(s, arrowhead, aspect, boxWidthPx, view.selection)).join('');

  return boxWidthPx;
}

function renderHud(els, doc, view, roster) {
  const tactic = activeTactic(doc);
  const objectCount = tactic ? visibleObjects(tactic, doc.layers, view.currentKeyframe).length : 0;
  const activeLayer = doc.layers.find((l) => l.id === view.activeLayerId);
  const roleEntry = (roster.roles || []).find((r) => r.hex === view.roleColor);

  els.hudEl.innerHTML = `
    ${renderPlacementHint(view.armedUnit, view.roleColor, roleEntry ? roleEntry.name : '', activeLayer ? activeLayer.name : '')}
    ${renderObjectCounter(objectCount)}
    ${renderZoomPill(view.zoom ?? ZOOM_DEFAULT)}
  `;
}

function renderZoomTransform(els, view) {
  const zoom = view.zoom ?? ZOOM_DEFAULT;
  const pan = view.pan || { x: 0, y: 0 };
  els.wrapperEl.style.transform = wrapperTransform(pan, zoom);
}

/**
 * Builds the wrapper's inline transform string: the CSS `top:50%;left:50%` centering plus
 * pan+zoom, all in one `transform` value (inline style replaces the whole property, so the
 * -50%/-50% centering has to travel with every write here — see canvas.css's comment on
 * .canvas-wrapper).
 * @param {{x:number,y:number}} pan
 * @param {number} zoomPercent
 * @returns {string}
 */
export function wrapperTransform(pan, zoomPercent) {
  return `translate(calc(-50% + ${pan.x}px), calc(-50% + ${pan.y}px)) scale(${zoomPercent / 100})`;
}

function flashNewestMarker(els) {
  const nodes = els.markersLayerEl.querySelectorAll('.canvas-marker');
  const last = nodes[nodes.length - 1];
  if (!last) return;
  last.classList.add('is-dropping');
  setTimeout(() => last.classList.remove('is-dropping'), MARKER_DROP_MS);
}
