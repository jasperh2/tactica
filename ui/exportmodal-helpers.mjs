// ui/exportmodal-helpers.mjs — DOM-string builders + asset/zip assembly for the export modal.
// Split out of exportmodal.mjs per the file-size budget (200-400 lines target); still
// [ui-export]-owned, no cross-panel imports. Functions here either build markup strings
// (pure) or fetch/encode bytes for the zip (impure but side-effect-free/idempotent).
import { buildPlaybook, buildIconsManifest, buildExportReadme, packageEntries } from '../core/exporter.mjs';
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

/** Renders every keyframe's frame (map+annotations) and overlay (annotations only) canvas. */
export async function renderAllFrames(doc, layers, tactic, mapImg, roster) {
  const frames = [];
  const overlays = [];
  for (const kfMeta of tactic.keyframes) {
    frames.push(await renderFrame(doc, layers, tactic, kfMeta.n, mapImg, roster));
    overlays.push(await renderFrame(doc, layers, tactic, kfMeta.n, null, roster));
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
 * @returns {Promise<{bytes:Uint8Array, playbook:object, fileName:string}>}
 */
export async function assembleExportZip({ doc, layers, tactic, mapMeta, roster, frames, overlays }) {
  const playbook = buildPlaybook(doc, roster, mapMeta);
  const manifest = buildIconsManifest(tactic, roster);
  const readme = buildExportReadme(tactic, mapMeta);

  const [framePngs, overlayPngs, mapPng, iconPngs] = await Promise.all([
    canvasesToPngBytes(frames),
    canvasesToPngBytes(overlays),
    fetchAssetBytes(mapMeta.asset),
    buildIconPngs(manifest, roster),
  ]);

  const entries = packageEntries({
    playbook,
    readme,
    mapPng: mapPng ?? new Uint8Array(),
    frames: framePngs,
    overlays: overlayPngs,
    icons: manifest,
    iconPngs,
    mapFileName: `${mapMeta.id}.png`,
  });

  const bytes = createZip(entries);
  const fileName = `${slugifyTacticName(tactic.name)}-animation-package.zip`;
  return { bytes, playbook, fileName };
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
