import React, { useState } from 'react';
import { CompileResponse } from '../../workers/latexCompiler';

interface CompiledPreviewPaneProps {
  compiled: CompileResponse;
  sourceLabel: string;
}

export const CompiledPreviewPane: React.FC<CompiledPreviewPaneProps> = ({
  compiled,
  sourceLabel,
}) => {
  const [zoom, setZoom] = useState(100);

  return (
    <div className="compiled-preview-shell">
      <div className="reader-toolbar">
        <div className="reader-meta">
          <strong>Compiled LaTeX Preview</strong>
          <span className="muted-hint">({sourceLabel})</span>
        </div>
        <div className="reader-controls">
          <span className="compile-stats">
            {compiled.citedKeys.length} cited · {compiled.durationMs} ms
          </span>
          <button
            type="button"
            className="btn-tiny"
            onClick={() => setZoom((z) => Math.max(70, z - 10))}
          >
            -
          </button>
          <span className="reader-page-indicator">{zoom}%</span>
          <button
            type="button"
            className="btn-tiny"
            onClick={() => setZoom((z) => Math.min(160, z + 10))}
          >
            +
          </button>
        </div>
      </div>

      {compiled.diagnostics.length > 0 && (
        <div className="editor-diagnostics">
          {compiled.diagnostics.map((d, idx) => (
            <span key={idx} className="diag-chip">
              {d}
            </span>
          ))}
        </div>
      )}

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
    </div>
  );
};
