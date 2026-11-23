import { describe, expect, it } from 'vitest';
import {
  filterPapersForCitation,
  matchCitationTrigger,
} from '../components/Editor/citationCompletion';
import {
  compileLatexPreview,
  renderMarkdownPreview,
} from '../workers/latexCompiler';
import { normalizeRect } from '../components/Reader/PdfReaderPane';
import {
  Paper,
  clearOutboxQueue,
  enqueueOutboxEntry,
  getOutboxQueue,
  loadLocalNotesVault,
  loadWorkspaceSnapshot,
  parseGitHubOwnerRepo,
  resolveActiveProjectId,
  resolveNoteWithLocalWins,
  saveLocalNote,
  saveWorkspaceSnapshot,
} from '../api/client';
import { buildFolderTree } from '../components/Sidebar/ExplorerSidebar';
import {
  checkLatexStructure,
  matchDiagnosticsForFile,
} from '../components/Editor/latexDiagnostics';
import {
  buildCommentCountMap,
  resolveCommentAnchors,
} from '../components/Editor/commentMarkers';

const SAMPLE_PAPERS: Paper[] = [
  {
    id: '11111111-1111-1111-1111-111111111111',
    owner_id: 1,
    title: 'Attention Is All You Need',
    authors: 'Ashish Vaswani, Noam Shazeer',
    publication_year: 2017,
    doi: '10.48550/arXiv.1706.03762',
    bibtex_key: 'vaswani2017attention',
    bibtex_raw: '@article{vaswani2017attention, title={Attention Is All You Need}}',
    file_path: 'pdfs/abc.pdf',
    file_hash: 'abc',
    is_shared: false,
    tags: ['transformers'],
    updated_at: '2026-11-16T00:00:00Z',
  },
  {
    id: '22222222-2222-2222-2222-222222222222',
    owner_id: 1,
    title: 'Deep Residual Learning for Image Recognition',
    authors: 'Kaiming He, Xiangyu Zhang',
    publication_year: 2016,
    doi: '10.1109/CVPR.2016.90',
    bibtex_key: 'he2016deep',
    bibtex_raw: '@article{he2016deep, title={Deep Residual Learning}}',
    file_path: 'pdfs/def.pdf',
    file_hash: 'def',
    is_shared: false,
    tags: ['vision'],
    updated_at: '2026-11-16T00:00:00Z',
  },
];

describe('Phase 2 Writing Studio', () => {
  it('detects @citation and \\cite{} autocomplete triggers', () => {
    const atTrigger = matchCitationTrigger('As shown in @vasw', 17);
    expect(atTrigger).toEqual({
      from: 12,
      query: 'vasw',
      mode: 'at',
    });

    const citeTrigger = matchCitationTrigger('Prior work \\cite{vaswani2017attention, he20', 43);
    expect(citeTrigger).toEqual({
      from: 39,
      query: 'he20',
      mode: 'cite',
    });

    const wikiTrigger = matchCitationTrigger('Notes on [[paper:vasw', 21);
    expect(wikiTrigger).toEqual({
      from: 9,
      query: 'vasw',
      mode: 'wikilink',
    });
  });

  it('filters papers by bibtex_key, author, or title', () => {
    const matches = filterPapersForCitation(SAMPLE_PAPERS, 'residual');
    expect(matches).toHaveLength(1);
    expect(matches[0].bibtex_key).toBe('he2016deep');
  });

  it('compiles LaTeX with KaTeX math, citations, and embedded SVG figures', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>Encoder</text></svg>';

    const res = compileLatexPreview({
      requestId: 1,
      source: `\\title{Test Paper}
\\begin{document}
We build on \\cite{vaswani2017attention} and $x^2 + y^2 = z^2$.
\\includegraphics{figures/arch.svg}
\\end{document}`,
      papers: SAMPLE_PAPERS,
      figures: { 'figures/arch.svg': svg },
    });

    expect(res.citedKeys).toEqual(['vaswani2017attention']);
    expect(res.missingKeys).toHaveLength(0);
    expect(res.html).toContain('Attention Is All You Need');
    expect(res.html).toContain('Encoder');
    expect(res.html).toContain('katex');
  });

  it('normalizes PDF selection bounding rects to [0.0, 1.0]', () => {
    const norm = normalizeRect(
      { left: 150, top: 250, width: 200, height: 50 },
      { left: 100, top: 50, width: 400, height: 800 },
    );
    expect(norm).toEqual({
      x: 0.125,
      y: 0.25,
      w: 0.5,
      h: 0.0625,
    });
  });

  it('queues and deduplicates offline outbox entries', () => {
    clearOutboxQueue();
    enqueueOutboxEntry({
      id: 'file:proj1:paper/main.tex',
      kind: 'project_file',
      projectId: 'proj1',
      path: 'paper/main.tex',
      content: 'v1',
      updatedAt: '2026-11-17T00:00:00Z',
    });
    enqueueOutboxEntry({
      id: 'file:proj1:paper/main.tex',
      kind: 'project_file',
      projectId: 'proj1',
      path: 'paper/main.tex',
      content: 'v2',
      updatedAt: '2026-11-17T00:01:00Z',
    });
    const queue = getOutboxQueue();
    expect(queue).toHaveLength(1);
    expect(queue[0].content).toBe('v2');
    clearOutboxQueue();
  });

  it('renders AGENTS.md tables and backtick \\cite{<bibtex_key>} without false citation errors', () => {
    const md = `# AGENTS.md — Default Paper Project

- Cite linked papers in LaTeX with \`\\cite{<bibtex_key>}\` and in Markdown notes with \`[[paper:<bibtex_key>]]\`.

| BibTeX Key | Year | Title | Authors |
|---|---|---|---|
| \`vaswani2017attention\` | 2017 | Attention Is All You Need | Ashish Vaswani |
`;
    const res = renderMarkdownPreview({
      requestId: 2,
      source: md,
      isMarkdown: true,
      papers: SAMPLE_PAPERS,
      figures: {},
    });
    expect(res.diagnostics).toHaveLength(0);
    expect(res.missingKeys).toHaveLength(0);
    expect(res.html).toContain('<table class="md-table">');
    expect(res.html).toContain('vaswani2017attention');
  });

  it('parses GitHub remote URLs and persists workspace cache for server-down fallback', () => {
    expect(parseGitHubOwnerRepo('git@github.com:Dinoclaro/overleaf-paper.git')).toEqual({
      owner: 'Dinoclaro',
      repo: 'overleaf-paper',
    });
    expect(parseGitHubOwnerRepo('https://github.com/Dinoclaro/overleaf-paper.git')).toEqual({
      owner: 'Dinoclaro',
      repo: 'overleaf-paper',
    });

    saveWorkspaceSnapshot({
      papers: SAMPLE_PAPERS,
      fileBuffers: { 'paper/main.tex': '\\section{Cached}' },
    });
    const snap = loadWorkspaceSnapshot();
    expect(snap.papers).toHaveLength(2);
    expect(snap.fileBuffers?.['paper/main.tex']).toBe('\\section{Cached}');
  });

  it('builds a recursive multi-level folder tree from project file entries', () => {
    const root = buildFolderTree([
      { path: 'notes/ideas/experiment.md', kind: 'markdown', git_status: '' },
      { path: 'paper/sections/intro.tex', kind: 'tex', git_status: 'M' },
    ]);

    const notesDir = root.childrenDirs.find((d) => d.name === 'notes');
    expect(notesDir).toBeDefined();
    const ideasDir = notesDir!.childrenDirs.find((d) => d.name === 'ideas')!;
    expect(ideasDir.files.map((f) => f.path)).toEqual(['notes/ideas/experiment.md']);

    const paperDir = root.childrenDirs.find((d) => d.name === 'paper')!;
    const sectionsDir = paperDir.childrenDirs.find((d) => d.name === 'sections')!;
    expect(sectionsDir.files.map((f) => f.path)).toEqual(['paper/sections/intro.tex']);
  });

  it('guarantees local notes always win over server stubs and syncs local note vault', () => {
    saveWorkspaceSnapshot({
      fileBuffers: {
        'notes/paperChanges.md': '# paperChanges\n\n- Detailed work laptop note bullet 1\n- Detailed bullet 2',
      },
    });
    const vault = loadLocalNotesVault();
    expect(vault['notes/paperChanges.md']?.content).toContain('Detailed work laptop note bullet 1');

    // Even if the server only has the 16-byte heading stub '# paperChanges\n\n', local MUST win
    const resolved = resolveNoteWithLocalWins('notes/paperChanges.md', '# paperChanges\n\n');
    expect(resolved.content).toContain('Detailed work laptop note bullet 1');
    expect(resolved.shouldPushToServer).toBe(true);

    // Direct local edit via saveLocalNote also wins over older server content
    saveLocalNote('notes/changes.md', '# changes\n\n- New local bullet', true, '# changes\n\n- Old');
    const resolvedChanges = resolveNoteWithLocalWins('notes/changes.md', '# changes\n\n- Old');
    expect(resolvedChanges.content).toContain('New local bullet');
    expect(resolvedChanges.shouldPushToServer).toBe(true);
  });

  it('parses comments.md into gutter anchors and file comment counts', () => {
    const commentsMd = `# Project Comments & Annotations

## Open Comments

- [ ] **[2026-11-20 07:20] \`paper/experiments.tex\` (line 2)**
  > "We compare against offline baselines"
  **Comment:** Tighten this framing.

## Addressed Comments

- [x] **[2026-11-19 20:46] \`paper/experiments.tex\` (line 3)**
  > "Done section"
  **Comment:** Looks good now.
`;
    const counts = buildCommentCountMap(commentsMd);
    expect(counts['paper/experiments.tex']).toEqual({ open: 1, addressed: 1 });

    const doc = '\\section{Exp}\nWe compare against offline baselines here.\nDone section.\n';
    const anchors = resolveCommentAnchors(commentsMd, 'paper/experiments.tex', doc);
    expect(anchors).toHaveLength(2);
    expect(anchors[0].line).toBe(2);
    expect(anchors[0].comment.open).toBe(true);
    expect(anchors[1].line).toBe(3);
    expect(anchors[1].comment.open).toBe(false);
  });

  it('detects structural LaTeX syntax mismatches and matches compiler diagnostics to files', () => {
    const validTex = `% comment with { unmatched brace\n\\begin{equation}\n  x = \\{1, 2\\}\n\\end{equation}\n`;
    expect(checkLatexStructure(validTex, 'paper/experiments.tex')).toEqual([]);

    const brokenTex = `\\begin{figure}\n  \\caption{Test\n\\end{table}\n`;
    const syntaxErrs = checkLatexStructure(brokenTex, 'paper/experiments.tex');
    expect(syntaxErrs.length).toBeGreaterThanOrEqual(2);
    expect(syntaxErrs.some((d) => d.message.includes('Mismatched \\end{table}'))).toBe(true);
    expect(syntaxErrs.some((d) => d.message.includes('Unclosed opening brace'))).toBe(true);

    const matched = matchDiagnosticsForFile(
      {
        success: false,
        failure_kind: 'latex_code',
        root_tex: 'paper/conference_101719.tex',
        pdf_available: false,
        duration_ms: 1200,
        errors: [
          {
            level: 'error',
            file: './experiments.tex',
            line: 42,
            message: 'Undefined control sequence',
          },
        ],
        warnings: [
          {
            level: 'warning',
            file: 'experiments.tex',
            line: 10,
            message: 'Underfull \\hbox',
            category: 'typography',
          },
          {
            level: 'warning',
            file: 'experiments.tex',
            line: 22,
            message: "Citation 'foo' undefined",
            category: 'reference',
          },
        ],
        raw_log: '',
      },
      'paper/experiments.tex',
    );
    expect(matched).toHaveLength(2);
    expect(matched[0].line).toBe(42);
    expect(matched[1].category).toBe('reference');
  });

  it('preserves the selected project across reloads via workspace snapshot', () => {
    const projectList = [
      {
        id: 'proj-default',
        name: 'Default Paper Project',
        folder_name: 'default-paper-project',
        overleaf_remote: '',
        linked_paper_ids: [],
        link_all_papers: true,
        pending_push: false,
        updated_at: '2026-11-20T12:00:00Z',
      },
      {
        id: 'proj-mimic',
        name: 'mimic',
        folder_name: 'mimic',
        overleaf_remote: '',
        linked_paper_ids: [],
        link_all_papers: true,
        pending_push: false,
        updated_at: '2026-11-20T12:01:00Z',
      },
    ];

    saveWorkspaceSnapshot({ activeProjectId: 'proj-mimic' });
    expect(resolveActiveProjectId(projectList)).toBe('proj-mimic');
    expect(resolveActiveProjectId(projectList, 'proj-missing')).toBe('proj-default');
    expect(resolveActiveProjectId([])).toBeNull();
  });
});
