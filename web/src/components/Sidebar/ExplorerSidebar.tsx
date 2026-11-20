import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Paper,
  ProjectConfig,
  ProjectTreeEntry,
  SearchMatchItem,
  api,
  getStoredGitHubPat,
  setStoredGitHubPat,
} from '../../api/client';

export interface FolderTreeNode {
  name: string;
  fullPath: string;
  childrenDirs: FolderTreeNode[];
  files: ProjectTreeEntry[];
  totalFileCount: number;
}

export function formatCompactParentDir(fullPath: string): string {
  const parts = fullPath.split('/').filter(Boolean);
  if (parts.length <= 1) {
    return '';
  }
  const dirParts = parts.slice(0, -1);
  if (dirParts.length <= 3) {
    return dirParts.join('/');
  }
  return `${dirParts[0]}/${dirParts[1]}/…/${dirParts[dirParts.length - 1]}`;
}

export function buildFolderTree(entries: ProjectTreeEntry[]): FolderTreeNode {
  const root: FolderTreeNode = {
    name: '',
    fullPath: '',
    childrenDirs: [],
    files: [],
    totalFileCount: 0,
  };

  // Ensure standard top-level project folders always appear
  for (const stdDir of ['paper', 'notes', 'diagrams', 'refs']) {
    root.childrenDirs.push({
      name: stdDir,
      fullPath: stdDir,
      childrenDirs: [],
      files: [],
      totalFileCount: 0,
    });
  }

  for (const entry of entries) {
    if (entry.path === '.gitignore') {
      continue;
    }
    const parts = entry.path.split('/').filter(Boolean);
    if (parts.length === 0) {
      continue;
    }
    if (parts.length === 1) {
      root.files.push(entry);
      root.totalFileCount++;
      continue;
    }

    let current = root;
    current.totalFileCount++;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      const nextFull = current.fullPath ? `${current.fullPath}/${seg}` : seg;
      let child = current.childrenDirs.find((d) => d.name === seg);
      if (!child) {
        child = {
          name: seg,
          fullPath: nextFull,
          childrenDirs: [],
          files: [],
          totalFileCount: 0,
        };
        current.childrenDirs.push(child);
      }
      child.totalFileCount++;
      current = child;
    }
    current.files.push(entry);
  }

  const sortNode = (node: FolderTreeNode) => {
    node.childrenDirs.sort((a, b) => a.name.localeCompare(b.name));
    node.files.sort((a, b) => a.path.localeCompare(b.path));
    node.childrenDirs.forEach(sortNode);
  };
  sortNode(root);
  return root;
}

interface ExplorerSidebarProps {
  papers: Paper[];
  citedBibKeys?: string[];
  commentCountsByFile?: Record<string, { open: number; addressed: number }>;
  hasLatexOrPreviewOpen?: boolean;
  projects: ProjectConfig[];
  activeProject: ProjectConfig | null;
  projectFiles: ProjectTreeEntry[];
  activeTabId: string | null;
  onSelectProject: (projectId: string) => void;
  onProjectsChanged: () => Promise<void>;
  onOpenPaper: (paper: Paper, inSplit: boolean) => void;
  onOpenProjectFile: (file: ProjectTreeEntry, inSplit: boolean, line?: number) => void;
  onOpenCompiledPreview: (inSplit: boolean) => void;
  onCreateProjectFile: (kind: 'tex' | 'markdown' | 'diagram', name: string) => Promise<void>;
  onRenameProjectFile?: (oldPath: string, newPath: string) => Promise<void>;
  onDeleteProjectFile?: (filePath: string) => Promise<void>;
  onPullProject: () => Promise<void>;
  onSyncProject: () => Promise<void>;
  onGatherContext: () => Promise<void>;
  onExportOverleafBundle: () => void;
  onInsertCitation: (bibtexKey: string) => void;
  onPapersChanged: () => Promise<void>;
  onStatusMessage: (msg: string) => void;
}

const PDF_FOLDERS_STORAGE_KEY = 'dupe_pdf_folders_v1';

function loadSavedPdfFolders(): string[] {
  try {
    const raw = localStorage.getItem(PDF_FOLDERS_STORAGE_KEY);
    if (!raw) {
      return ['Reading List', 'Core References'];
    }
    const parsed = JSON.parse(raw) as string[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return ['Reading List', 'Core References'];
  }
}

function getPaperFolder(paper: Paper): string {
  for (const tag of paper.tags || []) {
    if (tag.startsWith('folder:')) {
      return tag.slice('folder:'.length).trim();
    }
  }
  return '';
}

export function recommendFolderForPaper(
  paper: Paper,
  existingFolders: string[],
  citedKeySet: Set<string>,
): string {
  const keyLower = (paper.bibtex_key || '').toLowerCase();
  if (keyLower && citedKeySet.has(keyLower)) {
    return 'Core References';
  }
  const text = `${paper.title} ${paper.bibtex_raw}`.toLowerCase();
  for (const folder of existingFolders) {
    const words = folder
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 4 && w !== 'list' && w !== 'papers' && w !== 'references');
    if (words.length > 0 && words.some((w) => text.includes(w))) {
      return folder;
    }
  }
  if (/(world model|dreamer|model-based|mbrl|dynamics model|imagination|muzero|planet)/.test(text)) {
    return 'World Models & MBRL';
  }
  if (/(offline|conservative|cql|iql|d4rl|dataset|batch reinforcement|behavior cloning)/.test(text)) {
    return 'Offline RL';
  }
  if (/(robot|locomotion|manipulation|quadruped|sim-to-real|actuator|control|mpc)/.test(text)) {
    return 'Robotics & Control';
  }
  if (/(transformer|attention|diffusion|language model|foundation model|autoregressive)/.test(text)) {
    return 'Sequence & Generative Models';
  }
  if (/(reinforcement learning|policy gradient|actor-critic|q-learning|mdp|bellman|ppo|sac)/.test(text)) {
    return 'Reinforcement Learning';
  }
  return '';
}

interface SidebarContextMenuState {
  x: number;
  y: number;
  kind: 'file' | 'dir' | 'paper' | 'pdf-folder';
  file?: ProjectTreeEntry;
  dirPath?: string;
  paper?: Paper;
  pdfFolder?: string;
}

export const ExplorerSidebar: React.FC<ExplorerSidebarProps> = ({
  papers,
  citedBibKeys = [],
  commentCountsByFile = {},
  hasLatexOrPreviewOpen = false,
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
  onRenameProjectFile,
  onDeleteProjectFile,
  onPullProject,
  onSyncProject,
  onGatherContext,
  onExportOverleafBundle,
  onInsertCitation,
  onPapersChanged,
  onStatusMessage,
}) => {
  const sidebarRef = useRef<HTMLDivElement | null>(null);
  const [sidebarMode, setSidebarMode] = useState<'explorer' | 'search'>('explorer');
  const [topRatio, setTopRatio] = useState(0.46);

  // Global Search State
  const [globalQuery, setGlobalQuery] = useState('');
  const [searchCatFilter, setSearchCatFilter] = useState<
    'all' | 'pdf' | 'latex' | 'notes' | 'code'
  >('all');
  const [searchResults, setSearchResults] = useState<SearchMatchItem[]>([]);
  const [searching, setSearching] = useState(false);

  const [pdfSearch, setPdfSearch] = useState('');
  const [uploading, setUploading] = useState(false);
  const [editingPaperId, setEditingPaperId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editAuthors, setEditAuthors] = useState('');
  const [editBibKey, setEditBibKey] = useState('');
  const [editBibRaw, setEditBibRaw] = useState('');

  // PDF Folders state
  const [customPdfFolders, setCustomPdfFolders] = useState<string[]>(loadSavedPdfFolders);
  const [collapsedPdfFolders, setCollapsedPdfFolders] = useState<Record<string, boolean>>({});
  const [showNewPdfFolder, setShowNewPdfFolder] = useState(false);
  const [newPdfFolderName, setNewPdfFolderName] = useState('');
  const [pdfSectionCollapsed, setPdfSectionCollapsed] = useState(false);
  const [projectSectionCollapsed, setProjectSectionCollapsed] = useState(false);
  const [contextMenu, setContextMenu] = useState<SidebarContextMenuState | null>(null);

  useEffect(() => {
    if (!contextMenu) {
      return undefined;
    }
    const close = () => setContextMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setContextMenu(null);
      }
    };
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [contextMenu]);

  // Recursive Project Directory Expanded State (paper, notes, diagrams open by default; code & refs collapsed)
  const [expandedProjDirs, setExpandedProjDirs] = useState<Record<string, boolean>>({
    paper: true,
    notes: true,
    diagrams: true,
  });

  const [showNewProjectForm, setShowNewProjectForm] = useState(false);
  const [newProjName, setNewProjName] = useState('');
  const [newProjRemote, setNewProjRemote] = useState('');
  const [newProjCodeRemote, setNewProjCodeRemote] = useState('');

  const [showProjectSettings, setShowProjectSettings] = useState(false);
  const [settingsRemote, setSettingsRemote] = useState('');
  const [settingsCodeRemote, setSettingsCodeRemote] = useState('');
  const [settingsToken, setSettingsToken] = useState('');
  const [settingsGithubPat, setSettingsGithubPat] = useState(getStoredGitHubPat);
  const [syncingGit, setSyncingGit] = useState(false);

  const [newFileKind, setNewFileKind] = useState<
    'tex' | 'markdown' | 'diagram' | 'folder' | null
  >(null);
  const [newFileName, setNewFileName] = useState('');

  // Run Global Search across PDFs, LaTeX, Notes, and Code
  useEffect(() => {
    if (sidebarMode !== 'search') {
      return undefined;
    }
    const q = globalQuery.trim();
    if (q.length < 2 || !activeProject) {
      setSearchResults([]);
      return undefined;
    }
    const timer = window.setTimeout(() => {
      setSearching(true);
      api
        .searchProject(activeProject.id, q)
        .then(setSearchResults)
        .catch(() => setSearchResults([]))
        .finally(() => setSearching(false));
    }, 180);

    return () => window.clearTimeout(timer);
  }, [globalQuery, sidebarMode, activeProject]);

  const filteredSearchResults = useMemo(() => {
    if (searchCatFilter === 'all') {
      return searchResults;
    }
    return searchResults.filter((r) => r.category === searchCatFilter);
  }, [searchResults, searchCatFilter]);

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

  const citedKeySet = useMemo(
    () => new Set(citedBibKeys.map((k) => k.trim().toLowerCase()).filter(Boolean)),
    [citedBibKeys],
  );

  const referencedPapers = useMemo(
    () =>
      filteredPapers.filter(
        (p) => p.bibtex_key && citedKeySet.has(p.bibtex_key.trim().toLowerCase()),
      ),
    [filteredPapers, citedKeySet],
  );

  const pdfFolderGroups = useMemo(() => {
    const folderMap = new Map<string, Paper[]>();
    customPdfFolders.forEach((f) => folderMap.set(f, []));

    const unfiled: Paper[] = [];
    for (const p of filteredPapers) {
      const folder = getPaperFolder(p);
      if (folder) {
        if (!folderMap.has(folder)) {
          folderMap.set(folder, []);
        }
        folderMap.get(folder)!.push(p);
      } else {
        unfiled.push(p);
      }
    }
    return {
      folders: Array.from(folderMap.entries()).sort((a, b) => a[0].localeCompare(b[0])),
      unfiled,
    };
  }, [filteredPapers, customPdfFolders]);

  const folderTreeRoot = useMemo(
    () => buildFolderTree(projectFiles),
    [projectFiles],
  );

  const modifiedCount = useMemo(
    () =>
      projectFiles.filter(
        (f) =>
          !f.path.startsWith('refs/') &&
          f.path !== 'AGENTS.md' &&
          (f.git_status === 'M' || f.git_status === 'U'),
      ).length,
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

  const handleCreatePdfFolder = (event: React.FormEvent) => {
    event.preventDefault();
    const name = newPdfFolderName.trim();
    if (!name) {
      return;
    }
    const next = Array.from(new Set([...customPdfFolders, name]));
    setCustomPdfFolders(next);
    localStorage.setItem(PDF_FOLDERS_STORAGE_KEY, JSON.stringify(next));
    setNewPdfFolderName('');
    setShowNewPdfFolder(false);
    onStatusMessage(`Created PDF folder "${name}". Drag any paper onto it to file it.`);
  };

  const movePaperToFolder = async (paper: Paper, targetFolder: string) => {
    const otherTags = (paper.tags || []).filter((t) => !t.startsWith('folder:'));
    const nextTags = targetFolder ? [...otherTags, `folder:${targetFolder}`] : otherTags;
    try {
      await api.updatePaper(paper.id, { tags: nextTags });
      await onPapersChanged();
      onStatusMessage(
        targetFolder
          ? `Moved "${paper.title.slice(0, 35)}…" to folder "${targetFolder}".`
          : `Moved "${paper.title.slice(0, 35)}…" to Unfiled.`,
      );
    } catch (err) {
      onStatusMessage(`Move failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleUploadFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) {
      return;
    }
    setUploading(true);
    try {
      const created = await api.uploadPapers(files);
      const addedFolders = new Set<string>(customPdfFolders);
      const assignedSummaries: string[] = [];
      for (const paper of created) {
        if (!getPaperFolder(paper)) {
          const recommended = recommendFolderForPaper(paper, Array.from(addedFolders), citedKeySet);
          if (recommended) {
            addedFolders.add(recommended);
            const otherTags = (paper.tags || []).filter((t) => !t.startsWith('folder:'));
            await api.updatePaper(paper.id, { tags: [...otherTags, `folder:${recommended}`] });
            assignedSummaries.push(`@${paper.bibtex_key || 'paper'} -> ${recommended}`);
          }
        }
      }
      if (addedFolders.size !== customPdfFolders.length) {
        const nextFolders = Array.from(addedFolders);
        setCustomPdfFolders(nextFolders);
        localStorage.setItem(PDF_FOLDERS_STORAGE_KEY, JSON.stringify(nextFolders));
      }
      await onPapersChanged();
      if (created.length > 0) {
        onOpenPaper(created[0], false);
      }
      onStatusMessage(
        assignedSummaries.length > 0
          ? `Uploaded ${created.length} PDF(s) & auto-grouped (${assignedSummaries.join(', ')}).`
          : `Uploaded ${created.length} PDF(s) and extracted BibTeX.`,
      );
    } catch (err) {
      onStatusMessage(`Upload failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setUploading(false);
    }
  };

  const handleAutoGroupAllPapers = async () => {
    setUploading(true);
    try {
      const addedFolders = new Set<string>(customPdfFolders);
      let movedCount = 0;
      for (const paper of papers) {
        const current = getPaperFolder(paper);
        const isCited = Boolean(paper.bibtex_key && citedKeySet.has(paper.bibtex_key.toLowerCase()));
        if (!current || (isCited && current !== 'Core References')) {
          const recommended = recommendFolderForPaper(paper, Array.from(addedFolders), citedKeySet);
          if (recommended && recommended !== current) {
            addedFolders.add(recommended);
            const otherTags = (paper.tags || []).filter((t) => !t.startsWith('folder:'));
            await api.updatePaper(paper.id, { tags: [...otherTags, `folder:${recommended}`] });
            movedCount++;
          }
        }
      }
      const nextFolders = Array.from(addedFolders);
      setCustomPdfFolders(nextFolders);
      localStorage.setItem(PDF_FOLDERS_STORAGE_KEY, JSON.stringify(nextFolders));
      await onPapersChanged();

      const agentPrompt = `Review my PDF library using the dupe MCP search_papers and assign_paper_folder tools. Put all papers cited in paper/*.tex into "Core References" and group the remaining papers into topic folders (${nextFolders.join(', ')}).`;
      try {
        await navigator.clipboard.writeText(agentPrompt);
      } catch {
        // clipboard optional
      }
      onStatusMessage(
        `Auto-grouped ${movedCount} paper(s) into folders (and copied MCP Agent grouping prompt to clipboard).`,
      );
    } catch (err) {
      onStatusMessage(`Auto-group failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setUploading(false);
    }
  };

  const handleRenamePdfFolder = async (oldFolder: string, newFolder: string) => {
    const cleaned = newFolder.trim();
    if (!cleaned || cleaned === oldFolder) {
      return;
    }
    const nextFolders = customPdfFolders.map((f) => (f === oldFolder ? cleaned : f));
    if (!nextFolders.includes(cleaned)) {
      nextFolders.push(cleaned);
    }
    setCustomPdfFolders(nextFolders);
    localStorage.setItem(PDF_FOLDERS_STORAGE_KEY, JSON.stringify(nextFolders));
    for (const p of papers) {
      if (getPaperFolder(p) === oldFolder) {
        const otherTags = (p.tags || []).filter((t) => !t.startsWith('folder:'));
        await api.updatePaper(p.id, { tags: [...otherTags, `folder:${cleaned}`] });
      }
    }
    await onPapersChanged();
    onStatusMessage(`Renamed PDF folder "${oldFolder}" -> "${cleaned}".`);
  };

  const handleDeletePdfFolder = async (folderName: string) => {
    const nextFolders = customPdfFolders.filter((f) => f !== folderName);
    setCustomPdfFolders(nextFolders);
    localStorage.setItem(PDF_FOLDERS_STORAGE_KEY, JSON.stringify(nextFolders));
    for (const p of papers) {
      if (getPaperFolder(p) === folderName) {
        const otherTags = (p.tags || []).filter((t) => !t.startsWith('folder:'));
        await api.updatePaper(p.id, { tags: otherTags });
      }
    }
    await onPapersChanged();
    onStatusMessage(`Deleted PDF folder "${folderName}" (papers moved to Unfiled).`);
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
        code_remote: newProjCodeRemote.trim(),
        link_all_papers: true,
      });
      setShowNewProjectForm(false);
      setNewProjName('');
      setNewProjRemote('');
      setNewProjCodeRemote('');
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
    setStoredGitHubPat(settingsGithubPat);
    setSyncingGit(true);
    try {
      await api.updateProject(activeProject.id, {
        overleaf_remote: settingsRemote.trim(),
        overleaf_token: settingsToken.trim(),
        code_remote: settingsCodeRemote.trim(),
      });
      setShowProjectSettings(false);
      setSettingsToken('');
      await onProjectsChanged();
      onStatusMessage('Pulled Overleaf remote into paper/ and regenerated dupe_references.bib.');
    } catch (err) {
      onStatusMessage(`Overleaf sync failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSyncingGit(false);
    }
  };

  const handleTriggerPull = async () => {
    setSyncingGit(true);
    try {
      await onPullProject();
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

  const handleTriggerGatherContext = async () => {
    setSyncingGit(true);
    try {
      await onGatherContext();
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
    if (newFileKind === 'folder') {
      const folderPath = cleaned.replace(/\/+$/, '');
      await onCreateProjectFile('markdown', `${folderPath}/README.md`);
    } else {
      await onCreateProjectFile(newFileKind, cleaned);
    }
    setNewFileName('');
    setNewFileKind(null);
  };

  const renderPaperRow = (paper: Paper) => {
    const tabId = `pdf:${paper.id}`;
    const isSelected = activeTabId === tabId;
    const isEditing = editingPaperId === paper.id;
    const currentFolder = getPaperFolder(paper);

    return (
      <div key={paper.id} className="tree-item-group">
        <div
          className={`tree-row tree-row-nested ${isSelected ? 'active' : ''}`}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData('application/x-dupe-paper-id', paper.id);
            if (paper.bibtex_key) {
              e.dataTransfer.setData('text/plain', `\\cite{${paper.bibtex_key}}`);
            }
          }}
          onClick={() => onOpenPaper(paper, false)}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setContextMenu({
              x: e.clientX,
              y: e.clientY,
              kind: 'paper',
              paper,
            });
          }}
          title={`${paper.title}\n${paper.authors}\n@${paper.bibtex_key}\n(Right-click for options, drag onto a folder to organize, or drag into editor to cite)`}
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
              title="Edit BibTeX & Folder"
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
            <label className="muted-hint">
              Folder:
              <select
                value={currentFolder}
                onChange={(e) => void movePaperToFolder(paper, e.target.value)}
              >
                <option value="">(Unfiled)</option>
                {customPdfFolders.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </label>
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
  };

  // Recursive Renderer for Project Folders & Nested Subfolders (code/mbrl_soft/source/...)
  const renderFolderTreeNode = (node: FolderTreeNode, depth: number): React.ReactNode => {
    const isExpanded = Boolean(expandedProjDirs[node.fullPath]);
    const indentPx = 10 + depth * 14;

    return (
      <div key={node.fullPath} className="folder-group">
        <div
          className="folder-header-row"
          style={{ paddingLeft: `${indentPx}px` }}
          onClick={() =>
            setExpandedProjDirs((prev) => ({
              ...prev,
              [node.fullPath]: !prev[node.fullPath],
            }))
          }
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setContextMenu({
              x: e.clientX,
              y: e.clientY,
              kind: 'dir',
              dirPath: node.fullPath,
            });
          }}
        >
          <span className="folder-chevron">{isExpanded ? '▾' : '▸'}</span>
          <span className="folder-title">📁 {node.name}/</span>
          <span className="folder-count">{node.totalFileCount}</span>
        </div>

        {isExpanded && (
          <>
            {node.childrenDirs.map((childDir) =>
              renderFolderTreeNode(childDir, depth + 1),
            )}
            {node.files.map((file) => {
              const tabId = `file:${file.path}`;
              const isSelected = activeTabId === tabId;
              const shortName = file.path.split('/').pop() || file.path;
              const badge =
                file.kind === 'tex'
                  ? 'TEX'
                  : file.kind === 'bib'
                    ? 'BIB'
                    : file.kind === 'markdown'
                      ? 'MD'
                      : file.kind === 'diagram'
                        ? 'FIG'
                        : file.kind === 'asset'
                          ? file.path.toLowerCase().endsWith('.pdf')
                            ? 'FIG'
                            : 'IMG'
                          : file.path.endsWith('.py')
                            ? 'PY'
                            : 'FILE';
              const cleanStem = shortName.replace(/\.(drawio\.svg|drawio|excalidraw|svg|pdf|png|jpg|jpeg|gif|webp)$/i, '');
              const svgRelPath = `figures/${cleanStem}.svg`;
              const paperRelAsset = file.path.replace(/^paper\//, '');
              return (
                <div
                  key={file.path}
                  className={`tree-row ${isSelected ? 'active' : ''}`}
                  style={{ paddingLeft: `${indentPx + 14}px` }}
                  draggable={file.kind === 'diagram' || file.kind === 'asset'}
                  onDragStart={(e) => {
                    if (file.kind === 'diagram') {
                      e.dataTransfer.setData(
                        'text/plain',
                        `\\begin{figure}[h]\n  \\centering\n  \\includegraphics[width=0.8\\linewidth]{${svgRelPath}}\n  \\caption{${cleanStem.replace(/_/g, ' ')}}\n  \\label{fig:${cleanStem}}\n\\end{figure}`,
                      );
                    } else if (file.kind === 'asset') {
                      e.dataTransfer.setData(
                        'text/plain',
                        `\\begin{figure}[h]\n  \\centering\n  \\includegraphics[width=0.9\\linewidth]{${paperRelAsset}}\n  \\caption{${cleanStem.replace(/_/g, ' ')}}\n  \\label{fig:${cleanStem}}\n\\end{figure}`,
                      );
                    }
                  }}
                  onClick={() => onOpenProjectFile(file, false)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setContextMenu({
                      x: e.clientX,
                      y: e.clientY,
                      kind: 'file',
                      file,
                    });
                  }}
                  title={`${file.path} (Right-click to rename or delete)`}
                >
                  <span className={`file-icon kind-${file.kind}`}>{badge}</span>
                  <div className="tree-label-col">
                    <span className="tree-primary-text">{shortName}</span>
                  </div>
                  <div className="tree-row-actions" onClick={(e) => e.stopPropagation()}>
                    {commentCountsByFile[file.path] && (commentCountsByFile[file.path].open > 0 || commentCountsByFile[file.path].addressed > 0) && (
                      <span
                        className={`comment-tree-badge ${commentCountsByFile[file.path].open > 0 ? 'open' : 'addressed'}`}
                        title={`${commentCountsByFile[file.path].open} open, ${commentCountsByFile[file.path].addressed} addressed comment(s)`}
                      >
                        {commentCountsByFile[file.path].open > 0
                          ? `💬${commentCountsByFile[file.path].open}`
                          : `✓${commentCountsByFile[file.path].addressed}`}
                      </span>
                    )}
                    {file.git_status && !file.path.startsWith('refs/') && (
                      <span
                        className={`git-badge git-badge-${file.git_status.toLowerCase()}`}
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
          </>
        )}
      </div>
    );
  };

  const handleOpenSearchResult = (item: SearchMatchItem, inSplit: boolean) => {
    if (item.category === 'pdf' && item.paper_id) {
      const found = papers.find((p) => p.id === item.paper_id);
      if (found) {
        onOpenPaper(found, inSplit);
      }
      return;
    }
    onOpenProjectFile(
      {
        path: item.path,
        kind: item.kind === 'pdf' ? 'other' : item.kind,
      },
      inSplit,
      item.line,
    );
  };

  useEffect(() => {
    const onGlobalFind = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setSidebarMode('search');
        return;
      }
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
        const activeEl = document.activeElement as HTMLElement | null;
        const inCodeMirror = Boolean(activeEl?.closest?.('.cm-editor'));
        const inInput =
          activeEl?.tagName === 'INPUT' || activeEl?.tagName === 'TEXTAREA';
        if (!inCodeMirror && !inInput) {
          e.preventDefault();
          setSidebarMode('search');
        }
      }
    };
    window.addEventListener('keydown', onGlobalFind);
    return () => window.removeEventListener('keydown', onGlobalFind);
  }, []);

  return (
    <aside className="vscode-sidebar" ref={sidebarRef}>
      {/* Sidebar Mode Switcher: Explorer vs Unified Search */}
      <div className="sidebar-mode-tabs">
        <button
          type="button"
          className={`sidebar-mode-btn ${sidebarMode === 'explorer' ? 'active' : ''}`}
          onClick={() => setSidebarMode('explorer')}
        >
          📁 Explorer
        </button>
        <button
          type="button"
          className={`sidebar-mode-btn ${sidebarMode === 'search' ? 'active' : ''}`}
          onClick={() => setSidebarMode('search')}
        >
          🔍 Search All
        </button>
      </div>

      {sidebarMode === 'search' ? (
        <section className="explorer-section" style={{ flex: '1 1 0%' }}>
          <div className="explorer-search-row">
            <input
              type="search"
              placeholder="Search across PDFs, LaTeX & Notes…"
              value={globalQuery}
              onChange={(e) => setGlobalQuery(e.target.value)}
              autoFocus
            />
            <div className="search-filter-pills">
              {(
                [
                  ['all', 'All'],
                  ['pdf', 'PDFs'],
                  ['latex', 'LaTeX'],
                  ['notes', 'Notes'],
                ] as const
              ).map(([catKey, label]) => (
                <button
                  key={catKey}
                  type="button"
                  className={`tag-pill ${searchCatFilter === catKey ? 'active' : ''}`}
                  onClick={() => setSearchCatFilter(catKey)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="explorer-tree-list">
            {searching && <div className="explorer-empty">Searching…</div>}
            {!searching && globalQuery.trim().length < 2 && (
              <div className="explorer-empty">
                Type at least 2 characters to search across your <strong>{papers.length} PDFs</strong>,{' '}
                <strong>paper/</strong> LaTeX files, and <strong>notes/</strong>.
              </div>
            )}
            {!searching &&
              globalQuery.trim().length >= 2 &&
              filteredSearchResults.length === 0 && (
                <div className="explorer-empty">
                  No matches found for &ldquo;{globalQuery}&rdquo;.
                </div>
              )}

            {filteredSearchResults.map((hit, idx) => {
              const catBadge =
                hit.category === 'pdf'
                  ? 'PDF'
                  : hit.category === 'latex'
                    ? 'TEX'
                    : hit.category === 'code'
                      ? 'CODE'
                      : 'NOTE';
              const shortFile =
                hit.category === 'pdf'
                  ? hit.title
                  : hit.path.split('/').pop() || hit.title || hit.path;
              const parentDir =
                hit.category === 'pdf' ? '' : formatCompactParentDir(hit.path);
              return (
                <div
                  key={`${hit.path}-${hit.line || 0}-${idx}`}
                  className="tree-row search-hit-row"
                  onClick={() => handleOpenSearchResult(hit, false)}
                  title={hit.category === 'pdf' ? hit.title : `${hit.path}${hit.line ? `:${hit.line}` : ''}`}
                >
                  <span
                    className={`file-icon ${
                      hit.category === 'pdf'
                        ? 'pdf-icon'
                        : hit.category === 'latex'
                          ? 'kind-tex'
                          : hit.category === 'code'
                            ? 'kind-diagram'
                            : 'kind-markdown'
                    }`}
                  >
                    {catBadge}
                  </span>
                  <div className="tree-label-col">
                    <div className="search-hit-header">
                      <span className="tree-primary-text">
                        {shortFile}
                        {hit.line ? <span className="search-hit-line">:{hit.line}</span> : null}
                      </span>
                      {parentDir && (
                        <span className="search-hit-dir">{parentDir}</span>
                      )}
                    </div>
                    <span className="tree-sub-text">{hit.snippet}</span>
                  </div>
                  <div className="tree-row-actions" onClick={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      className="tree-action-btn"
                      title="Open in Right Split"
                      onClick={() => handleOpenSearchResult(hit, true)}
                    >
                      ◫
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ) : (
        <>
          {/* TOP HALF: PDF LIBRARY EXPLORER */}
          <section
            className="explorer-section"
            style={{
              flex: pdfSectionCollapsed
                ? '0 0 auto'
                : projectSectionCollapsed
                  ? '1 1 0%'
                  : `${topRatio} 1 0%`,
            }}
          >
            <div
              className="explorer-section-header"
              style={{ cursor: 'pointer' }}
              onClick={() => setPdfSectionCollapsed((v) => !v)}
            >
              <span className="explorer-chevron">{pdfSectionCollapsed ? '▸' : '▾'}</span>
              <span className="explorer-section-title">PDF LIBRARY ({papers.length})</span>
              <div className="explorer-header-actions" onClick={(e) => e.stopPropagation()}>
                <button
                  type="button"
                  className="icon-btn"
                  disabled={uploading || papers.length === 0}
                  title="Auto-group papers into folders & copy MCP Agent grouping prompt"
                  onClick={() => void handleAutoGroupAllPapers()}
                >
                  Auto-Group
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  title="New PDF Folder"
                  onClick={() => setShowNewPdfFolder((v) => !v)}
                >
                  + Folder
                </button>
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

            {!pdfSectionCollapsed && (
              <>
                {showNewPdfFolder && (
                  <form className="inline-new-file-form" onSubmit={handleCreatePdfFolder}>
                    <input
                      type="text"
                      placeholder="Folder name (e.g. World Models)"
                      value={newPdfFolderName}
                      onChange={(e) => setNewPdfFolderName(e.target.value)}
                      autoFocus
                    />
                    <button type="submit" className="btn-primary btn-tiny">
                      Create
                    </button>
                  </form>
                )}

                <div className="explorer-search-row">
                  <input
                    type="search"
                    placeholder="Filter 230+ papers (@key, title, author)..."
                    value={pdfSearch}
                    onChange={(e) => setPdfSearch(e.target.value)}
                  />
                </div>

                <div className="explorer-tree-list">
                  {/* Automatic Referenced in Manuscript Section */}
                  <div className="folder-group">
                    <div
                      className="folder-header-row"
                      onClick={() =>
                        setCollapsedPdfFolders((prev) => ({
                          ...prev,
                          __cited__: !prev.__cited__,
                        }))
                      }
                    >
                      <span className="folder-chevron">
                        {collapsedPdfFolders.__cited__ ? '▸' : '▾'}
                      </span>
                      <span className="folder-title">📌 Referenced in Paper</span>
                      <span className="folder-count">{referencedPapers.length}</span>
                    </div>
                    {!collapsedPdfFolders.__cited__ &&
                      (referencedPapers.length === 0 ? (
                        <div className="muted-hint" style={{ padding: '4px 20px', fontSize: 11 }}>
                          Cite papers with \cite&#123;key&#125; in paper/ to list them here.
                        </div>
                      ) : (
                        referencedPapers.map(renderPaperRow)
                      ))}
                  </div>

                  {/* User PDF Folders */}
                  {pdfFolderGroups.folders.map(([folderName, folderPapers]) => {
                    const isCollapsed = Boolean(collapsedPdfFolders[folderName]);
                    return (
                      <div key={folderName} className="folder-group">
                        <div
                          className="folder-header-row"
                          onClick={() =>
                            setCollapsedPdfFolders((prev) => ({
                              ...prev,
                              [folderName]: !prev[folderName],
                            }))
                          }
                          onContextMenu={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setContextMenu({
                              x: e.clientX,
                              y: e.clientY,
                              kind: 'pdf-folder',
                              pdfFolder: folderName,
                            });
                          }}
                          onDragOver={(e) => e.preventDefault()}
                          onDrop={(e) => {
                            e.preventDefault();
                            const paperId = e.dataTransfer.getData('application/x-dupe-paper-id');
                            const found = papers.find((p) => p.id === paperId);
                            if (found) {
                              void movePaperToFolder(found, folderName);
                            }
                          }}
                        >
                          <span className="folder-chevron">{isCollapsed ? '▸' : '▾'}</span>
                          <span className="folder-title">📁 {folderName}</span>
                          <span className="folder-count">{folderPapers.length}</span>
                        </div>
                        {!isCollapsed && folderPapers.map(renderPaperRow)}
                      </div>
                    );
                  })}

                  {/* Unfiled / All Papers Folder */}
                  <div className="folder-group">
                    <div
                      className="folder-header-row"
                      onClick={() =>
                        setCollapsedPdfFolders((prev) => ({
                          ...prev,
                          __unfiled__: !prev.__unfiled__,
                        }))
                      }
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => {
                        e.preventDefault();
                        const paperId = e.dataTransfer.getData('application/x-dupe-paper-id');
                        const found = papers.find((p) => p.id === paperId);
                        if (found) {
                          void movePaperToFolder(found, '');
                        }
                      }}
                    >
                      <span className="folder-chevron">
                        {collapsedPdfFolders.__unfiled__ ? '▸' : '▾'}
                      </span>
                      <span className="folder-title">📚 All / Unfiled Papers</span>
                      <span className="folder-count">{pdfFolderGroups.unfiled.length}</span>
                    </div>
                    {!collapsedPdfFolders.__unfiled__ &&
                      pdfFolderGroups.unfiled.map(renderPaperRow)}
                  </div>
                </div>
              </>
            )}
          </section>

          {/* HORIZONTAL RESIZE HANDLE */}
          {!pdfSectionCollapsed && !projectSectionCollapsed && (
            <div
              className="sidebar-split-handle"
              role="separator"
              aria-orientation="horizontal"
              onPointerDown={handleVerticalSplitDrag}
            />
          )}

          {/* BOTTOM HALF: RECURSIVE PROJECT FOLDER EXPLORER */}
          <section
            className="explorer-section"
            style={{
              flex: projectSectionCollapsed
                ? '0 0 auto'
                : pdfSectionCollapsed
                  ? '1 1 0%'
                  : `${1 - topRatio} 1 0%`,
            }}
          >
            <div
              className="explorer-section-header"
              style={{ cursor: 'pointer' }}
              onClick={() => setProjectSectionCollapsed((v) => !v)}
            >
              <span className="explorer-chevron">{projectSectionCollapsed ? '▸' : '▾'}</span>
              <span className="explorer-section-title">
                PROJECT {modifiedCount > 0 ? `(${modifiedCount} changed)` : ''}
              </span>
              <div className="explorer-header-actions" onClick={(e) => e.stopPropagation()}>
                <button
                  type="button"
                  className="icon-btn"
                  title="New Subfolder"
                  onClick={() => setNewFileKind((v) => (v === 'folder' ? null : 'folder'))}
                >
                  + Dir
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

            {!projectSectionCollapsed && (
              <>
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
                title="New Project"
                onClick={() => setShowNewProjectForm((v) => !v)}
              >
                +
              </button>
              <button
                type="button"
                className="btn-tiny"
                title="Configure Overleaf GitHub remote"
                onClick={() => {
                  setSettingsRemote(activeProject?.overleaf_remote || '');
                  setSettingsCodeRemote(activeProject?.code_remote || '');
                  setShowProjectSettings((v) => !v);
                }}
              >
                ⚙
              </button>
              <button
                type="button"
                className="btn-tiny"
                disabled={syncingGit || !activeProject}
                onClick={() => void handleTriggerGatherContext()}
                title="Reconcile notes/comments.md, read git logs for paper/ and code/, and update AGENTS.md"
              >
                Context
              </button>
              {hasLatexOrPreviewOpen && (
                <>
                  <button
                    type="button"
                    className="btn-tiny"
                    disabled={syncingGit || !activeProject?.overleaf_remote}
                    onClick={() => void handleTriggerPull()}
                    title="Fetch & pull latest changes from Overleaf into paper/"
                  >
                    {syncingGit ? '…' : '↓ Pull'}
                  </button>
                  <button
                    type="button"
                    className="btn-primary btn-tiny"
                    disabled={syncingGit || !activeProject}
                    onClick={() => void handleTriggerSync()}
                    title="Regenerate AGENTS.md & dupe_references.bib, commit, pull, and push paper/ to Overleaf"
                  >
                    {syncingGit ? 'Syncing…' : '↑ Push'}
                  </button>
                </>
              )}
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
                  placeholder="Overleaf GitHub Remote URL (optional -> paper/)"
                  value={newProjRemote}
                  onChange={(e) => setNewProjRemote(e.target.value)}
                />
                <input
                  type="text"
                  placeholder="Code GitHub Repo URL (optional -> code/)"
                  value={newProjCodeRemote}
                  onChange={(e) => setNewProjCodeRemote(e.target.value)}
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
                <strong>Overleaf / GitHub Remote (paper/)</strong>
                <input
                  type="text"
                  placeholder="https://git@git.overleaf.com/... or git@github.com:..."
                  value={settingsRemote}
                  onChange={(e) => setSettingsRemote(e.target.value)}
                />
                <input
                  type="text"
                  placeholder="Code GitHub Repo URL (clones into code/)"
                  value={settingsCodeRemote}
                  onChange={(e) => setSettingsCodeRemote(e.target.value)}
                />
                <input
                  type="password"
                  placeholder="Overleaf Git Token (olp_... if using git.overleaf.com)"
                  value={settingsToken}
                  onChange={(e) => setSettingsToken(e.target.value)}
                />
                <input
                  type="password"
                  placeholder="GitHub PAT (ghp_... for direct browser push if server is down)"
                  value={settingsGithubPat}
                  onChange={(e) => setSettingsGithubPat(e.target.value)}
                />
                <div className="row-gap">
                  <button type="submit" className="btn-primary btn-tiny" disabled={syncingGit}>
                    {syncingGit ? 'Pulling…' : 'Save & Pull Remote'}
                  </button>
                  <button
                    type="button"
                    className="btn-tiny"
                    onClick={onExportOverleafBundle}
                    title="Download main.tex + references.bib directly from browser cache"
                  >
                    ⬇ Export .tex + .bib
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
                    newFileKind === 'folder'
                      ? 'notes/experiments'
                      : newFileKind === 'tex'
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
                  <span className="tree-sub-text">Tectonic PDF &amp; Overleaf Logs</span>
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

              {/* Recursive Folder Hierarchy (paper/, code/mbrl_soft/..., notes/, diagrams/, refs/) */}
              {folderTreeRoot.childrenDirs.map((dirNode) =>
                renderFolderTreeNode(dirNode, 0),
              )}

              {/* Root Project Files (e.g. AGENTS.md) */}
              {folderTreeRoot.files.map((file) => {
                const tabId = `file:${file.path}`;
                const isSelected = activeTabId === tabId;
                return (
                  <div
                    key={file.path}
                    className={`tree-row ${isSelected ? 'active' : ''}`}
                    onClick={() => onOpenProjectFile(file, false)}
                  >
                    <span className="file-icon kind-markdown">MD</span>
                    <div className="tree-label-col">
                      <span className="tree-primary-text">{file.path}</span>
                    </div>
                  </div>
                );
              })}
                </div>
              </>
            )}
          </section>
        </>
      )}

      {contextMenu && (
        <div
          className="context-menu-popover"
          style={{
            top: Math.min(contextMenu.y, window.innerHeight - 240),
            left: Math.min(contextMenu.x, window.innerWidth - 220),
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {contextMenu.kind === 'file' && contextMenu.file && (
            <>
              <button
                type="button"
                className="context-menu-item"
                onClick={() => {
                  onOpenProjectFile(contextMenu.file!, false);
                  setContextMenu(null);
                }}
              >
                Open {contextMenu.file.path.split('/').pop()}
              </button>
              <button
                type="button"
                className="context-menu-item"
                onClick={() => {
                  onOpenProjectFile(contextMenu.file!, true);
                  setContextMenu(null);
                }}
              >
                Open in Right Split
              </button>
              {onRenameProjectFile &&
                contextMenu.file.path !== 'AGENTS.md' &&
                !contextMenu.file.path.startsWith('refs/') && (
                  <button
                    type="button"
                    className="context-menu-item"
                    onClick={() => {
                      const targetFile = contextMenu.file!;
                      setContextMenu(null);
                      const nextPath = window.prompt('Rename / move file path:', targetFile.path);
                      if (nextPath && nextPath.trim() && nextPath.trim() !== targetFile.path) {
                        void onRenameProjectFile(targetFile.path, nextPath.trim());
                      }
                    }}
                  >
                    Rename / Move…
                  </button>
                )}
              {onDeleteProjectFile &&
                contextMenu.file.path !== 'AGENTS.md' &&
                !contextMenu.file.path.startsWith('refs/') && (
                  <button
                    type="button"
                    className="context-menu-item danger"
                    onClick={() => {
                      const targetFile = contextMenu.file!;
                      setContextMenu(null);
                      if (window.confirm(`Delete "${targetFile.path}"?`)) {
                        void onDeleteProjectFile(targetFile.path);
                      }
                    }}
                  >
                    Delete File…
                  </button>
                )}
            </>
          )}

          {contextMenu.kind === 'dir' && contextMenu.dirPath && (
            <>
              <button
                type="button"
                className="context-menu-item"
                onClick={() => {
                  const dir = contextMenu.dirPath!;
                  setContextMenu(null);
                  const name = window.prompt(`New file in ${dir}/:`, `${dir}/note.md`);
                  if (name && name.trim()) {
                    const kind = name.endsWith('.tex')
                      ? 'tex'
                      : name.endsWith('.svg') || name.startsWith('diagrams/')
                        ? 'diagram'
                        : 'markdown';
                    void onCreateProjectFile(kind, name.trim());
                  }
                }}
              >
                New File in {contextMenu.dirPath}/…
              </button>
              {onRenameProjectFile &&
                !['paper', 'notes', 'diagrams', 'refs', 'code'].includes(contextMenu.dirPath) && (
                  <button
                    type="button"
                    className="context-menu-item"
                    onClick={() => {
                      const dir = contextMenu.dirPath!;
                      setContextMenu(null);
                      const nextPath = window.prompt('Rename folder path:', dir);
                      if (nextPath && nextPath.trim() && nextPath.trim() !== dir) {
                        void onRenameProjectFile(dir, nextPath.trim());
                      }
                    }}
                  >
                    Rename Folder…
                  </button>
                )}
              {onDeleteProjectFile &&
                !['paper', 'notes', 'diagrams', 'refs', 'code'].includes(contextMenu.dirPath) && (
                  <button
                    type="button"
                    className="context-menu-item danger"
                    onClick={() => {
                      const dir = contextMenu.dirPath!;
                      setContextMenu(null);
                      if (window.confirm(`Delete folder "${dir}" and all its contents?`)) {
                        void onDeleteProjectFile(dir);
                      }
                    }}
                  >
                    Delete Folder…
                  </button>
                )}
            </>
          )}

          {contextMenu.kind === 'paper' && contextMenu.paper && (
            <>
              <button
                type="button"
                className="context-menu-item"
                onClick={() => {
                  onOpenPaper(contextMenu.paper!, false);
                  setContextMenu(null);
                }}
              >
                Open PDF
              </button>
              <button
                type="button"
                className="context-menu-item"
                onClick={() => {
                  onOpenPaper(contextMenu.paper!, true);
                  setContextMenu(null);
                }}
              >
                Open PDF in Right Split
              </button>
              {contextMenu.paper.bibtex_key && (
                <button
                  type="button"
                  className="context-menu-item"
                  onClick={() => {
                    onInsertCitation(contextMenu.paper!.bibtex_key);
                    setContextMenu(null);
                  }}
                >
                  Insert \cite&#123;{contextMenu.paper.bibtex_key}&#125;
                </button>
              )}
              <button
                type="button"
                className="context-menu-item"
                onClick={() => {
                  const target = contextMenu.paper!;
                  setContextMenu(null);
                  const nextTitle = window.prompt('Rename paper title:', target.title);
                  if (nextTitle && nextTitle.trim() && nextTitle.trim() !== target.title) {
                    void api
                      .updatePaper(target.id, { title: nextTitle.trim() })
                      .then(() => onPapersChanged())
                      .then(() => onStatusMessage('Renamed paper title.'));
                  }
                }}
              >
                Rename Paper Title…
              </button>
              <button
                type="button"
                className="context-menu-item"
                onClick={() => {
                  const target = contextMenu.paper!;
                  setContextMenu(null);
                  const current = getPaperFolder(target);
                  const folderList = customPdfFolders.join(', ');
                  const chosen = window.prompt(
                    `Move paper to folder (${folderList} — or leave empty for Unfiled):`,
                    current,
                  );
                  if (chosen !== null) {
                    const cleanFolder = chosen.trim();
                    if (cleanFolder && !customPdfFolders.includes(cleanFolder)) {
                      const nextFolders = [...customPdfFolders, cleanFolder];
                      setCustomPdfFolders(nextFolders);
                      localStorage.setItem(PDF_FOLDERS_STORAGE_KEY, JSON.stringify(nextFolders));
                    }
                    void movePaperToFolder(target, cleanFolder);
                  }
                }}
              >
                Move to Folder…
              </button>
              <button
                type="button"
                className="context-menu-item danger"
                onClick={() => {
                  const target = contextMenu.paper!;
                  setContextMenu(null);
                  if (window.confirm(`Delete PDF "${target.title}" from library?`)) {
                    void api
                      .deletePaper(target.id)
                      .then(() => onPapersChanged())
                      .then(() => onStatusMessage(`Deleted "${target.title}".`));
                  }
                }}
              >
                Delete PDF…
              </button>
            </>
          )}

          {contextMenu.kind === 'pdf-folder' && contextMenu.pdfFolder && (
            <>
              <button
                type="button"
                className="context-menu-item"
                onClick={() => {
                  const oldName = contextMenu.pdfFolder!;
                  setContextMenu(null);
                  const nextName = window.prompt('Rename PDF folder:', oldName);
                  if (nextName && nextName.trim()) {
                    void handleRenamePdfFolder(oldName, nextName.trim());
                  }
                }}
              >
                Rename Folder…
              </button>
              <button
                type="button"
                className="context-menu-item danger"
                onClick={() => {
                  const oldName = contextMenu.pdfFolder!;
                  setContextMenu(null);
                  if (window.confirm(`Delete PDF folder "${oldName}" (papers will move to Unfiled)?`)) {
                    void handleDeletePdfFolder(oldName);
                  }
                }}
              >
                Delete Folder
              </button>
            </>
          )}
        </div>
      )}
    </aside>
  );
};
