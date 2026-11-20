import * as vscode from 'vscode';
import { filterPapersByQuery } from './citations';
import { LocalStatus, Paper, ProjectConfig, RemoteSyncStatus } from './types';

export class PaperTreeItem extends vscode.TreeItem {
  constructor(
    public readonly paper: Paper,
    public readonly isLinkedToProject: boolean,
  ) {
    const label = paper.bibtex_key || paper.title || 'Untitled';
    super(label, vscode.TreeItemCollapsibleState.None);

    const year = paper.publication_year ? ` (${paper.publication_year})` : '';
    const linkBadge = isLinkedToProject ? '✓' : '○';
    this.description = `${linkBadge} ${paper.title}${year}`;

    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown(`**${paper.title}**\n\n`);
    if (paper.authors) {
      md.appendMarkdown(`*${paper.authors}*${year}\n\n`);
    }
    md.appendMarkdown(`- Key: \`${paper.bibtex_key}\`\n`);
    if (paper.doi) {
      md.appendMarkdown(`- DOI: \`${paper.doi}\`\n`);
    }
    if (paper.tags && paper.tags.length > 0) {
      md.appendMarkdown(`- Tags: ${paper.tags.join(', ')}\n`);
    }
    md.appendMarkdown(`- Linked to active project: ${isLinkedToProject ? 'Yes' : 'No'}`);
    this.tooltip = md;

    this.contextValue = isLinkedToProject ? 'paperLinked' : 'paperUnlinked';
    this.iconPath = new vscode.ThemeIcon(isLinkedToProject ? 'book' : 'file-pdf');
    this.command = {
      command: 'dupe.openPaperPdf',
      title: 'Open Paper PDF',
      arguments: [paper],
    };
  }
}

export class InfoTreeItem extends vscode.TreeItem {
  constructor(
    label: string,
    description: string,
    iconId: string,
    command?: vscode.Command,
    tooltip?: string,
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.iconPath = new vscode.ThemeIcon(iconId);
    this.command = command;
    this.tooltip = tooltip || `${label}${description ? `: ${description}` : ''}`;
    this.contextValue = 'dupeInfo';
  }
}

export class PaperLibraryProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  readonly onDidChangeTreeData = this.onDidChangeEmitter.event;

  private papers: Paper[] = [];
  private activeProject: ProjectConfig | null = null;
  private filterQuery = '';
  private daemonError: string | null = null;

  update(
    papers: Paper[],
    activeProject: ProjectConfig | null,
    daemonError: string | null,
  ): void {
    this.papers = papers;
    this.activeProject = activeProject;
    this.daemonError = daemonError;
    this.onDidChangeEmitter.fire(undefined);
  }

  setFilter(query: string): void {
    this.filterQuery = query.trim();
    void vscode.commands.executeCommand('setContext', 'dupe.hasPaperFilter', Boolean(this.filterQuery));
    this.onDidChangeEmitter.fire(undefined);
  }

  getFilter(): string {
    return this.filterQuery;
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): vscode.TreeItem[] {
    if (this.daemonError) {
      return [
        new InfoTreeItem(
          'Local dupe daemon offline',
          this.daemonError,
          'warning',
          { command: 'dupe.refresh', title: 'Retry' },
        ),
      ];
    }

    const filtered = filterPapersByQuery(this.papers, this.filterQuery);
    if (filtered.length === 0) {
      return [
        new InfoTreeItem(
          this.filterQuery ? `No matches for "${this.filterQuery}"` : 'No papers in library',
          this.filterQuery ? 'Click to clear filter' : 'Click to upload a PDF',
          this.filterQuery ? 'clear-all' : 'cloud-upload',
          {
            command: this.filterQuery ? 'dupe.clearPaperFilter' : 'dupe.uploadPdf',
            title: this.filterQuery ? 'Clear filter' : 'Upload PDF',
          },
        ),
      ];
    }

    const linkedSet = new Set(this.activeProject?.linked_paper_ids || []);
    const linkAll = this.activeProject ? this.activeProject.link_all_papers : false;
    return filtered.map((paper) => new PaperTreeItem(paper, linkAll || linkedSet.has(paper.id)));
  }
}

export class ProjectSyncProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  readonly onDidChangeTreeData = this.onDidChangeEmitter.event;

  private activeProject: ProjectConfig | null = null;
  private localStatus: LocalStatus | null = null;
  private syncStatus: RemoteSyncStatus | null = null;
  private codeTarget = '';
  private daemonError: string | null = null;

  update(params: {
    activeProject: ProjectConfig | null;
    localStatus: LocalStatus | null;
    syncStatus: RemoteSyncStatus | null;
    codeTarget: string;
    daemonError: string | null;
  }): void {
    this.activeProject = params.activeProject;
    this.localStatus = params.localStatus;
    this.syncStatus = params.syncStatus;
    this.codeTarget = params.codeTarget;
    this.daemonError = params.daemonError;
    this.onDidChangeEmitter.fire(undefined);
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): vscode.TreeItem[] {
    if (this.daemonError) {
      return [
        new InfoTreeItem(
          'Daemon Unreachable',
          this.daemonError,
          'error',
          { command: 'dupe.refresh', title: 'Retry Connection' },
        ),
      ];
    }

    const items: vscode.TreeItem[] = [];
    const proj = this.activeProject;

    items.push(
      new InfoTreeItem(
        proj ? proj.name : 'No active project',
        proj ? `${proj.folder_name}/` : 'Click to open or create a project',
        'folder-active',
        { command: 'dupe.openProjectFolder', title: 'Switch Project Folder' },
      ),
    );

    if (this.localStatus?.projects_dir) {
      items.push(
        new InfoTreeItem(
          'Projects Parent Folder',
          this.localStatus.projects_dir,
          'folder-library',
          { command: 'dupe.switchProjectsRoot', title: 'Switch Parent Folder' },
        ),
      );
    }

    if (this.syncStatus?.remote_url) {
      const account = this.syncStatus.username ? `${this.syncStatus.username} @ ` : '';
      items.push(
        new InfoTreeItem(
          'Library Sync',
          `${account}${this.syncStatus.remote_url}`,
          'cloud',
          { command: 'dupe.syncLibrary', title: 'Sync Paper Library Now' },
        ),
      );
    }

    if (proj) {
      items.push(
        new InfoTreeItem(
          'Overleaf Remote',
          proj.overleaf_remote ? (proj.pending_push ? 'Linked (push queued)' : 'Linked') : 'Not linked',
          proj.overleaf_remote ? 'git-branch' : 'circle-slash',
          { command: proj.overleaf_remote ? 'dupe.pullProject' : 'dupe.linkLocalFolder', title: 'Overleaf' },
        ),
      );

      if (this.codeTarget) {
        items.push(
          new InfoTreeItem(
            'Linked Code Folder',
            this.codeTarget,
            'file-symlink-directory',
            { command: 'dupe.linkLocalFolder', title: 'Change Linked Folder' },
          ),
        );
      }

      items.push(
        new InfoTreeItem(
          'Compile LaTeX & View PDF',
          this.localStatus?.tectonic_available ? 'tectonic ready' : 'browser fallback',
          'play',
          { command: 'dupe.compileLatex', title: 'Compile LaTeX' },
        ),
        new InfoTreeItem(
          'Commit & Push (Overleaf Sync)',
          'paper/ & notes/',
          'sync',
          { command: 'dupe.syncProject', title: 'Sync Project' },
        ),
        new InfoTreeItem(
          'Regenerate AGENTS.md & BibTeX',
          'refs/text/ + dupe_references.bib',
          'sparkle',
          { command: 'dupe.gatherContext', title: 'Regenerate Context' },
        ),
        new InfoTreeItem(
          'New Note (notes/*.md)',
          'Create Markdown note',
          'note',
          { command: 'dupe.newNote', title: 'New Note' },
        ),
        new InfoTreeItem(
          'New Diagram (diagrams/*.drawio.svg)',
          'Create Draw.io diagram',
          'type-hierarchy-sub',
          { command: 'dupe.newDiagram', title: 'New Diagram' },
        ),
      );
    }

    items.push(
      new InfoTreeItem(
        'New Project',
        'Scaffold paper/, code/, notes/, refs/',
        'new-folder',
        { command: 'dupe.createProject', title: 'Create Project' },
      ),
      new InfoTreeItem(
        'Link Local Folder',
        'Symlink code/ or paper/',
        'file-symlink-directory',
        { command: 'dupe.linkLocalFolder', title: 'Link Local Folder' },
      ),
      new InfoTreeItem(
        'Open Web UI',
        'Open in browser',
        'globe',
        { command: 'dupe.openWebUI', title: 'Open Web UI' },
      ),
    );

    return items;
  }
}
