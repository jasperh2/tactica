// ui/app.mjs — TACTICA bootstrap + wiring [integration]
// Fetches data, builds the initial doc/view, wires the store<->history undo/redo seam,
// mounts every panel, installs keyboard shortcuts, debounced localStorage persistence,
// share-link (#pb=) encode/decode, and the export-modal open callback. Replaces the
// foundation-phase stub. Contract §3 (state model) / §5 (ui conventions).
import { createStore } from '../core/store.mjs';
import { createHistory } from '../core/commands.mjs';
import { newTactic } from '../core/playbook.mjs';
import { serialize, deserialize } from '../core/persist.mjs';
import { docKey, LEGACY_DOC_KEY, loadDocForMap, switchViewActions } from '../core/workspace.mjs';

import { mount as mountTopbar } from './topbar.mjs';
import { mount as mountLayers } from './layers.mjs';
import { mount as mountCanvas } from './canvas.mjs';
import { mount as mountToolrail } from './toolrail.mjs';
import { mount as mountInspector } from './inspector.mjs';
import { mount as mountPlaybookbar } from './playbookbar.mjs';
import { mount as mountExportModal } from './exportmodal.mjs';
import { mountLocator } from './locator.mjs';
import { createLayout } from './panelresize.mjs';

const PERSIST_DEBOUNCE_MS = 500;
const DEFAULT_MAP_ID = 'western-city';
const DEFAULT_TACTIC_NAME = 'A-Point Push';
const SHARE_HASH_PREFIX = '#pb=';

// Default layers — fixed ids the exporter + example playbook reference (contract §3).
const DEFAULT_LAYERS = [
  { id: 'units', name: 'Deployments', color: '#e5484d', visible: true, locked: false },
  { id: 'arty', name: 'Artillery Line', color: '#33b7d4', visible: true, locked: false },
  { id: 'routes', name: 'Push Routes', color: '#f5c518', visible: true, locked: false },
  { id: 'zones', name: 'Control Zones', color: '#38b26b', visible: true, locked: false },
  { id: 'notes', name: 'Labels & Notes', color: '#9aa3b2', visible: true, locked: false },
];

// Default toolOptions (contract §3 ViewState.toolOptions).
const DEFAULT_TOOL_OPTIONS = {
  // thickness/border are true screen px since the core/stroke.mjs recalibration. Default thickness
  // = 3 and slider max = 5 (inspector.mjs MAX_THICKNESS) per Jasper's arrow calibration (shared-bag
  // decision): 3px is a confident default stroke on the fit-to-column map, with room to 5 for bold
  // routes and sub-1px widths below for fine linework. HEAD_REFERENCE_THICKNESS_PX (core/stroke.mjs)
  // is pinned to this same 3 so a default arrow gets the calibrated baseline head.
  thickness: 3,
  dashed: false,
  head: 'solid',
  fillOpacity: 14,
  border: 1,
  textSize: 14,
  textChip: true,
  snap: false,
};

// Single-key tool shortcuts (contract §5, toolrail order). Uppercased key -> tool id.
const KEY_TO_TOOL = {
  Q: 'locator',
  V: 'select',
  G: 'move',
  H: 'pan',
  M: 'place',
  A: 'arrow',
  P: 'draw',
  L: 'line',
  R: 'box',
  C: 'circle',
  Z: 'zone',
  T: 'text',
  E: 'erase',
};

boot();

async function boot() {
  const [roster, maps, themeApi] = await Promise.all([
    fetchJson('./data/roster.json'),
    fetchJson('./data/maps.json'),
    loadThemeApi(),
  ]);
  themeApi.initTheme();

  // One-time cleanup of the pre-per-map single-doc key (Jasper 2026-07-06: wipe, do NOT migrate
  // it into a map slot). Harmless if already absent; guarded so a blocked localStorage can't throw.
  cleanupLegacyDoc();

  // Shared deps for the per-map document router (core/workspace.mjs). Kept pure there; the real
  // localStorage read + persist.deserialize + freshDoc(mapId) are injected from here.
  const storageDeps = { read: safeRead, deserialize, freshDoc };

  const shared = readSharedDocFromHash();
  const isReadonly = shared !== null;
  // Boot always opens the default map (Jasper 2026-07-06: no last-used-map memory) — loading that
  // map's saved slot if present, else a fresh doc. A #pb= share link still overrides into readonly.
  const doc = shared ?? loadDocForMap(DEFAULT_MAP_ID, storageDeps);
  const view = freshView();

  const store = createStore(doc, view);
  const history = createHistory();

  // History-aware dispatch: snapshot the pre-change doc before any undoable (doc/*) action.
  // Undo/redo themselves must NOT push (they replay snapshots) — they call store.dispatch
  // directly with a doc/replace action so subscribers re-render and the undo/redo buttons
  // (which read history.canUndo()/canRedo()) refresh in the same tick.
  function exec(action) {
    if (typeof action?.type === 'string' && action.type.startsWith('doc/')) {
      history.push(store.getDoc());
    }
    store.dispatch(action);
    pruneSelectionAfterDelete(action);
  }

  // Bug-hunt fix (dangling selection): doc/deleteObject and doc/deleteObjects are fully
  // independent of view.selection in the reducers — nothing there clears a selected id that
  // just got removed from the doc. Every read site degrades safely today (findObject returns
  // undefined, canvas-objects.mjs's .includes() check just renders nothing selected), but a
  // stale id lingering in view.selection is still wrong state worth closing here rather than
  // leaving it for a future feature to trip over.
  function pruneSelectionAfterDelete(action) {
    if (action?.type !== 'doc/deleteObject' && action?.type !== 'doc/deleteObjects') return;
    const deletedIds = action.type === 'doc/deleteObject' ? [action.id] : action.ids;
    const selection = store.getView().selection;
    const pruned = selection.filter((id) => !deletedIds.includes(id));
    if (pruned.length !== selection.length) {
      store.dispatch({ type: 'view/select', ids: pruned });
    }
  }

  function undo() {
    if (!history.canUndo()) return;
    const previous = history.undo(store.getDoc());
    store.dispatch({ type: 'doc/replace', doc: previous });
  }

  function redo() {
    if (!history.canRedo()) return;
    const next = history.redo(store.getDoc());
    store.dispatch({ type: 'doc/replace', doc: next });
  }

  // Resizable/collapsible side panels (sidebar-v2 v3 item c/d). Created before the panels mount
  // so ctx.layout is present when layers.mjs renders its collapse chevron. Applies persisted
  // view-pref widths + collapsed flag onto #app-shell and mounts the two drag handles into
  // #middle. View-pref only — nothing here touches the doc/persist.mjs schema.
  const layout = createLayout({
    shell: document.getElementById('app-shell'),
    middle: document.getElementById('middle'),
  });

  // Debounced per-map persistence. Installed BEFORE the panels mount (and before switchMap is
  // defined) so switchMap can force-flush the outgoing map's doc at the moment of a switch. A
  // read-only (#pb=) session never persists — its handle is a no-op flush so switchMap stays safe.
  const persistence = isReadonly ? { flush() {} } : installPersistence(store);

  // Map switch (topbar picker). Swaps the WHOLE doc rather than mutating mapId in place:
  //   1. flush the outgoing map's doc to its slot synchronously (before we lose it)
  //   2. load the target map's saved doc, or a fresh one if never visited
  //   3. doc/replace into the store (the same seam boot + undo/redo use)
  //   4. reset history — undo must not cross a map boundary
  //   5. reset the view (selection/keyframe reference the old doc; camera + active layer
  //      re-anchor to the incoming doc) via core/workspace.switchViewActions
  // Not routed through exec(): a map switch is navigation, not an undoable edit. Read-only
  // sessions get a no-op (a share link is a snapshot of one map; there are no other slots).
  function switchMap(mapId) {
    if (isReadonly) return;
    if (mapId === store.getDoc().mapId) return;
    persistence.flush();
    const incoming = loadDocForMap(mapId, storageDeps);
    store.dispatch({ type: 'doc/replace', doc: incoming });
    history.reset();
    for (const action of switchViewActions(incoming)) store.dispatch(action);
  }

  // openExport is set once the export modal mounts (below); the playbookbar's Export button
  // calls ctx.openExport, so it has to be present on ctx before playbookbar mounts.
  const ctx = {
    store,
    history,
    roster,
    maps,
    exec,
    undo,
    redo,
    layout,
    switchMap,
    toggleTheme: themeApi.toggleTheme,
    openExport: () => {},
  };

  mountTopbar(document.getElementById('topbar'), ctx);
  mountLayers(document.getElementById('layers'), ctx);
  mountCanvas(document.getElementById('canvas'), ctx);
  // Cursor Locator overlay rides on the canvas viewport canvas.mjs just mounted; fully
  // self-contained (own SVG, own listeners, active only when view.tool === 'locator').
  mountLocator(document.querySelector('#canvas .canvas-viewport'), store);
  mountToolrail(document.getElementById('toolrail'), ctx);
  mountInspector(document.getElementById('inspector'), ctx);
  mountPlaybookbar(document.getElementById('playbookbar'), ctx);

  const exportModal = mountExportModal(document.getElementById('modal-root'), ctx);
  ctx.openExport = () => exportModal.open();

  // Persistence is already installed above (before mounts) for non-readonly sessions; readonly
  // just flags the body so the CSS can neutralize write affordances (incl. the map picker).
  if (isReadonly) {
    document.body.classList.add('readonly');
  }

  // Flush the active map's doc on tab hide/close so an edit made inside the 500ms debounce window
  // isn't lost on reload/navigation. Map SWITCHING already flushes the outgoing doc; this covers
  // the raw reload/close path. `pagehide` (over `beforeunload`) stays bfcache-friendly; readonly's
  // persistence handle is a no-op flush, so this is safe there too.
  window.addEventListener('pagehide', () => persistence.flush());

  installShortcuts(ctx, isReadonly);
  installExportTestSeam(ctx);
}

// ---------------------------------------------------------------------------
// Theme (sidebar-v2 S1) — stub-tolerant dynamic import of ui/theme.mjs
// ---------------------------------------------------------------------------

/**
 * ui/theme.mjs is owned by the sidebar-v2 S2 builder (contract: `export function initTheme()`
 * / `export function toggleTheme()`, wiring document.documentElement.dataset.theme +
 * localStorage). This file is the ONLY place that imports it, and only dynamically — a plain
 * `import { initTheme, toggleTheme } from './theme.mjs'` at module top-level would throw a
 * fetch/parse error for the whole app.mjs bundle if theme.mjs doesn't exist yet on this branch,
 * which would take the rest of boot() down with it. The dynamic import here is caught, so a
 * missing theme.mjs degrades to no-op theme controls (topbar's toggle button still renders,
 * per isDarkTheme() there defaulting to dark) rather than breaking the app.
 * @returns {Promise<{initTheme: Function, toggleTheme: Function}>}
 */
async function loadThemeApi() {
  try {
    const mod = await import('./theme.mjs');
    return {
      initTheme: typeof mod.initTheme === 'function' ? mod.initTheme : noop,
      toggleTheme: typeof mod.toggleTheme === 'function' ? mod.toggleTheme : noop,
    };
  } catch {
    return { initTheme: noop, toggleTheme: noop };
  }
}

function noop() {}

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

/**
 * A brand-new, empty playbook for `mapId`: the standard default layers + one starter tactic.
 * Each map's layers are INDEPENDENT (Jasper 2026-07-06) — a fresh map always gets this standard
 * set, never a carry-over of the layers from the map you're leaving.
 * @param {string} mapId
 */
function freshDoc(mapId) {
  const tactic = newTactic(DEFAULT_TACTIC_NAME, '');
  return {
    mapId,
    layers: DEFAULT_LAYERS.map((l) => ({ ...l })),
    tactics: [tactic],
    activeTacticId: tactic.id,
  };
}

function freshView() {
  return {
    // Default tool on open = PAN, not select (sidebar-v2 v3 item f): a fresh board has nothing
    // to select, and pan/zoom is the first thing anyone does to frame the map. Read-only share
    // links keep this same neutral default — the viewer wants to move around the map, not draw.
    // Cursor Locator is the default tool (Jasper 2026-07-06): harmless to open on (no doc
    // writes), and the laser-pointer flow is the primary "show someone the plan" mode. Pan
    // stays one key away (H) and middle-mouse drag pans in EVERY tool.
    tool: 'locator',
    roleColor: '#e5484d',
    activeLayerId: 'units',
    currentKeyframe: 1,
    playing: false,
    selection: [],
    armedUnit: null,
    query: '',
    rosterTab: 'units',
    zoom: 100,
    pan: { x: 0, y: 0 },
    toolOptions: { ...DEFAULT_TOOL_OPTIONS },
  };
}

// ---------------------------------------------------------------------------
// Persistence (doc only, debounced; never view)
// ---------------------------------------------------------------------------

/** localStorage.getItem that never throws (private mode / blocked storage -> null). */
function safeRead(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** One-time removal of the obsolete pre-per-map single-doc key. Best-effort, never throws. */
function cleanupLegacyDoc() {
  try {
    localStorage.removeItem(LEGACY_DOC_KEY);
  } catch {
    /* storage blocked — nothing to clean up anyway */
  }
}

/**
 * Debounced per-map persistence: writes the active doc to its OWN slot (tactica:doc:<mapId>),
 * never the legacy single key. Returns a handle whose flush() writes the current doc immediately
 * — the map switch calls it so the outgoing map's latest edits land in its slot before the store
 * is replaced with the incoming map's doc. Only doc changes persist; view-only changes are skipped
 * (same reference-equality gate as before).
 * @param {{getDoc:Function, subscribe:Function}} store
 * @returns {{flush:()=>void}}
 */
function installPersistence(store) {
  let timer = null;
  let lastDoc = store.getDoc();

  function write(doc) {
    try {
      localStorage.setItem(docKey(doc.mapId), serialize(doc));
    } catch {
      /* storage full/blocked — persistence is best-effort, the session still works */
    }
  }

  store.subscribe((doc) => {
    if (doc === lastDoc) return; // view-only change — never persist view
    lastDoc = doc;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      write(doc);
    }, PERSIST_DEBOUNCE_MS);
  });

  return {
    flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      // Write whatever the store currently holds — at switch time that's the OUTGOING map's doc.
      write(store.getDoc());
    },
  };
}

// ---------------------------------------------------------------------------
// Share link — read path only. Existing #pb=<base64url-of-serialized-doc> links still boot into
// read-only viewer mode; the WRITE path (the old share() encoder + Share button) was removed in
// sidebar-v2 v3 item e as dead single-user UI. base64UrlDecode stays; the matching encoder is
// gone with its only caller.
// ---------------------------------------------------------------------------

function readSharedDocFromHash() {
  if (!location.hash.startsWith(SHARE_HASH_PREFIX)) return null;
  const encoded = location.hash.slice(SHARE_HASH_PREFIX.length);
  if (!encoded) return null;
  try {
    return deserialize(base64UrlDecode(encoded));
  } catch {
    return null; // malformed share link — boot the normal (persisted/fresh) doc instead
  }
}

function base64UrlDecode(encoded) {
  const b64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  return decodeURIComponent(escape(atob(padded)));
}

// ---------------------------------------------------------------------------
// Keyboard shortcuts (contract §5)
// ---------------------------------------------------------------------------

function installShortcuts(ctx, isReadonly) {
  window.addEventListener('keydown', (event) => {
    if (isTypingTarget(event.target) || isModalOpen()) return;

    if (isUndoRedoChord(event)) {
      event.preventDefault();
      if (isReadonly) return;
      if (isRedoChord(event)) ctx.redo();
      else ctx.undo();
      return;
    }

    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (isReadonly) return;

    const tool = KEY_TO_TOOL[event.key.toUpperCase()];
    if (tool) {
      event.preventDefault();
      ctx.exec({ type: 'view/setTool', tool });
    }
  });
}

function isUndoRedoChord(event) {
  if (!(event.ctrlKey || event.metaKey)) return false;
  const key = event.key.toLowerCase();
  return key === 'z' || key === 'y';
}

function isRedoChord(event) {
  const key = event.key.toLowerCase();
  return key === 'y' || (key === 'z' && event.shiftKey);
}

function isTypingTarget(target) {
  if (!target) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable === true;
}

function isModalOpen() {
  const root = document.getElementById('modal-root');
  return !!root && root.childElementCount > 0;
}

// ---------------------------------------------------------------------------
// Dev/test seam — window.__tactica exposes the store + a zip-bytes builder so the
// browser-verification harness can assert export integrity without driving a real
// file download (headless can't read the saved file). Intentionally kept in prod:
// it is read-only over store state and only ever *builds* bytes, never mutates.
// ---------------------------------------------------------------------------

function installExportTestSeam(ctx) {
  window.__tactica = {
    store: ctx.store,
    history: ctx.history,
    exec: ctx.exec,
    undo: ctx.undo,
    redo: ctx.redo,
    async exportZipBytes() {
      const { loadMapImage, renderAllFrames, assembleExportZip } = await import(
        './exportmodal-helpers.mjs'
      );
      const doc = ctx.store.getDoc();
      const tactic = doc.tactics.find((t) => t.id === doc.activeTacticId);
      const mapMeta = ctx.maps.maps.find((m) => m.id === doc.mapId);
      const mapImg = mapMeta?.available ? await loadMapImage(mapMeta.asset) : null;
      const { frames, overlays } = await renderAllFrames(
        doc,
        doc.layers,
        tactic,
        mapImg,
        ctx.roster
      );
      const { bytes } = await assembleExportZip({
        doc,
        layers: doc.layers,
        tactic,
        mapMeta,
        roster: ctx.roster,
        frames,
        overlays,
      });
      return bytes;
    },
  };
}

// ---------------------------------------------------------------------------
// Fetch helper
// ---------------------------------------------------------------------------

async function fetchJson(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`Failed to fetch ${path}: ${res.status} ${res.statusText}`);
  return res.json();
}
