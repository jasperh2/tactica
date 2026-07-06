// shared/gate.mjs — Immortals Academy client-side password gate [testing-only access control]
//
// RELATIONSHIP TO TACTICA'S GATE (site/tactics/ui/gate.mjs): this is the SAME pattern and the
// SAME password, factored so both trees can use one gate without either importing across the
// tree boundary (tactics/ stays FROZEN per docs/specs/academy-site-architecture.md; this file is
// new and owned by the Academy pages). The PASSWORD_HASH below is byte-identical to TACTICA's —
// unlocking one does NOT unlock the other (see GATE_STORAGE_KEY below), by design: Jasper can be
// on the Academy pages without exposing an already-unlocked TACTICA tab to a shared screen, and
// vice versa. If TACTICA's gate ever changes password, update both files — there is deliberately
// no shared import, only a shared shape (same functions/constants/markup skeleton), so a future
// consolidation (e.g. a real CF Worker gate) can replace either file independently.
//
// HONESTY / THREAT MODEL: this is COSMETIC access control, not real security — same caveat as
// TACTICA's gate. The plaintext password is NEVER stored here, only its SHA-256 hex digest.
// Comparison hashes the user's input via crypto.subtle (secure contexts: https + localhost) and
// compares digests. Pure helpers (sha256Hex/hexEqual/isCorrectPassword) are node-testable; the
// DOM part (mountGate) is a thin full-viewport overlay that blocks the page until unlocked.

/** SHA-256 hex of the one testing password. Public by design (see threat model above). Same
 * password as TACTICA's gate (site/tactics/ui/gate.mjs) — same hash, byte-for-byte. */
export const PASSWORD_HASH =
  'b4fb2d3a90eb8d07eaeaf2aaec52f0007433eb684f565354d7d4d95a436dcd31';

/** localStorage flag set once unlocked. Deliberately a DIFFERENT key from TACTICA's
 * ('tactica.gate.v1') — the two trees unlock independently even though the password is shared. */
export const GATE_STORAGE_KEY = 'academy.gate.v1';

/** Value written under GATE_STORAGE_KEY on a successful unlock. */
const UNLOCKED_VALUE = '1';

/**
 * SHA-256 of `text`, returned as 64-char lowercase hex. Uses the Web Crypto API
 * (globalThis.crypto.subtle), which node exposes too — so this is directly testable.
 * @param {string} text
 * @returns {Promise<string>}
 */
export async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(String(text));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Length-safe, case-insensitive equality for two hex digest strings. Returns false for any
 * non-string argument. (Not a real constant-time compare — irrelevant for a cosmetic gate whose
 * hash is public anyway.)
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
export function hexEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const lowerA = a.toLowerCase();
  const lowerB = b.toLowerCase();
  if (lowerA.length !== lowerB.length) return false;
  let mismatch = 0;
  for (let i = 0; i < lowerA.length; i += 1) {
    mismatch |= lowerA.charCodeAt(i) ^ lowerB.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * True when `input` hashes to the embedded PASSWORD_HASH. Non-string input resolves false
 * (never throws). Exact match only — no trimming, case-sensitive.
 * @param {unknown} input
 * @returns {Promise<boolean>}
 */
export async function isCorrectPassword(input) {
  if (typeof input !== 'string') return false;
  const digest = await sha256Hex(input);
  return hexEqual(digest, PASSWORD_HASH);
}

/** True if the unlock flag is already set (best-effort; storage may be blocked). */
export function isUnlocked() {
  try {
    return localStorage.getItem(GATE_STORAGE_KEY) === UNLOCKED_VALUE;
  } catch {
    return false; // storage disabled (private mode / blocked) — treat as locked
  }
}

/** Persist the unlock flag (best-effort — a blocked write just means retype next visit). */
function persistUnlock() {
  try {
    localStorage.setItem(GATE_STORAGE_KEY, UNLOCKED_VALUE);
  } catch {
    /* storage full/blocked — the current session is unlocked regardless */
  }
}

// Static overlay markup — no interpolation, so no injection surface. The password input value is
// read via the DOM (el.value), never written into markup. Class names are Academy-scoped
// (`academy-gate-*`) rather than reused from TACTICA's `gate-*` so both stylesheets can style
// their own overlay without collision if a page ever loaded both (it shouldn't, but cheap safety).
//
// Markup/copy ported from design/handoff-academy-pages/design_handoff_immortals_academy/
// templates/Gate.dc.html (single calm password screen + error state) — class names match the
// handoff's element intent 1:1 (emblem, wordmark, microcopy label, password field, submit,
// error line). This is a SURGICAL markup-string edit only: unlock logic (isCorrectPassword,
// persistUnlock), storage key (GATE_STORAGE_KEY), and DOM wiring below are unchanged. Two
// deliberate improvements kept over the raw handoff reference (not fidelity regressions): the
// existing role="dialog"/aria-modal/aria-labelledby wiring (the handoff has no ARIA — a static
// HTML reference, not accessible markup) and the focus-trap/inert behavior already in mountGate.
const OVERLAY_HTML = `
  <div class="academy-gate-card" role="dialog" aria-modal="true" aria-labelledby="academy-gate-title">
    <div class="academy-gate-emblem" aria-hidden="true">IA</div>
    <h1 id="academy-gate-title" class="academy-gate-wordmark">Immortals Academy</h1>
    <p class="academy-gate-microcopy">House Immortals members</p>
    <form class="academy-gate-form" novalidate>
      <input
        class="input academy-gate-input"
        type="password"
        name="password"
        autocomplete="off"
        autocapitalize="off"
        autocorrect="off"
        spellcheck="false"
        aria-label="Password"
        placeholder="Password"
      />
      <button class="btn btn-primary academy-gate-submit" type="submit">Enter</button>
    </form>
    <p class="academy-gate-error" role="alert" hidden>Wrong password.</p>
  </div>
`;

/**
 * Mounts the gate overlay into `host` and blocks the page until unlocked. If already unlocked
 * (localStorage flag), does nothing and returns immediately. Independent of page boot — other
 * modules keep loading underneath; the overlay just covers and traps focus.
 * @param {HTMLElement} host  container to render the overlay into (its own full-viewport node)
 * @param {HTMLElement} [appShell]  optional shell element to mark `inert` while locked (defaults
 *   to document.getElementById('app-shell') if present; safe no-op if neither exists)
 */
export function mountGate(host, appShell) {
  if (isUnlocked()) return;

  const overlay = document.createElement('div');
  overlay.className = 'academy-gate-overlay';
  overlay.innerHTML = OVERLAY_HTML;
  host.appendChild(overlay);

  // Block Tab from reaching the page underneath: while the overlay is up, the rest of the page
  // is inert. `inert` is widely supported; the focus-trap keydown handler is the fallback.
  const shell = appShell || document.getElementById('app-shell');
  if (shell) shell.inert = true;

  const input = overlay.querySelector('.academy-gate-input');
  const form = overlay.querySelector('.academy-gate-form');
  const errorEl = overlay.querySelector('.academy-gate-error');
  const submitBtn = overlay.querySelector('.academy-gate-submit');

  input.focus();

  // Focus trap fallback (in case `inert` is unavailable): keep Tab cycling inside the overlay.
  overlay.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return;
    const focusable = [input, submitBtn];
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  });

  async function attempt() {
    if (await isCorrectPassword(input.value)) {
      persistUnlock();
      if (shell) shell.inert = false;
      overlay.remove();
      return;
    }
    errorEl.hidden = false;
    input.value = '';
    input.focus();
  }

  // submit fires for both the Unlock button click and Enter pressed in the input.
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    attempt();
  });
}
