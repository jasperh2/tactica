// ui/exportmodal.mjs — TACTICA export "animation package" modal [ui-export]
// Handoff README §7 + SPEC-export-package.md (the .zip contract). Renders nothing until
// opened. Gathers -> renders frames/overlays per keyframe -> lets the user copy the motion
// JSON or download the full .zip via core/exporter.mjs + core/zip.mjs. DOM lives entirely
// inside #modal-root (the element passed to mount()); no cross-panel imports/DOM access.
import { buildIconsManifest, buildPlaybook } from '../core/exporter.mjs';
import {
  MANIFEST_ROWS,
  escapeHtml,
  resolveAssetPath,
  loadMapImage,
  renderAllFrames,
  assembleExportZip,
  renderKeyframeCard,
  renderIconStrip,
  buildIconPreviewSrcs,
} from './exportmodal-helpers.mjs';

const COPY_FEEDBACK_MS = 1400;

/**
 * @param {HTMLElement} el the #modal-root element
 * @param {{store:object, history:object, roster:object, maps:{worldSize:number, maps:object[]},
 *   exec:(action:object)=>void}} ctx
 * @returns {{open:Function}}
 */
export function mount(el, ctx) {
  /** @type {{isOpen:boolean, phase:'idle'|'gathering'|'ready'|'packaging',
   *   frameCanvases:HTMLCanvasElement[], frameDataUrls:string[], manifest:object|null,
   *   playbook:object|null, mapMeta:object|null, tactic:object|null,
   *   copyLabel:string, downloadLabel:string, downloadError:string|null}} */
  const local = {
    isOpen: false,
    phase: 'idle',
    frameCanvases: [],
    frameDataUrls: [],
    manifest: null,
    playbook: null,
    mapMeta: null,
    tactic: null,
    copyLabel: 'Copy motion JSON',
    downloadLabel: 'Download .zip package',
    // Set when assembleExportZip reports mapPngFailed — the download is aborted rather than
    // silently shipping a 0-byte map/<id>.png (bug hunt finding). Cleared on open() and on a
    // successful retry.
    downloadError: null,
  };

  el.addEventListener('click', onClick);
  document.addEventListener('keydown', onKeydown);

  return { open };

  // ---- open/close ---------------------------------------------------------

  async function open() {
    local.isOpen = true;
    local.phase = 'gathering';
    local.copyLabel = 'Copy motion JSON';
    local.downloadLabel = 'Download .zip package';
    local.downloadError = null;
    render();
    await gather();
  }

  function close() {
    local.isOpen = false;
    render();
  }

  /** Loads the map image, renders every keyframe's frame+overlay, builds the icons manifest. */
  async function gather() {
    const doc = ctx.store.getDoc();
    const tactic = doc.tactics.find((t) => t.id === doc.activeTacticId);
    const mapMeta = ctx.maps.maps.find((m) => m.id === doc.mapId);

    local.tactic = tactic;
    local.mapMeta = mapMeta;
    local.manifest = buildIconsManifest(tactic, ctx.roster);

    const mapImg = mapMeta?.available ? await loadMapImage(mapMeta.asset) : null;
    const { frames } = await renderAllFrames(doc, doc.layers, tactic, mapImg, ctx.roster, mapMeta);

    local.frameCanvases = frames;
    local.frameDataUrls = frames.map((c) => c.toDataURL('image/png'));
    local.phase = 'ready';
    render();
  }

  // ---- actions --------------------------------------------------------------

  async function copyMotionJson() {
    const doc = ctx.store.getDoc();
    const playbook = buildPlaybook(doc, ctx.roster, local.mapMeta);
    const json = JSON.stringify(playbook, null, 2);
    await navigator.clipboard.writeText(json);
    local.copyLabel = 'Copied JSON';
    render();
    setTimeout(() => {
      local.copyLabel = 'Copy motion JSON';
      render();
    }, COPY_FEEDBACK_MS);
  }

  async function downloadZipPackage() {
    local.phase = 'packaging';
    local.downloadLabel = 'Packaging…';
    local.downloadError = null;
    render();

    const doc = ctx.store.getDoc();
    const mapImg = local.mapMeta?.available ? await loadMapImage(local.mapMeta.asset) : null;
    const { overlays } = await renderAllFrames(doc, doc.layers, local.tactic, mapImg, ctx.roster, local.mapMeta);
    const { bytes, fileName, mapPngFailed } = await assembleExportZip({
      doc,
      layers: doc.layers,
      tactic: local.tactic,
      mapMeta: local.mapMeta,
      roster: ctx.roster,
      frames: local.frameCanvases,
      overlays,
    });

    if (mapPngFailed) {
      // Fail loudly: never ship a silent 0-byte map/<id>.png. Abort the download entirely so
      // the user isn't left with a broken zip and no explanation.
      local.phase = 'ready';
      local.downloadLabel = 'Download .zip package';
      local.downloadError = `Couldn't fetch the map image (${local.mapMeta?.name ?? 'map'}) — download cancelled so the .zip isn't shipped with a broken map file. Check your connection and try again.`;
      render();
      return;
    }

    triggerDownload(bytes, fileName);

    local.phase = 'ready';
    local.downloadLabel = 'Download .zip package';
    render();
  }

  function triggerDownload(bytes, fileName) {
    const blob = new Blob([bytes], { type: 'application/zip' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ---- events -----------------------------------------------------------

  function onClick(evt) {
    if (!local.isOpen) return;
    if (evt.target.closest('[data-action="close"]') || evt.target.classList.contains('xm-scrim')) {
      close();
      return;
    }
    if (evt.target.closest('[data-action="copy-json"]')) {
      copyMotionJson();
      return;
    }
    if (evt.target.closest('[data-action="download-zip"]')) {
      if (local.phase !== 'packaging') downloadZipPackage();
    }
  }

  function onKeydown(evt) {
    if (local.isOpen && evt.key === 'Escape') close();
  }

  // ---- rendering ------------------------------------------------------------

  function render() {
    if (!local.isOpen) {
      el.innerHTML = '';
      return;
    }
    el.innerHTML = renderModal();
  }

  function renderModal() {
    const tactic = local.tactic;
    const mapMeta = local.mapMeta;
    const kfCount = tactic?.keyframes.length ?? 0;
    const iconCount = local.manifest?.icons.length ?? 0;
    const isCopied = local.copyLabel === 'Copied JSON';
    const isZipping = local.phase === 'packaging';

    return `
      <div class="xm-scrim">
        <div class="xm-card" role="dialog" aria-modal="true" aria-label="Animation package export">
          <div class="xm-header">
            <div class="xm-header-tile"><i class="ph ph-film-strip"></i></div>
            <div class="xm-header-text">
              <h2 class="xm-title">Animation package — ${escapeHtml(tactic?.name ?? '')}</h2>
              <p class="xm-subtitle">${kfCount} keyframes · ${iconCount} icons · map, overlays &amp; notes · one .zip</p>
            </div>
            <button type="button" class="xm-close" data-action="close" aria-label="Close">
              <i class="ph ph-x"></i>
            </button>
          </div>

          <div class="xm-body">
            ${local.downloadError ? renderDownloadError() : ''}
            ${local.phase === 'gathering' ? renderGathering() : renderReady(tactic, mapMeta)}
          </div>

          <div class="xm-footer">
            <button type="button" class="xm-copy-btn" data-action="copy-json" ${local.phase === 'gathering' ? 'disabled' : ''}>
              ${isCopied
                ? '<i class="ph ph-check xm-copy-check"></i>'
                : '<i class="ph ph-brackets-curly"></i>'}
              <span>${escapeHtml(local.copyLabel)}</span>
            </button>
            <div class="xm-footer-note">Icons are placeholders — Claude Code rebuilds them from <b>icons/manifest.json</b>.</div>
            <button type="button" class="xm-download-btn" data-action="download-zip" ${local.phase === 'gathering' ? 'disabled' : ''}>
              ${isZipping
                ? '<i class="ph ph-circle-notch xm-spin"></i>'
                : '<i class="ph ph-file-zip"></i>'}
              <span>${escapeHtml(local.downloadLabel)}</span>
            </button>
          </div>
        </div>
      </div>
    `;
  }

  function renderGathering() {
    return `<div class="xm-loading"><i class="ph ph-circle-notch xm-spin"></i><span>Rendering keyframes…</span></div>`;
  }

  /** Visible failure banner for a cancelled download (map asset fetch failed) — never a silent
   * 0-byte map PNG. Shown above the manifest/preview columns until the user retries or closes. */
  function renderDownloadError() {
    return `
      <div class="xm-download-error" role="alert">
        <i class="ph-fill ph-warning-circle"></i>
        <span>${escapeHtml(local.downloadError)}</span>
      </div>
    `;
  }

  function renderReady(tactic, mapMeta) {
    const mapFileName = mapMeta ? `${mapMeta.id}.png` : '';
    return `
      <div class="xm-cols">
        <div class="xm-manifest">
          <div class="xm-panel-label">What's in the .zip</div>
          ${MANIFEST_ROWS.map(
            (row) => `
            <div class="xm-manifest-row">
              <i class="ph-fill ph-check-circle xm-manifest-check"></i>
              <i class="ph ${row.icon} xm-manifest-icon"></i>
              <div class="xm-manifest-text">
                <div class="xm-manifest-label">${escapeHtml(row.label)}</div>
                <div class="xm-manifest-detail">${escapeHtml(row.detail)}</div>
              </div>
            </div>`
          ).join('')}
        </div>
        <div class="xm-preview">
          <div class="xm-preview-frame">
            ${mapMeta?.available
              ? `<img src="${resolveAssetPath(mapMeta.asset)}" alt="${escapeHtml(mapMeta.name)}" />`
              : `<div class="xm-preview-empty"><i class="ph ph-image"></i><span>map art needed</span></div>`}
            <span class="xm-preview-filename chip-mono">map/${escapeHtml(mapFileName)}</span>
          </div>
          <div class="xm-claude-note">
            <i class="ph ph-sparkle"></i>
            <span>Hand the .zip to <b>Claude Code</b> — it rebuilds the unit icons from the manifest and animates the keyframes into a briefing.</span>
          </div>
        </div>
      </div>

      <div class="xm-section-label">Keyframes &amp; notes</div>
      <div class="xm-kf-grid">
        ${tactic.keyframes
          .map((kfMeta, i) =>
            renderKeyframeCard(kfMeta, local.frameCanvases[i], local.frameDataUrls[i], tactic.notes?.[kfMeta.n])
          )
          .join('')}
      </div>

      <div class="xm-section-label xm-icons-label">Icons to rebuild · ${local.manifest.icons.length}</div>
      <div class="xm-icon-strip">${renderIconStrip(local.manifest, buildIconPreviewSrcs(local.manifest, ctx.roster))}</div>
    `;
  }
}
