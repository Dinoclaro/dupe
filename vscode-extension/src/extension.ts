import fs from 'node:fs/promises';
import path from 'node:path';
import * as vscode from 'vscode';
import { DupeApiClient } from './api';
import { DupeCitationFeatures } from './citationFeatures';
import { formatCitationSnippet, paperFromLocalRefIndex } from './citations';
import { PaperLibraryProvider, PaperTreeItem, ProjectSyncProvider } from './libraryTree';
import { DupePdfViewer } from './pdfViewer';
import {
  discoverProjectsInWorkspace,
  findDupeProjectRoot,
  readLocalRefsIndex,
} from './projectLocator';
import { LatexDiagnostic, LocalStatus, Paper, ProjectConfig, RemoteSyncStatus } from './types';

const DEFAULT_DRAWIO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="220" viewBox="0 0 400 220" content="%3Cmxfile%3E%3Cdiagram%20id%3D%22d1%22%20name%3D%22Page-1%22%3E%3CmxGraphModel%3E%3Croot%3E%3CmxCell%20id%3D%220%22%2F%3E%3CmxCell%20id%3D%221%22%20parent%3D%220%22%2F%3E%3C%2Froot%3E%3C%2FmxGraphModel%3E%3C%2Fdiagram%3E%3C%2Fmxfile%3E"><rect width="100%" height="100%" fill="#ffffff"/><text x="200" y="114" text-anchor="middle" font-family="sans-serif" font-size="14" fill="#555">New dupe diagram</text></svg>\n`;

export function activate(context: vscode.ExtensionContext): void {
  const api = new DupeApiClient();
  const pdfViewer = new DupePdfViewer(context.extensionUri);
  const paperProvider = new PaperLibraryProvider();
  const projectProvider = new ProjectSyncProvider();
  const diagnostics = vscode.languages.createDiagnosticCollection('dupe-latex');

  let papers: Paper[] = [];
  let projects: ProjectConfig[] = [];
  let activeProject: ProjectConfig | null = null;
  let activeProjectRoot: string | null = null;
  let localStatus: LocalStatus | null = null;
  let syncStatus: RemoteSyncStatus | null = null;
  let codeTarget = '';
  let daemonError: string | null = null;

  const statusSyncItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  const statusCompileItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  const statusLibraryItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);

  statusSyncItem.command = 'dupe.syncProject';
  statusCompileItem.command = 'dupe.compileLatex';
  statusLibraryItem.command = 'dupe.searchPapers';

  function updateStatusBar(): void {
    if (daemonError) {
      statusSyncItem.text = '$(warning) dupe: Daemon Offline';
      statusSyncItem.tooltip = `${daemonError} — Click to retry`;
      statusSyncItem.command = 'dupe.refresh';
      statusSyncItem.show();
      statusCompileItem.hide();
      statusLibraryItem.hide();
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

      statusCompileItem.text = '$(play) Compile LaTeX';
      statusCompileItem.tooltip = 'Compile project LaTeX with tectonic and open PDF';
      statusCompileItem.show();
    } else {
      statusSyncItem.text = '$(folder) dupe: Ready';
      statusSyncItem.tooltip = 'Open or create a dupe project';
      statusSyncItem.command = 'dupe.openProjectFolder';
      statusSyncItem.show();
      statusCompileItem.hide();
    }

    statusLibraryItem.text = `$(book) ${papers.length} PDFs`;
    statusLibraryItem.tooltip = 'Search dupe Paper Library';
    statusLibraryItem.show();
  }

  function resolveWorkspaceRoots(): string[] {
    return (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
  }

  function loadFallbackLocalRefs(): void {
    const wsRoots = resolveWorkspaceRoots();
    const discovered = discoverProjectsInWorkspace(wsRoots);
    if (discovered.length === 0) {
      return;
    }
    const first = discovered[0];
    activeProject = first.config;
    activeProjectRoot = first.rootDir;
    const refs = readLocalRefsIndex(first.rootDir);
    if (refs.length > 0 && papers.length === 0) {
      papers = refs.map(paperFromLocalRefIndex);
    }
  }

  async function refreshAll(): Promise<void> {
    try {
      const wsRoots = resolveWorkspaceRoots();
      const discovered = discoverProjectsInWorkspace(wsRoots);

      localStatus = await api.getLocalStatus().catch(() => null);
      if (
        discovered.length > 0 &&
        localStatus?.projects_dir &&
        path.dirname(discovered[0].rootDir) !== path.resolve(localStatus.projects_dir)
      ) {
        // Align daemon parent folder with the dupe project open in VS Code
        localStatus = await api.setLocalProjectsRoot(path.dirname(discovered[0].rootDir));
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
      codeTarget = '';

      if (discovered.length > 0) {
        const match =
          projects.find((p) => p.id === discovered[0].config.id) ||
          projects.find((p) => p.folder_name === discovered[0].config.folder_name) ||
          null;
        if (match) {
          activeProject = match;
          activeProjectRoot = discovered[0].rootDir;
        }
      }

      if (!activeProject && wsRoots.length > 0) {
        // Also detect when user opened a symlinked code/ repository directly
        for (const proj of projects) {
          try {
            const tree = await api.getProjectTree(proj.id);
            if (tree.code_target) {
              const resolvedTarget = path.resolve(tree.code_target);
              if (wsRoots.some((ws) => path.resolve(ws) === resolvedTarget)) {
                activeProject = proj;
                activeProjectRoot = localStatus?.projects_dir
                  ? path.join(localStatus.projects_dir, proj.folder_name)
                  : null;
                codeTarget = tree.code_target;
                break;
              }
            }
          } catch {
            // ignore tree lookup errors
          }
        }
      }

      if (!activeProject && projects.length > 0) {
        activeProject = projects[0];
        if (localStatus?.projects_dir) {
          activeProjectRoot = path.join(localStatus.projects_dir, activeProject.folder_name);
        }
      }

      if (activeProject && !codeTarget) {
        try {
          const tree = await api.getProjectTree(activeProject.id);
          codeTarget = tree.code_target || '';
        } catch {
          codeTarget = '';
        }
      }
    } catch (err) {
      daemonError = err instanceof Error ? err.message : String(err);
      loadFallbackLocalRefs();
    }

    paperProvider.update(papers, activeProject, daemonError);
    projectProvider.update({
      activeProject,
      localStatus,
      syncStatus,
      codeTarget,
      daemonError,
    });
    updateStatusBar();
  }

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

  async function openPaper(paper: Paper): Promise<void> {
    await pdfViewer.openPdf({
      key: `paper:${paper.id}`,
      title: `${paper.bibtex_key || paper.title}.pdf`,
      loader: () => api.getPaperPdfBytes(paper.id),
      viewColumn: vscode.ViewColumn.Beside,
    });
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

  const citationProvider = new DupeCitationFeatures(() => papers);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('dupe.papersView', paperProvider),
    vscode.window.registerTreeDataProvider('dupe.projectView', projectProvider),
    vscode.languages.registerCompletionItemProvider(
      [{ language: 'latex' }, { language: 'markdown' }, { language: 'tex' }],
      citationProvider,
      '{',
      ',',
      ':',
    ),
    vscode.languages.registerHoverProvider(
      [{ language: 'latex' }, { language: 'markdown' }, { language: 'tex' }],
      citationProvider,
    ),
    vscode.languages.registerDocumentLinkProvider(
      [{ language: 'latex' }, { language: 'markdown' }, { language: 'tex' }],
      citationProvider,
    ),
    diagnostics,
    statusSyncItem,
    statusCompileItem,
    statusLibraryItem,
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dupe.refresh', () => refreshAll()),

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
        { placeHolder: 'Search library papers (select to open PDF or insert citation)', matchOnDescription: true, matchOnDetail: true },
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
        void vscode.window.showWarningMessage(`Paper "${bibtexKey}" not found in library.`);
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
      const projRoot = await resolveProjectRoot(proj);
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
              await pdfViewer.openPdf({
                key: `compiled:${proj.id}`,
                title: `${proj.name}.pdf`,
                loader: () => api.getCompiledPdfBytes(proj.id),
                viewColumn: vscode.ViewColumn.Beside,
                preserveFocus: true,
              });
            }

            if (res.success) {
              void vscode.window.showInformationMessage(
                `Compiled ${res.root_tex} in ${(res.duration_ms / 1000).toFixed(1)}s (${(res.warnings || []).length} warning(s)).`,
              );
            } else {
              void vscode.window.showWarningMessage(
                `LaTeX compile finished with ${(res.errors || []).length} error(s) (${res.failure_kind}). Check Problems panel.`,
              );
            }
          } catch (err) {
            void vscode.window.showErrorMessage(
              `Compile failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        },
      );
    }),

    vscode.commands.registerCommand('dupe.openCompiledPdf', async () => {
      const proj = await pickProjectOrWarn();
      if (!proj) {
        return;
      }
      await pdfViewer.openPdf({
        key: `compiled:${proj.id}`,
        title: `${proj.name}.pdf`,
        loader: () => api.getCompiledPdfBytes(proj.id),
        viewColumn: vscode.ViewColumn.Beside,
      });
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

    vscode.commands.registerCommand('dupe.openProjectFolder', async () => {
      await refreshAll();
      if (projects.length === 0) {
        void vscode.window.showInformationMessage('No projects in current parent folder.');
        return;
      }
      const rootDir = localStatus?.projects_dir;
      if (!rootDir) {
        return;
      }
      const picked = await vscode.window.showQuickPick(
        projects.map((p) => ({
          label: p.name,
          description: `${p.folder_name}/`,
          detail: p.overleaf_remote ? 'Overleaf Linked' : 'Local Git',
          folderPath: path.join(rootDir, p.folder_name),
        })),
        { placeHolder: `Open dupe project from ${rootDir}` },
      );
      if (!picked) {
        return;
      }
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(picked.folderPath), false);
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
          `Created project "${created.name}". Open folder in VS Code?`,
          'Open Folder',
          'Later',
        );
        if (openNow === 'Open Folder') {
          await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(targetRoot), false);
        }
      }
    }),

    vscode.commands.registerCommand('dupe.linkLocalFolder', async () => {
      const modePick = await vscode.window.showQuickPick(
        [
          {
            label: 'Link Code Repo into code/',
            description: 'Symlink an existing code directory into a dupe project without copying files',
            mode: 'symlink_code' as const,
          },
          {
            label: 'Link Existing LaTeX / Overleaf Folder as paper/',
            description: 'Symlink an existing paper repo into a dupe project',
            mode: 'symlink_paper' as const,
          },
        ],
        { placeHolder: 'How should the local folder be linked?' },
      );
      if (!modePick) {
        return;
      }
      const proj = modePick.mode === 'symlink_code' ? await pickProjectOrWarn() : activeProject;
      const folderPick = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false,
        openLabel: modePick.mode === 'symlink_code' ? 'Link as code/' : 'Link as paper/',
      });
      if (!folderPick || folderPick.length === 0) {
        return;
      }
      const res = await api.linkLocalFolder({
        mode: modePick.mode,
        source_path: folderPick[0].fsPath,
        target_project_id: proj?.id,
      });
      await refreshAll();
      void vscode.window.showInformationMessage(
        `Linked ${res.source_path} -> ${res.linked_path} (${res.project.name}).`,
      );
    }),

    vscode.commands.registerCommand('dupe.newNote', async () => {
      const proj = await pickProjectOrWarn();
      if (!proj) {
        return;
      }
      const projRoot = await resolveProjectRoot(proj);
      if (!projRoot) {
        return;
      }
      const rawName = await vscode.window.showInputBox({
        prompt: 'Note filename inside notes/',
        placeHolder: 'e.g. experiment-ideas',
      });
      if (!rawName?.trim()) {
        return;
      }
      const safeName = rawName.trim().endsWith('.md') ? rawName.trim() : `${rawName.trim()}.md`;
      const absNote = path.join(projRoot, 'notes', safeName);
      await fs.mkdir(path.dirname(absNote), { recursive: true });
      try {
        await fs.access(absNote);
      } catch {
        const heading = safeName.replace(/\.md$/, '');
        await fs.writeFile(absNote, `# ${heading}\n\n`, 'utf8');
      }
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(absNote));
      await vscode.window.showTextDocument(doc);
    }),

    vscode.commands.registerCommand('dupe.newDiagram', async () => {
      const proj = await pickProjectOrWarn();
      if (!proj) {
        return;
      }
      const projRoot = await resolveProjectRoot(proj);
      if (!projRoot) {
        return;
      }
      const rawName = await vscode.window.showInputBox({
        prompt: 'Diagram stem inside diagrams/ (.drawio.svg)',
        placeHolder: 'e.g. architecture',
      });
      if (!rawName?.trim()) {
        return;
      }
      const cleanStem = rawName.trim().replace(/(\.drawio\.svg|\.svg)$/, '');
      const absDiagram = path.join(projRoot, 'diagrams', `${cleanStem}.drawio.svg`);
      await fs.mkdir(path.dirname(absDiagram), { recursive: true });
      try {
        await fs.access(absDiagram);
      } catch {
        await fs.writeFile(absDiagram, DEFAULT_DRAWIO_SVG, 'utf8');
      }
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(absDiagram));
    }),

    vscode.commands.registerCommand('dupe.openWebUI', async () => {
      await vscode.env.openExternal(vscode.Uri.parse(api.getBaseUrl()));
    }),

    vscode.workspace.onDidChangeConfiguration((ev) => {
      if (ev.affectsConfiguration('dupe')) {
        void refreshAll();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void refreshAll()),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (!editor) {
        return;
      }
      const hitRoot = findDupeProjectRoot(path.dirname(editor.document.uri.fsPath));
      if (hitRoot && hitRoot !== activeProjectRoot) {
        void refreshAll();
      }
    }),
  );

  void refreshAll();
}

export function deactivate(): void {
  // no persistent background timers to clean up
}
