import fs from 'node:fs';
import path from 'node:path';
import { LocalRefIndexEntry, ProjectConfig } from './types';

export interface DiscoveredProject {
  rootDir: string;
  config: ProjectConfig;
}

export function findDupeProjectRoot(startDir: string): string | null {
  let current = path.resolve(startDir);
  while (true) {
    const cfgPath = path.join(current, '.dupe', 'project.json');
    if (fs.existsSync(cfgPath)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

export function readLocalProjectConfig(projectRoot: string): ProjectConfig | null {
  try {
    const raw = fs.readFileSync(path.join(projectRoot, '.dupe', 'project.json'), 'utf8');
    const parsed = JSON.parse(raw) as ProjectConfig;
    parsed.folder_name = path.basename(projectRoot);
    if (!Array.isArray(parsed.linked_paper_ids)) {
      parsed.linked_paper_ids = [];
    }
    return parsed;
  } catch {
    return null;
  }
}

export function discoverProjectsInWorkspace(workspaceRoots: string[]): DiscoveredProject[] {
  const seenRoots = new Set<string>();
  const discovered: DiscoveredProject[] = [];

  for (const ws of workspaceRoots) {
    const root = findDupeProjectRoot(ws);
    if (root && !seenRoots.has(root)) {
      const cfg = readLocalProjectConfig(root);
      if (cfg) {
        seenRoots.add(root);
        discovered.push({ rootDir: root, config: cfg });
      }
      continue;
    }

    // Also inspect immediate child directories when user opened the parent projects root
    try {
      const entries = fs.readdirSync(ws, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) {
          continue;
        }
        const candidate = path.join(ws, entry.name);
        if (seenRoots.has(candidate)) {
          continue;
        }
        const cfg = readLocalProjectConfig(candidate);
        if (cfg) {
          seenRoots.add(candidate);
          discovered.push({ rootDir: candidate, config: cfg });
        }
      }
    } catch {
      // ignore unreadable directories
    }
  }

  return discovered;
}

export function readLocalRefsIndex(projectRoot: string): LocalRefIndexEntry[] {
  try {
    const raw = fs.readFileSync(path.join(projectRoot, 'refs', 'index.json'), 'utf8');
    const parsed = JSON.parse(raw) as LocalRefIndexEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
