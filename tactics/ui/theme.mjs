// ui/theme.mjs — TACTICA light/dark theme switch [ui-theme]
//
// Design: `design/handoff-tactics-tool/sidebar-v2/TACTICA Sidebar v2 Options.dc.html` §2b +
// CHANGES-sidebar-v2.md §2 "Light mode tokens". Light mode is a pure CSS-custom-property swap
// (styles/tokens.css `[data-theme="light"]` block) — this module owns ONLY the theme choice
// itself: read the persisted preference, apply it to <html data-theme>, flip + persist on
// toggle. It never touches colors/markup.
//
// Split for testability (no existing DOM-stub convention in this codebase — see gate.mjs, whose
// isUnlocked/persistUnlock/mountGate are left untested at the unit level and verified only by
// the browser pass): the pure decision logic (resolveTheme/otherTheme) is fully node-testable
// with no globals; initTheme/toggleTheme are thin wrappers around document/localStorage,
// best-effort exactly like gate.mjs's isUnlocked/persistUnlock (a blocked/absent storage read
// or write never throws — it just means the preference doesn't survive a reload).

/** localStorage key the theme preference is persisted under. */
export const THEME_STORAGE_KEY = 'tactica.theme';

/** Theme used when no valid preference is stored yet. */
export const DEFAULT_THEME = 'dark';

const VALID_THEMES = new Set(['dark', 'light']);

/**
 * True if `value` is one of the two valid theme strings.
 * @param {unknown} value
 * @returns {value is 'dark' | 'light'}
 */
export function isValidTheme(value) {
  return typeof value === 'string' && VALID_THEMES.has(value);
}

/**
 * The other theme (dark <-> light). Any input that isn't a valid theme resolves as if it were
 * DEFAULT_THEME first, so this never returns anything outside the two valid themes.
 * @param {unknown} theme
 * @returns {'dark' | 'light'}
 */
export function otherTheme(theme) {
  const current = isValidTheme(theme) ? theme : DEFAULT_THEME;
  return current === 'dark' ? 'light' : 'dark';
}

/**
 * Pure resolution of "what theme should be active", given whatever raw value storage returned
 * (which may be null, missing, or corrupted by a hand-edited localStorage). Unknown/invalid
 * values fall back to DEFAULT_THEME rather than propagating garbage onto the document.
 * @param {unknown} storedValue  raw value read from localStorage (or null if absent/blocked)
 * @returns {'dark' | 'light'}
 */
export function resolveTheme(storedValue) {
  return isValidTheme(storedValue) ? storedValue : DEFAULT_THEME;
}

/** Best-effort localStorage read; returns null on any error (blocked storage, private mode). */
function readStoredTheme() {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    return null; // storage disabled/blocked — resolveTheme(null) falls back to DEFAULT_THEME
  }
}

/** Best-effort localStorage write; a blocked/full write just means the choice resets on reload. */
function persistTheme(theme) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    /* storage full/blocked — current session still reflects the choice via the DOM attribute */
  }
}

/**
 * Reads the persisted theme preference (default 'dark') and sets it on
 * `document.documentElement.dataset.theme` so tokens.css's `[data-theme="light"]` override
 * block applies immediately. Call once at boot, before first paint if possible. Returns the
 * theme that was applied.
 * @returns {'dark' | 'light'}
 */
export function initTheme() {
  const theme = resolveTheme(readStoredTheme());
  document.documentElement.dataset.theme = theme;
  return theme;
}

/**
 * Flips the current theme (reading it off `document.documentElement.dataset.theme`), applies
 * and persists the new value, and returns it. Safe to call even if initTheme() was never called
 * (missing/invalid dataset.theme resolves as DEFAULT_THEME first, per otherTheme()).
 * @returns {'dark' | 'light'}
 */
export function toggleTheme() {
  const next = otherTheme(document.documentElement.dataset.theme);
  document.documentElement.dataset.theme = next;
  persistTheme(next);
  return next;
}
