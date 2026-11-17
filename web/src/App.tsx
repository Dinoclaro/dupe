import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DocumentItem,
  GitRepo,
  Paper,
  User,
  api,
  getStoredToken,
  setStoredToken,
} from './api/client';
import {
  ExplorerSidebar,
  ProjectFileItem,
} from './components/Sidebar/ExplorerSidebar';
import { PdfReaderPane } from './components/Reader/PdfReaderPane';
import { LatexEditorPane } from './components/Editor/LatexEditorPane';
import { CompiledPreviewPane } from './components/Editor/CompiledPreviewPane';
import { DiagramPane } from './components/Diagram/DiagramPane';
import { TerminalPane } from './components/Terminal/TerminalPane';
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
We present an academic research workspace that extracts BibTeX entries automatically from PDFs and synchronizes figures and citations with Overleaf via GitHub.
\\end{abstract}

\\section{Introduction}
Type @ or \\cite{} to autocomplete references from your uploaded PDF library. Inline equations such as $E = mc^2$ and display equations render in real time:
$$\\mathcal{L}(\\theta) = \\frac{1}{N}\\sum_{i=1}^{N} \\|f_\\theta(x_i) - y_i\\|_2^2$$

\\section{System Architecture}
\\begin{figure}[h]
  \\includegraphics[width=0.8\\linewidth]{figures/architecture.svg}
  \\caption{System pipeline exported from the Diagram Canvas.}
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
  kind: 'pdf' | 'tex' | 'bib' | 'preview' | 'diagram' | 'terminal';
  paperId?: string;
  filePath?: string;
}

export const App: React.FC = () => {
  const [user, setUser] = useState<User | null>(null);
  const [authChecking, setAuthChecking] = useState(true);
  const [username, setUsername] = useState('dino');
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);

  const [showSidebar, setShowSidebar] = useState(true);
  const [papers, setPapers] = useState<Paper[]>([]);
  const [repos, setRepos] = useState<GitRepo[]>([]);
  const [activeRepoId, setActiveRepoId] = useState<string | null>(null);
  const [repoFilePaths, setRepoFilePaths] = useState<string[]>([]);
  const [docs, setDocs] = useState<DocumentItem[]>([]);

  // File buffers keyed by relative path (e.g. 'main.tex')
  const [fileBuffers, setFileBuffers] = useState<Record<string, string>>({
    'main.tex': DEFAULT_LATEX_TEMPLATE,
  });
  const [activeTexPath, setActiveTexPath] = useState<string>('main.tex');
  const [savingSource, setSavingSource] = useState(false);

  // Diagrams keyed by figure stem (e.g. 'architecture')
  const [diagramsXmlByStem, setDiagramsXmlByStem] = useState<Record<string, string>>({
    architecture: DEFAULT_DRAWIO_XML,
  });
  const [figuresMap, setFiguresMap] = useState<Record<string, string>>(() => ({
    'figures/architecture.svg': exportDiagramToSvg(INITIAL_DIAGRAM_ELEMENTS),
    'architecture.svg': exportDiagramToSvg(INITIAL_DIAGRAM_ELEMENTS),
  }));

  // Editor groups: left = 0, right = 1
  const [leftTabs, setLeftTabs] = useState<StudioTab[]>([
    { id: 'file:main.tex', title: 'main.tex', kind: 'tex', filePath: 'main.tex' },
  ]);
  const [activeLeftTabId, setActiveLeftTabId] = useState<string | null>('file:main.tex');

  const [rightTabs, setRightTabs] = useState<StudioTab[]>([
    { id: 'preview:compiled', title: 'Compiled Paper.pdf', kind: 'preview' },
  ]);
  const [activeRightTabId, setActiveRightTabId] = useState<string | null>('preview:compiled');
  const [focusedGroup, setFocusedGroup] = useState<0 | 1>(0);
  const [splitRatio, setSplitRatio] = useState(0.5);

  const editorStageRef = useRef<HTMLDivElement | null>(null);
  const insertSnippetRef = useRef<((snippet: string) => void) | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const requestIdRef = useRef(0);

  const [statusMessage, setStatusMessage] = useState('Ready.');

  const activeLatexSource = fileBuffers[activeTexPath] ?? DEFAULT_LATEX_TEMPLATE;

  const [compiled, setCompiled] = useState<CompileResponse>(() =>
    compileLatexPreview({
      requestId: 0,
      source: DEFAULT_LATEX_TEMPLATE,
      papers: [],
      figures: figuresMap,
    }),
  );

  // Set up Web Worker for live LaTeX compilation
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
      source: activeLatexSource,
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
  }, [activeLatexSource, papers, figuresMap]);

  const aggregatedBibtex = useMemo(() => {
    if (papers.length === 0) {
      return '% Upload PDFs in the PDF Library above to auto-generate BibTeX entries.\n';
    }
    return (
      '% Auto-generated by dupe from your PDF Library\n\n' +
      papers
        .map((p) => p.bibtex_raw.trim())
        .filter(Boolean)
        .join('\n\n') +
      '\n'
    );
  }, [papers]);

  const projectFiles = useMemo<ProjectFileItem[]>(() => {
    const map = new Map<string, ProjectFileItem>();
    map.set('main.tex', { path: 'main.tex', kind: 'tex' });
    map.set('references.bib', { path: 'references.bib', kind: 'bib' });

    Object.keys(fileBuffers).forEach((p) => {
      if (p.endsWith('.tex')) {
        map.set(p, { path: p, kind: 'tex' });
      } else if (p.endsWith('.bib')) {
        map.set(p, { path: p, kind: 'bib' });
      }
    });

    Object.keys(diagramsXmlByStem).forEach((stem) => {
      const figPath = `figures/${stem}.drawio.svg`;
      map.set(figPath, { path: figPath, kind: 'diagram' });
    });

    repoFilePaths.forEach((f) => {
      if (f.endsWith('.tex')) {
        map.set(f, { path: f, kind: 'tex' });
      } else if (f.endsWith('.bib')) {
        map.set(f, { path: f, kind: 'bib' });
      } else if (f.endsWith('.drawio') || f.endsWith('.excalidraw') || f.endsWith('.svg')) {
        map.set(f, { path: f, kind: 'diagram' });
      } else {
        map.set(f, { path: f, kind: 'other' });
      }
    });

    return Array.from(map.values()).sort((a, b) => a.path.localeCompare(b.path));
  }, [fileBuffers, diagramsXmlByStem, repoFilePaths]);

  const loadPapers = useCallback(async () => {
    const list = await api.listPapers();
    setPapers(list);
  }, []);

  const loadRepos = useCallback(async () => {
    const list = await api.listRepos();
    setRepos(list);
    setActiveRepoId((prev) => {
      if (prev && list.some((r) => r.id === prev)) {
        return prev;
      }
      return list[0]?.id || null;
    });
  }, []);

  const loadInitialWorkspace = useCallback(async () => {
    await Promise.all([loadPapers(), loadRepos()]);
    const allDocs = await api.listDocs();
    setDocs(allDocs);
    const nextBuffers: Record<string, string> = { 'main.tex': DEFAULT_LATEX_TEMPLATE };
    allDocs.forEach((d) => {
      if (d.doc_type === 'latex') {
        nextBuffers[d.title] = d.content || DEFAULT_LATEX_TEMPLATE;
      } else if (d.doc_type === 'diagram') {
        const stem = d.title.replace(/\.(drawio|excalidraw|svg)$/i, '');
        if (d.content.trim().startsWith('<svg') || d.content.trim().startsWith('<?xml') || d.content.trim().startsWith('<mxfile')) {
          setDiagramsXmlByStem((prev) => ({ ...prev, [stem]: d.content }));
          if (d.content.includes('<svg')) {
            setFiguresMap((prev) => ({
              ...prev,
              [`figures/${stem}.svg`]: d.content,
              [`${stem}.svg`]: d.content,
            }));
          }
        }
      }
    });
    setFileBuffers(nextBuffers);
  }, [loadPapers, loadRepos]);

  useEffect(() => {
    const token = getStoredToken();
    if (!token) {
      setAuthChecking(false);
      return;
    }
    api
      .me()
      .then(async (u) => {
        setUser(u);
        await loadInitialWorkspace();
      })
      .catch(() => setStoredToken(null))
      .finally(() => setAuthChecking(false));
  }, [loadInitialWorkspace]);

  useEffect(() => {
    if (!activeRepoId) {
      setRepoFilePaths([]);
      return;
    }
    api
      .listRepoFiles(activeRepoId)
      .then(setRepoFilePaths)
      .catch(() => setRepoFilePaths([]));
  }, [activeRepoId]);

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

  const moveTabToOtherGroup = (tab: StudioTab, fromGroup: 0 | 1, event: React.MouseEvent) => {
    event.stopPropagation();
    const targetGroup: 0 | 1 = fromGroup === 0 ? 1 : 0;
    openTabInGroup(tab, targetGroup);
  };

  // Clicking a PDF opens it in the main viewer (or right split if requested)
  const handleOpenPaper = (paper: Paper, inSplit: boolean) => {
    const tab: StudioTab = {
      id: `pdf:${paper.id}`,
      title: paper.title.length > 26 ? `${paper.title.slice(0, 26)}…` : paper.title,
      kind: 'pdf',
      paperId: paper.id,
    };
    openTabInGroup(tab, inSplit ? 1 : 0);
  };

  // Clicking a LaTeX source file opens the LaTeX code in Group 0 AND the Compiled Paper Preview in Group 1!
  const handleOpenProjectFile = async (file: ProjectFileItem, inSplit: boolean) => {
    if (activeRepoId && repoFilePaths.includes(file.path) && !(file.path in fileBuffers)) {
      try {
        const res = await api.readRepoFile(activeRepoId, file.path);
        setFileBuffers((prev) => ({ ...prev, [file.path]: res.content }));
      } catch {
        // use local buffer if available
      }
    }

    if (file.kind === 'tex') {
      setActiveTexPath(file.path);
      const texTab: StudioTab = {
        id: `file:${file.path}`,
        title: file.path,
        kind: 'tex',
        filePath: file.path,
      };
      const previewTab: StudioTab = {
        id: 'preview:compiled',
        title: 'Compiled Paper.pdf',
        kind: 'preview',
      };
      if (inSplit) {
        openTabInGroup(texTab, 1);
      } else {
        openTabInGroup(texTab, 0);
        openTabInGroup(previewTab, 1);
      }
      return;
    }

    if (file.kind === 'bib') {
      const bibTab: StudioTab = {
        id: `file:${file.path}`,
        title: file.path,
        kind: 'bib',
        filePath: file.path,
      };
      openTabInGroup(bibTab, inSplit ? 1 : 0);
      return;
    }

    if (file.kind === 'diagram') {
      const stem = file.path
        .replace(/^figures\//, '')
        .replace(/\.(drawio\.svg|drawio|excalidraw|svg)$/i, '');
      if (!diagramsXmlByStem[stem]) {
        setDiagramsXmlByStem((prev) => ({ ...prev, [stem]: DEFAULT_DRAWIO_XML }));
      }
      const diagTab: StudioTab = {
        id: `file:${file.path}`,
        title: `figures/${stem}.svg`,
        kind: 'diagram',
        filePath: stem,
      };
      openTabInGroup(diagTab, inSplit ? 1 : 0);
    }
  };

  const handleOpenCompiledPreview = (inSplit: boolean) => {
    const previewTab: StudioTab = {
      id: 'preview:compiled',
      title: 'Compiled Paper.pdf',
      kind: 'preview',
    };
    openTabInGroup(previewTab, inSplit ? 1 : 0);
  };

  const handleOpenTerminal = (inSplit: boolean) => {
    const termTab: StudioTab = {
      id: 'terminal:main',
      title: '>_ Terminal',
      kind: 'terminal',
    };
    openTabInGroup(termTab, inSplit ? 1 : 0);
  };

  const handleCreateTexFile = (filename: string) => {
    setFileBuffers((prev) => ({
      ...prev,
      [filename]: prev[filename] ?? `% ${filename}\n\\section{${filename.replace(/\.tex$/, '')}}\n`,
    }));
    void handleOpenProjectFile({ path: filename, kind: 'tex' }, false);
  };

  const handleCreateDiagramFile = (figureStem: string) => {
    setDiagramsXmlByStem((prev) => ({
      ...prev,
      [figureStem]: prev[figureStem] ?? DEFAULT_DRAWIO_XML,
    }));
    void handleOpenProjectFile(
      { path: `figures/${figureStem}.drawio.svg`, kind: 'diagram' },
      false,
    );
  };

  const handleInsertCitation = (bibtexKey: string) => {
    const citeCmd = `\\cite{${bibtexKey}}`;
    if (insertSnippetRef.current) {
      insertSnippetRef.current(citeCmd);
      setStatusMessage(`Inserted ${citeCmd} into ${activeTexPath}`);
    } else {
      setFileBuffers((prev) => ({
        ...prev,
        [activeTexPath]: `${prev[activeTexPath] || ''}\n${citeCmd}`,
      }));
      setStatusMessage(`Appended ${citeCmd} to ${activeTexPath}`);
    }
  };

  const handleSaveTexFile = async (filePath: string) => {
    const content = fileBuffers[filePath] ?? '';
    setSavingSource(true);
    try {
      if (activeRepoId) {
        await api.writeRepoFile(activeRepoId, filePath, content, false);
        const files = await api.listRepoFiles(activeRepoId);
        setRepoFilePaths(files);
      }
      const existingDoc = docs.find((d) => d.doc_type === 'latex' && d.title === filePath);
      if (existingDoc) {
        const updated = await api.updateDoc(existingDoc.id, { content });
        setDocs((prev) => prev.map((d) => (d.id === updated.id ? updated : d)));
      } else {
        const created = await api.createDoc({
          doc_type: 'latex',
          title: filePath,
          content,
        });
        setDocs((prev) => [...prev, created]);
      }
      setStatusMessage(
        activeRepoId
          ? `Saved ${filePath} (and updated linked Git repo working tree).`
          : `Saved ${filePath}.`,
      );
    } catch (err) {
      setStatusMessage(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSavingSource(false);
    }
  };

  const handleExportFigure = async (
    cleanName: string,
    svgContent: string,
    xmlContent: string,
    insertIntoLatex: boolean,
  ) => {
    const relSvgPath = `figures/${cleanName}.svg`;
    const relDrawioPath = `figures/${cleanName}.drawio`;

    setDiagramsXmlByStem((prev) => ({ ...prev, [cleanName]: svgContent || xmlContent }));
    setFiguresMap((prev) => ({
      ...prev,
      [relSvgPath]: svgContent,
      [`${cleanName}.svg`]: svgContent,
    }));

    const existingDiag = docs.find(
      (d) => d.doc_type === 'diagram' && d.title.startsWith(cleanName),
    );
    if (existingDiag) {
      await api.updateDoc(existingDiag.id, { content: svgContent || xmlContent });
    } else {
      const created = await api.createDoc({
        doc_type: 'diagram',
        title: `${cleanName}.svg`,
        content: svgContent || xmlContent,
      });
      setDocs((prev) => [...prev, created]);
    }

    if (activeRepoId) {
      await api.writeRepoFile(activeRepoId, relSvgPath, svgContent, false);
      await api.writeRepoFile(activeRepoId, relDrawioPath, xmlContent, false);
      const files = await api.listRepoFiles(activeRepoId);
      setRepoFilePaths(files);
    }

    if (insertIntoLatex) {
      const figSnippet = `\n\\begin{figure}[h]\n  \\centering\n  \\includegraphics[width=0.8\\linewidth]{${relSvgPath}}\n  \\caption{${cleanName.replace(/_/g, ' ')}}\n  \\label{fig:${cleanName}}\n\\end{figure}\n`;
      if (insertSnippetRef.current) {
        insertSnippetRef.current(figSnippet);
      } else {
        setFileBuffers((prev) => ({
          ...prev,
          [activeTexPath]: `${prev[activeTexPath] || ''}\n${figSnippet}`,
        }));
      }
    }

    setStatusMessage(
      activeRepoId
        ? `Exported ${relSvgPath} to linked Git repo${insertIntoLatex ? ' and inserted into LaTeX' : ''}.`
        : `Saved ${relSvgPath} in project${insertIntoLatex ? ' and inserted into LaTeX' : ''}.`,
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
          Click a PDF or a LaTeX project file in the left Explorer to open it.
        </div>
      );
    }

    if (tab.kind === 'pdf') {
      const paper = papers.find((p) => p.id === tab.paperId) || null;
      return <PdfReaderPane paper={paper} onInsertCitation={handleInsertCitation} />;
    }

    if (tab.kind === 'preview') {
      return <CompiledPreviewPane compiled={compiled} sourceLabel={activeTexPath} />;
    }

    if (tab.kind === 'terminal') {
      return <TerminalPane activeRepoId={activeRepoId} />;
    }

    if (tab.kind === 'bib') {
      return (
        <LatexEditorPane
          fileLabel={tab.filePath || 'references.bib'}
          source={aggregatedBibtex}
          papers={papers}
          saving={false}
          readOnly
          onChangeSource={() => {}}
          onSaveSource={async () => {}}
          registerInsertSnippet={() => {}}
        />
      );
    }

    if (tab.kind === 'diagram') {
      const stem = tab.filePath || 'architecture';
      const initialXml = diagramsXmlByStem[stem] || DEFAULT_DRAWIO_XML;
      return (
        <DiagramPane
          figureName={stem}
          initialXmlOrSvg={initialXml}
          hasActiveRepo={Boolean(activeRepoId)}
          onSaveDiagram={handleExportFigure}
        />
      );
    }

    const filePath = tab.filePath || 'main.tex';
    const source = fileBuffers[filePath] ?? DEFAULT_LATEX_TEMPLATE;
    return (
      <LatexEditorPane
        fileLabel={filePath}
        source={source}
        papers={papers}
        saving={savingSource}
        onChangeSource={(next) => {
          setActiveTexPath(filePath);
          setFileBuffers((prev) => ({ ...prev, [filePath]: next }));
        }}
        onSaveSource={() => handleSaveTexFile(filePath)}
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
            Dino&apos;s Ultimate Paper Editor — Academic Studio
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
    <div className="studio-shell">
      {/* Top Titlebar */}
      <header className="studio-titlebar">
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
          <span className="brand-sub">Academic Workbench</span>
        </div>

        <div className="row-gap">
          <button
            type="button"
            className="btn-tiny"
            onClick={() => handleOpenTerminal(false)}
            title="Open full-page Terminal tab (for Antigravity / Claude Code)"
          >
            &gt;_ Terminal
          </button>
          <button
            type="button"
            className="btn-tiny"
            onClick={() => handleOpenTerminal(true)}
            title="Open Terminal in Right Split"
          >
            ◫ Split Terminal
          </button>
          <button
            type="button"
            className="btn-tiny"
            onClick={() =>
              void handleOpenProjectFile({ path: activeTexPath, kind: 'tex' }, false)
            }
            title="Open LaTeX Code + Compiled Paper side-by-side"
          >
            LaTeX + Preview Split
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
          <span className="user-badge">{user.username}</span>
          <button type="button" className="btn-tiny" onClick={handleLogout}>
            Sign Out
          </button>
        </div>
      </header>

      {/* Explorer sidebar and split editor groups */}
      <div className="studio-workbench">
        {showSidebar && (
          <ExplorerSidebar
            papers={papers}
            projectFiles={projectFiles}
            activeTabId={currentHighlightedTabId}
            repos={repos}
            activeRepoId={activeRepoId}
            onOpenPaper={handleOpenPaper}
            onOpenProjectFile={(f, split) => void handleOpenProjectFile(f, split)}
            onOpenCompiledPreview={handleOpenCompiledPreview}
            onOpenTerminal={handleOpenTerminal}
            onCreateTexFile={handleCreateTexFile}
            onCreateDiagramFile={handleCreateDiagramFile}
            onInsertCitation={handleInsertCitation}
            onPapersChanged={loadPapers}
            onReposChanged={loadRepos}
            onSelectRepo={setActiveRepoId}
            onStatusMessage={setStatusMessage}
          />
        )}

        <main className="studio-editor-stage" ref={editorStageRef}>
          {/* Left Editor Group */}
          <section
            className={`editor-group ${focusedGroup === 0 ? 'focused' : ''}`}
            style={{ flex: hasRightSplit ? `${splitRatio} 1 0%` : '1 1 0%' }}
            onPointerDown={() => setFocusedGroup(0)}
          >
            <div className="studio-tabbar">
              {leftTabs.map((tab) => {
                const isActive = activeLeftTab?.id === tab.id;
                return (
                  <div
                    key={tab.id}
                    className={`studio-tab ${isActive ? 'active' : ''}`}
                    onClick={() => setActiveLeftTabId(tab.id)}
                  >
                    <span className="studio-tab-title">{tab.title}</span>
                    <button
                      type="button"
                      className="tab-icon-btn"
                      title="Open in Right Split"
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
            </div>
            <div className="editor-group-body">{renderTabContent(activeLeftTab)}</div>
          </section>

          {/* Right Split Editor Group (shown whenever rightTabs is non-empty) */}
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
                <div className="studio-tabbar">
                  {rightTabs.map((tab) => {
                    const isActive = activeRightTab?.id === tab.id;
                    return (
                      <div
                        key={tab.id}
                        className={`studio-tab ${isActive ? 'active' : ''}`}
                        onClick={() => setActiveRightTabId(tab.id)}
                      >
                        <span className="studio-tab-title">{tab.title}</span>
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

      {/* Status bar */}
      <footer className="studio-statusbar">
        <span>{statusMessage}</span>
        <span>
          {papers.length} PDFs in Library · {compiled.citedKeys.length} Citations ·{' '}
          {activeRepoId ? 'GitHub/Overleaf Linked' : 'Local Project'}
        </span>
      </footer>
    </div>
  );
};
