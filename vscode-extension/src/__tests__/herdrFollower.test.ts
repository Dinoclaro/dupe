import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  matchWorkspaceFolderForSpace,
  pickRevealAnchorPath,
  readActiveHerdrSpaceId,
} from '../herdrFollower';

describe('herdrFollower helpers', () => {
  it('matches exact folder, symlinked code repo, containment, and space name fallback', () => {
    const folders = [
      { name: 'mimic', fsPath: '/home/dino/dupe_mimic/mimic' },
      { name: 'ra-l_pele_offline_mbrl', fsPath: '/home/dino/dupe_pele/ra-l_pele_offline_mbrl' },
      { name: 'dupe-dev', fsPath: '/home/dino/dupe_mimic/dupe-dev' },
    ];

    const linkedMap: Record<string, string[]> = {
      '/home/dino/dupe_mimic/dupe-dev': ['/home/dino/dupe'],
      '/home/dino/dupe_mimic/mimic': ['/home/dino/mimic_src'],
    };

    const exact = matchWorkspaceFolderForSpace(
      { id: 'sp1', name: 'dupe_pele', folder: '/home/dino/dupe_pele/ra-l_pele_offline_mbrl' },
      folders,
      (p) => p,
      (r) => linkedMap[r] || [],
    );
    expect(exact?.name).toBe('ra-l_pele_offline_mbrl');

    const viaSymlink = matchWorkspaceFolderForSpace(
      { id: 'sp2', name: 'dupe-code', folder: '/home/dino/dupe/backend' },
      folders,
      (p) => p,
      (r) => linkedMap[r] || [],
    );
    expect(viaSymlink?.name).toBe('dupe-dev');

    const viaContainment = matchWorkspaceFolderForSpace(
      { id: 'sp3', name: 'mimic', folder: '/home/dino/dupe_mimic/mimic/notes' },
      folders,
      (p) => p,
      (r) => linkedMap[r] || [],
    );
    expect(viaContainment?.name).toBe('mimic');
  });

  it('reads active space id from view.json and picks clean reveal anchor', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-follower-'));
    try {
      const viewPath = path.join(tmp, 'view.json');
      fs.writeFileSync(viewPath, JSON.stringify({ active: 'sp123' }), 'utf8');
      expect(readActiveHerdrSpaceId(viewPath)).toBe('sp123');

      const projDir = path.join(tmp, 'proj');
      fs.mkdirSync(path.join(projDir, 'notes'), { recursive: true });
      fs.writeFileSync(path.join(projDir, 'AGENTS.md'), '# Agents\n', 'utf8');
      expect(pickRevealAnchorPath(projDir)).toBe(path.join(projDir, 'AGENTS.md'));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
