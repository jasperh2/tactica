// ui/canvas-view.mjs — [ui-canvas] pure zoom/pan/coordinate helpers for the map canvas.
// No DOM writes here — these are small numeric helpers canvas.mjs calls into so the
// pointer-routing/render code in canvas.mjs stays readable. Kept separate to respect the
// 400-line-per-file target for the biggest panel in the tool.

export const ZOOM_MIN = 25;
export const ZOOM_MAX = 400;
export const ZOOM_DEFAULT = 100;
const ZOOM_WHEEL_STEP = 0.0015; // exponential factor per wheel deltaY unit
const ZOOM_BUTTON_STEP = 25; // +/- pill step, in percent points

/**
 * Clamps a zoom percentage to [ZOOM_MIN, ZOOM_MAX].
 * @param {number} zoom
 * @returns {number}
 */
export function clampZoom(zoom) {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));
}

/**
 * Computes the next zoom level for a wheel event, exponential so it feels even across the
 * whole 25-400% range (linear deltaY steps would feel slow at 400% and jumpy at 25%).
 * @param {number} currentZoom
 * @param {number} deltaY
 * @returns {number}
 */
export function wheelZoom(currentZoom, deltaY) {
  const factor = Math.exp(-deltaY * ZOOM_WHEEL_STEP);
  return clampZoom(currentZoom * factor);
}

/**
 * Zoom level after pressing the +/- pill buttons (fixed step, not exponential).
 * @param {number} currentZoom
 * @param {1|-1} direction
 * @returns {number}
 */
export function stepZoom(currentZoom, direction) {
  return clampZoom(currentZoom + direction * ZOOM_BUTTON_STEP);
}

/**
 * Computes the pan delta needed to keep `cursor` fixed on the same map point when zoom
 * changes from `oldZoom` to `newZoom`, given the current pan. This is what makes wheel-zoom
 * "zoom to cursor" instead of zooming around the map's center.
 *
 * IMPORTANT: `cursor` must be relative to the wrapper's unscaled local origin — i.e. the
 * canvas VIEWPORT's CENTER, not its top-left. The wrapper is centered via `top:50%;left:50%`
 * plus a matching `-50%,-50%` translate (canvas.css), so local (0,0) in the coordinate system
 * `pan` lives in sits at the viewport's midpoint. Callers must subtract viewportRect.width/2
 * and viewportRect.height/2 (in addition to viewportRect.left/top) from the raw client
 * position before calling this. Verified empirically — passing top-left-relative coordinates
 * here silently drifts the zoom target by hundreds of px instead of throwing.
 * @param {{x:number,y:number}} pan current pan translate (px, pre-scale)
 * @param {{x:number,y:number}} cursor cursor position relative to the viewport's CENTER
 * @param {number} oldZoom percent
 * @param {number} newZoom percent
 * @returns {{x:number,y:number}}
 */
export function panForZoomAtCursor(pan, cursor, oldZoom, newZoom) {
  const oldScale = oldZoom / 100;
  const newScale = newZoom / 100;
  if (oldScale === newScale) return { ...pan };

  // Point under the cursor in unscaled wrapper space, given the current pan+scale.
  const worldX = (cursor.x - pan.x) / oldScale;
  const worldY = (cursor.y - pan.y) / oldScale;

  return {
    x: cursor.x - worldX * newScale,
    y: cursor.y - worldY * newScale,
  };
}

/**
 * Converts a client-space pointer position into percent-of-map-box coordinates (0-100,
 * origin top-left), accounting for the map box's own bounding rect (which already reflects
 * the wrapper's zoom/pan transform via getBoundingClientRect). Unclamped — callers decide
 * whether off-map placement/drags should be clamped or ignored.
 * @param {number} clientX
 * @param {number} clientY
 * @param {DOMRect} mapRect
 * @returns {{x:number,y:number}}
 */
export function clientToPercent(clientX, clientY, mapRect) {
  const x = ((clientX - mapRect.left) / mapRect.width) * 100;
  const y = ((clientY - mapRect.top) / mapRect.height) * 100;
  return { x, y };
}

/**
 * Rounds a percent coordinate to 2 decimals (export/persistence precision per contract).
 * @param {number} n
 * @returns {number}
 */
export function round2(n) {
  return Math.round(n * 100) / 100;
}
