import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import { DupeApiClient } from './api';
import { loadProjectBibMetadata } from './bibParser';
import { BrainGraphPanel } from './brainGraphPanel';
import { DupeCitationFeatures } from './citationFeatures';
import { formatCitationSnippet, paperFromLocalRefIndex } from './citations';
import {
  HerdrSpaceSummary,
  HerdrSpaceWatcher,
  listHerdrSpaces,
  matchWorkspaceFolderForSpace,
  pickRevealAnchorPath,
} from './herdrFollower';
import {
  NotesAndBacklinksProvider,
  NoteTreeItem,
  PaperLibraryProvider,
  PaperTreeItem,
  ProjectSyncProvider,
} from './libraryTree';
import {
  NotesIndex,
  computeMarkdownEnterEdit,
  formatCommentBlock,
  insertCommentIntoTargetNote,
  normalizeNoteRelPath,
  toggleCheckboxLine,
  toggleWrappedFormat,
} from './notesIndex';
import { DupePdfViewer } from './pdfViewer';
import {
  discoverNestedGitRepoPaths,
  discoverProjectsInWorkspace,
  findDupeProjectRoot,
  readLocalProjectConfig,
  readLocalRefsIndex,
} from './projectLocator';
import { DupeSpellProvider } from './spellProvider';
import {
  BibMetadata,
  LatexDiagnostic,
  LocalStatus,
  LocalUpdateInfo,
  Paper,
  ProjectConfig,
  RemoteSyncStatus,
  UnlinkedMentionHit,
} from './types';

const STARTER_MAIN_TEX = `\\documentclass[conference]{IEEEtran}
\\usepackage[utf8]{inputenc}
\\usepackage{amsmath,amssymb,graphicx}
\\usepackage[hidelinks]{hyperref}

\\title{Untitled Paper}
\\author{Author Name}

\\begin{document}
\\maketitle

\\begin{abstract}
Write your abstract here.
\\end{abstract}

\\section{Introduction}
Start writing your introduction here.

\\bibliographystyle{IEEEtran}
\\bibliography{dupe_references}

\\end{document}
`;

export function activate(context: vscode.ExtensionContext): void {
  const api = new DupeApiClient();
  const pdfViewer = new DupePdfViewer(context.extensionUri);
  const brainGraphPanel = new BrainGraphPanel();
  const notesIndex = new NotesIndex();
  const paperProvider = new PaperLibraryProvider();
  const notesProvider = new NotesAndBacklinksProvider(notesIndex);
  const projectProvider = new ProjectSyncProvider();
  const diagnostics = vscode.languages.createDiagnosticCollection('dupe-latex');

  const syncTexFlashDeco = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
    isWholeLine: true,
  });

  interface VSCodeGitAPI {
    readonly state: 'uninitialized' | 'initialized';
    readonly repositories: Array<{ rootUri: vscode.Uri }>;
    onDidChangeState: vscode.Event<'uninitialized' | 'initialized'>;
    openRepository(root: vscode.Uri): Promise<unknown>;
  }
  interface VSCodeGitExtension {
    readonly enabled: boolean;
    getAPI(version: 1): VSCodeGitAPI;
  }

  let gitStateWatcher: vscode.Disposable | undefined;

  async function syncVSCodeGitRepositories(projectRoot: string | null): Promise<void> {
    if (!projectRoot) {
      return;
    }
    const gitExt = vscode.extensions.getExtension<VSCodeGitExtension>('vscode.git');
    if (!gitExt) {
      return;
    }
    try {
      const exports = gitExt.isActive ? gitExt.exports : await gitExt.activate();
      if (!exports?.enabled) {
        return;
      }
      const gitApi = exports.getAPI(1);
      const openNested = async () => {
        const repoPaths = discoverNestedGitRepoPaths(projectRoot);
        const alreadyOpen = new Set(gitApi.repositories.map((r) => path.resolve(r.rootUri.fsPath)));
        for (const repoPath of repoPaths) {
          if (!alreadyOpen.has(path.resolve(repoPath))) {
            await gitApi.openRepository(vscode.Uri.file(repoPath)).catch(() => null);
          }
        }
      };
      if (gitApi.state === 'initialized') {
        await openNested();
      } else {
        gitStateWatcher?.dispose();
        gitStateWatcher = gitApi.onDidChangeState((st) => {
          if (st === 'initialized') {
            gitStateWatcher?.dispose();
            gitStateWatcher = undefined;
            void openNested();
          }
        });
      }
    } catch {
      // ignore if vscode.git is unavailable or restricted
    }
  }

  let papers: Paper[] = [];
  let projects: ProjectConfig[] = [];
  let activeProject: ProjectConfig | null = null;
  let activeProjectRoot: string | null = null;
  let preferredProjectRootOverride: string | null = null;
  let activeHerdrSpace: HerdrSpaceSummary | null = null;
  let localStatus: LocalStatus | null = null;
  let syncStatus: RemoteSyncStatus | null = null;
  let updateInfo: LocalUpdateInfo | null = null;
  let codeTargets: string[] = [];
  let paperTargets: string[] = [];
  let daemonError: string | null = null;
  let bibMap = new Map<string, BibMetadata>();
  let saveCompileTimer: ReturnType<typeof setTimeout> | undefined;

  const statusSyncItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  const statusCompileItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  const statusLibraryItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
  const statusNoteItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 97);
  const statusHerdrItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 96);

  statusSyncItem.command = 'dupe.syncProject';
  statusCompileItem.command = 'dupe.compileLatex';
  statusLibraryItem.command = 'dupe.searchPapers';
  statusNoteItem.command = 'dupe.quickOpenNote';
  statusHerdrItem.command = 'dupe.toggleHerdrFollow';

  function updateStatusBar(): void {
    if (daemonError) {
      statusSyncItem.text = '$(warning) dupe: Daemon Offline';
      statusSyncItem.tooltip = `${daemonError} — Click to retry`;
      statusSyncItem.command = 'dupe.refresh';
      statusSyncItem.show();
      statusCompileItem.hide();
      statusLibraryItem.hide();
      statusNoteItem.hide();
      return;
    }

    statusSyncItem.command = 'dupe.syncProject';
    if (activeProject) {
      const syncTag = activeProject.overleaf_remote
        ? activeProject.pending_push
          ? 'Sync (queued)'
          : 'Overleaf Sync'
        : 'Git Sync';
      statusSyncItem.text = `$(sync) ${activeProject.name} · ${syncTag}`;
      statusSyncItem.tooltip = 'Commit & sync project files (Overleaf + notes + BibTeX)';
      statusSyncItem.show();

      statusCompileItem.text = '$(play) Compile (Alt+C)';
      statusCompileItem.tooltip = 'Compile project LaTeX with tectonic and open PDF';
      statusCompileItem.show();

      statusNoteItem.text = '$(go-to-file) Notes (Alt+O)';
      statusNoteItem.tooltip = 'Quick Switcher (Alt+O), New Note (Alt+N), Daily Note (Alt+D)';
      statusNoteItem.show();
    } else {
      statusSyncItem.text = '$(folder) dupe: Ready';
      statusSyncItem.tooltip = 'Open a dupe project in a new window';
      statusSyncItem.command = 'dupe.switchProjectWindow';
      statusSyncItem.show();
      statusCompileItem.hide();
      statusNoteItem.hide();
    }

    statusLibraryItem.text = `$(book) ${papers.length} PDFs`;
    statusLibraryItem.tooltip = 'Search dupe Paper Library';
    statusLibraryItem.show();

    const followSpace = vscode.workspace
      .getConfiguration('dupe')
      .get<boolean>('herdr.followSpace', true);
    if (activeHerdrSpace) {
      statusHerdrItem.text = followSpace
        ? `$(layers) ${activeHerdrSpace.name}`
        : `$(layers) ${activeHerdrSpace.name} (paused)`;
      statusHerdrItem.tooltip = followSpace
        ? 'Following active Herdr space in Explorer — Click to pause'
        : 'Herdr space following paused — Click to resume';
      statusHerdrItem.show();
    } else {
      statusHerdrItem.hide();
    }
  }

  function resolveWorkspaceRoots(): string[] {
    return (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
  }

  function getActiveEditorProjectRoot(): string | null {
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    if (activeUri?.scheme === 'file') {
      return findDupeProjectRoot(path.dirname(activeUri.fsPath));
    }
    return null;
  }

  function buildCurrentBrainGraph() {
    const opts = brainGraphPanel.getQueryOptions();
    const activeFsPath = vscode.window.activeTextEditor?.document.uri.fsPath || null;
    return notesIndex.buildBrainGraphPayload(activeProjectRoot, papers, {
      focusPath: activeFsPath,
      depth: opts.localMode ? opts.depth : 0,
      includeAgentBrain: opts.includeAgentBrain,
    });
  }

  function refreshBrainGraphIfOpen(): void {
    if (brainGraphPanel.isOpen()) {
      brainGraphPanel.postGraph(buildCurrentBrainGraph());
    }
  }

  function rebuildLocalIndices(): void {
    bibMap = loadProjectBibMetadata(activeProjectRoot, papers);
    notesIndex.rebuild(activeProjectRoot);
    const activeFsPath = vscode.window.activeTextEditor?.document.uri.fsPath || null;
    notesProvider.refresh(activeFsPath);
    refreshBrainGraphIfOpen();
  }

  function getSerializableBibMap(): Record<string, BibMetadata> {
    const out: Record<string, BibMetadata> = {};
    for (const [k, v] of bibMap.entries()) {
      out[k] = v;
    }
    return out;
  }

  function loadFallbackLocalRefs(): void {
    const editorRoot = getActiveEditorProjectRoot();
    if (editorRoot) {
      const cfg = readLocalProjectConfig(editorRoot);
      if (cfg) {
        activeProject = cfg;
        activeProjectRoot = editorRoot;
      }
    } else {
      const discovered = discoverProjectsInWorkspace(resolveWorkspaceRoots());
      if (discovered.length > 0) {
        activeProject = discovered[0].config;
        activeProjectRoot = discovered[0].rootDir;
      }
    }
    if (activeProjectRoot) {
      const refs = readLocalRefsIndex(activeProjectRoot);
      if (refs.length > 0 && papers.length === 0) {
        papers = refs.map(paperFromLocalRefIndex);
      }
    }
  }

  async function refreshAll(): Promise<void> {
    try {
      const wsRoots = resolveWorkspaceRoots();
      const editorRoot = getActiveEditorProjectRoot();
      const discovered = discoverProjectsInWorkspace(wsRoots);
      const preferredRoot =
        preferredProjectRootOverride &&
        wsRoots.some((ws) => path.resolve(ws) === path.resolve(preferredProjectRootOverride!))
          ? preferredProjectRootOverride
          : editorRoot;
      const preferredDiscovered = preferredRoot
        ? discovered.find((d) => path.resolve(d.rootDir) === path.resolve(preferredRoot)) || {
            rootDir: preferredRoot,
            config: readLocalProjectConfig(preferredRoot),
          }
        : discovered.find((d) => d.config.folder_name !== 'default-paper-project') || discovered[0];

      localStatus = await api.getLocalStatus().catch(() => null);
      if (
        preferredDiscovered?.rootDir &&
        localStatus?.projects_dir &&
        path.dirname(preferredDiscovered.rootDir) !== path.resolve(localStatus.projects_dir)
      ) {
        localStatus = await api.setLocalProjectsRoot(path.dirname(preferredDiscovered.rootDir));
      }

      const [loadedPapers, loadedProjects, remoteSync] = await Promise.all([
        api.listPapers(),
        api.listProjects(),
        api.getRemoteSyncStatus().catch(() => null),
      ]);

      papers = loadedPapers;
      projects = loadedProjects;
      syncStatus = remoteSync;
      daemonError = null;

      activeProject = null;
      activeProjectRoot = null;
      codeTargets = [];
      paperTargets = [];

      if (preferredDiscovered?.config) {
        const cfg = preferredDiscovered.config;
        const match =
          projects.find((p) => p.id === cfg.id) ||
          projects.find((p) => p.folder_name === cfg.folder_name) ||
          null;
        if (match) {
          activeProject = match;
          activeProjectRoot = preferredDiscovered.rootDir;
        }
      }

      if (!activeProject && wsRoots.length > 0) {
        for (const proj of projects) {
          try {
            const tree = await api.getProjectTree(proj.id);
            const rawTargets = tree.code_targets?.length
              ? tree.code_targets.map((t) => (t.includes(' -> ') ? t.split(' -> ').pop()! : t))
              : tree.code_target
                ? [tree.code_target]
                : [];
            if (rawTargets.some((t) => wsRoots.some((ws) => path.resolve(ws) === path.resolve(t)))) {
              activeProject = proj;
              activeProjectRoot = localStatus?.projects_dir
                ? path.join(localStatus.projects_dir, proj.folder_name)
                : null;
              codeTargets = tree.code_targets || (tree.code_target ? [tree.code_target] : []);
              paperTargets = tree.paper_targets || [];
              break;
            }
          } catch {
            // ignore tree lookup errors
          }
        }
      }

      if (!activeProject && projects.length > 0) {
        const nonDefault = projects.find((p) => p.folder_name !== 'default-paper-project') || projects[0];
        activeProject = nonDefault;
        if (localStatus?.projects_dir) {
          activeProjectRoot = path.join(localStatus.projects_dir, nonDefault.folder_name);
        }
      }

      if (activeProject && codeTargets.length === 0) {
        try {
          const tree = await api.getProjectTree(activeProject.id);
          codeTargets = tree.code_targets || (tree.code_target ? [tree.code_target] : []);
          paperTargets = tree.paper_targets || [];
        } catch {
          codeTargets = [];
          paperTargets = [];
        }
      }
    } catch (err) {
      daemonError = err instanceof Error ? err.message : String(err);
      loadFallbackLocalRefs();
    }

    rebuildLocalIndices();
    paperProvider.update(papers, activeProject, daemonError);
    projectProvider.update({
      activeProject,
      localStatus,
      syncStatus,
      codeTargets,
      paperTargets,
      daemonError,
      updateInfo,
    });
    updateStatusBar();
    void syncVSCodeGitRepositories(activeProjectRoot);
  }

  async function waitForDaemonHealth(timeoutMs = 10000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      try {
        await api.health();
        return true;
      } catch {
        // daemon still restarting
      }
    }
    return false;
  }

  function isNewerVersion(currentRaw: string, latestRaw: string): boolean {
    const parse = (raw: string): number[] | null => {
      const clean = raw.trim().replace(/^v/i, '').split(/[-+]/)[0];
      if (!clean || clean.toLowerCase() === 'dev') {
        return null;
      }
      const nums = clean.split('.').map((n) => Number.parseInt(n, 10));
      if (nums.length < 2 || nums.length > 3 || nums.some((n) => Number.isNaN(n))) {
        return null;
      }
      return [nums[0] || 0, nums[1] || 0, nums[2] || 0];
    };
    const l = parse(latestRaw);
    if (!l) {
      return false;
    }
    const c = parse(currentRaw);
    if (!c) {
      return true;
    }
    for (let i = 0; i < 3; i++) {
      if (c[i] < l[i]) return true;
      if (c[i] > l[i]) return false;
    }
    return false;
  }

  async function checkUpdatesFromGitHubFallback(): Promise<LocalUpdateInfo | null> {
    const extVer = String((context.extension.packageJSON as { version?: string })?.version || '0.0.0');
    const res = await fetch('https://api.github.com/repos/Dinoclaro/dupe/releases/latest', {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `dupe-studio/${extVer}` },
    });
    if (!res.ok) {
      return null;
    }
    const rel = (await res.json()) as { tag_name?: string; html_url?: string; body?: string };
    const latest = String(rel.tag_name || '').trim();
    if (!latest) {
      return null;
    }
    return {
      current_version: `v${extVer.replace(/^v/i, '')}`,
      latest_version: latest,
      update_available: isNewerVersion(extVer, latest),
      release_url: rel.html_url || 'https://github.com/Dinoclaro/dupe/releases',
      release_notes: rel.body || '',
    };
  }

  async function runUpdateCheck(interactive: boolean): Promise<void> {
    let info: LocalUpdateInfo | null = null;
    try {
      info = await api.checkUpdates(interactive);
    } catch {
      try {
        info = await checkUpdatesFromGitHubFallback();
      } catch (err) {
        if (interactive) {
          void vscode.window.showWarningMessage(
            `Could not check for dupe updates: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        return;
      }
    }
    if (!info) {
      if (interactive) {
        void vscode.window.showInformationMessage('No published dupe release found yet.');
      }
      return;
    }

    updateInfo = info;
    projectProvider.update({
      activeProject,
      localStatus,
      syncStatus,
      codeTargets,
      paperTargets,
      daemonError,
      updateInfo,
    });

    if (!info.update_available) {
      if (interactive) {
        void vscode.window.showInformationMessage(
          `dupe is up to date (${info.current_version}).`,
        );
      }
      return;
    }

    const skippedVer = context.globalState.get<string>('dupe.skippedUpdateVersion', '');
    if (!interactive && skippedVer === info.latest_version) {
      return;
    }

    const choice = await vscode.window.showInformationMessage(
      `dupe ${info.latest_version} is available (installed: ${info.current_version}).`,
      'Update Now',
      'Release Notes',
      'Skip Version',
    );
    if (choice === 'Release Notes' && info.release_url) {
      await vscode.env.openExternal(vscode.Uri.parse(info.release_url));
      return;
    }
    if (choice === 'Skip Version') {
      await context.globalState.update('dupe.skippedUpdateVersion', info.latest_version);
      return;
    }
    if (choice !== 'Update Now') {
      return;
    }

    try {
      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Updating dupe to ${info.latest_version}...`,
          cancellable: false,
        },
        async () => {
          const applied = await api.applyUpdate(info!.latest_version);
          if (applied.restarting) {
            await waitForDaemonHealth(10000);
          }
          return applied;
        },
      );
      await refreshAll();
      if (result.extension_updated) {
        const reload = await vscode.window.showInformationMessage(
          `${result.message} Reload VS Code to activate the new dupe-studio extension.`,
          'Reload Window',
        );
        if (reload === 'Reload Window') {
          await vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
      } else {
        void vscode.window.showInformationMessage(result.message);
      }
    } catch (err) {
      void vscode.window.showErrorMessage(
        `dupe update failed: ${err instanceof Error ? err.message : String(err)}. You can also run "dupe update" in a terminal.`,
      );
    }
  }

  async function applyHerdrSpaceFocus(space: HerdrSpaceSummary, forceEvenIfPaused = false): Promise<void> {
    activeHerdrSpace = space;
    const followSpace = vscode.workspace
      .getConfiguration('dupe')
      .get<boolean>('herdr.followSpace', true);
    if (!followSpace && !forceEvenIfPaused) {
      updateStatusBar();
      return;
    }

    const wsFolders = (vscode.workspace.workspaceFolders || []).map((f) => ({
      name: f.name,
      fsPath: f.uri.fsPath,
    }));
    const matched = matchWorkspaceFolderForSpace(space, wsFolders);
    if (matched) {
      const matchedProjectRoot = findDupeProjectRoot(matched.fsPath) || matched.fsPath;
      preferredProjectRootOverride = matchedProjectRoot;

      if (wsFolders.length > 1) {
        const wasFocused = vscode.window.state.focused;
        const hadEditor = Boolean(vscode.window.activeTextEditor);
        await vscode.commands.executeCommand('workbench.files.action.collapseExplorerFolders');
        const anchorPath = pickRevealAnchorPath(matched.fsPath);
        await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(anchorPath));
        if (wasFocused && hadEditor) {
          await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
        }
      }
      await refreshAll();
    } else {
      updateStatusBar();
    }
  }

  const herdrWatcher = new HerdrSpaceWatcher(async (space) => {
    await applyHerdrSpaceFocus(space, false);
  });

  function applyCompilerDiagnostics(
    projectRoot: string | null,
    errors: LatexDiagnostic[],
    warnings: LatexDiagnostic[],
  ): void {
    diagnostics.clear();
    if (!projectRoot) {
      return;
    }
    const grouped = new Map<string, vscode.Diagnostic[]>();
    const addDiag = (item: LatexDiagnostic, severity: vscode.DiagnosticSeverity) => {
      const cleanRel = (item.file || 'main.tex').replace(/^\.\//, '');
      const absPath = path.join(projectRoot, 'paper', cleanRel);
      const lineIdx = Math.max(0, (item.line || 1) - 1);
      const range = new vscode.Range(lineIdx, 0, lineIdx, 200);
      const diag = new vscode.Diagnostic(range, item.message, severity);
      diag.source = 'dupe (tectonic)';
      const list = grouped.get(absPath) || [];
      list.push(diag);
      grouped.set(absPath, list);
    };

    for (const e of errors || []) {
      addDiag(e, vscode.DiagnosticSeverity.Error);
    }
    for (const w of warnings || []) {
      addDiag(w, vscode.DiagnosticSeverity.Warning);
    }

    for (const [filePath, list] of grouped.entries()) {
      diagnostics.set(vscode.Uri.file(filePath), list);
    }
  }

  async function pickProjectOrWarn(): Promise<ProjectConfig | null> {
    if (activeProject) {
      return activeProject;
    }
    if (projects.length === 0) {
      void vscode.window.showWarningMessage('No dupe project found. Create or open a project first.');
      return null;
    }
    const picked = await vscode.window.showQuickPick(
      projects.map((p) => ({ label: p.name, description: `${p.folder_name}/`, project: p })),
      { placeHolder: 'Select target dupe project' },
    );
    return picked?.project || null;
  }

  async function resolveProjectRoot(proj: ProjectConfig): Promise<string | null> {
    if (activeProject?.id === proj.id && activeProjectRoot) {
      return activeProjectRoot;
    }
    if (localStatus?.projects_dir) {
      return path.join(localStatus.projects_dir, proj.folder_name);
    }
    return null;
  }

  async function openNoteByRelPath(relPath: string, initialContent?: string): Promise<void> {
    const proj = await pickProjectOrWarn();
    if (!proj) {
      return;
    }
    const projRoot = await resolveProjectRoot(proj);
    if (!projRoot) {
      return;
    }
    const absNote = path.join(projRoot, relPath);
    await fsp.mkdir(path.dirname(absNote), { recursive: true });
    let created = false;
    try {
      await fsp.access(absNote);
    } catch {
      created = true;
      const heading = path.basename(absNote, '.md');
      await fsp.writeFile(absNote, initialContent ?? `# ${heading}\n\n`, 'utf8');
    }
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(absNote));
    const editor = await vscode.window.showTextDocument(doc);
    if (created) {
      const lastLine = Math.max(0, doc.lineCount - 1);
      const pos = new vscode.Position(lastLine, doc.lineAt(lastLine).text.length);
      editor.selection = new vscode.Selection(pos, pos);
      rebuildLocalIndices();
    }
  }

  async function handleSyncTexReverseForProject(
    proj: ProjectConfig,
    projRoot: string | null,
    params: { page: number; xRatio: number; yRatio: number; widthPt: number; heightPt: number },
  ): Promise<void> {
    if (!projRoot) {
      return;
    }
    try {
      const res = await api.syncTexBackward(proj.id, {
        page: params.page,
        x: params.xRatio,
        y: params.yRatio,
        w: params.widthPt,
        h: params.heightPt,
      });
      const absTex = path.join(projRoot, res.path);
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(absTex));
      const editor = await vscode.window.showTextDocument(doc, {
        viewColumn: vscode.ViewColumn.One,
        preserveFocus: false,
      });
      const lineIdx = Math.max(0, Math.min(doc.lineCount - 1, (res.line || 1) - 1));
      const range = new vscode.Range(lineIdx, 0, lineIdx, doc.lineAt(lineIdx).text.length);
      editor.selection = new vscode.Selection(range.start, range.start);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
      editor.setDecorations(syncTexFlashDeco, [range]);
      setTimeout(() => editor.setDecorations(syncTexFlashDeco, []), 1600);
    } catch (err) {
      void vscode.window.showWarningMessage(
        `SyncTeX jump failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async function appendQuoteToDailyNote(quote: string, bibtexKey?: string): Promise<void> {
    const today = new Date().toISOString().slice(0, 10);
    const relPath = `notes/daily/${today}.md`;
    const proj = await pickProjectOrWarn();
    if (!proj) {
      return;
    }
    const projRoot = await resolveProjectRoot(proj);
    if (!projRoot) {
      return;
    }
    const absNote = path.join(projRoot, relPath);
    await fsp.mkdir(path.dirname(absNote), { recursive: true });
    let existing = '';
    try {
      existing = await fsp.readFile(absNote, 'utf8');
    } catch {
      existing = `# ${today}\n\n`;
    }
    const citeSuffix = bibtexKey ? ` — [[paper:${bibtexKey}]]` : '';
    const block = `${existing.endsWith('\n') ? '' : '\n'}> "${quote}"${citeSuffix}\n\n`;
    await fsp.writeFile(absNote, existing + block, 'utf8');
    rebuildLocalIndices();
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(absNote));
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One });
  }

  async function openPaper(paper: Paper): Promise<void> {
    await pdfViewer.openPdf({
      key: `paper:${paper.id}`,
      title: `${paper.bibtex_key || paper.title}.pdf`,
      loader: () => api.getPaperPdfBytes(paper.id),
      getBibMap: getSerializableBibMap,
      paperBibtexKey: paper.bibtex_key,
      callbacks: {
        onOpenPaperByKey: async (k) => {
          await vscode.commands.executeCommand('dupe.openPaperByKey', k);
        },
        onQuoteToNote: appendQuoteToDailyNote,
      },
      viewColumn: vscode.ViewColumn.Beside,
    });
  }

  async function openCompiledPdfForProject(proj: ProjectConfig, preserveFocus = false): Promise<void> {
    const projRoot = await resolveProjectRoot(proj);
    await pdfViewer.openPdf({
      key: `compiled:${proj.id}`,
      title: `${proj.name}.pdf`,
      loader: () => api.getCompiledPdfBytes(proj.id),
      getBibMap: getSerializableBibMap,
      callbacks: {
        onSyncTexReverse: (coords) => handleSyncTexReverseForProject(proj, projRoot, coords),
        onOpenPaperByKey: async (k) => {
          await vscode.commands.executeCommand('dupe.openPaperByKey', k);
        },
        onQuoteToNote: appendQuoteToDailyNote,
      },
      viewColumn: vscode.ViewColumn.Beside,
      preserveFocus,
    });
  }

  async function runLatexCompile(proj: ProjectConfig, silentMissingTex = false): Promise<void> {
    const projRoot = await resolveProjectRoot(proj);
    if (projRoot) {
      const paperDir = path.join(projRoot, 'paper');
      let hasAnyTex = false;
      try {
        for (const entry of fs.readdirSync(paperDir, { withFileTypes: true })) {
          if (entry.isFile() && entry.name.toLowerCase().endsWith('.tex')) {
            hasAnyTex = true;
            break;
          }
          if ((entry.isDirectory() || entry.isSymbolicLink()) && !entry.name.startsWith('.')) {
            try {
              if (fs.readdirSync(path.join(paperDir, entry.name)).some((f) => f.toLowerCase().endsWith('.tex'))) {
                hasAnyTex = true;
                break;
              }
            } catch {
              // ignore unreadable subdir
            }
          }
        }
      } catch {
        hasAnyTex = false;
      }
      if (!hasAnyTex) {
        if (silentMissingTex) {
          return;
        }
        const pick = await vscode.window.showWarningMessage(
          `Project "${proj.name}" has no .tex file in paper/.`,
          'Create paper/main.tex',
          'Cancel',
        );
        if (pick === 'Create paper/main.tex') {
          await fsp.mkdir(paperDir, { recursive: true });
          const absMain = path.join(paperDir, 'main.tex');
          await fsp.writeFile(absMain, STARTER_MAIN_TEX, 'utf8');
          const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(absMain));
          await vscode.window.showTextDocument(doc);
          await runLatexCompile(proj, false);
        }
        return;
      }
    }

    const activeDocPath = vscode.window.activeTextEditor?.document.uri.fsPath;
    let targetRel = '';
    if (projRoot && activeDocPath) {
      const rel = path.relative(path.join(projRoot, 'paper'), activeDocPath);
      if (!rel.startsWith('..') && rel.endsWith('.tex')) {
        targetRel = rel.replace(/\\/g, '/');
      }
    }

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Compiling ${proj.name} LaTeX...` },
      async () => {
        try {
          const res = await api.compileProject(proj.id, targetRel);
          applyCompilerDiagnostics(projRoot, res.errors || [], res.warnings || []);

          const openOnCompile = vscode.workspace
            .getConfiguration('dupe')
            .get<boolean>('openPdfOnCompile', true);
          if (res.pdf_available && openOnCompile) {
            await openCompiledPdfForProject(proj, true);
          }

          if (res.success) {
            void vscode.window.setStatusBarMessage(
              `$(check) Compiled ${res.root_tex} (${(res.duration_ms / 1000).toFixed(1)}s)`,
              4000,
            );
          } else {
            const errs = res.errors || [];
            const firstMsg = errs[0]?.message;
            const summary =
              res.failure_kind === 'compiler' && firstMsg
                ? `LaTeX compiler error: ${firstMsg}`
                : firstMsg
                  ? `LaTeX compile finished with ${errs.length} error(s) (${res.failure_kind}): ${firstMsg}`
                  : `LaTeX compile finished with ${errs.length} error(s) (${res.failure_kind}). Check Problems panel.`;
            void vscode.window.showWarningMessage(summary);
          }
        } catch (err) {
          void vscode.window.showErrorMessage(
            `Compile failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
    );
  }

  const citationProvider = new DupeCitationFeatures(() => bibMap, notesIndex);
  const spellProvider = new DupeSpellProvider(context.extensionUri, () => activeProjectRoot);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('dupe.notesView', notesProvider),
    vscode.window.registerTreeDataProvider('dupe.papersView', paperProvider),
    vscode.window.registerTreeDataProvider('dupe.projectView', projectProvider),
    vscode.languages.registerCompletionItemProvider(
      [{ language: 'latex' }, { language: 'markdown' }, { language: 'tex' }],
      citationProvider,
      '{',
      ',',
      '[',
      ':',
      '#',
    ),
    vscode.languages.registerHoverProvider(
      [{ language: 'latex' }, { language: 'markdown' }, { language: 'tex' }],
      citationProvider,
    ),
    vscode.languages.registerDocumentLinkProvider(
      [{ language: 'latex' }, { language: 'markdown' }, { language: 'tex' }],
      citationProvider,
    ),
    vscode.languages.registerDefinitionProvider({ language: 'markdown' }, citationProvider),
    vscode.languages.registerCodeActionsProvider(
      [{ language: 'latex' }, { language: 'markdown' }, { language: 'tex' }],
      spellProvider,
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
    ),
    spellProvider,
    diagnostics,
    syncTexFlashDeco,
    { dispose: () => gitStateWatcher?.dispose() },
    statusSyncItem,
    statusCompileItem,
    statusLibraryItem,
    statusNoteItem,
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dupe.refresh', () => refreshAll()),

    // Obsidian-style Quick Switcher (Alt+O)
    vscode.commands.registerCommand('dupe.quickOpenNote', async () => {
      const proj = await pickProjectOrWarn();
      if (!proj) {
        return;
      }
      const projRoot = await resolveProjectRoot(proj);
      if (!projRoot) {
        return;
      }
      notesIndex.rebuild(projRoot);

      const qp = vscode.window.createQuickPick<
        vscode.QuickPickItem & { absPath?: string; createNote?: boolean }
      >();
      qp.placeholder = 'Jump to note or paper/*.tex — or type a name to create a new note';
      qp.matchOnDescription = true;

      const buildStaticItems = () => {
        const items: Array<vscode.QuickPickItem & { absPath?: string; createNote?: boolean }> = [];
        for (const n of notesIndex.getNotes()) {
          items.push({
            label: `$(note) ${n.slug}`,
            description: n.tags.map((t) => `#${t}`).join(' '),
            detail: n.relPath,
            absPath: n.absPath,
          });
        }
        const paperDir = path.join(projRoot, 'paper');
        try {
          for (const f of fs.readdirSync(paperDir)) {
            if (f.endsWith('.tex')) {
              items.push({
                label: `$(file-code) paper/${f}`,
                detail: `paper/${f}`,
                absPath: path.join(paperDir, f),
              });
            }
          }
        } catch {
          // ignore missing paper dir
        }
        return items;
      };

      const baseItems = buildStaticItems();
      qp.items = baseItems;
      qp.onDidChangeValue((val) => {
        const trimmed = val.trim();
        if (!trimmed) {
          qp.items = baseItems;
          return;
        }
        const exists = baseItems.some((it) => it.label.toLowerCase().includes(trimmed.toLowerCase()));
        if (exists) {
          qp.items = baseItems;
        } else {
          qp.items = [
            ...baseItems,
            {
              label: `$(add) Create note: ${normalizeNoteRelPath(trimmed)}`,
              alwaysShow: true,
              createNote: true,
            },
          ];
        }
      });

      qp.onDidAccept(async () => {
        const sel = qp.selectedItems[0];
        const typed = qp.value.trim();
        qp.hide();
        if (sel?.absPath) {
          await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(sel.absPath));
        } else if (typed) {
          await openNoteByRelPath(normalizeNoteRelPath(typed));
        }
      });
      qp.onDidHide(() => qp.dispose());
      qp.show();
    }),

    vscode.commands.registerCommand('dupe.openLatestArtifact', async () => {
      const proj = await pickProjectOrWarn();
      if (!proj) {
        return;
      }
      const projRoot = await resolveProjectRoot(proj);
      if (!projRoot) {
        return;
      }
      notesIndex.rebuild(projRoot);
      const artifacts = notesIndex.getArtifacts();
      if (artifacts.length === 0) {
        void vscode.window.showInformationMessage(
          'No agent artifacts in notes/artifacts/ yet.',
        );
        return;
      }
      const picked = await vscode.window.showQuickPick(
        artifacts.map((a, idx) => ({
          label: `$(sparkle) ${a.title}`,
          description: idx === 0 ? 'latest' : a.tags.map((t) => `#${t}`).join(' '),
          detail: a.relPath,
          absPath: a.absPath,
        })),
        { placeHolder: 'Select an agent artifact to preview' },
      );
      if (!picked) {
        return;
      }
      await vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(picked.absPath));
    }),

    // Daily Note (Alt+D)
    vscode.commands.registerCommand('dupe.dailyNote', async () => {
      const today = new Date().toISOString().slice(0, 10);
      await openNoteByRelPath(`notes/daily/${today}.md`, `# ${today}\n\n- [ ] `);
    }),

    // New Note (Alt+N)
    vscode.commands.registerCommand('dupe.newNote', async () => {
      const rawName = await vscode.window.showInputBox({
        prompt: 'New note name (supports subfolders like experiments/ablation)',
        placeHolder: 'e.g. experiment-ideas',
      });
      if (!rawName?.trim()) {
        return;
      }
      await openNoteByRelPath(normalizeNoteRelPath(rawName));
    }),

    vscode.commands.registerCommand('dupe.renameNote', async (item?: NoteTreeItem) => {
      if (!item?.note || !activeProjectRoot) {
        return;
      }
      const nextRaw = await vscode.window.showInputBox({
        prompt: 'New note name or relative path',
        value: item.note.slug,
      });
      if (!nextRaw?.trim()) {
        return;
      }
      const nextRel = normalizeNoteRelPath(nextRaw);
      const nextAbs = path.join(activeProjectRoot, nextRel);
      await fsp.mkdir(path.dirname(nextAbs), { recursive: true });
      await fsp.rename(item.note.absPath, nextAbs);
      rebuildLocalIndices();
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(nextAbs));
    }),

    vscode.commands.registerCommand('dupe.deleteNote', async (item?: NoteTreeItem) => {
      if (!item?.note) {
        return;
      }
      const confirm = await vscode.window.showWarningMessage(
        `Delete ${item.note.relPath}?`,
        { modal: true },
        'Delete',
      );
      if (confirm !== 'Delete') {
        return;
      }
      await fsp.unlink(item.note.absPath);
      rebuildLocalIndices();
    }),

    vscode.commands.registerCommand('dupe.openOrCreateWikiLink', async (target?: string) => {
      if (!target) {
        return;
      }

      const existing = notesIndex.resolveNoteTarget(target);
      if (existing) {
        await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(existing.absPath));
        return;
      }
      await openNoteByRelPath(normalizeNoteRelPath(target));
    }),

    // Obsidian List & Numbering Auto-Continuation on Enter
    vscode.commands.registerCommand('dupe.markdownEnter', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'markdown' || editor.selections.length !== 1) {
        await vscode.commands.executeCommand('default:type', { text: '\n' });
        return;
      }
      const sel = editor.selections[0];
      if (!sel.isEmpty) {
        await vscode.commands.executeCommand('default:type', { text: '\n' });
        return;
      }
      const line = editor.document.lineAt(sel.active.line);
      const editAction = computeMarkdownEnterEdit(line.text, sel.active.character);
      if (editAction.action === 'default') {
        await vscode.commands.executeCommand('default:type', { text: '\n' });
        return;
      }
      await editor.edit((eb) => {
        if (editAction.action === 'clearPrefix') {
          eb.replace(line.range, '');
        } else {
          eb.insert(sel.active, editAction.text);
        }
      });
    }),

    // Obsidian Checkbox Toggle (Ctrl+Enter in Markdown)
    vscode.commands.registerCommand('dupe.toggleCheckbox', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'markdown') {
        return;
      }
      await editor.edit((eb) => {
        const seenLines = new Set<number>();
        for (const sel of editor.selections) {
          for (let l = sel.start.line; l <= sel.end.line; l++) {
            if (seenLines.has(l)) {
              continue;
            }
            seenLines.add(l);
            const line = editor.document.lineAt(l);
            eb.replace(line.range, toggleCheckboxLine(line.text));
          }
        }
      });
    }),

    // Quick Link / Citation (Alt+L)
    vscode.commands.registerCommand('dupe.quickInsertLink', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return;
      }
      const isMd = editor.document.languageId === 'markdown';
      const items: Array<vscode.QuickPickItem & { insertText: string }> = [];

      if (isMd) {
        for (const n of notesIndex.getNotes()) {
          items.push({
            label: `$(note) [[${n.slug}]]`,
            description: n.relPath,
            insertText: `[[${n.slug}]]`,
          });
        }
      }
      for (const m of bibMap.values()) {
        items.push({
          label: `$(book) ${m.key}`,
          description: m.title,
          detail: `${m.authors}${m.year ? ` (${m.year})` : ''}`,
          insertText: isMd ? `[[paper:${m.key}]]` : `\\cite{${m.key}}`,
        });
      }

      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: isMd ? 'Insert [[note]] or [[paper:key]]' : 'Insert \\cite{key}',
        matchOnDescription: true,
        matchOnDetail: true,
      });
      if (!picked) {
        return;
      }
      await editor.edit((eb) => {
        for (const sel of editor.selections) {
          eb.replace(sel, picked.insertText);
        }
      });
    }),

    vscode.commands.registerCommand('dupe.formatBold', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return;
      }
      const isMd = editor.document.languageId === 'markdown';
      const prefix = isMd ? '**' : '\\textbf{';
      const suffix = isMd ? '**' : '}';
      await editor.edit((eb) => {
        for (const sel of editor.selections) {
          const text = editor.document.getText(sel);
          eb.replace(sel, toggleWrappedFormat(text, prefix, suffix));
        }
      });
    }),

    vscode.commands.registerCommand('dupe.formatItalic', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return;
      }
      const isMd = editor.document.languageId === 'markdown';
      const prefix = isMd ? '*' : '\\textit{';
      const suffix = isMd ? '*' : '}';
      await editor.edit((eb) => {
        for (const sel of editor.selections) {
          const text = editor.document.getText(sel);
          eb.replace(sel, toggleWrappedFormat(text, prefix, suffix));
        }
      });
    }),

    vscode.commands.registerCommand('dupe.searchByTag', async () => {
      if (activeProjectRoot) {
        notesIndex.rebuild(activeProjectRoot);
      }
      const tagsMap = notesIndex.getTagsMap();
      if (tagsMap.size === 0) {
        void vscode.window.showInformationMessage('No #tags found in notes/ yet.');
        return;
      }
      const tagPick = await vscode.window.showQuickPick(
        Array.from(tagsMap.entries()).map(([tag, list]) => ({
          label: `#${tag}`,
          description: `${list.length} note(s)`,
          notes: list,
        })),
        { placeHolder: 'Select #tag to filter notes' },
      );
      if (!tagPick) {
        return;
      }
      const notePick = await vscode.window.showQuickPick(
        tagPick.notes.map((n) => ({ label: n.slug, description: n.relPath, absPath: n.absPath })),
        { placeHolder: `Notes tagged #${tagPick.label.slice(1)}` },
      );
      if (notePick) {
        await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(notePick.absPath));
      }
    }),

    vscode.commands.registerCommand('dupe.searchPapers', async () => {
      if (papers.length === 0) {
        await refreshAll();
      }
      const picked = await vscode.window.showQuickPick(
        papers.map((p) => ({
          label: `$(book) ${p.bibtex_key || p.title}`,
          description: p.title,
          detail: `${p.authors || 'Unknown'}${p.publication_year ? ` (${p.publication_year})` : ''}`,
          paper: p,
        })),
        {
          placeHolder: 'Search library papers (select to open PDF or insert citation)',
          matchOnDescription: true,
          matchOnDetail: true,
        },
      );
      if (!picked) {
        return;
      }
      const action = await vscode.window.showQuickPick(
        [
          { label: 'Open PDF', value: 'open' },
          { label: 'Insert Citation at Cursor', value: 'cite' },
          { label: 'Filter Sidebar by This Key', value: 'filter' },
          { label: 'Copy BibTeX', value: 'bibtex' },
        ],
        { placeHolder: picked.paper.title },
      );
      if (!action) {
        return;
      }
      if (action.value === 'open') {
        await openPaper(picked.paper);
      } else if (action.value === 'cite') {
        await vscode.commands.executeCommand('dupe.insertCitation', picked.paper);
      } else if (action.value === 'filter') {
        paperProvider.setFilter(picked.paper.bibtex_key || picked.paper.title);
      } else if (action.value === 'bibtex') {
        await vscode.commands.executeCommand('dupe.copyBibtex', picked.paper);
      }
    }),

    vscode.commands.registerCommand('dupe.clearPaperFilter', () => {
      paperProvider.setFilter('');
    }),

    vscode.commands.registerCommand('dupe.addPaper', async () => {
      const pick = await vscode.window.showQuickPick(
        [
          {
            label: '$(link) Import from Web URL / arXiv / DOI',
            description: 'Paste an article page, arXiv link, DOI, or direct PDF URL',
            action: 'url',
          },
          {
            label: '$(file-pdf) Upload PDF File(s) from Computer',
            description: 'Select PDFs from anywhere (e.g. ~/Downloads) — dupe stores & syncs them automatically',
            action: 'file',
          },
        ],
        { placeHolder: 'How would you like to add a paper to dupe?' },
      );
      if (!pick) {
        return;
      }
      if (pick.action === 'url') {
        await vscode.commands.executeCommand('dupe.importPaperUrl');
      } else {
        await vscode.commands.executeCommand('dupe.uploadPdf');
      }
    }),

    vscode.commands.registerCommand('dupe.importPaperUrl', async () => {
      const rawUrl = await vscode.window.showInputBox({
        prompt: 'Paste paper URL, arXiv ID (e.g. 2401.12345), DOI, or PDF link',
        placeHolder: 'https://arxiv.org/abs/2401.12345',
      });
      if (!rawUrl?.trim()) {
        return;
      }
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Fetching PDF & extracting BibTeX...' },
        async () => {
          try {
            const paper = await api.importPaperFromUrl(rawUrl.trim());
            await refreshAll();
            if (activeProject) {
              await api.gatherProjectContext(activeProject.id).catch(() => {});
              rebuildLocalIndices();
            }
            void vscode.window.showInformationMessage(
              `Imported "${paper.title}" (${paper.bibtex_key}) into library.`,
            );
          } catch (err) {
            void vscode.window.showErrorMessage(
              `Import failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        },
      );
    }),

    vscode.commands.registerCommand('dupe.uploadPdf', async () => {
      const uris = await vscode.window.showOpenDialog({
        canSelectMany: true,
        filters: { PDFs: ['pdf'] },
        openLabel: 'Upload to dupe Library',
      });
      if (!uris || uris.length === 0) {
        return;
      }
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Uploading PDF(s) & extracting BibTeX...' },
        async () => {
          const uploaded = await api.uploadPdfs(uris.map((u) => u.fsPath));
          await refreshAll();
          void vscode.window.showInformationMessage(`Added ${uploaded.length} paper(s) to dupe library.`);
        },
      );
    }),

    vscode.commands.registerCommand('dupe.syncLibrary', async () => {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Syncing dupe library with hosted server...' },
        async () => {
          try {
            const res = await api.triggerRemoteSync();
            await refreshAll();
            void vscode.window.showInformationMessage(
              `Library synced (${res.pulled_papers} pulled, ${res.pushed_papers} pushed).`,
            );
          } catch (err) {
            void vscode.window.showErrorMessage(
              `Library sync failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        },
      );
    }),

    vscode.commands.registerCommand('dupe.openPaperPdf', async (arg?: Paper | PaperTreeItem) => {
      const paper = arg instanceof PaperTreeItem ? arg.paper : arg;
      if (!paper) {
        await vscode.commands.executeCommand('dupe.searchPapers');
        return;
      }
      await openPaper(paper);
    }),

    vscode.commands.registerCommand('dupe.openPaperByKey', async (bibtexKey?: string) => {
      if (!bibtexKey) {
        return;
      }
      if (papers.length === 0) {
        await refreshAll();
      }
      const paper = papers.find((p) => p.bibtex_key === bibtexKey);
      if (!paper) {
        const bibEntry = bibMap.get(bibtexKey);
        if (bibEntry) {
          void vscode.window.showInformationMessage(
            `"${bibEntry.title}" (${bibtexKey}) is in project .bib, not uploaded to your PDF library yet.`,
          );
        } else {
          void vscode.window.showWarningMessage(`Paper "${bibtexKey}" not found in library.`);
        }
        return;
      }
      await openPaper(paper);
    }),

    vscode.commands.registerCommand('dupe.insertCitation', async (arg?: Paper | PaperTreeItem) => {
      const paper = arg instanceof PaperTreeItem ? arg.paper : arg;
      if (!paper) {
        return;
      }
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        await vscode.env.clipboard.writeText(paper.bibtex_key);
        void vscode.window.showInformationMessage(`Copied key "${paper.bibtex_key}" (no active editor).`);
        return;
      }
      const snippet = formatCitationSnippet(paper.bibtex_key, editor.document.languageId);
      await editor.edit((eb) => {
        for (const sel of editor.selections) {
          eb.replace(sel, snippet);
        }
      });
    }),

    vscode.commands.registerCommand('dupe.copyBibtex', async (arg?: Paper | PaperTreeItem) => {
      const paper = arg instanceof PaperTreeItem ? arg.paper : arg;
      if (!paper) {
        return;
      }
      await vscode.env.clipboard.writeText(paper.bibtex_raw || paper.bibtex_key);
      void vscode.window.showInformationMessage(`Copied BibTeX for ${paper.bibtex_key}.`);
    }),

    vscode.commands.registerCommand('dupe.toggleLinkPaper', async (arg?: Paper | PaperTreeItem) => {
      const paper = arg instanceof PaperTreeItem ? arg.paper : arg;
      const proj = await pickProjectOrWarn();
      if (!paper || !proj) {
        return;
      }
      const currentLinked = proj.link_all_papers
        ? papers.map((p) => p.id)
        : [...(proj.linked_paper_ids || [])];
      const set = new Set(currentLinked);
      const wasLinked = set.has(paper.id);
      if (wasLinked) {
        set.delete(paper.id);
      } else {
        set.add(paper.id);
      }
      await api.updateProject(proj.id, {
        link_all_papers: false,
        linked_paper_ids: Array.from(set),
      });
      await refreshAll();
      void vscode.window.showInformationMessage(
        `${wasLinked ? 'Unlinked' : 'Linked'} "${paper.bibtex_key}" in ${proj.name} and updated dupe_references.bib.`,
      );
    }),

    vscode.commands.registerCommand('dupe.deletePaper', async (arg?: Paper | PaperTreeItem) => {
      const paper = arg instanceof PaperTreeItem ? arg.paper : arg;
      if (!paper) {
        return;
      }
      const confirm = await vscode.window.showWarningMessage(
        `Delete "${paper.title}" (${paper.bibtex_key}) from library?`,
        { modal: true },
        'Delete',
      );
      if (confirm !== 'Delete') {
        return;
      }
      await api.deletePaper(paper.id);
      await refreshAll();
    }),

    vscode.commands.registerCommand('dupe.compileLatex', async () => {
      const proj = await pickProjectOrWarn();
      if (!proj) {
        return;
      }
      await runLatexCompile(proj, false);
    }),

    vscode.commands.registerCommand('dupe.openCompiledPdf', async () => {
      const proj = await pickProjectOrWarn();
      if (!proj) {
        return;
      }
      await openCompiledPdfForProject(proj, false);
    }),

    // SyncTeX Forward (Alt+J in .tex)
    vscode.commands.registerCommand('dupe.syncTexForward', async () => {
      const proj = await pickProjectOrWarn();
      const editor = vscode.window.activeTextEditor;
      if (!proj || !editor) {
        return;
      }
      const projRoot = await resolveProjectRoot(proj);
      if (!projRoot) {
        return;
      }
      const rel = path.relative(projRoot, editor.document.uri.fsPath).replace(/\\/g, '/');
      if (!rel.startsWith('paper/') || !rel.endsWith('.tex')) {
        void vscode.window.showInformationMessage('Open a .tex file inside paper/ to SyncTeX forward.');
        return;
      }
      try {
        const res = await api.syncTexForward(proj.id, {
          file: rel,
          line: editor.selection.active.line + 1,
        });
        await openCompiledPdfForProject(proj, true);
        await pdfViewer.jumpToSyncTex(`compiled:${proj.id}`, res);
      } catch (err) {
        void vscode.window.showWarningMessage(
          `SyncTeX forward failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }),

    vscode.commands.registerCommand('dupe.pullProject', async () => {
      const proj = await pickProjectOrWarn();
      if (!proj) {
        return;
      }
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Pulling Overleaf for ${proj.name}...` },
        async () => {
          try {
            const res = await api.pullProject(proj.id);
            await refreshAll();
            void vscode.window.showInformationMessage(
              res.updated
                ? `Pulled latest Overleaf changes (${res.paper_sha.slice(0, 7)}).`
                : `Overleaf paper/ already up to date (${res.paper_sha.slice(0, 7)}).`,
            );
          } catch (err) {
            void vscode.window.showErrorMessage(
              `Overleaf pull failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        },
      );
    }),

    vscode.commands.registerCommand('dupe.syncProject', async () => {
      const proj = await pickProjectOrWarn();
      if (!proj) {
        return;
      }
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Syncing ${proj.name}...` },
        async () => {
          try {
            const res = await api.syncProject(proj.id);
            await refreshAll();
            if (res.pushed) {
              void vscode.window.showInformationMessage(
                `Committed & pushed paper/ (${res.paper_sha.slice(0, 7)}) to Overleaf.`,
              );
            } else if (res.pending_push) {
              void vscode.window.showWarningMessage(
                `Committed locally; Overleaf push queued: ${res.push_warning}`,
              );
            } else {
              void vscode.window.showInformationMessage(
                res.committed
                  ? `Committed project changes (${res.paper_sha.slice(0, 7)}).`
                  : 'Regenerated AGENTS.md & BibTeX (working tree clean).',
              );
            }
          } catch (err) {
            void vscode.window.showErrorMessage(
              `Sync failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        },
      );
    }),

    vscode.commands.registerCommand('dupe.gatherContext', async () => {
      const proj = await pickProjectOrWarn();
      if (!proj) {
        return;
      }
      await api.gatherProjectContext(proj.id);
      await refreshAll();
      void vscode.window.showInformationMessage(
        `Regenerated AGENTS.md, dupe_references.bib, and refs/text/ for ${proj.name}.`,
      );
    }),

    vscode.commands.registerCommand('dupe.switchProjectsRoot', async () => {
      const status = localStatus || (await api.getLocalStatus());
      const recent = status.recent_projects_dirs || [];
      const items: Array<vscode.QuickPickItem & { dirPath?: string; custom?: boolean }> = recent.map((dir) => ({
        label: dir,
        description: dir === status.projects_dir ? '(current)' : '',
        dirPath: dir,
      }));
      items.push({ label: '$(folder-opened) Browse for another parent folder...', custom: true });

      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: `Current parent folder: ${status.projects_dir}`,
      });
      if (!picked) {
        return;
      }
      let nextDir = picked.dirPath;
      if (picked.custom) {
        const chosen = await vscode.window.showOpenDialog({
          canSelectFolders: true,
          canSelectFiles: false,
          canSelectMany: false,
          defaultUri: vscode.Uri.file(status.projects_dir || status.home_dir),
          openLabel: 'Use as dupe Projects Parent Folder',
        });
        if (!chosen || chosen.length === 0) {
          return;
        }
        nextDir = chosen[0].fsPath;
      }
      if (!nextDir) {
        return;
      }
      await api.setLocalProjectsRoot(nextDir);
      await refreshAll();
      void vscode.window.showInformationMessage(`Switched dupe projects parent folder to ${nextDir}.`);
    }),

    // Open project in a NEW VS Code window
    vscode.commands.registerCommand('dupe.openProjectFolder', async () => {
      await refreshAll();
      if (projects.length === 0 || !localStatus?.projects_dir) {
        void vscode.window.showInformationMessage('No projects found in current parent folder.');
        return;
      }
      const rootDir = localStatus.projects_dir;
      const picked = await vscode.window.showQuickPick(
        projects.map((p) => ({
          label: p.name,
          description: `${p.folder_name}/`,
          detail: p.overleaf_remote ? 'Overleaf Linked' : 'Local Git',
          folderPath: path.join(rootDir, p.folder_name),
        })),
        { placeHolder: `Open dupe project in a new window (${rootDir})` },
      );
      if (!picked) {
        return;
      }
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(picked.folderPath), true);
    }),

    // Scan all known recent parent roots (e.g. ~/dupe_mimic & ~/dupe_pele) and open in a NEW window
    vscode.commands.registerCommand('dupe.switchProjectWindow', async () => {
      const status = localStatus || (await api.getLocalStatus().catch(() => null));
      const candidateRoots = Array.from(
        new Set([...(status?.recent_projects_dirs || []), ...(status?.projects_dir ? [status.projects_dir] : [])]),
      );
      const discovered = discoverProjectsInWorkspace(candidateRoots);
      const picked = await vscode.window.showQuickPick(
        [
          ...discovered.map((d) => ({
            label: `$(folder) ${d.config.name}`,
            description: d.rootDir,
            detail: d.config.overleaf_remote ? 'Overleaf Linked' : 'Local Git',
            folderPath: d.rootDir,
          })),
          {
            label: '$(folder-opened) Browse for any project folder...',
            description: '',
            folderPath: '',
          },
        ],
        { placeHolder: 'Open project in a separate VS Code window' },
      );
      if (!picked) {
        return;
      }
      let targetDir = picked.folderPath;
      if (!targetDir) {
        const chosen = await vscode.window.showOpenDialog({
          canSelectFolders: true,
          canSelectFiles: false,
          canSelectMany: false,
          openLabel: 'Open in New Window',
        });
        if (!chosen || chosen.length === 0) {
          return;
        }
        targetDir = chosen[0].fsPath;
      }
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(targetDir), true);
    }),

    vscode.commands.registerCommand('dupe.createProject', async () => {
      const name = await vscode.window.showInputBox({
        prompt: 'New dupe project name',
        placeHolder: 'e.g. mimic-rss-2027',
      });
      if (!name?.trim()) {
        return;
      }
      const overleafRemote =
        (await vscode.window.showInputBox({
          prompt: 'Optional Overleaf / GitHub repository URL for paper/ (leave blank to skip)',
          placeHolder: 'https://git.overleaf.com/...',
        })) || '';
      const codeRemote =
        (await vscode.window.showInputBox({
          prompt: 'Optional Git repository URL for code/ (leave blank to skip or symlink later)',
          placeHolder: 'git@github.com:user/repo.git',
        })) || '';

      const created = await api.createProject({
        name: name.trim(),
        overleaf_remote: overleafRemote.trim(),
        code_remote: codeRemote.trim(),
        link_all_papers: true,
      });
      await refreshAll();
      const targetRoot = localStatus?.projects_dir
        ? path.join(localStatus.projects_dir, created.folder_name)
        : null;
      if (targetRoot) {
        const openNow = await vscode.window.showInformationMessage(
          `Created project "${created.name}". Open in new VS Code window?`,
          'Open New Window',
          'Later',
        );
        if (openNow === 'Open New Window') {
          await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(targetRoot), true);
        }
      }
    }),

    vscode.commands.registerCommand('dupe.linkLocalFolder', async () => {
      const modePick = await vscode.window.showQuickPick(
        [
          {
            label: 'Link Code Repo inside code/<name>/',
            description: 'Symlink a code repo as a subdirectory in code/ (supports multiple repos)',
            mode: 'symlink_code' as const,
            asSubdir: true,
          },
          {
            label: 'Link LaTeX / Paper Repo inside paper/<name>/',
            description: 'Symlink a LaTeX folder as a subdirectory in paper/ (supports multiple papers)',
            mode: 'symlink_paper' as const,
            asSubdir: true,
          },
          {
            label: 'Replace Single code/ Symlink',
            description: 'Point project code/ directly to one folder',
            mode: 'symlink_code' as const,
            asSubdir: false,
          },
          {
            label: 'Replace Single paper/ Symlink',
            description: 'Point project paper/ directly to one folder',
            mode: 'symlink_paper' as const,
            asSubdir: false,
          },
        ],
        { placeHolder: 'How should the local folder be linked?' },
      );
      if (!modePick) {
        return;
      }
      const proj = await pickProjectOrWarn();
      const folderPick = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false,
        openLabel: modePick.mode === 'symlink_code' ? 'Select Code Folder' : 'Select Paper Folder',
      });
      if (!folderPick || folderPick.length === 0) {
        return;
      }
      const selectedPath = folderPick[0].fsPath;
      let linkName = path.basename(selectedPath);
      if (modePick.asSubdir) {
        const enteredName = await vscode.window.showInputBox({
          prompt: `Subdirectory name inside ${modePick.mode === 'symlink_code' ? 'code/' : 'paper/'}`,
          value: linkName,
        });
        if (!enteredName?.trim()) {
          return;
        }
        linkName = enteredName.trim();
      }
      const res = await api.linkLocalFolder({
        mode: modePick.mode,
        source_path: selectedPath,
        target_project_id: proj?.id,
        name: linkName,
        as_subdir: modePick.asSubdir,
      });
      await refreshAll();
      void vscode.window.showInformationMessage(
        `Linked ${res.source_path} -> ${res.linked_path} (${res.project?.name || proj?.name || 'project'}).`,
      );
    }),

    vscode.commands.registerCommand('dupe.openWebUI', async () => {
      await vscode.env.openExternal(vscode.Uri.parse(api.getBaseUrl()));
    }),

    vscode.commands.registerCommand('dupe.toggleSpellCheck', async () => {
      const cfg = vscode.workspace.getConfiguration('dupe');
      const next = !cfg.get<boolean>('spellCheck.enabled', true);
      await cfg.update('spellCheck.enabled', next, vscode.ConfigurationTarget.Global);
      spellProvider.refreshAllOpenDocuments();
      void vscode.window.showInformationMessage(`dupe spell check ${next ? 'enabled' : 'disabled'}.`);
    }),

    vscode.commands.registerCommand(
      'dupe.addWordToProjectDict',
      async (word?: string, explicitRoot?: string) => {
        if (word) {
          await spellProvider.addToProjectDictionary(word, explicitRoot);
        }
      },
    ),

    vscode.commands.registerCommand('dupe.addWordToUserDict', async (word?: string) => {
      if (word) {
        await spellProvider.addToUserDictionary(word);
      }
    }),

    vscode.commands.registerCommand('dupe.selectCommentTarget', async () => {
      if (activeProjectRoot) {
        notesIndex.rebuild(activeProjectRoot);
      }
      const cfg = vscode.workspace.getConfiguration('dupe');
      const currentTarget = normalizeNoteRelPath(cfg.get<string>('commentTargetNote', 'notes/comments.md'));
      const seen = new Set<string>();
      const items: Array<vscode.QuickPickItem & { relPath?: string; custom?: boolean }> = [];
      const addOption = (relPath: string, description: string) => {
        const norm = normalizeNoteRelPath(relPath);
        if (seen.has(norm)) {
          return;
        }
        seen.add(norm);
        items.push({
          label: norm,
          description: norm === currentTarget ? `(current) ${description}`.trim() : description,
          relPath: norm,
        });
      };

      addOption('notes/comments.md', 'Default annotation queue');
      addOption('notes/paperChanges.md', 'Paper revision checklist');
      for (const n of notesIndex.getNotes()) {
        addOption(n.relPath, '');
      }
      items.push({
        label: '$(add) Enter custom note path...',
        description: 'e.g. notes/review-notes.md',
        custom: true,
      });

      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: `Select target note for inline comments (current: ${currentTarget})`,
      });
      if (!picked) {
        return;
      }

      let nextRel = picked.relPath;
      if (picked.custom) {
        const raw = await vscode.window.showInputBox({
          prompt: 'Target note path inside notes/',
          value: currentTarget,
          placeHolder: 'notes/paperChanges.md',
        });
        if (!raw?.trim()) {
          return;
        }
        nextRel = normalizeNoteRelPath(raw);
      }
      if (!nextRel) {
        return;
      }

      const scope =
        vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
          ? vscode.ConfigurationTarget.Workspace
          : vscode.ConfigurationTarget.Global;
      await cfg.update('commentTargetNote', nextRel, scope);
      void vscode.window.showInformationMessage(`Inline comments will now append to ${nextRel}.`);
    }),

    vscode.commands.registerCommand('dupe.addComment', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.uri.scheme !== 'file') {
        void vscode.window.showInformationMessage('Open a .tex or .md file in a dupe project to add a comment.');
        return;
      }
      const docPath = editor.document.uri.fsPath;
      const docRoot = findDupeProjectRoot(path.dirname(docPath)) || activeProjectRoot;
      let proj: ProjectConfig | null = activeProject;
      if (docRoot && (!proj || activeProjectRoot !== docRoot)) {
        const localCfg = readLocalProjectConfig(docRoot);
        if (localCfg) {
          proj = localCfg;
        }
      }
      if (!proj && !docRoot) {
        proj = await pickProjectOrWarn();
      }
      const projRoot = docRoot || (proj ? await resolveProjectRoot(proj) : null);
      if (!projRoot) {
        void vscode.window.showWarningMessage('Could not locate a dupe project for this file.');
        return;
      }

      const targetRel = normalizeNoteRelPath(
        vscode.workspace
          .getConfiguration('dupe')
          .get<string>('commentTargetNote', 'notes/comments.md'),
      );

      const relSource = path.relative(projRoot, docPath).replace(/\\/g, '/');
      const sel = editor.selection;
      const startLine = sel.start.line + 1;
      const endLine = sel.end.line + 1;
      const location =
        !sel.isEmpty && endLine > startLine ? `lines ${startLine}-${endLine}` : `line ${startLine}`;
      const rawQuote = sel.isEmpty
        ? editor.document.lineAt(sel.active.line).text
        : editor.document.getText(sel);
      const quote = rawQuote.trim();

      const comment = await vscode.window.showInputBox({
        prompt: `Comment on ${relSource} (${location}) -> ${targetRel}`,
        placeHolder: 'Describe the change or note for agents...',
      });
      if (!comment?.trim()) {
        return;
      }

      const targetAbsPath = path.join(projRoot, targetRel);
      let savedViaApi = false;
      if (proj && targetRel === 'notes/comments.md') {
        try {
          await api.addProjectComment(proj.id, {
            source: relSource,
            location,
            quote,
            comment: comment.trim(),
          });
          savedViaApi = true;
        } catch {
          savedViaApi = false;
        }
      }
      if (!savedViaApi) {
        await fsp.mkdir(path.dirname(targetAbsPath), { recursive: true });
        let existing = '';
        try {
          existing = await fsp.readFile(targetAbsPath, 'utf8');
        } catch {
          existing = '';
        }
        const block = formatCommentBlock({
          source: relSource,
          location,
          quote,
          comment: comment.trim(),
        });
        const nextContent = insertCommentIntoTargetNote(existing, block, targetRel);
        await fsp.writeFile(targetAbsPath, nextContent, 'utf8');
      }

      rebuildLocalIndices();
      const action = await vscode.window.showInformationMessage(
        `Added comment on ${relSource} (${location}) to ${targetRel}.`,
        'Open Note',
        'Change Target Note',
      );
      if (action === 'Open Note') {
        const targetDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(targetAbsPath));
        await vscode.window.showTextDocument(targetDoc, { viewColumn: vscode.ViewColumn.Beside });
      } else if (action === 'Change Target Note') {
        await vscode.commands.executeCommand('dupe.selectCommentTarget');
      }
    }),

    vscode.commands.registerCommand('dupe.checkUpdates', async () => {
      await runUpdateCheck(true);
    }),

    vscode.commands.registerCommand('dupe.toggleHerdrFollow', async () => {
      const cfg = vscode.workspace.getConfiguration('dupe');
      const next = !cfg.get<boolean>('herdr.followSpace', true);
      await cfg.update('herdr.followSpace', next, vscode.ConfigurationTarget.Global);
      if (next) {
        await herdrWatcher.checkNow(true);
      }
      updateStatusBar();
      void vscode.window.showInformationMessage(
        `Herdr space following ${next ? 'enabled' : 'paused'}.`,
      );
    }),

    vscode.commands.registerCommand('dupe.syncWithHerdrNow', async () => {
      const space = await herdrWatcher.checkNow(true);
      if (!space) {
        void vscode.window.showInformationMessage('No active Herdr space detected.');
        return;
      }
      await applyHerdrSpaceFocus(space, true);
    }),

    vscode.commands.registerCommand('dupe.openAllProjectsWorkspace', async () => {
      const folderMap = new Map<string, { name: string; path: string }>();
      const addCandidate = (dirPath: string | null | undefined, customName?: string) => {
        if (!dirPath) {
          return;
        }
        const resolved = path.resolve(dirPath);
        if (!fs.existsSync(resolved)) {
          return;
        }
        const key = resolved;
        if (!folderMap.has(key)) {
          const cfg = readLocalProjectConfig(resolved);
          folderMap.set(key, {
            name: customName || cfg?.name || path.basename(resolved),
            path: resolved,
          });
        }
      };

      for (const ws of vscode.workspace.workspaceFolders || []) {
        addCandidate(ws.uri.fsPath, ws.name);
      }

      try {
        const spaces = await listHerdrSpaces();
        for (const sp of spaces) {
          if (sp.folder && fs.existsSync(path.join(sp.folder, '.dupe', 'project.json'))) {
            addCandidate(sp.folder, sp.name);
          }
        }
      } catch {
        // herdr-app optional
      }

      const rootsToScan = new Set<string>();
      if (localStatus?.projects_dir) {
        rootsToScan.add(localStatus.projects_dir);
      }
      for (const r of localStatus?.recent_projects_dirs || []) {
        rootsToScan.add(r);
      }
      for (const rootDir of rootsToScan) {
        try {
          for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const full = path.join(rootDir, entry.name);
            if (entry.name === 'default-paper-project') continue;
            if (fs.existsSync(path.join(full, '.dupe', 'project.json'))) {
              addCandidate(full);
            }
          }
        } catch {
          // ignore unreadable root
        }
      }

      if (folderMap.size === 0) {
        void vscode.window.showWarningMessage('No dupe project folders found to open.');
        return;
      }

      const wsDir = path.join(os.homedir(), '.local', 'share', 'dupe');
      await fsp.mkdir(wsDir, { recursive: true });
      const wsFile = path.join(wsDir, 'dupe-all.code-workspace');
      const payload = {
        folders: Array.from(folderMap.values()),
        settings: {
          'dupe.herdr.followSpace': true,
        },
      };
      await fsp.writeFile(wsFile, JSON.stringify(payload, null, 2) + '\n', 'utf8');
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(wsFile), {
        forceReuseWindow: false,
      });
    }),

    vscode.commands.registerCommand('dupe.openKnowledgeGraph', async () => {
      if (!activeProjectRoot) {
        void vscode.window.showWarningMessage('Open a dupe project folder first.');
        return;
      }
      const rootDir = activeProjectRoot;
      brainGraphPanel.open(buildCurrentBrainGraph(), {
        onOpenPath: async (relPath) => {
          const absPath = path.join(rootDir, relPath);
          if (fs.existsSync(absPath)) {
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(absPath));
            await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One });
          }
        },
        onOpenPaperByKey: async (key) => {
          await vscode.commands.executeCommand('dupe.openPaperByKey', key);
        },
        onCreateGhostNote: async (label, relPath) => {
          const targetRel = relPath.startsWith('notes/') ? relPath : `notes/concepts/${label}.md`;
          const absPath = path.join(rootDir, targetRel);
          if (!fs.existsSync(absPath)) {
            await fsp.mkdir(path.dirname(absPath), { recursive: true });
            const seed = [
              '---',
              'type: concept',
              'status: seed',
              'tags: [concept]',
              '---',
              '',
              `# ${label}`,
              '',
              'Connected to [[MOC]].',
              '',
            ].join('\n');
            await fsp.writeFile(absPath, seed, 'utf8');
          }
          rebuildLocalIndices();
          const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(absPath));
          await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One });
        },
        onRequestRefresh: async () => {
          refreshBrainGraphIfOpen();
        },
      });
    }),

    vscode.commands.registerCommand('dupe.openAgentBlackboard', async () => {
      if (!activeProjectRoot) {
        void vscode.window.showWarningMessage('Open a dupe project folder first.');
        return;
      }
      const boardPath = path.join(activeProjectRoot, '.dupe', 'brain', 'blackboard.md');
      if (!fs.existsSync(boardPath)) {
        await fsp.mkdir(path.join(activeProjectRoot, '.dupe', 'brain', 'topics'), { recursive: true });
        await fsp.writeFile(
          boardPath,
          '# Agent Brain & Blackboard (Gitignored)\n\nAgents collaborate here without bloating `notes/`.\n',
          'utf8',
        );
      }
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(boardPath));
      await vscode.window.showTextDocument(doc, { preview: false });
    }),

    vscode.commands.registerCommand(
      'dupe.linkUnlinkedMention',
      async (mention?: UnlinkedMentionHit) => {
        if (!mention) return;
        try {
          const raw = await fsp.readFile(mention.sourceAbsPath, 'utf8');
          const lines = raw.split(/\r?\n/);
          const idx = mention.line - 1;
          if (idx < 0 || idx >= lines.length) return;
          const linkText =
            mention.matchedText.toLowerCase() === mention.targetSlug.toLowerCase()
              ? `[[${mention.targetSlug}]]`
              : `[[${mention.targetSlug}|${mention.matchedText}]]`;
          const updatedLine = lines[idx].replace(mention.matchedText, linkText);
          if (updatedLine === lines[idx]) return;
          lines[idx] = updatedLine;
          await fsp.writeFile(mention.sourceAbsPath, lines.join('\n'), 'utf8');
          rebuildLocalIndices();
          void vscode.window.showInformationMessage(
            `Linked "${mention.matchedText}" in ${mention.sourceRelPath} -> ${linkText}.`,
          );
        } catch (err) {
          void vscode.window.showErrorMessage(
            `Failed to link mention: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
    ),

    brainGraphPanel,
    herdrWatcher,
    statusHerdrItem,

    vscode.workspace.onDidOpenTextDocument((doc) => spellProvider.checkDocument(doc)),
    vscode.workspace.onDidChangeTextDocument((ev) => spellProvider.scheduleCheck(ev.document)),
    vscode.workspace.onDidCloseTextDocument((doc) => spellProvider.clearDocument(doc.uri)),

    vscode.workspace.onDidChangeConfiguration((ev) => {
      if (ev.affectsConfiguration('dupe')) {
        void refreshAll();
        spellProvider.refreshAllOpenDocuments();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void refreshAll()),
    vscode.workspace.onDidGrantWorkspaceTrust(() => void syncVSCodeGitRepositories(activeProjectRoot)),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (!editor) {
        return;
      }
      spellProvider.checkDocument(editor.document);
      const fsPath = editor.document.uri.fsPath;
      const hitRoot = findDupeProjectRoot(path.dirname(fsPath));
      if (hitRoot && hitRoot !== activeProjectRoot) {
        preferredProjectRootOverride = hitRoot;
        void refreshAll();
      } else {
        notesProvider.refresh(fsPath);
        refreshBrainGraphIfOpen();
      }
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.uri.scheme !== 'file') {
        return;
      }
      const fsPath = doc.uri.fsPath;
      if (
        fsPath.endsWith('.md') &&
        activeProjectRoot &&
        (fsPath.startsWith(path.join(activeProjectRoot, 'notes')) ||
          fsPath.startsWith(path.join(activeProjectRoot, '.dupe', 'brain')))
      ) {
        rebuildLocalIndices();
        return;
      }
      if (fsPath.endsWith('.bib')) {
        bibMap = loadProjectBibMetadata(activeProjectRoot, papers);
        return;
      }
      const compileOnSave = vscode.workspace
        .getConfiguration('dupe')
        .get<boolean>('compileOnSave', true);
      if (
        compileOnSave &&
        activeProject &&
        activeProjectRoot &&
        fsPath.endsWith('.tex') &&
        fsPath.startsWith(path.join(activeProjectRoot, 'paper'))
      ) {
        if (saveCompileTimer) {
          clearTimeout(saveCompileTimer);
        }
        const targetProj = activeProject;
        saveCompileTimer = setTimeout(() => {
          void runLatexCompile(targetProj, true);
        }, 400);
      }
    }),
  );

  void refreshAll().then(() => {
    herdrWatcher.start();
    const autoCheck = vscode.workspace.getConfiguration('dupe').get<boolean>('autoCheckUpdates', true);
    if (!autoCheck) {
      return;
    }
    const lastCheck = context.globalState.get<number>('dupe.lastUpdateCheckMs', 0);
    if (Date.now() - lastCheck < 6 * 60 * 60 * 1000) {
      return;
    }
    void context.globalState.update('dupe.lastUpdateCheckMs', Date.now());
    void runUpdateCheck(false);
  });
  spellProvider.refreshAllOpenDocuments();
}

export function deactivate(): void {
  // no persistent background timers to clean up
}
