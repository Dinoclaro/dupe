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

const TOKEN_STORAGE_KEY = 'dupe_jwt_token';

export function getStoredToken(): string | null {
  return localStorage.getItem(TOKEN_STORAGE_KEY);
}

export function setStoredToken(token: string | null): void {
  if (token) {
    localStorage.setItem(TOKEN_STORAGE_KEY, token);
  } else {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
  }
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

  async listRepos(): Promise<GitRepo[]> {
    return apiFetch<GitRepo[]>('/api/repos');
  },

  async createRepo(input: {
    name: string;
    remote_url: string;
    bib_file_path?: string;
    figures_dir?: string;
  }): Promise<GitRepo> {
    return apiFetch<GitRepo>('/api/repos', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  async syncRepo(id: string, commitMessage?: string): Promise<SyncRepoResult> {
    return apiFetch<SyncRepoResult>(`/api/repos/${id}/sync`, {
      method: 'POST',
      body: JSON.stringify({ commit_message: commitMessage || '' }),
    });
  },

  async listRepoFiles(id: string): Promise<string[]> {
    const res = await apiFetch<{ files: string[] }>(`/api/repos/${id}/files`);
    return res.files;
  },

  async readRepoFile(id: string, filePath: string): Promise<{ path: string; content: string }> {
    return apiFetch<{ path: string; content: string }>(
      `/api/repos/${id}/file?path=${encodeURIComponent(filePath)}`,
    );
  },

  async writeRepoFile(
    id: string,
    filePath: string,
    content: string,
    isBase64 = false,
  ): Promise<{ path: string; bytes: number }> {
    return apiFetch<{ path: string; bytes: number }>(`/api/repos/${id}/file`, {
      method: 'PUT',
      body: JSON.stringify({ path: filePath, content, is_base64: isBase64 }),
    });
  },

  async deleteRepo(id: string): Promise<void> {
    return apiFetch<void>(`/api/repos/${id}`, { method: 'DELETE' });
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
