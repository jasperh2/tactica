// ui/gate.mjs — TACTICA client-side password gate [testing-only access control]
//
// HONESTY / THREAT MODEL: this is COSMETIC access control, not real security. The TACTICA
// source is a PUBLIC GitHub repo, so this file (including PASSWORD_HASH below) is readable by
// anyone, and any visitor who opens devtools can set the localStorage unlock flag or read the
// hash. It only keeps casual passers-by out of a testing build — Jasper approved this ("all
// testing"). The real gate is a later Cloudflare Worker migration (server-side check, source
// never shipped to the client). Do NOT treat this as protecting anything sensitive.
//
// The plaintext password is NEVER stored here — only its SHA-256 hex digest. Comparison hashes
// the user's input via crypto.subtle (available in secure contexts: https + localhost) and
// compares digests. Pure helpers (sha256Hex/hexEqual/isCorrectPassword) are node-testable; the
// DOM part (mountGate) is a thin full-viewport overlay that blocks the app until unlocked.

/** SHA-256 hex of the one testing password. Public by design (see threat model above). */
export const PASSWORD_HASH =
  'b4fb2d3a90eb8d07eaeaf2aaec52f0007433eb684f565354d7d4d95a436dcd31';

/** localStorage flag set once unlocked, so Jasper doesn't retype every visit. */
export const GATE_STORAGE_KEY = 'tactica.gate.v1';

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
 * non-string argument. (Not a real constant-time compare — irrelevant for a cosmetic gate
 * whose hash is public anyway.)
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

// Static overlay markup — no interpolation, so no injection surface. The password input value
// is read via the DOM (el.value), never written into markup.
const OVERLAY_HTML = `
  <div class="gate-card" role="dialog" aria-modal="true" aria-labelledby="gate-title">
    <div class="gate-brand section-label">TACTICA</div>
    <h1 id="gate-title" class="gate-heading">Restricted — Immortals testing build</h1>
    <p class="gate-sub">Enter the access password to continue.</p>
    <form class="gate-form" novalidate>
      <input
        class="input gate-input"
        type="password"
        name="password"
        autocomplete="off"
        autocapitalize="off"
        autocorrect="off"
        spellcheck="false"
        aria-label="Access password"
        placeholder="Password"
      />
      <button class="btn btn-primary gate-submit" type="submit">Unlock</button>
    </form>
    <p class="gate-error" role="alert" hidden>Wrong password — try again.</p>
  </div>
`;

/**
 * Mounts the gate overlay into `host` and blocks the app until unlocked. If already unlocked
 * (localStorage flag), does nothing and returns immediately. Independent of app boot — the app
 * modules keep loading underneath; the overlay just covers and traps focus. Share links (#pb=)
 * still boot normally underneath and become visible once unlocked.
 * @param {HTMLElement} host  container to render the overlay into (its own full-viewport node)
 */
export function mountGate(host) {
  if (isUnlocked()) return;

  const overlay = document.createElement('div');
  overlay.className = 'gate-overlay';
  overlay.innerHTML = OVERLAY_HTML;
  host.appendChild(overlay);

  // Block Tab from reaching the app underneath: while the overlay is up, the rest of the page
  // is inert. `inert` is widely supported; the focus-trap keydown handler is the fallback.
  const appShell = document.getElementById('app-shell');
  if (appShell) appShell.inert = true;

  const input = overlay.querySelector('.gate-input');
  const form = overlay.querySelector('.gate-form');
  const errorEl = overlay.querySelector('.gate-error');
  const submitBtn = overlay.querySelector('.gate-submit');

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
      if (appShell) appShell.inert = false;
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
