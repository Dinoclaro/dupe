import React, { useMemo, useRef, useState } from 'react';
import { GitRepo, Paper, api } from '../../api/client';

export interface ProjectFileItem {
  path: string;
  kind: 'tex' | 'bib' | 'diagram' | 'other';
}

interface ExplorerSidebarProps {
  papers: Paper[];
  projectFiles: ProjectFileItem[];
  activeTabId: string | null;
  repos: GitRepo[];
  activeRepoId: string | null;
  onOpenPaper: (paper: Paper, inSplit: boolean) => void;
  onOpenProjectFile: (file: ProjectFileItem, inSplit: boolean) => void;
  onOpenCompiledPreview: (inSplit: boolean) => void;
  onOpenTerminal: (inSplit: boolean) => void;
  onCreateTexFile: (filename: string) => void;
  onCreateDiagramFile: (figureName: string) => void;
  onInsertCitation: (bibtexKey: string) => void;
  onPapersChanged: () => Promise<void>;
  onReposChanged: () => Promise<void>;
  onSelectRepo: (repoId: string) => void;
  onStatusMessage: (msg: string) => void;
}

export const ExplorerSidebar: React.FC<ExplorerSidebarProps> = ({
  papers,
  projectFiles,
  activeTabId,
  repos,
  activeRepoId,
  onOpenPaper,
  onOpenProjectFile,
  onOpenCompiledPreview,
  onOpenTerminal,
  onCreateTexFile,
  onCreateDiagramFile,
  onInsertCitation,
  onPapersChanged,
  onReposChanged,
  onSelectRepo,
  onStatusMessage,
}) => {
  const sidebarRef = useRef<HTMLDivElement | null>(null);
  const [topRatio, setTopRatio] = useState(0.52);

  const [pdfSearch, setPdfSearch] = useState('');
  const [uploading, setUploading] = useState(false);
  const [editingPaperId, setEditingPaperId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editAuthors, setEditAuthors] = useState('');
  const [editBibKey, setEditBibKey] = useState('');
  const [editBibRaw, setEditBibRaw] = useState('');

  const [showRepoModal, setShowRepoModal] = useState(false);
  const [repoUrl, setRepoUrl] = useState('');
  const [repoName, setRepoName] = useState('');
  const [syncingGit, setSyncingGit] = useState(false);

  const [showNewFileInput, setShowNewFileInput] = useState<'tex' | 'diagram' | null>(null);
  const [newFileName, setNewFileName] = useState('');

  const filteredPapers = useMemo(() => {
    const q = pdfSearch.trim().toLowerCase();
    if (!q) {
      return papers;
    }
    return papers.filter(
      (p) =>
        p.title.toLowerCase().includes(q) ||
        p.authors.toLowerCase().includes(q) ||
        p.bibtex_key.toLowerCase().includes(q) ||
        p.doi.toLowerCase().includes(q),
    );
  }, [papers, pdfSearch]);

  const handleVerticalSplitDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const container = sidebarRef.current;
    if (!container) {
      return;
    }
    const rect = container.getBoundingClientRect();

    const onMove = (moveEvent: PointerEvent) => {
      const relY = moveEvent.clientY - rect.top;
      const nextRatio = Math.max(0.2, Math.min(0.8, relY / Math.max(1, rect.height)));
      setTopRatio(nextRatio);
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const handleUploadFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) {
      return;
    }
    setUploading(true);
    try {
      const created = await api.uploadPapers(files);
      await onPapersChanged();
      if (created.length > 0) {
        onOpenPaper(created[0], false);
      }
      onStatusMessage(`Uploaded ${created.length} PDF(s) and extracted BibTeX.`);
    } catch (err) {
      onStatusMessage(`Upload failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setUploading(false);
    }
  };

  const openBibEditor = (paper: Paper, event: React.MouseEvent) => {
    event.stopPropagation();
    if (editingPaperId === paper.id) {
      setEditingPaperId(null);
      return;
    }
    setEditingPaperId(paper.id);
    setEditTitle(paper.title);
    setEditAuthors(paper.authors);
    setEditBibKey(paper.bibtex_key);
    setEditBibRaw(paper.bibtex_raw);
  };

  const saveBibEditor = async (paperId: string) => {
    try {
      await api.updatePaper(paperId, {
        title: editTitle,
        authors: editAuthors,
        bibtex_key: editBibKey,
        bibtex_raw: editBibRaw,
      });
      setEditingPaperId(null);
      await onPapersChanged();
      onStatusMessage('Updated paper metadata and BibTeX.');
    } catch (err) {
      onStatusMessage(`Update failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleLinkRepo = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!repoUrl.trim()) {
      return;
    }
    setSyncingGit(true);
    try {
      const created = await api.createRepo({
        name: repoName.trim(),
        remote_url: repoUrl.trim(),
        bib_file_path: 'references.bib',
      });
      setShowRepoModal(false);
      setRepoUrl('');
      setRepoName('');
      await onReposChanged();
      onSelectRepo(created.id);
      onStatusMessage(`Linked GitHub/Overleaf repo "${created.name}".`);
    } catch (err) {
      onStatusMessage(`Git clone failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSyncingGit(false);
    }
  };

  const handleSyncGit = async () => {
    if (!activeRepoId) {
      return;
    }
    setSyncingGit(true);
    try {
      const res = await api.syncRepo(activeRepoId);
      await onReposChanged();
      onStatusMessage(
        res.committed
          ? `Pushed ${res.bib_entries} BibTeX entries & project files (${res.commit_sha?.slice(0, 7) || 'HEAD'}) to GitHub.`
          : `Synced ${res.bib_entries} BibTeX entries (working tree clean).`,
      );
    } catch (err) {
      onStatusMessage(`Git sync error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSyncingGit(false);
    }
  };

  const submitNewFile = (event: React.FormEvent) => {
    event.preventDefault();
    const cleaned = newFileName.trim();
    if (!cleaned || !showNewFileInput) {
      return;
    }
    if (showNewFileInput === 'tex') {
      onCreateTexFile(cleaned.endsWith('.tex') ? cleaned : `${cleaned}.tex`);
    } else {
      onCreateDiagramFile(cleaned.replace(/\.(svg|excalidraw)$/i, ''));
    }
    setNewFileName('');
    setShowNewFileInput(null);
  };

  const activeRepo = repos.find((r) => r.id === activeRepoId) || null;

  return (
    <aside className="studio-sidebar" ref={sidebarRef}>
      {/* TOP HALF: PDF LIBRARY EXPLORER */}
      <section className="explorer-section" style={{ flex: `${topRatio} 1 0%` }}>
        <div className="explorer-section-header">
          <span className="explorer-chevron">▾</span>
          <span className="explorer-section-title">PDF LIBRARY ({papers.length})</span>
          <div className="explorer-header-actions">
            <label className="icon-btn" title="Upload PDF(s) and extract BibTeX">
              <input
                type="file"
                accept="application/pdf,.pdf"
                multiple
                disabled={uploading}
                onChange={(e) => void handleUploadFiles(e.target.files)}
              />
              {uploading ? '…' : '+ PDF'}
            </label>
          </div>
        </div>

        <div className="explorer-search-row">
          <input
            type="search"
            placeholder="Filter papers (@key, title, author)..."
            value={pdfSearch}
            onChange={(e) => setPdfSearch(e.target.value)}
          />
        </div>

        <div className="explorer-tree-list">
          {filteredPapers.length === 0 ? (
            <div className="explorer-empty">
              Upload PDFs with <strong>+ PDF</strong> to populate your library and auto-generate BibTeX.
            </div>
          ) : (
            filteredPapers.map((paper) => {
              const tabId = `pdf:${paper.id}`;
              const isSelected = activeTabId === tabId;
              const isEditing = editingPaperId === paper.id;
              return (
                <div key={paper.id} className="tree-item-group">
                  <div
                    className={`tree-row ${isSelected ? 'active' : ''}`}
                    draggable={Boolean(paper.bibtex_key)}
                    onDragStart={(e) => {
                      if (paper.bibtex_key) {
                        e.dataTransfer.setData('text/plain', `\\cite{${paper.bibtex_key}}`);
                      }
                    }}
                    onClick={() => onOpenPaper(paper, false)}
                    title={`${paper.title}\n${paper.authors}\n@${paper.bibtex_key}\n(Drag into LaTeX editor to cite)`}
                  >
                    <span className="file-icon pdf-icon">PDF</span>
                    <div className="tree-label-col">
                      <span className="tree-primary-text">{paper.title}</span>
                      <span className="tree-sub-text">
                        <code>@{paper.bibtex_key || 'nokey'}</code>
                        {paper.publication_year ? ` · ${paper.publication_year}` : ''}
                      </span>
                    </div>
                    <div className="tree-row-actions" onClick={(e) => e.stopPropagation()}>
                      {paper.bibtex_key && (
                        <button
                          type="button"
                          className="tree-action-btn"
                          title={`Insert \\cite{${paper.bibtex_key}}`}
                          onClick={() => onInsertCitation(paper.bibtex_key)}
                        >
                          \cite
                        </button>
                      )}
                      <button
                        type="button"
                        className="tree-action-btn"
                        title="Edit BibTeX entry"
                        onClick={(e) => openBibEditor(paper, e)}
                      >
                        Bib
                      </button>
                      <button
                        type="button"
                        className="tree-action-btn"
                        title="Open PDF in Right Split"
                        onClick={() => onOpenPaper(paper, true)}
                      >
                        ◫
                      </button>
                    </div>
                  </div>

                  {isEditing && (
                    <div className="inline-bib-drawer">
                      <input
                        type="text"
                        value={editTitle}
                        onChange={(e) => setEditTitle(e.target.value)}
                        placeholder="Title"
                      />
                      <input
                        type="text"
                        value={editAuthors}
                        onChange={(e) => setEditAuthors(e.target.value)}
                        placeholder="Authors"
                      />
                      <input
                        type="text"
                        value={editBibKey}
                        onChange={(e) => setEditBibKey(e.target.value)}
                        placeholder="BibTeX key"
                      />
                      <textarea
                        rows={5}
                        value={editBibRaw}
                        onChange={(e) => setEditBibRaw(e.target.value)}
                      />
                      <div className="row-gap">
                        <button
                          type="button"
                          className="btn-primary btn-tiny"
                          onClick={() => void saveBibEditor(paper.id)}
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          className="btn-tiny"
                          onClick={() => setEditingPaperId(null)}
                        >
                          Close
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </section>

      {/* HORIZONTAL RESIZE HANDLE */}
      <div
        className="sidebar-split-handle"
        role="separator"
        aria-orientation="horizontal"
        onPointerDown={handleVerticalSplitDrag}
      />

      {/* BOTTOM HALF: LATEX PROJECT EXPLORER */}
      <section className="explorer-section" style={{ flex: `${1 - topRatio} 1 0%` }}>
        <div className="explorer-section-header">
          <span className="explorer-chevron">▾</span>
          <span className="explorer-section-title">
            LATEX PROJECT {activeRepo ? `(${activeRepo.name})` : ''}
          </span>
          <div className="explorer-header-actions">
            <button
              type="button"
              className="icon-btn"
              title="New .tex file"
              onClick={() =>
                setShowNewFileInput((v) => (v === 'tex' ? null : 'tex'))
              }
            >
              + .tex
            </button>
            <button
              type="button"
              className="icon-btn"
              title="New Excalidraw diagram"
              onClick={() =>
                setShowNewFileInput((v) => (v === 'diagram' ? null : 'diagram'))
              }
            >
              + Fig
            </button>
            <button
              type="button"
              className="icon-btn"
              title="Link Overleaf/GitHub repository"
              onClick={() => setShowRepoModal((v) => !v)}
            >
              Git
            </button>
          </div>
        </div>

        {showNewFileInput && (
          <form className="inline-new-file-form" onSubmit={submitNewFile}>
            <input
              type="text"
              placeholder={
                showNewFileInput === 'tex' ? 'section_intro.tex' : 'system_diagram'
              }
              value={newFileName}
              onChange={(e) => setNewFileName(e.target.value)}
              autoFocus
            />
            <button type="submit" className="btn-primary btn-tiny">
              Add
            </button>
          </form>
        )}

        {showRepoModal && (
          <form className="inline-bib-drawer" onSubmit={handleLinkRepo}>
            <input
              type="text"
              placeholder="git@github.com:user/overleaf-paper.git"
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
              required
            />
            <input
              type="text"
              placeholder="Project display name (optional)"
              value={repoName}
              onChange={(e) => setRepoName(e.target.value)}
            />
            <button type="submit" className="btn-primary btn-tiny" disabled={syncingGit}>
              {syncingGit ? 'Cloning...' : 'Clone Overleaf GitHub Repo'}
            </button>
          </form>
        )}

        {activeRepo && (
          <div className="git-sync-bar">
            <span className="truncate-text" title={activeRepo.remote_url}>
              ⎇ {activeRepo.name}
            </span>
            <button
              type="button"
              className="btn-primary btn-tiny"
              disabled={syncingGit}
              onClick={() => void handleSyncGit()}
            >
              {syncingGit ? 'Syncing…' : 'Sync & Push'}
            </button>
          </div>
        )}

        <div className="explorer-tree-list">
          {/* Interactive Terminal item in project */}
          <div
            className={`tree-row ${activeTabId === 'terminal:main' ? 'active' : ''}`}
            onClick={() => onOpenTerminal(false)}
          >
            <span className="file-icon term-icon">CLI</span>
            <div className="tree-label-col">
              <span className="tree-primary-text">Interactive Terminal</span>
              <span className="tree-sub-text">Antigravity / Claude / Shell</span>
            </div>
            <div className="tree-row-actions" onClick={(e) => e.stopPropagation()}>
              <button
                type="button"
                className="tree-action-btn"
                title="Open Terminal in Right Split"
                onClick={() => onOpenTerminal(true)}
              >
                ◫
              </button>
            </div>
          </div>

          {/* Virtual Compiled PDF item at top of project */}
          <div
            className={`tree-row ${activeTabId === 'preview:compiled' ? 'active' : ''}`}
            onClick={() => onOpenCompiledPreview(false)}
          >
            <span className="file-icon compiled-icon">OUT</span>
            <div className="tree-label-col">
              <span className="tree-primary-text">Compiled Paper Preview</span>
              <span className="tree-sub-text">Live LaTeX output</span>
            </div>
            <div className="tree-row-actions" onClick={(e) => e.stopPropagation()}>
              <button
                type="button"
                className="tree-action-btn"
                title="Open Compiled Preview in Right Split"
                onClick={() => onOpenCompiledPreview(true)}
              >
                ◫
              </button>
            </div>
          </div>

          {projectFiles.map((file) => {
            const tabId = `file:${file.path}`;
            const isSelected = activeTabId === tabId;
            const badge =
              file.kind === 'tex'
                ? 'TEX'
                : file.kind === 'bib'
                  ? 'BIB'
                  : file.kind === 'diagram'
                    ? 'FIG'
                    : 'FILE';
            const cleanStem = file.path
              .replace(/^figures\//, '')
              .replace(/\.(drawio|excalidraw|svg)$/i, '');
            const svgRelPath = `figures/${cleanStem}.svg`;
            return (
              <div
                key={file.path}
                className={`tree-row ${isSelected ? 'active' : ''}`}
                draggable={file.kind === 'diagram'}
                onDragStart={(e) => {
                  if (file.kind === 'diagram') {
                    e.dataTransfer.setData(
                      'text/plain',
                      `\\begin{figure}[h]\n  \\centering\n  \\includegraphics[width=0.8\\linewidth]{${svgRelPath}}\n  \\caption{${cleanStem.replace(/_/g, ' ')}}\n  \\label{fig:${cleanStem}}\n\\end{figure}`,
                    );
                  }
                }}
                onClick={() => onOpenProjectFile(file, false)}
                title={
                  file.kind === 'tex'
                    ? `${file.path} (Click to open LaTeX source + Compiled Preview)`
                    : file.kind === 'diagram'
                      ? `${file.path} (Click to edit in Draw.io, or drag into .tex editor)`
                      : file.path
                }
              >
                <span className={`file-icon kind-${file.kind}`}>{badge}</span>
                <div className="tree-label-col">
                  <span className="tree-primary-text">{file.path}</span>
                </div>
                <div className="tree-row-actions" onClick={(e) => e.stopPropagation()}>
                  <button
                    type="button"
                    className="tree-action-btn"
                    title="Open in Right Split"
                    onClick={() => onOpenProjectFile(file, true)}
                  >
                    ◫
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </aside>
  );
};
