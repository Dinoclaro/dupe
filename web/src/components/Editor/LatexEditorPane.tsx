import React, { useEffect, useRef } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { autocompletion } from '@codemirror/autocomplete';
import { StreamLanguage } from '@codemirror/language';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { oneDark } from '@codemirror/theme-one-dark';
import { Paper } from '../../api/client';
import { createCitationCompletionSource } from './citationCompletion';

interface LatexEditorPaneProps {
  fileLabel: string;
  source: string;
  papers: Paper[];
  saving: boolean;
  readOnly?: boolean;
  onChangeSource: (next: string) => void;
  onSaveSource: () => Promise<void>;
  onOpenPreviewSplit?: () => void;
  registerInsertSnippet: (fn: (snippet: string) => void) => void;
}

export const LatexEditorPane: React.FC<LatexEditorPaneProps> = ({
  fileLabel,
  source,
  papers,
  saving,
  readOnly = false,
  onChangeSource,
  onSaveSource,
  onOpenPreviewSplit,
  registerInsertSnippet,
}) => {
  const editorContainerRef = useRef<HTMLDivElement | null>(null);
  const editorViewRef = useRef<EditorView | null>(null);
  const papersRef = useRef<Paper[]>(papers);
  papersRef.current = papers;

  const onChangeRef = useRef(onChangeSource);
  onChangeRef.current = onChangeSource;

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
        EditorState.readOnly.of(readOnly),
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly]);

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
          <span className="muted-hint">
            {readOnly
              ? 'Auto-generated from PDF Library'
              : 'Type @ or \\cite{ for BibTeX autocomplete'}
          </span>
        </div>
        <div className="editor-actions">
          {onOpenPreviewSplit && (
            <button
              type="button"
              className="btn-tiny"
              onClick={onOpenPreviewSplit}
              title="Open Compiled LaTeX Preview in Right Split"
            >
              ◫ Open Compiled Preview
            </button>
          )}
          {!readOnly && (
            <button
              type="button"
              className="btn-primary btn-tiny"
              disabled={saving}
              onClick={() => void onSaveSource()}
            >
              {saving ? 'Saving...' : 'Save (Ctrl+S)'}
            </button>
          )}
        </div>
      </div>

      <div className="editor-split">
        <div className="codemirror-host" ref={editorContainerRef} />
      </div>
    </div>
  );
};
