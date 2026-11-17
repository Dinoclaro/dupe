import React, { useMemo, useRef, useState } from 'react';
import {
  Paper,
  ProjectConfig,
  ProjectTreeEntry,
  api,
} from '../../api/client';

interface ExplorerSidebarProps {
  papers: Paper[];
  projects: ProjectConfig[];
  activeProject: ProjectConfig | null;
  projectFiles: ProjectTreeEntry[];
  activeTabId: string | null;
  onSelectProject: (projectId: string) => void;
  onProjectsChanged: () => Promise<void>;
  onOpenPaper: (paper: Paper, inSplit: boolean) => void;
  onOpenProjectFile: (file: ProjectTreeEntry, inSplit: boolean) => void;
  onOpenCompiledPreview: (inSplit: boolean) => void;
  onCreateProjectFile: (kind: 'tex' | 'markdown' | 'diagram', name: string) => Promise<void>;
  onSyncProject: () => Promise<void>;
  onInsertCitation: (bibtexKey: string) => void;
  onPapersChanged: () => Promise<void>;
  onStatusMessage: (msg: string) => void;
}

export const ExplorerSidebar: React.FC<ExplorerSidebarProps> = ({
  papers,
  projects,
  activeProject,
  projectFiles,
  activeTabId,
  onSelectProject,
  onProjectsChanged,
  onOpenPaper,
  onOpenProjectFile,
  onOpenCompiledPreview,
  onCreateProjectFile,
  onSyncProject,
  onInsertCitation,
  onPapersChanged,
  onStatusMessage,
}) => {
  const sidebarRef = useRef<HTMLDivElement | null>(null);
  const [topRatio, setTopRatio] = useState(0.46);

  const [pdfSearch, setPdfSearch] = useState('');
  const [uploading, setUploading] = useState(false);
  const [editingPaperId, setEditingPaperId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editAuthors, setEditAuthors] = useState('');
  const [editBibKey, setEditBibKey] = useState('');
  const [editBibRaw, setEditBibRaw] = useState('');

  const [showNewProjectForm, setShowNewProjectForm] = useState(false);
  const [newProjName, setNewProjName] = useState('');
  const [newProjRemote, setNewProjRemote] = useState('');

  const [showProjectSettings, setShowProjectSettings] = useState(false);
  const [settingsRemote, setSettingsRemote] = useState('');
  const [syncingGit, setSyncingGit] = useState(false);

  const [newFileKind, setNewFileKind] = useState<'tex' | 'markdown' | 'diagram' | null>(null);
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

  const modifiedCount = useMemo(
    () => projectFiles.filter((f) => f.git_status === 'M' || f.git_status === 'U').length,
    [projectFiles],
  );

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

  const handleCreateProject = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!newProjName.trim()) {
      return;
    }
    setSyncingGit(true);
    try {
      const created = await api.createProject({
        name: newProjName.trim(),
        overleaf_remote: newProjRemote.trim(),
        link_all_papers: true,
      });
      setShowNewProjectForm(false);
      setNewProjName('');
      setNewProjRemote('');
      await onProjectsChanged();
      onSelectProject(created.id);
      onStatusMessage(`Created project "${created.name}" (${created.folder_name}/).`);
    } catch (err) {
      onStatusMessage(`Create project failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSyncingGit(false);
    }
  };

  const handleSaveProjectSettings = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!activeProject) {
      return;
    }
    setSyncingGit(true);
    try {
      await api.updateProject(activeProject.id, {
        overleaf_remote: settingsRemote.trim(),
      });
      setShowProjectSettings(false);
      await onProjectsChanged();
      onStatusMessage('Updated Overleaf GitHub remote and regenerated AGENTS.md + references.bib.');
    } catch (err) {
      onStatusMessage(`Project update failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSyncingGit(false);
    }
  };

  const handleTriggerSync = async () => {
    setSyncingGit(true);
    try {
      await onSyncProject();
    } finally {
      setSyncingGit(false);
    }
  };

  const submitNewFile = async (event: React.FormEvent) => {
    event.preventDefault();
    const cleaned = newFileName.trim();
    if (!cleaned || !newFileKind) {
      return;
    }
    await onCreateProjectFile(newFileKind, cleaned);
    setNewFileName('');
    setNewFileKind(null);
  };

  return (
    <aside className="vscode-sidebar" ref={sidebarRef}>
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
                    title={`${paper.title}\n${paper.authors}\n@${paper.bibtex_key}\n(Drag into editor to cite)`}
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

      {/* BOTTOM HALF: PROJECT FOLDER EXPLORER */}
      <section className="explorer-section" style={{ flex: `${1 - topRatio} 1 0%` }}>
        <div className="explorer-section-header">
          <span className="explorer-chevron">▾</span>
          <span className="explorer-section-title">
            PROJECT {modifiedCount > 0 ? `(${modifiedCount} changed)` : ''}
          </span>
          <div className="explorer-header-actions">
            <button
              type="button"
              className="icon-btn"
              title="New Project Folder"
              onClick={() => setShowNewProjectForm((v) => !v)}
            >
              + Proj
            </button>
            <button
              type="button"
              className="icon-btn"
              title="New LaTeX file in paper/"
              onClick={() => setNewFileKind((v) => (v === 'tex' ? null : 'tex'))}
            >
              + .tex
            </button>
            <button
              type="button"
              className="icon-btn"
              title="New Markdown note in notes/"
              onClick={() => setNewFileKind((v) => (v === 'markdown' ? null : 'markdown'))}
            >
              + Note
            </button>
            <button
              type="button"
              className="icon-btn"
              title="New Draw.io diagram in diagrams/"
              onClick={() => setNewFileKind((v) => (v === 'diagram' ? null : 'diagram'))}
            >
              + Fig
            </button>
          </div>
        </div>

        {/* Project selector & Sync bar */}
        <div className="git-sync-bar">
          <select
            value={activeProject?.id || ''}
            onChange={(e) => onSelectProject(e.target.value)}
            style={{ flex: 1 }}
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.folder_name}/)
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn-tiny"
            title="Configure Overleaf GitHub remote"
            onClick={() => {
              setSettingsRemote(activeProject?.overleaf_remote || '');
              setShowProjectSettings((v) => !v);
            }}
          >
            ⚙
          </button>
          <button
            type="button"
            className="btn-primary btn-tiny"
            disabled={syncingGit || !activeProject}
            onClick={() => void handleTriggerSync()}
            title="Regenerate AGENTS.md & references.bib, commit, and push paper/ to Overleaf GitHub"
          >
            {syncingGit ? 'Syncing…' : 'Sync'}
          </button>
        </div>

        {showNewProjectForm && (
          <form className="inline-bib-drawer" onSubmit={handleCreateProject}>
            <strong>Create Project Folder</strong>
            <input
              type="text"
              placeholder="Project Name (e.g. ICRA 2027 Paper)"
              value={newProjName}
              onChange={(e) => setNewProjName(e.target.value)}
              required
            />
            <input
              type="text"
              placeholder="Overleaf GitHub Remote URL (optional)"
              value={newProjRemote}
              onChange={(e) => setNewProjRemote(e.target.value)}
            />
            <div className="row-gap">
              <button type="submit" className="btn-primary btn-tiny" disabled={syncingGit}>
                Create Folder
              </button>
              <button
                type="button"
                className="btn-tiny"
                onClick={() => setShowNewProjectForm(false)}
              >
                Cancel
              </button>
            </div>
          </form>
        )}

        {showProjectSettings && activeProject && (
          <form className="inline-bib-drawer" onSubmit={handleSaveProjectSettings}>
            <strong>Overleaf GitHub Remote (paper/)</strong>
            <input
              type="text"
              placeholder="git@github.com:user/overleaf-paper.git"
              value={settingsRemote}
              onChange={(e) => setSettingsRemote(e.target.value)}
            />
            <div className="row-gap">
              <button type="submit" className="btn-primary btn-tiny" disabled={syncingGit}>
                Save Remote
              </button>
              <button
                type="button"
                className="btn-tiny"
                onClick={() => setShowProjectSettings(false)}
              >
                Close
              </button>
            </div>
          </form>
        )}

        {newFileKind && (
          <form className="inline-new-file-form" onSubmit={(e) => void submitNewFile(e)}>
            <input
              type="text"
              placeholder={
                newFileKind === 'tex'
                  ? 'paper/methods.tex'
                  : newFileKind === 'markdown'
                    ? 'notes/ideas.md'
                    : 'diagrams/system_arch'
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

        <div className="explorer-tree-list">
          {/* Virtual Compiled PDF item at top of project */}
          <div
            className={`tree-row ${activeTabId === 'preview:compiled' ? 'active' : ''}`}
            onClick={() => onOpenCompiledPreview(false)}
          >
            <span className="file-icon compiled-icon">OUT</span>
            <div className="tree-label-col">
              <span className="tree-primary-text">Compiled Paper Preview</span>
              <span className="tree-sub-text">Live LaTeX / Markdown output</span>
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
                  : file.kind === 'markdown'
                    ? 'MD'
                    : file.kind === 'diagram'
                      ? 'FIG'
                      : 'FILE';
            const cleanStem = file.path
              .replace(/^(diagrams|paper\/figures)\//, '')
              .replace(/\.(drawio\.svg|drawio|excalidraw|svg)$/i, '');
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
                  file.git_status
                    ? `${file.path} (${file.git_status === 'M' ? 'Modified vs HEAD — click to review inline diff' : 'Untracked'})`
                    : file.path
                }
              >
                <span className={`file-icon kind-${file.kind}`}>{badge}</span>
                <div className="tree-label-col">
                  <span className="tree-primary-text">{file.path}</span>
                </div>
                <div className="tree-row-actions" onClick={(e) => e.stopPropagation()}>
                  {file.git_status && (
                    <span
                      className={`git-badge git-badge-${file.git_status.toLowerCase()}`}
                      title={
                        file.git_status === 'M'
                          ? 'Modified against Git HEAD'
                          : 'Untracked file'
                      }
                    >
                      {file.git_status}
                    </span>
                  )}
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
