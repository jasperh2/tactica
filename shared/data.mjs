// shared/data.mjs — fetch helpers for site/data/*.json (unit-pages, hero-pages indexes/records).
//
// PATH RESOLUTION: paths are resolved relative to THIS MODULE's own location
// (import.meta.url), not to the page that imports it or to the site root. This makes every
// fetch helper here work identically whether it's imported from site/index.html (depth 0),
// site/units/index.html (depth 1), or a future deploy that serves the whole site from a
// non-root subpath (e.g. GitHub Pages project sites, same pattern TACTICA already uses at
// /tactica/) — a root-relative `/data/...` path would break under a subpath deploy, and a
// bare relative `data/...` path would resolve differently depending on which page depth
// imported it. Resolving against `import.meta.url` sidesteps both: this file lives at
// site/shared/data.mjs, so `../data/...` always means site/data/... regardless of caller depth
// or deploy subpath.
//
// CACHE-BUSTING CONVENTION: every request appends `?v=<cacheVersion>` so a redeploy is visible
// immediately without the visitor needing a hard-refresh (static hosting has no server-push
// cache invalidation). `cacheVersion` defaults to the current UTC date (YYYY-MM-DD) — coarse but
// deterministic and dependency-free; callers that want per-deploy busting (a build hash, a
// commit SHA) can pass their own `cacheVersion` into any of these functions.
//
// GRACEFUL-MISSING CONVENTION (required by docs/specs/academy-site-architecture.md — the two
// index.json files may not exist yet, other build lanes produce them): every fetch helper here
// resolves to a typed "result envelope" (`{ ok, data, error }`) rather than throwing or
// rejecting on a 404/network failure. Callers (nav.mjs counts, index.html cards) check `.ok` and
// render an honest empty/absent state instead of a crash. This mirrors the API response envelope
// convention (success/data/error) from the org-wide patterns doc, applied to static-file fetches.

/** Today's date as YYYY-MM-DD (UTC), used as the default cache-busting version string. */
function defaultCacheVersion() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Appends a `?v=<cacheVersion>` cache-busting query param to `path`. If `path` already has a
 * query string, appends with `&` instead of `?`.
 * @param {string} path
 * @param {string} [cacheVersion]
 * @returns {string}
 */
export function withCacheBust(path, cacheVersion = defaultCacheVersion()) {
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}v=${encodeURIComponent(cacheVersion)}`;
}

/**
 * Fetches and parses one JSON file, never throwing. Returns a result envelope:
 *   ok:true  -> { ok: true, data: <parsed JSON>, error: null }
 *   ok:false -> { ok: false, data: null, error: '<reason>' }
 * A non-2xx response, a network failure, and a JSON-parse failure are all treated as `ok:false`
 * — the caller doesn't need to distinguish "file missing" from "file malformed" to render a
 * graceful absent state, though `error` carries the detail for debugging.
 * @param {string} path
 * @param {{ cacheVersion?: string, fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<{ ok: boolean, data: unknown, error: string|null }>}
 */
export async function fetchJson(path, options = {}) {
  const { cacheVersion, fetchImpl = fetch } = options;
  const url = withCacheBust(path, cacheVersion);
  try {
    const response = await fetchImpl(url);
    if (!response.ok) {
      return { ok: false, data: null, error: `HTTP ${response.status} for ${url}` };
    }
    const data = await response.json();
    return { ok: true, data, error: null };
  } catch (err) {
    return { ok: false, data: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/** site/shared/ -> site/, so every data path below is resolved as site/data/... regardless of
 * which page depth (or deploy subpath) imported this module. See file header. */
const SITE_ROOT_URL = new URL('..', import.meta.url);

/** Canonical URL to the compiled unit-pages index (§ academy-site-architecture layout). Lives at
 * data/unit-pages/index.json directly — NOT under public/ — per tools/build-unit-pages/lib/
 * write-outputs.mjs's writeIndex, which writes one combined index (public-safe summary fields
 * only; house/public per-slug detail files are what's split, not this index) straight into
 * outputRoot. */
export const UNIT_INDEX_PATH = new URL('data/unit-pages/index.json', SITE_ROOT_URL).href;

/** Canonical URL to the compiled hero-pages index. */
export const HERO_INDEX_PATH = new URL('data/hero-pages/index.json', SITE_ROOT_URL).href;

/**
 * Fetches the public unit-pages index (list + count of every unit page). Graceful on missing —
 * see fetchJson's envelope contract.
 * @param {{ cacheVersion?: string, fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<{ ok: boolean, data: unknown, error: string|null }>}
 */
export function fetchUnitIndex(options = {}) {
  return fetchJson(UNIT_INDEX_PATH, options);
}

/**
 * Fetches the hero-pages index (list + count of every hero page). Graceful on missing — see
 * fetchJson's envelope contract.
 * @param {{ cacheVersion?: string, fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<{ ok: boolean, data: unknown, error: string|null }>}
 */
export function fetchHeroIndex(options = {}) {
  return fetchJson(HERO_INDEX_PATH, options);
}

/**
 * Best-effort item count from an index payload. Accepts either a bare array or an object with an
 * `items`/`units`/`heroes` array property (the exact index.json shape is owned by the compiler
 * lanes building in parallel — this stays liberal so it doesn't need to change if they pick one
 * shape over another). Returns `null` (not 0) when no array can be found, so callers can
 * distinguish "confirmed zero" from "shape not recognized / index missing" and render an honest
 * absent state rather than a misleading "0".
 * @param {unknown} indexData
 * @returns {number|null}
 */
export function countFromIndex(indexData) {
  if (Array.isArray(indexData)) return indexData.length;
  if (indexData && typeof indexData === 'object') {
    for (const key of ['items', 'units', 'heroes']) {
      const value = /** @type {Record<string, unknown>} */ (indexData)[key];
      if (Array.isArray(value)) return value.length;
    }
    // Some compilers may emit a plain { count: N } summary instead of a full list.
    const count = /** @type {Record<string, unknown>} */ (indexData).count;
    if (typeof count === 'number' && Number.isFinite(count)) return count;
  }
  return null;
}
