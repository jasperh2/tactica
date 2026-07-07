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
// UNIFIED GESTURE (Jasper's explicit refactor directive — "one shared two-point click-move-click
// primitive; line/box/circle/arrow inherit it; arrow adds shift-checkpoints; zone keeps its vertex
// loop; keep drag-commit as a bonus; no duplicated gesture logic anywhere"): Line, Box, Circle AND
// Arrow all run on ONE primitive — createTwoPointTool() below. It is a click-move-click state
// machine (click 1 anchors + rubber-bands to the cursor, plain click 2 commits) that ALSO accepts a
// press-drag-release as an equivalent one-shot gesture (the "bonus" — Excalidraw's dual contract,
// knowledge/research/canvas-tool-interaction-patterns.md §2). Arrow opts into checkpoints
// (Shift-click extends with a corner and keeps authoring) and commits kind:'route'; Line/Box/Circle
// are the same primitive with checkpoints OFF and a fixed 2-point commit. This REPLACES the old
// split where Line/Box/Circle shared a drag-only createDragTool() and Arrow had a separate
// click-only createArrowTool() — the two gesture code paths are now one. Zone (closed-polygon
// vertex loop, bug 4 fix), Draw (continuous sampling), Text (single click), and Erase
// (click-to-delete) keep their own bespoke state machines by design.
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
import { simplify, polygonBounds } from '../core/geometry.mjs';
import { activeTactic, interactableObjects } from '../core/playbook.mjs';
import {
  isMeaningfulDrag,
  isDebouncedClick,
  isNearFirstVertex,
  strokeMarkup,
  rectMarkup,
  ellipseMarkup,
  polygonGhostMarkup,
  resolveEraseTargetId,
  openInlineEditor,
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
  const id = latestObjectId(ctx);
  if (id) ctx.exec({ type: 'view/select', id });
}

/** Id of the most-recently-added object on the active tactic (the one commit() just wrote), or
 * null if none — used by selectLatest and by the Zone tool's on-canvas label entry to target the
 * just-committed zone with a doc/setObjectProps label update. */
function latestObjectId(ctx) {
  const doc = ctx.store.getDoc();
  const tactic = doc.tactics.find((t) => t.id === doc.activeTacticId);
  if (!tactic || tactic.objects.length === 0) return null;
  return tactic.objects[tactic.objects.length - 1].id;
}

/**
 * THE shared two-point gesture primitive (Jasper's unify-the-gesture directive). ONE state machine
 * that Line, Box, Circle AND Arrow all run on — no per-tool gesture code anywhere else. It supports
 * BOTH authoring gestures, disambiguated by which browser event fires (Excalidraw's dual contract,
 * research §2), leaning on the browser's own click-vs-drag synthesis rather than re-deriving it:
 *
 *   • CLICK-MOVE-CLICK: a `click` (press+release with no meaningful move — the browser only
 *     synthesizes `click` in that case) with nothing anchored yet anchors the start and begins a
 *     live rubber-band to the cursor on pointermove; the next plain `click` commits (far corner /
 *     arrowhead lands at click 2).
 *   • DRAG-COMMIT (the "bonus"): pointerdown, move past the threshold, pointerup — the pointerup
 *     commits the whole shape in one gesture (anchor = pointerdown point, far point = release).
 *
 * The two paths never collide: a real drag suppresses the trailing `click` (the browser fires no
 * `click` when the pointer moved far enough, and canvas.mjs additionally guards its own click), and
 * a plain click never trips the pointerup drag branch (pointerup only commits when it moved past the
 * threshold — a click did not). pointerdown seeds the anchor+rubber-band for BOTH paths so a
 * press-and-hold shows a live ghost immediately.
 *
 * Arrow opts in with `allowCheckpoints:true`: a Shift-CLICK while authoring pushes a checkpoint
 * corner and keeps going (the next plain click commits); Enter / double-click also finish; Esc
 * (cancel()) drops the uncommitted gesture. Line/Box/Circle pass `allowCheckpoints:false` and are a
 * pure 2-point commit. Every committed shape is exactly ONE ctx.exec (one undo entry).
 *
 * `renderGhost(dc, points)` returns the SVG ghost string for the in-progress point list (already
 * including the rubber-band cursor point when authoring); `buildObject(dc, points)` returns the doc
 * object to commit (or falsy to silently discard, e.g. a degenerate below-threshold shape).
 *
 * Click debounce (Jasper: "add a delay between clicks... pretty short just to prevent
 * accidental double clicks" — shapes only, never units/heroes/artillery placement, which don't
 * go through this primitive at all). Scoped narrowly to the anchor->first-commit transition: the
 * FIRST click anchors (unconditionally — an anchor is never itself "too soon," there is no
 * earlier click to debounce against yet); the very next click, if it arrives within
 * CLICK_DEBOUNCE_MS of the anchor, is treated as an accidental repeat and ignored (the gesture
 * stays pending, exactly like the pre-existing "this IS the anchoring click" same-point no-op —
 * this is the SAME kind of no-op, just gated on time instead of position). Every click while
 * authoring (accepted or debounced) updates the tracked timestamp, so a burst of rapid
 * accidental clicks can't accumulate into a commit just because enough time passed since the
 * very first one. dblclick/Enter-finish (>=2 points already placed) and drag-commit
 * (onPointerUp) never consult this — see their own comments below.
 *
 * @param {object} ctx
 * @param {CanvasApi} canvasApi
 * @param {(dc:object, points:[number,number][]) => string} renderGhost
 * @param {(dc:object, points:[number,number][]) => (object|null)} buildObject
 * @param {{selectAfter?: boolean, allowCheckpoints?: boolean, now?: () => number}} [opts]
 */
function createTwoPointTool(ctx, canvasApi, renderGhost, buildObject, opts = {}) {
  const { selectAfter = false, allowCheckpoints = false, now = Date.now } = opts;
  /** Committed points so far while authoring; null = idle. points[0] is the anchored start; a
   * no-checkpoint tool only ever holds the single start point here until commit. */
  let points = null;
  /** The current press's pointerdown point (percent space); non-null only between a pointerdown and
   * its pointerup, so the pointerup can measure the drag distance. */
  let pressStart = null;
  /** ms timestamp of the most recent click received while authoring (set by the anchoring click
   * AND every click after it, accepted or debounced); null when idle. Feeds isDebouncedClick() —
   * see the click-debounce doc above. */
  let lastClickAt = null;
  /** Set true the instant ANY commit happens (drag-commit on pointerup, or click/dblclick/Enter
   * commit); consumed by the very next `click` (which is then swallowed) and unconditionally
   * cleared by the next `pointerdown`. This is THE duplicate-shape fix (Jasper hotfix 2026-07-06):
   * a press-drag-release fires a trailing synthetic `click` in the real browser (the old
   * dragRelease test helper wrongly assumed it doesn't), and that trailing click used to hit the
   * onClick "no anchor yet -> re-anchor" branch and seed a PHANTOM anchor at the release point —
   * the user's next click then committed a second, unwanted shape. Mirrors canvas.mjs's own
   * `suppressNextClick` latch (its select/move drags have the identical trailing-click problem)
   * exactly: set on the moved-gesture commit, consumed by the one trailing click, cleared at the
   * next pointerdown so it can never linger and swallow a genuine later click. */
  let suppressClick = false;

  function cancel() {
    points = null;
    pressStart = null;
    lastClickAt = null;
    suppressClick = false;
    clearGhost(canvasApi);
  }

  function drawGhost(pts) {
    canvasApi.previewEl.innerHTML = renderGhost(drawContext(ctx), pts);
  }

  function doCommit(pts) {
    const dc = drawContext(ctx);
    points = null;
    pressStart = null;
    lastClickAt = null;
    suppressClick = true; // swallow the trailing synthetic click this commit's gesture may emit
    clearGhost(canvasApi);
    const object = buildObject(dc, pts);
    if (!object) return;
    commit(ctx, canvasApi, dc.layerId, object);
    if (selectAfter) selectLatest(ctx);
  }

  return {
    onPointerDown(e) {
      // A fresh press moots any pending post-commit click suppression: whether this press ends up
      // anchoring a new gesture or continuing one, the latch's job (eat exactly the ONE trailing
      // click of the just-committed gesture) is over — clearing here bounds it to that one click
      // even when the browser suppressed that click (drag moved far enough), so it can never
      // linger and swallow a genuine later click. Same bound canvas.mjs applies at its pointerdown.
      suppressClick = false;
      const dc = drawContext(ctx);
      if (canvasApi.blocked(dc.layerId)) return;
      const p = canvasApi.toPct(e.clientX, e.clientY);
      pressStart = [p.x, p.y];
      // Seed the anchor + a live rubber-band for a fresh gesture so press-and-hold previews
      // immediately (drag path). A press mid-authoring (click-move-click already anchored) does NOT
      // reset the anchor — the click/pointerup decides.
      if (!points) {
        points = [[p.x, p.y]];
        // The REAL browser event order for a plain click is pointerdown -> pointerup -> click, so
        // THIS is where the anchor is actually placed in practice — lastClickAt must be seeded
        // here, not only in onClick's defensive no-anchor-yet branch (which only fires if a click
        // ever arrives with pointerdown having been swallowed). Without this, the debounce below
        // never sees a real previous-click timestamp for the realistic tap-tap sequence.
        lastClickAt = now();
        drawGhost([[p.x, p.y], [p.x, p.y]]);
      }
    },

    onPointerMove(e) {
      if (!points) return; // idle — nothing to rubber-band against.
      const p = canvasApi.toPct(e.clientX, e.clientY);
      drawGhost([...points, [p.x, p.y]]); // committed points + rubber-band to the cursor.
    },

    onPointerUp(e) {
      // Only the DRAG-COMMIT bonus lives here: a pointerup that moved past the threshold since its
      // pointerdown commits anchor..release. A plain click's pointerup did NOT move far, so it falls
      // through to `click` (the click-move-click path) — no double-handling. Never debounced: a
      // genuine press-drag-release has already proven deliberate intent via the movement itself.
      const start = pressStart;
      pressStart = null;
      if (!points || !start) return;
      const p = canvasApi.toPct(e.clientX, e.clientY);
      if (isMeaningfulDrag(start, [p.x, p.y])) doCommit([points[0], [p.x, p.y]]);
    },

    onClick(e) {
      // The click-move-click path. A real drag never reaches here (the browser suppresses `click`
      // after a far-enough move; canvas.mjs also guards it), so a click here is always a genuine
      // click. pointerdown already anchored the start for the FIRST click of a gesture, so:
      const dc = drawContext(ctx);
      if (canvasApi.blocked(dc.layerId)) return;

      // Swallow the ONE trailing synthetic click a just-committed gesture emits (a press-drag-
      // release fires pointerup->commit->click in the real browser; a double-click's committing
      // click is followed by more clicks). Without this, that trailing click fell into the
      // re-anchor branch below and seeded a phantom anchor the user's NEXT click turned into a
      // duplicate shape (Jasper's bug). Consuming it here leaves the tool cleanly idle instead.
      if (suppressClick) {
        suppressClick = false;
        return;
      }

      const p = canvasApi.toPct(e.clientX, e.clientY);

      // Defensive: if a click ever arrives with no anchor (e.g. pointerdown was swallowed), treat it
      // as the anchoring click so the gesture still starts cleanly. An anchor is never itself "too
      // soon" (there is no earlier click yet), so this always seeds lastClickAt unconditionally.
      if (!points) {
        points = [[p.x, p.y]];
        lastClickAt = now();
        return;
      }

      if (allowCheckpoints && e.shiftKey) {
        // Shift-click — add a checkpoint corner and keep authoring; the next plain click commits.
        // Not debounced: a modifier-key click is a deliberate, distinct gesture from an accidental
        // double-click, and it doesn't commit anything (Jasper's ask is scoped to the commit).
        points.push([p.x, p.y]);
        lastClickAt = now();
        drawGhost(points);
        return;
      }

      if (points.length === 1 && samePoint(points[0], [p.x, p.y])) {
        // This IS the anchoring click (its own pointerdown seeded points[0] at the same point). Stay
        // pending; the rubber-band is already live from pointermove. lastClickAt is already set from
        // the branch above (or the pointerdown-seeded first click) — nothing new to record here.
        return;
      }

      // This click would COMMIT — the anchor->first-commit transition the debounce guards. If it
      // arrives within CLICK_DEBOUNCE_MS of the previous click, treat it as an accidental repeat:
      // ignore it, stay pending (same shape as the same-point no-op above), but DO advance
      // lastClickAt so a subsequent rapid click must clear its own gap from THIS one, not the
      // original anchor — a burst of clicks can't outlast the debounce just by accumulating time
      // since the very first click.
      const clickAt = now();
      if (isDebouncedClick(lastClickAt, clickAt)) {
        lastClickAt = clickAt;
        return;
      }
      // Committing click — the far end lands here.
      doCommit([...points, [p.x, p.y]]);
    },

    // Enter / double-click finish an in-progress checkpointed gesture at its current points; for a
    // gesture with only the anchor (or the trailing dblclick after a plain-click commit, when
    // points is already null) they are a safe no-op. Never debounced (mission requirement): these
    // only ever fire once >=2 points are already placed — a deliberate multi-click authoring
    // session, not the anchor->first-commit transition the guard targets.
    onDblClick() {
      if (points && points.length >= 2) {
        doCommit(points);
        return;
      }
      // A dblclick with only a lone anchor (or none) is the tail of a native double-click whose
      // second press re-anchored a PHANTOM point after the first click already committed — clear
      // it so it can't linger and be committed as a duplicate by the user's next click (Jasper's
      // "double-clicking spawns a second shape" bug). Harmless no-op when already idle.
      cancel();
    },
    onEnter() {
      if (points && points.length >= 2) doCommit(points);
    },

    cancel,
  };
}

/** True when two percent-space points coincide to within the drag threshold (a zero-move click
 * lands its pointerup/click at the exact pointerdown point). */
function samePoint(a, b) {
  return !isMeaningfulDrag(a, b);
}

function strokeOpts(dc) {
  return { color: dc.role, thickness: dc.opts.thickness, dashed: dc.opts.dashed, head: dc.opts.head };
}

/** The two inputs every ghost-markup call needs, read fresh each render:
 *  - `boxWidthPx` — core/stroke.mjs's px->viewBox stroke-width conversion, so the ghost's stroke
 *    width is px-identical to the committed stroke.
 *  - `aspect` (map h/w) — the SVG Y-unit boundary (Bug A): the shape builders convert stored
 *    height-percent y into the overlay's viewBox width-units via geometry.svgEmitY, so the ghost
 *    sits at the cursor exactly like the committed object (which converts with the same aspect).
 * Every ghost-markup call spreads this so the preview and the eventual committed object share both
 * conversions. */
function boxOpt(canvasApi) {
  return { boxWidthPx: canvasApi.getBoxWidth(), aspect: canvasApi.getAspect() };
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

// =============================================================================
// Arrow — the shared two-point primitive with checkpoints ON, committing kind:'route' (the
// playbook.json movement-arrow channel). Click-anchor -> plain-click-commit (arrowhead at click 2),
// Shift-click adds a checkpoint corner and keeps authoring, Enter/dblclick finish, Esc cancels;
// press-drag-release is the one-shot bonus. All of that logic lives in createTwoPointTool — Arrow is
// just a thin wiring of that primitive to the route ghost + route builder, no bespoke state machine.
// =============================================================================

function createArrowTool(ctx, canvasApi, now) {
  return createTwoPointTool(
    ctx,
    canvasApi,
    (dc, points) => strokeMarkup(points, { ...strokeOpts(dc), ...boxOpt(canvasApi) }),
    (dc, points) => routeObject(dc, points, dc.opts.head),
    { allowCheckpoints: true, now }
  );
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
// Line — the shared two-point primitive (checkpoints OFF), committing a plain 2-point sketch
// (shape:'line', no arrowhead). Click-anchor -> plain-click-commit, OR press-drag-release — both
// via createTwoPointTool, same as Arrow minus the checkpoints. `points` always holds exactly the
// [start, end] pair the primitive commits.
// =============================================================================

function createLineTool(ctx, canvasApi, now) {
  return createTwoPointTool(
    ctx,
    canvasApi,
    (dc, points) => strokeMarkup(points, { ...strokeOpts(dc), head: 'none', ...boxOpt(canvasApi) }),
    (dc, points) => sketchStrokeObject(dc, 'line', twoPoints(points), 'none'),
    { now }
  );
}

// =============================================================================
// Box / Circle — the shared two-point primitive (checkpoints OFF), committing rect/ellipse
// sketches. Click-anchor -> plain-click-commit, OR press-drag-release. NOT exported (see file
// header). The ghost/build read the first + last point as the two drag corners (twoPoints) so a
// stray mid-gesture rubber-band never widens the committed box.
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

/** The two defining corners of a two-point gesture: the anchored start and the current far point.
 * Box/Circle are corner-to-corner shapes, so they only ever use points[0] and the last point even
 * though the shared primitive can carry checkpoints for Arrow. */
function twoPoints(points) {
  return [points[0], points[points.length - 1]];
}

function createBoxTool(ctx, canvasApi, now) {
  return createTwoPointTool(
    ctx,
    canvasApi,
    (dc, points) => rectMarkup(points[0], points[points.length - 1], { ...fillOpts(dc), ...boxOpt(canvasApi) }),
    (dc, points) => sketchObject(dc, 'rect', points[0], points[points.length - 1]),
    { now }
  );
}

function createCircleTool(ctx, canvasApi, now) {
  return createTwoPointTool(
    ctx,
    canvasApi,
    (dc, points) => ellipseMarkup(points[0], points[points.length - 1], { ...fillOpts(dc), ...boxOpt(canvasApi) }),
    (dc, points) => sketchObject(dc, 'ellipse', points[0], points[points.length - 1]),
    { now }
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

/**
 * @param {object} ctx
 * @param {CanvasApi} canvasApi
 * @param {() => number} [now] injected clock (defaults to Date.now) — see createTwoPointTool's
 *   click-debounce doc for why this is never Date.now() called directly.
 */
function createZoneTool(ctx, canvasApi, now = Date.now) {
  /** @type {[number,number][]|null} */
  let polygonPoints = null; // non-null while building a click-vertex zone polygon
  /** ms timestamp of the most recently placed vertex; null when idle. Feeds the duplicate-vertex
   * debounce below (Jasper's ask, scoped narrowly to "adding a duplicate vertex at the same
   * spot" — NOT a blanket delay on every vertex click, which would fight normal fast polygon
   * authoring). */
  let lastVertexAt = null;

  function drawPolygonGhost(points, dc) {
    // Authoring ghost = open solid polyline (polygonGhostMarkup), NOT the committed dashed+filled
    // polygonMarkup: the finished zone's auto-closing filled `<polygon>` reads as a phantom box
    // while you're still placing vertices (Jasper v2 fix). Committed zones stay dashed+filled via
    // their own render path (canvas-objects.mjs) — this only changes the in-progress preview.
    canvasApi.previewEl.innerHTML = polygonGhostMarkup(points, { color: dc.role, ...boxOpt(canvasApi) });
  }

  /** Handle for the on-canvas label editor opened right after a zone commits; null when idle. */
  let labelEditor = null;

  function cancel() {
    polygonPoints = null;
    lastVertexAt = null;
    // A tool switch / Escape while the post-commit label box is open commits it cleanly (its
    // onCommit no-ops on an empty value, so the zone just keeps its default '' label) — no
    // phantom, no dangling editor element. close() is idempotent.
    if (labelEditor) {
      labelEditor.close();
      labelEditor = null;
    }
    clearGhost(canvasApi);
  }

  /** Commits the in-progress polygon if it has enough vertices to be a real shape; silently
   * cancels (no commit) otherwise — mirrors Arrow's onDblClick "too-short, just cancel" rule,
   * but the threshold is 3 (a polygon's minimum) instead of Arrow's 2 (a line's minimum). On a
   * real commit it opens an on-canvas label box at the polygon's top-center (CV7) so the zone can
   * be NAMED without leaving the canvas — no window.prompt (dark-theme seam). The inspector path
   * still works as a fallback because the new zone is also selected. */
  function closeAndCommit(dc) {
    if (!polygonPoints || polygonPoints.length < MIN_ZONE_POLYGON_VERTICES) {
      cancel();
      return;
    }
    const committedPoints = polygonPoints;
    const object = {
      kind: 'zone',
      shape: 'polygon',
      points: committedPoints,
      label: DEFAULT_ZONE_LABEL,
      role: dc.role,
      layerId: dc.layerId,
      appearsAt: dc.appearsAt,
    };
    polygonPoints = null;
    lastVertexAt = null;
    clearGhost(canvasApi);
    commit(ctx, canvasApi, dc.layerId, object);
    // README §5: "zones get an optional label" — also surface it in the inspector immediately via
    // the same selected-object card Select/Move-Resize already renders (fallback edit path).
    selectLatest(ctx);

    // CV7 on-canvas label entry: name the zone right where it sits. Anchor the box at the
    // polygon's top-center (polygonBounds → {cx, minY}), matching where the committed label pill
    // renders (canvas-objects.mjs). An empty box leaves the zone's default '' label untouched; a
    // non-empty box writes it via doc/setObjectProps {label} — the same seam the inspector drives.
    const zoneId = latestObjectId(ctx);
    if (!zoneId) return;
    const bounds = polygonBounds(committedPoints);
    labelEditor = openInlineEditor({
      mount: canvasApi.mapEl,
      documentEl: canvasApi.documentEl,
      at: { x: bounds.cx, y: bounds.minY },
      seed: '',
      className: 'tactica-inline-editor--zone-label',
      onCommit(value) {
        labelEditor = null;
        if (value) ctx.exec({ type: 'doc/setObjectProps', id: zoneId, props: { label: value } });
      },
      onCancel() {
        labelEditor = null;
      },
    });
  }

  return {
    onPointerDown(e) {
      const dc = drawContext(ctx);
      if (canvasApi.blocked(dc.layerId)) return;
      const p = canvasApi.toPct(e.clientX, e.clientY);

      if (!polygonPoints) {
        // First vertex of a new polygon — never debounced (there is no earlier vertex yet).
        polygonPoints = [[p.x, p.y]];
        lastVertexAt = now();
        drawPolygonGhost(polygonPoints, dc);
        return;
      }

      // Continuing an in-progress polygon: a click near the first vertex closes the shape
      // instead of adding a near-duplicate point on top of it.
      if (isNearFirstVertex(polygonPoints, [p.x, p.y])) {
        closeAndCommit(dc);
        return;
      }

      // Duplicate-vertex debounce (Jasper's ask, scoped narrowly): a click landing at
      // essentially the SAME spot as the just-placed vertex, arriving within
      // CLICK_DEBOUNCE_MS of it, is an accidental repeat — ignore it rather than pushing a
      // zero-length degenerate edge onto the polygon. Deliberately does NOT gate normal fast
      // clicking of DISTINCT corners (samePoint() is false for any real next vertex, so this
      // branch never fires for a genuine polygon-authoring click, however quick).
      const lastVertex = polygonPoints[polygonPoints.length - 1];
      const clickAt = now();
      if (samePoint(lastVertex, [p.x, p.y]) && isDebouncedClick(lastVertexAt, clickAt)) {
        lastVertexAt = clickAt;
        return;
      }

      polygonPoints.push([p.x, p.y]);
      lastVertexAt = clickAt;
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
// Text — an explicit left-CLICK on the canvas opens a focused on-canvas textarea at the click
// point (openInlineEditor); typing there types into a REAL textarea, so app.mjs's installShortcuts
// (which early-returns via isTypingTarget for any focused TEXTAREA) NO LONGER routes tool hotkeys
// (M/A/P/…) into the box — Jasper's "keybindings go into the textbox" bug. The box is created
// ONLY on that click; selecting the Text tool never auto-spawns or auto-focuses a box. Enter or
// click-away commits kind:'text' {x,y,text,size,chip}; an empty (whitespace-only) box commits
// NOTHING and leaves no phantom object; Escape cancels with no commit. `text` is seeded from the
// dock's textPrefill so a pre-typed label drops immediately (the user can still edit it in the
// box before committing). `chip` reads dc.opts.textChip (DEFAULT_TOOL_OPTIONS seeds it ON). After
// a real commit the new object is selected so the inspector's Text panel stays available as a
// fallback edit path.
// =============================================================================

function createTextTool(ctx, canvasApi) {
  /** The live inline-editor handle while one is open; null when idle. Guards against a second
   * click opening a second overlapping box (the first commits first). */
  let editor = null;

  function placeText(dc, p, value) {
    // Empty/whitespace-only text commits nothing — no phantom object (Jasper's ask). A trimmed
    // value is what openInlineEditor already hands back, but re-guarding here keeps the DOM-less
    // test fallback (which passes the seed straight through) honest too.
    if (!value) return;
    commit(ctx, canvasApi, dc.layerId, {
      kind: 'text',
      x: p.x,
      y: p.y,
      text: value,
      size: dc.opts.textSize,
      chip: dc.opts.textChip,
      role: dc.role,
      layerId: dc.layerId,
      appearsAt: dc.appearsAt,
    });
    // Select the just-placed note so the inspector Text panel targets it (fallback edit path).
    selectLatest(ctx);
  }

  return {
    onClick(e) {
      const dc = drawContext(ctx);
      if (canvasApi.blocked(dc.layerId)) return;
      if (editor) {
        // A pending box commits first (click-away semantics), then this click starts a fresh one.
        editor.close();
        editor = null;
      }
      const p = canvasApi.toPct(e.clientX, e.clientY);
      editor = openInlineEditor({
        mount: canvasApi.mapEl,
        documentEl: canvasApi.documentEl,
        at: p,
        seed: dc.opts.textPrefill ?? '',
        className: 'tactica-inline-editor--text',
        onCommit(value) {
          editor = null;
          placeText(dc, p, value);
        },
        onCancel() {
          editor = null;
        },
      });
    },

    cancel() {
      // Tool switch / Escape while a box is open commits it cleanly (no phantom), then clears any
      // ghost. close() is idempotent, so a double cancel is safe.
      if (editor) {
        editor.close();
        editor = null;
      }
      clearGhost(canvasApi);
    },
  };
}

// =============================================================================
// Erase — click object -> exec doc/deleteObject {id}.
// =============================================================================

function createEraseTool(ctx, canvasApi) {
  /**
   * Erase-eligible objects at the current keyframe: core/playbook.mjs's interactableObjects()
   * — active layer ONLY (Jasper's ruling), minus anything on a LOCKED or hidden layer. Mirrors
   * canvas.mjs's selectableObjects() exactly (the Select tool's own click-candidate list), just
   * resolved independently here since this module does not import canvas.mjs (a different
   * panel's owned file) — both call the same shared core helper, so the two candidate lists
   * can never drift. Excluding non-active/locked-layer objects from the candidate list itself
   * (rather than checking after a hit resolves) means they are never even hit-tested: a click
   * that would land on a non-active-layer object is a clean no-op, same as clicking empty
   * ground — the same guarantee the old per-id isObjectLocked() check gave for locked layers.
   */
  function eraseCandidates() {
    const doc = ctx.store.getDoc();
    const view = ctx.store.getView();
    const tactic = activeTactic(doc);
    if (!tactic) return [];
    return interactableObjects(tactic, doc.layers, view.currentKeyframe, view.activeLayerId);
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

  // Hold-and-drag sweep (Jasper hot fix 2026-07-06): press, drag over everything you want gone,
  // release. ONE-UNDO batching (CV4): the WHOLE gesture is a single history entry — a 10-object
  // sweep undoes in ONE Ctrl+Z, not ten. This mirrors how commitDrag/commitGroupResize snapshot
  // once per gesture: instead of exec'ing doc/deleteObject per touched object mid-drag, the sweep
  // ACCUMULATES the touched ids in `swept` and flushes them as a single doc/deleteObjects on
  // pointerup (app.mjs snapshots history once for that one dispatch). `swept` also doubles as the
  // "already gone" set so an id the cursor re-crosses within the same drag is never re-collected,
  // and — because resolveTargetId still hit-tests the LIVE doc (objects aren't deleted until
  // pointerup) — it is what keeps an already-swept object from resolving again as the topmost hit.
  // `sweeping` is plain gesture state; a pointerup/cancel anywhere ends it.
  let sweeping = false;
  /** @type {Set<string>} ids touched during the current sweep, flushed as one batch on pointerup. */
  const swept = new Set();
  /** Set true when a pointerup flush just ran; consumed by the ONE trailing synthetic click the
   * browser emits after a press+release (so that click doesn't re-erase / double-delete), and
   * cleared by the next pointerdown. Mirrors the two-point tools' suppressClick latch. */
  let suppressClick = false;

  /** Resolves the erase target under the pointer, skipping anything already swept this gesture so
   * a re-crossed object doesn't resolve again (it's still in the live doc until the pointerup
   * flush). Returns null when nothing new is under the cursor. */
  function resolveNewTargetId(e) {
    const id = resolveTargetId(e);
    if (!id || swept.has(id)) return null;
    return id;
  }

  function collectAt(e) {
    const id = resolveNewTargetId(e);
    if (id) swept.add(id);
  }

  function flush() {
    if (swept.size === 0) return;
    const ids = [...swept];
    swept.clear();
    // One id vs many: keep the singular action for a single-object erase (matches the inspector's
    // delete-button convention and the erase tests' click assertions) and use the batched action
    // for a multi-object sweep — either way it is exactly ONE dispatch = ONE undo entry.
    if (ids.length === 1) ctx.exec({ type: 'doc/deleteObject', id: ids[0] });
    else ctx.exec({ type: 'doc/deleteObjects', ids });
  }

  return {
    onPointerDown(e) {
      if (e.button !== 0) return;
      suppressClick = false; // a fresh press moots any pending trailing-click suppression.
      sweeping = true;
      swept.clear();
      collectAt(e);
    },

    onPointerMove(e) {
      if (sweeping) collectAt(e);
    },

    onPointerUp() {
      if (!sweeping) return;
      sweeping = false;
      suppressClick = true; // swallow the ONE trailing synthetic click this gesture emits.
      flush(); // whole gesture -> ONE history entry.
    },

    onClick(e) {
      // Swallow the single trailing synthetic click a just-flushed press+release emits, so it
      // can't re-erase (the sweep already dispatched the delete for this spot).
      if (suppressClick) {
        suppressClick = false;
        return;
      }
      // A pure click with no preceding sweep (e.g. a caller/test dispatching only `click`) erases
      // the single object under it in one dispatch.
      const id = resolveTargetId(e);
      if (!id) return;
      ctx.exec({ type: 'doc/deleteObject', id });
    },

    cancel() {
      sweeping = false;
      suppressClick = false;
      swept.clear();
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
 * @param {() => number} [now] injected clock for the shape-tool click debounce (Arrow/Line/Box/
 *   Circle/Zone only — units/heroes/artillery placement and every other tool never read it).
 *   Defaults to Date.now in production; tests pass a controllable fake clock so the debounce
 *   logic is never subject to real-wall-clock timing flakiness.
 */
export function createDrawHandlers(ctx, canvasApi, now = Date.now) {
  return {
    arrow: withEventAliases(createArrowTool(ctx, canvasApi, now)),
    draw: withEventAliases(createFreehandTool(ctx, canvasApi)),
    line: withEventAliases(createLineTool(ctx, canvasApi, now)),
    box: withEventAliases(createBoxTool(ctx, canvasApi, now)),
    circle: withEventAliases(createCircleTool(ctx, canvasApi, now)),
    zone: withEventAliases(createZoneTool(ctx, canvasApi, now)),
    text: withEventAliases(createTextTool(ctx, canvasApi)),
    erase: withEventAliases(createEraseTool(ctx, canvasApi)),
  };
}
