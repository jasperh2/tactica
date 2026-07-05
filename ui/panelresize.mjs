// ui/panelresize.mjs — [ui-layout] drag-resizable + collapsible side panels (sidebar-v2 v3
// item c/d). The layers and dock columns are user-resizable via thin col-resize handles at each
// panel's canvas-facing edge; the layers panel additionally collapses to a slim rail. Widths and
// the collapsed flag persist to localStorage under a VIEW-PREFS namespace — deliberately NOT the
// doc schema (persist.mjs), mirroring ui/theme.mjs exactly: view preferences (panel widths, theme,
// sort) never enter the shared/exported document.
//
// Split for testability, same shape as theme.mjs: the pure decision logic (clampWidth /
// resolvePanelWidth / resolveCollapsed) is fully node-testable with no globals; createLayout()
// is the thin DOM/localStorage wrapper (best-effort storage — a blocked/absent read or write
// never throws, it just means the preference doesn't survive a reload).

// ---- storage keys (view-prefs namespace, NOT the doc) -----------------------------------
export const LAYERS_WIDTH_KEY = 'tactica.layersWidth';
export const DOCK_WIDTH_KEY = 'tactica.dockWidth';
export const LAYERS_COLLAPSED_KEY = 'tactica.layersCollapsed';

// ---- default / clamp bounds (mirror tokens.css --layers-w-* / --dock-w-* so the JS clamp and
// the CSS defaults can never disagree). Kept as plain numbers here; the CSS custom props are the
// visual source, these are the interaction guardrails. --------------------------------------
export const LAYERS_WIDTH = { min: 200, max: 420, def: 260 };
export const DOCK_WIDTH = { min: 300, max: 520, def: 360 };

/**
 * Clamps a pixel width into [min, max].
 * @param {number} width
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clampWidth(width, min, max) {
  return Math.min(max, Math.max(min, width));
}

/**
 * Pure resolution of "what width should this panel be", given whatever raw value storage
 * returned (a string, null, missing, or hand-edited garbage) and the panel's bounds. Mirrors
 * theme.mjs's resolveTheme: an unusable value falls back to the default rather than propagating
 * garbage; a usable-but-out-of-range value is clamped into the allowed band.
 * @param {unknown} rawStored raw localStorage value (string | null)
 * @param {{min:number, max:number, def:number}} bounds
 * @returns {number} a width in [min, max]
 */
export function resolvePanelWidth(rawStored, bounds) {
  const parsed = typeof rawStored === 'number' ? rawStored : Number(rawStored);
  if (rawStored === null || rawStored === undefined || rawStored === '' || !Number.isFinite(parsed)) {
    return bounds.def;
  }
  return clampWidth(parsed, bounds.min, bounds.max);
}

/**
 * Pure resolution of the collapsed flag. Only the exact string '1' (what persistCollapsed writes
 * for true) counts as collapsed; anything else — null, '0', garbage — resolves to expanded. This
 * keeps a corrupted value from silently hiding the layers panel on boot.
 * @param {unknown} rawStored
 * @returns {boolean}
 */
export function resolveCollapsed(rawStored) {
  return rawStored === '1';
}

// ---- best-effort storage (identical contract to theme.mjs) --------------------------------

function readStored(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // storage disabled/blocked — resolve* falls back to the default
  }
}

function writeStored(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage full/blocked — the choice still applies this session via the DOM/inline prop */
  }
}

// ---- DOM wrapper --------------------------------------------------------------------------

const HANDLE_CLASS = 'panel-resize-handle';

/**
 * Wires the resizable + collapsible layout onto the app shell. Reads persisted view-prefs and
 * applies them, mounts a drag handle at each side-column boundary (into #middle — NOT into the
 * panels, whose innerHTML gets rewritten on render), and returns a small api the layers panel
 * uses to drive its collapse chevron. Read-only (share) mode can still call this — resizing the
 * map/layers view is a harmless, pleasant affordance for a viewer.
 *
 * @param {{shell:HTMLElement, middle:HTMLElement}} els #app-shell and #middle
 * @returns {{ isLayersCollapsed:()=>boolean, toggleLayersCollapsed:()=>boolean,
 *   onCollapseChange:(cb:(collapsed:boolean)=>void)=>void }}
 */
export function createLayout(els) {
  const { shell, middle } = els;

  // Apply persisted widths + collapsed flag before first interaction.
  const layersW = resolvePanelWidth(readStored(LAYERS_WIDTH_KEY), LAYERS_WIDTH);
  const dockW = resolvePanelWidth(readStored(DOCK_WIDTH_KEY), DOCK_WIDTH);
  shell.style.setProperty('--layers-w', `${layersW}px`);
  shell.style.setProperty('--dock-w', `${dockW}px`);

  let collapsed = resolveCollapsed(readStored(LAYERS_COLLAPSED_KEY));
  const collapseListeners = [];
  applyCollapsed();

  mountHandle({
    modifier: 'layers',
    bounds: LAYERS_WIDTH,
    storageKey: LAYERS_WIDTH_KEY,
    prop: '--layers-w',
    // handle is on the layers/canvas seam: dragging RIGHT widens the layers panel.
    sign: 1,
  });
  mountHandle({
    modifier: 'dock',
    bounds: DOCK_WIDTH,
    storageKey: DOCK_WIDTH_KEY,
    prop: '--dock-w',
    // handle is on the canvas/dock seam: dragging LEFT widens the dock — inverted sign.
    sign: -1,
  });

  function applyCollapsed() {
    shell.classList.toggle('layers-collapsed', collapsed);
    // The inline --layers-w (persisted width) outranks the .layers-collapsed class rule that
    // narrows the column to the rail width — while collapsed the inline prop must come OFF or
    // the "rail" silently stays full-width and the canvas never gains the freed space.
    if (collapsed) {
      shell.style.removeProperty('--layers-w');
    } else {
      const width = resolvePanelWidth(readStored(LAYERS_WIDTH_KEY), LAYERS_WIDTH);
      shell.style.setProperty('--layers-w', `${width}px`);
    }
  }

  function mountHandle(cfg) {
    const handle = document.createElement('div');
    handle.className = `${HANDLE_CLASS} ${HANDLE_CLASS}--${cfg.modifier}`;
    handle.setAttribute('role', 'separator');
    handle.setAttribute('aria-orientation', 'vertical');
    handle.title = 'Drag to resize · double-click to reset';
    middle.appendChild(handle);

    let dragStartX = 0;
    let dragStartWidth = 0;

    handle.addEventListener('pointerdown', (event) => {
      // Never resize the collapsed layers rail — the user expands it first.
      if (cfg.modifier === 'layers' && collapsed) return;
      event.preventDefault();
      dragStartX = event.clientX;
      dragStartWidth = readCurrentWidth(cfg.prop, cfg.bounds.def);
      handle.classList.add('is-dragging');
      handle.setPointerCapture(event.pointerId);
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
      handle.addEventListener('pointercancel', onUp);
    });

    function onMove(event) {
      const delta = (event.clientX - dragStartX) * cfg.sign;
      const next = clampWidth(dragStartWidth + delta, cfg.bounds.min, cfg.bounds.max);
      shell.style.setProperty(cfg.prop, `${next}px`);
    }

    function onUp(event) {
      handle.classList.remove('is-dragging');
      try {
        handle.releasePointerCapture(event.pointerId);
      } catch {
        /* pointer already released — nothing to do */
      }
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
      writeStored(cfg.storageKey, String(readCurrentWidth(cfg.prop, cfg.bounds.def)));
    }

    handle.addEventListener('dblclick', () => {
      shell.style.setProperty(cfg.prop, `${cfg.bounds.def}px`);
      writeStored(cfg.storageKey, String(cfg.bounds.def));
    });
  }

  function readCurrentWidth(prop, fallback) {
    const raw = getComputedStyle(shell).getPropertyValue(prop).trim();
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : fallback;
  }

  return {
    isLayersCollapsed: () => collapsed,
    toggleLayersCollapsed() {
      collapsed = !collapsed;
      applyCollapsed();
      writeStored(LAYERS_COLLAPSED_KEY, collapsed ? '1' : '0');
      collapseListeners.forEach((cb) => cb(collapsed));
      return collapsed;
    },
    onCollapseChange(cb) {
      collapseListeners.push(cb);
    },
  };
}
