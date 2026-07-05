// core/stroke.mjs — the ONE shared thickness->stroke-width model for TACTICA's map annotations.
// Pure, deterministic, no DOM/fetch (core/ contract, same as geometry.mjs) so ghost markup
// (ui/drawtools-helpers.mjs), committed SVG renderers (ui/canvas-objects.mjs), and the canvas2d
// export path (ui/render.mjs) can ALL call it — stroke parity by construction, not by three
// hand-synced copies of the math (the pre-fix bug: the ghost wrote raw thickness into viewBox
// units and rendered 8-13x too thick, while the committed path converted thickness->viewBox
// units and the export path used a third, unrelated device-px scale).
//
// UNIT MODEL (decided against the parallel Excalidraw/tldraw research pass,
// knowledge/research/canvas-tool-interaction-patterns.md §3, which was verified against both
// editors' source): content strokes live in WORLD/SCENE space and scale with zoom — Excalidraw
// stores strokeWidth in scene units, tldraw wants strokes to zoom; `vector-effect:
// non-scaling-stroke` is the tool for screen-constant CHROME only, never content. TACTICA's
// committed surface already renders world-space (viewBox units under the CSS zoom transform), so
// the fix keeps that model and simply makes the ghost + export call the SAME conversion the
// committed path uses. This diverges from the stroke-pipeline diagnosis's non-scaling-stroke
// recommendation on purpose: the research (source-verified) is the authority on the zoom fork,
// and reusing the existing committed model means existing saved docs keep byte-identical
// committed weight (a stored thickness=3 rendered ~3px before and renders ~3px after — no
// migration), while the ghost stops lying.
//
// `thickness` (and shape `border`) are authored as SCREEN PIXELS: the typed slider value means
// "this many CSS px on the map at 100% zoom". strokeWidthViewBox() converts that px value into
// the viewBox units an SVG stroke-width attribute needs so it renders back to exactly `thickness`
// px on a map box `boxWidthPx` wide (the overlay/preview SVGs use viewBox="0 0 100 H", so 1
// viewBox unit == boxWidthPx/100 px; stroke-width S renders at S*boxWidthPx/100 px, hence
// S = thickness/boxWidthPx*100).

const DASH_ON_FACTOR = 2.4; // dash "on" length as a multiple of the stroke width
const DASH_OFF_FACTOR = 1.6; // dash "off" gap as a multiple of the stroke width
// Arrowhead size scales with the AUTHORED px thickness, not the tiny viewBox-unit stroke width —
// that was the pre-fix floor bug: renderRoute did Math.max(strokeWidthPct*1.6, 1), but on any real
// map strokeWidthPct is ~0.03-0.2 (thickness/boxW*100), so *1.6 is always < 1 and the head clamped
// to size=1 forever, never responding to the thickness slider. geometry.arrowhead's opts.size
// multiplies its ARROWHEAD_BASE_OFFSET (2.0% of map width) and HALF_WIDTH (1.25%), so size=1 is
// already a legible ~2%-of-map head. We keep size=1 as the baseline at HEAD_REFERENCE_THICKNESS_PX
// and grow/shrink LINEARLY with thickness, clamped, so a 3px route shows a bigger head than a
// 0.5px one on the SAME map (Jasper's ask).
// The thickness (px) that maps to the size=1 baseline head. Pinned to the arrow tool's DEFAULT
// thickness (app.mjs DEFAULT_TOOL_OPTIONS.thickness = 3, the shared-bag default per Jasper's arrow
// calibration) so a fresh default arrow gets the calibrated ~2%-of-map baseline head, thinner
// strokes scale proportionally DOWN and the 5px slider max scales modestly UP (5/3 ~ 1.67x). Keep
// this equal to that default: if the default thickness moves, this moves with it.
const HEAD_REFERENCE_THICKNESS_PX = 3;
// A thin stroke gets a proportionally smaller head, floored so a very thin route still shows a
// legible triangle. Lowered from 0.6 to 0.35 when the reference moved 1.5 -> 3: with the higher
// reference a linear head/thickness map compresses the bottom of the 0.25..5 slider, so the floor
// must sit lower or it would flatten the whole sub-2px range to one head size. At 0.35 the floor
// only catches strokes below ~1px (0.35*3), keeping the mid-slider monotonic while a hair-thin
// 0.25px route still gets a ~0.7%-of-map head instead of vanishing.
const HEAD_MIN_SIZE = 0.35;
const HEAD_MAX_SIZE = 4.0; // clamp so a very thick stroke can't produce an absurd triangle.
const REFERENCE_BOX_WIDTH_PX = 1600; // nominal on-screen map-box width the export path scales
// against, so a `thickness`-px on-screen stroke exports proportionally onto the fixed-width MP4/
// frame canvas. ~mid of the current fit-to-viewport box widths (stage 1's bigger map spans well
// past the old 822px native cap); a route authored at 3px looks like 3px on a ~1600px editor box
// and ~1.7px on the 900px export frame — proportional, not a raw device-px mismatch.

/**
 * Converts an authored stroke thickness (screen px at 100% zoom) into the SVG stroke-width value
 * (viewBox units) that renders back to exactly `thickness` px on a map box `boxWidthPx` wide.
 * The single seam ghost + committed both call, guaranteeing pixel-identical stroke widths.
 * @param {number} thickness authored width in screen px (the typed slider value)
 * @param {number} boxWidthPx on-screen width of the map box (getBoundingClientRect().width)
 * @returns {number} stroke-width in viewBox units for a viewBox="0 0 100 H" overlay
 */
export function strokeWidthViewBox(thickness, boxWidthPx) {
  const t = Number(thickness);
  const safeT = Number.isFinite(t) ? t : 0;
  if (!boxWidthPx || boxWidthPx <= 0) return safeT; // degenerate (unmeasured box) — pass through
  return (safeT / boxWidthPx) * 100;
}

/**
 * The dash-array [on, off] for a dashed stroke, expressed in the SAME units as `strokeWidth`
 * (works for both the viewBox-unit committed/ghost path and the device-px export path, since the
 * factors are unit-agnostic multiples of the stroke width). One shared source so dashed ghost ==
 * dashed committed == dashed export (the pre-fix bug had ghost at 2.2/1.6 and committed at
 * 2.4/1.6 — a subtle dashed-parity miss).
 * @param {number} strokeWidth the rendered stroke width in whatever unit the caller draws in
 * @returns {[number, number]}
 */
export function dashArray(strokeWidth) {
  return [strokeWidth * DASH_ON_FACTOR, strokeWidth * DASH_OFF_FACTOR];
}

/**
 * The arrowhead `size` multiplier to feed geometry.arrowhead(), scaling with the AUTHORED px
 * thickness so the head grows/shrinks with the thickness slider (fixes the pinned-tiny-head floor
 * bug) yet stays legible and never absurd. size=1 (the ~2%-of-map baseline head) corresponds to
 * HEAD_REFERENCE_THICKNESS_PX; thicker strokes scale up linearly, thinner down, clamped to
 * [HEAD_MIN_SIZE, HEAD_MAX_SIZE]. Driven by px (not the tiny viewBox-unit width) precisely because
 * the viewBox width is always < 1 on a real map, which is what pinned the old floor.
 * @param {number} thicknessPx the authored stroke thickness in screen px (the slider value)
 * @returns {number} clamped size multiplier for geometry.arrowhead's opts.size
 */
export function arrowheadSize(thicknessPx) {
  const t = Number(thicknessPx);
  const safeT = Number.isFinite(t) && t > 0 ? t : 0;
  const raw = safeT / HEAD_REFERENCE_THICKNESS_PX; // size=1 at the reference thickness
  return Math.min(Math.max(raw, HEAD_MIN_SIZE), HEAD_MAX_SIZE);
}

/**
 * Export-path stroke width (device px on the fixed-width export canvas) for an authored
 * `thickness` (screen px), scaled by the export canvas width so it looks proportional to the
 * on-screen appearance. Same shared seam as the on-screen path, just resolved into the export
 * canvas's own device-px space instead of viewBox units.
 * @param {number} thickness authored width in screen px
 * @param {number} exportCanvasWidthPx the export canvas width (e.g. 900)
 * @returns {number} lineWidth in device px for the 2d canvas
 */
export function strokeWidthExportPx(thickness, exportCanvasWidthPx) {
  const t = Number(thickness);
  const safeT = Number.isFinite(t) ? t : 0;
  if (!exportCanvasWidthPx || exportCanvasWidthPx <= 0) return safeT;
  return safeT * (exportCanvasWidthPx / REFERENCE_BOX_WIDTH_PX);
}

export const STROKE_INTERNALS = { HEAD_MIN_SIZE, HEAD_MAX_SIZE, REFERENCE_BOX_WIDTH_PX };
