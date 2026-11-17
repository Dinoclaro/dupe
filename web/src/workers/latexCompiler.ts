import katex from 'katex';

export interface BibEntrySummary {
  bibtex_key: string;
  title: string;
  authors: string;
  publication_year: number | null;
  doi: string;
}

export interface CompileRequest {
  requestId: number;
  source: string;
  isMarkdown?: boolean;
  papers: BibEntrySummary[];
  figures: Record<string, string>;
}

export interface CompileResponse {
  requestId: number;
  html: string;
  citedKeys: string[];
  missingKeys: string[];
  diagnostics: string[];
  durationMs: number;
}

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function extractCommandArg(source: string, command: string): string {
  const regex = new RegExp(`\\\\${command}\\{([^}]*)\\}`);
  const match = source.match(regex);
  return match ? match[1].trim() : '';
}

function extractEnvironment(source: string, envName: string): string {
  const regex = new RegExp(`\\\\begin\\{${envName}\\}([\\s\\S]*?)\\\\end\\{${envName}\\}`);
  const match = source.match(regex);
  return match ? match[1].trim() : '';
}

function renderMathSegments(input: string, diagnostics: string[]): string {
  let output = input.replace(/\$\$([\s\S]+?)\$\$/g, (_match, expr: string) => {
    try {
      return katex.renderToString(expr.trim(), { displayMode: true, throwOnError: false });
    } catch (err) {
      diagnostics.push(`Display math error: ${String(err)}`);
      return `<code>${escapeHtml(expr)}</code>`;
    }
  });

  output = output.replace(/\\\[([\s\S]+?)\\\]/g, (_match, expr: string) => {
    try {
      return katex.renderToString(expr.trim(), { displayMode: true, throwOnError: false });
    } catch (err) {
      diagnostics.push(`Display math error: ${String(err)}`);
      return `<code>${escapeHtml(expr)}</code>`;
    }
  });

  output = output.replace(/\$([^$\n]+?)\$/g, (_match, expr: string) => {
    try {
      return katex.renderToString(expr.trim(), { displayMode: false, throwOnError: false });
    } catch (err) {
      diagnostics.push(`Inline math error: ${String(err)}`);
      return `<code>${escapeHtml(expr)}</code>`;
    }
  });

  return output;
}

export function renderMarkdownPreview(req: CompileRequest): CompileResponse {
  const startedAt = performance.now();
  const diagnostics: string[] = [];
  const paperMap = new Map<string, BibEntrySummary>();
  for (const p of req.papers) {
    if (p.bibtex_key) {
      paperMap.set(p.bibtex_key, p);
    }
  }

  const citedOrder: string[] = [];
  const missingSet = new Set<string>();

  // 1. Extract fenced code blocks first so their contents are never parsed as citations or math
  const codeTokens: string[] = [];
  let text = req.source.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (_m, _lang: string, code: string) => {
    const token = `@@CODE_BLOCK_${codeTokens.length}@@`;
    codeTokens.push(`<pre class="md-pre"><code>${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`);
    return token;
  });

  // 2. Extract inline backtick code spans (`...`) before math or citation parsing
  const inlineCodeTokens: string[] = [];
  text = text.replace(/`([^`\n]+)`/g, (_m, code: string) => {
    const token = `@@INLINE_CODE_${inlineCodeTokens.length}@@`;
    inlineCodeTokens.push(`<code class="md-code">${escapeHtml(code)}</code>`);
    return token;
  });

  // 3. Extract math segments
  const mathTokens: string[] = [];
  text = text.replace(/\$\$[\s\S]+?\$\$|\$[^$\n]+?\$/g, (match) => {
    const rendered = renderMathSegments(match, diagnostics);
    const token = `@@MATH_TOKEN_${mathTokens.length}@@`;
    mathTokens.push(rendered);
    return token;
  });

  const formatInline = (rawLine: string): string => {
    let escaped = escapeHtml(rawLine);
    escaped = escaped
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .replace(/\[\[paper:([a-zA-Z0-9_:-]+)\]\]/g, (_m, key: string) => {
        if (key.includes('bibtex_key')) {
          return `<code>[[paper:${escapeHtml(key)}]]</code>`;
        }
        let idx = citedOrder.indexOf(key);
        if (idx === -1) {
          citedOrder.push(key);
          idx = citedOrder.length - 1;
        }
        const p = paperMap.get(key);
        if (!p) {
          missingSet.add(key);
          return `<span class="cite-missing">[?${escapeHtml(key)}]</span>`;
        }
        return `<a href="#ref-${escapeHtml(key)}" class="cite-badge" title="${escapeHtml(
          p.title,
        )}">[@${escapeHtml(key)}]</a>`;
      });

    inlineCodeTokens.forEach((html, idx) => {
      escaped = escaped.replace(`@@INLINE_CODE_${idx}@@`, html);
    });
    mathTokens.forEach((html, idx) => {
      escaped = escaped.replace(`@@MATH_TOKEN_${idx}@@`, html);
    });
    return escaped;
  };

  const lines = text.split('\n');
  const htmlBlocks: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      i++;
      continue;
    }

    if (trimmed.startsWith('@@CODE_BLOCK_')) {
      const matchIdx = trimmed.match(/^@@CODE_BLOCK_(\d+)@@$/);
      if (matchIdx) {
        htmlBlocks.push(codeTokens[Number(matchIdx[1])] || '');
        i++;
        continue;
      }
    }

    // Headings
    const hMatch = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (hMatch) {
      const level = hMatch[1].length;
      htmlBlocks.push(`<h${level} class="md-heading">${formatInline(hMatch[2])}</h${level}>`);
      i++;
      continue;
    }

    // Markdown Table (| col1 | col2 |)
    if (trimmed.startsWith('|') && trimmed.endsWith('|') && i + 1 < lines.length && lines[i + 1].trim().startsWith('|')) {
      const parseRow = (rowLine: string) =>
        rowLine
          .trim()
          .replace(/^\|/, '')
          .replace(/\|$/, '')
          .split('|')
          .map((c) => c.trim());

      const headers = parseRow(trimmed);
      const nextTrimmed = lines[i + 1].trim();
      const isDivider = /^\|[\s:-]+\|/.test(nextTrimmed);
      if (isDivider) {
        i += 2;
        const bodyRows: string[][] = [];
        while (i < lines.length && lines[i].trim().startsWith('|') && lines[i].trim().endsWith('|')) {
          bodyRows.push(parseRow(lines[i]));
          i++;
        }
        const thead = `<thead><tr>${headers.map((h) => `<th>${formatInline(h)}</th>`).join('')}</tr></thead>`;
        const tbody = `<tbody>${bodyRows
          .map((r) => `<tr>${r.map((c) => `<td>${formatInline(c)}</td>`).join('')}</tr>`)
          .join('')}</tbody>`;
        htmlBlocks.push(`<div class="md-table-wrap"><table class="md-table">${thead}${tbody}</table></div>`);
        continue;
      }
    }

    // Unordered list (- or *)
    if (/^[-*]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i].trim())) {
        items.push(`<li>${formatInline(lines[i].trim().replace(/^[-*]\s+/, ''))}</li>`);
        i++;
      }
      htmlBlocks.push(`<ul class="md-list">${items.join('')}</ul>`);
      continue;
    }

    // Ordered list (1. )
    if (/^\d+\.\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
        items.push(`<li>${formatInline(lines[i].trim().replace(/^\d+\.\s+/, ''))}</li>`);
        i++;
      }
      htmlBlocks.push(`<ol class="md-list">${items.join('')}</ol>`);
      continue;
    }

    // Regular paragraph
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !lines[i].trim().startsWith('#') &&
      !lines[i].trim().startsWith('@@CODE_BLOCK_') &&
      !lines[i].trim().startsWith('|') &&
      !/^[-*]\s+/.test(lines[i].trim()) &&
      !/^\d+\.\s+/.test(lines[i].trim())
    ) {
      paraLines.push(lines[i].trim());
      i++;
    }
    htmlBlocks.push(`<p>${formatInline(paraLines.join(' '))}</p>`);
  }

  return {
    requestId: req.requestId,
    html: `<article class="compiled-paper markdown-document">${htmlBlocks.join('\n')}</article>`,
    citedKeys: citedOrder,
    missingKeys: Array.from(missingSet),
    diagnostics,
    durationMs: Math.round(performance.now() - startedAt),
  };
}

export function compileLatexPreview(req: CompileRequest): CompileResponse {
  if (req.isMarkdown || (!req.source.includes('\\begin{document}') && req.source.trimStart().startsWith('#'))) {
    return renderMarkdownPreview(req);
  }

  const startedAt = performance.now();
  const diagnostics: string[] = [];
  const paperMap = new Map<string, BibEntrySummary>();
  for (const p of req.papers) {
    if (p.bibtex_key) {
      paperMap.set(p.bibtex_key, p);
    }
  }

  const title = extractCommandArg(req.source, 'title');
  const author = extractCommandArg(req.source, 'author');
  const date = extractCommandArg(req.source, 'date');
  const abstractText = extractEnvironment(req.source, 'abstract');

  let body = extractEnvironment(req.source, 'document') || req.source;
  body = body
    .replace(/\\maketitle/g, '')
    .replace(/\\begin\{abstract\}[\s\S]*?\\end\{abstract\}/g, '')
    .replace(/\\bibliographystyle\{[^}]*\}/g, '')
    .replace(/\\bibliography\{[^}]*\}/g, '');

  // Strip comments starting with unescaped %
  body = body
    .split('\n')
    .map((line) => line.replace(/(^|[^\\])%.*$/, '$1'))
    .join('\n');

  const citedOrder: string[] = [];
  const missingSet = new Set<string>();

  const recordCitation = (rawKeys: string): string => {
    const keys = rawKeys
      .split(',')
      .map((k) => k.trim())
      .filter((k) => Boolean(k) && !k.includes('<') && !k.includes('>') && !k.includes('&lt;'));
    if (keys.length === 0) {
      return '';
    }
    const badges = keys.map((key) => {
      let idx = citedOrder.indexOf(key);
      if (idx === -1) {
        citedOrder.push(key);
        idx = citedOrder.length - 1;
      }
      if (!paperMap.has(key)) {
        missingSet.add(key);
        return `<span class="cite-missing" title="Missing key: ${escapeHtml(key)}">[?${escapeHtml(key)}]</span>`;
      }
      const p = paperMap.get(key)!;
      return `<a href="#ref-${escapeHtml(key)}" class="cite-badge" title="${escapeHtml(p.title)}">[${idx + 1}]</a>`;
    });
    return badges.join(', ');
  };

  // Replace figures before escaping remaining text
  const figureTokens: string[] = [];
  let figureCounter = 0;
  body = body.replace(
    /\\begin\{figure\}(?:\[[^\]]*\])?([\s\S]*?)\\end\{figure\}/g,
    (_match, inner: string) => {
      figureCounter++;
      const imgMatch = inner.match(/\\includegraphics(?:\[[^\]]*\])?\{([^}]+)\}/);
      const capMatch = inner.match(/\\caption\{([^}]*)\}/);
      const figPath = imgMatch ? imgMatch[1].trim() : '';
      const caption = capMatch ? capMatch[1].trim() : '';
      const svgContent =
        req.figures[figPath] ||
        req.figures[figPath.replace(/^figures\//, '')] ||
        req.figures[`figures/${figPath}`];

      const figHtml = svgContent
        ? `<figure class="paper-figure"><div class="paper-figure-canvas">${svgContent}</div>${
            caption
              ? `<figcaption class="paper-figcaption"><strong>Figure ${figureCounter}:</strong> ${escapeHtml(
                  caption,
                )}</figcaption>`
              : ''
          }</figure>`
        : `<figure class="paper-figure paper-figure-missing"><div>Missing figure: <code>${escapeHtml(
            figPath || 'unspecified',
          )}</code></div>${
            caption
              ? `<figcaption class="paper-figcaption"><strong>Figure ${figureCounter}:</strong> ${escapeHtml(
                  caption,
                )}</figcaption>`
              : ''
          }</figure>`;
      const token = `@@FIGURE_TOKEN_${figureTokens.length}@@`;
      figureTokens.push(figHtml);
      return token;
    },
  );

  body = body.replace(/\\includegraphics(?:\[[^\]]*\])?\{([^}]+)\}/g, (_match, rawPath: string) => {
    const figPath = rawPath.trim();
    const svgContent =
      req.figures[figPath] ||
      req.figures[figPath.replace(/^figures\//, '')] ||
      req.figures[`figures/${figPath}`];
    const figHtml = svgContent
      ? `<figure class="paper-figure"><div class="paper-figure-canvas">${svgContent}</div></figure>`
      : `<div class="paper-figure-missing">Missing figure: <code>${escapeHtml(figPath)}</code></div>`;
    const token = `@@FIGURE_TOKEN_${figureTokens.length}@@`;
    figureTokens.push(figHtml);
    return token;
  });

  // Escape HTML outside math, then restore math and formatting
  const mathTokens: string[] = [];
  body = body.replace(/\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\$[^$\n]+?\$/g, (match) => {
    const rendered = renderMathSegments(match, diagnostics);
    const token = `@@MATH_TOKEN_${mathTokens.length}@@`;
    mathTokens.push(rendered);
    return token;
  });

  body = escapeHtml(body);

  body = body
    .replace(/\\centering/g, '')
    .replace(/\\label\{[^}]*\}/g, '')
    .replace(/\\section\*\{([^}]*)\}/g, '<h2 class="latex-section-star">$1</h2>')
    .replace(/\\section\{([^}]*)\}/g, '<h2 class="latex-section">$1</h2>')
    .replace(/\\subsection\*\{([^}]*)\}/g, '<h3 class="latex-subsection-star">$1</h3>')
    .replace(/\\subsection\{([^}]*)\}/g, '<h3 class="latex-subsection">$1</h3>')
    .replace(/\\subsubsection\*?\{([^}]*)\}/g, '<h4 class="latex-subsubsection">$1</h4>')
    .replace(/\\textbf\{([^}]*)\}/g, '<strong>$1</strong>')
    .replace(/\\textit\{([^}]*)\}/g, '<em>$1</em>')
    .replace(/\\emph\{([^}]*)\}/g, '<em>$1</em>')
    .replace(/\\texttt\{([^}]*)\}/g, '<code class="latex-tt">$1</code>')
    .replace(/\\cite[a-zA-Z*]*\{([^}]+)\}/g, (_m, keys: string) => recordCitation(keys))
    .replace(/(^|\s)@([a-zA-Z0-9_:-]{3,})/g, (_m, prefix: string, key: string) => {
      if (paperMap.has(key)) {
        return `${prefix}${recordCitation(key)}`;
      }
      return `${prefix}@${key}`;
    });

  // Paragraphs
  const paragraphs = body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((block) => {
      if (block.startsWith('<h') || block.startsWith('@@FIGURE_TOKEN_')) {
        return block;
      }
      return `<p>${block.replace(/\n/g, ' ')}</p>`;
    })
    .join('\n');

  let finalBody = paragraphs;
  mathTokens.forEach((rendered, i) => {
    finalBody = finalBody.replace(`@@MATH_TOKEN_${i}@@`, rendered);
  });
  figureTokens.forEach((figHtml, i) => {
    finalBody = finalBody.replace(`@@FIGURE_TOKEN_${i}@@`, figHtml);
  });

  for (const missing of missingSet) {
    diagnostics.push(`Unresolved citation key: ${missing}`);
  }

  const headerHtml = title
    ? `<header class="paper-header">
        <h1 class="paper-title">${escapeHtml(title)}</h1>
        ${author ? `<div class="paper-authors">${escapeHtml(author.replace(/\\and/g, ' · '))}</div>` : ''}
        ${date ? `<div class="paper-date">${escapeHtml(date)}</div>` : ''}
      </header>`
    : '';

  const abstractHtml = abstractText
    ? `<section class="paper-abstract"><div class="paper-abstract-title">Abstract</div><div class="paper-abstract-body">${renderMathSegments(
        escapeHtml(abstractText),
        diagnostics,
      )}</div></section>`
    : '';

  const refsHtml =
    citedOrder.length > 0
      ? `<section class="paper-references">
          <h2 class="latex-section-star">References</h2>
          <ol class="latex-bib-list">
            ${citedOrder
              .map((key, idx) => {
                const entry = paperMap.get(key);
                if (!entry) {
                  return `<li id="ref-${escapeHtml(key)}" class="cite-missing"><span class="bib-num">[${
                    idx + 1
                  }]</span> <strong>${escapeHtml(key)}</strong> — Missing from library</li>`;
                }
                const yearStr = entry.publication_year ? `, ${entry.publication_year}` : '';
                const doiStr = entry.doi ? ` doi:${escapeHtml(entry.doi)}.` : '';
                return `<li id="ref-${escapeHtml(key)}"><span class="bib-num">[${
                  idx + 1
                }]</span> <span class="bib-text">${escapeHtml(
                  entry.authors,
                )}, &ldquo;${escapeHtml(entry.title)},&rdquo;${yearStr}.${doiStr}</span></li>`;
              })
              .join('\n')}
          </ol>
        </section>`
      : '';

  return {
    requestId: req.requestId,
    html: `<article class="compiled-paper">${headerHtml}${abstractHtml}${finalBody}${refsHtml}</article>`,
    citedKeys: citedOrder,
    missingKeys: Array.from(missingSet),
    diagnostics,
    durationMs: Math.round(performance.now() - startedAt),
  };
}
