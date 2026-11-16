import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  DocumentItem,
  GitRepo,
  Paper,
  User,
  api,
  getStoredToken,
  setStoredToken,
} from './api/client';
import { SplitWorkspace } from './components/Workspace/SplitWorkspace';
import { LibraryPane } from './components/Library/LibraryPane';
import { PdfReaderPane } from './components/Reader/PdfReaderPane';
import { LatexEditorPane } from './components/Editor/LatexEditorPane';
import { DiagramPane } from './components/Diagram/DiagramPane';
import { DiagramElement, exportDiagramToSvg } from './components/Diagram/svgExport';

const DEFAULT_LATEX_TEMPLATE = `\\documentclass{article}
\\title{Self-Hosted Academic Paper Workflow}
\\author{Dino \\and Collaborators}
\\date{November 2026}

\\begin{document}
\\maketitle

\\begin{abstract}
We present a split-pane research workspace that extracts BibTeX entries automatically from PDFs and synchronizes figures and citations with Overleaf via GitHub.
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

export const App: React.FC = () => {
  const [user, setUser] = useState<User | null>(null);
  const [authChecking, setAuthChecking] = useState(true);
  const [username, setUsername] = useState('dino');
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);

  const [papers, setPapers] = useState<Paper[]>([]);
  const [selectedPaper, setSelectedPaper] = useState<Paper | null>(null);

  const [repos, setRepos] = useState<GitRepo[]>([]);
  const [activeRepoId, setActiveRepoId] = useState<string | null>(null);
  const [repoFiles, setRepoFiles] = useState<string[]>([]);

  const [activeDoc, setActiveDoc] = useState<DocumentItem | null>(null);
  const [activeRepoFilePath, setActiveRepoFilePath] = useState<string | null>(null);
  const [latexSource, setLatexSource] = useState(DEFAULT_LATEX_TEMPLATE);
  const [savingSource, setSavingSource] = useState(false);

  const [figureName, setFigureName] = useState('architecture');
  const [diagramElements, setDiagramElements] = useState<DiagramElement[]>(
    INITIAL_DIAGRAM_ELEMENTS,
  );
  const [figuresMap, setFiguresMap] = useState<Record<string, string>>(() => ({
    'figures/architecture.svg': exportDiagramToSvg(INITIAL_DIAGRAM_ELEMENTS),
  }));

  const [showLibrary, setShowLibrary] = useState(true);
  const [showReader, setShowReader] = useState(false);
  const [showEditor, setShowEditor] = useState(true);
  const [showDiagram, setShowDiagram] = useState(true);
  const [statusMessage, setStatusMessage] = useState('Ready.');

  const insertSnippetRef = useRef<((snippet: string) => void) | null>(null);

  const loadPapers = useCallback(async () => {
    const list = await api.listPapers();
    setPapers(list);
    setSelectedPaper((prev) => {
      if (prev) {
        return list.find((p) => p.id === prev.id) || list[0] || null;
      }
      return list[0] || null;
    });
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
    const docs = await api.listDocs('latex');
    if (docs.length > 0) {
      setActiveDoc(docs[0]);
      setLatexSource(docs[0].content || DEFAULT_LATEX_TEMPLATE);
    }
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
      .catch(() => {
        setStoredToken(null);
      })
      .finally(() => setAuthChecking(false));
  }, [loadInitialWorkspace]);

  useEffect(() => {
    if (!activeRepoId) {
      setRepoFiles([]);
      return;
    }
    api
      .listRepoFiles(activeRepoId)
      .then(setRepoFiles)
      .catch(() => setRepoFiles([]));
  }, [activeRepoId]);

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

  const handleSelectPaper = (paper: Paper) => {
    setSelectedPaper(paper);
    setShowReader(true);
  };

  const handleInsertCitation = (bibtexKey: string) => {
    const citeCmd = `\\cite{${bibtexKey}}`;
    if (insertSnippetRef.current) {
      insertSnippetRef.current(citeCmd);
      setStatusMessage(`Inserted ${citeCmd}`);
    } else {
      setLatexSource((prev) => `${prev}\n${citeCmd}`);
      setStatusMessage(`Appended ${citeCmd}`);
    }
  };

  const handleOpenRepoFile = async (repoId: string, filePath: string) => {
    try {
      const res = await api.readRepoFile(repoId, filePath);
      setActiveRepoFilePath(res.path);
      setLatexSource(res.content);
      setShowEditor(true);
      setStatusMessage(`Opened ${res.path} from linked Git repository.`);
    } catch (err) {
      setStatusMessage(`Failed to read ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleSaveSource = async () => {
    setSavingSource(true);
    try {
      if (activeRepoId && activeRepoFilePath) {
        await api.writeRepoFile(activeRepoId, activeRepoFilePath, latexSource, false);
        const files = await api.listRepoFiles(activeRepoId);
        setRepoFiles(files);
        setStatusMessage(`Saved ${activeRepoFilePath} to linked Git repository.`);
      } else if (activeDoc) {
        const updated = await api.updateDoc(activeDoc.id, { content: latexSource });
        setActiveDoc(updated);
        setStatusMessage(`Saved manuscript "${updated.title}".`);
      } else {
        const created = await api.createDoc({
          doc_type: 'latex',
          title: 'main.tex',
          content: latexSource,
        });
        setActiveDoc(created);
        setStatusMessage('Created and saved main.tex in workspace.');
      }
    } catch (err) {
      setStatusMessage(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSavingSource(false);
    }
  };

  const handleDiagramChange = (elements: DiagramElement[]) => {
    setDiagramElements(elements);
    const cleanName =
      figureName
        .trim()
        .replace(/\.(svg|excalidraw|pdf)$/i, '')
        .replace(/[^a-zA-Z0-9_-]/g, '_') || 'architecture';
    const svg = exportDiagramToSvg(elements);
    setFiguresMap((prev) => ({
      ...prev,
      [`figures/${cleanName}.svg`]: svg,
      [`${cleanName}.svg`]: svg,
    }));
  };

  const handleExportFigure = async (
    cleanName: string,
    svgContent: string,
    sceneJson: string,
    insertIntoLatex: boolean,
  ) => {
    const relSvgPath = `figures/${cleanName}.svg`;
    const relExcalidrawPath = `figures/${cleanName}.excalidraw`;

    setFiguresMap((prev) => ({
      ...prev,
      [relSvgPath]: svgContent,
      [`${cleanName}.svg`]: svgContent,
    }));

    await api.createDoc({
      doc_type: 'diagram',
      title: `${cleanName}.excalidraw`,
      content: sceneJson,
    });

    if (activeRepoId) {
      await api.writeRepoFile(activeRepoId, relSvgPath, svgContent, false);
      await api.writeRepoFile(activeRepoId, relExcalidrawPath, sceneJson, false);
      const files = await api.listRepoFiles(activeRepoId);
      setRepoFiles(files);
    }

    if (insertIntoLatex) {
      const figSnippet = `\n\\begin{figure}[h]\n  \\centering\n  \\includegraphics[width=0.8\\linewidth]{${relSvgPath}}\n  \\caption{${cleanName.replace(/_/g, ' ')}}\n  \\label{fig:${cleanName}}\n\\end{figure}\n`;
      if (insertSnippetRef.current) {
        insertSnippetRef.current(figSnippet);
      } else {
        setLatexSource((prev) => `${prev}\n${figSnippet}`);
      }
    }

    setStatusMessage(
      activeRepoId
        ? `Exported ${relSvgPath} to linked Git repo${insertIntoLatex ? ' and inserted into LaTeX' : ''}.`
        : `Saved ${relSvgPath} in workspace${insertIntoLatex ? ' and inserted into LaTeX' : ''}.`,
    );
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
            Dino&apos;s Ultimate Paper Editor — PDF Library, Auto-BibTeX, Overleaf-GitHub Bridge &amp; LaTeX Studio
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

  const editorFileLabel = activeRepoFilePath
    ? `repo:${activeRepoFilePath}`
    : activeDoc?.title || 'main.tex';

  return (
    <div className="studio-shell">
      <header className="studio-topbar">
        <div className="brand-group">
          <strong className="brand-logo">dupe</strong>
          <span className="brand-sub">Academic Paper Studio</span>
        </div>

        <div className="pane-toggles">
          <button
            type="button"
            className={`toggle-btn ${showLibrary ? 'active' : ''}`}
            onClick={() => setShowLibrary((v) => !v)}
          >
            1. Library &amp; Git ({papers.length})
          </button>
          <button
            type="button"
            className={`toggle-btn ${showReader ? 'active' : ''}`}
            onClick={() => setShowReader((v) => !v)}
          >
            2. PDF Reader
          </button>
          <button
            type="button"
            className={`toggle-btn ${showEditor ? 'active' : ''}`}
            onClick={() => setShowEditor((v) => !v)}
          >
            3. LaTeX Studio
          </button>
          <button
            type="button"
            className={`toggle-btn ${showDiagram ? 'active' : ''}`}
            onClick={() => setShowDiagram((v) => !v)}
          >
            4. Diagram Tool
          </button>
        </div>

        <div className="user-group">
          <span className="user-badge">{user.username}</span>
          <button type="button" className="btn-tiny" onClick={handleLogout}>
            Sign Out
          </button>
        </div>
      </header>

      <main className="studio-main">
        <SplitWorkspace
          panes={[
            {
              id: 'library',
              title: 'PDF Library, BibTeX & Overleaf Git Bridge',
              visible: showLibrary,
              defaultWeight: 0.9,
              content: (
                <LibraryPane
                  papers={papers}
                  selectedPaperId={selectedPaper?.id || null}
                  repos={repos}
                  activeRepoId={activeRepoId}
                  repoFiles={repoFiles}
                  onSelectPaper={handleSelectPaper}
                  onInsertCitation={handleInsertCitation}
                  onPapersChanged={loadPapers}
                  onReposChanged={loadRepos}
                  onSelectRepo={setActiveRepoId}
                  onOpenRepoFile={handleOpenRepoFile}
                  onStatusMessage={setStatusMessage}
                />
              ),
            },
            {
              id: 'reader',
              title: selectedPaper ? `PDF: ${selectedPaper.title}` : 'PDF Reader',
              visible: showReader,
              defaultWeight: 1.1,
              content: (
                <PdfReaderPane
                  paper={selectedPaper}
                  onInsertCitation={handleInsertCitation}
                />
              ),
            },
            {
              id: 'editor',
              title: `LaTeX Editor & Live Preview (${editorFileLabel})`,
              visible: showEditor,
              defaultWeight: 1.6,
              content: (
                <LatexEditorPane
                  fileLabel={editorFileLabel}
                  source={latexSource}
                  papers={papers}
                  figures={figuresMap}
                  saving={savingSource}
                  onChangeSource={setLatexSource}
                  onSaveSource={handleSaveSource}
                  registerInsertSnippet={(fn) => {
                    insertSnippetRef.current = fn;
                  }}
                />
              ),
            },
            {
              id: 'diagram',
              title: 'Excalidraw Figure Studio',
              visible: showDiagram,
              defaultWeight: 1.0,
              content: (
                <DiagramPane
                  figureName={figureName}
                  elements={diagramElements}
                  hasActiveRepo={Boolean(activeRepoId)}
                  onChangeFigureName={setFigureName}
                  onChangeElements={handleDiagramChange}
                  onExportFigureToProject={handleExportFigure}
                />
              ),
            },
          ]}
        />
      </main>

      <footer className="studio-statusbar">
        <span>{statusMessage}</span>
        <span>
          {activeRepoId
            ? `Linked Repo Active · ${papers.length} papers in .bib`
            : `${papers.length} papers in library`}
        </span>
      </footer>
    </div>
  );
};
