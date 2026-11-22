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

export interface ProjectConfig {
  id: string;
  name: string;
  folder_name: string;
  overleaf_remote: string;
  code_remote?: string;
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
  projects_dir: string;
  recent_projects_dirs?: string[];
  home_dir: string;
  storage_dir: string;
  sync_remote_url: string;
  python_available: boolean;
  tectonic_available: boolean;
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
  outgoingLinks: string[];
}

export interface DiagramEntry {
  name: string;
  relPath: string;
  absPath: string;
}

export interface BacklinkHit {
  sourceRelPath: string;
  sourceAbsPath: string;
  line: number;
  preview: string;
}
