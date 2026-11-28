import * as vscode from 'vscode';
import { filterPapersByQuery } from './citations';
import { NotesIndex } from './notesIndex';
import {
  BacklinkHit,
  LocalStatus,
  LocalUpdateInfo,
  NoteEntry,
  Paper,
  ProjectConfig,
  RemoteSyncStatus,
  UnlinkedMentionHit,
} from './types';

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

export class SectionTreeItem extends vscode.TreeItem {
  constructor(
    label: string,
    public readonly sectionKind: string,
    iconId: string,
    description = '',
    public readonly items: vscode.TreeItem[] = [],
    collapsibleState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.Expanded,
  ) {
    super(label, collapsibleState);
    this.description = description;
    this.iconPath = new vscode.ThemeIcon(iconId);
    this.contextValue = `section_${sectionKind}`;
  }
}

export class NoteTreeItem extends vscode.TreeItem {
  constructor(public readonly note: NoteEntry, openInBrainStudio = false) {
    super(note.title, vscode.TreeItemCollapsibleState.None);
    this.description = note.tags.length > 0 ? note.tags.map((t) => `#${t}`).join(' ') : `${note.lineCount || 0}L`;
    this.iconPath = new vscode.ThemeIcon(
      note.relPath.startsWith('notes/artifacts/')
        ? 'sparkle'
        : note.relPath.startsWith('notes/concepts/')
          ? 'lightbulb'
          : 'note',
    );
    this.tooltip = `${note.relPath} (${note.lineCount || 0} lines)`;
    this.contextValue = 'dupeNote';
    this.command = openInBrainStudio
      ? {
          command: 'dupe.openInBrainStudio',
          title: 'Open in Brain Studio Reader',
          arguments: [`note:${note.relPath}`, 'docs'],
        }
      : {
          command: 'vscode.open',
          title: 'Open Note',
          arguments: [vscode.Uri.file(note.absPath)],
        };
  }
}

export class BacklinkTreeItem extends vscode.TreeItem {
  constructor(public readonly hit: BacklinkHit) {
    super(hit.sourceRelPath, vscode.TreeItemCollapsibleState.None);
    this.description = `:${hit.line} ${hit.preview}`;
    this.iconPath = new vscode.ThemeIcon('references');
    this.tooltip = `${hit.sourceRelPath}:${hit.line}\n${hit.preview}`;
    this.command = {
      command: 'vscode.open',
      title: 'Open Backlink',
      arguments: [
        vscode.Uri.file(hit.sourceAbsPath),
        { selection: new vscode.Range(hit.line - 1, 0, hit.line - 1, 0) },
      ],
    };
  }
}

export class UnlinkedMentionTreeItem extends vscode.TreeItem {
  constructor(public readonly mention: UnlinkedMentionHit) {
    super(`Link: ${mention.sourceRelPath}:${mention.line}`, vscode.TreeItemCollapsibleState.None);
    this.description = `"${mention.matchedText}" — click to [[link]]`;
    this.iconPath = new vscode.ThemeIcon('link');
    this.tooltip = `${mention.preview}\n\nClick to convert "${mention.matchedText}" into [[${mention.targetSlug}|${mention.matchedText}]]`;
    this.command = {
      command: 'dupe.linkUnlinkedMention',
      title: 'Convert Unlinked Mention to [[Wikilink]]',
      arguments: [mention],
    };
  }
}

export class PaperLibraryProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  readonly onDidChangeTreeData = this.onDidChangeEmitter.event;

  private papers: Paper[] = [];
  private activeProject: ProjectConfig | null = null;
  private filterQuery = '';
  private daemonError: string | null = null;

  update(papers: Paper[], activeProject: ProjectConfig | null, daemonError: string | null): void {
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

export class NotesAndBacklinksProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  readonly onDidChangeTreeData = this.onDidChangeEmitter.event;

  private activeFilePath: string | null = null;

  constructor(private readonly notesIndex: NotesIndex) {}

  refresh(activeFilePath?: string | null): void {
    if (activeFilePath !== undefined) {
      this.activeFilePath = activeFilePath;
    }
    this.onDidChangeEmitter.fire(undefined);
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
    if (element instanceof SectionTreeItem) {
      return element.items;
    }

    const hits = this.activeFilePath ? this.notesIndex.getBacklinksForNote(this.activeFilePath) : [];
    const outgoing = this.activeFilePath ? this.notesIndex.getOutgoingLinksForNote(this.activeFilePath) : [];
    const unlinked = this.activeFilePath
      ? this.notesIndex.getUnlinkedMentionsForNote(this.activeFilePath)
      : [];
    const groups = this.notesIndex.getAutoBrainGroups();

    const items: vscode.TreeItem[] = [
      new InfoTreeItem(
        'Open Brain Studio (Alt+G)',
        'Interactive graph + Mermaid reader',
        'type-hierarchy',
        { command: 'dupe.openKnowledgeGraph', title: 'Open Brain Studio' },
      ),
    ];

    if (hits.length > 0) {
      items.push(
        new SectionTreeItem(
          'Incoming Backlinks',
          'backlinks',
          'references',
          String(hits.length),
          hits.map((h) => new BacklinkTreeItem(h)),
        ),
      );
    }

    if (outgoing.length > 0) {
      const outItems = outgoing.map((o) => {
        if (o.kind === 'paper' && o.paperKey) {
          return new InfoTreeItem(o.label, 'paper', 'book', {
            command: 'dupe.openPaperByKey',
            title: 'Open Paper PDF',
            arguments: [o.paperKey],
          });
        }
        if (o.kind === 'ghost' && o.targetRelPath) {
          return new InfoTreeItem(o.label, 'unresolved (click to create)', 'circle-outline', {
            command: 'dupe.openInBrainStudio',
            title: 'Inspect Ghost Note',
            arguments: [`ghost:${o.label.toLowerCase()}`, 'graph'],
          });
        }
        return new InfoTreeItem(o.label, o.targetRelPath || '', 'arrow-right', {
          command: 'dupe.openInBrainStudio',
          title: 'Open Note in Brain Studio',
          arguments: [`note:${o.targetRelPath || ''}`, 'graph'],
        });
      });
      items.push(
        new SectionTreeItem('Links Out', 'outgoing', 'arrow-small-right', String(outItems.length), outItems),
      );
    }

    if (unlinked.length > 0) {
      items.push(
        new SectionTreeItem(
          'Unlinked Mentions',
          'unlinked',
          'link',
          String(unlinked.length),
          unlinked.map((u) => new UnlinkedMentionTreeItem(u)),
        ),
      );
    }

    if (groups.artifacts.length > 0) {
      items.push(
        new SectionTreeItem(
          'Living Artifacts',
          'artifacts',
          'sparkle',
          String(groups.artifacts.length),
          groups.artifacts.map((a) => new NoteTreeItem(a, true)),
        ),
      );
    }

    if (groups.concepts.length > 0) {
      items.push(
        new SectionTreeItem(
          'Concepts',
          'concepts',
          'lightbulb',
          String(groups.concepts.length),
          groups.concepts.map((c) => new NoteTreeItem(c, true)),
        ),
      );
    }

    if (groups.notes.length > 0) {
      items.push(
        new SectionTreeItem(
          'Notes',
          'notes',
          'files',
          String(groups.notes.length),
          groups.notes.map((n) => new NoteTreeItem(n, true)),
          vscode.TreeItemCollapsibleState.Collapsed,
        ),
      );
    }

    return items;
  }
}

export class ProjectSyncProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  readonly onDidChangeTreeData = this.onDidChangeEmitter.event;

  private activeProject: ProjectConfig | null = null;
  private localStatus: LocalStatus | null = null;
  private syncStatus: RemoteSyncStatus | null = null;
  private codeTargets: string[] = [];
  private paperTargets: string[] = [];
  private daemonError: string | null = null;
  private updateInfo: LocalUpdateInfo | null = null;

  update(params: {
    activeProject: ProjectConfig | null;
    localStatus: LocalStatus | null;
    syncStatus: RemoteSyncStatus | null;
    codeTargets: string[];
    paperTargets: string[];
    daemonError: string | null;
    updateInfo?: LocalUpdateInfo | null;
  }): void {
    this.activeProject = params.activeProject;
    this.localStatus = params.localStatus;
    this.syncStatus = params.syncStatus;
    this.codeTargets = params.codeTargets;
    this.paperTargets = params.paperTargets;
    this.daemonError = params.daemonError;
    if (params.updateInfo !== undefined) {
      this.updateInfo = params.updateInfo;
    }
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
        proj ? `${proj.folder_name}/ (click to open in new window)` : 'Click to open a project',
        'folder-active',
        { command: 'dupe.openProjectFolder', title: 'Open Project in New Window' },
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
          proj.overleaf_remote ? (proj.pending_push ? 'Linked (push queued)' : 'Linked (click to pull)') : 'Not linked',
          proj.overleaf_remote ? 'git-branch' : 'circle-slash',
          { command: proj.overleaf_remote ? 'dupe.pullProject' : 'dupe.linkLocalFolder', title: 'Overleaf' },
        ),
      );

      if (this.codeTargets.length > 0) {
        items.push(
          new InfoTreeItem(
            `Linked Code (${this.codeTargets.length})`,
            this.codeTargets.join(', '),
            'file-symlink-directory',
            { command: 'dupe.linkLocalFolder', title: 'Link Another Code / Paper Repo' },
          ),
        );
      }

      if (this.paperTargets.length > 0) {
        items.push(
          new InfoTreeItem(
            `Linked Paper Repos (${this.paperTargets.length})`,
            this.paperTargets.join(', '),
            'book',
            { command: 'dupe.linkLocalFolder', title: 'Link Another Code / Paper Repo' },
          ),
        );
      }

      items.push(
        new InfoTreeItem(
          'Compile LaTeX & View PDF (Alt+C)',
          this.localStatus?.tectonic_available ? 'tectonic + SyncTeX ready' : 'check tectonic',
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
      );
    }

    items.push(
      new InfoTreeItem(
        'Open Another Project (New Window)',
        'Opens isolated VS Code window',
        'window',
        { command: 'dupe.switchProjectWindow', title: 'Open Project in New Window' },
      ),
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
      this.updateInfo?.update_available
        ? new InfoTreeItem(
            `Update Available: ${this.updateInfo.latest_version}`,
            `Installed: ${this.updateInfo.current_version} — Click to update`,
            'cloud-download',
            { command: 'dupe.checkUpdates', title: 'Update dupe' },
          )
        : new InfoTreeItem(
            'Check for Updates',
            this.localStatus?.version ? `Installed: ${this.localStatus.version}` : 'GitHub Releases',
            'cloud-download',
            { command: 'dupe.checkUpdates', title: 'Check for Updates' },
          ),
    );

    return items;
  }
}
