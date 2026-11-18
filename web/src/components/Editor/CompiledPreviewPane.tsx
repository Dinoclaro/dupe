import React, { useEffect, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { CompileProjectResponse, api } from '../../api/client';
import { CompileResponse } from '../../workers/latexCompiler';

if (typeof window !== 'undefined' && pdfjsLib.GlobalWorkerOptions) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.mjs',
    import.meta.url,
  ).toString();
}

interface CompiledPdfPageCanvasProps {
  pdfDoc: pdfjsLib.PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  onDoubleClickPoint: (pageNumber: number, xRatio: number, yRatio: number) => void;
}

const CompiledPdfPageCanvas: React.FC<CompiledPdfPageCanvasProps> = ({
  pdfDoc,
  pageNumber,
  scale,
  onDoubleClickPoint,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    let renderTask: pdfjsLib.RenderTask | null = null;

    const renderPage = async () => {
      try {
        const page = await pdfDoc.getPage(pageNumber);
        if (cancelled) {
          return;
        }
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const cssViewport = page.getViewport({ scale });
        const hiViewport = page.getViewport({ scale: scale * dpr });
        const canvas = canvasRef.current;
        if (!canvas) {
          return;
        }
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          return;
        }
        canvas.width = hiViewport.width;
        canvas.height = hiViewport.height;
        canvas.style.width = `${cssViewport.width}px`;
        canvas.style.height = `${cssViewport.height}px`;
        renderTask = page.render({ canvasContext: ctx, viewport: hiViewport });
        await renderTask.promise;
      } catch {
        // Ignore cancelled render
      }
    };

    void renderPage();
    return () => {
      cancelled = true;
      if (renderTask) {
        try {
          renderTask.cancel();
        } catch {
          // ignore
        }
      }
    };
  }, [pdfDoc, pageNumber, scale]);

  return (
    <div
      className="pdf-page-wrapper"
      title="Double-click anywhere on the page to jump to the corresponding LaTeX source line"
      onDoubleClick={(e) => {
        const canvas = canvasRef.current;
        if (!canvas) {
          return;
        }
        const rect = canvas.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
          return;
        }
        const xRatio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        const yRatio = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
        onDoubleClickPoint(pageNumber, xRatio, yRatio);
      }}
    >
      <div className="pdf-page-Badge">Page {pageNumber} · Double-click to jump to LaTeX</div>
      <canvas ref={canvasRef} className="pdf-canvas" style={{ cursor: 'pointer' }} />
    </div>
  );
};

interface CompiledPreviewPaneProps {
  projectId: string | null;
  compileResult: CompileProjectResponse | null;
  compiling: boolean;
  pdfVersion: number;
  compiled: CompileResponse;
  sourceLabel: string;
  onTriggerCompile: () => Promise<void>;
  onJumpToFile?: (relPath: string, line?: number) => void;
}

export const CompiledPreviewPane: React.FC<CompiledPreviewPaneProps> = ({
  projectId,
  compileResult,
  compiling,
  pdfVersion,
  compiled,
  sourceLabel,
  onTriggerCompile,
  onJumpToFile,
}) => {
  const [viewMode, setViewMode] = useState<'pdf' | 'logs' | 'draft'>('pdf');
  const [pdfRenderMode, setPdfRenderMode] = useState<'interactive' | 'native'>('interactive');
  const [zoom, setZoom] = useState(115);
  const [showRawLog, setShowRawLog] = useState(false);
  const [pdfDoc, setPdfDoc] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState<number>(0);
  const [syncTexStatus, setSyncTexStatus] = useState<string | null>(null);

  const errorCount = compileResult?.errors?.length ?? 0;
  const warningCount = compileResult?.warnings?.length ?? 0;
  const hasRealPdf = Boolean(projectId && compileResult?.pdf_available);

  // Automatically switch to the Overleaf-style Error Page when compilation fails with errors
  useEffect(() => {
    if (compileResult && (!compileResult.success || compileResult.errors.length > 0)) {
      setViewMode('logs');
    } else if (compileResult?.pdf_available && viewMode === 'logs' && errorCount === 0) {
      setViewMode('pdf');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compileResult]);

  const pdfUrl =
    projectId && compileResult
      ? api.compiledPdfUrl(projectId, compileResult.root_tex, pdfVersion)
      : '';

  useEffect(() => {
    if (!hasRealPdf || !pdfUrl || pdfRenderMode !== 'interactive') {
      return undefined;
    }
    let cancelled = false;
    const loadingTask = pdfjsLib.getDocument(pdfUrl);
    loadingTask.promise
      .then((doc) => {
        if (!cancelled) {
          setPdfDoc(doc);
          setNumPages(doc.numPages);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPdfRenderMode('native');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [hasRealPdf, pdfUrl, pdfRenderMode]);

  const handleSyncTexDoubleClick = async (
    pageNumber: number,
    xRatio: number,
    yRatio: number,
  ) => {
    if (!projectId || !onJumpToFile) {
      return;
    }
    try {
      setSyncTexStatus(`Locating source on page ${pageNumber}…`);
      const res = await api.resolveSyncTex(
        projectId,
        pageNumber,
        xRatio,
        yRatio,
        compileResult?.root_tex,
      );
      setSyncTexStatus(`→ ${res.path}:${res.line}`);
      onJumpToFile(res.path, res.line);
      window.setTimeout(() => setSyncTexStatus(null), 2200);
    } catch {
      setSyncTexStatus(null);
    }
  };

  return (
    <div className="compiled-preview-shell">
      <div className="reader-toolbar">
        <div className="reader-meta">
          <button
            type="button"
            className="btn-primary btn-tiny"
            disabled={compiling || !projectId}
            onClick={() => void onTriggerCompile()}
            title="Compile full LaTeX project with Tectonic (XeTeX + BibTeX)"
          >
            {compiling ? '↻ Compiling…' : '↻ Recompile'}
          </button>
          <code className="bibkey-badge">
            {compileResult?.root_tex || sourceLabel}
          </code>
          {compileResult && (
            <span className="muted-hint">
              {(compileResult.duration_ms / 1000).toFixed(1)}s
              {numPages > 0 ? ` · ${numPages}p` : ''}
            </span>
          )}
          {syncTexStatus && (
            <code className="bibkey-badge" style={{ color: '#86efac' }}>
              {syncTexStatus}
            </code>
          )}
        </div>

        <div className="reader-controls">
          <button
            type="button"
            className={`btn-tiny ${viewMode === 'pdf' ? 'active-btn' : ''}`}
            onClick={() => setViewMode('pdf')}
          >
            📄 PDF Output
          </button>

          <button
            type="button"
            className={`btn-tiny ${viewMode === 'logs' ? 'active-btn' : ''} ${
              errorCount > 0 ? 'log-btn-error' : warningCount > 0 ? 'log-btn-warn' : ''
            }`}
            onClick={() => setViewMode((m) => (m === 'logs' ? 'pdf' : 'logs'))}
            title="View LaTeX compiler errors, warnings, and raw output logs"
          >
            📋 Logs{' '}
            {errorCount > 0 && <span className="log-count-pill error">{errorCount} Err</span>}
            {warningCount > 0 && (
              <span className="log-count-pill warn">{warningCount} Warn</span>
            )}
            {errorCount === 0 && warningCount === 0 && compileResult && (
              <span className="log-count-pill ok">✓</span>
            )}
          </button>

          <button
            type="button"
            className={`btn-tiny ${viewMode === 'draft' ? 'active-btn' : ''}`}
            onClick={() => setViewMode('draft')}
            title="Fast offline HTML/KaTeX draft preview"
          >
            ⚡ Draft
          </button>

          {viewMode !== 'logs' && (
            <>
              <button
                type="button"
                className="btn-tiny"
                onClick={() => setZoom((z) => Math.max(60, z - 15))}
              >
                −
              </button>
              <span className="reader-page-indicator">{zoom}%</span>
              <button
                type="button"
                className="btn-tiny"
                onClick={() => setZoom((z) => Math.min(220, z + 15))}
              >
                +
              </button>
            </>
          )}

          {hasRealPdf && (
            <a
              href={pdfUrl}
              target="_blank"
              rel="noreferrer"
              className="btn-tiny"
              title="Open compiled PDF in a new browser tab"
            >
              ↗ PDF
            </a>
          )}
        </div>
      </div>

      {/* VIEW 1: Overleaf-Style Error & Warning Diagnostics Page */}
      {viewMode === 'logs' && (
        <div className="overleaf-logs-stage">
          <div className="overleaf-logs-header">
            <div>
              <strong>
                {errorCount > 0
                  ? `${errorCount} Compiler Error(s)`
                  : 'Compilation Succeeded'}
              </strong>
              <span className="muted-hint" style={{ marginLeft: 10 }}>
                {warningCount} Warning(s) · Root:{' '}
                <code>{compileResult?.root_tex || sourceLabel}</code>
              </span>
            </div>
            <button
              type="button"
              className="btn-tiny"
              onClick={() => setShowRawLog((v) => !v)}
            >
              {showRawLog ? 'Hide Raw TeX Log' : 'View Raw TeX Log'}
            </button>
          </div>

          {errorCount === 0 && warningCount === 0 && !showRawLog && (
            <div className="log-card log-card-ok">
              No LaTeX errors or warnings reported.
            </div>
          )}

          {compileResult?.errors?.map((errItem, idx) => {
            const relTarget = errItem.file.startsWith('paper/')
              ? errItem.file
              : `paper/${errItem.file}`;
            return (
              <div key={`err-${idx}`} className="log-card log-card-error">
                <div className="log-card-top">
                  <span className="log-level-badge error">ERROR</span>
                  <code>
                    {errItem.file || compileResult.root_tex}
                    {errItem.line ? ` : line ${errItem.line}` : ''}
                  </code>
                  {errItem.file && onJumpToFile && (
                    <button
                      type="button"
                      className="btn-tiny"
                      onClick={() => onJumpToFile(relTarget, errItem.line)}
                    >
                      Open {errItem.file}
                      {errItem.line ? `:${errItem.line}` : ''}
                    </button>
                  )}
                </div>
                <div className="log-card-msg">{errItem.message}</div>
              </div>
            );
          })}

          {compileResult?.warnings?.map((warnItem, idx) => {
            const relTarget = warnItem.file.startsWith('paper/')
              ? warnItem.file
              : `paper/${warnItem.file}`;
            return (
              <div key={`warn-${idx}`} className="log-card log-card-warn">
                <div className="log-card-top">
                  <span className="log-level-badge warn">WARNING</span>
                  <code>
                    {warnItem.file || compileResult.root_tex}
                    {warnItem.line ? ` : line ${warnItem.line}` : ''}
                  </code>
                  {warnItem.file &&
                    warnItem.file.endsWith('.tex') &&
                    onJumpToFile && (
                      <button
                        type="button"
                        className="btn-tiny"
                        onClick={() => onJumpToFile(relTarget, warnItem.line)}
                      >
                        Open {warnItem.file}
                        {warnItem.line ? `:${warnItem.line}` : ''}
                      </button>
                    )}
                </div>
                <div className="log-card-msg">{warnItem.message}</div>
              </div>
            );
          })}

          {(showRawLog || (!compileResult?.errors?.length && !compileResult?.warnings?.length)) &&
            compileResult?.raw_log && (
              <div className="raw-log-box">
                <div className="raw-log-title">Raw TeX / BibTeX Output</div>
                <pre className="md-pre">{compileResult.raw_log}</pre>
              </div>
            )}
        </div>
      )}

      {/* VIEW 2: Real Compiled PDF Viewer (Interactive SyncTeX Double-Click or Native PDF) */}
      {viewMode === 'pdf' && (
        hasRealPdf ? (
          pdfRenderMode === 'interactive' && pdfDoc ? (
            <div className="reader-canvas-stage">
              {Array.from({ length: numPages }, (_, i) => i + 1).map((pageNum) => (
                <CompiledPdfPageCanvas
                  key={`${pdfVersion}-page-${pageNum}`}
                  pdfDoc={pdfDoc}
                  pageNumber={pageNum}
                  scale={zoom / 100}
                  onDoubleClickPoint={(p, x, y) => void handleSyncTexDoubleClick(p, x, y)}
                />
              ))}
            </div>
          ) : (
            <div className="reader-native-stage">
              <iframe
                key={`${pdfUrl}-${zoom}`}
                title="Compiled Paper PDF"
                src={`${pdfUrl}#zoom=${zoom}`}
                className="reader-native-iframe"
              />
            </div>
          )
        ) : (
          <div className="compiled-page-stage">
            <div
              className="compiled-page-sheet"
              style={{
                transform: `scale(${zoom / 100})`,
                transformOrigin: 'top center',
              }}
              dangerouslySetInnerHTML={{ __html: compiled.html }}
            />
          </div>
        )
      )}

      {/* VIEW 3: Fast Offline Draft HTML Preview */}
      {viewMode === 'draft' && (
        <div className="compiled-page-stage">
          <div
            className="compiled-page-sheet"
            style={{
              transform: `scale(${zoom / 100})`,
              transformOrigin: 'top center',
            }}
            dangerouslySetInnerHTML={{ __html: compiled.html }}
          />
        </div>
      )}
    </div>
  );
};
