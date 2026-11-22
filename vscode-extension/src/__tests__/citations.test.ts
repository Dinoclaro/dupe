import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseBibtexContent } from '../bibParser';
import {
  detectCitationTrigger,
  filterPapersByQuery,
  findCitationKeysInLine,
  formatCitationSnippet,
} from '../citations';
import {
  NotesIndex,
  extractMarkdownTags,
  extractWikiLinksInLine,
  normalizeNoteRelPath,
  toggleCheckboxLine,
  toggleWrappedFormat,
} from '../notesIndex';
import {
  discoverProjectsInWorkspace,
  findDupeProjectRoot,
  readLocalRefsIndex,
} from '../projectLocator';
import { Paper } from '../types';

const SAMPLE_PAPERS: Paper[] = [
  {
    id: '11111111-1111-1111-1111-111111111111',
    owner_id: 1,
    title: 'Diffusion Policies for Visuomotor Control',
    authors: 'Chi, Cheng and Song, Shuran',
    publication_year: 2023,
    doi: '10.15607/RSS.2023.XIX.026',
    bibtex_key: 'chi2023diffusion',
    bibtex_raw: '@inproceedings{chi2023diffusion,\n  title={Diffusion Policies},\n}',
    file_path: 'pdfs/a.pdf',
    file_hash: 'aaaa',
    is_shared: false,
    tags: ['robotics', 'diffusion'],
    updated_at: '2026-11-20T00:00:00Z',
  },
  {
    id: '22222222-2222-2222-2222-222222222222',
    owner_id: 1,
    title: 'Action Chunking with Transformers',
    authors: 'Zhao, Tony Z.',
    publication_year: 2023,
    doi: '',
    bibtex_key: 'zhao2023act',
    bibtex_raw: '@inproceedings{zhao2023act,\n  title={ACT},\n}',
    file_path: 'pdfs/b.pdf',
    file_hash: 'bbbb',
    is_shared: false,
    tags: ['imitation'],
    updated_at: '2026-11-20T00:00:00Z',
  },
];

describe('dupe VS Code extension helpers', () => {
  it('detects LaTeX \\cite and Obsidian [[ / [[paper: / #tag triggers', () => {
    expect(detectCitationTrigger('As shown in \\cite{chi', 'latex')).toEqual({
      kind: 'latex',
      query: 'chi',
      replaceStartOffset: 18,
    });

    expect(detectCitationTrigger('See \\citep{chi2023diffusion, zha', 'latex')).toEqual({
      kind: 'latex',
      query: 'zha',
      replaceStartOffset: 29,
    });

    expect(detectCitationTrigger('Notes on [[paper:zhao', 'markdown')).toEqual({
      kind: 'markdown_paper',
      query: 'zhao',
      replaceStartOffset: 17,
    });

    expect(detectCitationTrigger('Linked to [[SRE', 'markdown')).toEqual({
      kind: 'markdown_wiki',
      query: 'SRE',
      replaceStartOffset: 12,
    });

    expect(detectCitationTrigger('Topic #ablat', 'markdown')).toEqual({
      kind: 'markdown_tag',
      query: 'ablat',
      replaceStartOffset: 7,
    });

    expect(detectCitationTrigger('plain sentence', 'latex')).toBeNull();
  });

  it('finds citation key ranges across multi-key LaTeX and Markdown lines', () => {
    const line = 'We build on \\cite{chi2023diffusion, zhao2023act} and [[paper:chi2023diffusion]].';
    const hits = findCitationKeysInLine(line);
    expect(hits.map((h) => h.key)).toEqual([
      'chi2023diffusion',
      'zhao2023act',
      'chi2023diffusion',
    ]);
    expect(line.slice(hits[0].startOffset, hits[0].endOffset)).toBe('chi2023diffusion');
    expect(line.slice(hits[1].startOffset, hits[1].endOffset)).toBe('zhao2023act');
    expect(line.slice(hits[2].startOffset, hits[2].endOffset)).toBe('chi2023diffusion');
  });

  it('filters papers and formats citations by language', () => {
    expect(filterPapersByQuery(SAMPLE_PAPERS, 'diffusion')).toHaveLength(1);
    expect(filterPapersByQuery(SAMPLE_PAPERS, '2023')).toHaveLength(2);
    expect(formatCitationSnippet('chi2023diffusion', 'latex')).toBe('\\cite{chi2023diffusion}');
    expect(formatCitationSnippet('chi2023diffusion', 'markdown')).toBe('[[paper:chi2023diffusion]]');
  });

  it('parses .bib files with nested braces cleanly', () => {
    const bib = `
@article{yasaOverviewSoftRobotics2023,
  title = {An {Overview} of Soft Robotics},
  author = {Yasa, Oncay and Toshimitsu, Yasunori},
  year = {2023},
  doi = {10.1146/annurev}
}
`;
    const entries = parseBibtexContent(bib);
    expect(entries).toHaveLength(1);
    expect(entries[0].key).toBe('yasaOverviewSoftRobotics2023');
    expect(entries[0].title).toBe('An Overview of Soft Robotics');
    expect(entries[0].year).toBe('2023');
  });

  it('extracts Obsidian wikilinks, tags, checkbox toggles, and note paths', () => {
    const links = extractWikiLinksInLine('Compare [[SRE Ideas|ideas]] with [[paper:chi2023diffusion]] and ![[arch.drawio.svg]]');
    expect(links.map((l) => [l.kind, l.target])).toEqual([
      ['note', 'SRE Ideas'],
      ['paper', 'chi2023diffusion'],
      ['diagram', 'arch.drawio.svg'],
    ]);

    expect(extractMarkdownTags('# Title\nText #experiment and #todo/urgent\n```\n#ignored\n```')).toEqual([
      'experiment',
      'todo/urgent',
    ]);

    expect(toggleCheckboxLine('- [ ] Run ablation')).toBe('- [x] Run ablation');
    expect(toggleCheckboxLine('- [x] Run ablation')).toBe('- [ ] Run ablation');
    expect(toggleCheckboxLine('- Plain item')).toBe('- [ ] Plain item');
    expect(toggleWrappedFormat('focus', '**', '**')).toBe('**focus**');
    expect(toggleWrappedFormat('**focus**', '**', '**')).toBe('focus');
    expect(normalizeNoteRelPath('daily/2026-11-22')).toBe('notes/daily/2026-11-22.md');
  });

  it('indexes notes, diagrams, and backlinks inside a dupe project', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dupe-vscode-test-'));
    try {
      const projDir = path.join(tmpRoot, 'mimic');
      fs.mkdirSync(path.join(projDir, '.dupe'), { recursive: true });
      fs.mkdirSync(path.join(projDir, 'paper', 'sections'), { recursive: true });
      fs.mkdirSync(path.join(projDir, 'notes', 'daily'), { recursive: true });
      fs.mkdirSync(path.join(projDir, 'diagrams'), { recursive: true });
      fs.mkdirSync(path.join(projDir, 'refs'), { recursive: true });

      fs.writeFileSync(
        path.join(projDir, '.dupe', 'project.json'),
        JSON.stringify({ id: 'p-1', name: 'mimic', linked_paper_ids: [], link_all_papers: true }),
      );
      fs.writeFileSync(
        path.join(projDir, 'refs', 'index.json'),
        JSON.stringify([{ paper_id: '111', bibtex_key: 'chi2023diffusion', title: 'Diffusion', authors: 'Chi', publication_year: 2023, doi: '', tags: [] }]),
      );
      fs.writeFileSync(path.join(projDir, 'notes', 'ideas.md'), '# Ideas\n\nTarget note #core\n');
      fs.writeFileSync(path.join(projDir, 'notes', 'daily', '2026-11-22.md'), 'See [[ideas]] and [[paper:chi2023diffusion]]\n');
      fs.writeFileSync(path.join(projDir, 'diagrams', 'arch.drawio.svg'), '<svg/>');

      expect(findDupeProjectRoot(path.join(projDir, 'paper', 'sections'))).toBe(projDir);
      expect(discoverProjectsInWorkspace([tmpRoot])).toHaveLength(1);
      expect(readLocalRefsIndex(projDir)).toHaveLength(1);

      const idx = new NotesIndex();
      idx.rebuild(projDir);
      expect(idx.getNotes()).toHaveLength(2);
      expect(idx.getDiagrams()).toHaveLength(1);

      const targetNote = idx.resolveNoteTarget('ideas')!;
      expect(targetNote.relPath).toBe('notes/ideas.md');
      const backlinks = idx.getBacklinksForNote(targetNote.absPath);
      expect(backlinks).toHaveLength(1);
      expect(backlinks[0].sourceRelPath).toBe('notes/daily/2026-11-22.md');
      expect(idx.getBacklinksForPaper('chi2023diffusion')).toHaveLength(1);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
