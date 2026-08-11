// ui/exportmodal-helpers.mjs — DOM-string builders + asset/zip assembly for the export modal.
// Split out of exportmodal.mjs per the file-size budget (200-400 lines target); still
// [ui-export]-owned, no cross-panel imports. Functions here either build markup strings
// (pure) or fetch/encode bytes for the zip (impure but side-effect-free/idempotent).
import {
  buildPlaybook,
  buildIconsManifest,
  buildExportReadme,
  packageEntries,
  fetchTacticalBriefs,
  scopeTacticalBriefs,
} from '../core/exporter.mjs';
import { createZip } from '../core/zip.mjs';
import { renderFrame } from './render.mjs';

const PLACEHOLDER_TILE_PX = 128;
const RARITY_COLORS = {
  Legendary: '#e6b24c',
  Epic: '#b45ce6',
  Rare: '#4c9bef',
  Uncommon: '#46c46e',
};

export const MANIFEST_ROWS = [
  { icon: 'ph-file-text', label: 'playbook.json', detail: 'motion spec — keyframes, positions, notes' },
  { icon: 'ph-image', label: 'map/', detail: 'base map render' },
  { icon: 'ph-film-strip', label: 'frames/', detail: 'composite renders — map + annotations per keyframe' },
  { icon: 'ph-stack', label: 'overlays/', detail: 'same renders, transparent, pixel-aligned to frames/' },
  { icon: 'ph-note', label: 'README.md', detail: 'contents, coordinates, animation intent' },
  { icon: 'ph-list-checks', label: 'icons/manifest.json', detail: 'unit icons this animation needs' },
  { icon: 'ph-package', label: 'icons/*.png', detail: 'placeholder tiles — rebuild with final art' },
];

/** @param {string} str */
export function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

/** Document-relative asset path, matching ui/topbar.mjs's convention (page root = index.html). */
export function resolveAssetPath(assetPath) {
  return `./${assetPath}`;
}

/** Zero-pads a 1-based frame index to 2+ digits, matching core/exporter.mjs's padIndex. */
function padIndex(n) {
  return String(n).padStart(2, '0');
}

/** Filename-safe tactic name: spaces -> dashes, per contract §5 export flow. */
export function slugifyTacticName(name) {
  return name.trim().replace(/\s+/g, '-');
}

/**
 * Loads a map's asset as an <img>, resolving null on error (so a missing/placeholder map
 * degrades gracefully instead of throwing mid-export).
 * @param {string} assetPath
 * @returns {Promise<HTMLImageElement|null>}
 */
export function loadMapImage(assetPath) {
  return new Promise((resolve) => {
    if (!assetPath) {
      resolve(null);
      return;
    }
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = resolveAssetPath(assetPath);
  });
}

/**
 * Resolves the h/w aspect ratio to pass as renderFrame's `mapAspect` param from a map's
 * `assetSize` (data/maps.json), for the overlay render (mapImg=null) so it matches its paired
 * frame render on every map, not just Western City — see render.mjs's resolveFrameAspect for
 * the full priority order this feeds into. Returns undefined (not a number) when assetSize is
 * absent/malformed so resolveFrameAspect's own MAJORITY_MAP_ASPECT fallback still applies,
 * matching its documented `mapAspect?: number` contract.
 * @param {{assetSize?:{w:number,h:number}}} [mapMeta]
 * @returns {number|undefined}
 */
export function resolveMapAspect(mapMeta) {
  const w = mapMeta?.assetSize?.w;
  const h = mapMeta?.assetSize?.h;
  if (typeof w !== 'number' || typeof h !== 'number' || !(w > 0) || !(h > 0)) return undefined;
  return h / w;
}

/** Renders every keyframe's frame (map+annotations) and overlay (annotations only) canvas.
 * `mapMeta` (optional) supplies the active map's real aspect for the overlay render (which
 * always passes mapImg=null to renderFrame) via resolveMapAspect — bug-hunt fix: without it,
 * overlays/ silently defaulted to the hardcoded Western-City aspect on every other map. */
export async function renderAllFrames(doc, layers, tactic, mapImg, roster, mapMeta) {
  const mapAspect = resolveMapAspect(mapMeta);
  const frames = [];
  const overlays = [];
  for (const kfMeta of tactic.keyframes) {
    frames.push(await renderFrame(doc, layers, tactic, kfMeta.n, mapImg, roster, undefined, mapAspect));
    overlays.push(await renderFrame(doc, layers, tactic, kfMeta.n, null, roster, undefined, mapAspect));
  }
  return { frames, overlays };
}

/** @param {HTMLCanvasElement} canvas @returns {Promise<Uint8Array>} */
function canvasToPngBytes(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(async (blob) => {
      if (!blob) {
        reject(new Error('canvas.toBlob returned null'));
        return;
      }
      resolve(new Uint8Array(await blob.arrayBuffer()));
    }, 'image/png');
  });
}

/** @param {HTMLCanvasElement[]} canvases @returns {Promise<Uint8Array[]>} */
export function canvasesToPngBytes(canvases) {
  return Promise.all(canvases.map(canvasToPngBytes));
}

/**
 * Fetches a map/icon asset's raw bytes via fetch()->arrayBuffer (real file bytes, not a
 * re-render) — per brief: "fetch the map asset bytes via fetch->arrayBuffer" and "REAL icon
 * file bytes fetched from assets/units/<CODE>.png". Resolves null on any failure.
 * @param {string} assetPath
 * @returns {Promise<Uint8Array|null>}
 */
export async function fetchAssetBytes(assetPath) {
  try {
    const res = await fetch(resolveAssetPath(assetPath));
    if (!res.ok) return null;
    return new Uint8Array(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * Draws a 128px placeholder icon tile per SPEC-export-package.md: dark rounded square,
 * rarity-color border, centered mono unit code. Returns the canvas itself (callers derive
 * either PNG bytes for the zip or a data URL for the on-screen strip from the same draw).
 * @param {string} code
 * @param {string} rarityName one of RARITY_COLORS' keys
 * @returns {HTMLCanvasElement}
 */
export function drawPlaceholderIconTile(code, rarityName) {
  const size = PLACEHOLDER_TILE_PX;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const color = RARITY_COLORS[rarityName] ?? RARITY_COLORS.Uncommon;

  const r = 18;
  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.arcTo(size, 0, size, size, r);
  ctx.arcTo(size, size, 0, size, r);
  ctx.arcTo(0, size, 0, 0, r);
  ctx.arcTo(0, 0, size, 0, r);
  ctx.closePath();
  ctx.fillStyle = '#171b22';
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = color;
  ctx.stroke();

  ctx.fillStyle = '#eef1f6';
  ctx.font = `700 22px JetBrains Mono, ui-monospace, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(code, size / 2, size / 2 + 1);

  return canvas;
}

/**
 * Builds icons/<CODE>.png bytes for every manifest entry: real icon file bytes when the
 * roster entry has one, else a generated placeholder tile.
 * @param {{icons:{code:string,rarity:string}[]}} manifest
 * @param {object} roster
 * @returns {Promise<Record<string, Uint8Array>>}
 */
export async function buildIconPngs(manifest, roster) {
  const result = {};
  await Promise.all(
    manifest.icons.map(async (icon) => {
      const rosterEntry = findRosterEntry(roster, icon.code);
      const bytes = rosterEntry?.icon ? await fetchAssetBytes(rosterEntry.icon) : null;
      result[icon.code] = bytes ?? (await canvasToPngBytes(drawPlaceholderIconTile(icon.code, icon.rarity)));
    })
  );
  return result;
}

/**
 * Builds a display src (real icon asset path, or a data URL of the generated placeholder
 * tile) for every manifest entry — feeds the modal's "Icons to rebuild" strip.
 * @param {{icons:{code:string,rarity:string}[]}} manifest
 * @param {object} roster
 * @returns {Record<string,string>} code -> <img> src
 */
export function buildIconPreviewSrcs(manifest, roster) {
  const result = {};
  for (const icon of manifest.icons) {
    const rosterEntry = findRosterEntry(roster, icon.code);
    result[icon.code] = rosterEntry?.icon
      ? resolveAssetPath(rosterEntry.icon)
      : drawPlaceholderIconTile(icon.code, icon.rarity).toDataURL('image/png');
  }
  return result;
}

function findRosterEntry(roster, code) {
  for (const key of ['units', 'heroes', 'artillery', 'extra']) {
    const entry = (roster?.[key] ?? []).find((r) => r.code === code);
    if (entry) return entry;
  }
  return null;
}

/**
 * Assembles the full zip byte array for the current tactic/map/frames/overlays.
 *
 * `mapPngFailed` is true when fetchAssetBytes(mapMeta.asset) resolved null (network hiccup,
 * moved/renamed asset, non-ok response). The zip is still assembled in that case — the map
 * entry falls back to an empty Uint8Array so the rest of the package (playbook.json, frames,
 * overlays, icons) isn't lost — but callers MUST check this flag before treating the export as
 * successful. Bug this fixes: previously `mapPng ?? new Uint8Array()` shipped a silent 0-byte
 * map/<id>.png with no signal anywhere that the fetch failed (see exportmodal.mjs's
 * downloadZipPackage, which now aborts the download and shows an error instead of proceeding).
 *
 * tactical-briefs.json is fetched + scoped alongside the other assets and is purely additive:
 * fetchTacticalBriefs() already resolves null (never rejects) on any failure — network error,
 * non-2xx, malformed JSON — and scopeTacticalBriefs returns null on a null doc or when nothing
 * placed resolves to a brief. packageEntries omits the file entirely on a null/undefined
 * `tacticalBriefs` (no entry, never an empty one). Unlike the map asset, briefs have no
 * equivalent "failed" flag — there is no degraded artifact to warn about, just an honestly
 * absent optional file, so a failed/slow briefs fetch can never fail or stall the export itself.
 * @returns {Promise<{bytes:Uint8Array, playbook:object, fileName:string, mapPngFailed:boolean}>}
 */
export async function assembleExportZip({ doc, layers, tactic, mapMeta, roster, frames, overlays }) {
  const playbook = buildPlaybook(doc, roster, mapMeta);
  const manifest = buildIconsManifest(tactic, roster);
  const readme = buildExportReadme(tactic, mapMeta);

  const [framePngs, overlayPngs, mapPng, iconPngs, briefsDoc] = await Promise.all([
    canvasesToPngBytes(frames),
    canvasesToPngBytes(overlays),
    fetchAssetBytes(mapMeta.asset),
    buildIconPngs(manifest, roster),
    fetchTacticalBriefs(),
  ]);

  const mapPngFailed = mapPng === null;
  const tacticalBriefs = scopeTacticalBriefs(tactic, roster, briefsDoc);

  const entries = packageEntries({
    playbook,
    readme,
    mapPng: mapPng ?? new Uint8Array(),
    frames: framePngs,
    overlays: overlayPngs,
    icons: manifest,
    iconPngs,
    mapFileName: `${mapMeta.id}.png`,
    tacticalBriefs,
  });

  const bytes = createZip(entries);
  const fileName = `${slugifyTacticName(tactic.name)}-animation-package.zip`;
  return { bytes, playbook, fileName, mapPngFailed };
}

/** Renders one keyframe card: thumbnail w/ "KF n · name" pill, note (icon-prefixed or empty
 * placeholder), filename + PNG download button — matches the design prototype's frame card. */
export function renderKeyframeCard(kfMeta, frameCanvas, frameDataUrl, note) {
  const fileName = `frame-${padIndex(kfMeta.n)}.png`;
  const hasNote = Boolean(note?.trim());
  const noteBody = hasNote
    ? `<span class="xm-kf-note-row"><i class="ph-fill ph-note"></i><span>${escapeHtml(note)}</span></span>`
    : `<span class="xm-kf-note-empty">No note — add details in the designer.</span>`;

  return `
    <div class="xm-kf-card">
      <div class="xm-kf-thumb">
        <img src="${frameDataUrl}" alt="Keyframe ${kfMeta.n} render" width="${frameCanvas.width}" height="${frameCanvas.height}" />
        <span class="xm-kf-pill chip-mono">KF ${kfMeta.n} · ${escapeHtml(kfMeta.name)}</span>
      </div>
      <div class="xm-kf-note">${noteBody}</div>
      <div class="xm-kf-footer">
        <span class="xm-kf-filename chip-mono">${fileName}</span>
        <a class="xm-kf-download" href="${frameDataUrl}" download="${fileName}">
          <i class="ph ph-download-simple"></i>PNG
        </a>
      </div>
    </div>
  `;
}

/**
 * Renders the "ICONS TO REBUILD" strip: one 46px tile (real icon or placeholder preview) +
 * CODE.png label per manifest entry.
 * @param {{icons:{code:string}[]}} manifest
 * @param {Record<string,string>} previewSrcs from buildIconPreviewSrcs
 */
export function renderIconStrip(manifest, previewSrcs) {
  return manifest.icons
    .map(
      (icon) => `
        <div class="xm-icon-tile-wrap">
          <div class="xm-icon-tile">
            <img src="${previewSrcs[icon.code] ?? ''}" alt="${escapeHtml(icon.code)}" />
          </div>
          <span class="xm-icon-filename chip-mono">${escapeHtml(icon.code)}.png</span>
        </div>
      `
    )
    .join('');
}
