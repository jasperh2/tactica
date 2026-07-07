// ui/inspector.mjs — TACTICA contextual inspector [ui-inspector]
// Content swaps per view.tool (contract §5 / handoff README §5). Rebuilds innerHTML from
// state on every store change; event delegation on the panel root. No cross-panel imports.
//
// Text-note editing + zone labels both go through doc/setObjectProps (core/store.mjs), a
// single whitelisted action for the small set of kind-specific editable props that don't
// warrant their own doc/* action (TextNote text/size/chip; Zone label — contract §3). The
// text panel dispatches it when an existing text object is selected (editingTextNote());
// the select/move panel dispatches it for a selected zone's label field. Both are debounced
// 300ms like the existing frame-notes textarea.

import { activeTactic, positionAt } from '../core/playbook.mjs';
import {
  toolMeta,
  isLineLikeTool,
  isShapeTool,
  escapeHtml,
  filterRoster,
  sortRosterEntries,
  renderRarityLegend,
  renderRosterGrid,
  renderArmedCard,
  renderSortControl,
  renderSliderWithValue,
  renderNextLabelBlock,
  renderRoleSwatches,
  renderMultiSelectPanel,
  renderErasePanel,
  clearableObjects,
  renderPanPanel,
  renderFrameNotes,
  objectKindLabel,
  renderLabelField,
  fmtCoordPair,
  renderShapeEditors,
  renderUnitLabelField,
  isLineLikeSketch,
} from './inspector-helpers.mjs';
import { installGlobalSearchFocus } from './inspector-shortcuts.mjs';

const NOTE_DEBOUNCE_MS = 300;
// MUST stay numerically equal to canvas-objects.mjs's own MIN_MARKER_SIZE/MAX_MARKER_SIZE (the
// on-canvas resize handle's clamp range, increment 2/6) — kept as a separate local const rather
// than a cross-panel import per this module's own "no cross-panel imports" header comment.
const MIN_MARKER_SIZE = 16;
const MAX_MARKER_SIZE = 54;
const MIN_TEXT_SIZE = 8;
const MAX_TEXT_SIZE = 40;
// Stroke-width recalibration (Jasper v2 + stage-1 bigger-map + arrow calibration): a typed
// thickness value means genuine SCREEN PX (core/stroke.mjs converts px->viewBox at render). Range
// 0.25..5 with the DEFAULT at 3 (app.mjs DEFAULT_TOOL_OPTIONS.thickness — Jasper's shared-bag
// calibration): sub-1px widths (0.25/0.5/0.75) below for fine linework, 3px the confident default,
// up to 5px for bold routes on the fit-to-column map (strokes scale with zoom, so 5px @100% is very
// heavy zoomed in). step=0.25 exposes the fractional widths. Typed px stays consistent: the number
// IS the on-screen px width. HEAD_REFERENCE_THICKNESS_PX is pinned to the 3px default so the arrow
// head is calibrated at the default and scales proportionally across the whole range.
const MIN_THICKNESS = 0.25;
const MAX_THICKNESS = 5;
const THICKNESS_STEP = 0.25;
// Box/Circle border: Jasper's spec is literal — "1px size should be in the middle of the
// slider" — so the range is 0.25..1.75, putting 1.0 at the exact midpoint with sub-1px fine
// borders below it. (Routes/draw keep the wider 0.25..3 THICKNESS range above; the midpoint
// ask was specific to box/circle borders.)
const MIN_BORDER = 0.25;
const MAX_BORDER = 1.75;
const BORDER_STEP = 0.25;
const MIN_LABEL_SIZE = 6;
const MAX_LABEL_SIZE = 20;

// Selectable palette tabs (sidebar-v2 design 2a/CHANGES §3: Extra tab REMOVED, Jasper-approved
// 2026-07-05 — "doesn't get used"). roster.extra still exists in data/roster.json and still
// renders fine wherever an existing doc/object references it (e.g. already-placed 'extra'
// markers on the canvas) — only the SELECTABLE TAB is gone, per the mission's "keep their
// rendering support for existing docs, just no tab".
const PALETTE_TABS = ['heroes', 'units', 'artillery'];
const DEFAULT_PALETTE_TAB = 'units';

// Defaults for the two NEW "applies at next placement" ViewState fields (markerSize,
// nextLabel) — mirrors the mockup's own defaults (26px marker, 9px label, background on,
// south position). Used ONLY as a defensive `??` fallback here so this panel never throws if
// a caller's view doesn't carry these fields yet (e.g. a test double, or app.mjs's
// freshView()/a persisted doc from before this stage — that seam is app.mjs's, not owned
// here); real interactive state always comes from the store once a value has been set once.
const DEFAULT_MARKER_SIZE = 26;
const DEFAULT_NEXT_LABEL = { text: '', background: true, size: 9, position: 'S' };

function header(toolId) {
  const meta = toolMeta(toolId);
  return `
    <div class="inspector-header">
      <div class="inspector-header-tile"><i class="ph-bold ${escapeHtml(meta.icon)}" aria-hidden="true"></i></div>
      <div class="inspector-header-text">
        <div class="inspector-header-name">${escapeHtml(meta.name)}</div>
        <div class="inspector-header-hint">Panel follows the active tool</div>
      </div>
      <span class="chip chip-mono chip-neutral inspector-header-key">${escapeHtml(meta.key)}</span>
    </div>
  `;
}

// ---- Place tool --------------------------------------------------------------

function findObject(tactic, id) {
  return tactic?.objects.find((o) => o.id === id) ?? null;
}

/**
 * Bug-hunt fix, extended by Jasper's active-layer-only ruling: every Inspector-driven object
 * edit (delete, resize, recolor, text/zone-label setObjectProps) must refuse a target that is
 * EITHER on a locked/hidden layer OR on a layer that isn't the active one — "you cannot ever
 * interact with another layer if its not active thats the point of layers." Mirrors
 * canvas.mjs's own (private, non-exported per that module's convention, so duplicated here
 * rather than cross-panel-imported) isBlockedForInteraction: resolve the object's layerId from
 * the active tactic, refuse on active-layer mismatch first, then check doc.layers for that
 * layer's lock flag. An id that doesn't resolve to a live object is treated as locked (refuse)
 * — defensive, not normally reachable since callers only pass ids already known to be
 * selected/present (and selection itself is already active-layer-gated at the point of
 * selection — this is the belt-and-suspenders check for a stale selection surviving an
 * active-layer switch).
 * @param {object} doc
 * @param {{activeLayerId:string}} view
 * @param {string} objectId
 * @returns {boolean}
 */
function isObjectLocked(doc, view, objectId) {
  const tactic = activeTactic(doc);
  const obj = findObject(tactic, objectId);
  if (!obj) return true;
  if (obj.layerId !== view.activeLayerId) return true; // non-active layer — always excluded
  const layer = doc.layers.find((l) => l.id === obj.layerId);
  return !!(layer && layer.locked);
}

/**
 * The single selected object, IF exactly one object is selected (view.selection is now
 * string[] — multi-select rework, bug 5/6 diagnosis). Every single-object inspector control
 * (size slider, zone label, delete button, role recolor, text editing) should read through
 * this instead of the old scalar `findObject(tactic, view.selection)`, so a 0- or 2+-object
 * selection cleanly resolves to null (hide/no-op) rather than silently matching nothing via a
 * broken `===` comparison against an array.
 * @param {object} tactic
 * @param {{selection:string[]}} view
 * @returns {object|null}
 */
function singleSelected(tactic, view) {
  return view.selection.length === 1 ? findObject(tactic, view.selection[0]) : null;
}

/**
 * The selected text object, IF the text tool is active and the current selection resolves to
 * a `kind:'text'` object — i.e. exactly the "editing existing note" state renderTextToolPanel
 * computes for display. Re-derived fresh from live store state in event handlers (same style
 * as applyRoleColor's isTransformContext) rather than threaded through as DOM dataset state.
 * @param {{getDoc:Function, getView:Function}} store
 * @returns {object|null}
 */
function editingTextNote(store) {
  const view = store.getView();
  if (view.tool !== 'text') return null;
  const tactic = activeTactic(store.getDoc());
  const obj = singleSelected(tactic, view);
  return obj?.kind === 'text' ? obj : null;
}

function rosterEntriesForTab(roster, tab) {
  return roster[tab] ?? [];
}

function findRosterEntry(roster, tab, code) {
  return rosterEntriesForTab(roster, tab).find((e) => e.code === code) ?? null;
}

/**
 * The tab actually used for rendering (heading/entries/sort applicability) — defensively falls
 * back to DEFAULT_PALETTE_TAB for a stale `rosterTab: 'extra'` (e.g. an old persisted doc or
 * share-link from before the Extra tab was removed) without mutating store state; the tab
 * button row itself never offers 'extra' as a choice.
 * @param {string} rosterTab
 */
function effectivePaletteTab(rosterTab) {
  return PALETTE_TABS.includes(rosterTab) ? rosterTab : DEFAULT_PALETTE_TAB;
}

/** Live count of `kind:'unit'` objects on the active tactic (Unit options heading, item 1). */
function placedUnitCount(doc) {
  const tactic = activeTactic(doc);
  return tactic?.objects.filter((o) => o.kind === 'unit').length ?? 0;
}

function renderPlacePanel(doc, view, roster) {
  const activeLayer = doc.layers.find((l) => l.id === view.activeLayerId);
  const tab = effectivePaletteTab(view.rosterTab);
  const filtered = filterRoster(rosterEntriesForTab(roster, tab), view.query);
  // Type sort only applies to the Units tab (heroes/artillery have no gameClass — mission item
  // 6) — fall back to rarity mode's flat order for every other tab regardless of view.sortMode.
  const effectiveSortMode = tab === 'units' ? (view.sortMode ?? 'rarity') : 'rarity';
  const entries = sortRosterEntries(filtered, effectiveSortMode);
  const armedCode = view.armedUnit?.code ?? null;

  const tabs = PALETTE_TABS.map(
    (t) => `
      <button type="button" class="roster-tab${t === tab ? ' is-active' : ''}" data-tab="${t}">
        ${escapeHtml(t[0].toUpperCase() + t.slice(1))}
      </button>`
  ).join('');

  // Sort control only shown on the Units tab — heroes/artillery always sort by rarity, and a
  // 2-state toggle with only one reachable state would be confusing chrome, not a real choice.
  const sortControl = tab === 'units' ? renderSortControl(view.sortMode ?? 'rarity') : '';

  return `
    <div class="inspector-content">
      <div class="inspector-section-heading">
        <span class="inspector-section-title">Unit options</span>
        <span class="inspector-section-count">(${placedUnitCount(doc)} on map)</span>
      </div>
      <div class="place-hint-chip">New units → ${escapeHtml(activeLayer?.name ?? '—')}</div>
      <div class="roster-tabs">${tabs}</div>
      <input type="text" class="input roster-search" data-field="roster-search" placeholder="Search name or code…" value="${escapeHtml(view.query)}" />
      ${renderRarityLegend(roster.rarity)}
      ${sortControl}
      ${renderRosterGrid(tab, entries, armedCode, roster.rarity)}
      ${view.armedUnit ? renderArmedCard(tab, view.armedUnit.entry, roster.rarity) : ''}
      ${renderRoleSwatches(roster.roles, view.roleColor, 'place', { showCurrentName: true })}
      ${renderSliderWithValue({ label: 'Marker size', dataKey: 'markerSize', min: MIN_MARKER_SIZE, max: MAX_MARKER_SIZE, value: view.markerSize ?? DEFAULT_MARKER_SIZE, unit: 'px' })}
      ${renderNextLabelBlock(view.nextLabel ?? DEFAULT_NEXT_LABEL, { minSize: MIN_LABEL_SIZE, maxSize: MAX_LABEL_SIZE })}
    </div>
  `;
}

// ---- Select / Move tool -------------------------------------------------------

function renderSelectPanel(doc, view, roster) {
  const tactic = activeTactic(doc);

  if (view.selection.length > 1) {
    return renderMultiSelectPanel(view.selection.length);
  }

  const obj = singleSelected(tactic, view);

  if (!obj) {
    return `
      <div class="inspector-content">
        <div class="inspector-empty">
          Click an object on the map to select it. Drag to move it once selected.
        </div>
      </div>
    `;
  }

  const isUnit = obj.kind === 'unit';
  const sizeRow = isUnit
    ? `
      <div class="inspector-section">
        <div class="section-label">Size</div>
        <input type="range" class="slider" data-slider="size" min="${MIN_MARKER_SIZE}" max="${MAX_MARKER_SIZE}" value="${obj.size}" />
        <div class="slider-value chip-mono">${obj.size}px</div>
      </div>
    `
    : '';

  // UNIT label editor (H3/OB1): a selected marker gets its own "Label" field, dispatching
  // doc/setObjectProps {props:{label}} — the counterpart to the Place panel's "next label" UI.
  const unitLabelRow = isUnit ? renderUnitLabelField(obj.label) : '';

  // ROUTE / SKETCH stroke+fill editors (OB2) + label (OB3): mirror the creation panels so editing
  // a placed shape feels identical to drawing one. Bounds are threaded in so inspector-helpers
  // keeps no reverse dependency on this module's local consts.
  const shapeEditors = obj.kind === 'route' || obj.kind === 'sketch'
    ? renderShapeEditors(obj, {
        thickness: { min: MIN_THICKNESS, max: MAX_THICKNESS, step: THICKNESS_STEP },
        border: { min: MIN_BORDER, max: MAX_BORDER, step: BORDER_STEP },
      })
    : '';

  // Zones get an optional label (contract §5, buildPlaybook's zoneEntry exports it when
  // present) — edits go through doc/setObjectProps, same seam as text-note editing.
  const zoneLabelRow = obj.kind === 'zone'
    ? `
      <div class="inspector-section">
        <div class="section-label">Label (optional)</div>
        <input type="text" class="input" data-zone-label-input data-field="zone-label" placeholder="e.g. Hold line" value="${escapeHtml(obj.label ?? '')}" />
      </div>
    `
    : '';

  return `
    <div class="inspector-content">
      <div class="object-card">
        <div class="object-card-top">
          <span class="object-card-kind">${escapeHtml(objectKindLabel(obj))}</span>
          <button type="button" class="btn-icon" data-action="delete-object" title="Delete" aria-label="Delete object">
            <i class="ph-bold ph-trash" aria-hidden="true"></i>
          </button>
        </div>
      </div>
      ${sizeRow}
      ${unitLabelRow}
      ${shapeEditors}
      ${zoneLabelRow}
      ${renderRoleSwatches(roster.roles, obj.role, 'select')}
    </div>
  `;
}

// ---- Line-like tools (arrow/draw/line) ----------------------------------------

function renderLineToolPanel(toolId, view, roster) {
  const opts = view.toolOptions;
  const headRow = toolId === 'arrow'
    ? `
      <div class="inspector-section">
        <div class="section-label">Arrowhead</div>
        <div class="segmented" data-segmented="head">
          ${['solid', 'open', 'none']
            .map(
              (h) => `<button type="button" class="segmented-btn${opts.head === h ? ' is-active' : ''}" data-value="${h}">${h[0].toUpperCase()}${h.slice(1)}</button>`
            )
            .join('')}
        </div>
      </div>
    `
    : '';

  return `
    <div class="inspector-content">
      <div class="inspector-section">
        <div class="section-label">Thickness</div>
        <input type="range" class="slider" data-slider="thickness" min="${MIN_THICKNESS}" max="${MAX_THICKNESS}" step="${THICKNESS_STEP}" value="${opts.thickness}" />
        <div class="slider-value chip-mono">${opts.thickness}px</div>
      </div>
      <label class="toggle-row">
        <input type="checkbox" data-toggle="dashed" ${opts.dashed ? 'checked' : ''} />
        <span>Dashed</span>
      </label>
      ${headRow}
      ${renderRoleSwatches(roster.roles, view.roleColor, 'create')}
      ${renderLabelField()}
    </div>
  `;
}

// ---- Shape tools (box/circle/zone) --------------------------------------------

function renderShapeToolPanel(view, roster) {
  const opts = view.toolOptions;
  return `
    <div class="inspector-content">
      <div class="inspector-section">
        <div class="section-label">Fill opacity</div>
        <input type="range" class="slider" data-slider="fillOpacity" min="0" max="100" value="${opts.fillOpacity}" />
        <div class="slider-value chip-mono">${opts.fillOpacity}%</div>
      </div>
      <div class="inspector-section">
        <div class="section-label">Border width</div>
        <input type="range" class="slider" data-slider="border" min="${MIN_BORDER}" max="${MAX_BORDER}" step="${BORDER_STEP}" value="${opts.border}" />
        <div class="slider-value chip-mono">${opts.border}px</div>
      </div>
      <label class="toggle-row">
        <input type="checkbox" data-toggle="dashed" ${opts.dashed ? 'checked' : ''} />
        <span>Dashed</span>
      </label>
      ${renderRoleSwatches(roster.roles, view.roleColor, 'create')}
      ${renderLabelField()}
    </div>
  `;
}

// ---- Text tool -----------------------------------------------------------------

function renderTextToolPanel(doc, view, roster) {
  const tactic = activeTactic(doc);
  const selected = singleSelected(tactic, view);
  const editingExisting = selected?.kind === 'text' ? selected : null;
  const opts = view.toolOptions;
  const sizeValue = editingExisting ? editingExisting.size : opts.textSize;
  const chipValue = editingExisting ? editingExisting.chip : (opts.textChip ?? true);

  // Two distinct Text fields depending on mode (Jasper v2 fix — the placement seam used to be
  // hardcoded 'Label'):
  //  - EDITING an existing selected note: a textarea bound to data-text-input, which edits that
  //    object's `text` via doc/setObjectProps (the pre-existing seam).
  //  - PLACEMENT (nothing / non-text selected): a prefill INPUT bound to data-text-prefill,
  //    which sets view.toolOptions.textPrefill (view/setToolOption). drawtools' Text tool drops
  //    that string on click; an empty prefill places an empty note and selects it, so this panel
  //    immediately swaps to the editing textarea for an inline edit.
  const textField = editingExisting
    ? `
      <div class="inspector-section">
        <div class="section-label">Text</div>
        <textarea class="input textarea" data-text-input data-field="text-body" rows="3" placeholder="Label…">${escapeHtml(editingExisting.text)}</textarea>
      </div>
    `
    : `
      <div class="inspector-section">
        <div class="section-label">Text — next placement</div>
        <input type="text" class="input" data-text-prefill data-field="text-prefill" placeholder="Type a label, then click the map…" value="${escapeHtml(opts.textPrefill ?? '')}" />
      </div>
    `;

  return `
    <div class="inspector-content">
      ${editingExisting
        ? '<div class="inspector-empty inspector-note-hint">Editing selected text note.</div>'
        : '<div class="inspector-empty inspector-note-hint">Click the map to drop this label. Leave it blank to place an empty note and type it inline.</div>'}
      ${textField}
      <div class="inspector-section">
        <div class="section-label">Size</div>
        <input type="range" class="slider" data-slider="textSize" min="${MIN_TEXT_SIZE}" max="${MAX_TEXT_SIZE}" value="${sizeValue}" />
        <div class="slider-value chip-mono">${sizeValue}px</div>
      </div>
      <label class="toggle-row">
        <input type="checkbox" data-toggle="textChip" ${chipValue ? 'checked' : ''} />
        <span>Background chip</span>
      </label>
      ${renderRoleSwatches(roster.roles, view.roleColor, 'create')}
    </div>
  `;
}

// ---- Persistent bottom: selection mini-card + frame notes ----------------------

const TRANSFORM_TOOLS = new Set(['select', 'move']);

/**
 * Role-color input (swatch click or custom `<input type=color>`) means two different things
 * depending on tool: in Select/Move (and Text, when a text object is selected — TextNote
 * carries a `role` field per contract §3) it recolors the selected object; in every creation
 * tool it sets the "next object" role color used at placement/draw time.
 */
function applyRoleColor(store, ctx, hex) {
  const view = store.getView();
  const hasSelection = view.selection.length > 0;
  const isTransformContext = TRANSFORM_TOOLS.has(view.tool) || (view.tool === 'text' && hasSelection);
  if (isTransformContext) {
    // Recolor every selected object in one pass (multi-select rework) — each is a separate
    // doc/recolorObject dispatch; a batched action isn't needed here (unlike moves/resizes)
    // since app.mjs's exec() already snapshots once per dispatch and a multi-object recolor
    // reverting as N undo-steps is a much smaller UX cost than a multi-object DRAG doing so.
    // Layer-lock enforcement (bug-hunt fix): skip locked-layer objects — same
    // exclude-not-refuse precedent as the delete button, so locking one object doesn't block
    // recoloring the rest of a multi-select.
    const doc = store.getDoc();
    view.selection
      .filter((id) => !isObjectLocked(doc, view, id))
      .forEach((id) => ctx.exec({ type: 'doc/recolorObject', id, role: hex }));
    return;
  }
  ctx.exec({ type: 'view/setRoleColor', color: hex });
}

function renderMiniSelectionCard(doc, view) {
  if (TRANSFORM_TOOLS.has(view.tool)) return '';
  const tactic = activeTactic(doc);
  const obj = singleSelected(tactic, view);
  if (!obj) return '';
  // Markers store per-keyframe positions[kf], not a flat x/y (contract §3) — resolve via
  // playbook.positionAt the same way canvas.mjs / playbook.visibleObjects would, rather than
  // reading a field that only exists on the *resolved* view of an object.
  const coords = obj.kind === 'unit' ? fmtCoordPair(positionAt(obj, view.currentKeyframe)) : '';
  return `
    <div class="mini-selection-card">
      <span class="chip chip-mono chip-neutral">${escapeHtml(objectKindLabel(obj))}</span>
      ${coords ? `<span class="chip-mono mini-selection-coords">${coords}</span>` : ''}
    </div>
  `;
}

// ---- Top-level dispatch ---------------------------------------------------------

function renderBody(doc, view, roster) {
  const tool = view.tool;
  if (tool === 'place') return renderPlacePanel(doc, view, roster);
  if (tool === 'select' || tool === 'move') return renderSelectPanel(doc, view, roster);
  if (isLineLikeTool(tool)) return renderLineToolPanel(tool, view, roster);
  if (isShapeTool(tool)) return renderShapeToolPanel(view, roster);
  if (tool === 'text') return renderTextToolPanel(doc, view, roster);
  if (tool === 'erase') return renderErasePanel(doc, view);
  if (tool === 'pan') return renderPanPanel();
  if (tool === 'locator') {
    return `<div class="inspector-content"><div class="inspector-empty">Hold the left button and move to point — pulses and a fading trail follow the cursor (uses the role color). Nothing is drawn on the map. Middle-mouse drags the map in any tool.</div></div>`;
  }
  return `<div class="inspector-content"><div class="inspector-empty">Select a tool from the rail.</div></div>`;
}

function render(doc, view, roster) {
  return `
    ${header(view.tool)}
    ${renderBody(doc, view, roster)}
    ${renderMiniSelectionCard(doc, view)}
    ${renderFrameNotes(doc, view)}
  `;
}

// ---- Event wiring -----------------------------------------------------------------

function wirePlaceEvents(el, ctx, roster) {
  const view = ctx.store.getView();

  el.querySelectorAll('.roster-tab').forEach((btn) => {
    btn.addEventListener('click', () => ctx.exec({ type: 'view/setTab', tab: btn.dataset.tab }));
  });

  el.querySelectorAll('.roster-tile').forEach((tile) => {
    tile.addEventListener('click', () => {
      const tab = tile.dataset.refTab;
      const code = tile.dataset.refCode;
      const entry = findRosterEntry(roster, tab, code);
      if (!entry) return;
      if (view.armedUnit?.code === code) {
        ctx.exec({ type: 'view/disarm' });
        return;
      }
      ctx.exec({ type: 'view/armUnit', unit: { code, tab, entry } });
    });
  });
}

/**
 * A debouncer for doc/setNote specifically (bug 1 fix): unlike a plain last-call-wins
 * debounce(), this one is keyframe-aware and exposes an explicit flush() so mount()'s
 * store.subscribe callback can force a pending write out the instant the keyframe changes —
 * same shared reasoning as createObjectPropsDebouncer's flush-on-id-change below, just keyed
 * on `kf` instead of an object id. Without this, typing on KF1 (arming a 300ms timer for
 * kf=1), switching to KF2 via any playbookbar action, and typing again calls this with kf=2,
 * which used to silently `clearTimeout` the still-pending kf=1 write before it ever reached
 * doc/setNote — never entering history, producing zero exec log entry for it.
 * @param {Function} exec
 * @param {number} ms
 * @returns {{write:(kf:number, text:string)=>void, flush:()=>void}}
 */
function createNoteDebouncer(exec, ms) {
  let timer = null;
  let pendingKf = null;
  let pendingText = null;

  function flush() {
    if (timer) clearTimeout(timer);
    timer = null;
    // Clear the pending buffer BEFORE calling exec(), not after: exec() dispatches
    // synchronously through the store, which re-enters this module's store.subscribe
    // listener (still inside the SAME keyframe-change tick) — if that listener's own
    // flush-on-keyframe-change check reads a still-non-null pendingKf here, it calls flush()
    // again and recurses without ever terminating (verified experimentally: unbounded
    // exec()->dispatch->listener->flush()->exec() recursion). Clearing first means the
    // re-entrant call sees an already-empty buffer and safely no-ops.
    if (pendingKf === null) return;
    const kf = pendingKf;
    const text = pendingText;
    pendingKf = null;
    pendingText = null;
    exec({ type: 'doc/setNote', kf, text });
  }

  function write(kf, text) {
    if (pendingKf !== null && pendingKf !== kf) flush();
    pendingKf = kf;
    pendingText = text;
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, ms);
  }

  return { write, flush };
}

/**
 * A debouncer for doc/setObjectProps specifically: merges props across rapid-fire calls for
 * the SAME object id instead of a plain debounce()'s last-call-wins. Needed because the text
 * panel exposes three independent controls (text/size/chip) that all funnel through this one
 * dispatcher — dragging the size slider and toggling the chip checkbox within the debounce
 * window would otherwise silently drop whichever call didn't fire last, even though both are
 * genuine, distinct edits. If the selected object changes mid-debounce (different id), the
 * pending buffer flushes immediately first so it isn't merged into or lost under the new id.
 * @param {Function} exec
 * @param {number} ms
 * @returns {(id:string, props:object) => void}
 */
function createObjectPropsDebouncer(exec, ms) {
  let timer = null;
  let pendingId = null;
  let pendingProps = null;

  function flush() {
    if (timer) clearTimeout(timer);
    timer = null;
    if (pendingId) exec({ type: 'doc/setObjectProps', id: pendingId, props: pendingProps });
    pendingId = null;
    pendingProps = null;
  }

  return (id, props) => {
    if (pendingId && pendingId !== id) flush();
    pendingId = id;
    pendingProps = { ...pendingProps, ...props };
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, ms);
  };
}

/**
 * Mounts the contextual inspector panel.
 * @param {HTMLElement} el
 * @param {{store:object, history:object, roster:object, maps:object, exec:Function}} ctx
 */
export function mount(el, ctx) {
  const { store, roster } = ctx;

  const noteDebouncer = createNoteDebouncer(ctx.exec, NOTE_DEBOUNCE_MS);
  const debouncedSetNote = noteDebouncer.write;

  const debouncedSetObjectProps = createObjectPropsDebouncer(ctx.exec, NOTE_DEBOUNCE_MS);

  /**
   * Dispatches doc/setObjectProps for the single selected object, guarded by the same lock +
   * active-layer rule every other Inspector edit uses (isObjectLocked). No-ops on a 0- or
   * 2+-object selection or a locked/non-active target. Used by the selected route/sketch
   * editors (thickness/dashed/fillOpacity/border/head/label — OB2/OB3). `immediate` skips the
   * debounce for discrete edits (arrowhead click, dashed toggle) that never rapid-fire; the
   * sliders and the label field debounce like the text-note editors.
   * @param {object} props whitelisted props for the object's kind (core/store.mjs enforces)
   * @param {{immediate?:boolean}} [opts]
   */
  function setSelectedObjectProps(props, { immediate = false } = {}) {
    const view = store.getView();
    if (view.selection.length !== 1) return;
    const id = view.selection[0];
    if (isObjectLocked(store.getDoc(), view, id)) return;
    if (immediate) {
      ctx.exec({ type: 'doc/setObjectProps', id, props });
    } else {
      debouncedSetObjectProps(id, props);
    }
  }

  installGlobalSearchFocus(el, ctx);

  function draw() {
    el.innerHTML = render(store.getDoc(), store.getView(), roster);
    wirePlaceEvents(el, ctx, roster);
  }

  el.addEventListener('click', (event) => {
    const target = event.target;

    const disarmBtn = target.closest('[data-action="disarm"]');
    if (disarmBtn) {
      ctx.exec({ type: 'view/disarm' });
      return;
    }

    const deleteBtn = target.closest('[data-action="delete-object"]');
    if (deleteBtn) {
      const doc = store.getDoc();
      const view = store.getView();
      // Layer-lock + active-layer enforcement: exclude locked/hidden/non-active-layer objects
      // from the delete rather than refusing the whole batch — matches canvas.mjs's
      // deleteSelection precedent exactly (locking one object in a multi-select must not block
      // deleting the rest).
      const deletable = view.selection.filter((id) => !isObjectLocked(doc, view, id));
      if (deletable.length === 1) {
        ctx.exec({ type: 'doc/deleteObject', id: deletable[0] });
      } else if (deletable.length > 1) {
        // Batched (one history snapshot for the whole group, not one per object) — same
        // reasoning as doc/moveObjects/doc/resizeMarkers.
        ctx.exec({ type: 'doc/deleteObjects', ids: deletable });
      }
      return;
    }

    // Layer-guard fix: the bulk clears used to dispatch the layer-blind doc/clearPlaced /
    // doc/clearByKind reducers and wiped locked/hidden-layer objects. They now resolve the
    // clearable id list (same source as the panel's counts) and reuse the already-guarded
    // batched delete path — exclude-not-refuse, matching the delete-object button above.
    // Undo stays free: app.mjs's exec() snapshots history for any doc/*-prefixed action.
    const clearBtn = target.closest('[data-action="clear-placed"]');
    if (clearBtn) {
      const ids = clearableObjects(store.getDoc(), store.getView().activeLayerId).map((o) => o.id);
      if (ids.length === 1) ctx.exec({ type: 'doc/deleteObject', id: ids[0] });
      else if (ids.length > 1) ctx.exec({ type: 'doc/deleteObjects', ids });
      return;
    }

    const clearKindBtn = target.closest('[data-action="clear-kind"]');
    if (clearKindBtn) {
      const kind = clearKindBtn.dataset.kind;
      const ids = clearableObjects(store.getDoc(), store.getView().activeLayerId)
        .filter((o) => o.kind === kind)
        .map((o) => o.id);
      if (ids.length === 1) ctx.exec({ type: 'doc/deleteObject', id: ids[0] });
      else if (ids.length > 1) ctx.exec({ type: 'doc/deleteObjects', ids });
      return;
    }

    const roleSwatch = target.closest('.role-swatch');
    if (roleSwatch) {
      applyRoleColor(store, ctx, roleSwatch.dataset.roleHex);
      return;
    }

    // Unit options panel's sort-mode control (rarity default | type). Checked BEFORE the
    // generic .segmented-btn handler below since it shares that visual class but carries a
    // different data attribute (data-sort-mode, not data-value) and targets a dedicated action.
    const sortBtn = target.closest('[data-sort-mode]');
    if (sortBtn) {
      ctx.exec({ type: 'view/setSortMode', mode: sortBtn.dataset.sortMode });
      return;
    }

    // LABEL — NEXT PLACEMENT compass position grid (mission item 11).
    const positionBtn = target.closest('[data-position]');
    if (positionBtn) {
      ctx.exec({ type: 'view/setNextLabel', key: 'position', value: positionBtn.dataset.position });
      return;
    }

    // LABEL — NEXT PLACEMENT background ON/OFF toggle-button.
    const labelBgToggle = target.closest('[data-action="toggle-label-bg"]');
    if (labelBgToggle) {
      const current = store.getView().nextLabel?.background ?? DEFAULT_NEXT_LABEL.background;
      ctx.exec({ type: 'view/setNextLabel', key: 'background', value: !current });
      return;
    }

    // Selected ROUTE's arrowhead control (OB2) — dispatches doc/setObjectProps on the object,
    // not view/setToolOption. Checked before the generic .segmented-btn handler since it shares
    // that visual class but carries data-obj-head (not data-value) and targets the selection.
    const objHeadBtn = target.closest('[data-obj-head]');
    if (objHeadBtn) {
      setSelectedObjectProps({ head: objHeadBtn.dataset.objHead }, { immediate: true });
      return;
    }

    const segBtn = target.closest('.segmented-btn');
    if (segBtn) {
      const group = segBtn.closest('[data-segmented]');
      ctx.exec({ type: 'view/setToolOption', key: group.dataset.segmented, value: segBtn.dataset.value });
    }
  });

  /**
   * Dispatches a numeric view-state change coming from EITHER half of a slider+typed-value row
   * (renderSliderWithValue) — the range input and its sibling typed <input type=text> share one
   * data key and must produce the exact same action, so both call this instead of duplicating
   * the key-to-action mapping. Not used for the pre-existing size/textSize/toolOptions sliders,
   * which have their own selection/lock-aware or debounced dispatch paths above/below this.
   * @param {string} key 'markerSize' | 'labelSize'
   * @param {number} value
   */
  function dispatchNamedSliderValue(key, value) {
    if (key === 'markerSize') {
      ctx.exec({ type: 'view/setMarkerSize', size: value });
      return true;
    }
    if (key === 'labelSize') {
      ctx.exec({ type: 'view/setNextLabel', key: 'size', value });
      return true;
    }
    return false;
  }

  el.addEventListener('input', (event) => {
    const target = event.target;

    if (target.matches('.roster-search')) {
      ctx.exec({ type: 'view/setQuery', query: target.value });
      return;
    }

    // Selected route/sketch numeric editors (OB2): thickness / fillOpacity / border. Debounced
    // (dragging fires per-frame), lock/active-layer guarded via setSelectedObjectProps.
    if (target.matches('[data-obj-slider]')) {
      const propKey = target.dataset.objSlider;
      setSelectedObjectProps({ [propKey]: Number(target.value) });
      return;
    }

    // Selected route/sketch Dashed toggle (OB2). Immediate — a single discrete click.
    if (target.matches('[data-obj-toggle]')) {
      const propKey = target.dataset.objToggle;
      setSelectedObjectProps({ [propKey]: target.checked }, { immediate: true });
      return;
    }

    // Selected unit/route/sketch Label editor (OB1/OB3). Debounced like the text-note/zone-label
    // fields; the store's per-kind whitelist accepts `label` for unit/route/sketch/zone.
    if (target.matches('[data-obj-label-input]')) {
      setSelectedObjectProps({ label: target.value });
      return;
    }

    if (target.matches('[data-slider]')) {
      const key = target.dataset.slider;
      const value = Number(target.value);
      const view = store.getView();
      if (dispatchNamedSliderValue(key, value)) return;
      if (key === 'size') {
        // Layer-lock + active-layer enforcement: refuse to resize an object that is locked,
        // hidden, or on a non-active layer.
        if (view.selection.length === 1 && !isObjectLocked(store.getDoc(), view, view.selection[0])) {
          ctx.exec({ type: 'doc/resizeMarker', id: view.selection[0], size: value });
        }
        return;
      }
      const editing = key === 'textSize' ? editingTextNote(store) : null;
      if (editing) {
        if (!isObjectLocked(store.getDoc(), view, editing.id)) debouncedSetObjectProps(editing.id, { size: value });
      } else {
        ctx.exec({ type: 'view/setToolOption', key, value });
      }
      return;
    }

    // The typed-number companion input beside a slider (G5 — CHANGES-sidebar-v2.md §1: "every
    // numeric control = slider + typed value with unit"). Only wired for the two NEW
    // markerSize/labelSize rows this stage adds — the pre-existing size/textSize/toolOptions
    // sliders keep their own read-only chip display, unchanged, per this mission's scope.
    if (target.matches('[data-slider-typed]')) {
      const key = target.dataset.sliderTyped;
      const raw = target.value.trim();
      // `Number('')` is 0, not NaN — an explicit empty/whitespace-only check is required
      // (mid-edit, e.g. the user selected-all-and-deleted the field); Number.isNaN() alone
      // would silently dispatch 0 in that state instead of waiting for a real value.
      if (raw === '' || Number.isNaN(Number(raw))) return;
      const parsed = Number(raw);
      // dataset.min/max, not the target's own .min/.max IDL properties — those only reflect
      // for <input type="number"|"range">, and this typed companion is type="text" (so free
      // typing isn't fought by the browser's own number-input stepping/validation UX).
      const min = Number(target.dataset.min) || 0;
      const max = Number(target.dataset.max) || parsed;
      const clamped = Math.min(Math.max(parsed, min), max);
      dispatchNamedSliderValue(key, clamped);
      return;
    }

    if (target.matches('[data-next-label-text]')) {
      ctx.exec({ type: 'view/setNextLabel', key: 'text', value: target.value });
      return;
    }

    if (target.matches('[data-toggle]')) {
      const key = target.dataset.toggle;
      const editing = key === 'textChip' ? editingTextNote(store) : null;
      if (editing) {
        if (!isObjectLocked(store.getDoc(), store.getView(), editing.id)) debouncedSetObjectProps(editing.id, { chip: target.checked });
      } else {
        ctx.exec({ type: 'view/setToolOption', key, value: target.checked });
      }
      return;
    }

    if (target.matches('.role-custom-input')) {
      applyRoleColor(store, ctx, target.value);
      return;
    }

    if (target.matches('[data-notes-input]')) {
      const view = store.getView();
      debouncedSetNote(view.currentKeyframe, target.value);
      return;
    }

    if (target.matches('[data-text-input]')) {
      const editing = editingTextNote(store);
      if (editing && !isObjectLocked(store.getDoc(), store.getView(), editing.id)) {
        debouncedSetObjectProps(editing.id, { text: target.value });
      }
      return;
    }

    // Text tool's "next placement" prefill (Jasper v2 fix): a view-only preference (never a doc
    // field, never persisted) that drawtools' Text tool reads at click time. Distinct from
    // data-text-input above, which edits the ALREADY-PLACED selected note's `text`.
    if (target.matches('[data-text-prefill]')) {
      ctx.exec({ type: 'view/setToolOption', key: 'textPrefill', value: target.value });
      return;
    }

    if (target.matches('[data-zone-label-input]')) {
      const view = store.getView();
      const doc = store.getDoc();
      if (view.selection.length === 1 && !isObjectLocked(doc, view, view.selection[0])) {
        debouncedSetObjectProps(view.selection[0], { label: target.value });
      }
    }
  });

  draw();
  let lastSeenKeyframe = store.getView().currentKeyframe;
  store.subscribe((_doc, _view, action) => {
    // Bug 1 fix: flush any pending frame-note write the INSTANT the keyframe changes, before
    // the redraw below can swap the textarea's underlying kf out from under it. Must run
    // before draw() (not after) — the whole point is to commit the KF-N-1 text before
    // anything about KF-N's state is read/rendered. See createNoteDebouncer's header for the
    // exact race this closes (typing on KF1, switching to KF2, typing again used to silently
    // clear KF1's still-pending timeout instead of committing it).
    const nextKeyframe = store.getView().currentKeyframe;
    if (nextKeyframe !== lastSeenKeyframe) {
      noteDebouncer.flush();
      lastSeenKeyframe = nextKeyframe;
    }

    // Full rebuild (contract §5: "rebuild innerHTML from state"), but if a text field inside
    // this panel is focused, redrawing would steal focus and caret position mid-typing
    // (view/setQuery and the debounced doc/setNote both dispatch on every keystroke). Every
    // focusable text field carries a stable `data-field` id so we can find its replacement
    // after the rebuild and restore focus + caret there. Guarded for environments with no
    // `document` global (e.g. node:test doubles that invoke this listener directly) — a real
    // browser always has one, so this is a no-op there.
    const active = typeof document !== 'undefined' ? document.activeElement : null;
    const fieldId = active && el.contains(active) ? active.dataset?.field : null;
    const selection = fieldId ? { start: active.selectionStart, end: active.selectionEnd } : null;

    draw();

    if (fieldId) {
      const restored = el.querySelector(`[data-field="${fieldId}"]`);
      if (restored) {
        restored.focus();
        if (typeof selection.start === 'number' && restored.setSelectionRange) {
          restored.setSelectionRange(selection.start, selection.end);
        }
      }
    } else if (action && action.type === 'view/select' && store.getView().tool === 'text') {
      // Inline-edit affordance (Jasper v2 text flow): an empty-prefill placement selects the new
      // empty note (drawtools selectLatest -> view/select) and this panel swaps to the editing
      // textarea — land the caret in it so the user types immediately, no extra click. Only for
      // an EMPTY note: selecting an existing labeled note must not yank keyboard focus.
      const textarea = typeof document !== 'undefined' ? el.querySelector('[data-text-input]') : null;
      if (textarea && textarea.value === '') textarea.focus();
    }
  });
}
