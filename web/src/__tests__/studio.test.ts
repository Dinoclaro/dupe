import { describe, expect, it } from 'vitest';
import {
  filterPapersForCitation,
  matchCitationTrigger,
} from '../components/Editor/citationCompletion';
import {
  compileLatexPreview,
  renderMarkdownPreview,
} from '../workers/latexCompiler';
import {
  decodeDrawioSvgDataUri,
  exportDiagramToSvg,
} from '../components/Diagram/svgExport';
import { normalizeRect } from '../components/Reader/PdfReaderPane';
import {
  Paper,
  clearOutboxQueue,
  enqueueOutboxEntry,
  getOutboxQueue,
  loadLocalNotesVault,
  loadWorkspaceSnapshot,
  parseGitHubOwnerRepo,
  resolveNoteWithLocalWins,
  saveLocalNote,
  saveWorkspaceSnapshot,
} from '../api/client';
import { buildFolderTree } from '../components/Sidebar/ExplorerSidebar';
import { convertDrawioClipboardToSnippet } from '../components/Editor/LatexEditorPane';

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

describe('Phase 2 Writing Studio & Diagram Tool', () => {
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
    const svg = exportDiagramToSvg([
      {
        id: 'box-1',
        type: 'rect',
        x: 10,
        y: 20,
        width: 120,
        height: 60,
        stroke: '#1e40af',
        fill: '#dbeafe',
        label: 'Encoder',
      },
    ]);

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

  it('decodes Draw.io xmlsvg base64 data URIs into SVG markup', () => {
    const rawSvg = '<svg xmlns="http://www.w3.org/2000/svg"><text>$$f(x)$$</text></svg>';
    const dataUri = `data:image/svg+xml;base64,${btoa(rawSvg)}`;
    expect(decodeDrawioSvgDataUri(dataUri)).toBe(rawSvg);
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

  it('converts copied Draw.io mxGraphModel clipboard XML into LaTeX figure and Markdown image snippets', () => {
    const drawioClipboard =
      '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="2" value="Encoder Block" vertex="1" parent="1"/></root></mxGraphModel>';

    const latexSnippet = convertDrawioClipboardToSnippet(
      drawioClipboard,
      '',
      false,
      'architecture',
    );
    expect(latexSnippet).toContain('\\includegraphics[width=0.8\\linewidth]{figures/architecture.svg}');
    expect(latexSnippet).toContain('\\caption{Encoder Block}');

    const mdSnippet = convertDrawioClipboardToSnippet(
      drawioClipboard,
      '',
      true,
      'architecture',
    );
    expect(mdSnippet).toBe('![Encoder Block](../paper/figures/architecture.svg)');
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
});
