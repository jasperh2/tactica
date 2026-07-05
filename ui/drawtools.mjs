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
//   - Arrow (click-driven: click1 anchors, plain click2 commits, Shift-click adds a checkpoint —
//     Jasper v2 rework) commits kind:'route' — the ONLY sketch-family gesture that produces
//     exported motion data; both its rendering (renderRoute) and hit-testing (core/geometry.mjs
//     hitTest's 'route' case) already exist and are tested.
//   - Draw/Line/Box/Circle commit as kind:'sketch' and are UI-only: they will not appear in the
//     exported animation.
//   - Text commits as kind:'text' — also UI-only per the same test/schema (playbook.json has
//     no text-note array; only per-keyframe `note` strings, owned by the inspector/playbookbar).
//   - Zone remains kind:'zone', which IS read by the exporter.
//
// Line/Box/Circle share one gesture shape (pointerdown anchors a start point, pointermove renders
// a ghost, pointerup commits or discards a too-short drag) — createDragTool() below is that shared
// lifecycle; Arrow (click-driven state machine), Zone (closed-polygon branch, bug 4 fix), Draw
// (continuous sampling), Text (single click), and Erase (click-to-delete) need bespoke state
// machines.
//
// Zone authoring (bug 4 fix): the Zone tool used to be createDragTool() reused verbatim from
// Circle (drag corner-to-corner -> ellipse) — a label slapped on Circle's code path with no
// authoring identity of its own. It is now a click-vertex polygon tool modeled directly on
// Arrow's click-polyline branch (createArrowTool below), adapted for a CLOSED, FILLED shape
// (min 3 vertices, not 2) instead of an open polyline: click each corner, see a live rubber-band
// fill preview, close by clicking near the first vertex / double-click / Enter, Esc cancels.
// Committed zones now carry a `shape` discriminator: 'polygon' {points} (this tool's new output)
// vs 'ellipse' {cx,cy,rx,ry} (pre-existing saved zones — rendering/hit-test/persist/export all
// keep dispatching on `shape` so old ellipse zones round-trip byte-identical, no migration).
import { simplify } from '../core/geometry.mjs';
import { activeTactic, visibleObjects } from '../core/playbook.mjs';
import {
  isMeaningfulDrag,
  isNearFirstVertex,
  strokeMarkup,
  rectMarkup,
  ellipseMarkup,
  polygonGhostMarkup,
  resolveEraseTargetId,
} from './drawtools-helpers.mjs';

const FREEHAND_SIMPLIFY_EPSILON = 0.35; // core/geometry.mjs default, named here for clarity
const DEFAULT_ZONE_LABEL = '';
const MIN_ZONE_POLYGON_VERTICES = 3; // a polygon needs >=3 points to be a renderable shape

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

    cancel,
  };
}

// =============================================================================
// Arrow — click-driven authoring (Jasper v2 spec, verbatim from the arrow-interaction diagnosis):
//   • click 1 anchors the start and begins a live rubber-band from the anchor to the cursor;
//   • a plain click 2 COMMITS the arrow with the arrowhead landing at click 2;
//   • a Shift-click adds a checkpoint corner and KEEPS authoring (the next plain click commits);
//   • Esc cancels (canvas.mjs Escape -> cancel()); switching tools mid-arrow cancels clean
//     (canvas.mjs store.subscribe -> cancel() on tool change);
//   • exactly ONE undo entry per committed arrow (a single ctx.exec(doc/placeObject)).
// The old dblclick-only commit + drag-to-draw reinterpretation are GONE — every plain click with
// an anchor present commits, so a fast native double-click fires click(commit),click,dblclick:
// the 2nd click commits (points -> null) and the trailing click/dblclick are guarded no-ops.
// Commits kind:'route' (the playbook.json movement-arrow channel — see file header). This is a
// deliberate behavior change to a shipped gesture (was: every click added a waypoint, only
// dblclick finished — Jasper's "always holding shift, can never let go").
// =============================================================================

function createArrowTool(ctx, canvasApi) {
  /** @type {[number,number][]|null} */
  let points = null; // null = idle; non-null while authoring, points[0] is the committed start.

  function drawGhost(pts, dc) {
    canvasApi.previewEl.innerHTML = strokeMarkup(pts, {
      ...strokeOpts(dc),
      aspect: canvasApi.getAspect(),
      ...boxOpt(canvasApi),
    });
  }

  function cancel() {
    points = null;
    clearGhost(canvasApi);
  }

  return {
    // Anchoring, checkpoints, and commit ALL happen on `click` (not pointerdown/up) so a click is
    // never ambiguous with a drag — there is no drag gesture on this tool anymore.
    onClick(e) {
      const dc = drawContext(ctx);
      if (canvasApi.blocked(dc.layerId)) return;
      const p = canvasApi.toPct(e.clientX, e.clientY);

      if (!points) {
        // click 1 — anchor the start. No ghost yet (a single point has no segment to draw; the
        // rubber-band appears on the first pointermove, matching the Zone tool's first-click gap).
        points = [[p.x, p.y]];
        return;
      }

      if (e.shiftKey) {
        // Shift-click — add a checkpoint corner and keep authoring. The next PLAIN click commits.
        points.push([p.x, p.y]);
        drawGhost(points, dc);
        return;
      }

      // Plain click with an anchor present — commit. The arrowhead lands at this click point.
      const committed = [...points, [p.x, p.y]];
      points = null;
      clearGhost(canvasApi);
      commit(ctx, canvasApi, dc.layerId, routeObject(dc, committed, dc.opts.head));
    },

    onPointerMove(e) {
      if (!points) return; // idle — no rubber-band until the start is anchored.
      const dc = drawContext(ctx);
      const p = canvasApi.toPct(e.clientX, e.clientY);
      drawGhost([...points, [p.x, p.y]], dc); // committed corners + rubber-band to the cursor.
    },

    // The browser fires click,click,dblclick on a fast second click; the 2nd click already
    // committed (points === null), so the trailing dblclick must be a safe no-op (guard) rather
    // than the old "dblclick commits" path (removed). Never starts or commits an arrow.
    onDblClick() {
      // no-op by design — see comment above. Guarded implicitly: with points===null there is
      // nothing to do, and with points!==null a dblclick shouldn't force a commit.
    },

    cancel,
  };
}

function strokeOpts(dc) {
  return { color: dc.role, thickness: dc.opts.thickness, dashed: dc.opts.dashed, head: dc.opts.head };
}

/** The one input core/stroke.mjs needs to make the ghost's stroke width px-identical to the
 * committed stroke: the live on-screen map-box width, read fresh each render. Every ghost-markup
 * call spreads this so the preview and the eventual committed object convert the same authored px
 * thickness/border through the same shared model. */
function boxOpt(canvasApi) {
  return { boxWidthPx: canvasApi.getBoxWidth() };
}

/**
 * Builds a Route object (architecture doc §3 / handoff README Route typedef) for the Arrow
 * tool's click-driven gesture (anchor -> optional Shift checkpoints -> commit). This is the
 * playbook.json movement-arrow channel —
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
        ...boxOpt(canvasApi),
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
      strokeMarkup([start, end], { ...strokeOpts(dc), head: 'none', aspect: canvasApi.getAspect(), ...boxOpt(canvasApi) }),
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
    (dc, start, end) => rectMarkup(start, end, { ...fillOpts(dc), ...boxOpt(canvasApi) }),
    (dc, start, end) => sketchObject(dc, 'rect', start, end)
  );
}

function createCircleTool(ctx, canvasApi) {
  return createDragTool(
    ctx,
    canvasApi,
    (dc, start, end) => ellipseMarkup(start, end, { ...fillOpts(dc), ...boxOpt(canvasApi) }),
    (dc, start, end) => sketchObject(dc, 'ellipse', start, end)
  );
}

// =============================================================================
// Zone — click-vertex polygon (bug 4 fix): click each corner, live rubber-band fill preview,
// close via click-near-first-vertex / double-click / Enter (min 3 vertices). Esc cancels.
// Commits kind:'zone' {shape:'polygon', points, label:''}. Existing saved ellipse zones
// (shape:'ellipse' {cx,cy,rx,ry}) are untouched by this tool — they still load/render/hit-test/
// export via their own dispatch branch in geometry.mjs/canvas-objects.mjs/render.mjs/
// exporter.mjs; this tool only ever AUTHORS the new polygon shape (no migration needed).
// =============================================================================

function createZoneTool(ctx, canvasApi) {
  /** @type {[number,number][]|null} */
  let polygonPoints = null; // non-null while building a click-vertex zone polygon

  function drawPolygonGhost(points, dc) {
    // Authoring ghost = open solid polyline (polygonGhostMarkup), NOT the committed dashed+filled
    // polygonMarkup: the finished zone's auto-closing filled `<polygon>` reads as a phantom box
    // while you're still placing vertices (Jasper v2 fix). Committed zones stay dashed+filled via
    // their own render path (canvas-objects.mjs) — this only changes the in-progress preview.
    canvasApi.previewEl.innerHTML = polygonGhostMarkup(points, { color: dc.role, ...boxOpt(canvasApi) });
  }

  function cancel() {
    polygonPoints = null;
    clearGhost(canvasApi);
  }

  /** Commits the in-progress polygon if it has enough vertices to be a real shape; silently
   * cancels (no commit) otherwise — mirrors Arrow's onDblClick "too-short, just cancel" rule,
   * but the threshold is 3 (a polygon's minimum) instead of Arrow's 2 (a line's minimum). */
  function closeAndCommit(dc) {
    if (!polygonPoints || polygonPoints.length < MIN_ZONE_POLYGON_VERTICES) {
      cancel();
      return;
    }
    const object = {
      kind: 'zone',
      shape: 'polygon',
      points: polygonPoints,
      label: DEFAULT_ZONE_LABEL,
      role: dc.role,
      layerId: dc.layerId,
      appearsAt: dc.appearsAt,
    };
    polygonPoints = null;
    clearGhost(canvasApi);
    commit(ctx, canvasApi, dc.layerId, object);
    // README §5: "zones get an optional label" — surface it in the inspector immediately via
    // the same selected-object card Select/Move-Resize already renders (matches the prior
    // drag-ellipse Zone tool's selectAfter:true behavior).
    selectLatest(ctx);
  }

  return {
    onPointerDown(e) {
      const dc = drawContext(ctx);
      if (canvasApi.blocked(dc.layerId)) return;
      const p = canvasApi.toPct(e.clientX, e.clientY);

      if (!polygonPoints) {
        // First vertex of a new polygon.
        polygonPoints = [[p.x, p.y]];
        drawPolygonGhost(polygonPoints, dc);
        return;
      }

      // Continuing an in-progress polygon: a click near the first vertex closes the shape
      // instead of adding a near-duplicate point on top of it.
      if (isNearFirstVertex(polygonPoints, [p.x, p.y])) {
        closeAndCommit(dc);
        return;
      }
      polygonPoints.push([p.x, p.y]);
      drawPolygonGhost(polygonPoints, dc);
    },

    onPointerMove(e) {
      if (!polygonPoints) return;
      const dc = drawContext(ctx);
      const p = canvasApi.toPct(e.clientX, e.clientY);
      // Live rubber-band preview: every committed vertex so far, plus the cursor's current
      // position as the tentative next vertex.
      drawPolygonGhost([...polygonPoints, [p.x, p.y]], dc);
    },

    onDblClick() {
      closeAndCommit(drawContext(ctx));
    },

    /** Enter closes the polygon the same way double-click does (bug 4 ask: "double-click/Enter
     * to close"). canvas.mjs's [ui-canvas] onKeyDown has no Enter path today (only Space/Escape/
     * Delete) — this method is new surface for the integrator to wire an Enter branch to,
     * mirroring the existing Escape branch's `drawApi[currentTool()].cancel?.()` shape:
     * `if (event.key === 'Enter') drawApi[currentTool()].onEnter?.()`. No other tool defines
     * onEnter, so this is purely additive (not a behavior change for any other draw tool). */
    onEnter() {
      closeAndCommit(drawContext(ctx));
    },

    cancel,
  };
}

// =============================================================================
// Text — click -> kind:'text' {x,y,text,size,chip}, then select it.
// The placed string comes from the Text options dock's prefill input (view.toolOptions
// .textPrefill, set via view/setToolOption — Jasper v2 fix: type the label once, then click to
// drop it, instead of every placement dropping a hardcoded 'Label' you must re-edit). An empty
// prefill places an empty text object and selects it, so the inspector's text panel opens for an
// immediate inline edit (the existing "edit selected note via the panel textarea" seam — there
// is no on-canvas contenteditable in this tool, and adding one is out of this lane's scope).
// The `chip` (background pill) reads dc.opts.textChip, which DEFAULT_TOOL_OPTIONS seeds ON, so
// placed labels get the background pill by default per Jasper's ask.
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
        text: dc.opts.textPrefill ?? '',
        size: dc.opts.textSize,
        chip: dc.opts.textChip,
        role: dc.role,
        layerId: dc.layerId,
        appearsAt: dc.appearsAt,
      });
      // selectLatest is both the "prefilled label placed, now selected" affordance AND the
      // empty-prefill inline-edit fallback: the inspector's Text panel renders an editable
      // textarea for the selected text object (editingTextNote), so an empty placement lands the
      // user straight in that textarea. Text edits commit via doc/setObjectProps (store.mjs
      // whitelists text/size/chip) — the seam the inspector already drives.
      selectLatest(ctx);
    },

    cancel() {
      clearGhost(canvasApi);
    },
  };
}

// =============================================================================
// Erase — click object -> exec doc/deleteObject {id}.
// =============================================================================

function createEraseTool(ctx, canvasApi) {
  /**
   * Erase-eligible objects at the current keyframe: visible-layer objects (visibleObjects()
   * already filters to layer.visible, so a hidden layer's objects are never erase candidates)
   * minus anything on a LOCKED layer — mirrors canvas.mjs's selectableObjects() exactly (the
   * Select tool's own click-candidate list), just resolved independently here since this module
   * does not import canvas.mjs (a different panel's owned file). Excluding locked-layer objects
   * from the candidate list itself (rather than checking lock only after a hit resolves) means a
   * locked layer's markers are never even hit-tested — locked = no-op, same guarantee the old
   * per-id isObjectLocked() check gave, arrived at the same way canvas.mjs's own click-select
   * path already does it.
   */
  function eraseCandidates() {
    const doc = ctx.store.getDoc();
    const view = ctx.store.getView();
    const tactic = activeTactic(doc);
    if (!tactic) return [];
    return visibleObjects(tactic, doc.layers, view.currentKeyframe).filter(
      (obj) => !canvasApi.blocked(obj.layerId)
    );
  }

  /**
   * Bug-hunt fix: the erase tool never hit markers because the SVG annotation overlay sits
   * visually above the markers layer and eats the pointer event — `event.target.closest('[data-
   * id]')` from the overlay's own `<svg>` node never finds a marker's `[data-id]` ancestor, so
   * clicking directly on a unit marker silently did nothing. Resolves the click geometrically
   * instead — exactly the Select tool's forgiving hit-test path (canvas.mjs's
   * resolvePointerHit / canvas-helpers.mjs's resolveHitId), mirrored here via this module's own
   * resolveEraseTargetId (core/geometry.mjs's hitTest under the hood) — so a click that would
   * select an object also erases it, independent of DOM stacking, for every object kind
   * including markers.
   * @param {PointerEvent|MouseEvent} e
   * @returns {string|null}
   */
  function resolveTargetId(e) {
    const p = canvasApi.toPct(e.clientX, e.clientY);
    return resolveEraseTargetId(eraseCandidates(), [p.x, p.y], canvasApi.getBoxWidth());
  }

  return {
    onClick(e) {
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
    erase: withEventAliases(createEraseTool(ctx, canvasApi)),
  };
}
