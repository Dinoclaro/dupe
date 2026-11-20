import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import * as vscode from 'vscode';

interface ActivePdfPanel {
  panel: vscode.WebviewPanel;
  loader: () => Promise<Uint8Array>;
  title: string;
}

export class DupePdfViewer {
  private readonly panels = new Map<string, ActivePdfPanel>();

  constructor(private readonly extensionUri: vscode.Uri) {}

  async openPdf(params: {
    key: string;
    title: string;
    loader: () => Promise<Uint8Array>;
    viewColumn?: vscode.ViewColumn;
    preserveFocus?: boolean;
  }): Promise<void> {
    const existing = this.panels.get(params.key);
    if (existing) {
      existing.loader = params.loader;
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
      title: params.title,
    };
    this.panels.set(params.key, record);

    panel.onDidDispose(() => {
      this.panels.delete(params.key);
    });

    panel.webview.onDidReceiveMessage(async (msg: { type?: string }) => {
      if (msg.type === 'ready' || msg.type === 'refresh') {
        await this.pushPdfBytes(record);
      } else if (msg.type === 'openExternal') {
        await this.openInSystemViewer(record);
      }
    });

    panel.webview.html = this.buildHtml(panel.webview, params.title);
  }

  async refreshIfOpen(key: string): Promise<void> {
    const existing = this.panels.get(key);
    if (!existing) {
      return;
    }
    await this.pushPdfBytes(existing);
  }

  private async pushPdfBytes(record: ActivePdfPanel): Promise<void> {
    try {
      const bytes = await record.loader();
      const base64 = Buffer.from(bytes).toString('base64');
      await record.panel.webview.postMessage({ type: 'loadPdf', base64 });
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
    }
    .page-wrap {
      background: #fff;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.45);
      line-height: 0;
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
    <button id="refresh" title="Reload PDF">Reload</button>
    <button id="open-ext" title="Open in External PDF Viewer">External Viewer</button>
  </div>
  <div id="viewer"><div class="message">Loading PDF...</div></div>

  <script type="module" nonce="${nonce}">
    import * as pdfjsLib from '${pdfJsUri}';

    const vscode = acquireVsCodeApi();
    const viewerEl = document.getElementById('viewer');
    const pageInfoEl = document.getElementById('page-info');
    const zoomLabelEl = document.getElementById('zoom-label');

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

    function decodeBase64(b64) {
      const bin = atob(b64);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) {
        out[i] = bin.charCodeAt(i);
      }
      return out;
    }

    async function renderAllPages() {
      if (!currentPdf) return;
      const token = ++renderToken;
      const dpr = window.devicePixelRatio || 1;
      zoomLabelEl.textContent = Math.round(currentScale * 100) + '%';
      pageInfoEl.textContent = currentPdf.numPages + ' page(s)';
      viewerEl.innerHTML = '';

      for (let num = 1; num <= currentPdf.numPages; num++) {
        if (token !== renderToken) return;
        const page = await currentPdf.getPage(num);
        if (token !== renderToken) return;

        const cssViewport = page.getViewport({ scale: currentScale });
        const renderViewport = page.getViewport({ scale: currentScale * dpr });

        const wrap = document.createElement('div');
        wrap.className = 'page-wrap';
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(renderViewport.width);
        canvas.height = Math.floor(renderViewport.height);
        canvas.style.width = Math.floor(cssViewport.width) + 'px';
        canvas.style.height = Math.floor(cssViewport.height) + 'px';
        wrap.appendChild(canvas);
        viewerEl.appendChild(wrap);

        const ctx = canvas.getContext('2d');
        await page.render({ canvasContext: ctx, viewport: renderViewport }).promise;
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

    document.getElementById('zoom-out').addEventListener('click', () => {
      currentScale = Math.max(0.5, +(currentScale - 0.15).toFixed(2));
      void renderAllPages();
    });
    document.getElementById('zoom-in').addEventListener('click', () => {
      currentScale = Math.min(3.5, +(currentScale + 0.15).toFixed(2));
      void renderAllPages();
    });
    document.getElementById('fit-width').addEventListener('click', () => void fitWidth());
    document.getElementById('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
    document.getElementById('open-ext').addEventListener('click', () => vscode.postMessage({ type: 'openExternal' }));

    window.addEventListener('message', async (event) => {
      const msg = event.data;
      if (msg.type === 'loadPdf') {
        try {
          await ensureWorker();
          const data = decodeBase64(msg.base64);
          const task = pdfjsLib.getDocument({ data });
          currentPdf = await task.promise;
          await renderAllPages();
        } catch (err) {
          viewerEl.innerHTML = '<div class="message error">Failed to render PDF: ' + (err?.message || err) + '</div>';
          pageInfoEl.textContent = 'Render failed';
        }
      } else if (msg.type === 'error') {
        viewerEl.innerHTML = '<div class="message error">' + msg.message + '</div>';
        pageInfoEl.textContent = 'Error';
      }
    });

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}
