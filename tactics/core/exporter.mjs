// core/exporter.mjs — builds the "animation package" export contents.
// Pure module: no DOM, no fetch, no Date/Math.random. [core-export]
// Schema: SPEC-export-package.md. Object shapes: docs/specs/tactics-tool-architecture.md §3-4.
import { positionAt } from './playbook.mjs';

const COORD_DECIMALS = 2;
const SHIPPED_FRAME_WIDTH_PX = 900;
const SPEC_MAP_WIDTH_WISH_PX = 1600;
const RARITY_NAMES = { 1: 'Uncommon', 2: 'Rare', 3: 'Epic', 4: 'Legendary' };

const COORD_ROUNDING_FACTOR = 10 ** COORD_DECIMALS;

/** Round a percent coordinate to 2 decimal places (SPEC: "coords rounded to 2 decimals"). */
function roundCoord(n) {
  return Math.round(n * COORD_ROUNDING_FACTOR) / COORD_ROUNDING_FACTOR;
}

/** Objects on `tactic` visible by the appearsAt<=kf model, regardless of layer UI-visible flag. */
function cumulativeObjects(tactic, kf) {
  return tactic.objects.filter((obj) => obj.appearsAt <= kf);
}

/** Build one playbook.json `units[]` entry for a marker object at keyframe `kf`. */
function unitEntry(marker, kf) {
  const { x, y } = positionAt(marker, kf);
  return {
    code: marker.code,
    name: marker.name,
    x: roundCoord(x),
    y: roundCoord(y),
    role: marker.role,
    layer: marker.layerId,
  };
}

/** Build one playbook.json `routes[]` entry from a route object. */
function routeEntry(route) {
  return {
    points: route.points.map(([x, y]) => [roundCoord(x), roundCoord(y)]),
    color: route.role,
  };
}

/**
 * Build one playbook.json `zones[]` entry from a zone object, dispatching on `zone.shape`.
 *
 * SPEC-export-package.md note (amended alongside this change — see the file's "Zone shapes"
 * section): an 'ellipse' zone entry stays BYTE-IDENTICAL to the original SPEC schema
 * ({cx,cy,rx,ry,color,label?}, no `shape` key at all) so the exporter.test.mjs golden-fixture
 * test (buildPlaybook reconstructed from playbook.example.json, an ellipse-only fixture) is
 * untouched. A 'polygon' zone entry is a NEW, additive entry shape ({shape:'polygon',
 * points,color,label?}) — this is a schema ADDITION, not a compatible narrowing: any existing
 * playbook.json consumer (the Claude-Design animator) that assumes every zones[] entry has
 * cx/cy/rx/ry will need its own shape-aware handling before it can render a polygon zone. Flag
 * this to whoever owns the animator handoff before the first real polygon-zone export.
 * @param {object} zone
 * @returns {object}
 */
function zoneEntry(zone) {
  if (zone.shape === 'polygon') {
    const entry = {
      shape: 'polygon',
      points: zone.points.map(([x, y]) => [roundCoord(x), roundCoord(y)]),
      color: zone.role,
    };
    if (zone.label) entry.label = zone.label;
    return entry;
  }

  const entry = {
    cx: roundCoord(zone.cx),
    cy: roundCoord(zone.cy),
    rx: roundCoord(zone.rx),
    ry: roundCoord(zone.ry),
    color: zone.role,
  };
  if (zone.label) entry.label = zone.label;
  return entry;
}

/** Build one playbook.json keyframe entry: cumulative units/routes/zones at `kf`. */
function buildKeyframeEntry(tactic, kfMeta) {
  const kf = kfMeta.n;
  const visible = cumulativeObjects(tactic, kf);
  return {
    keyframe: kf,
    label: kfMeta.name,
    t: kfMeta.t,
    note: tactic.notes?.[kf] ?? '',
    units: visible.filter((o) => o.kind === 'unit').map((m) => unitEntry(m, kf)),
    routes: visible.filter((o) => o.kind === 'route').map(routeEntry),
    zones: visible.filter((o) => o.kind === 'zone').map(zoneEntry),
  };
}

/**
 * Build the playbook.json motion spec for the doc's active tactic.
 * @param {{tactics:object[], activeTacticId:string}} doc
 * @param {object} roster unused here (icons manifest consumes it); accepted for API symmetry
 * @param {{name:string, assetSize:{w:number,h:number}}} mapMeta
 * @returns {object} matches SPEC-export-package.md playbook.json schema exactly
 */
export function buildPlaybook(doc, roster, mapMeta) {
  const tactic = doc.tactics.find((t) => t.id === doc.activeTacticId);
  return {
    tactic: tactic.name,
    map: mapMeta.name,
    map_file: `map/${mapFileNameFor(mapMeta)}`,
    map_size: { w: mapMeta.assetSize.w, h: mapMeta.assetSize.h },
    coordinate_space: 'percent 0-100 of map, origin top-left',
    linear: true,
    fps_suggested: 30,
    keyframes: tactic.keyframes.map((kfMeta) => buildKeyframeEntry(tactic, kfMeta)),
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
 * @param {{objects:object[]}} tactic
 * @param {object} roster {units,heroes,artillery,extra}
 * @returns {{note:string, icons:{code:string,name:string,class:string,rarity:string}[]}}
 */
export function buildIconsManifest(tactic, roster) {
  const seen = new Set();
  const icons = [];

  for (const obj of tactic.objects) {
    if (obj.kind !== 'unit' || seen.has(obj.code)) continue;
    seen.add(obj.code);
    const found = findRosterEntry(roster, obj.code);
    const name = found?.entry.name ?? obj.name;
    const rarityTier = found?.entry.rarity;
    icons.push({
      code: obj.code,
      name,
      class: found ? classFieldFor(found.entry, found.sectionKey) : '',
      rarity: RARITY_NAMES[rarityTier] ?? 'Uncommon',
    });
  }

  return {
    note: 'Placeholder tiles. Replace CODE.png with final art; keep filenames.',
    icons,
  };
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
    '- `playbook.json` — the motion spec: keyframes, cumulative unit/route/zone state, notes.',
    '  Coordinates are percent (0-100) of the map, origin top-left.',
    `- \`map/\` — base map render (${mapMeta.name}).`,
    '- `frames/` — composite renders: map + all annotations at each keyframe (900px wide).',
    '- `overlays/` — the same renders WITHOUT the map, transparent background, pixel-aligned 1:1',
    '  with frames/ and map/.',
    '- `icons/manifest.json` — unit icons this animation needs; `icons/<CODE>.png` are placeholder',
    '  tiles. Replace with final art, keep filenames.',
    '',
    `## Coordinates & timing`,
    '`x`,`y`,`cx`,`cy`,`rx`,`ry` and route points are percent of map width/height:',
    '`px = x/100 * imageWidth`. Each keyframe carries the complete visible state (cumulative) —',
    'diff consecutive keyframes to find what spawns or moves.',
    '',
    '## Animation intent',
    '1. Open on the base map; keyframe 1 spawns its units (staggered, drop-in scale, ~200ms).',
    '2. Between keyframes: tween unit positions ~500ms; reveal new routes/zones; hold each',
    '   keyframe roughly a second, paced by `t` and `note`.',
    '3. Show `label`, `t`, and `note` as a per-keyframe caption.',
    '4. Role colors group the players — keep them exact.',
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
 * Assemble the final zip entry list with SPEC-exact paths.
 * @param {{playbook:object, readme:string, mapPng:Uint8Array, frames:Uint8Array[],
 *   overlays:Uint8Array[], icons:object, iconPngs:Record<string,Uint8Array>, mapFileName:string}} input
 * @returns {{path:string, data:Uint8Array|string}[]}
 */
export function packageEntries({ playbook, readme, mapPng, frames, overlays, icons, iconPngs, mapFileName }) {
  const entries = [
    { path: 'README.md', data: readme },
    { path: 'playbook.json', data: JSON.stringify(playbook, null, 2) },
    { path: `map/${mapFileName}`, data: mapPng },
    ...frames.map((data, i) => ({ path: `frames/frame-${padIndex(i + 1)}.png`, data })),
    ...overlays.map((data, i) => ({ path: `overlays/overlay-${padIndex(i + 1)}.png`, data })),
    { path: 'icons/manifest.json', data: JSON.stringify(icons, null, 2) },
  ];

  for (const icon of icons.icons) {
    const png = iconPngs[icon.code];
    if (png) entries.push({ path: `icons/${icon.code}.png`, data: png });
  }

  return entries;
}
