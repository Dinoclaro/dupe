import React, { useEffect, useMemo, useRef, useState } from 'react';
import { EditorState, Extension } from '@codemirror/state';
import {
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { openSearchPanel, search, searchKeymap } from '@codemirror/search';
import { autocompletion, closeBrackets } from '@codemirror/autocomplete';
import { StreamLanguage, bracketMatching } from '@codemirror/language';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { markdown } from '@codemirror/lang-markdown';
import { unifiedMergeView } from '@codemirror/merge';
import { oneDark } from '@codemirror/theme-one-dark';
import { CompileProjectResponse, Paper } from '../../api/client';
import { renderMarkdownPreview } from '../../workers/latexCompiler';
import { createCitationCompletionSource } from './citationCompletion';
import {
  commentMarkerExtensions,
  resolveCommentAnchors,
  setCommentAnchorsEffect,
} from './commentMarkers';
import {
  checkLatexStructure,
  latexDiagnosticExtensions,
  matchDiagnosticsForFile,
  normalizeDiagnosticRelPath,
  setLatexDiagnosticsEffect,
} from './latexDiagnostics';

const editorViewportCache = new Map<
  string,
  { anchor: number; head: number; scrollTop: number }
>();

interface LatexEditorPaneProps {
  fileLabel: string;
  source: string;
  headContent?: string;
  hasExternalAgentEdit?: boolean;
  papers: Paper[];
  saving: boolean;
  dirty?: boolean;
  readOnly?: boolean;
  commentsMd?: string;
  compileResult?: CompileProjectResponse | null;
  compilingPdf?: boolean;
  autoCompile?: boolean;
  onToggleAutoCompile?: () => void;
  jumpToLine?: { line: number; seq: number } | null;
  onChangeSource: (next: string) => void;
  onSaveSource: (contentOverride?: string) => Promise<void>;
  onRevertToHead?: () => Promise<void>;
  onAcceptAgentEdits?: () => void;
  onOpenPreviewSplit?: () => void;
  onJumpToFile?: (relPath: string, line?: number) => void;
  onForwardSyncTex?: (fileLabel: string, line: number) => void;
  onAddComment?: (source: string, location: string, quote: string, comment: string) => Promise<void>;
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
  commentsMd = '',
  compileResult = null,
  compilingPdf = false,
  autoCompile = false,
  onToggleAutoCompile,
  jumpToLine = null,
  onChangeSource,
  onSaveSource,
  onRevertToHead,
  onAcceptAgentEdits,
  onOpenPreviewSplit,
  onJumpToFile,
  onForwardSyncTex,
  onAddComment,
  registerInsertSnippet,
}) => {
  const editorContainerRef = useRef<HTMLDivElement | null>(null);
  const editorViewRef = useRef<EditorView | null>(null);
  const isApplyingSyncRef = useRef<boolean>(false);
  const pendingOpenFindRef = useRef<boolean>(false);
  const papersRef = useRef<Paper[]>(papers);
  papersRef.current = papers;

  const onChangeRef = useRef(onChangeSource);
  onChangeRef.current = onChangeSource;

  const onSaveRef = useRef(onSaveSource);
  onSaveRef.current = onSaveSource;

  const isMarkdown = fileLabel.endsWith('.md');
  const isTex = fileLabel.endsWith('.tex');
  const [diffEnabled, setDiffEnabled] = useState<boolean>(false);
  const [mdViewMode, setMdViewMode] = useState<'preview' | 'split' | 'raw'>(
    isMarkdown ? (readOnly ? 'preview' : 'raw') : 'raw',
  );
  const [showCommentBox, setShowCommentBox] = useState(false);
  const [showCommentsList, setShowCommentsList] = useState(false);
  const [commentQuote, setCommentQuote] = useState('');
  const [commentLocation, setCommentLocation] = useState('');
  const [commentText, setCommentText] = useState('');
  const [submittingComment, setSubmittingComment] = useState(false);
  const [dismissedBannerVersion, setDismissedBannerVersion] = useState<string>('');

  const fileCommentAnchors = useMemo(
    () => resolveCommentAnchors(commentsMd, fileLabel, source),
    [commentsMd, fileLabel, source],
  );

  const structuralDiagnostics = useMemo(
    () => (isTex && !readOnly ? checkLatexStructure(source, fileLabel) : []),
    [isTex, readOnly, source, fileLabel],
  );

  const fileDiagnostics = useMemo(() => {
    if (!isTex) {
      return [];
    }
    const compilerDiags = matchDiagnosticsForFile(compileResult, fileLabel);
    return [...compilerDiags, ...structuralDiagnostics];
  }, [isTex, compileResult, fileLabel, structuralDiagnostics]);

  const openCommentDrawer = () => {
    const view = editorViewRef.current;
    if (view) {
      const sel = view.state.selection.main;
      const startLine = view.state.doc.lineAt(sel.from).number;
      const endLine = view.state.doc.lineAt(sel.to).number;
      const selected = view.state.sliceDoc(sel.from, sel.to).trim();
      const fallbackLine = view.state.doc.line(startLine).text.trim();
      setCommentQuote(selected || fallbackLine);
      setCommentLocation(startLine === endLine ? `line ${startLine}` : `lines ${startLine}-${endLine}`);
    } else {
      const domSel = window.getSelection()?.toString().trim() || '';
      setCommentQuote(domSel);
      setCommentLocation('');
    }
    setShowCommentBox((v) => !v);
  };

  const handleSubmitComment = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!onAddComment || !commentText.trim()) {
      return;
    }
    setSubmittingComment(true);
    try {
      await onAddComment(fileLabel, commentLocation, commentQuote, commentText.trim());
      setCommentText('');
      setShowCommentBox(false);
    } finally {
      setSubmittingComment(false);
    }
  };

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
      highlightActiveLineGutter(),
      highlightActiveLine(),
      bracketMatching(),
      closeBrackets(),
      ...latexDiagnosticExtensions,
      ...commentMarkerExtensions,
      history(),
      search(),
      keymap.of([
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
        {
          key: 'Mod-s',
          run: (view) => {
            if (!readOnly) {
              void onSaveRef.current(view.state.doc.toString());
            }
            return true;
          },
        },
      ]),
      langExt,
      oneDark,
      EditorView.lineWrapping,
      EditorView.contentAttributes.of({
        spellcheck: 'true',
        autocorrect: 'on',
        autocapitalize: 'sentences',
      }),
      EditorState.readOnly.of(readOnly),
      autocompletion({
        override: [createCitationCompletionSource(() => papersRef.current, isMarkdown)],
        activateOnTyping: true,
      }),
      EditorView.updateListener.of((update) => {
        if (update.docChanged && !isApplyingSyncRef.current) {
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

    const cachedViewport = editorViewportCache.get(fileLabel);
    const initialAnchor = cachedViewport
      ? Math.min(cachedViewport.anchor, source.length)
      : 0;
    const initialHead = cachedViewport
      ? Math.min(cachedViewport.head, source.length)
      : 0;

    const state = EditorState.create({
      doc: source,
      selection: { anchor: initialAnchor, head: initialHead },
      extensions,
    });

    const view = new EditorView({
      state,
      parent: container,
    });
    editorViewRef.current = view;

    if (cachedViewport && cachedViewport.scrollTop > 0) {
      window.requestAnimationFrame(() => {
        view.scrollDOM.scrollTop = cachedViewport.scrollTop;
      });
    }

    if (fileCommentAnchors.length > 0) {
      view.dispatch({
        effects: setCommentAnchorsEffect.of(fileCommentAnchors),
      });
    }
    if (fileDiagnostics.length > 0) {
      view.dispatch({
        effects: setLatexDiagnosticsEffect.of(fileDiagnostics),
      });
    }

    if (pendingOpenFindRef.current) {
      pendingOpenFindRef.current = false;
      openSearchPanel(view);
      view.focus();
    }

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
      const sel = view.state.selection.main;
      editorViewportCache.set(fileLabel, {
        anchor: sel.anchor,
        head: sel.head,
        scrollTop: view.scrollDOM.scrollTop,
      });
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
      const prevSel = view.state.selection.main;
      const prevScrollTop = view.scrollDOM.scrollTop;
      isApplyingSyncRef.current = true;
      try {
        view.dispatch({
          changes: { from: 0, to: currentText.length, insert: source },
          selection: {
            anchor: Math.min(prevSel.anchor, source.length),
            head: Math.min(prevSel.head, source.length),
          },
        });
      } finally {
        isApplyingSyncRef.current = false;
      }
      window.requestAnimationFrame(() => {
        if (editorViewRef.current === view) {
          view.scrollDOM.scrollTop = prevScrollTop;
        }
      });
    }
  }, [source]);

  useEffect(() => {
    const view = editorViewRef.current;
    if (!view) {
      return;
    }
    view.dispatch({
      effects: setCommentAnchorsEffect.of(fileCommentAnchors),
    });
  }, [fileCommentAnchors]);

  useEffect(() => {
    const view = editorViewRef.current;
    if (!view) {
      return;
    }
    view.dispatch({
      effects: setLatexDiagnosticsEffect.of(fileDiagnostics),
    });
  }, [fileDiagnostics]);

  useEffect(() => {
    if (!jumpToLine || jumpToLine.line < 1) {
      return;
    }
    if (isMarkdown && mdViewMode === 'preview') {
      setMdViewMode('split');
    }
    const applyJump = () => {
      const view = editorViewRef.current;
      if (!view) {
        return;
      }
      const clampedLine = Math.min(
        Math.max(1, jumpToLine.line),
        view.state.doc.lines,
      );
      const lineInfo = view.state.doc.line(clampedLine);
      view.dispatch({
        selection: { anchor: lineInfo.from, head: lineInfo.to },
        effects: EditorView.scrollIntoView(lineInfo.from, { y: 'center' }),
      });
      view.focus();
    };
    const timer = window.setTimeout(applyJump, 40);
    return () => window.clearTimeout(timer);
  }, [jumpToLine, isMarkdown, mdViewMode]);

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
          {isTex && onForwardSyncTex && (
            <button
              type="button"
              className="btn-tiny"
              onClick={() => {
                const view = editorViewRef.current;
                const line = view
                  ? view.state.doc.lineAt(view.state.selection.main.head).number
                  : 1;
                onForwardSyncTex(fileLabel, line);
              }}
              title="Locate current LaTeX line in the compiled PDF (Forward SyncTeX)"
            >
              📍 To PDF
            </button>
          )}
          <button
            type="button"
            className="btn-tiny"
            onClick={() => {
              if (isMarkdown && mdViewMode === 'preview') {
                pendingOpenFindRef.current = true;
                setMdViewMode('split');
                return;
              }
              if (editorViewRef.current) {
                openSearchPanel(editorViewRef.current);
                editorViewRef.current.focus();
              }
            }}
            title="Find in file (Ctrl+F)"
          >
            🔍 Find
          </button>
          {fileCommentAnchors.length > 0 && (
            <button
              type="button"
              className={`btn-tiny ${showCommentsList ? 'active-btn' : ''}`}
              onClick={() => setShowCommentsList((v) => !v)}
              title="Show commented passages in this file"
            >
              💬 {fileCommentAnchors.filter((a) => a.comment.open).length || fileCommentAnchors.length}
            </button>
          )}
          {onAddComment && (
            <button
              type="button"
              className={`btn-tiny ${showCommentBox ? 'active-btn' : ''}`}
              onClick={openCommentDrawer}
              title="Highlight text and add a comment to notes/comments.md for the coding agent"
            >
              + Comment
            </button>
          )}
          {!readOnly && (
            <>
              <span
                className="muted-hint"
                style={{ fontSize: 11, padding: '0 4px' }}
                title="Changes auto-save to disk automatically after 0.8s"
              >
                {saving ? '↻ Auto-saving…' : dirty ? '● Unsaved…' : '✓ Auto-saved'}
              </span>
              {isTex && onToggleAutoCompile && (
                <button
                  type="button"
                  className={`btn-tiny ${autoCompile ? 'active-btn' : ''}`}
                  onClick={onToggleAutoCompile}
                  title="Automatically recompile PDF ~2.5s after you pause typing"
                >
                  {autoCompile ? '⚡ Auto: ON' : '⚡ Auto: OFF'}
                </button>
              )}
              {!isMarkdown && (
                <button
                  type="button"
                  className="btn-primary btn-tiny"
                  disabled={saving || compilingPdf}
                  onClick={() => {
                    const liveText = editorViewRef.current?.state.doc.toString();
                    void onSaveSource(liveText);
                  }}
                  title="Save and recompile LaTeX PDF (Ctrl+S)"
                >
                  {compilingPdf ? '↻ Compiling…' : '⟳ Compile PDF'}
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {isTex &&
        (() => {
          const compilerErrs = compileResult?.errors || [];
          const hasCompilerFailure = Boolean(
            compileResult && (!compileResult.success || compilerErrs.length > 0),
          );
          const allBannerErrors =
            compilerErrs.length > 0 ? compilerErrs : structuralDiagnostics;
          if (!hasCompilerFailure && structuralDiagnostics.length === 0) {
            return null;
          }
          const isCompilerFault = compileResult?.failure_kind === 'compiler';
          const bannerSig = `${compileResult?.duration_ms || 0}:${allBannerErrors
            .map((e) => `${e.file}:${e.line || 0}:${e.message}`)
            .join('|')}`;
          if (dismissedBannerVersion === bannerSig) {
            return null;
          }
          return (
            <div
              className={`tex-diag-banner ${isCompilerFault ? 'compiler' : 'latex-code'}`}
            >
              <div className="tex-diag-banner-head">
                <strong>
                  {isCompilerFault
                    ? '⚙ Compiler / Server Issue (not your LaTeX syntax)'
                    : compilerErrs.length > 0
                      ? `✕ LaTeX Code Error (${compilerErrs.length})`
                      : `✕ LaTeX Syntax Check (${structuralDiagnostics.length})`}
                </strong>
                <button
                  type="button"
                  className="btn-tiny"
                  onClick={() => setDismissedBannerVersion(bannerSig)}
                >
                  Dismiss
                </button>
              </div>
              <div className="tex-diag-banner-list">
                {allBannerErrors.slice(0, 4).map((errItem, idx) => {
                  const targetRel =
                    normalizeDiagnosticRelPath(errItem.file) || fileLabel;
                  return (
                    <button
                      key={`banner-err-${idx}`}
                      type="button"
                      className="tex-diag-chip"
                      onClick={() => {
                        if (targetRel === fileLabel && editorViewRef.current) {
                          const ln = Math.min(
                            Math.max(1, errItem.line || 1),
                            editorViewRef.current.state.doc.lines,
                          );
                          const info = editorViewRef.current.state.doc.line(ln);
                          editorViewRef.current.dispatch({
                            selection: { anchor: info.from, head: info.to },
                            effects: EditorView.scrollIntoView(info.from, { y: 'center' }),
                          });
                          editorViewRef.current.focus();
                        } else if (onJumpToFile) {
                          onJumpToFile(targetRel, errItem.line);
                        }
                      }}
                      title="Click to jump directly to this line"
                    >
                      <code>
                        {targetRel}
                        {errItem.line ? `:${errItem.line}` : ''}
                      </code>{' '}
                      <span>{errItem.message}</span>
                      {errItem.context && (
                        <code className="tex-diag-chip-ctx">{errItem.context}</code>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })()}

      {showCommentsList && fileCommentAnchors.length > 0 && (
        <div className="inline-bib-drawer">
          <div className="row-gap" style={{ justifyContent: 'space-between' }}>
            <strong>Comments in {fileLabel}</strong>
            <button type="button" className="btn-tiny" onClick={() => setShowCommentsList(false)}>
              Close
            </button>
          </div>
          {fileCommentAnchors.map((anchor, idx) => (
            <div
              key={`${anchor.line}-${idx}`}
              className="tree-row"
              onClick={() => {
                const view = editorViewRef.current;
                if (view && anchor.line >= 1 && anchor.line <= view.state.doc.lines) {
                  const lineInfo = view.state.doc.line(anchor.line);
                  view.dispatch({
                    selection: {
                      anchor: anchor.from ?? lineInfo.from,
                      head: anchor.to ?? lineInfo.to,
                    },
                    effects: EditorView.scrollIntoView(anchor.from ?? lineInfo.from, { y: 'center' }),
                  });
                  view.focus();
                }
              }}
              title="Click to jump to commented line"
            >
              <span className="file-icon">{anchor.comment.open ? '💬' : '✓'}</span>
              <div className="tree-label-col">
                <span className="tree-primary-text">
                  Line {anchor.line}: {anchor.comment.comment}
                </span>
                {anchor.comment.quote && (
                  <span className="tree-sub-text">&ldquo;{anchor.comment.quote}&rdquo;</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {showCommentBox && onAddComment && (
        <form className="inline-bib-drawer" onSubmit={(e) => void handleSubmitComment(e)}>
          <div className="row-gap" style={{ justifyContent: 'space-between' }}>
            <strong>
              Comment on <code>{fileLabel}</code> {commentLocation ? `(${commentLocation})` : ''}
            </strong>
            <span className="muted-hint">Saved to notes/comments.md &amp; AGENTS.md</span>
          </div>
          <input
            type="text"
            placeholder="Quoted selection (optional)"
            value={commentQuote}
            onChange={(e) => setCommentQuote(e.target.value)}
          />
          <input
            type="text"
            placeholder="Instruction or note for the coding agent..."
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
