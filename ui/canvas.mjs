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
// Selection model (bugs 5/6 + v3 select-ux diagnosis): view.selection is a string[]. Selection
// switches on pointerDOWN via the pure selectGestureIntent (canvas-helpers.mjs) — clicking an
// unselected object re-targets AND lets the same gesture drag it (tldraw/Excalidraw), empty ground
// always marquees, shift toggles (no drag). Hit-test is geometry-based with a forgiving tolerance
// (canvas-helpers.resolveHitId). The selection shows a padded dashed bbox outline with four corner
// resize handles that scale about the opposite corner; Delete/Backspace removes the selection.

import { activeTactic, interactableObjects, positionAt } from '../core/playbook.mjs';
import { createDrawHandlers } from './drawtools.mjs';
import { renderCanvas, wrapperTransform, MIN_MARKER_SIZE, MAX_MARKER_SIZE } from './canvas-objects.mjs';
import { wheelZoom, stepZoom, panForZoomAtCursor, clientToPercent, round2, ZOOM_DEFAULT } from './canvas-view.mjs';
import {
  resolveHitId,
  rectFromDrag,
  marqueeMatches,
  groupBBox,
  padBBox,
  oppositeCornerAnchor,
  selectGestureIntent,
  scaleAboutAnchor,
} from './canvas-helpers.mjs';

const DEFAULT_ASPECT_W = 822;
const DEFAULT_ASPECT_H = 786;
const DRAG_THRESHOLD_PX = 3;
const MARKER_SIZE_DEFAULT = 26;
const BLOCKED_FLASH_MS = 260;
// 'locator' is owned-but-inert here: the Cursor Locator handles its own gestures in
// ui/locator.mjs's self-contained overlay; canvas.mjs must neither forward it to drawtools
// nor start a select gesture for it.
const OWN_TOOLS = new Set(['select', 'move', 'pan', 'place', 'locator']);
const HIT_TOLERANCE_PCT = 1.6; // forgiving click-select radius, % of map width (increment 1)
const RESIZE_HANDLE_SELECTOR = '[data-resize-handle]';
// Extra breathing room (percent-of-map-width) added on every side of the selection bbox on top
// of the marker half-size, so the dashed outline + corner handles sit clear of the markers
// instead of cutting through them (item b — the outline must frame the selection, not trace it).
const OUTLINE_MARGIN_PCT = 0.9;

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
            <div class="canvas-resize-handle canvas-resize-handle--nw" data-resize-handle="nw"></div>
            <div class="canvas-resize-handle canvas-resize-handle--ne" data-resize-handle="ne"></div>
            <div class="canvas-resize-handle canvas-resize-handle--sw" data-resize-handle="sw"></div>
            <div class="canvas-resize-handle canvas-resize-handle--se" data-resize-handle="se"></div>
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
    /** UNZOOMED map-box layout width in px — the input core/stroke.mjs needs to convert an
     * authored px thickness/border into the viewBox stroke-width the ghost writes, so the ghost
     * renders at the SAME width as the committed stroke (canvas-objects.mjs renderObjects uses
     * the same offsetWidth source). offsetWidth, NOT getBoundingClientRect().width: the rect
     * includes the zoom transform, which would make the ghost diverge from the committed
     * world-space stroke at any zoom != 100%. Read live each gesture so it tracks panel/window
     * resizes. Falls back to the default map width if unmeasured. */
    getBoxWidth() {
      return mapEl.offsetWidth || DEFAULT_ASPECT_W;
    },
    blocked(layerId) {
      const doc = ctx.store.getDoc();
      const layer = doc.layers.find((l) => l.id === layerId);
      // Hidden counts as blocked too (layer-guard fix): creating onto a hidden layer used to
      // silently succeed, leaving an invisible object. Refuse — consistent with locked; the
      // refuse-vs-auto-unhide fork is logged in DECISIONS for Jasper.
      return !!(layer && (layer.locked || layer.visible === false));
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
    // Chrome arms middle-click autoscroll on mousedown — suppress it so MMB is a clean pan.
    mapEl.addEventListener('mousedown', (e) => {
      if (e.button === 1) e.preventDefault();
    });
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

    // Middle-mouse ALWAYS pans, in every tool (Jasper hot fix 2026-07-06) — the universal
    // canvas-editor convention. preventDefault also runs on 'mousedown' (wireEvents) because
    // Chrome's middle-click autoscroll arms there, not on pointerdown.
    if (event.button === 1) {
      event.preventDefault();
      startPan(event);
      return;
    }

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
    const geometryHit = resolveHitId(objects, [pt.x, pt.y], HIT_TOLERANCE_PCT, canvasApi.getBoxWidth());
    if (geometryHit) return geometryHit;
    const domHit = event.target.closest('[data-id]');
    return domHit ? domHit.dataset.id : null;
  }

  /** Objects eligible for click/marquee selection: core/playbook.mjs's interactableObjects()
   * (Jasper's ruling — the active layer is the WHOLE interaction scope). A click/marquee over a
   * non-active-layer object now behaves exactly like clicking empty ground: it never resolves
   * as a hit, so selectGestureIntent sees hitId===null and starts a marquee / clears selection,
   * same as it already did for a locked-layer object pre-this-change. */
  function selectableObjects() {
    const doc = ctx.store.getDoc();
    const view = ctx.store.getView();
    const tactic = activeTactic(doc);
    if (!tactic) return [];
    return interactableObjects(tactic, doc.layers, view.currentKeyframe, view.activeLayerId);
  }

  /**
   * Pointerdown routing for select/move (the select-lock fix, item a). Selection switches on
   * pointerDOWN — the tldraw/Excalidraw model — so the same gesture can immediately drag the
   * freshly-selected object. Grabbing a corner handle takes priority (resize), then the pure
   * selectGestureIntent decides marquee / toggle / drag / reselect-drag from
   * (selection, hitId, shift). This REPLACES the old "startDrag whatever is under the pointer,
   * never switching selection" path that let you move B while A stayed selected.
   */
  function startSelectGesture(event) {
    const handle = event.target.closest(RESIZE_HANDLE_SELECTOR);
    if (handle) {
      startGroupResize(event, handle.dataset.resizeHandle);
      return;
    }
    const view = ctx.store.getView();
    const hitId = resolvePointerHit(event);
    const intent = selectGestureIntent(view.selection, hitId, event.shiftKey);

    if (intent === 'marquee') {
      // Empty ground always marquees; the movement threshold (updateMarquee) decides at commit time
      // whether it was a real marquee or a click-to-clear (handleSelectClick handles the latter).
      startMarquee(event);
      return;
    }
    if (intent === 'toggle') {
      // Shift+click on an object: add/remove from selection, never a drag (tldraw model).
      ctx.exec({ type: 'view/select', ids: [hitId], mode: 'toggle' });
      return;
    }
    if (intent === 'reselect-drag') {
      // Object not in the selection: switch selection to it FIRST (synchronous store dispatch),
      // THEN drag it in the same gesture, passing the known id straight into startDrag.
      ctx.exec({ type: 'view/select', ids: [hitId], mode: 'replace' });
      startDrag([hitId], event);
      return;
    }
    // intent === 'drag': object already selected — drag the existing single OR whole-group
    // selection together (preserves the multi-select group-drag path).
    startDrag(view.selection.includes(hitId) && view.selection.length > 1 ? view.selection : [hitId], event);
  }

  function handleSelectClick(event) {
    // Selection now switches on pointerdown (startSelectGesture), so the trailing click's only job
    // is the zero-movement empty-ground CLEAR (a plain click too short to arm a marquee). Re-select
    // on an object hit already happened at pointerdown, so this only clears — never re-selects.
    const hitId = resolvePointerHit(event);
    if (hitId) return;
    if (event.shiftKey) return;
    if (event.target === mapEl || event.target.closest('.canvas-mapbox') === mapEl) {
      ctx.exec({ type: 'view/select', ids: [] });
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

  /** True when `objectId` is NOT interactable right now — either its own layer is
   * locked/hidden, OR it sits on a non-active layer (Jasper's active-layer-only ruling).
   * Named for what it guards (kept the historic isLayerLockedForObject name at call sites below
   * is misleading now that it also gates on active-layer, so every caller was updated alongside
   * this rename — see startDrag/deleteSelection). A stale selection id from BEFORE the user
   * switched the active layer (view.selection isn't auto-pruned on an active-layer switch) is
   * exactly the case this defensively excludes at the drag/delete call sites, even though the
   * normal path (selectableObjects() gating click/marquee) already prevents a NEW selection
   * from ever containing a non-active-layer id. */
  function isBlockedForInteraction(objectId) {
    const doc = ctx.store.getDoc();
    const view = ctx.store.getView();
    const tactic = activeTactic(doc);
    const obj = tactic && tactic.objects.find((o) => o.id === objectId);
    if (!obj) return true;
    if (obj.layerId !== view.activeLayerId) return true; // non-active layer — always excluded
    return canvasApi.blocked(obj.layerId);
  }

  // ---- drag: single object OR a whole multi-select group together (increment 5) ---------

  /**
   * Starts a drag of an explicit set of object ids (the caller — startSelectGesture — has already
   * decided single vs whole-group via selectGestureIntent, so this no longer re-derives the group
   * from the store). An object that's locked, on a hidden layer, OR on a non-active layer is
   * never dragged: for a single-object drag we bail entirely; in a group drag, blocked members
   * are simply dropped from the anchor set (defensive — normally selectableObjects() already
   * kept them out of the selection in the first place) so the rest of the group still moves.
   * @param {string[]} ids
   * @param {PointerEvent} event
   */
  function startDrag(ids, event) {
    if (ids.length === 1 && isBlockedForInteraction(ids[0])) return;
    const view = ctx.store.getView();
    const rect = mapEl.getBoundingClientRect();
    const { x, y } = clientToPercent(event.clientX, event.clientY, rect);
    const doc = ctx.store.getDoc();
    const tactic = activeTactic(doc);
    const anchors = {};
    ids.forEach((objId) => {
      if (isBlockedForInteraction(objId)) return;
      const obj = tactic?.objects.find((o) => o.id === objId);
      if (obj && obj.kind === 'unit') anchors[objId] = positionAt(obj, view.currentKeyframe);
    });
    if (Object.keys(anchors).length === 0) return;

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

  function livePreviewMarker(id, x, y, sizePx) {
    const nodeEl = markersLayerEl.querySelector(`[data-id="${cssEscape(id)}"]`);
    if (nodeEl) {
      nodeEl.style.left = `${x}%`;
      nodeEl.style.top = `${y}%`;
      // Corner-resize live preview: the marker itself must visibly scale during the drag, not
      // just the dashed outline (the committed size lands via doc/resizeMarkers on pointerup).
      if (typeof sizePx === 'number' && Number.isFinite(sizePx)) {
        nodeEl.style.width = `${sizePx}px`;
        nodeEl.style.height = `${sizePx}px`;
      }
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

  // ---- resize handles: single-object AND multi-select group share one code path --
  // A single selected unit is just a 1-object "group"; paddedSelectionBBox inflates its zero-area
  // point box into a real frame so the four corner handles land outside the marker (not on it).

  function renderGroupChrome() {
    // While a resize gesture is in progress, updateGroupResize owns the outline rect every
    // pointermove — a store-driven re-render (fires on every store.subscribe tick, incl. unrelated
    // actions) must not clobber that live preview back to the pre-drag bbox before pointerup.
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
    renderGroupOutlineRect(paddedSelectionBBox(units));
  }

  /**
   * The selection bbox the outline + corner handles are drawn from: the point-only groupBBox
   * inflated by the largest marker's half-size (px -> percent-of-map-width) plus a margin. Fixes
   * the "blue blob dead-center on a single marker" — a single unit's zero-area point box becomes a
   * real box framing the marker, so the dashed outline is visible and the corner handles land just
   * outside the marker instead of stacking on its center.
   * @param {{id:string,x:number,y:number,size:number}[]} units
   * @returns {{minX:number,minY:number,maxX:number,maxY:number}}
   */
  function paddedSelectionBBox(units) {
    const bbox = groupBBox(units);
    const boxWidthPx = mapEl.getBoundingClientRect().width || DEFAULT_ASPECT_W;
    const maxSizePx = units.reduce((m, u) => Math.max(m, u.size || MARKER_SIZE_DEFAULT), 0);
    // marker half-size as a percentage of map width; the vertical pad divides by aspect so the
    // px margin is visually equal on both axes (percent-of-HEIGHT = percent-of-width / aspect).
    const padX = ((maxSizePx / 2) / boxWidthPx) * 100 + OUTLINE_MARGIN_PCT;
    const padY = padX / (currentAspect || 1);
    return padBBox(bbox, padX, padY);
  }

  /** Resolved {id,x,y,size} for every currently-selected object that is a unit marker (routes/
   * zones/sketches/text in a mixed selection are excluded from group-resize — see fixPlan's
   * documented scope decision: group-resize/move initially handles unit kinds only). Also drops
   * any id that is blocked for interaction (locked/hidden layer, or a non-active layer — same
   * defensive guard as startDrag/deleteSelection): a stale selection surviving a lock toggle or
   * an active-layer switch must not still be corner-resizable. */
  function resolvedSelectedUnits(view) {
    const doc = ctx.store.getDoc();
    const tactic = activeTactic(doc);
    if (!tactic) return [];
    return view.selection
      .filter((id) => !isBlockedForInteraction(id))
      .map((id) => tactic.objects.find((o) => o.id === id))
      .filter((obj) => obj && obj.kind === 'unit')
      .map((obj) => ({ id: obj.id, size: Number(obj.size) || MARKER_SIZE_DEFAULT, ...positionAt(obj, view.currentKeyframe) }));
  }

  /**
   * Begins a corner-handle resize. The grabbed corner (nw/ne/sw/se) scales the selection ABOUT the
   * diagonally-opposite corner of the PADDED bbox — standard editor resize, the opposite corner
   * stays pinned while the grabbed corner tracks the pointer (was: always scale about bbox center).
   * Reuses scaleAboutAnchor's arbitrary-anchor support — no second scaling path.
   * @param {PointerEvent} event
   * @param {'nw'|'ne'|'sw'|'se'} corner
   */
  function startGroupResize(event, corner) {
    const view = ctx.store.getView();
    const units = resolvedSelectedUnits(view);
    if (units.length === 0) return;
    const bbox = paddedSelectionBBox(units);
    const anchor = oppositeCornerAnchor(bbox, corner);
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
    scaled.forEach((obj) => livePreviewMarker(obj.id, round2(obj.x), round2(obj.y), obj.size));
    renderGroupOutlineRect(paddedSelectionBBox(scaled));
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
      // Esc also clears the selection (select-UX contract: outline/handles disappear). Runs after
      // the gesture cancels; selection is empty during draw authoring, so no double-duty conflict.
      if (ctx.store.getView().selection.length > 0) {
        ctx.exec({ type: 'view/select', ids: [] });
      }
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
    // Exclude-not-refuse (matches the existing drag-start/erase-tool precedent): an object that
    // is locked, on a hidden layer, OR on a non-active layer (Jasper's active-layer-only ruling)
    // is dropped from the batch rather than blocking deletion of the rest of a valid selection.
    const deletable = view.selection.filter((id) => !isBlockedForInteraction(id));
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
