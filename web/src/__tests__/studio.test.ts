import { describe, expect, it } from 'vitest';
import {
  filterPapersForCitation,
  matchCitationTrigger,
} from '../components/Editor/citationCompletion';
import { compileLatexPreview } from '../workers/latexCompiler';
import { exportDiagramToSvg } from '../components/Diagram/svgExport';
import { normalizeRect } from '../components/Reader/PdfReaderPane';
import { Paper } from '../api/client';

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
});
