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

interface PdfReaderPaneProps {
  paper: Paper | null;
  onInsertCitation: (bibtexKey: string) => void;
}

export const PdfReaderPane: React.FC<PdfReaderPaneProps> = ({ paper, onInsertCitation }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pdfDocRef = useRef<pdfjsLib.PDFDocumentProxy | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [numPages, setNumPages] = useState(0);
  const [scale, setScale] = useState(1.2);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!paper) {
      pdfDocRef.current = null;
      setNumPages(0);
      setPageNumber(1);
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
        pdfDocRef.current = doc;
        setNumPages(doc.numPages);
        setPageNumber(1);
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
  }, [paper]);

  useEffect(() => {
    let cancelled = false;
    const renderPage = async () => {
      const doc = pdfDocRef.current;
      const canvas = canvasRef.current;
      if (!doc || !canvas || pageNumber < 1 || pageNumber > doc.numPages) {
        return;
      }

      try {
        const page = await doc.getPage(pageNumber);
        if (cancelled) {
          return;
        }
        const viewport = page.getViewport({ scale });
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          return;
        }
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        await page.render({ canvasContext: ctx, viewport }).promise;
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to render page');
        }
      }
    };

    void renderPage();
    return () => {
      cancelled = true;
    };
  }, [pageNumber, scale, numPages, paper]);

  if (!paper) {
    return (
      <div className="empty-hint">
        Select a paper from the Library to read its PDF alongside your LaTeX manuscript.
      </div>
    );
  }

  return (
    <div className="reader-pane">
      <div className="reader-toolbar">
        <div className="reader-meta">
          <strong className="truncate-text" title={paper.title}>
            {paper.title}
          </strong>
          {paper.bibtex_key && (
            <button
              type="button"
              className="btn-tiny"
              onClick={() => onInsertCitation(paper.bibtex_key)}
            >
              Insert \cite&#123;{paper.bibtex_key}&#125;
            </button>
          )}
        </div>
        <div className="reader-controls">
          <button
            type="button"
            className="btn-tiny"
            disabled={pageNumber <= 1}
            onClick={() => setPageNumber((p) => Math.max(1, p - 1))}
          >
            Prev
          </button>
          <span className="reader-page-indicator">
            {pageNumber} / {numPages || 1}
          </span>
          <button
            type="button"
            className="btn-tiny"
            disabled={pageNumber >= numPages}
            onClick={() => setPageNumber((p) => Math.min(numPages, p + 1))}
          >
            Next
          </button>
          <button
            type="button"
            className="btn-tiny"
            onClick={() => setScale((s) => Math.max(0.6, Number((s - 0.2).toFixed(1))))}
          >
            -
          </button>
          <span className="reader-page-indicator">{Math.round(scale * 100)}%</span>
          <button
            type="button"
            className="btn-tiny"
            onClick={() => setScale((s) => Math.min(2.5, Number((s + 0.2).toFixed(1))))}
          >
            +
          </button>
          <a
            href={api.paperFileUrl(paper.id)}
            target="_blank"
            rel="noreferrer"
            className="btn-tiny"
          >
            Native PDF
          </a>
        </div>
      </div>

      <div className="reader-canvas-stage">
        {loading && <div className="empty-hint">Loading PDF...</div>}
        {error && (
          <div className="reader-fallback">
            <p className="muted-hint">Canvas preview notice: {error}</p>
            <iframe
              title={paper.title}
              src={api.paperFileUrl(paper.id)}
              className="reader-iframe"
            />
          </div>
        )}
        <canvas
          ref={canvasRef}
          className="pdf-canvas"
          style={{ display: error ? 'none' : 'block' }}
        />
      </div>
    </div>
  );
};
