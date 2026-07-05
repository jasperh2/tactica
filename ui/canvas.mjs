// ui/canvas.mjs — [ui-canvas] the map canvas panel (contract §5, handoff README §3).
// Owns the #canvas subtree: mounts the DOM scaffold, wires pointer/wheel/keyboard events,
// and handles select/move/pan/place itself. Rendering (map box, markers, SVG overlay, HUD
// pills) lives in canvas-objects.mjs's renderCanvas(); drawing-tool GESTURES (arrow/draw/
// line/box/circle/zone/text/measure/erase) are delegated to drawtools.mjs via the seam
// documented in the build brief.
//
// No cross-panel imports besides the one documented seam. No direct DOM access outside this
// panel's own element. Re-renders from store.subscribe; never mutates doc/view.

import { activeTactic } from '../core/playbook.mjs';
import { createDrawHandlers } from './drawtools.mjs';
import { renderCanvas, wrapperTransform } from './canvas-objects.mjs';
import { wheelZoom, stepZoom, panForZoomAtCursor, clientToPercent, round2, ZOOM_DEFAULT } from './canvas-view.mjs';

const DEFAULT_ASPECT_W = 822;
const DEFAULT_ASPECT_H = 786;
const DRAG_THRESHOLD_PX = 3;
const MARKER_SIZE_DEFAULT = 26;
const BLOCKED_FLASH_MS = 260;
const OWN_TOOLS = new Set(['select', 'move', 'pan', 'place']);

/**
 * @param {HTMLElement} el
 * @param {{store:object, history:object, roster:object, maps:object, exec:Function}} ctx
 */
export function mount(el, ctx) {
  el.classList.add('canvas-panel');

  /** @type {{id:string, startX:number, startY:number, moved:boolean, lastX:number, lastY:number}|null} */
  let dragState = null;
  /** @type {{startClientX:number, startClientY:number, startPan:{x:number,y:number}, pendingPan?:{x:number,y:number}}|null} */
  let panState = null;
  let spaceHeld = false;
  let currentAspect = DEFAULT_ASPECT_H / DEFAULT_ASPECT_W;

  el.innerHTML = `
    <div class="canvas-viewport">
      <div class="canvas-wrapper">
        <div class="canvas-mapbox">
          <img class="canvas-mapbox__img" alt="" draggable="false" />
          <div class="canvas-mapbox__empty">
            <i class="ph ph-image-broken" aria-hidden="true"></i>
            <span>Map art needed</span>
          </div>
          <div class="canvas-markers-layer"></div>
          <svg class="canvas-svg-overlay" preserveAspectRatio="none"></svg>
          <svg class="canvas-svg-preview" preserveAspectRatio="none"></svg>
        </div>
      </div>
      <div class="canvas-hud"></div>
    </div>
  `;

  const els = {
    viewportEl: el.querySelector('.canvas-viewport'),
    wrapperEl: el.querySelector('.canvas-wrapper'),
    mapEl: el.querySelector('.canvas-mapbox'),
    imgEl: el.querySelector('.canvas-mapbox__img'),
    markersLayerEl: el.querySelector('.canvas-markers-layer'),
    svgEl: el.querySelector('.canvas-svg-overlay'),
    previewEl: el.querySelector('.canvas-svg-preview'),
    hudEl: el.querySelector('.canvas-hud'),
  };
  const { viewportEl, wrapperEl, mapEl, markersLayerEl, hudEl } = els;

  // ---- canvasApi handed to drawtools.mjs (seam, per build brief) ------------------------

  const canvasApi = {
    toPct(clientX, clientY) {
      const rect = mapEl.getBoundingClientRect();
      return clientToPercent(clientX, clientY, rect);
    },
    mapEl,
    svgEl: els.svgEl,
    previewEl: els.previewEl,
    getAspect() {
      return currentAspect;
    },
    blocked(layerId) {
      const doc = ctx.store.getDoc();
      const layer = doc.layers.find((l) => l.id === layerId);
      return !!(layer && layer.locked);
    },
  };

  const drawApi = createDrawHandlers(ctx, canvasApi);
  let lastTool = ctx.store.getView().tool;

  doRender();
  wireEvents();
  ctx.store.subscribe((doc, view, action) => {
    if (view.tool !== lastTool) {
      cancelDrawTool(lastTool);
      lastTool = view.tool;
    }
    doRender(action);
  });

  const resizeObserver = new ResizeObserver(() => doRender());
  resizeObserver.observe(mapEl);

  function doRender(action) {
    const result = renderCanvas(els, ctx, action);
    currentAspect = result.aspect;
  }

  /** Clears any in-progress gesture ghost when leaving a drawtools-owned tool (tool switch or
   * Escape) — per drawtools.mjs's documented expectation that canvas.mjs calls `.cancel?.()`. */
  function cancelDrawTool(tool) {
    const handler = drawApi[tool];
    if (handler && typeof handler.cancel === 'function') handler.cancel();
  }

  // ---- pointer routing ----------------------------------------------------------------

  function wireEvents() {
    mapEl.addEventListener('pointerdown', onPointerDown);
    viewportEl.addEventListener('pointermove', onPointerMove);
    viewportEl.addEventListener('pointerup', onPointerUp);
    viewportEl.addEventListener('pointercancel', onPointerUp);
    mapEl.addEventListener('click', onClick);
    mapEl.addEventListener('dblclick', onDblClick);
    viewportEl.addEventListener('wheel', onWheel, { passive: false });
    hudEl.addEventListener('click', onHudClick);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
  }

  function currentTool() {
    return ctx.store.getView().tool;
  }

  function isPanning() {
    return currentTool() === 'pan' || spaceHeld || !!panState;
  }

  function onPointerDown(event) {
    if (isPanning()) {
      startPan(event);
      return;
    }

    const tool = currentTool();
    if (!OWN_TOOLS.has(tool)) {
      forwardToDrawApi(tool, 'pointerdown', event);
      return;
    }

    if (tool === 'select' || tool === 'move') {
      const markerEl = event.target.closest('[data-id]');
      if (markerEl && !isLayerLockedForObject(markerEl.dataset.id)) {
        startDrag(markerEl.dataset.id, event);
      }
    }
  }

  function onPointerMove(event) {
    if (panState) {
      updatePan(event);
      return;
    }
    if (dragState) {
      updateDrag(event);
      return;
    }
    const tool = currentTool();
    if (!OWN_TOOLS.has(tool)) forwardToDrawApi(tool, 'pointermove', event);
  }

  function onPointerUp(event) {
    if (panState) {
      commitPan();
      return;
    }
    if (dragState) {
      commitDrag();
      return;
    }
    const tool = currentTool();
    if (!OWN_TOOLS.has(tool)) forwardToDrawApi(tool, 'pointerup', event);
  }

  function onClick(event) {
    const tool = currentTool();

    if (tool === 'place') {
      handlePlaceClick(event);
      return;
    }
    if (!OWN_TOOLS.has(tool)) {
      forwardToDrawApi(tool, 'click', event);
      return;
    }
    if ((tool === 'select' || tool === 'move') && !dragState?.moved) {
      handleSelectClick(event);
    }
  }

  function onDblClick(event) {
    const tool = currentTool();
    if (!OWN_TOOLS.has(tool)) forwardToDrawApi(tool, 'dblclick', event);
  }

  function forwardToDrawApi(tool, eventName, event) {
    const handler = drawApi[tool] && drawApi[tool][eventName];
    if (typeof handler === 'function') handler(event);
  }

  // ---- select / place / drag (owned tools) ---------------------------------------------

  function handleSelectClick(event) {
    const targetEl = event.target.closest('[data-id]');
    if (targetEl) {
      ctx.exec({ type: 'view/select', id: targetEl.dataset.id });
    } else if (event.target === mapEl || event.target.closest('.canvas-mapbox') === mapEl) {
      ctx.exec({ type: 'view/select', id: null });
    }
  }

  function handlePlaceClick(event) {
    const view = ctx.store.getView();
    if (!view.armedUnit) return;
    if (event.target.closest('[data-id]')) return; // clicking an existing object doesn't re-place

    if (canvasApi.blocked(view.activeLayerId)) {
      flashBlocked();
      return;
    }

    const { x, y } = canvasApi.toPct(event.clientX, event.clientY);
    const object = {
      kind: 'unit',
      code: view.armedUnit.code,
      name: view.armedUnit.name,
      role: view.roleColor,
      layerId: view.activeLayerId,
      appearsAt: view.currentKeyframe,
      size: MARKER_SIZE_DEFAULT,
      positions: { [view.currentKeyframe]: { x: round2(x), y: round2(y) } },
    };
    ctx.exec({ type: 'doc/placeObject', object });
  }

  function isLayerLockedForObject(objectId) {
    const doc = ctx.store.getDoc();
    const tactic = activeTactic(doc);
    const obj = tactic && tactic.objects.find((o) => o.id === objectId);
    return !!(obj && canvasApi.blocked(obj.layerId));
  }

  function startDrag(id, event) {
    const rect = mapEl.getBoundingClientRect();
    const { x, y } = clientToPercent(event.clientX, event.clientY, rect);
    dragState = { id, startX: x, startY: y, moved: false, lastX: x, lastY: y };
  }

  function updateDrag(event) {
    if (!dragState) return;
    const rect = mapEl.getBoundingClientRect();
    const { x, y } = clientToPercent(event.clientX, event.clientY, rect);

    if (!dragState.moved) {
      // rect.width/height already reflect the wrapper's zoom transform (getBoundingClientRect
      // returns post-transform screen px), so converting the %-space delta back through
      // rect.width gives real on-screen px directly — no separate zoom correction needed.
      const movedPxX = ((x - dragState.startX) / 100) * rect.width;
      const movedPxY = ((y - dragState.startY) / 100) * rect.height;
      if (Math.hypot(movedPxX, movedPxY) < DRAG_THRESHOLD_PX) return;
      dragState.moved = true;
    }
    dragState.lastX = round2(x);
    dragState.lastY = round2(y);
    livePreviewMarker(dragState.id, dragState.lastX, dragState.lastY);
  }

  function livePreviewMarker(id, x, y) {
    const nodeEl = markersLayerEl.querySelector(`[data-id="${cssEscape(id)}"]`);
    if (nodeEl) {
      nodeEl.style.left = `${x}%`;
      nodeEl.style.top = `${y}%`;
    }
  }

  function commitDrag() {
    if (!dragState) return;
    const { id, moved, lastX, lastY } = dragState;
    dragState = null;
    if (!moved) return;
    const kf = ctx.store.getView().currentKeyframe;
    ctx.exec({ type: 'doc/moveObject', id, kf, x: lastX, y: lastY });
  }

  function flashBlocked() {
    mapEl.classList.add('is-blocked');
    setTimeout(() => mapEl.classList.remove('is-blocked'), BLOCKED_FLASH_MS);
  }

  // ---- pan (H tool / space-drag) --------------------------------------------------------

  function startPan(event) {
    const view = ctx.store.getView();
    panState = {
      startClientX: event.clientX,
      startClientY: event.clientY,
      startPan: view.pan || { x: 0, y: 0 },
    };
  }

  function updatePan(event) {
    if (!panState) return;
    const dx = event.clientX - panState.startClientX;
    const dy = event.clientY - panState.startClientY;
    const pan = { x: panState.startPan.x + dx, y: panState.startPan.y + dy };
    const zoom = ctx.store.getView().zoom ?? ZOOM_DEFAULT;
    wrapperEl.style.transform = wrapperTransform(pan, zoom);
    panState.pendingPan = pan;
  }

  function commitPan() {
    const pending = panState && panState.pendingPan;
    panState = null;
    if (pending) ctx.exec({ type: 'view/setPan', pan: pending });
  }

  // ---- zoom (wheel + pills) -------------------------------------------------------------

  function onWheel(event) {
    event.preventDefault();
    const view = ctx.store.getView();
    const zoom = view.zoom ?? ZOOM_DEFAULT;
    const nextZoom = wheelZoom(zoom, event.deltaY);
    if (nextZoom === zoom) return;

    // panForZoomAtCursor's "cursor" is relative to the WRAPPER's unscaled local origin, which
    // sits at the viewport's CENTER (the wrapper is `top:50%;left:50%` + a matching translate,
    // per canvas.css) — not the viewport's top-left. Verified empirically: using top-left-
    // relative coordinates here drifts the zoom target by hundreds of px; center-relative has
    // zero drift.
    const viewportRect = viewportEl.getBoundingClientRect();
    const cursor = {
      x: event.clientX - viewportRect.left - viewportRect.width / 2,
      y: event.clientY - viewportRect.top - viewportRect.height / 2,
    };
    const pan = view.pan || { x: 0, y: 0 };
    const nextPan = panForZoomAtCursor(pan, cursor, zoom, nextZoom);

    ctx.exec({ type: 'view/setZoom', zoom: nextZoom });
    ctx.exec({ type: 'view/setPan', pan: nextPan });
  }

  function onHudClick(event) {
    const btn = event.target.closest('.canvas-zoom-btn');
    if (!btn) return;
    const view = ctx.store.getView();
    const direction = btn.dataset.action === 'zoom-in' ? 1 : -1;
    ctx.exec({ type: 'view/setZoom', zoom: stepZoom(view.zoom ?? ZOOM_DEFAULT, direction) });
  }

  // ---- keyboard: space-drag pan toggle + Escape cancel -----------------------------------

  function onKeyDown(event) {
    if (isInputFocused()) return;

    if (event.code === 'Space') {
      spaceHeld = true;
      viewportEl.classList.add('is-space-pan');
      return;
    }
    if (event.key === 'Escape') {
      cancelDrawTool(currentTool());
      dragState = null;
      panState = null;
    }
  }

  function onKeyUp(event) {
    if (event.code === 'Space') {
      spaceHeld = false;
      viewportEl.classList.remove('is-space-pan');
    }
  }

  function isInputFocused() {
    const active = document.activeElement;
    return !!active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable);
  }
}

/**
 * Minimal CSS.escape fallback for data-id attribute selectors (ids are generator-controlled
 * "o1", "o2", ... but this keeps the querySelector call safe if that ever changes).
 * @param {string} id
 * @returns {string}
 */
function cssEscape(id) {
  return window.CSS && window.CSS.escape ? window.CSS.escape(id) : id.replace(/["\\]/g, '\\$&');
}
