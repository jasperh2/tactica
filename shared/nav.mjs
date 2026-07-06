// shared/nav.mjs — shared top nav for every Immortals Academy page (homepage, units, heroes)
// plus the TACTICA tool's nav-strip include (see docs/specs/academy-site-architecture.md
// layout: "tactics/ FROZEN except: nav strip include + gate include").
//
// Markup ported from design/handoff-academy-pages/design_handoff_immortals_academy/templates/
// — the content form matches Unit Page.dc.html / Hero Page.dc.html / Units Index.dc.html /
// Heroes Index.dc.html's shared `<nav class="site-nav">` (emblem + wordmark, Units / Heroes /
// Tactics tool links, active link = gold underline); the slim form matches the pinned reference
// canvas `reference/Home & Indexes - Review.dc.html` section 4c ("Shared nav, form (b) — slim
// strip above the frozen TACTICA editor"). Class names are the handoff's own vocabulary
// (`.academy-nav`, `.academy-nav-brand`, `.academy-nav-emblem`, `.academy-nav-wordmark`,
// `.academy-nav-links`, `.academy-nav-link`, `.academy-nav-toggle`) with a `.academy-nav-slim`
// modifier class added for the second form — see site/shared/academy.css §3 for the styling.
//
// Renders: emblem + wordmark (left), destination links Units / Heroes / Tactics tool (center),
// with an `active` state on whichever the current page is, and a mobile hamburger collapse
// below a breakpoint (content form only — the slim form never collapses; the reference canvas
// pins it at a fixed 1440px width above the tool). Pure DOM construction — no innerHTML with
// interpolated data, so there is no injection surface even though nothing here is untrusted
// input today.
//
// Usage:
//   import { mountNav } from '../shared/nav.mjs';
//   mountNav('home');   // or 'units' | 'heroes' | 'tactics' | null (no active highlight)
//
// The slim strip is not a separate call — mountNav renders it automatically when `active ===
// 'tactics'` (the only page that mounts nav inside the frozen TACTICA shell), so every existing
// call site (`mountNav('tactics')`, `mountNav('units')`, etc.) keeps working unchanged. Pass
// `{ slim: true }` explicitly as a third argument only if a future caller needs the slim form on
// a page other than 'tactics' (none does today).
//
// PATH RESOLUTION: hrefs are resolved relative to THIS MODULE's own location
// (import.meta.url), the same convention shared/data.mjs uses for its data-file paths — NOT a
// root-relative `/index.html`-style href. A root-relative href breaks the moment the site is
// deployed under a subpath (exactly how TACTICA is hosted today, at jasperh2.github.io/tactica/
// — a project-pages subpath, not domain root); resolving against the module's own file location
// keeps every link correct regardless of deploy subpath or which page depth mounted the nav.

/** site/shared/ -> site/, so every href below resolves to site/<path> regardless of deploy
 * subpath or caller page depth. See PATH RESOLUTION note above. */
const SITE_ROOT_URL = new URL('..', import.meta.url);

/** Valid `active` values — anything else is treated as no-active-highlight (defensive default). */
const NAV_ITEMS = [
  { key: 'home', label: 'Immortals Academy', href: new URL('index.html', SITE_ROOT_URL).href, isWordmark: true },
  { key: 'units', label: 'Units', href: new URL('units/index.html', SITE_ROOT_URL).href },
  { key: 'heroes', label: 'Heroes', href: new URL('heroes/index.html', SITE_ROOT_URL).href },
  { key: 'tactics', label: 'Tactics tool', href: new URL('tactics/index.html', SITE_ROOT_URL).href },
];

/** Escapes text for safe use as element textContent — belt-and-suspenders even though nav
 * content today is all static strings; keeps the pattern consistent with the rest of the repo's
 * ui/ modules, each of which owns its own escape helper rather than importing across trees. */
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch]);
}
const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/**
 * Builds the nav DOM tree (not yet attached to the document). Exported separately from
 * mountNav so tests can inspect structure without a full document/jsdom environment — this
 * function still needs `document` (createElement), so tests run it under node's built-in DOM-ish
 * globals are NOT assumed; the pure logic (which item is active, escaping) is tested via the
 * smaller exported helpers below instead.
 * @param {string|null} active  one of NAV_ITEMS[].key, or null/unrecognized for no highlight
 * @param {{slim?: boolean}} [options]  slim renders the 36px TACTICA-strip form (reference canvas
 *   4c): no mobile toggle/collapse, smaller emblem/type scale. Defaults to the full content form.
 * @returns {HTMLElement}
 */
export function buildNav(active, options = {}) {
  const { slim = false } = options;

  const nav = document.createElement('nav');
  nav.className = slim ? 'academy-nav academy-nav-slim' : 'academy-nav';
  nav.setAttribute('role', 'navigation');
  nav.setAttribute('aria-label', 'Main navigation');

  const brandItem = NAV_ITEMS[0];
  const brand = document.createElement('a');
  brand.className = 'academy-nav-brand';
  brand.href = brandItem.href;
  const emblem = document.createElement('span');
  emblem.className = 'academy-nav-emblem';
  emblem.setAttribute('aria-hidden', 'true');
  const wordmark = document.createElement('span');
  wordmark.className = 'academy-nav-wordmark';
  wordmark.textContent = escapeHtml(brandItem.label);
  brand.append(emblem, wordmark);
  nav.appendChild(brand);

  const list = document.createElement('ul');
  list.className = 'academy-nav-links';
  nav.appendChild(list);

  for (const item of NAV_ITEMS.slice(1)) {
    const li = document.createElement('li');
    const link = document.createElement('a');
    link.className = 'academy-nav-link';
    link.href = item.href;
    link.textContent = escapeHtml(item.label);
    if (isActiveItem(item.key, active)) {
      link.classList.add('is-active');
      link.setAttribute('aria-current', 'page');
    }
    li.appendChild(link);
    list.appendChild(li);
  }

  // The slim strip never collapses (reference canvas 4c pins it at a fixed width above the
  // frozen tool) — no mobile hamburger toggle for this form.
  if (!slim) {
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'academy-nav-toggle';
    toggle.setAttribute('aria-label', 'Toggle navigation menu');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.innerHTML = '<span class="academy-nav-toggle-bar"></span>'.repeat(3);
    nav.insertBefore(toggle, list);

    toggle.addEventListener('click', () => {
      const isOpen = list.classList.toggle('is-open');
      toggle.setAttribute('aria-expanded', String(isOpen));
      toggle.classList.toggle('is-open', isOpen);
    });
  }

  return nav;
}

/**
 * True if `itemKey` matches the current `active` selector. Pure/testable without a DOM: exact
 * match only, and any unrecognized `active` value (including null/undefined) matches nothing —
 * a typo'd active string degrades to "no page highlighted", never a wrong highlight.
 * @param {string} itemKey
 * @param {string|null|undefined} active
 * @returns {boolean}
 */
export function isActiveItem(itemKey, active) {
  return typeof active === 'string' && active === itemKey;
}

/**
 * True when `active` should render the slim TACTICA-strip form by default — currently only the
 * 'tactics' page mounts nav inside the frozen tool shell. Exported so callers/tests can reason
 * about the default without duplicating the string literal.
 * @param {string|null|undefined} active
 * @returns {boolean}
 */
export function isSlimByDefault(active) {
  return active === 'tactics';
}

/**
 * Mounts the shared nav into `host` (or `document.body` prepended, if no host given). Idempotent
 * per host — calling twice on the same host replaces the previous nav rather than duplicating it,
 * so pages can call mountNav again after a client-side active-state change without accumulating
 * stray nodes.
 * @param {string|null} [active]  which NAV_ITEMS key to highlight; see buildNav
 * @param {HTMLElement} [host]  container to mount into; defaults to a node with id="nav-root" if
 *   present, else prepends to document.body
 * @param {{slim?: boolean}} [options]  forces the slim/content form; defaults to
 *   isSlimByDefault(active) when omitted, so `mountNav('tactics')` keeps rendering the slim strip
 *   without every call site needing to know about the option.
 * @returns {HTMLElement} the mounted nav element
 */
export function mountNav(active = null, host, options) {
  const target = host || document.getElementById('nav-root') || document.body;
  const slim = options && typeof options.slim === 'boolean' ? options.slim : isSlimByDefault(active);
  const existing = target.querySelector(':scope > .academy-nav');
  const nav = buildNav(active, { slim });
  if (existing) {
    existing.replaceWith(nav);
  } else if (target === document.body) {
    target.prepend(nav);
  } else {
    target.appendChild(nav);
  }
  return nav;
}
