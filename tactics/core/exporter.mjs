// core/exporter.mjs — builds the "animation package" export contents.
// Pure module: no DOM, no Date/Math.random. ONE exception: fetchTacticalBriefs performs a
// browser fetch() (site/tactics runs client-side and cannot read the repo off disk) — see its
// docstring for the graceful-degradation contract. Every other export stays pure. [core-export]
// Schema: SPEC-export-package.md. Object shapes: docs/specs/tactics-tool-architecture.md §3-4.
import { positionAt } from './playbook.mjs';

const COORD_DECIMALS = 2;
const SHIPPED_FRAME_WIDTH_PX = 900;
const SPEC_MAP_WIDTH_WISH_PX = 1600;
const RARITY_NAMES = { 1: 'Uncommon', 2: 'Rare', 3: 'Epic', 4: 'Legendary' };
const DEFAULT_ROUTE_THICKNESS = 3; // matches app.mjs DEFAULT_TOOL_OPTIONS.thickness + render.mjs
const DEFAULT_ROUTE_HEAD = 'solid'; // matches render.mjs drawPolylineStroke default

const COORD_ROUNDING_FACTOR = 10 ** COORD_DECIMALS;

/** Round a percent coordinate to 2 decimal places (SPEC: "coords rounded to 2 decimals"). */
function roundCoord(n) {
  return Math.round(n * COORD_ROUNDING_FACTOR) / COORD_ROUNDING_FACTOR;
}

/** Objects OWNED by frame `kf` (independent-frames model: appearsAt === kf), regardless of layer
 * UI-visible flag. Each exported keyframe carries exactly that frame's own state; the animator
 * diffs consecutive keyframes by unit code to find what spawns, moves, or despawns. */
function frameObjects(tactic, kf) {
  return tactic.objects.filter((obj) => obj.appearsAt === kf);
}

// ---- roster identity / role-name resolution (export gaps 2 & 3, 2026-08-11) -----------------
// A marker's own `name` is a placement-time snapshot that regularly ships empty (see the export
// report for the traced cause); the roster (data/roster.json) is the actual source of truth for
// a unit's name/class/rarity, and buildIconsManifest already joined it that way for icons/
// manifest.json. resolveIdentity below does the SAME join so every units[] entry is self-
// contained — Design needs no separate lookup into icons/manifest.json to get a real name.
//
// `role` is a bare hex with no semantic attached. It is NOT a friendly/enemy side — this tool has
// no team/faction concept anywhere (no `team`/`faction` field, no "enemy" roster section); it is
// a named TACTICAL GROUP colour the author assigns freely from data/roster.json's `roles` table
// (Vanguard/Flank/Cavalry/Support/Artillery/Recon/Reserve/Ping). resolveRoleName below surfaces
// that real, codified semantic instead of inventing a friendly/enemy label the data doesn't have.

/**
 * Resolve a unit's canonical identity from the roster by code. Roster is authoritative when it
 * recognizes the code; `fallbackName` (the marker's own snapshot `name`) is used only when the
 * code is unregistered — same honest-absence fallback buildIconsManifest already used for icons.
 * @param {object} roster @param {string} code @param {string} fallbackName
 * @returns {{name:string, class:string, rarity:string, entry:object|null}}
 */
function resolveIdentity(roster, code, fallbackName) {
  const found = findRosterEntry(roster, code);
  const rarityTier = found?.entry.rarity;
  return {
    name: found?.entry.name ?? fallbackName,
    class: found ? classFieldFor(found.entry, found.sectionKey) : '',
    rarity: RARITY_NAMES[rarityTier] ?? 'Uncommon',
    entry: found?.entry ?? null,
  };
}

/**
 * Resolve a hex colour to its named tactical role via roster.roles (e.g. "#e5484d" -> "Vanguard").
 * Returns undefined when unresolvable (no roles table on this roster, or a colour outside it —
 * e.g. a hand-picked custom colour) so the caller omits the field rather than guessing a label.
 * @param {object} roster @param {string} hex @returns {string|undefined}
 */
function resolveRoleName(roster, hex) {
  const match = (roster?.roles ?? []).find(
    (r) => typeof r.hex === 'string' && typeof hex === 'string' && r.hex.toLowerCase() === hex.toLowerCase()
  );
  return match?.name;
}

/** Build one playbook.json `units[]` entry for a marker object at keyframe `kf`.
 * Includes the object's stable `id` (H8/EX2 — lets the animator diff/track the same object across
 * frames unambiguously) and, when authored, its `label` (OB1). `name`/`class`/`rarity` are
 * roster-resolved (gap 2); `role_name` is the roster's named-role semantic for the `role` colour
 * (gap 3); `from_id` (gap 1) is the id of the object this one continues from — present only when
 * playbook.mjs recorded an authored continuation link (Duplicate Frame / copy-paste), never
 * inferred. */
function unitEntry(marker, kf, roster) {
  const { x, y } = positionAt(marker, kf);
  const identity = resolveIdentity(roster, marker.code, marker.name);
  const roleName = resolveRoleName(roster, marker.role);
  const entry = {
    id: marker.id,
    code: marker.code,
    name: identity.name,
    class: identity.class,
    rarity: identity.rarity,
    x: roundCoord(x),
    y: roundCoord(y),
    role: marker.role,
    layer: marker.layerId,
  };
  if (roleName) entry.role_name = roleName;
  if (marker.label) entry.label = marker.label;
  if (marker.continuesFrom) entry.from_id = marker.continuesFrom;
  return entry;
}

/** Build one playbook.json `routes[]` entry from a route object. Carries the stable `id`
 * (H8/EX2) plus authored styling — thickness/dashed/head (EX3) — so the machine-readable spec
 * matches the rendered PNGs, the optional `label` (OB1) when set, and `color_name` (gap 3) — the
 * roster's named-role semantic for `color`, same resolution as unit `role_name` — when resolvable. */
function routeEntry(route, roster) {
  const entry = {
    id: route.id,
    points: route.points.map(([x, y]) => [roundCoord(x), roundCoord(y)]),
    color: route.role,
    thickness: route.thickness ?? DEFAULT_ROUTE_THICKNESS,
    dashed: route.dashed ?? false,
    head: route.head ?? DEFAULT_ROUTE_HEAD,
  };
  const roleName = resolveRoleName(roster, route.role);
  if (roleName) entry.color_name = roleName;
  if (route.label) entry.label = route.label;
  return entry;
}

/**
 * Build one playbook.json `zones[]` entry from a zone object, dispatching on `zone.shape`.
 *
 * SPEC-export-package.md note (see the file's "Zone shapes" section): an 'ellipse' zone entry
 * keeps NO `shape` key ({id,cx,cy,rx,ry,color,label?}) — a consumer branches on the presence of
 * `shape:'polygon'`. A 'polygon' zone entry is the additive entry shape ({id,shape:'polygon',
 * points,color,label?}): any existing playbook.json consumer (the Claude-Design animator) that
 * assumes every zones[] entry has cx/cy/rx/ry will need its own shape-aware handling before it
 * can render a polygon zone. Both shapes now carry the object's stable `id` (H8/EX2) so the
 * animator can track a zone across frames by id rather than positional index. `color_name` (gap
 * 3) is the roster's named-role semantic for `color`, same resolution as unit `role_name`/route
 * `color_name`, present only when resolvable.
 * @param {object} zone
 * @param {object} roster
 * @returns {object}
 */
function zoneEntry(zone, roster) {
  const roleName = resolveRoleName(roster, zone.role);
  if (zone.shape === 'polygon') {
    const entry = {
      id: zone.id,
      shape: 'polygon',
      points: zone.points.map(([x, y]) => [roundCoord(x), roundCoord(y)]),
      color: zone.role,
    };
    if (roleName) entry.color_name = roleName;
    if (zone.label) entry.label = zone.label;
    return entry;
  }

  const entry = {
    id: zone.id,
    cx: roundCoord(zone.cx),
    cy: roundCoord(zone.cy),
    rx: roundCoord(zone.rx),
    ry: roundCoord(zone.ry),
    color: zone.role,
  };
  if (roleName) entry.color_name = roleName;
  if (zone.label) entry.label = zone.label;
  return entry;
}

// ---- unit continuity (export gap 1, 2026-08-11 — the highest-priority fix) --------------------
// Independent frames means a unit that should read as "still on the field" must be re-authored
// on every frame it appears on; when the author adds a frame without doing that (keyframeOps.add,
// or simply not re-placing), the export used to just show `units: []` with no signal at all — the
// animator had no way to tell "these units left" from "the author didn't restate them" and had to
// invent movement from nothing. classifyContinuity computes an honest, zero-inference answer from
// data TACTICA actually has (see playbook.mjs's `continuesFrom` — the one moment the tool knows
// two objects are the same logical unit is when one is cloned from the other).

/**
 * Classify this frame's units against the previous exported keyframe's units.
 *   - `continuing`: this frame's unit has a `from_id` that matches an id from the PREVIOUS
 *     frame's own units — an authored, unambiguous same-unit link (Duplicate Frame / copy-paste).
 *     `moved` is a plain comparison of the two already-rounded positions.
 *   - `entering`: everything else this frame — no authored link back. May be a genuine new spawn
 *     or a re-placement the author didn't chain via Duplicate Frame; TACTICA cannot tell those
 *     apart, so neither is asserted.
 *   - `not_continued`: previous-frame units that no entry this frame claims via `from_id`. This
 *     does NOT assert the unit despawned — there is no despawn gesture distinct from "wasn't
 *     re-authored" — it names exactly which units are now ambiguous so the animator makes that
 *     creative call deliberately instead of guessing blind against a silently empty frame.
 * @param {object[]} units this frame's own unit entries (already built)
 * @param {object[]} previousUnits the previous keyframe's own unit entries, or [] for keyframe 1
 * @returns {{entering:object[], continuing:object[], not_continued:object[]}}
 */
function classifyContinuity(units, previousUnits) {
  const previousById = new Map(previousUnits.map((u) => [u.id, u]));
  const claimed = new Set();
  const entering = [];
  const continuing = [];

  for (const unit of units) {
    const from = unit.from_id ? previousById.get(unit.from_id) : undefined;
    if (!from) {
      entering.push({ id: unit.id, code: unit.code });
      continue;
    }
    claimed.add(from.id);
    continuing.push({
      id: unit.id,
      from_id: from.id,
      code: unit.code,
      moved: unit.x !== from.x || unit.y !== from.y,
    });
  }

  const not_continued = previousUnits
    .filter((u) => !claimed.has(u.id))
    .map((u) => ({ id: u.id, code: u.code }));

  return { entering, continuing, not_continued };
}

/** Build one playbook.json keyframe entry: this frame's OWN units/routes/zones (independent-frames
 * model — appearsAt===kf, NOT cumulative), plus `continuity` (gap 1) against `previousUnits` and
 * `desc` (gap 4) — an alias of `note` under the name the artifact/animation framework looks for;
 * both stay honestly empty when the author left no intent, never fabricated. */
function buildKeyframeEntry(tactic, kfMeta, roster, previousUnits) {
  const kf = kfMeta.n;
  const visible = frameObjects(tactic, kf);
  const units = visible.filter((o) => o.kind === 'unit').map((m) => unitEntry(m, kf, roster));
  const note = tactic.notes?.[kf] ?? '';
  return {
    keyframe: kf,
    label: kfMeta.name,
    t: kfMeta.t,
    note,
    desc: note,
    units,
    routes: visible.filter((o) => o.kind === 'route').map((r) => routeEntry(r, roster)),
    zones: visible.filter((o) => o.kind === 'zone').map((z) => zoneEntry(z, roster)),
    continuity: classifyContinuity(units, previousUnits),
  };
}

/** Parses a "m:ss" battle-clock string (the freeform `t` field) to whole seconds; null for
 * anything that doesn't cleanly parse (blank, freeform text, malformed) — never guesses. */
function parseClockSeconds(t) {
  const match = typeof t === 'string' ? /^(\d+):([0-5]\d)$/.exec(t.trim()) : null;
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/**
 * Derives `duration_seconds` per keyframe (gap 6) from the gap to the NEXT keyframe's `t`, only
 * when both parse as "m:ss" and the timeline doesn't run backwards. The last keyframe has no next
 * frame to time against, so it never gets a duration — honest absence, not a guess at how long
 * the final hold should be. A keyframe whose own or neighbouring `t` doesn't parse is left alone.
 * @param {object[]} keyframes @returns {object[]}
 */
function withDurations(keyframes) {
  return keyframes.map((entry, i) => {
    const next = keyframes[i + 1];
    if (!next) return entry;
    const start = parseClockSeconds(entry.t);
    const end = parseClockSeconds(next.t);
    if (start === null || end === null || end < start) return entry;
    return { ...entry, duration_seconds: end - start };
  });
}

/**
 * Build the playbook.json motion spec for the doc's active tactic.
 * @param {{tactics:object[], activeTacticId:string}} doc
 * @param {object} roster joined into every unit/route/zone entry (name/class/rarity/role_name)
 * @param {{name:string, assetSize:{w:number,h:number}}} mapMeta
 * @returns {object} matches SPEC-export-package.md playbook.json schema, plus additive fields
 *   documented in the export report (class/rarity/role_name/color_name/from_id/continuity/desc/
 *   duration_seconds) — see this file's module docstring areas for each gap's rationale.
 */
export function buildPlaybook(doc, roster, mapMeta) {
  const tactic = doc.tactics.find((t) => t.id === doc.activeTacticId);
  const keyframes = [];
  let previousUnits = [];
  for (const kfMeta of tactic.keyframes) {
    const entry = buildKeyframeEntry(tactic, kfMeta, roster, previousUnits);
    keyframes.push(entry);
    previousUnits = entry.units;
  }
  return {
    tactic: tactic.name,
    map: mapMeta.name,
    map_file: `map/${mapFileNameFor(mapMeta)}`,
    map_size: { w: mapMeta.assetSize.w, h: mapMeta.assetSize.h },
    coordinate_space: 'percent 0-100 of map, origin top-left',
    linear: true,
    fps_suggested: 30,
    keyframes: withDurations(keyframes),
  };
}

/** Derive the zip-internal map/<name>.png filename from a map id (kebab-case, .png). */
function mapFileNameFor(mapMeta) {
  return `${mapMeta.id}.png`;
}

/** Find a roster entry by code across units/heroes/artillery/extra; returns {entry, sectionKey} or null. */
function findRosterEntry(roster, code) {
  for (const sectionKey of ['units', 'heroes', 'artillery', 'extra']) {
    const entry = (roster[sectionKey] ?? []).find((r) => r.code === code);
    if (entry) return { entry, sectionKey };
  }
  return null;
}

/** The "class" field for a manifest icon entry: units/heroes use `class`, artillery uses `type`. */
function classFieldFor(entry, sectionKey) {
  if (sectionKey === 'artillery') return entry.type;
  return entry.class ?? entry.weapon ?? entry.desc ?? '';
}

/**
 * Build icons/manifest.json: unique unit codes used in the tactic, resolved against the roster.
 * Each entry carries a `placeholder` flag (EX5): true when no real roster art shipped for that
 * code (the zip's icons/<CODE>.png is a generated coded tile the animator must replace), false
 * when the roster entry has an `icon` path (real art shipped in the zip). This makes the
 * animator's to-do list accurate instead of labelling every tile "placeholder".
 * @param {{objects:object[]}} tactic
 * @param {object} roster {units,heroes,artillery,extra}
 * @returns {{note:string, icons:{code:string,name:string,class:string,rarity:string,placeholder:boolean}[]}}
 */
export function buildIconsManifest(tactic, roster) {
  const seen = new Set();
  const icons = [];

  for (const obj of tactic.objects) {
    if (obj.kind !== 'unit' || seen.has(obj.code)) continue;
    seen.add(obj.code);
    // Same roster join as unitEntry's resolveIdentity (export gap 2) — the manifest and every
    // units[] entry are guaranteed to agree on a code's name/class/rarity, never drift apart.
    const identity = resolveIdentity(roster, obj.code, obj.name);
    icons.push({
      code: obj.code,
      name: identity.name,
      class: identity.class,
      rarity: identity.rarity,
      placeholder: !identity.entry?.icon,
    });
  }

  return {
    note: 'Each entry has a `placeholder` flag: true = generated coded tile, replace icons/CODE.png with final art (keep the filename); false = real art already shipped in this zip.',
    icons,
  };
}

// ---- tactical briefs (placed-token scoping, 2026-08-11) ---------------------------------------
// site/tactics/data/tactical-briefs.json (tools/gen-tactical-briefs/gen.mjs) carries a compact
// per-token brief — role, positioning, up to two "does in a fight" bullets, grounded tags — for
// every roster unit code and hero weapon class, so Design knows what each token DOES, not just
// where it sits (Jasper: "connect the units in the animation with their unit guide... show what
// they're doing... same for heroes — in the back? who's blocking supply?"). The full file is 71
// entries; a single tactic typically places a handful, so the zip ships only THOSE — reusing
// buildIconsManifest's exact placed-code traversal (iterate tactic.objects, kind==='unit', dedupe
// via a Set) above rather than a parallel scan.

/** Lowercase-hyphenate slug normalizer — reimplemented byte-for-byte from
 * tools/gen-tactical-briefs/gen.mjs's `normalizeToSlug` rather than imported: that tool is a Node
 * CLI with module-scope `node:fs`/`node:path` imports and cannot load in this file's browser
 * runtime (site/tactics is vanilla client-side ESM, zero deps, no bundler). Used only to resolve
 * a roster hero's `weapon` field to its tactical-briefs.json `heroes{}` key, exactly as gen.mjs's
 * own `resolveHeroSlug` does. @param {string} name */
function normalizeToSlug(name) {
  return String(name)
    .toLowerCase()
    .replace(/'/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Scopes the full tactical-briefs.json document down to the tokens ACTUALLY PLACED in this
 * tactic. Both `units` and `heroes` in the result are keyed by the PLACED MARKER'S OWN roster
 * `code` — for heroes this means the code -> `weapon` -> weapon-class-slug join (the same
 * resolution gen.mjs's `resolveHeroSlug` performs) happens once, here, so a zip consumer can do
 * `briefs.heroes[marker.code]` exactly like `briefs.units[marker.code]`, never re-deriving the
 * weapon-class join itself. Roster sections tactical-briefs.json has no coverage for (artillery,
 * extra) are silently skipped, same as any code with no roster entry at all.
 *
 * A placed code with nothing to show — roster miss, artillery/extra section, or the source file
 * genuinely has no entry for that unit/weapon-class — is OMITTED from both maps, never a
 * fabricated or empty-shaped placeholder (CLAUDE.md anti-fabrication rule: absence is honest).
 * Returns null when `briefsDoc` itself is unavailable (upstream fetch failed) or when nothing
 * placed resolved to any brief at all — callers (packageEntries) treat null as "ship no file",
 * never an empty/near-empty one.
 * @param {{objects:object[]}} tactic
 * @param {object} roster {units,heroes,artillery,extra}
 * @param {{units?:object, heroes?:object}|null} briefsDoc the parsed tactical-briefs.json, or
 *   null when fetchTacticalBriefs couldn't load it
 * @returns {{note:string, units:Record<string,object>, heroes:Record<string,object>}|null}
 */
export function scopeTacticalBriefs(tactic, roster, briefsDoc) {
  if (!briefsDoc) return null;

  const seen = new Set();
  const units = {};
  const heroes = {};

  for (const obj of tactic.objects) {
    if (obj.kind !== 'unit' || seen.has(obj.code)) continue;
    seen.add(obj.code);

    const found = findRosterEntry(roster, obj.code);
    if (!found) continue;

    if (found.sectionKey === 'units') {
      const brief = briefsDoc.units?.[obj.code];
      if (brief) units[obj.code] = brief;
    } else if (found.sectionKey === 'heroes') {
      const weaponSlug = normalizeToSlug(found.entry.weapon ?? '');
      const brief = briefsDoc.heroes?.[weaponSlug];
      if (brief) heroes[obj.code] = brief;
    }
  }

  if (Object.keys(units).length === 0 && Object.keys(heroes).length === 0) return null;
  return {
    note:
      "Tactical context for the tokens placed in THIS tactic only (see tools/gen-tactical-briefs " +
      "for the full per-roster file). Already resolved - briefs.units[code] and " +
      "briefs.heroes[code] both use this tactic's own marker codes, no roster lookup or weapon-" +
      "class join needed. A placed code with no key here has no tactical brief available.",
    units,
    heroes,
  };
}

/**
 * Fetches and parses site/tactics/data/tactical-briefs.json, relative to site/tactics/ (same
 * convention as ui/app.mjs's `fetchJson('./data/roster.json')`). Unlike that boot-time loader,
 * this resolves null on ANY failure — non-ok response, network error, malformed JSON — instead
 * of throwing, matching the SAME graceful-degradation contract already used twice in this
 * codebase for optional data (ui/app.mjs's `fetchCanonicalDoc`, ui/exportmodal-helpers.mjs's
 * `fetchAssetBytes`): a missing tactical brief is a nice-to-have, never worth failing an export
 * an author is trying to ship.
 * @param {string} [path]
 * @returns {Promise<object|null>}
 */
export async function fetchTacticalBriefs(path = './data/tactical-briefs.json') {
  try {
    const res = await fetch(path);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Human intro string for the export README.md (SPEC-export-package.md zip layout).
 * @param {{name:string}} tactic
 * @param {{name:string, assetSize:{w:number,h:number}}} mapMeta
 * @returns {string}
 */
export function buildExportReadme(tactic, mapMeta) {
  const shippedWidth = mapMeta.assetSize.w;
  const resolutionNote =
    shippedWidth < SPEC_MAP_WIDTH_WISH_PX
      ? `Map art shipped at its native ${shippedWidth}px width (source asset is smaller than the ${SPEC_MAP_WIDTH_WISH_PX}px target; this is the highest resolution available for ${mapMeta.name}).`
      : `Map art shipped at ${shippedWidth}px width.`;

  return [
    `# ${tactic.name} — animation package`,
    '',
    `Tactic plan for ${mapMeta.name}, exported from TACTICA. This package is the contract between`,
    'the designer (TACTICA) and the animator (Claude Code): playbook.json is the motion spec, the',
    'renders are references, and icons/ lists the unit art still to be generated.',
    '',
    '## Contents',
    '- `playbook.json` — the motion spec: keyframes, each frame\'s own unit/route/zone state, notes.',
    '  Coordinates are percent (0-100) of the map, origin top-left. Every object carries a stable',
    '  `id` — diff consecutive keyframes by `id` (and `code` for icon lookup) to tween/spawn. Units',
    '  carry a resolved `name`/`class`/`rarity` (no separate lookup needed) and a `role_name` next',
    '  to the `role` colour (routes/zones get `color_name` next to `color`) — a named tactical',
    '  group like "Vanguard" or "Support", not a friendly/enemy side; this tool has no team concept.',
    '- `tactical-briefs.json` - what each placed unit/hero DOES: role, positioning, 1-2 things it',
    '  does in a fight, grounded tags (front-line, back-line, blocks-supply, anti-cavalry).',
    '  `units`/`heroes` are both keyed by this tactic\'s own marker `code` - no roster lookup or',
    '  weapon-class join needed. Scoped to placed tokens only (not the full roster) and present',
    '  only when at least one placed code resolved to a brief; skip this file gracefully if it is',
    '  missing.',
    `- \`map/\` — base map render (${mapMeta.name}).`,
    '- `frames/` — composite renders: map + all annotations at each keyframe (900px wide).',
    '- `overlays/` — the same renders WITHOUT the map, transparent background, pixel-aligned 1:1',
    '  with frames/ and map/.',
    '- `icons/manifest.json` — unit icons this animation needs. Each entry\'s `placeholder` flag',
    '  says whether `icons/<CODE>.png` is a generated tile to replace (true) or real shipped art',
    '  (false). Replace the placeholders with final art; keep filenames.',
    '',
    `## Coordinates & timing`,
    '`x`,`y`,`cx`,`cy`,`rx`,`ry` and route points are percent of map width/height:',
    '`px = x/100 * imageWidth`. Each keyframe carries that frame\'s complete state (frames are',
    'independent) — diff consecutive keyframes by unit code to find what spawns, moves, or despawns.',
    '`duration_seconds` is the gap to the next keyframe\'s `t`, only when both parse as "m:ss" —',
    'absent (not zero) on any keyframe where that can\'t be derived honestly, and always absent on',
    'the last keyframe (nothing to time it against).',
    '',
    '## Unit continuity',
    'Every keyframe carries a `continuity` block so spawns/tweens/holds never have to be guessed',
    'from a diff: `entering` (no authored link to the previous frame — new or an unlinked re-',
    'placement), `continuing` (this frame\'s unit has a `from_id` pointing at a previous-frame unit',
    '— an authored same-unit link; tween from that unit\'s position, `moved` says whether it',
    'actually differs), and `not_continued` (previous-frame units nothing here claims). Read',
    '`not_continued` as "ambiguous", not "despawned" — TACTICA has no despawn gesture distinct from',
    '"the author didn\'t restate it", so it names the units without asserting which happened; use',
    'the frame\'s `note`/`desc` for tactical intent when deciding.',
    '',
    '## Animation intent',
    '1. Open on the base map; keyframe 1 spawns its units (staggered, drop-in scale, ~200ms).',
    '2. Between keyframes: use `continuity` directly — tween each `continuing` unit ~500ms from its',
    '   previous position (skip the tween when `moved` is false), spawn each `entering` unit, and',
    '   make a deliberate call on `not_continued` units (hold or fade) rather than inventing motion;',
    '   reveal new routes/zones; hold each keyframe roughly a second, paced by `t`/`duration_seconds`.',
    '3. Show `label`, `t`, and `note`/`desc` (identical text; `desc` is the same one-sentence intent',
    '   under the name some animation frameworks look for) as a per-keyframe caption. Both are the',
    '   empty string, honestly, on a keyframe the author left uncaptioned — never invented text.',
    '4. Role colors group the players — keep them exact; `role_name`/`color_name` name the group.',
    '5. `tactical-briefs.json` (when present) is what each unit/hero code is DOING, not just where',
    '   it stands - use it to inform HOW a token moves/poses (a `blocks-supply` hero holds a point',
    '   rather than drifting, a `front-line` unit leads the push) instead of generic motion.',
    '',
    resolutionNote,
  ].join('\n');
}

const FRAME_INDEX_PAD = 2;

/** Zero-pad a 1-based frame index to at least FRAME_INDEX_PAD digits ("01".."10".."11"). */
function padIndex(n) {
  return String(n).padStart(FRAME_INDEX_PAD, '0');
}

/**
 * Assemble the final zip entry list with SPEC-exact paths. `tacticalBriefs` (optional — the
 * scopeTacticalBriefs result, or null/undefined) adds `tactical-briefs.json` as a sibling of
 * `playbook.json` when present; omitted entirely (no entry, never an empty file) when null/
 * undefined — the fetch-failed, nothing-resolved, and not-yet-wired-up cases all degrade the
 * same honest way, and every pre-existing caller that doesn't pass this field is unaffected.
 * @param {{playbook:object, readme:string, mapPng:Uint8Array, frames:Uint8Array[],
 *   overlays:Uint8Array[], icons:object, iconPngs:Record<string,Uint8Array>, mapFileName:string,
 *   tacticalBriefs?:object|null}} input
 * @returns {{path:string, data:Uint8Array|string}[]}
 */
export function packageEntries({ playbook, readme, mapPng, frames, overlays, icons, iconPngs, mapFileName, tacticalBriefs }) {
  const entries = [
    { path: 'README.md', data: readme },
    { path: 'playbook.json', data: JSON.stringify(playbook, null, 2) },
  ];
  if (tacticalBriefs) {
    entries.push({ path: 'tactical-briefs.json', data: JSON.stringify(tacticalBriefs, null, 2) });
  }
  entries.push(
    { path: `map/${mapFileName}`, data: mapPng },
    ...frames.map((data, i) => ({ path: `frames/frame-${padIndex(i + 1)}.png`, data })),
    ...overlays.map((data, i) => ({ path: `overlays/overlay-${padIndex(i + 1)}.png`, data })),
    { path: 'icons/manifest.json', data: JSON.stringify(icons, null, 2) },
  );

  for (const icon of icons.icons) {
    const png = iconPngs[icon.code];
    if (png) entries.push({ path: `icons/${icon.code}.png`, data: png });
  }

  return entries;
}
