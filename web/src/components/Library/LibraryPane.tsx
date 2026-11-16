import React, { useMemo, useState } from 'react';
import { GitRepo, Paper, api } from '../../api/client';

interface LibraryPaneProps {
  papers: Paper[];
  selectedPaperId: string | null;
  repos: GitRepo[];
  activeRepoId: string | null;
  repoFiles: string[];
  onSelectPaper: (paper: Paper) => void;
  onInsertCitation: (bibtexKey: string) => void;
  onPapersChanged: () => Promise<void>;
  onReposChanged: () => Promise<void>;
  onSelectRepo: (repoId: string) => void;
  onOpenRepoFile: (repoId: string, filePath: string) => Promise<void>;
  onStatusMessage: (msg: string) => void;
}

export const LibraryPane: React.FC<LibraryPaneProps> = ({
  papers,
  selectedPaperId,
  repos,
  activeRepoId,
  repoFiles,
  onSelectPaper,
  onInsertCitation,
  onPapersChanged,
  onReposChanged,
  onSelectRepo,
  onOpenRepoFile,
  onStatusMessage,
}) => {
  const [search, setSearch] = useState('');
  const [selectedTag, setSelectedTag] = useState<string>('');
  const [uploading, setUploading] = useState(false);
  const [editingPaperId, setEditingPaperId] = useState<string | null>(null);
  const [editBibKey, setEditBibKey] = useState('');
  const [editBibRaw, setEditBibRaw] = useState('');
  const [editTitle, setEditTitle] = useState('');
  const [editAuthors, setEditAuthors] = useState('');
  const [editTags, setEditTags] = useState('');

  const [showNewRepoForm, setShowNewRepoForm] = useState(false);
  const [repoName, setRepoName] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [repoBibPath, setRepoBibPath] = useState('references.bib');
  const [syncingRepo, setSyncingRepo] = useState(false);

  const allTags = useMemo(() => {
    const set = new Set<string>();
    papers.forEach((p) => (p.tags || []).forEach((t) => set.add(t)));
    return Array.from(set).sort();
  }, [papers]);

  const filteredPapers = useMemo(() => {
    const q = search.trim().toLowerCase();
    return papers.filter((p) => {
      if (selectedTag && !(p.tags || []).includes(selectedTag)) {
        return false;
      }
      if (!q) {
        return true;
      }
      return (
        p.title.toLowerCase().includes(q) ||
        p.authors.toLowerCase().includes(q) ||
        p.bibtex_key.toLowerCase().includes(q) ||
        p.doi.toLowerCase().includes(q)
      );
    });
  }, [papers, search, selectedTag]);

  const handleFileUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) {
      return;
    }
    setUploading(true);
    try {
      const uploaded = await api.uploadPapers(files);
      await onPapersChanged();
      if (uploaded.length > 0) {
        onSelectPaper(uploaded[0]);
      }
      onStatusMessage(`Uploaded ${uploaded.length} PDF(s) and extracted BibTeX.`);
    } catch (err) {
      onStatusMessage(`Upload error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setUploading(false);
    }
  };

  const startEditing = (paper: Paper) => {
    setEditingPaperId(paper.id);
    setEditTitle(paper.title);
    setEditAuthors(paper.authors);
    setEditBibKey(paper.bibtex_key);
    setEditBibRaw(paper.bibtex_raw);
    setEditTags((paper.tags || []).join(', '));
  };

  const savePaperEdits = async (paperId: string) => {
    try {
      const tags = editTags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
      await api.updatePaper(paperId, {
        title: editTitle,
        authors: editAuthors,
        bibtex_key: editBibKey,
        bibtex_raw: editBibRaw,
        tags,
      });
      setEditingPaperId(null);
      await onPapersChanged();
      onStatusMessage('Saved paper metadata and BibTeX.');
    } catch (err) {
      onStatusMessage(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleReextract = async (paperId: string) => {
    try {
      onStatusMessage('Re-extracting DOI and BibTeX via PyMuPDF...');
      await api.reextractPaper(paperId);
      await onPapersChanged();
      onStatusMessage('Updated BibTeX metadata from PDF.');
    } catch (err) {
      onStatusMessage(`Re-extract failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleExportBibtex = async () => {
    try {
      const bib = await api.exportBibtex();
      const blob = new Blob([bib], { type: 'application/x-bibtex;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'references.bib';
      a.click();
      URL.revokeObjectURL(url);
      onStatusMessage('Exported references.bib');
    } catch (err) {
      onStatusMessage(`BibTeX export failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleCreateRepo = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!repoUrl.trim()) {
      return;
    }
    setSyncingRepo(true);
    try {
      const created = await api.createRepo({
        name: repoName.trim(),
        remote_url: repoUrl.trim(),
        bib_file_path: repoBibPath.trim() || 'references.bib',
      });
      setShowNewRepoForm(false);
      setRepoName('');
      setRepoUrl('');
      await onReposChanged();
      onSelectRepo(created.id);
      onStatusMessage(`Cloned Overleaf/GitHub repo "${created.name}".`);
    } catch (err) {
      onStatusMessage(`Git clone failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSyncingRepo(false);
    }
  };

  const handleSyncActiveRepo = async () => {
    if (!activeRepoId) {
      return;
    }
    setSyncingRepo(true);
    try {
      const res = await api.syncRepo(activeRepoId);
      await onReposChanged();
      onStatusMessage(
        res.committed
          ? `Synced ${res.bib_entries} BibTeX entries & pushed commit ${res.commit_sha?.slice(0, 7) || ''} to GitHub/Overleaf.`
          : `Wrote ${res.bib_entries} BibTeX entries (repo already clean & up to date).`,
      );
    } catch (err) {
      onStatusMessage(`Git sync failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSyncingRepo(false);
    }
  };

  return (
    <div className="library-pane">
      {/* Overleaf / GitHub Bridge Section */}
      <div className="repo-bridge-box">
        <div className="section-title-row">
          <strong>Overleaf / GitHub Bridge</strong>
          <button
            type="button"
            className="btn-small"
            onClick={() => setShowNewRepoForm((prev) => !prev)}
          >
            {showNewRepoForm ? 'Cancel' : '+ Link Repo'}
          </button>
        </div>

        {showNewRepoForm && (
          <form className="repo-form" onSubmit={handleCreateRepo}>
            <input
              type="text"
              placeholder="GitHub Remote URL (or local path)"
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
              required
            />
            <div className="row-gap">
              <input
                type="text"
                placeholder="Project name (optional)"
                value={repoName}
                onChange={(e) => setRepoName(e.target.value)}
              />
              <input
                type="text"
                placeholder="references.bib"
                value={repoBibPath}
                onChange={(e) => setRepoBibPath(e.target.value)}
              />
            </div>
            <button type="submit" className="btn-primary" disabled={syncingRepo}>
              {syncingRepo ? 'Cloning...' : 'Clone Repository'}
            </button>
          </form>
        )}

        {repos.length > 0 ? (
          <div className="repo-controls">
            <div className="row-gap">
              <select
                value={activeRepoId || ''}
                onChange={(e) => onSelectRepo(e.target.value)}
              >
                {repos.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name} ({r.bib_file_path})
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn-primary btn-small"
                disabled={!activeRepoId || syncingRepo}
                onClick={handleSyncActiveRepo}
                title="Write references.bib, commit changes, and push to GitHub/Overleaf"
              >
                {syncingRepo ? 'Syncing...' : 'Sync .bib & Push'}
              </button>
            </div>
            {repoFiles.length > 0 && activeRepoId && (
              <div className="repo-file-list">
                {repoFiles.map((f) => (
                  <button
                    key={f}
                    type="button"
                    className="repo-file-chip"
                    onClick={() => onOpenRepoFile(activeRepoId, f)}
                    title={`Open ${f} in editor`}
                  >
                    {f}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <p className="muted-hint">
            Link your Overleaf-connected GitHub repository to auto-write <code>references.bib</code> and figures.
          </p>
        )}
      </div>

      {/* PDF Upload & BibTeX Export */}
      <div className="library-actions">
        <label className="upload-dropzone">
          <input
            type="file"
            accept="application/pdf,.pdf"
            multiple
            disabled={uploading}
            onChange={(e) => handleFileUpload(e.target.files)}
          />
          <span>{uploading ? 'Extracting BibTeX...' : '+ Upload PDFs (Auto-BibTeX)'}</span>
        </label>
        <button type="button" className="btn-secondary" onClick={handleExportBibtex}>
          Export .bib ({papers.length})
        </button>
      </div>

      {/* Search & Tag Filters */}
      <div className="library-filters">
        <input
          type="search"
          placeholder="Filter by title, author, @key, or DOI..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {allTags.length > 0 && (
          <div className="tag-strip">
            <button
              type="button"
              className={`tag-pill ${selectedTag === '' ? 'active' : ''}`}
              onClick={() => setSelectedTag('')}
            >
              All
            </button>
            {allTags.map((tag) => (
              <button
                key={tag}
                type="button"
                className={`tag-pill ${selectedTag === tag ? 'active' : ''}`}
                onClick={() => setSelectedTag(tag)}
              >
                #{tag}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Paper List */}
      <div className="paper-list">
        {filteredPapers.length === 0 ? (
          <div className="empty-hint">No papers found. Upload PDFs above to generate BibTeX.</div>
        ) : (
          filteredPapers.map((paper) => {
            const isSelected = paper.id === selectedPaperId;
            const isEditing = paper.id === editingPaperId;
            return (
              <div
                key={paper.id}
                className={`paper-card ${isSelected ? 'selected' : ''}`}
                onClick={() => onSelectPaper(paper)}
              >
                <div className="paper-card-top">
                  <code className="bibkey-badge">@{paper.bibtex_key || 'nokey'}</code>
                  {paper.publication_year && (
                    <span className="paper-year">{paper.publication_year}</span>
                  )}
                </div>
                <div className="paper-card-title">{paper.title}</div>
                <div className="paper-card-authors">{paper.authors}</div>

                {(paper.tags || []).length > 0 && (
                  <div className="paper-card-tags">
                    {paper.tags.map((t) => (
                      <span key={t} className="tag-mini">
                        #{t}
                      </span>
                    ))}
                  </div>
                )}

                <div className="paper-card-actions" onClick={(e) => e.stopPropagation()}>
                  {paper.bibtex_key && (
                    <button
                      type="button"
                      className="btn-tiny"
                      onClick={() => onInsertCitation(paper.bibtex_key)}
                      title="Insert \cite{key} into active LaTeX editor"
                    >
                      Cite \cite
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn-tiny"
                    onClick={() =>
                      isEditing ? setEditingPaperId(null) : startEditing(paper)
                    }
                  >
                    {isEditing ? 'Close' : 'BibTeX'}
                  </button>
                  <button
                    type="button"
                    className="btn-tiny"
                    onClick={() => handleReextract(paper.id)}
                    title="Re-run PyMuPDF + Crossref/arXiv extraction"
                  >
                    Re-extract
                  </button>
                </div>

                {isEditing && (
                  <div className="paper-bibtex-editor" onClick={(e) => e.stopPropagation()}>
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
                    <div className="row-gap">
                      <input
                        type="text"
                        value={editBibKey}
                        onChange={(e) => setEditBibKey(e.target.value)}
                        placeholder="BibTeX Key"
                      />
                      <input
                        type="text"
                        value={editTags}
                        onChange={(e) => setEditTags(e.target.value)}
                        placeholder="Tags (comma-separated)"
                      />
                    </div>
                    <textarea
                      rows={6}
                      value={editBibRaw}
                      onChange={(e) => setEditBibRaw(e.target.value)}
                    />
                    <div className="row-gap">
                      <button
                        type="button"
                        className="btn-primary btn-small"
                        onClick={() => savePaperEdits(paper.id)}
                      >
                        Save BibTeX
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
