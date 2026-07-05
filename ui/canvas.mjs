// ui/canvas.mjs — [ui-canvas] the map canvas panel (contract §5, handoff README §3).
// Owns the #canvas subtree: mounts the DOM scaffold, wires pointer/wheel/keyboard events,
// and handles select/move/pan/place itself. Rendering (map box, markers, SVG overlay, HUD
// pills) lives in canvas-objects.mjs's renderCanvas(); drawing-tool GESTURES (arrow/draw/
// line/box/circle/zone/text/measure/erase) are delegated to drawtools.mjs via the seam
// documented in the build brief.
//
// No cross-panel imports besides the one documented seam. No direct DOM access outside this
// panel's own element. Re-renders from store.subscribe; never mutates doc/view.
//
// Multi-select rework (bugs 5/6 diagnosis): view.selection is now string[] (increment 3).
// Click-select uses a geometry-based hit-test with a forgiving tolerance radius instead of the
// old exact-DOM-box lookup (increment 1); shift-click adds/toggles; dragging from empty ground
// starts a marquee-select rectangle (increment 4); dragging any object already part of a
// multi-object selection moves the whole group together (increment 5); a resize handle on the
// selection outline scales the group about its bbox anchor (increment 6); Delete/Backspace
// removes the current selection (increment 1/6).

import { activeTactic, visibleObjects, positionAt } from '../core/playbook.mjs';
import { createDrawHandlers } from './drawtools.mjs';
import { renderCanvas, wrapperTransform, MIN_MARKER_SIZE, MAX_MARKER_SIZE } from './canvas-objects.mjs';
import { wheelZoom, stepZoom, panForZoomAtCursor, clientToPercent, round2, ZOOM_DEFAULT } from './canvas-view.mjs';
import { resolveHitId, rectFromDrag, marqueeMatches, groupBBox, scaleAboutAnchor } from './canvas-helpers.mjs';

const DEFAULT_ASPECT_W = 822;
const DEFAULT_ASPECT_H = 786;
const DRAG_THRESHOLD_PX = 3;
const MARKER_SIZE_DEFAULT = 26;
const BLOCKED_FLASH_MS = 260;
const OWN_TOOLS = new Set(['select', 'move', 'pan', 'place']);
const HIT_TOLERANCE_PCT = 1.6; // forgiving click-select radius, % of map width (increment 1)
const RESIZE_HANDLE_SELECTOR = '[data-resize-handle]';

/**
 * @param {HTMLElement} el
 * @param {{store:object, history:object, roster:object, maps:object, exec:Function}} ctx
 */
export function mount(el, ctx) {
  el.classList.add('canvas-panel');

  /** @type {{ids:string[], startX:number, startY:number, moved:boolean, lastDx:number,
   *   lastDy:number, anchors:Record<string,{x:number,y:number}>}|null} */
  let dragState = null;
  /** @type {{startClientX:number, startClientY:number, startPan:{x:number,y:number}, pendingPan?:{x:number,y:number}}|null} */
  let panState = null;
  /** @type {{startX:number, startY:number, lastX:number, lastY:number, additive:boolean}|null} */
  let marqueeState = null;
  /** @type {{anchor:{x:number,y:number}, startDistance:number,
   *   originals:{id:string,x:number,y:number,size:number}[], lastScaleFactor:number}|null} */
  let resizeState = null;
  let spaceHeld = false;
  // A drag/marquee/resize gesture nulls its state object on pointerup (in commit*), which happens
  // BEFORE the browser's trailing `click` fires. Without this latch, onClick's `!marqueeState?.moved`
  // guard reads `!undefined === true` and lets handleSelectClick run a fresh replace-select on
  // whatever sits under the release point — collapsing a just-committed marquee/group selection down
  // to that one object. commit* sets this true when the gesture moved; onClick consumes+clears it.
  let suppressNextClick = false;
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
          <div class="canvas-marquee" hidden></div>
          <div class="canvas-group-outline" hidden>
            <div class="canvas-resize-handle" data-resize-handle="se"></div>
          </div>
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
  const marqueeEl = el.querySelector('.canvas-marquee');
  const groupOutlineEl = el.querySelector('.canvas-group-outline');

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
    renderGroupChrome();
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
    // Fresh gesture — clear any stale click-suppression latch. A moved gesture sets it on
    // pointerup for the immediately-following trailing click; if the browser suppressed that
    // click (it does when the pointer moved far enough), the flag would otherwise linger and
    // wrongly swallow the next real click. The next pointerdown always precedes the next click,
    // so clearing here bounds the latch to exactly the one click after its own pointerup.
    suppressNextClick = false;

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
      startSelectGesture(event);
    }
  }

  function onPointerMove(event) {
    if (panState) {
      updatePan(event);
      return;
    }
    if (resizeState) {
      updateGroupResize(event);
      return;
    }
    if (dragState) {
      updateDrag(event);
      return;
    }
    if (marqueeState) {
      updateMarquee(event);
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
    if (resizeState) {
      commitGroupResize();
      return;
    }
    if (dragState) {
      commitDrag();
      return;
    }
    if (marqueeState) {
      commitMarquee();
      return;
    }
    const tool = currentTool();
    if (!OWN_TOOLS.has(tool)) forwardToDrawApi(tool, 'pointerup', event);
  }

  function onClick(event) {
    const tool = currentTool();

    // A drag/marquee/resize that actually moved sets suppressNextClick in its commit* (pointerup
    // fires and nulls the gesture state BEFORE this trailing click), so the state-based guards
    // below can't see it. Consume the latch here and swallow the click, or it would run a fresh
    // replace-select on whatever sits under the release point — collapsing the just-committed
    // marquee/group selection down to that single object.
    if (suppressNextClick) {
      suppressNextClick = false;
      return;
    }

    if (tool === 'place') {
      handlePlaceClick(event);
      return;
    }
    if (!OWN_TOOLS.has(tool)) {
      forwardToDrawApi(tool, 'click', event);
      return;
    }
    if ((tool === 'select' || tool === 'move') && !dragState?.moved && !marqueeState?.moved) {
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

  /** Percent-space hit resolution shared by click-select and drag-start: geometry-based via
   * canvas-helpers.resolveHitId (forgiving tolerance), falling back to the old DOM
   * closest('[data-id]') lookup only if the geometry pass finds nothing (defensive — guards
   * against a resolved-position edge case ever diverging from the rendered DOM position). */
  function resolvePointerHit(event) {
    const rect = mapEl.getBoundingClientRect();
    const pt = clientToPercent(event.clientX, event.clientY, rect);
    const objects = selectableObjects();
    const geometryHit = resolveHitId(objects, [pt.x, pt.y], HIT_TOLERANCE_PCT);
    if (geometryHit) return geometryHit;
    const domHit = event.target.closest('[data-id]');
    return domHit ? domHit.dataset.id : null;
  }

  /** Objects eligible for click/marquee selection: visible-layer objects (visibleObjects()
   * already filters those) minus anything on a LOCKED layer — visibleObjects() does not filter
   * by lock, only by visibility, so that check is added here (mirrors the pre-existing
   * isLayerLockedForObject drag-start guard). */
  function selectableObjects() {
    const doc = ctx.store.getDoc();
    const view = ctx.store.getView();
    const tactic = activeTactic(doc);
    if (!tactic) return [];
    return visibleObjects(tactic, doc.layers, view.currentKeyframe).filter(
      (obj) => !canvasApi.blocked(obj.layerId)
    );
  }

  function startSelectGesture(event) {
    if (event.target.closest(RESIZE_HANDLE_SELECTOR)) {
      startGroupResize(event);
      return;
    }
    const hitId = resolvePointerHit(event);
    if (hitId) {
      startDrag(hitId, event);
      return;
    }
    // Empty ground with select/move active: no existing object under the pointer — start a
    // marquee-select rectangle instead of the old no-op (increment 4).
    startMarquee(event);
  }

  function handleSelectClick(event) {
    const hitId = resolvePointerHit(event);
    if (hitId) {
      const mode = event.shiftKey ? 'toggle' : 'replace';
      ctx.exec({ type: 'view/select', ids: [hitId], mode });
    } else if (event.target === mapEl || event.target.closest('.canvas-mapbox') === mapEl) {
      if (!event.shiftKey) ctx.exec({ type: 'view/select', ids: [] });
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

  // ---- drag: single object OR a whole multi-select group together (increment 5) ---------

  function startDrag(id, event) {
    if (isLayerLockedForObject(id)) return;
    const view = ctx.store.getView();
    const isGroupMember = view.selection.length > 1 && view.selection.includes(id);
    const ids = isGroupMember ? view.selection : [id];

    const rect = mapEl.getBoundingClientRect();
    const { x, y } = clientToPercent(event.clientX, event.clientY, rect);
    const doc = ctx.store.getDoc();
    const tactic = activeTactic(doc);
    const anchors = {};
    ids.forEach((objId) => {
      const obj = tactic?.objects.find((o) => o.id === objId);
      if (obj && obj.kind === 'unit') anchors[objId] = positionAt(obj, view.currentKeyframe);
    });

    dragState = { ids: Object.keys(anchors), startX: x, startY: y, moved: false, lastDx: 0, lastDy: 0, anchors };
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
    dragState.lastDx = x - dragState.startX;
    dragState.lastDy = y - dragState.startY;
    dragState.ids.forEach((id) => {
      const anchor = dragState.anchors[id];
      livePreviewMarker(id, round2(anchor.x + dragState.lastDx), round2(anchor.y + dragState.lastDy));
    });
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
    const { ids, moved, lastDx, lastDy, anchors } = dragState;
    dragState = null;
    if (!moved) return;
    suppressNextClick = true; // this drag moved — don't let the trailing click re-select
    const kf = ctx.store.getView().currentKeyframe;

    if (ids.length === 1) {
      const anchor = anchors[ids[0]];
      ctx.exec({ type: 'doc/moveObject', id: ids[0], kf, x: round2(anchor.x + lastDx), y: round2(anchor.y + lastDy) });
      return;
    }
    // Batched (one history snapshot for the whole group drag, not one per object) — see
    // store.mjs's doc/moveObjects.
    const moves = ids.map((id) => {
      const anchor = anchors[id];
      return { id, kf, x: round2(anchor.x + lastDx), y: round2(anchor.y + lastDy) };
    });
    ctx.exec({ type: 'doc/moveObjects', moves });
  }

  function flashBlocked() {
    mapEl.classList.add('is-blocked');
    setTimeout(() => mapEl.classList.remove('is-blocked'), BLOCKED_FLASH_MS);
  }

  // ---- marquee select on empty ground (increment 4) --------------------------------------

  function startMarquee(event) {
    const rect = mapEl.getBoundingClientRect();
    const { x, y } = clientToPercent(event.clientX, event.clientY, rect);
    marqueeState = { startX: x, startY: y, lastX: x, lastY: y, moved: false, additive: event.shiftKey };
  }

  function updateMarquee(event) {
    if (!marqueeState) return;
    const rect = mapEl.getBoundingClientRect();
    const { x, y } = clientToPercent(event.clientX, event.clientY, rect);

    if (!marqueeState.moved) {
      const movedPxX = ((x - marqueeState.startX) / 100) * rect.width;
      const movedPxY = ((y - marqueeState.startY) / 100) * rect.height;
      if (Math.hypot(movedPxX, movedPxY) < DRAG_THRESHOLD_PX) return;
      marqueeState.moved = true;
      marqueeEl.hidden = false;
    }
    marqueeState.lastX = x;
    marqueeState.lastY = y;
    renderMarqueeRect(rectFromDrag([marqueeState.startX, marqueeState.startY], [x, y]));
  }

  function renderMarqueeRect(rect) {
    marqueeEl.style.left = `${rect.x}%`;
    marqueeEl.style.top = `${rect.y}%`;
    marqueeEl.style.width = `${rect.w}%`;
    marqueeEl.style.height = `${rect.h}%`;
  }

  function commitMarquee() {
    if (!marqueeState) return;
    const { startX, startY, lastX, lastY, moved, additive } = marqueeState;
    marqueeState = null;
    marqueeEl.hidden = true;
    if (!moved) return; // too-short drag — treated as a stray click, onClick handles selection
    suppressNextClick = true; // this marquee moved — don't let the trailing click re-select

    const rect = rectFromDrag([startX, startY], [lastX, lastY]);
    const matches = marqueeMatches(selectableObjects(), rect);
    if (matches.length === 0 && !additive) {
      ctx.exec({ type: 'view/select', ids: [] });
      return;
    }
    if (matches.length === 0) return; // shift-drag over empty ground: leave existing selection
    ctx.exec({ type: 'view/select', ids: matches, mode: additive ? 'add' : 'replace' });
  }

  // ---- resize handle: single-object (increment 2) AND multi-select group (increment 6) --
  // Both share one code path — a single selected unit is just a 1-object "group", and
  // scaleAboutAnchor/groupBBox degenerate correctly for a single point (bbox = a zero-area box
  // at the object's own position, scale-about-anchor = scale-about-self).

  function renderGroupChrome() {
    // While a resize gesture is in progress, updateGroupResize already owns the outline's
    // rect every pointermove — a store-driven re-render (which fires on every store.subscribe
    // tick, including from unrelated actions) must not clobber that live preview back to the
    // pre-drag bbox before pointerup commits it.
    if (resizeState) return;
    const view = ctx.store.getView();
    if (view.selection.length === 0) {
      groupOutlineEl.hidden = true;
      return;
    }
    const units = resolvedSelectedUnits(view);
    if (units.length === 0) {
      groupOutlineEl.hidden = true;
      return;
    }
    groupOutlineEl.hidden = false;
    renderGroupOutlineRect(groupBBox(units));
  }

  /** Resolved {id,x,y,size} for every currently-selected object that is a unit marker (routes/
   * zones/sketches/text in a mixed selection are excluded from group-resize — see fixPlan's
   * documented scope decision: group-resize/move initially handles unit kinds only). */
  function resolvedSelectedUnits(view) {
    const doc = ctx.store.getDoc();
    const tactic = activeTactic(doc);
    if (!tactic) return [];
    return view.selection
      .map((id) => tactic.objects.find((o) => o.id === id))
      .filter((obj) => obj && obj.kind === 'unit')
      .map((obj) => ({ id: obj.id, size: Number(obj.size) || MARKER_SIZE_DEFAULT, ...positionAt(obj, view.currentKeyframe) }));
  }

  function startGroupResize(event) {
    const view = ctx.store.getView();
    const units = resolvedSelectedUnits(view);
    if (units.length === 0) return;
    const bbox = groupBBox(units);
    const anchor = { x: (bbox.minX + bbox.maxX) / 2, y: (bbox.minY + bbox.maxY) / 2 };
    const rect = mapEl.getBoundingClientRect();
    const pt = clientToPercent(event.clientX, event.clientY, rect);
    const startDistance = Math.max(Math.hypot(pt.x - anchor.x, pt.y - anchor.y), 0.01);
    resizeState = { anchor, startDistance, originals: units, lastScaleFactor: 1 };
  }

  function updateGroupResize(event) {
    if (!resizeState) return;
    const rect = mapEl.getBoundingClientRect();
    const pt = clientToPercent(event.clientX, event.clientY, rect);
    const { anchor, startDistance, originals } = resizeState;
    const distance = Math.hypot(pt.x - anchor.x, pt.y - anchor.y);
    const scaleFactor = distance / startDistance;
    resizeState.lastScaleFactor = scaleFactor;

    const scaled = scaleAboutAnchor(originals, anchor, scaleFactor, { minSize: MIN_MARKER_SIZE, maxSize: MAX_MARKER_SIZE });
    scaled.forEach((obj) => livePreviewMarker(obj.id, round2(obj.x), round2(obj.y)));
    renderGroupOutlineRect(groupBBox(scaled));
  }

  function renderGroupOutlineRect(bbox) {
    groupOutlineEl.style.left = `${bbox.minX}%`;
    groupOutlineEl.style.top = `${bbox.minY}%`;
    groupOutlineEl.style.width = `${Math.max(bbox.maxX - bbox.minX, 0.01)}%`;
    groupOutlineEl.style.height = `${Math.max(bbox.maxY - bbox.minY, 0.01)}%`;
  }

  function commitGroupResize() {
    if (!resizeState) return;
    const { anchor, originals, lastScaleFactor } = resizeState;
    resizeState = null;
    if (lastScaleFactor === 1) return; // pointerdown+pointerup with no movement — no-op
    suppressNextClick = true; // this resize moved — don't let the trailing click re-select

    const kf = ctx.store.getView().currentKeyframe;
    const scaled = scaleAboutAnchor(originals, anchor, lastScaleFactor, { minSize: MIN_MARKER_SIZE, maxSize: MAX_MARKER_SIZE });
    // Batched (one history snapshot for the whole group-resize drag) — see store.mjs's
    // doc/resizeMarkers, which accepts the optional per-entry kf/x/y this "scale about the
    // selection bbox" gesture needs alongside the size change.
    const resizes = scaled.map((obj) => ({ id: obj.id, size: round2(obj.size), kf, x: round2(obj.x), y: round2(obj.y) }));
    ctx.exec({ type: 'doc/resizeMarkers', resizes });
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

  // ---- keyboard: space-drag pan toggle, Escape cancel, Delete removes selection ----------

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
      if (marqueeState) {
        marqueeState = null;
        marqueeEl.hidden = true;
      }
      resizeState = null;
      return;
    }
    // Enter closes an in-progress draw gesture that opts in via onEnter (only the Zone polygon
    // tool defines it — see drawtools.mjs's Zone onEnter). Purely additive: forwardToDrawApi
    // no-ops for every other tool, which have no onEnter handler. Mirrors the Escape branch's
    // drawApi[currentTool()].cancel?.() shape. Skips when a select/move gesture owns Enter-less
    // paths — Enter has no other canvas binding, so this is safe to run unconditionally here.
    if (event.key === 'Enter') {
      const tool = currentTool();
      if (!OWN_TOOLS.has(tool)) {
        event.preventDefault();
        forwardToDrawApi(tool, 'onEnter', event);
      }
      return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      deleteSelection();
    }
  }

  function deleteSelection() {
    const view = ctx.store.getView();
    if (view.selection.length === 0) return;
    const doc = ctx.store.getDoc();
    const tactic = activeTactic(doc);
    // Respect the locked-layer guard (matches the existing drag-start/erase-tool behavior):
    // an object on a locked layer is excluded from the delete, not silently deleted alongside
    // an otherwise-valid multi-select.
    const deletable = view.selection.filter((id) => {
      const obj = tactic?.objects.find((o) => o.id === id);
      return obj && !canvasApi.blocked(obj.layerId);
    });
    if (deletable.length === 0) return;
    // app.mjs's exec() already prunes any deleted id out of view.selection after doc/
    // deleteObject(s) — no separate view/select dispatch needed here, and dispatching one
    // unconditionally would wrongly clear a locked-layer object's selection too when it was
    // excluded from `deletable` above and so is still present in the doc.
    if (deletable.length === 1) {
      ctx.exec({ type: 'doc/deleteObject', id: deletable[0] });
    } else {
      ctx.exec({ type: 'doc/deleteObjects', ids: deletable });
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
