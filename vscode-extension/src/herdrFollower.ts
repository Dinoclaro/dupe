import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface HerdrSpaceSummary {
  id: string;
  name: string;
  folder: string | null;
  active: boolean;
  tabs?: Array<{
    id: string;
    name: string;
    active: boolean;
    terminals?: Array<{
      terminal: string;
      pane: string;
      status?: string | null;
      app?: string | null;
    }>;
  }>;
}

export interface WorkspaceFolderLike {
  name: string;
  fsPath: string;
}

export function resolveHerdrStateDir(homeDir = os.homedir(), env = process.env): string {
  const candidates = [
    env.HERDR_APP_HOME?.trim(),
    path.join(homeDir, '.config', 'herdr-app'),
    path.join(homeDir, 'Library', 'Application Support', 'herdr-app'),
  ].filter((p): p is string => Boolean(p));

  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'view.json'))) {
      return dir;
    }
  }
  return candidates[0] || path.join(homeDir, '.config', 'herdr-app');
}

export function readActiveHerdrSpaceId(viewJsonPath: string): string | null {
  try {
    const raw = fs.readFileSync(viewJsonPath, 'utf8');
    const parsed = JSON.parse(raw) as { active?: unknown };
    return typeof parsed.active === 'string' && parsed.active.trim() ? parsed.active.trim() : null;
  } catch {
    return null;
  }
}

export function resolveHerdrAppBinary(homeDir = os.homedir()): string {
  const candidates = [
    'herdr-app',
    path.join(homeDir, '.local', 'bin', 'herdr-app'),
    '/opt/homebrew/bin/herdr-app',
    '/usr/local/bin/herdr-app',
    '/Applications/Herdr.app/Contents/MacOS/herdr-app',
  ];
  for (const cand of candidates) {
    if (cand === 'herdr-app') {
      continue;
    }
    if (fs.existsSync(cand)) {
      return cand;
    }
  }
  return 'herdr-app';
}

function defaultRealpath(targetPath: string): string {
  try {
    return fs.realpathSync(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

function defaultLinkedSubdirs(workspaceRoot: string): string[] {
  const results: string[] = [];
  for (const parentName of ['code', 'paper']) {
    const parentDir = path.join(workspaceRoot, parentName);
    try {
      const entries = fs.readdirSync(parentDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isSymbolicLink() && !entry.isDirectory()) {
          continue;
        }
        results.push(defaultRealpath(path.join(parentDir, entry.name)));
      }
    } catch {
      // ignore missing code/ or paper/ directory
    }
  }
  return results;
}

export function matchWorkspaceFolderForSpace<T extends WorkspaceFolderLike>(
  space: Pick<HerdrSpaceSummary, 'id' | 'name' | 'folder'>,
  folders: readonly T[],
  realpathFn: (p: string) => string = defaultRealpath,
  linkedTargetsFn: (root: string) => string[] = defaultLinkedSubdirs,
): T | null {
  if (folders.length === 0) {
    return null;
  }
  const spaceFolder = space.folder?.trim();
  if (spaceFolder) {
    const resolvedSpace = realpathFn(spaceFolder);

    // 1. Exact workspace root match
    for (const folder of folders) {
      if (realpathFn(folder.fsPath) === resolvedSpace) {
        return folder;
      }
    }

    // 2. Space folder lives inside a workspace folder
    let bestContainment: T | null = null;
    let bestDepth = -1;
    for (const folder of folders) {
      const resolvedRoot = realpathFn(folder.fsPath);
      if (resolvedSpace.startsWith(resolvedRoot + path.sep) && resolvedRoot.length > bestDepth) {
        bestContainment = folder;
        bestDepth = resolvedRoot.length;
      }
    }
    if (bestContainment) {
      return bestContainment;
    }

    // 3. Space folder matches or sits inside a symlinked code/ or paper/ repo of a dupe project
    for (const folder of folders) {
      const targets = linkedTargetsFn(folder.fsPath);
      for (const target of targets) {
        if (resolvedSpace === target || resolvedSpace.startsWith(target + path.sep)) {
          return folder;
        }
      }
    }
  }

  // 4. Fallback: space name matches workspace folder name cleanly (case-insensitive)
  const cleanName = space.name.trim().toLowerCase();
  if (cleanName) {
    for (const folder of folders) {
      const base = path.basename(folder.fsPath).toLowerCase();
      if (folder.name.toLowerCase() === cleanName || base === cleanName) {
        return folder;
      }
    }
  }
  return null;
}

export function pickRevealAnchorPath(folderPath: string): string {
  for (const preferred of ['AGENTS.md', 'notes', 'paper', 'code', 'diagrams']) {
    const candidate = path.join(folderPath, preferred);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  try {
    const first = fs.readdirSync(folderPath).find((n) => !n.startsWith('.'));
    if (first) {
      return path.join(folderPath, first);
    }
  } catch {
    // ignore read error
  }
  return folderPath;
}

export async function listHerdrSpaces(): Promise<HerdrSpaceSummary[]> {
  const bin = resolveHerdrAppBinary();
  const { stdout } = await execFileAsync(bin, ['ls'], { timeout: 2500 });
  const parsed = JSON.parse(stdout) as { spaces?: HerdrSpaceSummary[] };
  return Array.isArray(parsed.spaces) ? parsed.spaces : [];
}

export class HerdrSpaceWatcher {
  private readonly stateDir: string;
  private readonly viewJsonPath: string;
  private watcher: fs.FSWatcher | null = null;
  private fallbackTimer: ReturnType<typeof setInterval> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSpaceId: string | null = null;
  private lastMtimeMs = 0;
  private disposed = false;

  constructor(private readonly onActiveSpaceChanged: (space: HerdrSpaceSummary) => void | Promise<void>) {
    this.stateDir = resolveHerdrStateDir();
    this.viewJsonPath = path.join(this.stateDir, 'view.json');
  }

  start(): void {
    if (this.disposed) {
      return;
    }
    try {
      if (fs.existsSync(this.stateDir)) {
        this.watcher = fs.watch(this.stateDir, (_eventType, filename) => {
          if (!filename || filename === 'view.json') {
            this.scheduleCheck();
          }
        });
      }
    } catch {
      // fall back to lightweight stat polling below
    }

    this.fallbackTimer = setInterval(() => {
      try {
        const st = fs.statSync(this.viewJsonPath);
        if (st.mtimeMs !== this.lastMtimeMs) {
          this.scheduleCheck();
        }
      } catch {
        // herdr-app not running yet
      }
    }, 2000);

    void this.checkNow(false);
  }

  async checkNow(forceEmit: boolean): Promise<HerdrSpaceSummary | null> {
    if (this.disposed) {
      return null;
    }
    try {
      const st = fs.statSync(this.viewJsonPath);
      this.lastMtimeMs = st.mtimeMs;
    } catch {
      return null;
    }

    const activeId = readActiveHerdrSpaceId(this.viewJsonPath);
    if (!forceEmit && activeId && activeId === this.lastSpaceId) {
      return null;
    }

    try {
      const spaces = await listHerdrSpaces();
      const activeSpace =
        spaces.find((s) => s.active) ||
        (activeId ? spaces.find((s) => s.id === activeId) : undefined) ||
        null;
      if (!activeSpace) {
        return null;
      }
      if (!forceEmit && activeSpace.id === this.lastSpaceId) {
        return activeSpace;
      }
      this.lastSpaceId = activeSpace.id;
      await this.onActiveSpaceChanged(activeSpace);
      return activeSpace;
    } catch {
      return null;
    }
  }

  private scheduleCheck(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      void this.checkNow(false);
    }, 100);
  }

  dispose(): void {
    this.disposed = true;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.fallbackTimer) {
      clearInterval(this.fallbackTimer);
      this.fallbackTimer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }
}
