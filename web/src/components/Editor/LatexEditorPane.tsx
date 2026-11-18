import React, { useEffect, useMemo, useRef, useState } from 'react';
import { EditorState, Extension } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { openSearchPanel, search, searchKeymap } from '@codemirror/search';
import { autocompletion } from '@codemirror/autocomplete';
import { StreamLanguage } from '@codemirror/language';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { markdown } from '@codemirror/lang-markdown';
import { unifiedMergeView } from '@codemirror/merge';
import { oneDark } from '@codemirror/theme-one-dark';
import { Paper } from '../../api/client';
import { renderMarkdownPreview } from '../../workers/latexCompiler';
import { createCitationCompletionSource } from './citationCompletion';

interface LatexEditorPaneProps {
  fileLabel: string;
  source: string;
  headContent?: string;
  hasExternalAgentEdit?: boolean;
  papers: Paper[];
  saving: boolean;
  dirty?: boolean;
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
  dirty = false,
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

  const onSaveRef = useRef(onSaveSource);
  onSaveRef.current = onSaveSource;

  const isMarkdown = fileLabel.endsWith('.md');
  const [diffEnabled, setDiffEnabled] = useState<boolean>(false);
  const [mdViewMode, setMdViewMode] = useState<'preview' | 'split' | 'raw'>(
    isMarkdown ? (readOnly ? 'preview' : 'split') : 'raw',
  );

  const hasHeadDiff = Boolean(headContent && headContent !== source);

  const markdownCompiled = useMemo(() => {
    if (!isMarkdown || mdViewMode === 'raw') {
      return null;
    }
    return renderMarkdownPreview({
      requestId: 0,
      source,
      isMarkdown: true,
      papers: papers.map((p) => ({
        bibtex_key: p.bibtex_key,
        title: p.title,
        authors: p.authors,
        publication_year: p.publication_year,
        doi: p.doi,
      })),
      figures: {},
    });
  }, [isMarkdown, mdViewMode, source, papers]);

  useEffect(() => {
    setDiffEnabled(Boolean(hasExternalAgentEdit && headContent && headContent !== source));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileLabel, hasExternalAgentEdit]);

  useEffect(() => {
    const container = editorContainerRef.current;
    if (!container || (isMarkdown && mdViewMode === 'preview')) {
      return undefined;
    }

    const langExt: Extension = isMarkdown
      ? markdown()
      : StreamLanguage.define(stex);

    const extensions: Extension[] = [
      lineNumbers(),
      history(),
      search(),
      keymap.of([
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
        {
          key: 'Mod-s',
          run: () => {
            if (!readOnly) {
              void onSaveRef.current();
            }
            return true;
          },
        },
      ]),
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileLabel, readOnly, diffEnabled, isMarkdown, mdViewMode]);

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
          {isMarkdown && (
            <div className="row-gap">
              <button
                type="button"
                className={`btn-tiny ${mdViewMode === 'preview' ? 'active-btn' : ''}`}
                onClick={() => setMdViewMode('preview')}
              >
                Rendered
              </button>
              {!readOnly && (
                <button
                  type="button"
                  className={`btn-tiny ${mdViewMode === 'split' ? 'active-btn' : ''}`}
                  onClick={() => setMdViewMode('split')}
                >
                  Split
                </button>
              )}
              <button
                type="button"
                className={`btn-tiny ${mdViewMode === 'raw' ? 'active-btn' : ''}`}
                onClick={() => setMdViewMode('raw')}
              >
                Raw Source
              </button>
            </div>
          )}

          {headContent && (!isMarkdown || mdViewMode !== 'preview') && (
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
          {!isMarkdown && onOpenPreviewSplit && (
            <button
              type="button"
              className="btn-tiny"
              onClick={onOpenPreviewSplit}
              title="Open Compiled Paper Preview in Right Split"
            >
              ◫ Open Preview
            </button>
          )}
          {(!isMarkdown || mdViewMode !== 'preview') && (
            <button
              type="button"
              className="btn-tiny"
              onClick={() => {
                if (editorViewRef.current) {
                  openSearchPanel(editorViewRef.current);
                  editorViewRef.current.focus();
                }
              }}
              title="Find in file (Ctrl+F)"
            >
              Find
            </button>
          )}
          {!readOnly && (
            <button
              type="button"
              className="btn-primary btn-tiny"
              disabled={saving}
              onClick={() => void onSaveSource()}
              title="Auto-saves after 1.2s, or press Ctrl+S"
            >
              {saving ? 'Saving...' : dirty ? 'Save*' : 'Saved'}
            </button>
          )}
        </div>
      </div>

      <div className="editor-split">
        {(!isMarkdown || mdViewMode !== 'preview') && (
          <div className="codemirror-host" ref={editorContainerRef} />
        )}
        {isMarkdown && mdViewMode !== 'raw' && markdownCompiled && (
          <div
            className="markdown-preview-pane"
            dangerouslySetInnerHTML={{ __html: markdownCompiled.html }}
          />
        )}
      </div>
    </div>
  );
};
