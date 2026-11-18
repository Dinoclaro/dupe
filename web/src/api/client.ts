export interface User {
  id: number;
  username: string;
  color_hex: string;
  created_at: string;
}

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

export interface GitRepo {
  id: string;
  owner_id: number;
  name: string;
  remote_url: string;
  bib_file_path: string;
  figures_dir: string;
  local_path: string;
  last_synced_at: string | null;
  updated_at: string;
}

export interface SyncRepoResult {
  repo: GitRepo;
  bib_entries: number;
  committed: boolean;
  commit_sha?: string;
  synced_at: string;
}

export interface DocumentItem {
  id: string;
  owner_id: number;
  doc_type: 'markdown' | 'diagram' | 'latex' | 'typst';
  title: string;
  content: string;
  is_shared: boolean;
  updated_at: string;
}

export interface ProjectConfig {
  id: string;
  name: string;
  folder_name: string;
  overleaf_remote: string;
  linked_paper_ids: string[];
  link_all_papers: boolean;
  pending_push: boolean;
  last_synced_at?: string;
  updated_at: string;
}

export interface ProjectTreeEntry {
  path: string;
  kind: 'tex' | 'bib' | 'markdown' | 'diagram' | 'json' | 'other';
  git_status?: 'M' | 'U' | '';
}

export interface ProjectFilePayload {
  path: string;
  content: string;
  head_content: string;
}

export interface ProjectPullResponse {
  project: ProjectConfig;
  pulled: boolean;
  updated: boolean;
  paper_sha: string;
  last_synced_at: string;
}

export interface ProjectSyncResponse {
  project: ProjectConfig;
  committed: boolean;
  root_sha: string;
  paper_sha: string;
  pushed: boolean;
  pending_push: boolean;
  push_warning: string;
  last_synced_at: string;
}

export interface LatexDiagnostic {
  level: 'error' | 'warning';
  file: string;
  line?: number;
  message: string;
}

export interface CompileProjectResponse {
  success: boolean;
  root_tex: string;
  pdf_available: boolean;
  duration_ms: number;
  errors: LatexDiagnostic[];
  warnings: LatexDiagnostic[];
  raw_log: string;
}

export interface SearchMatchItem {
  category: 'pdf' | 'latex' | 'notes' | 'code';
  path: string;
  title: string;
  paper_id?: string;
  bibtex_key?: string;
  line?: number;
  snippet: string;
  kind: ProjectTreeEntry['kind'] | 'pdf';
}

export interface OutboxEntry {
  id: string;
  kind: 'paper_patch' | 'project_file';
  projectId?: string;
  path?: string;
  content?: string;
  paperPatch?: Partial<Paper> & { id: string; file_hash: string };
  updatedAt: string;
}

const TOKEN_STORAGE_KEY = 'dupe_jwt_token';
const OUTBOX_STORAGE_KEY = 'dupe_sync_outbox_v1';
const SNAPSHOT_STORAGE_KEY = 'dupe_workspace_snapshot_v1';
const GITHUB_PAT_STORAGE_KEY = 'dupe_github_pat_v1';
const memoryStorageFallback = new Map<string, string>();

function storageGet(key: string): string | null {
  if (typeof localStorage !== 'undefined' && typeof localStorage.getItem === 'function') {
    return localStorage.getItem(key);
  }
  return memoryStorageFallback.get(key) ?? null;
}

function storageSet(key: string, value: string): void {
  if (typeof localStorage !== 'undefined' && typeof localStorage.setItem === 'function') {
    localStorage.setItem(key, value);
    return;
  }
  memoryStorageFallback.set(key, value);
}

function storageRemove(key: string): void {
  if (typeof localStorage !== 'undefined' && typeof localStorage.removeItem === 'function') {
    localStorage.removeItem(key);
    return;
  }
  memoryStorageFallback.delete(key);
}

export function getStoredToken(): string | null {
  return storageGet(TOKEN_STORAGE_KEY);
}

export function setStoredToken(token: string | null): void {
  if (token) {
    storageSet(TOKEN_STORAGE_KEY, token);
  } else {
    storageRemove(TOKEN_STORAGE_KEY);
  }
}

export function getOutboxQueue(): OutboxEntry[] {
  try {
    const raw = storageGet(OUTBOX_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as OutboxEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function enqueueOutboxEntry(entry: OutboxEntry): OutboxEntry[] {
  const current = getOutboxQueue().filter((item) => item.id !== entry.id);
  const next = [...current, entry];
  storageSet(OUTBOX_STORAGE_KEY, JSON.stringify(next));
  return next;
}

export function clearOutboxQueue(): void {
  storageRemove(OUTBOX_STORAGE_KEY);
}

export interface CachedWorkspaceSnapshot {
  user?: User;
  papers?: Paper[];
  projects?: ProjectConfig[];
  projectTree?: ProjectTreeEntry[];
  fileBuffers?: Record<string, string>;
}

export function loadWorkspaceSnapshot(): CachedWorkspaceSnapshot {
  try {
    const raw = storageGet(SNAPSHOT_STORAGE_KEY);
    if (!raw) {
      return {};
    }
    return JSON.parse(raw) as CachedWorkspaceSnapshot;
  } catch {
    return {};
  }
}

export function saveWorkspaceSnapshot(patch: Partial<CachedWorkspaceSnapshot>): void {
  try {
    const current = loadWorkspaceSnapshot();
    const merged: CachedWorkspaceSnapshot = {
      ...current,
      ...patch,
      fileBuffers: {
        ...(current.fileBuffers || {}),
        ...(patch.fileBuffers || {}),
      },
    };
    storageSet(SNAPSHOT_STORAGE_KEY, JSON.stringify(merged));
  } catch {
    // ignore storage quota errors
  }
}

export function getStoredGitHubPat(): string {
  return storageGet(GITHUB_PAT_STORAGE_KEY) || '';
}

export function setStoredGitHubPat(token: string): void {
  if (token.trim()) {
    storageSet(GITHUB_PAT_STORAGE_KEY, token.trim());
  } else {
    storageRemove(GITHUB_PAT_STORAGE_KEY);
  }
}

export function parseGitHubOwnerRepo(remoteUrl: string): { owner: string; repo: string } | null {
  const trimmed = remoteUrl.trim().replace(/\.git$/i, '');
  const sshMatch = trimmed.match(/git@github\.com:([^/]+)\/([^/\s]+)$/i);
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }
  const httpsMatch = trimmed.match(/github\.com\/([^/]+)\/([^/\s]+)$/i);
  if (httpsMatch) {
    return { owner: httpsMatch[1], repo: httpsMatch[2] };
  }
  return null;
}

export async function pushFilesToGitHubDirect(
  remoteUrl: string,
  githubPat: string,
  files: Array<{ path: string; content: string }>,
  commitMessage = 'chore(dupe): direct browser commit while home server offline',
): Promise<number> {
  const parsed = parseGitHubOwnerRepo(remoteUrl);
  if (!parsed) {
    throw new Error('Remote URL is not a GitHub repository (expected github.com/owner/repo)');
  }
  if (!githubPat.trim()) {
    throw new Error('GitHub Personal Access Token (ghp_...) is required for direct browser push');
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${githubPat.trim()}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
  };

  let pushedCount = 0;
  for (const file of files) {
    const cleanRel = file.path.replace(/^paper\//, '');
    const apiUrl = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/contents/${cleanRel}`;

    let existingSha: string | undefined;
    const getResp = await fetch(apiUrl, { headers });
    if (getResp.ok) {
      const existingData = (await getResp.json()) as { sha?: string };
      existingSha = existingData.sha;
    }

    const utf8Bytes = new TextEncoder().encode(file.content);
    let binary = '';
    utf8Bytes.forEach((b) => {
      binary += String.fromCharCode(b);
    });
    const contentBase64 = btoa(binary);

    const putResp = await fetch(apiUrl, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        message: commitMessage,
        content: contentBase64,
        ...(existingSha ? { sha: existingSha } : {}),
      }),
    });
    if (!putResp.ok) {
      const errText = await putResp.text();
      throw new Error(`GitHub API error (${putResp.status}) on ${cleanRel}: ${errText.slice(0, 120)}`);
    }
    pushedCount++;
  }
  return pushedCount;
}

async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!path.startsWith('/api/')) {
    throw new Error(`API path must be a relative /api/... path: ${path}`);
  }
  const headers = new Headers(init.headers);
  const token = getStoredToken();
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  if (!(init.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(path, { ...init, headers });
  if (response.status === 204) {
    return undefined as T;
  }

  const contentType = response.headers.get('Content-Type') || '';
  if (!response.ok) {
    if (contentType.includes('application/json')) {
      const errPayload = (await response.json()) as { error?: string };
      throw new Error(errPayload.error || `Request failed (${response.status})`);
    }
    throw new Error(`Request failed (${response.status})`);
  }

  if (contentType.includes('application/json')) {
    return (await response.json()) as T;
  }
  return (await response.text()) as unknown as T;
}

export const api = {
  async health(): Promise<{ status: string; mode?: string }> {
    return apiFetch<{ status: string; mode?: string }>('/api/health');
  },

  async login(username: string, password: string): Promise<{ token: string; user: User }> {
    const res = await apiFetch<{ token: string; user: User }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
    setStoredToken(res.token);
    return res;
  },

  async me(): Promise<User> {
    return apiFetch<User>('/api/auth/me');
  },

  async changePassword(newPassword: string): Promise<void> {
    await apiFetch<{ status: string }>('/api/auth/password', {
      method: 'POST',
      body: JSON.stringify({ new_password: newPassword }),
    });
  },

  async listPapers(): Promise<Paper[]> {
    return apiFetch<Paper[]>('/api/papers');
  },

  async uploadPapers(files: FileList | File[], isShared = false): Promise<Paper[]> {
    const form = new FormData();
    Array.from(files).forEach((file) => form.append('files', file));
    form.append('is_shared', String(isShared));

    const res = await apiFetch<Paper | { papers: Paper[] }>('/api/papers/upload', {
      method: 'POST',
      body: form,
    });
    return Array.isArray((res as { papers?: Paper[] }).papers)
      ? (res as { papers: Paper[] }).papers
      : [res as Paper];
  },

  async updatePaper(
    id: string,
    patch: Partial<Pick<Paper, 'title' | 'authors' | 'publication_year' | 'doi' | 'bibtex_key' | 'bibtex_raw' | 'is_shared' | 'tags'>>,
  ): Promise<Paper> {
    return apiFetch<Paper>(`/api/papers/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
  },

  async reextractPaper(id: string): Promise<Paper> {
    return apiFetch<Paper>(`/api/papers/${id}/reextract`, { method: 'POST' });
  },

  async deletePaper(id: string): Promise<void> {
    return apiFetch<void>(`/api/papers/${id}`, { method: 'DELETE' });
  },

  async exportBibtex(): Promise<string> {
    return apiFetch<string>('/api/papers/bibtex');
  },

  paperFileUrl(id: string): string {
    const token = getStoredToken();
    return token ? `/api/papers/${id}/file?token=${encodeURIComponent(token)}` : `/api/papers/${id}/file`;
  },

  async listProjects(): Promise<ProjectConfig[]> {
    return apiFetch<ProjectConfig[]>('/api/projects');
  },

  async createProject(input: {
    name: string;
    overleaf_remote?: string;
    link_all_papers?: boolean;
  }): Promise<ProjectConfig> {
    return apiFetch<ProjectConfig>('/api/projects', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  async updateProject(
    id: string,
    patch: {
      name?: string;
      overleaf_remote?: string;
      overleaf_token?: string;
      linked_paper_ids?: string[];
      link_all_papers?: boolean;
    },
  ): Promise<ProjectConfig> {
    return apiFetch<ProjectConfig>(`/api/projects/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
  },

  async getProjectTree(id: string): Promise<{ project: ProjectConfig; files: ProjectTreeEntry[] }> {
    return apiFetch<{ project: ProjectConfig; files: ProjectTreeEntry[] }>(`/api/projects/${id}/tree`);
  },

  async readProjectFile(id: string, filePath: string): Promise<ProjectFilePayload> {
    return apiFetch<ProjectFilePayload>(
      `/api/projects/${id}/file?path=${encodeURIComponent(filePath)}`,
    );
  },

  async writeProjectFile(
    id: string,
    filePath: string,
    content: string,
    isBase64 = false,
  ): Promise<{ path: string; bytes: number; head_content: string }> {
    return apiFetch<{ path: string; bytes: number; head_content: string }>(
      `/api/projects/${id}/file`,
      {
        method: 'PUT',
        body: JSON.stringify({ path: filePath, content, is_base64: isBase64 }),
      },
    );
  },

  async revertProjectFile(id: string, filePath: string): Promise<ProjectFilePayload> {
    return apiFetch<ProjectFilePayload>(`/api/projects/${id}/revert`, {
      method: 'POST',
      body: JSON.stringify({ path: filePath }),
    });
  },

  async pullProject(id: string): Promise<ProjectPullResponse> {
    return apiFetch<ProjectPullResponse>(`/api/projects/${id}/pull`, {
      method: 'POST',
    });
  },

  async syncProject(id: string, commitMessage?: string): Promise<ProjectSyncResponse> {
    return apiFetch<ProjectSyncResponse>(`/api/projects/${id}/sync`, {
      method: 'POST',
      body: JSON.stringify({ commit_message: commitMessage || '' }),
    });
  },

  async compileProject(id: string, target?: string): Promise<CompileProjectResponse> {
    return apiFetch<CompileProjectResponse>(`/api/projects/${id}/compile`, {
      method: 'POST',
      body: JSON.stringify({ target: target || '' }),
    });
  },

  async searchProject(id: string, query: string): Promise<SearchMatchItem[]> {
    const res = await apiFetch<{ results: SearchMatchItem[] }>(
      `/api/projects/${id}/search?q=${encodeURIComponent(query)}`,
    );
    return res.results || [];
  },

  compiledPdfUrl(id: string, target?: string, version?: number): string {
    const params = new URLSearchParams();
    const token = getStoredToken();
    if (token) {
      params.set('token', token);
    }
    if (target) {
      params.set('target', target);
    }
    if (version !== undefined) {
      params.set('v', String(version));
    }
    return `/api/projects/${id}/compiled.pdf?${params.toString()}`;
  },

  async flushOutbox(): Promise<number> {
    const queue = getOutboxQueue();
    if (queue.length === 0) {
      return 0;
    }
    let flushed = 0;
    for (const item of queue) {
      if (item.kind === 'project_file' && item.projectId && item.path && item.content !== undefined) {
        await this.writeProjectFile(item.projectId, item.path, item.content, false);
        flushed++;
      } else if (item.kind === 'paper_patch' && item.paperPatch) {
        await apiFetch('/api/library/sync', {
          method: 'POST',
          body: JSON.stringify({ papers: [item.paperPatch], highlights: [] }),
        });
        flushed++;
      }
    }
    clearOutboxQueue();
    return flushed;
  },

  async listDocs(docType?: DocumentItem['doc_type']): Promise<DocumentItem[]> {
    const query = docType ? `?doc_type=${encodeURIComponent(docType)}` : '';
    return apiFetch<DocumentItem[]>(`/api/docs${query}`);
  },

  async createDoc(input: {
    id?: string;
    doc_type: DocumentItem['doc_type'];
    title: string;
    content: string;
    is_shared?: boolean;
  }): Promise<DocumentItem> {
    return apiFetch<DocumentItem>('/api/docs', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  async updateDoc(
    id: string,
    patch: Partial<Pick<DocumentItem, 'title' | 'content' | 'is_shared'>>,
  ): Promise<DocumentItem> {
    return apiFetch<DocumentItem>(`/api/docs/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
  },

  async deleteDoc(id: string): Promise<void> {
    return apiFetch<void>(`/api/docs/${id}`, { method: 'DELETE' });
  },
};
