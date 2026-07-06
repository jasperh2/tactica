// ui/sanitize.mjs — shared attribute-sink sanitizers for every ui/ panel that interpolates
// doc-controlled strings into style/SVG attributes (canvas-objects.mjs, drawtools-helpers.mjs,
// playbookbar-helpers.mjs, layers.mjs).
//
// SECURITY CONTEXT: core/persist.mjs's deserialize() already fail-closed-validates every doc
// that enters the app through the two untrusted-input paths (localStorage boot, #pb= share
// link) — invalid colors are replaced, unknown object kinds dropped, geometry coerced to
// finite numbers. escapeHtml() (canvas-objects.mjs, playbookbar-helpers.mjs, layers.mjs) already
// covers HTML TEXT CONTENT and simple quoted attributes consistently. This module is the
// belt-and-suspenders second layer for the specific sink these two miss: values interpolated
// directly into unquoted-context-adjacent or attribute-VALUE position inside a `style="..."`
// string or a raw SVG presentation attribute (fill=/stroke=), where a plain HTML-escape of `<`/
// `>`/`"` is necessary but a strict allowlist is cheaper and strictly safer for a value that is
// supposed to be nothing but a hex color in the first place. Defense in depth: even if a future
// code path constructs a doc object without going through persist.mjs (e.g. a test/dev seam, or
// a follow-on feature that mutates state directly), these two guards are re-applied right at the
// point of interpolation, matching the fix set's "apply at EVERY attribute interpolation sink"
// instruction.
//
// Minimal insertion only — no renderer restructuring. Every call site here was already calling
// escapeHtml/escapeAttr-equivalent helpers for other fields; this module adds the two that were
// missing (color values, and a general attribute-value escaper importable without pulling in
// each panel's private escapeHtml).

/** Safe fallback color for any value that fails the hex-color pattern check (matches
 * core/persist.mjs's FALLBACK_COLOR — both independently enforce the same contract so a bad
 * color can never reach an attribute even if persist.mjs's own guard is bypassed). */
export const FALLBACK_COLOR = '#9aa3b2';

const HEX_COLOR_PATTERN = /^#[0-9a-f]{3,8}$/i;

/**
 * Validates a color value against the hex-color pattern; returns the value unchanged when
 * valid, or FALLBACK_COLOR otherwise. Use at every point a doc-controlled color string is
 * interpolated into a `style="..."` value or an SVG `fill=`/`stroke=` attribute.
 * @param {unknown} value
 * @returns {string}
 */
export function safeColor(value) {
  return typeof value === 'string' && HEX_COLOR_PATTERN.test(value) ? value : FALLBACK_COLOR;
}

/**
 * Escapes a value for safe interpolation into an HTML/SVG attribute value (inside double
 * quotes). Coerces non-strings via String() first, matching the other escapeHtml/escapeAttr
 * implementations already in this codebase (canvas-objects.mjs, playbookbar-helpers.mjs,
 * layers.mjs) — kept as a separate exported copy here (not a re-export) so ui/sanitize.mjs has
 * no import dependency on any single panel module.
 * @param {unknown} value
 * @returns {string}
 */
export function escapeAttr(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch]);
}

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
