import React, { useEffect, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { Paper, api, getStoredToken } from '../../api/client';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

export interface NormalizedRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function normalizeRect(
  rect: { left: number; top: number; width: number; height: number },
  pageRect: { left: number; top: number; width: number; height: number },
): NormalizedRect {
  const safeW = Math.max(1, pageRect.width);
  const safeH = Math.max(1, pageRect.height);
  const clamp01 = (v: number) => Math.max(0, Math.min(1, Number(v.toFixed(4))));
  return {
    x: clamp01((rect.left - pageRect.left) / safeW),
    y: clamp01((rect.top - pageRect.top) / safeH),
    w: clamp01(rect.width / safeW),
    h: clamp01(rect.height / safeH),
  };
}

interface PdfPageCanvasProps {
  doc: pdfjsLib.PDFDocumentProxy;
  pageNumber: number;
  scale: number;
}

const PdfPageCanvas: React.FC<PdfPageCanvasProps> = ({ doc, pageNumber, scale }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    let renderTask: pdfjsLib.RenderTask | null = null;

    const render = async () => {
      try {
        const page = await doc.getPage(pageNumber);
        if (cancelled) {
          return;
        }
        const dpr = window.devicePixelRatio || 1;
        const viewport = page.getViewport({ scale });
        const canvas = canvasRef.current;
        if (!canvas) {
          return;
        }
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          return;
        }
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        renderTask = page.render({ canvasContext: ctx, viewport });
        await renderTask.promise;
      } catch {
        // ignore cancelled render
      }
    };

    void render();
    return () => {
      cancelled = true;
      if (renderTask) {
        renderTask.cancel();
      }
    };
  }, [doc, pageNumber, scale]);

  return (
    <div className="pdf-page-wrapper">
      <canvas ref={canvasRef} className="pdf-canvas" />
      <div className="pdf-page-Badge">Page {pageNumber}</div>
    </div>
  );
};

interface PdfReaderPaneProps {
  paper: Paper | null;
  onInsertCitation: (bibtexKey: string) => void;
  onAddComment?: (source: string, location: string, quote: string, comment: string) => Promise<void>;
}

export const PdfReaderPane: React.FC<PdfReaderPaneProps> = ({
  paper,
  onInsertCitation,
  onAddComment,
}) => {
  const [viewerMode, setViewerMode] = useState<'native' | 'pdfjs'>('native');
  const [zoomPercent, setZoomPercent] = useState(110);
  const [pdfDoc, setPdfDoc] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCommentBox, setShowCommentBox] = useState(false);
  const [commentQuote, setCommentQuote] = useState('');
  const [commentLocation, setCommentLocation] = useState('PDF');
  const [commentText, setCommentText] = useState('');
  const [submittingComment, setSubmittingComment] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!paper || viewerMode !== 'pdfjs') {
      setPdfDoc(null);
      setNumPages(0);
      return;
    }

    const loadPdf = async () => {
      setLoading(true);
      setError(null);
      try {
        const token = getStoredToken();
        const loadingTask = pdfjsLib.getDocument({
          url: `/api/papers/${paper.id}/file`,
          httpHeaders: token ? { Authorization: `Bearer ${token}` } : undefined,
        });
        const doc = await loadingTask.promise;
        if (cancelled) {
          return;
        }
        setPdfDoc(doc);
        setNumPages(doc.numPages);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load PDF');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void loadPdf();
    return () => {
      cancelled = true;
    };
  }, [paper, viewerMode]);

  if (!paper) {
    return (
      <div className="empty-hint">
        Select a paper from the PDF Library to read it alongside your manuscript.
      </div>
    );
  }

  const fileUrl = api.paperFileUrl(paper.id);
  const scale = zoomPercent / 100;

  return (
    <div className="reader-pane">
      <div className="reader-toolbar">
        <div className="reader-meta">
          <code className="bibkey-badge">@{paper.bibtex_key || 'paper'}</code>
          <strong className="truncate-text" title={paper.title}>
            {paper.title}
          </strong>
        </div>
        <div className="reader-controls">
          {paper.bibtex_key && (
            <button
              type="button"
              className="btn-tiny"
              onClick={() => onInsertCitation(paper.bibtex_key)}
              title="Insert citation into active editor"
            >
              Cite \cite&#123;{paper.bibtex_key}&#125;
            </button>
          )}
          {onAddComment && (
            <button
              type="button"
              className={`btn-tiny ${showCommentBox ? 'active-btn' : ''}`}
              onClick={() => {
                const sel = window.getSelection()?.toString().trim() || '';
                if (sel) {
                  setCommentQuote(sel);
                }
                setShowCommentBox((v) => !v);
              }}
              title="Add a comment on this paper to notes/comments.md for the coding agent"
            >
              + Comment
            </button>
          )}
          <button
            type="button"
            className="btn-tiny"
            onClick={() => setZoomPercent((z) => Math.max(50, z - 15))}
            title="Zoom Out"
          >
            −
          </button>
          <span className="reader-page-indicator">{zoomPercent}%</span>
          <button
            type="button"
            className="btn-tiny"
            onClick={() => setZoomPercent((z) => Math.min(250, z + 15))}
            title="Zoom In"
          >
            +
          </button>
          <button
            type="button"
            className="btn-tiny"
            onClick={() =>
              setViewerMode((m) => (m === 'native' ? 'pdfjs' : 'native'))
            }
            title="Switch between Native Browser PDF Renderer and Continuous PDF.js Canvas"
          >
            {viewerMode === 'native' ? 'Engine: Native PDF' : `Engine: PDF.js (${numPages}p)`}
          </button>
          <a
            href={fileUrl}
            target="_blank"
            rel="noreferrer"
            className="btn-tiny"
            title="Open PDF in a new browser tab"
          >
            ↗ Pop Out
          </a>
        </div>
      </div>

      {showCommentBox && onAddComment && (
        <form
          className="inline-bib-drawer"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!commentText.trim()) {
              return;
            }
            setSubmittingComment(true);
            try {
              const sourceKey = paper.bibtex_key ? `[[paper:${paper.bibtex_key}]]` : paper.title;
              await onAddComment(sourceKey, commentLocation, commentQuote, commentText.trim());
              setCommentText('');
              setCommentQuote('');
              setShowCommentBox(false);
            } finally {
              setSubmittingComment(false);
            }
          }}
        >
          <div className="row-gap" style={{ justifyContent: 'space-between' }}>
            <strong>
              Comment on <code>@{paper.bibtex_key || paper.title}</code>
            </strong>
            <span className="muted-hint">Saved to notes/comments.md &amp; AGENTS.md</span>
          </div>
          <div className="row-gap">
            <input
              type="text"
              placeholder="Page / Section (e.g. Page 4)"
              value={commentLocation}
              onChange={(e) => setCommentLocation(e.target.value)}
              style={{ width: 140 }}
            />
            <input
              type="text"
              placeholder="Quoted text from PDF (optional)"
              value={commentQuote}
              onChange={(e) => setCommentQuote(e.target.value)}
              style={{ flex: 1 }}
            />
          </div>
          <input
            type="text"
            placeholder="Comment or instruction for the coding agent..."
            value={commentText}
            onChange={(e) => setCommentText(e.target.value)}
            autoFocus
            required
          />
          <div className="row-gap">
            <button type="submit" className="btn-primary btn-tiny" disabled={submittingComment}>
              {submittingComment ? 'Saving…' : 'Save Comment'}
            </button>
            <button type="button" className="btn-tiny" onClick={() => setShowCommentBox(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {viewerMode === 'native' ? (
        <div className="reader-native-stage">
          <iframe
            key={`${paper.id}-${zoomPercent}`}
            title={paper.title}
            src={`${fileUrl}#zoom=${zoomPercent}`}
            className="reader-native-iframe"
          />
        </div>
      ) : (
        <div className="reader-canvas-stage">
          {loading && <div className="empty-hint">Rendering {paper.title}…</div>}
          {error && <div className="auth-error">{error}</div>}
          {pdfDoc &&
            Array.from({ length: numPages }, (_, i) => i + 1).map((pageNum) => (
              <PdfPageCanvas
                key={`${paper.id}-p${pageNum}`}
                doc={pdfDoc}
                pageNumber={pageNum}
                scale={scale}
              />
            ))}
        </div>
      )}
    </div>
  );
};
