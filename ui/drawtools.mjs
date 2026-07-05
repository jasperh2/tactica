// ui/drawtools.mjs — TACTICA drawing-tool gesture logic [ui-draw]
// Handoff README §3 [BUILD] drawing tools. This module implements ONLY the gesture behavior
// behind the seam canvas.mjs ([ui-canvas]) calls; it never touches the DOM outside the
// `previewEl` ghost surface handed to it via canvasApi.
//
// Contract §5: tools read ctx.store.getView() for roleColor/activeLayerId/currentKeyframe/
// toolOptions, refuse to create on a locked/blocked layer, and commit via
// ctx.exec({type:'doc/placeObject', object}) — exec is history-aware (snapshots doc first).
//
// Object-kind decision (resolved by reading BOTH core/exporter.mjs+exporter.test.mjs, the
// handoff README's Route typedef, AND architecture doc §3's Route typedef verbatim): the ARROW
// tool is the movement-arrow authoring UX the contract's Route typedef exists for — it commits
// kind:'route' {id, kind:'route', points, role, layerId, appearsAt, thickness, dashed, head},
// which buildKeyframeEntry (core/exporter.mjs) reads into playbook.json's routes[] channel and
// canvas-objects.mjs's renderRoute() already renders correctly. Draw (freehand), Line, Box,
// Circle stay kind:'sketch' (shapes 'free'/'line'/'rect'/'ellipse') — deliberate UI-only
// annotations excluded from playbook.json by exporter design (see exporter.test.mjs's
// "buildPlaybook ignores non-unit/route/zone object kinds" test), matching canvas-objects.mjs's
// renderSketch() dispatch for those four shapes.
//   - Arrow (drag + click-polyline) commits kind:'route' — the ONLY sketch-family gesture that
//     produces exported motion data; both its rendering (renderRoute) and hit-testing
//     (core/geometry.mjs hitTest's 'route' case) already exist and are tested.
//   - Draw/Line/Box/Circle commit as kind:'sketch' and are UI-only: they will not appear in the
//     exported animation.
//   - Text commits as kind:'text' — also UI-only per the same test/schema (playbook.json has
//     no text-note array; only per-keyframe `note` strings, owned by the inspector/playbookbar).
//   - Zone remains kind:'zone', which IS read by the exporter.
//
// Most tools share one gesture shape (pointerdown anchors a start point, pointermove renders a
// ghost, pointerup commits or discards a too-short drag) — createDragTool() below is that shared
// lifecycle; only Arrow (polyline branch), Draw (continuous sampling), Text (single click), and
// Erase (click-to-delete) need bespoke state machines.
import { simplify, worldDistance } from '../core/geometry.mjs';
import {
  isMeaningfulDrag,
  ellipseFromCorners,
  strokeMarkup,
  rectMarkup,
  ellipseMarkup,
  zoneMarkup,
  measureMarkup,
} from './drawtools-helpers.mjs';

const FREEHAND_SIMPLIFY_EPSILON = 0.35; // core/geometry.mjs default, named here for clarity
const DEFAULT_TEXT = 'Label';
const DEFAULT_ZONE_LABEL = '';

/**
 * @typedef {{toPct:Function, mapEl:HTMLElement, svgEl:SVGElement, previewEl:SVGElement,
 *   getAspect:Function, blocked:Function}} CanvasApi
 */

/** Clears any in-progress ghost markup. */
function clearGhost(canvasApi) {
  canvasApi.previewEl.innerHTML = '';
}

/** Current tool options + role/layer/keyframe snapshot every tool needs to read on gesture start. */
function drawContext(ctx) {
  const view = ctx.store.getView();
  return {
    role: view.roleColor,
    layerId: view.activeLayerId,
    appearsAt: view.currentKeyframe,
    opts: view.toolOptions,
  };
}

/** Dispatches doc/placeObject for a fully-built object; refuses silently if layer is blocked. */
function commit(ctx, canvasApi, layerId, object) {
  if (canvasApi.blocked(layerId)) return;
  ctx.exec({ type: 'doc/placeObject', object });
}

/**
 * Selects the most-recently-added object on the active tactic. Used right after a zone/text
 * commit so the inspector's "selected object" card shows it without a separate click. Reads doc
 * state that commit() just wrote via ctx.exec, then dispatches a view (non-undoable) action.
 */
function selectLatest(ctx) {
  const doc = ctx.store.getDoc();
  const tactic = doc.tactics.find((t) => t.id === doc.activeTacticId);
  if (!tactic || tactic.objects.length === 0) return;
  const latest = tactic.objects[tactic.objects.length - 1];
  ctx.exec({ type: 'view/select', id: latest.id });
}

/**
 * Shared drag lifecycle for the simple "anchor -> ghost -> commit-or-discard" tools
 * (Line, Box, Circle, Zone). `buildObject(dc, start, end)` returns the doc object to commit
 * (or a falsy value to silently discard, e.g. a click too short to count as a drag).
 * @param {object} ctx
 * @param {CanvasApi} canvasApi
 * @param {(dc:object, start:[number,number], end:[number,number]) => string} renderGhost
 * @param {(dc:object, start:[number,number], end:[number,number]) => (object|null)} buildObject
 * @param {{selectAfter?: boolean}} [opts]
 */
function createDragTool(ctx, canvasApi, renderGhost, buildObject, opts = {}) {
  /** @type {{x:number,y:number}|null} */
  let dragStart = null;

  function cancel() {
    dragStart = null;
    clearGhost(canvasApi);
  }

  return {
    onPointerDown(e) {
      const dc = drawContext(ctx);
      if (canvasApi.blocked(dc.layerId)) return;
      dragStart = canvasApi.toPct(e.clientX, e.clientY);
    },

    onPointerMove(e) {
      if (!dragStart) return;
      const dc = drawContext(ctx);
      const p = canvasApi.toPct(e.clientX, e.clientY);
      canvasApi.previewEl.innerHTML = renderGhost(dc, [dragStart.x, dragStart.y], [p.x, p.y]);
    },

    onPointerUp(e) {
      if (!dragStart) return;
      const dc = drawContext(ctx);
      const p = canvasApi.toPct(e.clientX, e.clientY);
      const start = [dragStart.x, dragStart.y];
      const end = [p.x, p.y];
      dragStart = null;
      clearGhost(canvasApi);

      if (!isMeaningfulDrag(start, end)) return;
      const object = buildObject(dc, start, end);
      if (!object) return;
      commit(ctx, canvasApi, dc.layerId, object);
      if (opts.selectAfter) selectLatest(ctx);
    },

    /** Exposes the in-progress anchor (or null) — Arrow uses this to reinterpret a too-short
     * drag as the first click of a polyline route instead of a silent no-op. */
    peekStart() {
      return dragStart;
    },

    cancel,
  };
}

// =============================================================================
// Arrow — drag = straight 2-point route; click-click-…-dblclick = polyline route.
// Both commit as kind:'route' (see file header for the kind decision) — this is the
// playbook.json movement-arrow channel, not a UI-only sketch.
// =============================================================================

function createArrowTool(ctx, canvasApi) {
  const drag = createDragTool(
    ctx,
    canvasApi,
    (dc, start, end) => strokeMarkup([start, end], { ...strokeOpts(dc), aspect: canvasApi.getAspect() }),
    (dc, start, end) => routeObject(dc, [start, end], dc.opts.head)
  );

  /** @type {[number,number][]|null} */
  let polylinePoints = null; // non-null while building a click-polyline arrow

  function drawPolylineGhost(points, dc) {
    canvasApi.previewEl.innerHTML = strokeMarkup(points, { ...strokeOpts(dc), aspect: canvasApi.getAspect() });
  }

  function cancel() {
    polylinePoints = null;
    drag.cancel();
  }

  return {
    onPointerDown(e) {
      if (!polylinePoints) {
        drag.onPointerDown(e);
        return;
      }
      // continuing an in-progress polyline
      const dc = drawContext(ctx);
      const p = canvasApi.toPct(e.clientX, e.clientY);
      polylinePoints.push([p.x, p.y]);
      drawPolylineGhost(polylinePoints, dc);
    },

    onPointerMove(e) {
      if (!polylinePoints) {
        drag.onPointerMove(e);
        return;
      }
      const dc = drawContext(ctx);
      const p = canvasApi.toPct(e.clientX, e.clientY);
      drawPolylineGhost([...polylinePoints, [p.x, p.y]], dc);
    },

    onPointerUp(e) {
      if (polylinePoints) return; // polyline mode commits on dblclick, not pointerup

      const dc = drawContext(ctx);
      const p = canvasApi.toPct(e.clientX, e.clientY);
      // Peek at drag's own anchor before delegating, so a too-short drag can be reinterpreted
      // as "first click of a polyline" instead of silently discarded.
      const startedDrag = drag.peekStart();
      drag.onPointerUp(e);

      if (startedDrag && !isMeaningfulDrag([startedDrag.x, startedDrag.y], [p.x, p.y])) {
        polylinePoints = [[startedDrag.x, startedDrag.y]];
        drawPolylineGhost(polylinePoints, dc);
      }
    },

    onDblClick() {
      if (!polylinePoints || polylinePoints.length < 2) {
        cancel();
        return;
      }
      const dc = drawContext(ctx);
      const object = routeObject(dc, polylinePoints, dc.opts.head);
      polylinePoints = null;
      clearGhost(canvasApi);
      commit(ctx, canvasApi, dc.layerId, object);
    },

    cancel,
  };
}

function strokeOpts(dc) {
  return { color: dc.role, thickness: dc.opts.thickness, dashed: dc.opts.dashed, head: dc.opts.head };
}

/**
 * Builds a Route object (architecture doc §3 / handoff README Route typedef) for the Arrow
 * tool's drag or click-polyline gesture. This is the playbook.json movement-arrow channel —
 * core/exporter.mjs's buildKeyframeEntry reads kind:'route' objects into routes[] (see file
 * header re: the kind decision). Rendering (canvas-objects.mjs renderRoute) and hit-testing
 * (core/geometry.mjs hitTest's 'route' case) already dispatch on this kind.
 */
function routeObject(dc, points, head) {
  return {
    kind: 'route',
    points,
    thickness: dc.opts.thickness,
    dashed: dc.opts.dashed,
    head,
    role: dc.role,
    layerId: dc.layerId,
    appearsAt: dc.appearsAt,
  };
}

/**
 * Builds a Sketch object (architecture doc §3 typedef) for a UI-only drawn stroke — line or
 * freehand. `shape` matches canvas-objects.mjs's renderSketch() dispatch exactly
 * (`sketch.shape === 'line'|'free'` routes to the route-style polyline renderer there); this is
 * a deliberate UI-only annotation kind, see file header re: exporter exclusion. Arrow no longer
 * uses this builder — see routeObject.
 */
function sketchStrokeObject(dc, shape, points, head) {
  return {
    kind: 'sketch',
    shape,
    points,
    thickness: dc.opts.thickness,
    dashed: dc.opts.dashed,
    head,
    role: dc.role,
    layerId: dc.layerId,
    appearsAt: dc.appearsAt,
  };
}

// =============================================================================
// Draw — freehand pointermove sampling -> geometry.simplify -> sketch (shape:'free', no head).
// =============================================================================

function createFreehandTool(ctx, canvasApi) {
  /** @type {[number,number][]|null} */
  let samples = null;

  function cancel() {
    samples = null;
    clearGhost(canvasApi);
  }

  return {
    onPointerDown(e) {
      const dc = drawContext(ctx);
      if (canvasApi.blocked(dc.layerId)) return;
      const p = canvasApi.toPct(e.clientX, e.clientY);
      samples = [[p.x, p.y]];
    },

    onPointerMove(e) {
      if (!samples) return;
      const dc = drawContext(ctx);
      const p = canvasApi.toPct(e.clientX, e.clientY);
      samples.push([p.x, p.y]);
      canvasApi.previewEl.innerHTML = strokeMarkup(samples, {
        ...strokeOpts(dc),
        head: 'none',
        aspect: canvasApi.getAspect(),
      });
    },

    onPointerUp() {
      if (!samples) return;
      const dc = drawContext(ctx);
      const points = samples;
      samples = null;
      clearGhost(canvasApi);

      if (points.length < 2) return;
      const thinned = simplify(points, FREEHAND_SIMPLIFY_EPSILON);
      commit(ctx, canvasApi, dc.layerId, sketchStrokeObject(dc, 'free', thinned, 'none'));
    },

    cancel,
  };
}

// =============================================================================
// Line — drag = plain 2-point sketch (shape:'line'), no arrowhead.
// =============================================================================

function createLineTool(ctx, canvasApi) {
  return createDragTool(
    ctx,
    canvasApi,
    (dc, start, end) =>
      strokeMarkup([start, end], { ...strokeOpts(dc), head: 'none', aspect: canvasApi.getAspect() }),
    (dc, start, end) => sketchStrokeObject(dc, 'line', [start, end], 'none')
  );
}

// =============================================================================
// Box / Circle — drag-to-size sketches (rect/ellipse). NOT exported (see file header).
// =============================================================================

function sketchObject(dc, shape, start, end) {
  return {
    kind: 'sketch',
    shape,
    points: [start, end],
    thickness: dc.opts.border,
    dashed: dc.opts.dashed,
    fillOpacity: dc.opts.fillOpacity,
    border: dc.opts.border,
    role: dc.role,
    layerId: dc.layerId,
    appearsAt: dc.appearsAt,
  };
}

function fillOpts(dc) {
  return { color: dc.role, fillOpacity: dc.opts.fillOpacity, border: dc.opts.border, dashed: dc.opts.dashed };
}

function createBoxTool(ctx, canvasApi) {
  return createDragTool(
    ctx,
    canvasApi,
    (dc, start, end) => rectMarkup(start, end, fillOpts(dc)),
    (dc, start, end) => sketchObject(dc, 'rect', start, end)
  );
}

function createCircleTool(ctx, canvasApi) {
  return createDragTool(
    ctx,
    canvasApi,
    (dc, start, end) => ellipseMarkup(start, end, fillOpts(dc)),
    (dc, start, end) => sketchObject(dc, 'ellipse', start, end)
  );
}

// =============================================================================
// Zone — drag ellipse -> kind:'zone' {shape:'ellipse', cx, cy, rx, ry, label:''}.
// =============================================================================

function createZoneTool(ctx, canvasApi) {
  return createDragTool(
    ctx,
    canvasApi,
    (dc, start, end) => zoneMarkup(start, end, { color: dc.role }),
    (dc, start, end) => {
      const { cx, cy, rx, ry } = ellipseFromCorners(start, end);
      return {
        kind: 'zone',
        shape: 'ellipse',
        cx,
        cy,
        rx,
        ry,
        label: DEFAULT_ZONE_LABEL,
        role: dc.role,
        layerId: dc.layerId,
        appearsAt: dc.appearsAt,
      };
    },
    // README §5: "zones get an optional label" — surface it in the inspector immediately via
    // the same selected-object card Select/Move-Resize already renders.
    { selectAfter: true }
  );
}

// =============================================================================
// Text — click -> kind:'text' {x,y,text:'Label',size,chip}, then select it.
// =============================================================================

function createTextTool(ctx, canvasApi) {
  return {
    onClick(e) {
      const dc = drawContext(ctx);
      if (canvasApi.blocked(dc.layerId)) return;
      const p = canvasApi.toPct(e.clientX, e.clientY);

      commit(ctx, canvasApi, dc.layerId, {
        kind: 'text',
        x: p.x,
        y: p.y,
        text: DEFAULT_TEXT,
        size: dc.opts.textSize,
        chip: dc.opts.textChip,
        role: dc.role,
        layerId: dc.layerId,
        appearsAt: dc.appearsAt,
      });
      // Inspector edits the text via a doc action keyed on the object id — no generic
      // "update object field" doc action exists yet in store.mjs (recolorObject only touches
      // `role`, resizeMarker only touches `size`). Selecting here is the seam; the inspector
      // owner needs a new reducer case (e.g. doc/updateText or a generic doc/setObjectField)
      // to actually commit textarea edits.
      selectLatest(ctx);
    },

    cancel() {
      clearGhost(canvasApi);
    },
  };
}

// =============================================================================
// Measure — drag: live overlay line + distance label; NEVER persisted, clears on pointerup.
// =============================================================================

function createMeasureTool(ctx, canvasApi) {
  /** @type {{x:number,y:number}|null} */
  let dragStart = null;

  function cancel() {
    dragStart = null;
    clearGhost(canvasApi);
  }

  return {
    onPointerDown(e) {
      dragStart = canvasApi.toPct(e.clientX, e.clientY);
    },

    onPointerMove(e) {
      if (!dragStart) return;
      const p = canvasApi.toPct(e.clientX, e.clientY);
      const dist = worldDistance([dragStart.x, dragStart.y], [p.x, p.y]);
      canvasApi.previewEl.innerHTML = measureMarkup([dragStart.x, dragStart.y], [p.x, p.y], dist);
    },

    onPointerUp() {
      // Measure is explicitly non-persistent (README §3, contract seam docstring): clear and
      // forget, no exec() call of any kind.
      cancel();
    },

    cancel,
  };
}

// =============================================================================
// Erase — click object -> exec doc/deleteObject {id}.
// =============================================================================

function createEraseTool(ctx, canvasApi) {
  /** Resolves the object id under a click via the DOM's own data-id — canvas.mjs/
   * canvas-objects.mjs already render markers/routes/zones/sketches/text with data-id on
   * their elements per contract §5 ("routes clicks that land on object elements"). This module
   * has no independent visible-object list to hit-test against (geometry.hitTest needs
   * pre-resolved {x,y} from visibleObjects(), which only canvas.mjs computes), so the DOM
   * lookup is the documented primary path, not a fallback. */
  function resolveTargetId(e) {
    const el = e.target.closest?.('[data-id]');
    return el?.dataset.id ?? null;
  }

  return {
    onClick(e) {
      const dc = drawContext(ctx);
      if (canvasApi.blocked(dc.layerId)) return;
      const id = resolveTargetId(e);
      if (!id) return;
      ctx.exec({ type: 'doc/deleteObject', id });
    },

    cancel() {
      clearGhost(canvasApi);
    },
  };
}

// canvas.mjs (the integrator's actual [ui-canvas] code, read directly to verify this seam)
// looks up handlers via lowercase DOM event names — drawApi[tool]['pointerdown'|'pointermove'|
// 'pointerup'|'click'|'dblclick'] — while the build brief's seam spec names them onPointerDown/
// onPointerMove/onPointerUp/onClick/onDblClick. Every tool below is implemented against the
// spec's on* names; withEventAliases() mirrors each present on* method onto its lowercase DOM
// counterpart so canvas.mjs's forwardToDrawApi() actually finds them — without this alias every
// draw tool would be silently inert (the lookup fails soft: `typeof handler === 'function'`
// just skips a missing key with no error). Both naming schemes stay callable.
const EVENT_ALIASES = [
  ['onPointerDown', 'pointerdown'],
  ['onPointerMove', 'pointermove'],
  ['onPointerUp', 'pointerup'],
  ['onClick', 'click'],
  ['onDblClick', 'dblclick'],
];

/** Adds lowercase DOM-event-name aliases for any onX handlers present on `tool`. */
function withEventAliases(tool) {
  for (const [onName, domName] of EVENT_ALIASES) {
    if (typeof tool[onName] === 'function') tool[domName] = tool[onName];
  }
  return tool;
}

/**
 * Builds the full drawtools handler map. Each tool object exposes only the pointer/click
 * handlers it needs (under both the onX and lowercase-DOM-event names — see withEventAliases);
 * canvas.mjs is expected to call `.cancel?.()` on Escape / tool switch to clear any in-progress
 * ghost (contract: "Escape cancels").
 * @param {{store:object, history:object, roster:object, maps:object, exec:Function}} ctx
 * @param {CanvasApi} canvasApi
 */
export function createDrawHandlers(ctx, canvasApi) {
  return {
    arrow: withEventAliases(createArrowTool(ctx, canvasApi)),
    draw: withEventAliases(createFreehandTool(ctx, canvasApi)),
    line: withEventAliases(createLineTool(ctx, canvasApi)),
    box: withEventAliases(createBoxTool(ctx, canvasApi)),
    circle: withEventAliases(createCircleTool(ctx, canvasApi)),
    zone: withEventAliases(createZoneTool(ctx, canvasApi)),
    text: withEventAliases(createTextTool(ctx, canvasApi)),
    measure: withEventAliases(createMeasureTool(ctx, canvasApi)),
    erase: withEventAliases(createEraseTool(ctx, canvasApi)),
  };
}
