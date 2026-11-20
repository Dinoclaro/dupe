import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { CompileProjectResponse, LatexDiagnostic, api } from '../../api/client';
import { CompileResponse } from '../../workers/latexCompiler';
import { normalizeDiagnosticRelPath } from './latexDiagnostics';

if (typeof window !== 'undefined' && pdfjsLib.GlobalWorkerOptions) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.mjs',
    import.meta.url,
  ).toString();
}

const pdfBytesCache = new Map<string, Uint8Array>();
const previewScrollCache = new Map<string, number>();

function storeCachedPdfBytes(cacheKey: string, bytes: Uint8Array): void {
  if (pdfBytesCache.has(cacheKey)) {
    pdfBytesCache.delete(cacheKey);
  }
  pdfBytesCache.set(cacheKey, bytes);
  if (pdfBytesCache.size > 4) {
    const oldestKey = pdfBytesCache.keys().next().value;
    if (oldestKey) {
      pdfBytesCache.delete(oldestKey);
    }
  }
}

interface CompiledPdfPageCanvasProps {
  pdfDoc: pdfjsLib.PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  fallbackSizePt: { width: number; height: number };
  highlightPoint: { x: number; y: number } | null;
  registerPageRef: (pageNum: number, el: HTMLDivElement | null) => void;
  onPageMeasured: (widthPt: number, heightPt: number) => void;
  onDoubleClickPoint: (
    pageNumber: number,
    xRatio: number,
    yRatio: number,
    widthPt: number,
    heightPt: number,
  ) => void;
}

const CompiledPdfPageCanvas: React.FC<CompiledPdfPageCanvasProps> = ({
  pdfDoc,
  pageNumber,
  scale,
  fallbackSizePt,
  highlightPoint,
  registerPageRef,
  onPageMeasured,
  onDoubleClickPoint,
}) => {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [isVisible, setIsVisible] = useState(pageNumber <= 2);
  const [pageSizePt, setPageSizePt] = useState<{ width: number; height: number }>(fallbackSizePt);

  useEffect(() => {
    const el = wrapperRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setIsVisible(true);
      return undefined;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setIsVisible(true);
          }
        }
      },
      { rootMargin: '500px 0px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!isVisible) {
      return undefined;
    }
    let cancelled = false;
    let renderTask: pdfjsLib.RenderTask | null = null;

    const renderPage = async () => {
      try {
        const page = await pdfDoc.getPage(pageNumber);
        if (cancelled) {
          return;
        }
        const unitViewport = page.getViewport({ scale: 1 });
        setPageSizePt({ width: unitViewport.width, height: unitViewport.height });
        if (pageNumber === 1) {
          onPageMeasured(unitViewport.width, unitViewport.height);
        }

        const dpr = Math.max(window.devicePixelRatio || 1, 2);
        const cssViewport = page.getViewport({ scale });
        const hiViewport = page.getViewport({ scale: scale * dpr });
        const canvas = canvasRef.current;
        if (!canvas) {
          return;
        }

        // Render to offscreen canvas first so existing page stays sharp with zero white flash
        const offscreen = document.createElement('canvas');
        offscreen.width = Math.max(1, Math.floor(hiViewport.width));
        offscreen.height = Math.max(1, Math.floor(hiViewport.height));
        const offCtx = offscreen.getContext('2d');
        if (!offCtx) {
          return;
        }

        renderTask = page.render({ canvasContext: offCtx, viewport: hiViewport });
        await renderTask.promise;
        if (cancelled) {
          return;
        }

        const ctx = canvas.getContext('2d');
        if (!ctx) {
          return;
        }
        canvas.width = offscreen.width;
        canvas.height = offscreen.height;
        canvas.style.width = `${cssViewport.width}px`;
        canvas.style.height = `${cssViewport.height}px`;
        ctx.drawImage(offscreen, 0, 0);
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
  }, [pdfDoc, pageNumber, scale, isVisible, onPageMeasured]);

  const estWidth = Math.round(pageSizePt.width * scale);
  const estHeight = Math.round(pageSizePt.height * scale);

  return (
    <div
      ref={(el) => {
        wrapperRef.current = el;
        registerPageRef(pageNumber, el);
      }}
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
        onDoubleClickPoint(pageNumber, xRatio, yRatio, pageSizePt.width, pageSizePt.height);
      }}
    >
      <div className="pdf-page-Badge">Page {pageNumber} · Double-click to jump to LaTeX</div>
      <div className="pdf-canvas-frame" style={{ position: 'relative', minWidth: estWidth, minHeight: estHeight }}>
        <canvas
          ref={canvasRef}
          className="pdf-canvas"
          style={{ cursor: 'pointer', width: `${estWidth}px`, height: `${estHeight}px` }}
        />
        {highlightPoint && (
          <div
            className="synctex-pulse-marker"
            style={{
              left: `${highlightPoint.x * 100}%`,
              top: `${highlightPoint.y * 100}%`,
            }}
          />
        )}
      </div>
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
  forwardSyncTarget?: { page: number; x: number; y: number; seq: number } | null;
  onReportPageSize?: (widthPt: number, heightPt: number) => void;
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
  forwardSyncTarget = null,
  onReportPageSize,
  onTriggerCompile,
  onJumpToFile,
}) => {
  const [viewMode, setViewMode] = useState<'pdf' | 'logs' | 'draft'>('pdf');
  const [pdfRenderMode, setPdfRenderMode] = useState<'interactive' | 'native'>('interactive');
  const [zoom, setZoom] = useState(115);
  const [showRawLog, setShowRawLog] = useState(false);
  const [pdfDoc, setPdfDoc] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState<number>(0);
  const [pageSizePt, setPageSizePt] = useState<{ width: number; height: number }>({
    width: 612,
    height: 792,
  });
  const [loadingPdf, setLoadingPdf] = useState(false);
  const [pdfLoadError, setPdfLoadError] = useState<string | null>(null);
  const [retrySeq, setRetrySeq] = useState(0);
  const [syncTexStatus, setSyncTexStatus] = useState<string | null>(null);
  const [activeHighlight, setActiveHighlight] = useState<{
    page: number;
    x: number;
    y: number;
  } | null>(null);

  const stageRef = useRef<HTMLDivElement | null>(null);
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const pdfDocRef = useRef<pdfjsLib.PDFDocumentProxy | null>(null);

  const allErrors = compileResult?.errors ?? [];
  const allWarnings = compileResult?.warnings ?? [];
  const primaryWarnings = useMemo(
    () => allWarnings.filter((w) => w.category !== 'typography'),
    [allWarnings],
  );
  const typographyWarnings = useMemo(
    () => allWarnings.filter((w) => w.category === 'typography'),
    [allWarnings],
  );
  const errorCount = allErrors.length;
  const hasRealPdf = Boolean(projectId && compileResult?.pdf_available);
  const isCompilerFault = compileResult?.failure_kind === 'compiler';

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

  const registerPageRef = useCallback((pageNum: number, el: HTMLDivElement | null) => {
    if (el) {
      pageRefs.current.set(pageNum, el);
    } else {
      pageRefs.current.delete(pageNum);
    }
  }, []);

  const handlePageMeasured = useCallback(
    (wPt: number, hPt: number) => {
      setPageSizePt((prev) =>
        Math.abs(prev.width - wPt) < 1 && Math.abs(prev.height - hPt) < 1
          ? prev
          : { width: wPt, height: hPt },
      );
      if (onReportPageSize) {
        onReportPageSize(wPt, hPt);
      }
    },
    [onReportPageSize],
  );

  // Restore scroll position on mount when returning to Compiled Paper tab
  useEffect(() => {
    const el = stageRef.current;
    if (!el || !projectId) {
      return undefined;
    }
    const savedScroll = previewScrollCache.get(projectId);
    if (savedScroll && savedScroll > 0) {
      window.requestAnimationFrame(() => {
        if (stageRef.current) {
          stageRef.current.scrollTop = savedScroll;
        }
      });
    }
    return undefined;
  }, [projectId, pdfDoc]);

  useEffect(() => {
    if (!hasRealPdf || !pdfUrl || pdfRenderMode !== 'interactive' || !projectId) {
      return undefined;
    }
    let cancelled = false;
    let loadingTask: pdfjsLib.PDFDocumentLoadingTask | null = null;
    const abortCtrl = new AbortController();
    const cacheKey = `${projectId}:${compileResult?.root_tex || ''}:${pdfVersion}`;

    const loadDocument = async () => {
      setPdfLoadError(null);
      setLoadingPdf(true);
      try {
        let bytes = pdfBytesCache.get(cacheKey);
        if (!bytes) {
          const resp = await fetch(pdfUrl, { signal: abortCtrl.signal });
          if (!resp.ok) {
            throw new Error(`PDF download failed (HTTP ${resp.status})`);
          }
          const buf = await resp.arrayBuffer();
          bytes = new Uint8Array(buf);
          storeCachedPdfBytes(cacheKey, bytes);
        }
        if (cancelled) {
          return;
        }
        loadingTask = pdfjsLib.getDocument({ data: bytes.slice(0) });
        const doc = await loadingTask.promise;
        if (cancelled) {
          void doc.destroy();
          return;
        }
        const prevDoc = pdfDocRef.current;
        const savedTop = stageRef.current?.scrollTop ?? previewScrollCache.get(projectId) ?? 0;
        pdfDocRef.current = doc;
        setPdfDoc(doc);
        setNumPages(doc.numPages);
        if (savedTop > 0) {
          window.requestAnimationFrame(() => {
            if (stageRef.current) {
              stageRef.current.scrollTop = savedTop;
            }
          });
        }
        if (prevDoc && prevDoc !== doc) {
          window.setTimeout(() => {
            void prevDoc.destroy();
          }, 150);
        }
      } catch (err) {
        if (cancelled || (err instanceof DOMException && err.name === 'AbortError')) {
          return;
        }
        setPdfLoadError(
          err instanceof Error ? err.message : 'Failed to load compiled PDF',
        );
      } finally {
        if (!cancelled) {
          setLoadingPdf(false);
        }
      }
    };

    void loadDocument();
    return () => {
      cancelled = true;
      abortCtrl.abort();
      if (loadingTask) {
        void loadingTask.destroy();
      }
    };
  }, [hasRealPdf, pdfUrl, pdfRenderMode, projectId, compileResult?.root_tex, pdfVersion, retrySeq]);

  // Clean up current PDFDocumentProxy when unmounting pane
  useEffect(() => {
    return () => {
      if (pdfDocRef.current) {
        void pdfDocRef.current.destroy();
        pdfDocRef.current = null;
      }
    };
  }, []);

  // Handle Forward SyncTeX jump from LaTeX Editor -> PDF page + highlight pulse
  useEffect(() => {
    if (!forwardSyncTarget) {
      return undefined;
    }
    setViewMode('pdf');
    setActiveHighlight({
      page: forwardSyncTarget.page,
      x: forwardSyncTarget.x,
      y: forwardSyncTarget.y,
    });
    const scrollTimer = window.setTimeout(() => {
      const stageEl = stageRef.current;
      const pageEl = pageRefs.current.get(forwardSyncTarget.page);
      if (stageEl && pageEl) {
        const targetTop =
          pageEl.offsetTop + pageEl.offsetHeight * forwardSyncTarget.y - stageEl.clientHeight * 0.35;
        stageEl.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' });
      } else if (pageEl) {
        pageEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }, 60);
    const clearTimer = window.setTimeout(() => setActiveHighlight(null), 2200);
    return () => {
      window.clearTimeout(scrollTimer);
      window.clearTimeout(clearTimer);
    };
  }, [forwardSyncTarget]);

  const handleSyncTexDoubleClick = async (
    pageNumber: number,
    xRatio: number,
    yRatio: number,
    widthPt: number,
    heightPt: number,
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
        widthPt,
        heightPt,
      );
      setSyncTexStatus(`→ ${res.path}:${res.line}`);
      onJumpToFile(res.path, res.line);
      window.setTimeout(() => setSyncTexStatus(null), 2200);
    } catch {
      setSyncTexStatus('SyncTeX position unavailable (click Recompile)');
      window.setTimeout(() => setSyncTexStatus(null), 2200);
    }
  };

  const renderDiagCard = (item: LatexDiagnostic, idx: number, prefix: string) => {
    const relTarget = normalizeDiagnosticRelPath(item.file);
    const canJump = Boolean(relTarget && (relTarget.endsWith('.tex') || relTarget.endsWith('.bib')) && onJumpToFile);
    return (
      <div
        key={`${prefix}-${idx}`}
        className={`log-card ${item.level === 'error' ? 'log-card-error' : 'log-card-warn'}`}
      >
        <div className="log-card-top">
          <span className={`log-level-badge ${item.level === 'error' ? 'error' : 'warn'}`}>
            {item.level === 'error'
              ? item.source === 'compiler'
                ? 'COMPILER'
                : 'ERROR'
              : item.source === 'bibtex'
                ? 'BIBTEX'
                : 'WARNING'}
          </span>
          <code>
            {item.file || compileResult?.root_tex}
            {item.line ? ` : line ${item.line}` : ''}
          </code>
          {canJump && (
            <button
              type="button"
              className="btn-tiny"
              onClick={() => onJumpToFile!(relTarget, item.line)}
            >
              Open {relTarget.replace(/^paper\//, '')}
              {item.line ? `:${item.line}` : ''}
            </button>
          )}
        </div>
        <div className="log-card-msg">{item.message}</div>
        {item.context && (
          <pre className="log-card-context">
            <code>
              {item.line ? `l.${item.line}  ` : ''}
              {item.context}
            </code>
          </pre>
        )}
      </div>
    );
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
          {compileResult && compileResult.duration_ms > 0 && (
            <span className="muted-hint">
              {(compileResult.duration_ms / 1000).toFixed(1)}s
              {numPages > 0 ? ` · ${numPages}p` : ''}
            </span>
          )}
          {(!compileResult || compileResult.duration_ms === 0) && numPages > 0 && (
            <span className="muted-hint">{numPages}p (cached)</span>
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
              errorCount > 0 ? 'log-btn-error' : primaryWarnings.length > 0 ? 'log-btn-warn' : ''
            }`}
            onClick={() => setViewMode((m) => (m === 'logs' ? 'pdf' : 'logs'))}
            title="View LaTeX compiler errors, warnings, and raw output logs"
          >
            📋 Logs{' '}
            {errorCount > 0 && <span className="log-count-pill error">{errorCount} Err</span>}
            {primaryWarnings.length > 0 && (
              <span className="log-count-pill warn">{primaryWarnings.length} Warn</span>
            )}
            {errorCount === 0 && primaryWarnings.length === 0 && compileResult && (
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

          {viewMode === 'pdf' && hasRealPdf && (
            <button
              type="button"
              className="btn-tiny"
              onClick={() =>
                setPdfRenderMode((m) => (m === 'interactive' ? 'native' : 'interactive'))
              }
              title="Toggle between Interactive SyncTeX PDF renderer and browser native PDF viewer"
            >
              {pdfRenderMode === 'interactive' ? 'Native PDF' : 'SyncTeX PDF'}
            </button>
          )}

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

      {(compiling || loadingPdf) && viewMode === 'pdf' && (
        <div className="pdf-progress-strip">
          <span>
            {compiling
              ? '↻ Compiling LaTeX on server… keeping current PDF visible'
              : '⬇ Downloading compiled PDF…'}
          </span>
        </div>
      )}

      {/* VIEW 1: Overleaf-Style Error & Warning Diagnostics Page */}
      {viewMode === 'logs' && (
        <div className="overleaf-logs-stage">
          <div className="overleaf-logs-header">
            <div>
              <strong>
                {errorCount > 0
                  ? isCompilerFault
                    ? '⚙ Compiler / Environment Error (not LaTeX code)'
                    : `✕ ${errorCount} LaTeX Code Error(s)`
                  : '✓ Compilation Succeeded'}
              </strong>
              <span className="muted-hint" style={{ marginLeft: 10 }}>
                {primaryWarnings.length} Warning(s) · {typographyWarnings.length} Typography hint(s) ·
                Root: <code>{compileResult?.root_tex || sourceLabel}</code>
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

          {errorCount === 0 && primaryWarnings.length === 0 && !showRawLog && (
            <div className="log-card log-card-ok">
              No LaTeX syntax, citation, or reference issues reported.
            </div>
          )}

          {allErrors.map((errItem, idx) => renderDiagCard(errItem, idx, 'err'))}
          {primaryWarnings.map((warnItem, idx) => renderDiagCard(warnItem, idx, 'warn'))}

          {typographyWarnings.length > 0 && (
            <details className="raw-log-box">
              <summary className="raw-log-title" style={{ cursor: 'pointer' }}>
                Typography / Box Layout Hints ({typographyWarnings.length} Underfull/Overfull warnings)
              </summary>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 8 }}>
                {typographyWarnings.map((warnItem, idx) => renderDiagCard(warnItem, idx, 'typo'))}
              </div>
            </details>
          )}

          {(showRawLog || (allErrors.length === 0 && primaryWarnings.length === 0)) &&
            compileResult?.raw_log && (
              <div className="raw-log-box">
                <div className="raw-log-title">Raw TeX / BibTeX Output</div>
                <pre className="md-pre">{compileResult.raw_log}</pre>
              </div>
            )}
        </div>
      )}

      {/* VIEW 2: Real Compiled PDF Viewer (Interactive SyncTeX Double-Click or Native PDF) */}
      {viewMode === 'pdf' &&
        (hasRealPdf ? (
          pdfRenderMode === 'interactive' ? (
            pdfLoadError && !pdfDoc ? (
              <div className="overleaf-logs-stage">
                <div className="log-card log-card-warn">
                  <div className="log-card-top">
                    <span className="log-level-badge warn">NETWORK</span>
                    <strong>Could not download compiled PDF</strong>
                  </div>
                  <div className="log-card-msg">{pdfLoadError}</div>
                  <div className="row-gap" style={{ marginTop: 8 }}>
                    <button
                      type="button"
                      className="btn-primary btn-tiny"
                      onClick={() => setRetrySeq((s) => s + 1)}
                    >
                      ↻ Retry PDF Download
                    </button>
                    <button
                      type="button"
                      className="btn-tiny"
                      onClick={() => setPdfRenderMode('native')}
                    >
                      Try Native Viewer
                    </button>
                    <button
                      type="button"
                      className="btn-tiny"
                      onClick={() => setViewMode('draft')}
                    >
                      ⚡ Switch to Offline Draft
                    </button>
                  </div>
                </div>
              </div>
            ) : pdfDoc ? (
              <div
                ref={stageRef}
                className="reader-canvas-stage"
                onScroll={() => {
                  if (projectId && stageRef.current) {
                    previewScrollCache.set(projectId, stageRef.current.scrollTop);
                  }
                }}
              >
                {Array.from({ length: numPages }, (_, i) => i + 1).map((pageNum) => (
                  <CompiledPdfPageCanvas
                    key={`page-${pageNum}`}
                    pdfDoc={pdfDoc}
                    pageNumber={pageNum}
                    scale={zoom / 100}
                    fallbackSizePt={pageSizePt}
                    highlightPoint={
                      activeHighlight && activeHighlight.page === pageNum
                        ? { x: activeHighlight.x, y: activeHighlight.y }
                        : null
                    }
                    registerPageRef={registerPageRef}
                    onPageMeasured={handlePageMeasured}
                    onDoubleClickPoint={(p, x, y, wPt, hPt) =>
                      void handleSyncTexDoubleClick(p, x, y, wPt, hPt)
                    }
                  />
                ))}
              </div>
            ) : (
              <div className="empty-hint">Loading compiled PDF…</div>
            )
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
          <div className="overleaf-logs-stage">
            <div className="log-card log-card-ok">
              <div className="log-card-top">
                <strong>
                  {compiling
                    ? '↻ Compiling LaTeX PDF on the server…'
                    : 'No compiled PDF available yet'}
                </strong>
              </div>
              <div className="log-card-msg" style={{ marginTop: 6 }}>
                {compiling
                  ? 'Tectonic is building your PDF and SyncTeX map. It will appear here automatically once finished.'
                  : 'Click Recompile above (or press Ctrl+S in a .tex file) to generate the full LaTeX PDF.'}
              </div>
              <div className="row-gap" style={{ marginTop: 10 }}>
                <button
                  type="button"
                  className="btn-primary btn-tiny"
                  disabled={compiling || !projectId}
                  onClick={() => void onTriggerCompile()}
                >
                  {compiling ? '↻ Compiling…' : '↻ Compile Now'}
                </button>
                <button
                  type="button"
                  className="btn-tiny"
                  onClick={() => setViewMode('draft')}
                >
                  ⚡ View Offline Draft Preview
                </button>
              </div>
            </div>
          </div>
        ))}

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
