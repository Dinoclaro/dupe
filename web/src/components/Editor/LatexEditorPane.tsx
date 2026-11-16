import React, { useEffect, useRef, useState } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { autocompletion } from '@codemirror/autocomplete';
import { StreamLanguage } from '@codemirror/language';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { oneDark } from '@codemirror/theme-one-dark';
import { Paper } from '../../api/client';
import {
  CompileRequest,
  CompileResponse,
  compileLatexPreview,
} from '../../workers/latexCompiler';
import { createCitationCompletionSource } from './citationCompletion';

interface LatexEditorPaneProps {
  fileLabel: string;
  source: string;
  papers: Paper[];
  figures: Record<string, string>;
  saving: boolean;
  onChangeSource: (next: string) => void;
  onSaveSource: () => Promise<void>;
  registerInsertSnippet: (fn: (snippet: string) => void) => void;
}

export const LatexEditorPane: React.FC<LatexEditorPaneProps> = ({
  fileLabel,
  source,
  papers,
  figures,
  saving,
  onChangeSource,
  onSaveSource,
  registerInsertSnippet,
}) => {
  const editorContainerRef = useRef<HTMLDivElement | null>(null);
  const editorViewRef = useRef<EditorView | null>(null);
  const papersRef = useRef<Paper[]>(papers);
  papersRef.current = papers;

  const onChangeRef = useRef(onChangeSource);
  onChangeRef.current = onChangeSource;

  const workerRef = useRef<Worker | null>(null);
  const requestIdRef = useRef(0);
  const [compiled, setCompiled] = useState<CompileResponse>(() =>
    compileLatexPreview({
      requestId: 0,
      source,
      papers,
      figures,
    }),
  );
  const [showPreview, setShowPreview] = useState(true);

  useEffect(() => {
    try {
      const worker = new Worker(
        new URL('../../workers/latexWorker.ts', import.meta.url),
        { type: 'module' },
      );
      worker.onmessage = (event: MessageEvent<CompileResponse>) => {
        setCompiled(event.data);
      };
      workerRef.current = worker;
      return () => {
        worker.terminate();
        workerRef.current = null;
      };
    } catch {
      workerRef.current = null;
      return undefined;
    }
  }, []);

  useEffect(() => {
    const reqId = ++requestIdRef.current;
    const payload: CompileRequest = {
      requestId: reqId,
      source,
      papers: papers.map((p) => ({
        bibtex_key: p.bibtex_key,
        title: p.title,
        authors: p.authors,
        publication_year: p.publication_year,
        doi: p.doi,
      })),
      figures,
    };

    const timer = window.setTimeout(() => {
      if (workerRef.current) {
        workerRef.current.postMessage(payload);
      } else {
        setCompiled(compileLatexPreview(payload));
      }
    }, 120);

    return () => window.clearTimeout(timer);
  }, [source, papers, figures]);

  useEffect(() => {
    const container = editorContainerRef.current;
    if (!container) {
      return undefined;
    }

    const state = EditorState.create({
      doc: source,
      extensions: [
        lineNumbers(),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        StreamLanguage.define(stex),
        oneDark,
        EditorView.lineWrapping,
        autocompletion({
          override: [createCitationCompletionSource(() => papersRef.current)],
          activateOnTyping: true,
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current(update.state.doc.toString());
          }
        }),
      ],
    });

    const view = new EditorView({
      state,
      parent: container,
    });
    editorViewRef.current = view;

    registerInsertSnippet((snippet: string) => {
      const currentView = editorViewRef.current;
      if (!currentView) {
        return;
      }
      const { from, to } = currentView.state.selection.main;
      currentView.dispatch({
        changes: { from, to, insert: snippet },
        selection: { anchor: from + snippet.length },
      });
      currentView.focus();
    });

    return () => {
      view.destroy();
      editorViewRef.current = null;
    };
    // Only recreate editor when container mounts
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const view = editorViewRef.current;
    if (!view) {
      return;
    }
    const currentText = view.state.doc.toString();
    if (currentText !== source) {
      view.dispatch({
        changes: { from: 0, to: currentText.length, insert: source },
      });
    }
  }, [source]);

  return (
    <div className="editor-pane">
      <div className="editor-toolbar">
        <div className="editor-file-badge">
          <code>{fileLabel}</code>
          <span className="muted-hint">Type @ or \cite&#123; for BibTeX autocomplete</span>
        </div>
        <div className="editor-actions">
          <span className="compile-stats">
            {compiled.citedKeys.length} cited · {compiled.durationMs} ms
          </span>
          <button
            type="button"
            className="btn-tiny"
            onClick={() => setShowPreview((p) => !p)}
          >
            {showPreview ? 'Hide Preview' : 'Show Preview'}
          </button>
          <button
            type="button"
            className="btn-primary btn-small"
            disabled={saving}
            onClick={() => void onSaveSource()}
          >
            {saving ? 'Saving...' : 'Save File'}
          </button>
        </div>
      </div>

      {compiled.diagnostics.length > 0 && (
        <div className="editor-diagnostics">
          {compiled.diagnostics.map((d, i) => (
            <span key={i} className="diag-chip">
              {d}
            </span>
          ))}
        </div>
      )}

      <div className="editor-split">
        <div className="codemirror-host" ref={editorContainerRef} />
        {showPreview && (
          <div
            className="latex-preview-pane"
            dangerouslySetInnerHTML={{ __html: compiled.html }}
          />
        )}
      </div>
    </div>
  );
};
