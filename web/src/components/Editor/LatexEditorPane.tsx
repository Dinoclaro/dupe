import React, { useEffect, useRef, useState } from 'react';
import { EditorState, Extension } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { autocompletion } from '@codemirror/autocomplete';
import { StreamLanguage } from '@codemirror/language';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { markdown } from '@codemirror/lang-markdown';
import { unifiedMergeView } from '@codemirror/merge';
import { oneDark } from '@codemirror/theme-one-dark';
import { Paper } from '../../api/client';
import { createCitationCompletionSource } from './citationCompletion';

interface LatexEditorPaneProps {
  fileLabel: string;
  source: string;
  headContent?: string;
  hasExternalAgentEdit?: boolean;
  papers: Paper[];
  saving: boolean;
  readOnly?: boolean;
  onChangeSource: (next: string) => void;
  onSaveSource: () => Promise<void>;
  onRevertToHead?: () => Promise<void>;
  onAcceptAgentEdits?: () => void;
  onOpenPreviewSplit?: () => void;
  registerInsertSnippet: (fn: (snippet: string) => void) => void;
}

export const LatexEditorPane: React.FC<LatexEditorPaneProps> = ({
  fileLabel,
  source,
  headContent = '',
  hasExternalAgentEdit = false,
  papers,
  saving,
  readOnly = false,
  onChangeSource,
  onSaveSource,
  onRevertToHead,
  onAcceptAgentEdits,
  onOpenPreviewSplit,
  registerInsertSnippet,
}) => {
  const editorContainerRef = useRef<HTMLDivElement | null>(null);
  const editorViewRef = useRef<EditorView | null>(null);
  const papersRef = useRef<Paper[]>(papers);
  papersRef.current = papers;

  const onChangeRef = useRef(onChangeSource);
  onChangeRef.current = onChangeSource;

  const [diffEnabled, setDiffEnabled] = useState<boolean>(false);
  const isMarkdown = fileLabel.endsWith('.md');
  const hasHeadDiff = Boolean(headContent && headContent !== source);

  // Only auto-open diff mode when switching to a file that was modified externally by an agent
  useEffect(() => {
    setDiffEnabled(Boolean(hasExternalAgentEdit && headContent && headContent !== source));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileLabel, hasExternalAgentEdit]);

  useEffect(() => {
    const container = editorContainerRef.current;
    if (!container) {
      return undefined;
    }

    const langExt: Extension = isMarkdown
      ? markdown()
      : StreamLanguage.define(stex);

    const extensions: Extension[] = [
      lineNumbers(),
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      langExt,
      oneDark,
      EditorView.lineWrapping,
      EditorState.readOnly.of(readOnly),
      autocompletion({
        override: [createCitationCompletionSource(() => papersRef.current, isMarkdown)],
        activateOnTyping: true,
      }),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          onChangeRef.current(update.state.doc.toString());
        }
      }),
    ];

    if (diffEnabled && headContent) {
      extensions.push(
        unifiedMergeView({
          original: headContent,
          highlightChanges: true,
          gutter: true,
          syntaxHighlightDeletions: true,
          mergeControls: !readOnly,
        }),
      );
    }

    const state = EditorState.create({
      doc: source,
      extensions,
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
    // Only recreate editor when fileLabel, readOnly, or diff toggle changes (never on user typing)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileLabel, readOnly, diffEnabled, isMarkdown]);

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
          {hasExternalAgentEdit && (
            <span
              className="git-badge git-badge-m"
              title="Modified externally on disk (e.g. by an agent)"
            >
              Agent Edit
            </span>
          )}
          <span className="muted-hint">
            {readOnly
              ? 'Generated by dupe'
              : isMarkdown
                ? 'Type @ or [[paper: for citation links'
                : 'Type @ or \\cite{ for BibTeX autocomplete'}
          </span>
        </div>
        <div className="editor-actions">
          {headContent && (
            <button
              type="button"
              className={`btn-tiny ${diffEnabled ? 'active-btn' : ''}`}
              onClick={() => setDiffEnabled((v) => !v)}
              title="Compare current file against last Git commit (HEAD)"
            >
              {diffEnabled ? 'Hide Diff' : 'Diff vs HEAD'}
            </button>
          )}
          {diffEnabled && onAcceptAgentEdits && (
            <button
              type="button"
              className="btn-tiny"
              onClick={() => {
                onAcceptAgentEdits();
                setDiffEnabled(false);
              }}
              title="Accept current changes as your baseline"
            >
              ✓ Accept All
            </button>
          )}
          {hasHeadDiff && diffEnabled && onRevertToHead && !readOnly && (
            <button
              type="button"
              className="btn-tiny danger"
              onClick={() => {
                void onRevertToHead();
                setDiffEnabled(false);
              }}
              title="Discard uncommitted edits and restore Git HEAD version"
            >
              Revert to HEAD
            </button>
          )}
          {onOpenPreviewSplit && (
            <button
              type="button"
              className="btn-tiny"
              onClick={onOpenPreviewSplit}
              title="Open Compiled Preview in Right Split"
            >
              ◫ Open Preview
            </button>
          )}
          {!readOnly && (
            <button
              type="button"
              className="btn-primary btn-tiny"
              disabled={saving}
              onClick={() => void onSaveSource()}
            >
              {saving ? 'Saving...' : 'Save'}
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
