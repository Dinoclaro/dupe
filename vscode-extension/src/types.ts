export interface Paper {
  id: string;
  owner_id: number;
  title: string;
  authors: string;
  publication_year: number | null;
  doi: string;
  bibtex_key: string;
  bibtex_raw: string;
  file_path: string;
  file_hash: string;
  is_shared: boolean;
  tags: string[];
  updated_at: string;
}

export interface BibMetadata {
  key: string;
  title: string;
  authors: string;
  year: string;
  doi: string;
  raw: string;
  paperId?: string;
}

export interface LinkedCodeRepo {
  subdir?: string;
  remote_url: string;
  branch?: string;
}

export interface ProjectConfig {
  id: string;
  name: string;
  folder_name: string;
  overleaf_remote: string;
  code_remote?: string;
  code_repos?: LinkedCodeRepo[];
  linked_paper_ids: string[];
  link_all_papers: boolean;
  pending_push: boolean;
  last_synced_at?: string;
  updated_at: string;
}

export interface ProjectTreeEntry {
  path: string;
  kind: string;
  git_status?: string;
}

export interface ProjectTreeResponse {
  project: ProjectConfig;
  files: ProjectTreeEntry[];
  cited_keys: string[];
  code_target?: string;
  code_targets?: string[];
  paper_targets?: string[];
}

export interface LatexDiagnostic {
  level: 'error' | 'warning' | string;
  file: string;
  line?: number;
  message: string;
  context?: string;
  source?: string;
  category?: string;
}

export interface CompileProjectResponse {
  success: boolean;
  failure_kind: string;
  root_tex: string;
  pdf_available: boolean;
  duration_ms: number;
  errors: LatexDiagnostic[];
  warnings: LatexDiagnostic[];
  raw_log: string;
}

export interface PullProjectResponse {
  project: ProjectConfig;
  pulled: boolean;
  updated: boolean;
  paper_sha: string;
  last_synced_at: string;
}

export interface SyncProjectResponse {
  project: ProjectConfig;
  committed: boolean;
  root_sha: string;
  paper_sha: string;
  pushed: boolean;
  pending_push: boolean;
  push_warning: string;
  last_synced_at: string;
}

export interface SyncTexBackwardResult {
  path: string;
  line: number;
  page: number;
}

export interface SyncTexForwardResult {
  page: number;
  x: number;
  y: number;
}

export interface LocalStatus {
  mode: string;
  version?: string;
  projects_dir: string;
  recent_projects_dirs?: string[];
  home_dir: string;
  storage_dir: string;
  sync_remote_url: string;
  python_available: boolean;
  tectonic_available: boolean;
}

export interface LocalUpdateInfo {
  current_version: string;
  latest_version: string;
  update_available: boolean;
  release_url: string;
  release_notes?: string;
  install_method?: string;
  checked_at?: string;
}

export interface LocalUpdateApplyResponse {
  status: string;
  previous_version: string;
  version: string;
  method: string;
  extension_updated: boolean;
  herdr_updated: boolean;
  restarting: boolean;
  message: string;
}

export interface LocalBrowseDir {
  name: string;
  path: string;
  is_dupe_project: boolean;
  has_tex: boolean;
  has_code: boolean;
  has_git: boolean;
}

export interface RemoteSyncStatus {
  mode: string;
  remote_url: string;
  username: string;
  has_token: boolean;
  last_synced_at: string;
}

export interface LocalRefIndexEntry {
  paper_id: string;
  bibtex_key: string;
  title: string;
  authors: string;
  publication_year: number | null;
  doi: string;
  tags: string[];
}

export interface NoteEntry {
  title: string;
  relPath: string;
  absPath: string;
  slug: string;
  tags: string[];
  aliases?: string[];
  frontmatterType?: string;
  outgoingLinks: string[];
  lineCount?: number;
  byteSize?: number;
  isBloated?: boolean;
}

export interface BacklinkHit {
  sourceRelPath: string;
  sourceAbsPath: string;
  line: number;
  preview: string;
}

export interface UnlinkedMentionHit {
  sourceRelPath: string;
  sourceAbsPath: string;
  targetSlug: string;
  targetRelPath: string;
  matchedText: string;
  line: number;
  preview: string;
}

export type BrainNodeKind =
  | 'moc'
  | 'concept'
  | 'note'
  | 'artifact'
  | 'blackboard'
  | 'paper'
  | 'tex'
  | 'code'
  | 'ghost';

export interface BrainGraphNode {
  id: string;
  label: string;
  kind: BrainNodeKind;
  path: string;
  tags: string[];
  aliases?: string[];
  degree: number;
  backlinks: number;
  lines?: number;
  bloated?: boolean;
  snippet?: string;
}

export interface BrainGraphEdge {
  source: string;
  target: string;
  kind: 'wikilink' | 'cite' | 'provenance';
}

export interface BrainGraphPayload {
  nodes: BrainGraphNode[];
  edges: BrainGraphEdge[];
  focusNodeId: string | null;
  summary: {
    curatedNoteCount: number;
    artifactCount: number;
    blackboardCount: number;
    orphanCount: number;
    ghostCount: number;
    bloatedCount: number;
  };
}
