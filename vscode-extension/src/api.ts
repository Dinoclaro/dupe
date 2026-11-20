import fs from 'node:fs/promises';
import path from 'node:path';
import * as vscode from 'vscode';
import {
  CompileProjectResponse,
  LocalBrowseDir,
  LocalStatus,
  Paper,
  ProjectConfig,
  ProjectTreeResponse,
  PullProjectResponse,
  RemoteSyncStatus,
  SyncProjectResponse,
} from './types';

export class DupeApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'DupeApiError';
  }
}

export class DupeApiClient {
  getBaseUrl(): string {
    const raw = vscode.workspace.getConfiguration('dupe').get<string>('serverUrl') || 'http://127.0.0.1:8080';
    return raw.trim().replace(/\/+$/, '');
  }

  private getHeaders(extra?: Record<string, string>): Record<string, string> {
    const token = (vscode.workspace.getConfiguration('dupe').get<string>('authToken') || '').trim();
    const headers: Record<string, string> = { ...(extra || {}) };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    return headers;
  }

  private async requestJson<T>(method: string, route: string, body?: unknown): Promise<T> {
    const url = `${this.getBaseUrl()}${route}`;
    const headers = this.getHeaders(body !== undefined ? { 'Content-Type': 'application/json' } : undefined);
    const res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!res.ok) {
      const errMsg =
        parsed && typeof parsed === 'object' && 'error' in parsed && typeof (parsed as { error: unknown }).error === 'string'
          ? (parsed as { error: string }).error
          : text || `HTTP ${res.status}`;
      throw new DupeApiError(res.status, errMsg);
    }
    return parsed as T;
  }

  private async requestBytes(route: string): Promise<Uint8Array> {
    const url = `${this.getBaseUrl()}${route}`;
    const res = await fetch(url, { headers: this.getHeaders() });
    if (!res.ok) {
      const text = await res.text();
      throw new DupeApiError(res.status, text || `HTTP ${res.status}`);
    }
    const buf = await res.arrayBuffer();
    return new Uint8Array(buf);
  }

  health(): Promise<{ status: string; mode?: string; projects_dir?: string }> {
    return this.requestJson('GET', '/api/health');
  }

  getLocalStatus(): Promise<LocalStatus> {
    return this.requestJson('GET', '/api/local/status');
  }

  browseLocalDir(dirPath?: string): Promise<{ current_path: string; parent_path: string; home_dir: string; dirs: LocalBrowseDir[] }> {
    const q = dirPath ? `?path=${encodeURIComponent(dirPath)}` : '';
    return this.requestJson('GET', `/api/local/browse${q}`);
  }

  setLocalProjectsRoot(projectsDir: string): Promise<LocalStatus> {
    return this.requestJson('POST', '/api/local/projects-root', { projects_dir: projectsDir });
  }

  linkLocalFolder(payload: {
    mode: 'symlink_paper' | 'symlink_code';
    source_path: string;
    target_project_id?: string;
    project_name?: string;
  }): Promise<{ project: ProjectConfig; linked_path: string; source_path: string; mode: string }> {
    return this.requestJson('POST', '/api/local/link-folder', payload);
  }

  listPapers(): Promise<Paper[]> {
    return this.requestJson('GET', '/api/papers');
  }

  async uploadPdfs(filePaths: string[]): Promise<Paper[]> {
    const form = new FormData();
    for (const filePath of filePaths) {
      const bytes = await fs.readFile(filePath);
      const blob = new Blob([bytes], { type: 'application/pdf' });
      form.append('files', blob, path.basename(filePath));
    }
    const url = `${this.getBaseUrl()}/api/papers/upload`;
    const res = await fetch(url, {
      method: 'POST',
      headers: this.getHeaders(),
      body: form,
    });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!res.ok) {
      const errMsg =
        parsed && typeof parsed === 'object' && 'error' in parsed && typeof (parsed as { error: unknown }).error === 'string'
          ? (parsed as { error: string }).error
          : text || `HTTP ${res.status}`;
      throw new DupeApiError(res.status, errMsg);
    }
    if (parsed && typeof parsed === 'object' && 'papers' in parsed && Array.isArray((parsed as { papers: Paper[] }).papers)) {
      return (parsed as { papers: Paper[] }).papers;
    }
    if (parsed && typeof parsed === 'object' && 'id' in parsed) {
      return [parsed as Paper];
    }
    return [];
  }

  deletePaper(paperId: string): Promise<void> {
    return this.requestJson('DELETE', `/api/papers/${encodeURIComponent(paperId)}`);
  }

  getPaperPdfBytes(paperId: string): Promise<Uint8Array> {
    return this.requestBytes(`/api/papers/${encodeURIComponent(paperId)}/file`);
  }

  getRemoteSyncStatus(): Promise<RemoteSyncStatus> {
    return this.requestJson('GET', '/api/library/remote-sync');
  }

  triggerRemoteSync(): Promise<{ pulled_papers: number; pushed_papers: number; remote_url: string; synced_at: string }> {
    return this.requestJson('POST', '/api/library/remote-sync', {});
  }

  listProjects(): Promise<ProjectConfig[]> {
    return this.requestJson('GET', '/api/projects');
  }

  createProject(payload: {
    name: string;
    overleaf_remote?: string;
    overleaf_token?: string;
    code_remote?: string;
    link_all_papers?: boolean;
  }): Promise<ProjectConfig> {
    return this.requestJson('POST', '/api/projects', payload);
  }

  updateProject(
    projectId: string,
    payload: Partial<{
      name: string;
      overleaf_remote: string;
      overleaf_token: string;
      code_remote: string;
      linked_paper_ids: string[];
      link_all_papers: boolean;
    }>,
  ): Promise<ProjectConfig> {
    return this.requestJson('PATCH', `/api/projects/${encodeURIComponent(projectId)}`, payload);
  }

  getProjectTree(projectId: string): Promise<ProjectTreeResponse> {
    return this.requestJson('GET', `/api/projects/${encodeURIComponent(projectId)}/tree`);
  }

  pullProject(projectId: string): Promise<PullProjectResponse> {
    return this.requestJson('POST', `/api/projects/${encodeURIComponent(projectId)}/pull`, {});
  }

  syncProject(projectId: string, commitMessage?: string): Promise<SyncProjectResponse> {
    return this.requestJson('POST', `/api/projects/${encodeURIComponent(projectId)}/sync`, {
      commit_message: commitMessage || '',
    });
  }

  compileProject(projectId: string, target?: string): Promise<CompileProjectResponse> {
    return this.requestJson('POST', `/api/projects/${encodeURIComponent(projectId)}/compile`, {
      target: target || '',
    });
  }

  getCompiledPdfBytes(projectId: string): Promise<Uint8Array> {
    return this.requestBytes(`/api/projects/${encodeURIComponent(projectId)}/compiled.pdf`);
  }

  gatherProjectContext(projectId: string): Promise<{ open_count: number; addressed_count: number }> {
    return this.requestJson('POST', `/api/projects/${encodeURIComponent(projectId)}/context`, {});
  }
}
