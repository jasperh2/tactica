// ui/locator.mjs — Cursor Locator ("laser pointer") tool [ui-locator]
// Jasper 2026-07-06: the new DEFAULT tool. Hold the left button and move: expanding pulse
// circles emit from the cursor every few ms and the recent path renders as a temporary fading
// trail — pointing/teaching on the map like a laser pointer, but it IS the cursor.
//
// Deliberately EPHEMERAL and SCREEN-SPACE: renders into its own pointer-events-none SVG overlay
// in viewport client coordinates, never converts to map coordinates, never dispatches a doc/*
// action, never enters persistence/undo/export. Everything fades out and self-clears. Because
// it is fully self-contained (own overlay, own listeners, active only when view.tool ===
// 'locator'), it needs no changes inside canvas.mjs's pointer routing beyond OWN_TOOLS opt-out.
import { safeColor } from './sanitize.mjs';

export const PULSE_INTERVAL_MS = 160; // "every few ms" — new pulse cadence while held
const PULSE_LIFE_MS = 550; // one pulse's expand+fade lifetime
const PULSE_MAX_RADIUS_PX = 34;
const PULSE_START_RADIUS_PX = 4;
const TRAIL_LIFE_MS = 650; // trail segments fade out after this
const TRAIL_MIN_DIST_PX = 3; // ignore sub-pixel jitter when extending the trail
const TRAIL_WIDTH_PX = 3;
const SVG_NS = 'http://www.w3.org/2000/svg';

/** Pulses younger than PULSE_LIFE_MS (pure — injected clock for tests). */
export function prunePulses(pulses, now) {
  return pulses.filter((p) => now - p.t0 < PULSE_LIFE_MS);
}

/** Trail points younger than TRAIL_LIFE_MS (pure — injected clock for tests). */
export function pruneTrail(trail, now) {
  return trail.filter((p) => now - p.t < TRAIL_LIFE_MS);
}

/** Pulse radius for age01 in [0,1] — ease-out expansion from start to max. */
export function pulseRadius(age01) {
  const eased = 1 - (1 - age01) * (1 - age01);
  return PULSE_START_RADIUS_PX + (PULSE_MAX_RADIUS_PX - PULSE_START_RADIUS_PX) * eased;
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

  /** @type {{trail:{x:number,y:number,t:number}[], pulses:{x:number,y:number,t0:number}[], lastPulseAt:number}|null} */
  let session = null;
  let rafId = 0;

  function toLocal(e) {
    const r = viewportEl.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function color() {
    return safeColor(store.getView().roleColor);
  }

  function start(e) {
    const { x, y } = toLocal(e);
    const now = performance.now();
    session = { trail: [{ x, y, t: now }], pulses: [{ x, y, t0: now }], lastPulseAt: now };
    if (!rafId) rafId = requestAnimationFrame(render);
  }

  function extend(e) {
    if (!session) return;
    const { x, y } = toLocal(e);
    const now = performance.now();
    const last = session.trail[session.trail.length - 1];
    if (!last || Math.hypot(x - last.x, y - last.y) >= TRAIL_MIN_DIST_PX) {
      session.trail.push({ x, y, t: now });
    }
    if (now - session.lastPulseAt >= PULSE_INTERVAL_MS) {
      session.pulses.push({ x, y, t0: now });
      session.lastPulseAt = now;
    }
  }

  function stop() {
    // Stop emitting; the render loop keeps running until everything has faded, then clears.
    if (session) session = { ...session, done: true };
  }

  function render() {
    rafId = 0;
    if (!session) { svg.innerHTML = ''; return; }
    const now = performance.now();
    session.pulses = prunePulses(session.pulses, now);
    if (!session.done) {
      // keep the full trail while held; only fade what has aged out
      session.trail = session.trail.length > 1 ? pruneTrail(session.trail, now) : session.trail;
    } else {
      session.trail = pruneTrail(session.trail, now);
    }
    const c = color();
    const parts = [];
    for (const p of session.pulses) {
      const age01 = Math.min(1, (now - p.t0) / PULSE_LIFE_MS);
      parts.push(`<circle cx="${p.x}" cy="${p.y}" r="${pulseRadius(age01).toFixed(1)}" fill="none" stroke="${c}" stroke-width="2.5" opacity="${(1 - age01).toFixed(2)}"/>`);
    }
    const tr = session.trail;
    for (let i = 1; i < tr.length; i += 1) {
      const age01 = Math.min(1, (now - tr[i].t) / TRAIL_LIFE_MS);
      parts.push(`<line x1="${tr[i - 1].x}" y1="${tr[i - 1].y}" x2="${tr[i].x}" y2="${tr[i].y}" stroke="${c}" stroke-width="${TRAIL_WIDTH_PX}" stroke-linecap="round" opacity="${(1 - age01).toFixed(2)}"/>`);
    }
    // cursor dot while actively held
    if (!session.done && tr.length) {
      const head = tr[tr.length - 1];
      parts.push(`<circle cx="${head.x}" cy="${head.y}" r="4.5" fill="${c}"/>`);
    }
    svg.innerHTML = parts.join('');
    if (session.done && session.pulses.length === 0 && session.trail.length <= 1) {
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
