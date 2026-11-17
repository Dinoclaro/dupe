import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Paper,
  ProjectConfig,
  ProjectTreeEntry,
  User,
  api,
  enqueueOutboxEntry,
  getOutboxQueue,
  getStoredGitHubPat,
  getStoredToken,
  loadWorkspaceSnapshot,
  pushFilesToGitHubDirect,
  saveWorkspaceSnapshot,
  setStoredToken,
} from './api/client';
import { ExplorerSidebar } from './components/Sidebar/ExplorerSidebar';
import { PdfReaderPane } from './components/Reader/PdfReaderPane';
import { LatexEditorPane } from './components/Editor/LatexEditorPane';
import { CompiledPreviewPane } from './components/Editor/CompiledPreviewPane';
import { DiagramPane } from './components/Diagram/DiagramPane';
import {
  DEFAULT_DRAWIO_XML,
  DiagramElement,
  exportDiagramToSvg,
} from './components/Diagram/svgExport';
import {
  CompileRequest,
  CompileResponse,
  compileLatexPreview,
} from './workers/latexCompiler';

const DEFAULT_LATEX_TEMPLATE = `\\documentclass{article}
\\title{Self-Hosted Academic Paper Workflow}
\\author{Dino \\and Collaborators}
\\date{November 2026}

\\begin{document}
\\maketitle

\\begin{abstract}
We present a VS Code-style academic research workspace that extracts BibTeX entries automatically from PDFs and synchronizes figures, notes, and citations with Overleaf via GitHub.
\\end{abstract}

\\section{Introduction}
Type @ or \\cite{} to autocomplete references from your uploaded PDF library. Inline equations such as $E = mc^2$ and display equations render in real time:
$$\\mathcal{L}(\\theta) = \\frac{1}{N}\\sum_{i=1}^{N} \\|f_\\theta(x_i) - y_i\\|_2^2$$

\\section{System Architecture}
\\begin{figure}[h]
  \\includegraphics[width=0.8\\linewidth]{figures/architecture.svg}
  \\caption{System pipeline exported from the Draw.io Diagram Canvas.}
\\end{figure}

\\bibliographystyle{plain}
\\bibliography{references}
\\end{document}
`;

const INITIAL_DIAGRAM_ELEMENTS: DiagramElement[] = [
  {
    id: 'node-pdf',
    type: 'rect',
    x: 60,
    y: 90,
    width: 150,
    height: 70,
    stroke: '#1e40af',
    fill: '#dbeafe',
    label: 'PDF Library',
  },
  {
    id: 'arrow-1',
    type: 'arrow',
    x: 215,
    y: 125,
    width: 90,
    height: 0,
    stroke: '#334155',
    fill: '#f1f5f9',
    label: 'PyMuPDF',
  },
  {
    id: 'node-bib',
    type: 'rect',
    x: 315,
    y: 90,
    width: 160,
    height: 70,
    stroke: '#065f46',
    fill: '#d1fae5',
    label: 'references.bib',
  },
  {
    id: 'arrow-2',
    type: 'arrow',
    x: 480,
    y: 125,
    width: 90,
    height: 0,
    stroke: '#334155',
    fill: '#f1f5f9',
    label: 'Git Push',
  },
  {
    id: 'node-overleaf',
    type: 'ellipse',
    x: 580,
    y: 90,
    width: 160,
    height: 70,
    stroke: '#6b21a8',
    fill: '#f3e8ff',
    label: 'Overleaf / LaTeX',
  },
];

export interface StudioTab {
  id: string;
  title: string;
  kind: 'pdf' | 'tex' | 'bib' | 'markdown' | 'preview' | 'diagram' | 'json' | 'other';
  paperId?: string;
  filePath?: string;
}

export const App: React.FC = () => {
  const [user, setUser] = useState<User | null>(null);
  const [authChecking, setAuthChecking] = useState(true);
  const [username, setUsername] = useState('dino');
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);
  const [runtimeMode, setRuntimeMode] = useState<string>('hosted');

  const [isOnline, setIsOnline] = useState<boolean>(
    typeof navigator !== 'undefined' ? navigator.onLine : true,
  );
  const [serverOnline, setServerOnline] = useState<boolean>(true);
  const [outboxCount, setOutboxCount] = useState<number>(() => getOutboxQueue().length);

  const [showSidebar, setShowSidebar] = useState(true);
  const [papers, setPapers] = useState<Paper[]>([]);
  const [projects, setProjects] = useState<ProjectConfig[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [projectTree, setProjectTree] = useState<ProjectTreeEntry[]>([]);

  // File buffers & Git HEAD snapshots keyed by relative project path (e.g. 'paper/main.tex')
  const [fileBuffers, setFileBuffers] = useState<Record<string, string>>({
    'paper/main.tex': DEFAULT_LATEX_TEMPLATE,
  });
  const [headBuffers, setHeadBuffers] = useState<Record<string, string>>({});
  const [externalAgentEdits, setExternalAgentEdits] = useState<Record<string, boolean>>({});
  const [activeEditorPath, setActiveEditorPath] = useState<string>('paper/main.tex');
  const [savingSource, setSavingSource] = useState(false);

  // Diagrams keyed by figure stem (e.g. 'architecture')
  const [diagramsXmlByStem, setDiagramsXmlByStem] = useState<Record<string, string>>({
    architecture: DEFAULT_DRAWIO_XML,
  });
  const [figuresMap, setFiguresMap] = useState<Record<string, string>>(() => ({
    'figures/architecture.svg': exportDiagramToSvg(INITIAL_DIAGRAM_ELEMENTS),
    'architecture.svg': exportDiagramToSvg(INITIAL_DIAGRAM_ELEMENTS),
  }));

  // VS Code Editor Groups (Left = Group 0, Right = Group 1)
  const [leftTabs, setLeftTabs] = useState<StudioTab[]>([
    {
      id: 'file:paper/main.tex',
      title: 'paper/main.tex',
      kind: 'tex',
      filePath: 'paper/main.tex',
    },
  ]);
  const [activeLeftTabId, setActiveLeftTabId] = useState<string | null>(
    'file:paper/main.tex',
  );

  const [rightTabs, setRightTabs] = useState<StudioTab[]>([
    { id: 'preview:compiled', title: 'Compiled Paper.pdf', kind: 'preview' },
  ]);
  const [activeRightTabId, setActiveRightTabId] = useState<string | null>(
    'preview:compiled',
  );
  const [focusedGroup, setFocusedGroup] = useState<0 | 1>(0);
  const [splitRatio, setSplitRatio] = useState(0.5);

  const editorStageRef = useRef<HTMLDivElement | null>(null);
  const insertSnippetRef = useRef<((snippet: string) => void) | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const requestIdRef = useRef(0);

  const [statusMessage, setStatusMessage] = useState('Ready.');

  const activeSourceText = fileBuffers[activeEditorPath] ?? DEFAULT_LATEX_TEMPLATE;

  const [compiled, setCompiled] = useState<CompileResponse>(() =>
    compileLatexPreview({
      requestId: 0,
      source: DEFAULT_LATEX_TEMPLATE,
      papers: [],
      figures: figuresMap,
    }),
  );

  const activeProject = useMemo(
    () => projects.find((p) => p.id === activeProjectId) || projects[0] || null,
    [projects, activeProjectId],
  );

  // Online / Offline & Outbox Synchronization
  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true);
      api
        .flushOutbox()
        .then((flushed) => {
          setOutboxCount(getOutboxQueue().length);
          if (flushed > 0) {
            setStatusMessage(`Flushed ${flushed} queued offline change(s).`);
          }
        })
        .catch(() => {});
    };
    const handleOffline = () => setIsOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // Set up Web Worker for live LaTeX/Markdown compilation
  useEffect(() => {
    try {
      const worker = new Worker(
        new URL('./workers/latexWorker.ts', import.meta.url),
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
      source: activeSourceText,
      papers: papers.map((p) => ({
        bibtex_key: p.bibtex_key,
        title: p.title,
        authors: p.authors,
        publication_year: p.publication_year,
        doi: p.doi,
      })),
      figures: figuresMap,
    };

    const timer = window.setTimeout(() => {
      if (workerRef.current) {
        workerRef.current.postMessage(payload);
      } else {
        setCompiled(compileLatexPreview(payload));
      }
    }, 100);

    return () => window.clearTimeout(timer);
  }, [activeSourceText, papers, figuresMap]);

  const loadPapers = useCallback(async () => {
    const list = await api.listPapers();
    setPapers(list);
    saveWorkspaceSnapshot({ papers: list });
  }, []);

  const refreshProjectTree = useCallback(async (projectId: string) => {
    const res = await api.getProjectTree(projectId);
    setProjectTree(res.files);
    saveWorkspaceSnapshot({ projectTree: res.files });
    return res.files;
  }, []);

  const loadProjects = useCallback(async () => {
    const list = await api.listProjects();
    setProjects(list);
    saveWorkspaceSnapshot({ projects: list });
    if (list.length > 0) {
      const chosenId =
        activeProjectId && list.some((p) => p.id === activeProjectId)
          ? activeProjectId
          : list[0].id;
      setActiveProjectId(chosenId);
      const files = await refreshProjectTree(chosenId);
      const mainTexEntry = files.find((f) => f.path === 'paper/main.tex');
      if (mainTexEntry) {
        try {
          const payload = await api.readProjectFile(chosenId, 'paper/main.tex');
          setFileBuffers((prev) => {
            const next = { ...prev, [payload.path]: payload.content };
            saveWorkspaceSnapshot({ fileBuffers: next });
            return next;
          });
          setHeadBuffers((prev) => ({ ...prev, [payload.path]: payload.head_content }));
        } catch {
          // keep fallback buffer
        }
      }
    }
  }, [activeProjectId, refreshProjectTree]);

  const loadInitialWorkspace = useCallback(async () => {
    await Promise.all([loadPapers(), loadProjects()]);
  }, [loadPapers, loadProjects]);

  useEffect(() => {
    const checkServer = async () => {
      try {
        const h = await api.health();
        setServerOnline(true);
        if (h.mode) {
          setRuntimeMode(h.mode);
        }
        const flushed = await api.flushOutbox();
        if (flushed > 0) {
          setOutboxCount(getOutboxQueue().length);
          setStatusMessage(`Server reconnected: synced ${flushed} queued change(s).`);
        }
      } catch {
        setServerOnline(false);
      }
    };

    void checkServer();
    const interval = window.setInterval(() => void checkServer(), 15000);

    api
      .me()
      .then(async (u) => {
        setUser(u);
        saveWorkspaceSnapshot({ user: u });
        await loadInitialWorkspace();
      })
      .catch(() => {
        const cached = loadWorkspaceSnapshot();
        if (cached.user) {
          setServerOnline(false);
          setUser(cached.user);
          if (cached.papers) {
            setPapers(cached.papers);
          }
          if (cached.projects && cached.projects.length > 0) {
            setProjects(cached.projects);
            setActiveProjectId(cached.projects[0].id);
          }
          if (cached.projectTree) {
            setProjectTree(cached.projectTree);
          }
          if (cached.fileBuffers) {
            setFileBuffers((prev) => ({ ...prev, ...cached.fileBuffers }));
          }
          setStatusMessage(
            'Home server unreachable — loaded cached workspace (Wi-Fi / Direct Git mode active).',
          );
          return;
        }
        if (getStoredToken()) {
          setStoredToken(null);
        }
      })
      .finally(() => setAuthChecking(false));

    return () => window.clearInterval(interval);
  }, [loadInitialWorkspace]);

  const handleSelectProject = async (projectId: string) => {
    setActiveProjectId(projectId);
    const files = await refreshProjectTree(projectId);
    const mainEntry = files.find((f) => f.path === 'paper/main.tex') || files[0];
    if (mainEntry) {
      await handleOpenProjectFile(mainEntry, false, projectId);
    }
  };

  const openTabInGroup = (tab: StudioTab, groupIdx: 0 | 1) => {
    if (groupIdx === 0) {
      setLeftTabs((prev) => (prev.some((t) => t.id === tab.id) ? prev : [...prev, tab]));
      setActiveLeftTabId(tab.id);
      setFocusedGroup(0);
    } else {
      setRightTabs((prev) => (prev.some((t) => t.id === tab.id) ? prev : [...prev, tab]));
      setActiveRightTabId(tab.id);
      setFocusedGroup(1);
    }
  };

  const closeTabInGroup = (tabId: string, groupIdx: 0 | 1, event: React.MouseEvent) => {
    event.stopPropagation();
    if (groupIdx === 0) {
      setLeftTabs((prev) => {
        const next = prev.filter((t) => t.id !== tabId);
        if (activeLeftTabId === tabId) {
          setActiveLeftTabId(next[next.length - 1]?.id || null);
        }
        return next;
      });
    } else {
      setRightTabs((prev) => {
        const next = prev.filter((t) => t.id !== tabId);
        if (activeRightTabId === tabId) {
          setActiveRightTabId(next[next.length - 1]?.id || null);
        }
        return next;
      });
    }
  };

  const moveTabToOtherGroup = (tab: StudioTab, fromGroup: 0 | 1, event?: React.MouseEvent) => {
    if (event) {
      event.stopPropagation();
    }
    const targetGroup: 0 | 1 = fromGroup === 0 ? 1 : 0;
    if (fromGroup === 0) {
      setLeftTabs((prev) => {
        const next = prev.filter((t) => t.id !== tab.id);
        if (activeLeftTabId === tab.id) {
          setActiveLeftTabId(next[next.length - 1]?.id || null);
        }
        return next;
      });
    } else {
      setRightTabs((prev) => {
        const next = prev.filter((t) => t.id !== tab.id);
        if (activeRightTabId === tab.id) {
          setActiveRightTabId(next[next.length - 1]?.id || null);
        }
        return next;
      });
    }
    openTabInGroup(tab, targetGroup);
  };

  const handleTabDropOnGroup = (targetGroup: 0 | 1, event: React.DragEvent) => {
    event.preventDefault();
    const rawTab = event.dataTransfer.getData('application/x-dupe-tab');
    if (rawTab) {
      try {
        const parsed = JSON.parse(rawTab) as { tab: StudioTab; fromGroup: 0 | 1 };
        if (parsed.fromGroup !== targetGroup) {
          moveTabToOtherGroup(parsed.tab, parsed.fromGroup);
        } else {
          openTabInGroup(parsed.tab, targetGroup);
        }
        return;
      } catch {
        // ignore invalid payload
      }
    }
    const droppedPaperId = event.dataTransfer.getData('application/x-dupe-paper-id');
    if (droppedPaperId) {
      const found = papers.find((p) => p.id === droppedPaperId);
      if (found) {
        const tab: StudioTab = {
          id: `pdf:${found.id}`,
          title: found.title.length > 28 ? `${found.title.slice(0, 28)}…` : found.title,
          kind: 'pdf',
          paperId: found.id,
        };
        openTabInGroup(tab, targetGroup);
      }
    }
  };

  const handleOpenPaper = (paper: Paper, inSplit: boolean) => {
    const tab: StudioTab = {
      id: `pdf:${paper.id}`,
      title: paper.title.length > 26 ? `${paper.title.slice(0, 26)}…` : paper.title,
      kind: 'pdf',
      paperId: paper.id,
    };
    openTabInGroup(tab, inSplit ? 1 : 0);
  };

  const handleOpenProjectFile = async (
    file: ProjectTreeEntry,
    inSplit: boolean,
    overrideProjId?: string,
  ) => {
    const projId = overrideProjId || activeProject?.id;
    if (projId) {
      try {
        const res = await api.readProjectFile(projId, file.path);
        const diskDiffersFromHead = Boolean(
          res.head_content && res.head_content !== res.content,
        );
        setFileBuffers((prev) => ({ ...prev, [res.path]: res.content }));
        setHeadBuffers((prev) => ({ ...prev, [res.path]: res.head_content }));
        setExternalAgentEdits((prev) => ({
          ...prev,
          [res.path]: diskDiffersFromHead && prev[res.path] !== false,
        }));
        if (file.kind === 'diagram' && res.content.trim().startsWith('<')) {
          const stem = file.path
            .replace(/^(diagrams|paper\/figures)\//, '')
            .replace(/\.(drawio\.svg|drawio|excalidraw|svg)$/i, '');
          setDiagramsXmlByStem((prev) => ({ ...prev, [stem]: res.content }));
        }
      } catch {
        // use local buffer
      }
    }

    if (file.kind === 'tex') {
      setActiveEditorPath(file.path);
      const docTab: StudioTab = {
        id: `file:${file.path}`,
        title: file.path,
        kind: file.kind,
        filePath: file.path,
      };
      const previewTab: StudioTab = {
        id: 'preview:compiled',
        title: 'Compiled Paper.pdf',
        kind: 'preview',
      };
      if (inSplit) {
        openTabInGroup(docTab, 1);
      } else {
        openTabInGroup(docTab, 0);
        openTabInGroup(previewTab, 1);
      }
      return;
    }

    if (file.kind === 'markdown') {
      const mdTab: StudioTab = {
        id: `file:${file.path}`,
        title: file.path,
        kind: 'markdown',
        filePath: file.path,
      };
      openTabInGroup(mdTab, inSplit ? 1 : 0);
      return;
    }

    if (file.kind === 'diagram') {
      const stem = file.path
        .replace(/^(diagrams|paper\/figures)\//, '')
        .replace(/\.(drawio\.svg|drawio|excalidraw|svg)$/i, '');
      if (!diagramsXmlByStem[stem]) {
        setDiagramsXmlByStem((prev) => ({ ...prev, [stem]: DEFAULT_DRAWIO_XML }));
      }
      const diagTab: StudioTab = {
        id: `file:${file.path}`,
        title: `diagrams/${stem}.svg`,
        kind: 'diagram',
        filePath: stem,
      };
      openTabInGroup(diagTab, inSplit ? 1 : 0);
      return;
    }

    const genericTab: StudioTab = {
      id: `file:${file.path}`,
      title: file.path,
      kind: file.kind,
      filePath: file.path,
    };
    openTabInGroup(genericTab, inSplit ? 1 : 0);
  };

  const handleOpenCompiledPreview = (inSplit: boolean) => {
    const previewTab: StudioTab = {
      id: 'preview:compiled',
      title: 'Compiled Paper.pdf',
      kind: 'preview',
    };
    openTabInGroup(previewTab, inSplit ? 1 : 0);
  };

  const handleCreateProjectFile = async (
    kind: 'tex' | 'markdown' | 'diagram',
    rawName: string,
  ) => {
    if (!activeProject) {
      return;
    }
    if (kind === 'diagram') {
      const stem = rawName
        .replace(/^(diagrams|paper\/figures)\//, '')
        .replace(/\.(drawio\.svg|drawio|excalidraw|svg)$/i, '');
      const diagPath = `diagrams/${stem}.drawio.svg`;
      await api.writeProjectFile(activeProject.id, diagPath, DEFAULT_DRAWIO_XML, false);
      await refreshProjectTree(activeProject.id);
      await handleOpenProjectFile({ path: diagPath, kind: 'diagram' }, false);
      return;
    }

    let relPath = rawName;
    if (kind === 'tex') {
      if (!relPath.startsWith('paper/')) {
        relPath = `paper/${relPath}`;
      }
      if (!relPath.endsWith('.tex')) {
        relPath += '.tex';
      }
    } else if (kind === 'markdown') {
      if (!relPath.startsWith('notes/')) {
        relPath = `notes/${relPath}`;
      }
      if (!relPath.endsWith('.md')) {
        relPath += '.md';
      }
    }

    const initialContent =
      kind === 'tex'
        ? `% ${relPath}\n\\section{${relPath.replace(/^paper\//, '').replace(/\.tex$/, '')}}\n`
        : `# ${relPath.replace(/^notes\//, '').replace(/\.md$/, '')}\n\n`;

    await api.writeProjectFile(activeProject.id, relPath, initialContent, false);
    await refreshProjectTree(activeProject.id);
    await handleOpenProjectFile({ path: relPath, kind }, false);
  };

  const handleInsertCitation = (bibtexKey: string) => {
    const isMd = activeEditorPath.endsWith('.md');
    const citeCmd = isMd ? `[[paper:${bibtexKey}]]` : `\\cite{${bibtexKey}}`;
    if (insertSnippetRef.current) {
      insertSnippetRef.current(citeCmd);
      setStatusMessage(`Inserted ${citeCmd} into ${activeEditorPath}`);
    } else {
      setFileBuffers((prev) => ({
        ...prev,
        [activeEditorPath]: `${prev[activeEditorPath] || ''}\n${citeCmd}`,
      }));
      setStatusMessage(`Appended ${citeCmd} to ${activeEditorPath}`);
    }
  };

  const handleSaveProjectFile = async (filePath: string) => {
    if (!activeProject) {
      return;
    }
    const content = fileBuffers[filePath] ?? '';
    setSavingSource(true);
    try {
      const res = await api.writeProjectFile(activeProject.id, filePath, content, false);
      setHeadBuffers((prev) => ({ ...prev, [filePath]: res.head_content }));
      setExternalAgentEdits((prev) => ({ ...prev, [filePath]: false }));
      await refreshProjectTree(activeProject.id);
      setStatusMessage(`Saved ${filePath}.`);
    } catch {
      const q = enqueueOutboxEntry({
        id: `file:${activeProject.id}:${filePath}`,
        kind: 'project_file',
        projectId: activeProject.id,
        path: filePath,
        content,
        updatedAt: new Date().toISOString(),
      });
      setOutboxCount(q.length);
      setStatusMessage(`Offline: queued ${filePath} in outbox (${q.length} pending).`);
    } finally {
      setSavingSource(false);
    }
  };

  const handleRevertProjectFile = async (filePath: string) => {
    if (!activeProject) {
      return;
    }
    try {
      const res = await api.revertProjectFile(activeProject.id, filePath);
      setFileBuffers((prev) => ({ ...prev, [filePath]: res.content }));
      setHeadBuffers((prev) => ({ ...prev, [filePath]: res.head_content }));
      await refreshProjectTree(activeProject.id);
      setStatusMessage(`Reverted ${filePath} to Git HEAD.`);
    } catch (err) {
      setStatusMessage(`Revert failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const buildLocalReferencesBib = useCallback((): string => {
    const entries = papers
      .map((p) => (p.bibtex_raw || '').trim())
      .filter(Boolean);
    return `% Generated by dupe browser cache (${entries.length} entries)\n\n${entries.join('\n\n')}\n`;
  }, [papers]);

  const handleExportOverleafBundle = useCallback(() => {
    const downloadFile = (filename: string, text: string) => {
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    };
    const mainTex = fileBuffers['paper/main.tex'] || activeSourceText;
    const refsBib = buildLocalReferencesBib();
    downloadFile('main.tex', mainTex);
    window.setTimeout(() => downloadFile('references.bib', refsBib), 200);
    setStatusMessage('Downloaded main.tex and references.bib from browser cache.');
  }, [fileBuffers, activeSourceText, buildLocalReferencesBib]);

  const handleSyncActiveProject = async () => {
    if (!activeProject) {
      return;
    }
    try {
      const res = await api.syncProject(activeProject.id);
      setServerOnline(true);
      await loadProjects();
      const files = await refreshProjectTree(activeProject.id);
      for (const f of files) {
        if (f.path in fileBuffers) {
          setHeadBuffers((prev) => ({ ...prev, [f.path]: fileBuffers[f.path] }));
        }
      }
      if (res.pushed) {
        setStatusMessage(`Committed & pushed paper/ (${res.paper_sha.slice(0, 7)}) to Overleaf GitHub.`);
      } else if (res.pending_push) {
        setStatusMessage(`Committed locally; push queued (${res.push_warning}).`);
      } else {
        setStatusMessage(
          res.committed
            ? `Committed project changes (${res.paper_sha.slice(0, 7)}).`
            : 'Regenerated AGENTS.md & references.bib (working tree clean).',
        );
      }
    } catch (err) {
      setServerOnline(false);
      const pat = getStoredGitHubPat();
      if (isOnline && activeProject.overleaf_remote && pat) {
        try {
          const filesToPush = [
            {
              path: 'paper/main.tex',
              content: fileBuffers['paper/main.tex'] || activeSourceText,
            },
            {
              path: 'paper/references.bib',
              content: buildLocalReferencesBib(),
            },
          ];
          const count = await pushFilesToGitHubDirect(
            activeProject.overleaf_remote,
            pat,
            filesToPush,
          );
          setStatusMessage(
            `Home server down — pushed ${count} files (main.tex + references.bib) directly from browser to GitHub!`,
          );
          return;
        } catch (ghErr) {
          setStatusMessage(
            `Server down & direct GitHub push failed: ${
              ghErr instanceof Error ? ghErr.message : String(ghErr)
            }`,
          );
          return;
        }
      }
      setStatusMessage(
        `Server unreachable (${
          err instanceof Error ? err.message : String(err)
        }). Use '⚙ -> ⬇ Export .tex + .bib' or configure a GitHub PAT for direct browser push.`,
      );
    }
  };

  const handleExportFigure = async (
    cleanName: string,
    svgContent: string,
    xmlContent: string,
    insertIntoLatex: boolean,
  ) => {
    const relSvgPath = `figures/${cleanName}.svg`;
    const diagPath = `diagrams/${cleanName}.drawio.svg`;

    setDiagramsXmlByStem((prev) => ({ ...prev, [cleanName]: svgContent || xmlContent }));
    setFiguresMap((prev) => ({
      ...prev,
      [relSvgPath]: svgContent,
      [`${cleanName}.svg`]: svgContent,
    }));

    if (activeProject) {
      await api.writeProjectFile(activeProject.id, diagPath, svgContent || xmlContent, false);
      await refreshProjectTree(activeProject.id);
    }

    if (insertIntoLatex) {
      const figSnippet = `\n\\begin{figure}[h]\n  \\centering\n  \\includegraphics[width=0.8\\linewidth]{${relSvgPath}}\n  \\caption{${cleanName.replace(/_/g, ' ')}}\n  \\label{fig:${cleanName}}\n\\end{figure}\n`;
      if (insertSnippetRef.current) {
        insertSnippetRef.current(figSnippet);
      } else {
        setFileBuffers((prev) => ({
          ...prev,
          [activeEditorPath]: `${prev[activeEditorPath] || ''}\n${figSnippet}`,
        }));
      }
    }

    setStatusMessage(
      `Saved ${diagPath} and exported paper/${relSvgPath}${
        insertIntoLatex ? ' (inserted into editor)' : ''
      }.`,
    );
  };

  const handleGroupSplitDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const stage = editorStageRef.current;
    if (!stage) {
      return;
    }
    const rect = stage.getBoundingClientRect();

    const onMove = (moveEvent: PointerEvent) => {
      const relX = moveEvent.clientX - rect.left;
      const nextRatio = Math.max(0.2, Math.min(0.8, relX / Math.max(1, rect.width)));
      setSplitRatio(nextRatio);
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const renderTabContent = (tab: StudioTab | null) => {
    if (!tab) {
      return (
        <div className="empty-hint">
          Click a PDF or a project file in the left Explorer to open it.
        </div>
      );
    }

    if (tab.kind === 'pdf') {
      const paper = papers.find((p) => p.id === tab.paperId) || null;
      return (
        <PdfReaderPane
          key={tab.id}
          paper={paper}
          onInsertCitation={handleInsertCitation}
        />
      );
    }

    if (tab.kind === 'preview') {
      return (
        <CompiledPreviewPane
          key={tab.id}
          compiled={compiled}
          sourceLabel={activeEditorPath}
        />
      );
    }

    if (tab.kind === 'diagram') {
      const stem = tab.filePath || 'architecture';
      const initialXml = diagramsXmlByStem[stem] || DEFAULT_DRAWIO_XML;
      return (
        <DiagramPane
          key={tab.id}
          figureName={stem}
          initialXmlOrSvg={initialXml}
          hasActiveRepo={Boolean(activeProject?.overleaf_remote)}
          onSaveDiagram={handleExportFigure}
        />
      );
    }

    const filePath = tab.filePath || 'paper/main.tex';
    const source = fileBuffers[filePath] ?? '';
    const headContent = headBuffers[filePath] ?? '';
    const isGeneratedReadOnly =
      filePath === 'AGENTS.md' ||
      filePath === 'paper/references.bib' ||
      filePath.startsWith('refs/');

    return (
      <LatexEditorPane
        key={tab.id}
        fileLabel={filePath}
        source={source}
        headContent={headContent}
        hasExternalAgentEdit={Boolean(externalAgentEdits[filePath])}
        papers={papers}
        saving={savingSource}
        readOnly={isGeneratedReadOnly}
        onChangeSource={(next) => {
          if (filePath.endsWith('.tex')) {
            setActiveEditorPath(filePath);
          }
          setExternalAgentEdits((prev) => ({ ...prev, [filePath]: false }));
          setFileBuffers((prev) => {
            const updated = { ...prev, [filePath]: next };
            saveWorkspaceSnapshot({ fileBuffers: updated });
            return updated;
          });
        }}
        onSaveSource={() => handleSaveProjectFile(filePath)}
        onRevertToHead={() => handleRevertProjectFile(filePath)}
        onAcceptAgentEdits={() => {
          setHeadBuffers((prev) => ({ ...prev, [filePath]: source }));
          setExternalAgentEdits((prev) => ({ ...prev, [filePath]: false }));
        }}
        onOpenPreviewSplit={() => handleOpenCompiledPreview(true)}
        registerInsertSnippet={(fn) => {
          insertSnippetRef.current = fn;
        }}
      />
    );
  };

  const handleLogin = async (event: React.FormEvent) => {
    event.preventDefault();
    setAuthError(null);
    try {
      const res = await api.login(username, password);
      setUser(res.user);
      await loadInitialWorkspace();
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Login failed');
    }
  };

  const handleLogout = () => {
    setStoredToken(null);
    setUser(null);
  };

  if (authChecking) {
    return <div className="auth-screen">Checking session...</div>;
  }

  if (!user) {
    return (
      <div className="auth-screen">
        <form className="auth-card" onSubmit={handleLogin}>
          <h1>dupe</h1>
          <p className="muted-hint">
            Dino&apos;s Ultimate Paper Editor — VS Code Academic Studio
          </p>
          {authError && <div className="auth-error">{authError}</div>}
          <label>
            Username
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
            />
          </label>
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="dino-dev-password"
              required
            />
          </label>
          <button type="submit" className="btn-primary">
            Sign In
          </button>
        </form>
      </div>
    );
  }

  const activeLeftTab = leftTabs.find((t) => t.id === activeLeftTabId) || leftTabs[0] || null;
  const activeRightTab = rightTabs.find((t) => t.id === activeRightTabId) || rightTabs[0] || null;
  const hasRightSplit = rightTabs.length > 0;
  const currentHighlightedTabId =
    focusedGroup === 0 ? activeLeftTab?.id || null : activeRightTab?.id || null;

  return (
    <div className="vscode-shell">
      {/* Top Titlebar */}
      <header className="vscode-titlebar">
        <div className="brand-group">
          <button
            type="button"
            className={`btn-tiny ${showSidebar ? 'active-btn' : ''}`}
            onClick={() => setShowSidebar((v) => !v)}
            title="Toggle Explorer Sidebar"
          >
            ☰ Explorer
          </button>
          <strong className="brand-logo">dupe</strong>
          <span className="brand-sub">
            {activeProject ? activeProject.name : 'Academic Workbench'}
          </span>
        </div>

        <div className="row-gap">
          <button
            type="button"
            className="btn-tiny"
            onClick={() =>
              void handleOpenProjectFile(
                {
                  path: activeEditorPath,
                  kind: activeEditorPath.endsWith('.md') ? 'markdown' : 'tex',
                },
                false,
              )
            }
            title="Open Editor + Compiled Preview side-by-side"
          >
            Editor + Preview Split
          </button>
          <button
            type="button"
            className="btn-tiny"
            onClick={() => handleOpenCompiledPreview(true)}
            title="Open Compiled Preview in Right Split"
          >
            ◫ Split Preview
          </button>
        </div>

        <div className="user-group">
          <span className="user-badge">
            {user.username} ({runtimeMode})
          </span>
          {runtimeMode !== 'local' && (
            <button type="button" className="btn-tiny" onClick={handleLogout}>
              Sign Out
            </button>
          )}
        </div>
      </header>

      {/* Main Workbench Area: Explorer Sidebar + Split Editor Groups */}
      <div className="vscode-workbench">
        {showSidebar && (
          <ExplorerSidebar
            papers={papers}
            projects={projects}
            activeProject={activeProject}
            projectFiles={projectTree}
            activeTabId={currentHighlightedTabId}
            onSelectProject={(id) => void handleSelectProject(id)}
            onProjectsChanged={loadProjects}
            onOpenPaper={handleOpenPaper}
            onOpenProjectFile={(f, split) => void handleOpenProjectFile(f, split)}
            onOpenCompiledPreview={handleOpenCompiledPreview}
            onCreateProjectFile={handleCreateProjectFile}
            onSyncProject={handleSyncActiveProject}
            onExportOverleafBundle={handleExportOverleafBundle}
            onInsertCitation={handleInsertCitation}
            onPapersChanged={async () => {
              await loadPapers();
              if (activeProject) {
                await refreshProjectTree(activeProject.id);
              }
            }}
            onStatusMessage={setStatusMessage}
          />
        )}

        <main className="vscode-editor-stage" ref={editorStageRef}>
          {/* Left Editor Group */}
          <section
            className={`editor-group ${focusedGroup === 0 ? 'focused' : ''}`}
            style={{ flex: hasRightSplit ? `${splitRatio} 1 0%` : '1 1 0%' }}
            onPointerDown={() => setFocusedGroup(0)}
          >
            <div
              className="vscode-tabbar"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => handleTabDropOnGroup(0, e)}
            >
              {leftTabs.map((tab) => {
                const isActive = activeLeftTab?.id === tab.id;
                const livePaper =
                  tab.kind === 'pdf'
                    ? papers.find((p) => p.id === tab.paperId)
                    : undefined;
                const displayTitle = livePaper
                  ? livePaper.title.length > 28
                    ? `${livePaper.title.slice(0, 28)}…`
                    : livePaper.title
                  : tab.title;
                return (
                  <div
                    key={tab.id}
                    className={`vscode-tab ${isActive ? 'active' : ''}`}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData(
                        'application/x-dupe-tab',
                        JSON.stringify({ tab, fromGroup: 0 }),
                      );
                    }}
                    onClick={() => setActiveLeftTabId(tab.id)}
                    title={livePaper ? `${livePaper.title} (@${livePaper.bibtex_key}) — Drag tab to right split` : `${tab.title} — Drag tab to right split`}
                  >
                    <span className="vscode-tab-title">{displayTitle}</span>
                    <button
                      type="button"
                      className="tab-icon-btn"
                      title="Move to Right Split"
                      onClick={(e) => moveTabToOtherGroup(tab, 0, e)}
                    >
                      ◫
                    </button>
                    <button
                      type="button"
                      className="tab-icon-btn"
                      title="Close Tab"
                      onClick={(e) => closeTabInGroup(tab.id, 0, e)}
                    >
                      ×
                    </button>
                  </div>
                );
              })}
              {!hasRightSplit && (
                <div
                  className="tab-drop-split-zone"
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => handleTabDropOnGroup(1, e)}
                  title="Drag any tab or paper here to open in Right Split"
                >
                  ⇢ Drop here to Split Right
                </div>
              )}
            </div>
            <div className="editor-group-body">{renderTabContent(activeLeftTab)}</div>
          </section>

          {/* Right Split Editor Group */}
          {hasRightSplit && (
            <>
              <div
                className="pane-divider"
                role="separator"
                aria-orientation="vertical"
                onPointerDown={handleGroupSplitDrag}
              />
              <section
                className={`editor-group ${focusedGroup === 1 ? 'focused' : ''}`}
                style={{ flex: `${1 - splitRatio} 1 0%` }}
                onPointerDown={() => setFocusedGroup(1)}
              >
                <div
                  className="vscode-tabbar"
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => handleTabDropOnGroup(1, e)}
                >
                  {rightTabs.map((tab) => {
                    const isActive = activeRightTab?.id === tab.id;
                    const livePaper =
                      tab.kind === 'pdf'
                        ? papers.find((p) => p.id === tab.paperId)
                        : undefined;
                    const displayTitle = livePaper
                      ? livePaper.title.length > 28
                        ? `${livePaper.title.slice(0, 28)}…`
                        : livePaper.title
                      : tab.title;
                    return (
                      <div
                        key={tab.id}
                        className={`vscode-tab ${isActive ? 'active' : ''}`}
                        draggable
                        onDragStart={(e) => {
                          e.dataTransfer.setData(
                            'application/x-dupe-tab',
                            JSON.stringify({ tab, fromGroup: 1 }),
                          );
                        }}
                        onClick={() => setActiveRightTabId(tab.id)}
                        title={livePaper ? `${livePaper.title} (@${livePaper.bibtex_key}) — Drag tab to left split` : `${tab.title} — Drag tab to left split`}
                      >
                        <span className="vscode-tab-title">{displayTitle}</span>
                        <button
                          type="button"
                          className="tab-icon-btn"
                          title="Move to Left Split"
                          onClick={(e) => moveTabToOtherGroup(tab, 1, e)}
                        >
                          ◧
                        </button>
                        <button
                          type="button"
                          className="tab-icon-btn"
                          title="Close Tab"
                          onClick={(e) => closeTabInGroup(tab.id, 1, e)}
                        >
                          ×
                        </button>
                      </div>
                    );
                  })}
                </div>
                <div className="editor-group-body">{renderTabContent(activeRightTab)}</div>
              </section>
            </>
          )}
        </main>
      </div>

      {/* VS Code Bottom Statusbar */}
      <footer className="vscode-statusbar">
        <span>{statusMessage}</span>
        <span>
          {serverOnline
            ? '● Server Online'
            : isOnline
              ? '◐ Server Down · Wi-Fi Active (Direct Git Ready)'
              : '○ Offline (No Wi-Fi)'}{' '}
          · Outbox: {outboxCount} · {papers.length} PDFs · {compiled.citedKeys.length} Cited ·{' '}
          {activeProject?.overleaf_remote ? 'Overleaf Linked' : 'Local Git'}
        </span>
      </footer>
    </div>
  );
};
