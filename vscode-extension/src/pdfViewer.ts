import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import { BibMetadata } from './types';

export interface PdfViewerCallbacks {
  onSyncTexReverse?: (params: {
    page: number;
    xRatio: number;
    yRatio: number;
    widthPt: number;
    heightPt: number;
  }) => Promise<void>;
  onOpenPaperByKey?: (bibtexKey: string) => Promise<void>;
  onQuoteToNote?: (quote: string, bibtexKey?: string) => Promise<void>;
}

interface ActivePdfPanel {
  panel: vscode.WebviewPanel;
  loader: () => Promise<Uint8Array>;
  getBibMap: () => Record<string, BibMetadata>;
  callbacks: PdfViewerCallbacks;
  title: string;
  paperBibtexKey?: string;
}

export class DupePdfViewer {
  private readonly panels = new Map<string, ActivePdfPanel>();

  constructor(private readonly extensionUri: vscode.Uri) {}

  async openPdf(params: {
    key: string;
    title: string;
    loader: () => Promise<Uint8Array>;
    getBibMap: () => Record<string, BibMetadata>;
    callbacks?: PdfViewerCallbacks;
    paperBibtexKey?: string;
    viewColumn?: vscode.ViewColumn;
    preserveFocus?: boolean;
  }): Promise<void> {
    const existing = this.panels.get(params.key);
    if (existing) {
      existing.loader = params.loader;
      existing.getBibMap = params.getBibMap;
      existing.callbacks = params.callbacks || existing.callbacks;
      existing.paperBibtexKey = params.paperBibtexKey ?? existing.paperBibtexKey;
      existing.panel.title = params.title;
      existing.panel.reveal(params.viewColumn ?? existing.panel.viewColumn, params.preserveFocus);
      await this.pushPdfBytes(existing);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'dupe.pdfViewer',
      params.title,
      {
        viewColumn: params.viewColumn ?? vscode.ViewColumn.Beside,
        preserveFocus: params.preserveFocus ?? false,
      },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
      },
    );

    const record: ActivePdfPanel = {
      panel,
      loader: params.loader,
      getBibMap: params.getBibMap,
      callbacks: params.callbacks || {},
      title: params.title,
      paperBibtexKey: params.paperBibtexKey,
    };
    this.panels.set(params.key, record);

    panel.onDidDispose(() => {
      this.panels.delete(params.key);
    });

    panel.webview.onDidReceiveMessage(
      async (msg: {
        type?: string;
        page?: number;
        xRatio?: number;
        yRatio?: number;
        widthPt?: number;
        heightPt?: number;
        bibtexKey?: string;
        quote?: string;
      }) => {
        if (msg.type === 'ready' || msg.type === 'refresh') {
          await this.pushPdfBytes(record);
        } else if (msg.type === 'openExternal') {
          await this.openInSystemViewer(record);
        } else if (
          msg.type === 'synctexReverse' &&
          record.callbacks.onSyncTexReverse &&
          msg.page &&
          msg.xRatio !== undefined &&
          msg.yRatio !== undefined
        ) {
          await record.callbacks.onSyncTexReverse({
            page: msg.page,
            xRatio: msg.xRatio,
            yRatio: msg.yRatio,
            widthPt: msg.widthPt || 612,
            heightPt: msg.heightPt || 792,
          });
        } else if (msg.type === 'openPaperByKey' && msg.bibtexKey && record.callbacks.onOpenPaperByKey) {
          await record.callbacks.onOpenPaperByKey(msg.bibtexKey);
        } else if (msg.type === 'quoteToNote' && msg.quote && record.callbacks.onQuoteToNote) {
          await record.callbacks.onQuoteToNote(msg.quote, record.paperBibtexKey);
        }
      },
    );

    panel.webview.html = this.buildHtml(panel.webview, params.title);
  }

  async jumpToSyncTex(
    key: string,
    coords: { page: number; x: number; y: number },
  ): Promise<boolean> {
    const existing = this.panels.get(key);
    if (!existing) {
      return false;
    }
    existing.panel.reveal(existing.panel.viewColumn, true);
    await existing.panel.webview.postMessage({ type: 'synctexJump', ...coords });
    return true;
  }

  private async pushPdfBytes(record: ActivePdfPanel): Promise<void> {
    try {
      const bytes = await record.loader();
      const base64 = Buffer.from(bytes).toString('base64');
      await record.panel.webview.postMessage({
        type: 'loadPdf',
        base64,
        bibMap: record.getBibMap(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await record.panel.webview.postMessage({ type: 'error', message });
    }
  }

  private async openInSystemViewer(record: ActivePdfPanel): Promise<void> {
    try {
      const bytes = await record.loader();
      const safeName = record.title.replace(/[^a-zA-Z0-9._-]+/g, '_');
      const tmpPath = path.join(os.tmpdir(), `dupe-${safeName}.pdf`);
      await fs.writeFile(tmpPath, bytes);
      await vscode.env.openExternal(vscode.Uri.file(tmpPath));
    } catch (err) {
      void vscode.window.showErrorMessage(
        `Failed to open PDF externally: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private buildHtml(webview: vscode.Webview, title: string): string {
    const nonce = crypto.randomBytes(16).toString('hex');
    const pdfJsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'pdfjs', 'pdf.min.mjs'),
    );
    const pdfWorkerUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'pdfjs', 'pdf.worker.min.mjs'),
    );

    const escapedTitle = title
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data: blob:; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'nonce-${nonce}'; worker-src blob:; connect-src ${webview.cspSource} blob:;" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapedTitle}</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 0;
      font-family: var(--vscode-font-family, sans-serif);
      background: var(--vscode-editor-background, #1e1e1e);
      color: var(--vscode-editor-foreground, #d4d4d4);
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
    }
    .toolbar {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 12px;
      background: var(--vscode-editorGroupHeader-tabsBackground, #252526);
      border-bottom: 1px solid var(--vscode-panel-border, #333);
      font-size: 12px;
      flex-shrink: 0;
    }
    .toolbar button {
      background: var(--vscode-button-secondaryBackground, #3a3d41);
      color: var(--vscode-button-secondaryForeground, #fff);
      border: 1px solid transparent;
      border-radius: 3px;
      padding: 3px 8px;
      cursor: pointer;
      font-size: 12px;
    }
    .toolbar button:hover {
      background: var(--vscode-button-secondaryHoverBackground, #45494e);
    }
    .toolbar button.primary {
      background: var(--vscode-button-background, #0e639c);
      color: var(--vscode-button-foreground, #fff);
    }
    .spacer { flex: 1; }
    .status { opacity: 0.85; }
    #viewer {
      flex: 1;
      overflow-y: auto;
      padding: 16px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 14px;
      position: relative;
    }
    .page-wrap {
      background: #fff;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.45);
      line-height: 0;
      position: relative;
      user-select: text;
    }
    .page-wrap canvas {
      display: block;
    }
    /* pdfjs v4 TextLayer alignment */
    .textLayer {
      position: absolute;
      text-align: initial;
      inset: 0;
      overflow: clip;
      opacity: 1;
      line-height: 1;
      text-size-adjust: none;
      forced-color-adjust: none;
      transform-origin: 0 0;
      z-index: 1;
    }
    .textLayer :is(span, br) {
      color: transparent;
      position: absolute;
      white-space: pre;
      cursor: text;
      transform-origin: 0% 0%;
    }
    .textLayer ::selection {
      background: rgba(56, 139, 253, 0.35);
    }
    .annot-layer {
      position: absolute;
      inset: 0;
      pointer-events: none;
      z-index: 2;
    }
    .annot-link {
      position: absolute;
      pointer-events: auto;
      cursor: pointer;
      border-radius: 2px;
      transition: background 0.12s ease;
    }
    .annot-link:hover {
      background: rgba(56, 139, 253, 0.18);
      outline: 1px solid rgba(56, 139, 253, 0.55);
    }
    .synctex-pulse {
      position: absolute;
      width: 24px;
      height: 24px;
      margin-left: -12px;
      margin-top: -12px;
      border-radius: 50%;
      background: rgba(14, 165, 233, 0.32);
      border: 2px solid #38bdf8;
      pointer-events: none;
      z-index: 4;
      animation: pulseFade 1.8s ease-out forwards;
    }
    @keyframes pulseFade {
      0% { transform: scale(0.7); opacity: 1; }
      70% { transform: scale(1.4); opacity: 0.75; }
      100% { transform: scale(1.9); opacity: 0; }
    }
    #hover-card {
      position: fixed;
      z-index: 50;
      max-width: 440px;
      background: var(--vscode-editorHoverWidget-background, #252526);
      color: var(--vscode-editorHoverWidget-foreground, #cccccc);
      border: 1px solid var(--vscode-editorHoverWidget-border, #454545);
      border-radius: 6px;
      padding: 10px 12px;
      font-size: 12px;
      line-height: 1.45;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.55);
      display: none;
    }
    #hover-card .hc-title {
      font-weight: 600;
      color: #fff;
      margin-bottom: 4px;
    }
    #hover-card .hc-meta {
      opacity: 0.85;
      margin-bottom: 6px;
    }
    #hover-card .hc-key {
      font-family: monospace;
      font-size: 11px;
      background: rgba(255, 255, 255, 0.08);
      padding: 1px 5px;
      border-radius: 3px;
    }
    #hover-card .hc-actions {
      margin-top: 8px;
      display: flex;
      gap: 6px;
    }
    #hover-card button {
      background: var(--vscode-button-background, #0e639c);
      color: var(--vscode-button-foreground, #fff);
      border: none;
      border-radius: 3px;
      padding: 3px 8px;
      cursor: pointer;
      font-size: 11px;
    }
    .message {
      padding: 24px;
      opacity: 0.85;
      font-size: 13px;
      max-width: 600px;
      text-align: center;
    }
    .message.error { color: var(--vscode-errorForeground, #f48771); }
  </style>
</head>
<body>
  <div class="toolbar">
    <button id="zoom-out" title="Zoom Out">-</button>
    <span id="zoom-label">125%</span>
    <button id="zoom-in" title="Zoom In">+</button>
    <button id="fit-width" title="Fit Width">Fit Width</button>
    <span class="status" id="page-info">Loading PDF...</span>
    <div class="spacer"></div>
    <button id="quote-btn" class="primary" style="display:none" title="Send selected text to today's note">Quote to Note</button>
    <button id="refresh" title="Reload PDF">Reload</button>
    <button id="open-ext" title="Open in External PDF Viewer">External</button>
  </div>
  <div id="viewer"><div class="message">Loading PDF...</div></div>
  <div id="hover-card"></div>

  <script type="module" nonce="${nonce}">
    import * as pdfjsLib from '${pdfJsUri}';

    const vscode = acquireVsCodeApi();
    const viewerEl = document.getElementById('viewer');
    const pageInfoEl = document.getElementById('page-info');
    const zoomLabelEl = document.getElementById('zoom-label');
    const hoverCardEl = document.getElementById('hover-card');
    const quoteBtnEl = document.getElementById('quote-btn');

    let workerBlobUrl = null;
    async function ensureWorker() {
      if (!workerBlobUrl) {
        const resp = await fetch('${pdfWorkerUri}');
        const blob = await resp.blob();
        workerBlobUrl = URL.createObjectURL(blob);
        pdfjsLib.GlobalWorkerOptions.workerSrc = workerBlobUrl;
      }
    }

    let currentPdf = null;
    let currentScale = 1.25;
    let renderToken = 0;
    let bibMap = {};
    let bibList = [];
    const pageContainers = new Map();
    let hideCardTimer = null;

    function decodeBase64(b64) {
      const bin = atob(b64);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) {
        out[i] = bin.charCodeAt(i);
      }
      return out;
    }

    function escapeHtml(s) {
      return String(s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    }

    function scheduleHideCard() {
      clearTimeout(hideCardTimer);
      hideCardTimer = setTimeout(() => {
        hoverCardEl.style.display = 'none';
      }, 220);
    }

    hoverCardEl.addEventListener('mouseenter', () => clearTimeout(hideCardTimer));
    hoverCardEl.addEventListener('mouseleave', scheduleHideCard);

    function showHoverCard(anchorRect, info) {
      clearTimeout(hideCardTimer);
      let html = '';
      if (info.meta) {
        const m = info.meta;
        const yr = m.year ? ' (' + escapeHtml(m.year) + ')' : '';
        html += '<div class="hc-title">' + escapeHtml(m.title) + '</div>';
        if (m.authors) {
          html += '<div class="hc-meta">' + escapeHtml(m.authors) + yr + '</div>';
        }
        html += '<span class="hc-key">' + escapeHtml(m.key) + '</span>';
        if (m.paperId) {
          html += '<div class="hc-actions"><button id="hc-open-pdf">Open Cited PDF</button></div>';
        }
      } else if (info.snippet) {
        html += '<div class="hc-title">' + escapeHtml(info.label || 'Reference Preview') + '</div>';
        html += '<div class="hc-meta">' + escapeHtml(info.snippet) + '</div>';
      } else {
        return;
      }
      hoverCardEl.innerHTML = html;
      const top = Math.min(window.innerHeight - 150, anchorRect.bottom + 6);
      const left = Math.min(window.innerWidth - 460, Math.max(8, anchorRect.left));
      hoverCardEl.style.top = Math.max(42, top) + 'px';
      hoverCardEl.style.left = left + 'px';
      hoverCardEl.style.display = 'block';

      const btn = document.getElementById('hc-open-pdf');
      if (btn && info.meta?.key) {
        btn.addEventListener('click', () => {
          vscode.postMessage({ type: 'openPaperByKey', bibtexKey: info.meta.key });
          hoverCardEl.style.display = 'none';
        });
      }
    }

    function findBibEntryByKey(rawKey) {
      if (!rawKey) return null;
      if (bibMap[rawKey]) return bibMap[rawKey];
      const lower = rawKey.toLowerCase();
      return bibList.find((b) => b.key.toLowerCase() === lower) || null;
    }

    function matchBibBySnippet(snippet) {
      const clean = snippet.toLowerCase();
      for (const entry of bibList) {
        const titleWords = (entry.title || '')
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .filter((w) => w.length >= 5)
          .slice(0, 4);
        if (titleWords.length >= 2 && titleWords.every((w) => clean.includes(w))) {
          return entry;
        }
      }
      return null;
    }

    async function resolveLinkInfo(annot) {
      if (!currentPdf) return null;
      if (annot.url) {
        return { label: 'External Link', snippet: annot.url };
      }
      if (typeof annot.dest === 'string' && annot.dest.startsWith('cite.')) {
        const key = annot.dest.slice(5);
        const meta = findBibEntryByKey(key);
        if (meta) return { meta, targetPage: null };
      }
      let destArray = Array.isArray(annot.dest) ? annot.dest : null;
      if (!destArray && typeof annot.dest === 'string') {
        try {
          destArray = await currentPdf.getDestination(annot.dest);
        } catch {
          destArray = null;
        }
      }
      if (!destArray || !destArray[0]) return null;
      try {
        const pageIndex = await currentPdf.getPageIndex(destArray[0]);
        const targetPageNum = pageIndex + 1;
        const targetPage = await currentPdf.getPage(targetPageNum);
        const textContent = await targetPage.getTextContent();
        const destX = typeof destArray[2] === 'number' ? destArray[2] : null;
        const destY = typeof destArray[3] === 'number' ? destArray[3] : null;
        const items = textContent.items || [];
        let snippetItems = items;
        if (destY !== null) {
          snippetItems = items.filter((it) => {
            const ty = it.transform?.[5];
            const tx = it.transform?.[4];
            if (typeof ty !== 'number') return false;
            const yOk = ty <= destY + 14 && ty >= destY - 70;
            const xOk = destX === null || Math.abs(tx - destX) < 260;
            return yOk && xOk;
          });
        }
        const snippet = snippetItems.map((it) => it.str).join(' ').replace(/\s+/g, ' ').trim().slice(0, 260);
        const matchedMeta = snippet ? matchBibBySnippet(snippet) : null;
        return {
          meta: matchedMeta,
          label: typeof annot.dest === 'string' ? annot.dest : 'Page ' + targetPageNum,
          snippet: snippet || ('Jump to page ' + targetPageNum),
          targetPage: targetPageNum,
          destY,
        };
      } catch {
        return null;
      }
    }

    async function renderAllPages(preserveScroll = false) {
      if (!currentPdf) return;
      const prevScrollTop = viewerEl.scrollTop;
      const token = ++renderToken;
      const dpr = Math.max(window.devicePixelRatio || 1, 1.5);
      zoomLabelEl.textContent = Math.round(currentScale * 100) + '%';
      pageInfoEl.textContent = currentPdf.numPages + ' page(s) · double-click to jump to source';
      viewerEl.innerHTML = '';
      pageContainers.clear();

      for (let num = 1; num <= currentPdf.numPages; num++) {
        if (token !== renderToken) return;
        const page = await currentPdf.getPage(num);
        if (token !== renderToken) return;

        const unitViewport = page.getViewport({ scale: 1 });
        const cssViewport = page.getViewport({ scale: currentScale });
        const renderViewport = page.getViewport({ scale: currentScale * dpr });

        const wrap = document.createElement('div');
        wrap.className = 'page-wrap';
        wrap.style.width = Math.floor(cssViewport.width) + 'px';
        wrap.style.height = Math.floor(cssViewport.height) + 'px';

        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(renderViewport.width);
        canvas.height = Math.floor(renderViewport.height);
        canvas.style.width = Math.floor(cssViewport.width) + 'px';
        canvas.style.height = Math.floor(cssViewport.height) + 'px';
        wrap.appendChild(canvas);

        const textDiv = document.createElement('div');
        textDiv.className = 'textLayer';
        textDiv.style.setProperty('--scale-factor', String(currentScale));
        wrap.appendChild(textDiv);

        const annotLayer = document.createElement('div');
        annotLayer.className = 'annot-layer';
        wrap.appendChild(annotLayer);

        wrap.addEventListener('dblclick', (ev) => {
          const rect = wrap.getBoundingClientRect();
          const xRatio = Math.max(0, Math.min(1, (ev.clientX - rect.left) / Math.max(1, rect.width)));
          const yRatio = Math.max(0, Math.min(1, (ev.clientY - rect.top) / Math.max(1, rect.height)));
          vscode.postMessage({
            type: 'synctexReverse',
            page: num,
            xRatio,
            yRatio,
            widthPt: unitViewport.width,
            heightPt: unitViewport.height,
          });
        });

        viewerEl.appendChild(wrap);
        pageContainers.set(num, wrap);

        const ctx = canvas.getContext('2d');
        await page.render({ canvasContext: ctx, viewport: renderViewport }).promise;
        if (token !== renderToken) return;

        try {
          const textLayer = new pdfjsLib.TextLayer({
            textContentSource: page.streamTextContent(),
            container: textDiv,
            viewport: cssViewport,
          });
          await textLayer.render();
        } catch {
          // keep canvas readable even if text layer fails
        }

        try {
          const annotations = await page.getAnnotations();
          for (const annot of annotations) {
            if (annot.subtype !== 'Link' || !annot.rect) continue;
            const [vx1, vy1, vx2, vy2] = cssViewport.convertToViewportRectangle(annot.rect);
            const left = Math.min(vx1, vx2);
            const top = Math.min(vy1, vy2);
            const width = Math.abs(vx2 - vx1);
            const height = Math.abs(vy2 - vy1);
            if (width < 2 || height < 2) continue;

            const box = document.createElement('div');
            box.className = 'annot-link';
            box.style.left = left + 'px';
            box.style.top = top + 'px';
            box.style.width = width + 'px';
            box.style.height = height + 'px';

            let cachedInfo = undefined;
            box.addEventListener('mouseenter', async () => {
              if (cachedInfo === undefined) {
                cachedInfo = await resolveLinkInfo(annot);
              }
              if (cachedInfo) {
                showHoverCard(box.getBoundingClientRect(), cachedInfo);
              }
            });
            box.addEventListener('mouseleave', scheduleHideCard);
            box.addEventListener('click', async () => {
              if (cachedInfo === undefined) {
                cachedInfo = await resolveLinkInfo(annot);
              }
              if (cachedInfo?.targetPage) {
                const targetEl = pageContainers.get(cachedInfo.targetPage);
                targetEl?.scrollIntoView({ behavior: 'smooth', block: 'start' });
              }
            });
            annotLayer.appendChild(box);
          }
        } catch {
          // ignore annotation parsing errors
        }
      }

      if (preserveScroll) {
        viewerEl.scrollTop = prevScrollTop;
      }
    }

    async function fitWidth() {
      if (!currentPdf) return;
      const page = await currentPdf.getPage(1);
      const baseViewport = page.getViewport({ scale: 1 });
      const available = Math.max(320, viewerEl.clientWidth - 40);
      currentScale = Math.max(0.5, Math.min(3.0, available / baseViewport.width));
      await renderAllPages();
    }

    document.addEventListener('selectionchange', () => {
      const sel = window.getSelection()?.toString().trim() || '';
      quoteBtnEl.style.display = sel.length > 0 ? 'inline-block' : 'none';
    });

    quoteBtnEl.addEventListener('click', () => {
      const sel = window.getSelection()?.toString().replace(/\s+/g, ' ').trim() || '';
      if (sel) {
        vscode.postMessage({ type: 'quoteToNote', quote: sel });
        window.getSelection()?.removeAllRanges();
        quoteBtnEl.style.display = 'none';
      }
    });

    document.getElementById('zoom-out').addEventListener('click', () => {
      currentScale = Math.max(0.5, +(currentScale - 0.15).toFixed(2));
      void renderAllPages(true);
    });
    document.getElementById('zoom-in').addEventListener('click', () => {
      currentScale = Math.min(3.5, +(currentScale + 0.15).toFixed(2));
      void renderAllPages(true);
    });
    document.getElementById('fit-width').addEventListener('click', () => void fitWidth());
    document.getElementById('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
    document.getElementById('open-ext').addEventListener('click', () => vscode.postMessage({ type: 'openExternal' }));

    window.addEventListener('message', async (event) => {
      const msg = event.data;
      if (msg.type === 'loadPdf') {
        try {
          await ensureWorker();
          const hadDoc = Boolean(currentPdf);
          bibMap = msg.bibMap || {};
          bibList = Object.values(bibMap);
          const data = decodeBase64(msg.base64);
          const task = pdfjsLib.getDocument({ data });
          currentPdf = await task.promise;
          await renderAllPages(hadDoc);
        } catch (err) {
          viewerEl.innerHTML = '<div class="message error">Failed to render PDF: ' + (err?.message || err) + '</div>';
          pageInfoEl.textContent = 'Render failed';
        }
      } else if (msg.type === 'synctexJump') {
        const wrap = pageContainers.get(msg.page);
        if (wrap) {
          wrap.scrollIntoView({ behavior: 'smooth', block: 'center' });
          const pulse = document.createElement('div');
          pulse.className = 'synctex-pulse';
          pulse.style.left = (msg.x * 100) + '%';
          pulse.style.top = (msg.y * 100) + '%';
          wrap.appendChild(pulse);
          setTimeout(() => pulse.remove(), 1900);
        }
      } else if (msg.type === 'error') {
        viewerEl.innerHTML = '<div class="message error">' + escapeHtml(msg.message) + '</div>';
        pageInfoEl.textContent = 'Error';
      }
    });

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}
