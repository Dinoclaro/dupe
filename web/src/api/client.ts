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
  doc_type: 'markdown' | 'latex' | 'typst';
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
  code_remote?: string;
  linked_paper_ids: string[];
  link_all_papers: boolean;
  pending_push: boolean;
  last_synced_at?: string;
  updated_at: string;
}

export interface ProjectTreeEntry {
  path: string;
  kind: 'tex' | 'bib' | 'markdown' | 'asset' | 'json' | 'other';
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

export interface ProjectContextResponse {
  comments_md: string;
  agents_md: string;
  open_count: number;
  addressed_count: number;
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
  context?: string;
  source?: 'latex' | 'bibtex' | 'compiler' | 'client';
  category?: 'syntax' | 'reference' | 'package' | 'typography' | 'system';
}

export interface CompileProjectResponse {
  success: boolean;
  failure_kind?: 'none' | 'latex_code' | 'compiler';
  root_tex: string;
  pdf_available: boolean;
  duration_ms: number;
  errors: LatexDiagnostic[];
  warnings: LatexDiagnostic[];
  raw_log: string;
}

export interface CompiledPdfMeta {
  available: boolean;
  root_tex: string;
  version?: number;
  size_bytes?: number;
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
  activeProjectId?: string;
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
    const nextFileBuffers = { ...(current.fileBuffers || {}) };
    if (patch.fileBuffers) {
      for (const [k, v] of Object.entries(patch.fileBuffers)) {
        // Never allow a shorter stub to overwrite a longer note in snapshot cache
        const existing = nextFileBuffers[k];
        if (
          k.startsWith('notes/') &&
          existing &&
          existing.trim().length > 25 &&
          v.trim().length <= 30 &&
          !v.trim().includes('\n')
        ) {
          continue;
        }
        nextFileBuffers[k] = v;
      }
    }
    const merged: CachedWorkspaceSnapshot = {
      ...current,
      ...patch,
      fileBuffers: nextFileBuffers,
    };
    storageSet(SNAPSHOT_STORAGE_KEY, JSON.stringify(merged));
  } catch {
    // ignore storage quota errors
  }
}

export function resolveActiveProjectId(
  projects: ProjectConfig[],
  preferredId?: string | null,
): string | null {
  if (projects.length === 0) {
    return null;
  }
  const candidate = preferredId ?? loadWorkspaceSnapshot().activeProjectId;
  if (candidate && projects.some((p) => p.id === candidate)) {
    return candidate;
  }
  return projects[0].id;
}

const LOCAL_NOTES_VAULT_KEY = 'dupe_local_notes_v1';
const LOCAL_NOTES_BACKUP_KEY = 'dupe_local_notes_backups_v1';

export interface LocalNoteEntry {
  path: string;
  content: string;
  syncedContent: string | null;
  dirty: boolean;
  updatedAt: string;
}

export function loadLocalNotesVault(): Record<string, LocalNoteEntry> {
  let vault: Record<string, LocalNoteEntry> = {};
  try {
    const raw = storageGet(LOCAL_NOTES_VAULT_KEY);
    if (raw) {
      vault = JSON.parse(raw) as Record<string, LocalNoteEntry>;
    }
  } catch {
    vault = {};
  }

  // Rescue/migrate any notes/* from dupe_workspace_snapshot_v1.fileBuffers
  const snap = loadWorkspaceSnapshot();
  let migrated = false;
  if (snap.fileBuffers) {
    for (const [path, text] of Object.entries(snap.fileBuffers)) {
      if (!path.startsWith('notes/') || typeof text !== 'string' || !text.trim()) {
        continue;
      }
      const existing = vault[path];
      if (!existing || text.trim().length > existing.content.trim().length) {
        vault[path] = {
          path,
          content: text,
          syncedContent: existing?.syncedContent ?? null,
          dirty: true,
          updatedAt: new Date().toISOString(),
        };
        migrated = true;
      }
    }
  }
  if (migrated) {
    try {
      storageSet(LOCAL_NOTES_VAULT_KEY, JSON.stringify(vault));
    } catch {
      // ignore
    }
  }
  return vault;
}

function recordLocalNoteBackup(path: string, oldContent: string): void {
  if (!oldContent || oldContent.trim().length <= 20) {
    return;
  }
  try {
    const raw = storageGet(LOCAL_NOTES_BACKUP_KEY);
    const list: Array<{ path: string; content: string; savedAt: string }> = raw
      ? JSON.parse(raw)
      : [];
    const lastForPath = [...list].reverse().find((b) => b.path === path);
    if (lastForPath && lastForPath.content === oldContent) {
      return;
    }
    const next = [
      ...list.slice(-39),
      { path, content: oldContent, savedAt: new Date().toISOString() },
    ];
    storageSet(LOCAL_NOTES_BACKUP_KEY, JSON.stringify(next));
  } catch {
    // ignore quota errors
  }
}

export function saveLocalNote(
  path: string,
  content: string,
  dirty = true,
  syncedContent?: string | null,
): LocalNoteEntry {
  const vault = loadLocalNotesVault();
  const prev = vault[path];
  if (prev && prev.content !== content) {
    recordLocalNoteBackup(path, prev.content);
  }
  const entry: LocalNoteEntry = {
    path,
    content,
    syncedContent:
      syncedContent !== undefined ? syncedContent : (prev?.syncedContent ?? null),
    dirty,
    updatedAt: new Date().toISOString(),
  };
  vault[path] = entry;
  try {
    storageSet(LOCAL_NOTES_VAULT_KEY, JSON.stringify(vault));
  } catch {
    // ignore
  }
  saveWorkspaceSnapshot({ fileBuffers: { [path]: content } });
  return entry;
}

export function markLocalNoteSynced(path: string, syncedContent: string): void {
  const vault = loadLocalNotesVault();
  const prev = vault[path];
  const currentContent = prev ? prev.content : syncedContent;
  vault[path] = {
    path,
    content: currentContent,
    syncedContent,
    dirty: currentContent !== syncedContent,
    updatedAt: prev?.updatedAt || new Date().toISOString(),
  };
  try {
    storageSet(LOCAL_NOTES_VAULT_KEY, JSON.stringify(vault));
  } catch {
    // ignore
  }
}

export function deleteLocalNote(pathPrefix: string): void {
  const vault = loadLocalNotesVault();
  for (const k of Object.keys(vault)) {
    if (k === pathPrefix || k.startsWith(pathPrefix + '/')) {
      delete vault[k];
    }
  }
  try {
    storageSet(LOCAL_NOTES_VAULT_KEY, JSON.stringify(vault));
  } catch {
    // ignore
  }
}

export function renameLocalNote(oldPath: string, newPath: string): void {
  const vault = loadLocalNotesVault();
  for (const [k, entry] of Object.entries(vault)) {
    if (k === oldPath) {
      delete vault[k];
      vault[newPath] = { ...entry, path: newPath };
    } else if (k.startsWith(oldPath + '/')) {
      const target = newPath + k.slice(oldPath.length);
      delete vault[k];
      vault[target] = { ...entry, path: target };
    }
  }
  try {
    storageSet(LOCAL_NOTES_VAULT_KEY, JSON.stringify(vault));
  } catch {
    // ignore
  }
}

export function resolveNoteWithLocalWins(
  path: string,
  serverContent: string,
): {
  content: string;
  shouldPushToServer: boolean;
  serverBackupContent?: string;
  hasConflict?: boolean;
} {
  const vault = loadLocalNotesVault();
  const local = vault[path];

  if (!local || !local.content.trim()) {
    saveLocalNote(path, serverContent, false, serverContent);
    return { content: serverContent, shouldPushToServer: false };
  }

  if (local.content === serverContent) {
    markLocalNoteSynced(path, serverContent);
    return { content: serverContent, shouldPushToServer: false };
  }

  const serverLen = serverContent.trim().length;
  const serverIsBareStub =
    serverLen <= 30 && !serverContent.trim().includes('\n');

  // If the server only has a bare 1-line stub, keep local and push to server.
  if (serverIsBareStub) {
    return {
      content: local.content,
      shouldPushToServer: true,
      serverBackupContent: serverLen > 0 ? serverContent : undefined,
    };
  }

  // If local has unsynced edits (dirty === true):
  if (local.dirty) {
    // If the server file also changed independently since our last sync, do NOT silently overwrite
    // the server — surface a conflict diff so the user can review both versions!
    if (local.syncedContent && local.syncedContent.trim() !== '' && serverContent !== local.syncedContent) {
      recordLocalNoteBackup(path, serverContent);
      return {
        content: local.content,
        shouldPushToServer: false,
        serverBackupContent: serverContent,
        hasConflict: true,
      };
    }
    return {
      content: local.content,
      shouldPushToServer: true,
      serverBackupContent: serverLen > 0 ? serverContent : undefined,
    };
  }

  // Local was already synced (dirty === false) and the server file changed (e.g. via VS Code or + Comment):
  // back up the previous local copy and accept the new server version without overwriting it!
  recordLocalNoteBackup(path, local.content);
  saveLocalNote(path, serverContent, false, serverContent);
  return { content: serverContent, shouldPushToServer: false };
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

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function apiFetch<T>(
  path: string,
  init: RequestInit = {},
  timeoutMs?: number,
): Promise<T> {
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

  const effectiveTimeout =
    timeoutMs ??
    (path.endsWith('/compile') ||
    path.endsWith('/pull') ||
    path.endsWith('/sync') ||
    path.endsWith('/upload')
      ? 90000
      : 15000);

  const controller = new AbortController();
  const externalSignal = init.signal;
  if (externalSignal?.aborted) {
    controller.abort();
  } else if (externalSignal) {
    externalSignal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  const timer = setTimeout(() => controller.abort(), effectiveTimeout);

  let response: Response;
  try {
    response = await fetch(path, { ...init, headers, signal: controller.signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error(`Request timed out after ${Math.round(effectiveTimeout / 1000)}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (response.status === 204) {
    return undefined as T;
  }

  const contentType = response.headers.get('Content-Type') || '';
  if (!response.ok) {
    let errMsg = `Request failed (${response.status})`;
    if (contentType.includes('application/json')) {
      const errPayload = (await response.json()) as { error?: string };
      errMsg = errPayload.error || errMsg;
    }
    if (response.status === 401 && path !== '/api/auth/login') {
      setStoredToken(null);
      if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
        window.dispatchEvent(new CustomEvent('dupe:unauthorized', { detail: errMsg }));
      }
    }
    throw new ApiError(errMsg, response.status);
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
    code_remote?: string;
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
      code_remote?: string;
      linked_paper_ids?: string[];
      link_all_papers?: boolean;
    },
  ): Promise<ProjectConfig> {
    return apiFetch<ProjectConfig>(`/api/projects/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
  },

  async getProjectTree(id: string): Promise<{
    project: ProjectConfig;
    files: ProjectTreeEntry[];
    cited_keys?: string[];
    compiled_pdf?: CompiledPdfMeta;
    code_target?: string;
  }> {
    return apiFetch<{
      project: ProjectConfig;
      files: ProjectTreeEntry[];
      cited_keys?: string[];
      compiled_pdf?: CompiledPdfMeta;
      code_target?: string;
    }>(`/api/projects/${id}/tree`);
  },

  async deleteProjectFile(id: string, filePath: string): Promise<void> {
    return apiFetch<void>(`/api/projects/${id}/file?path=${encodeURIComponent(filePath)}`, {
      method: 'DELETE',
    });
  },

  async renameProjectFile(
    id: string,
    oldPath: string,
    newPath: string,
  ): Promise<{ old_path: string; new_path: string }> {
    return apiFetch<{ old_path: string; new_path: string }>(`/api/projects/${id}/rename`, {
      method: 'POST',
      body: JSON.stringify({ old_path: oldPath, new_path: newPath }),
    });
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

  async addProjectComment(
    id: string,
    input: { source: string; location: string; quote: string; comment: string },
  ): Promise<ProjectContextResponse> {
    return apiFetch<ProjectContextResponse>(`/api/projects/${id}/comments`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  async gatherProjectContext(id: string): Promise<ProjectContextResponse> {
    return apiFetch<ProjectContextResponse>(`/api/projects/${id}/context`, {
      method: 'POST',
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

  async resolveSyncTex(
    id: string,
    page: number,
    x: number,
    y: number,
    target?: string,
    pageWidthPt?: number,
    pageHeightPt?: number,
  ): Promise<{ path: string; line: number; page: number }> {
    const params = new URLSearchParams({
      page: String(page),
      x: x.toFixed(4),
      y: y.toFixed(4),
    });
    if (target) {
      params.set('target', target);
    }
    if (pageWidthPt && pageWidthPt > 0) {
      params.set('w', pageWidthPt.toFixed(2));
    }
    if (pageHeightPt && pageHeightPt > 0) {
      params.set('h', pageHeightPt.toFixed(2));
    }
    return apiFetch<{ path: string; line: number; page: number }>(
      `/api/projects/${id}/synctex?${params.toString()}`,
    );
  },

  async resolveSyncTexForward(
    id: string,
    file: string,
    line: number,
    target?: string,
    pageWidthPt?: number,
    pageHeightPt?: number,
  ): Promise<{ page: number; x: number; y: number }> {
    const params = new URLSearchParams({
      file,
      line: String(line),
    });
    if (target) {
      params.set('target', target);
    }
    if (pageWidthPt && pageWidthPt > 0) {
      params.set('w', pageWidthPt.toFixed(2));
    }
    if (pageHeightPt && pageHeightPt > 0) {
      params.set('h', pageHeightPt.toFixed(2));
    }
    return apiFetch<{ page: number; x: number; y: number }>(
      `/api/projects/${id}/synctex-forward?${params.toString()}`,
    );
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

  projectAssetUrl(id: string, filePath: string): string {
    const params = new URLSearchParams({ path: filePath });
    const token = getStoredToken();
    if (token) {
      params.set('token', token);
    }
    return `/api/projects/${id}/asset?${params.toString()}`;
  },

  async flushOutbox(): Promise<number> {
    const queue = getOutboxQueue();
    if (queue.length === 0) {
      return 0;
    }
    let flushed = 0;
    for (const item of queue) {
      if (item.kind === 'project_file' && item.projectId && item.path && item.content !== undefined) {
        if (
          (item.path.endsWith('.tex') || item.path.endsWith('.bib')) &&
          item.content.trim().length === 0
        ) {
          continue;
        }
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
