// ui/locator.mjs — Cursor Locator ("laser pointer") tool [ui-locator]
// Jasper 2026-07-06 (v2, matched to his reference screenshot): hold the left button and move —
// a COMET OF RINGS follows the cursor. Each sampled point spawns a bold ring that starts big
// and SHRINKS away as it ages, so the newest ring (at the cursor) is the largest and the trail
// tapers off behind it. NO trail line — rings only, overlapping along the path.
//
// Deliberately EPHEMERAL and SCREEN-SPACE: renders into its own pointer-events-none SVG overlay
// in viewport client coordinates, never converts to map coordinates, never dispatches a doc/*
// action, never enters persistence/undo/export. Everything shrinks out and self-clears. Because
// it is fully self-contained (own overlay, own listeners, active only when view.tool ===
// 'locator'), it needs no changes inside canvas.mjs's pointer routing beyond OWN_TOOLS opt-out.
import { safeColor } from './sanitize.mjs';

export const RING_INTERVAL_MS = 90; // stationary-hold cadence: keep spawning at the cursor
export const RING_SPACING_PX = 9; // moving cadence: spawn a ring every N px of travel
const RING_LIFE_MS = 600; // one ring's shrink-away lifetime
const RING_MAX_RADIUS_PX = 17; // newest ring (at the cursor) — the comet head
const RING_STROKE_PX = 4.5; // bold ring outline, per the reference screenshot
const SVG_NS = 'http://www.w3.org/2000/svg';

/** Rings younger than RING_LIFE_MS (pure — injected clock for tests). */
export function pruneRings(rings, now) {
  return rings.filter((r) => now - r.t0 < RING_LIFE_MS);
}

/** Ring radius for age01 in [0,1] — starts at the max (comet head) and SHRINKS to nothing. */
export function ringRadius(age01) {
  return RING_MAX_RADIUS_PX * Math.max(0, 1 - age01);
}

/**
 * Mounts the locator overlay + listeners on the canvas viewport.
 * @param {HTMLElement} viewportEl
 * @param {{getView:Function}} store
 */
export function mountLocator(viewportEl, store) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'locator-overlay');
  // Inline styles on purpose: zero shared-CSS-file footprint (hot fix; avoids conflicts).
  svg.setAttribute('style', 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:60;overflow:visible;');
  viewportEl.appendChild(svg);

  /** @type {{rings:{x:number,y:number,t0:number}[], last:{x:number,y:number},
   *   lastSpawnAt:number, done?:boolean}|null} */
  let session = null;
  let rafId = 0;

  function toLocal(e) {
    const r = viewportEl.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function color() {
    return safeColor(store.getView().roleColor);
  }

  function spawn(x, y, now) {
    session.rings.push({ x, y, t0: now });
    session.last = { x, y };
    session.lastSpawnAt = now;
  }

  function start(e) {
    const { x, y } = toLocal(e);
    session = { rings: [], last: { x, y }, lastSpawnAt: 0 };
    spawn(x, y, performance.now());
    if (!rafId) rafId = requestAnimationFrame(render);
  }

  function extend(e) {
    if (!session || session.done) return;
    const { x, y } = toLocal(e);
    const now = performance.now();
    // Moving: drop a ring every RING_SPACING_PX of travel so the comet is dense and continuous.
    if (Math.hypot(x - session.last.x, y - session.last.y) >= RING_SPACING_PX) {
      spawn(x, y, now);
    } else {
      session.last = { x, y };
    }
  }

  function stop() {
    if (session) session.done = true;
  }

  function render() {
    rafId = 0;
    if (!session) { svg.innerHTML = ''; return; }
    const now = performance.now();
    session.rings = pruneRings(session.rings, now);
    // Stationary hold: keep re-spawning at the cursor so the head ring stays big and alive.
    if (!session.done && now - session.lastSpawnAt >= RING_INTERVAL_MS) {
      spawn(session.last.x, session.last.y, now);
    }
    const c = color();
    const parts = [];
    for (const r of session.rings) {
      const age01 = Math.min(1, (now - r.t0) / RING_LIFE_MS);
      const radius = ringRadius(age01);
      if (radius < 0.5) continue;
      parts.push(`<circle cx="${r.x}" cy="${r.y}" r="${radius.toFixed(1)}" fill="none" stroke="${c}" stroke-width="${RING_STROKE_PX}" opacity="0.92"/>`);
    }
    svg.innerHTML = parts.join('');
    if (session.done && session.rings.length === 0) {
      session = null;
      svg.innerHTML = '';
      return;
    }
    rafId = requestAnimationFrame(render);
  }

  viewportEl.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (store.getView().tool !== 'locator') return;
    e.preventDefault();
    start(e);
  });
  viewportEl.addEventListener('pointermove', (e) => {
    if (session && !session.done) extend(e);
  });
  const end = () => stop();
  viewportEl.addEventListener('pointerup', end);
  viewportEl.addEventListener('pointercancel', end);
  viewportEl.addEventListener('pointerleave', end);

  return { stop };
}
