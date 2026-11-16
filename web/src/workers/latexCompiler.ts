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

export function compileLatexPreview(req: CompileRequest): CompileResponse {
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
      .filter(Boolean);
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
  body = body.replace(
    /\\begin\{figure\}(?:\[[^\]]*\])?([\s\S]*?)\\end\{figure\}/g,
    (_match, inner: string) => {
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
            caption ? `<figcaption><strong>Figure:</strong> ${escapeHtml(caption)}</figcaption>` : ''
          }</figure>`
        : `<figure class="paper-figure paper-figure-missing"><div>Missing figure: <code>${escapeHtml(
            figPath || 'unspecified',
          )}</code></div>${caption ? `<figcaption>${escapeHtml(caption)}</figcaption>` : ''}</figure>`;
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
    .replace(/\\section\*?\{([^}]*)\}/g, '<h2>$1</h2>')
    .replace(/\\subsection\*?\{([^}]*)\}/g, '<h3>$1</h3>')
    .replace(/\\subsubsection\*?\{([^}]*)\}/g, '<h4>$1</h4>')
    .replace(/\\textbf\{([^}]*)\}/g, '<strong>$1</strong>')
    .replace(/\\textit\{([^}]*)\}/g, '<em>$1</em>')
    .replace(/\\emph\{([^}]*)\}/g, '<em>$1</em>')
    .replace(/\\texttt\{([^}]*)\}/g, '<code>$1</code>')
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
    ? `<section class="paper-abstract"><strong>Abstract.</strong> ${renderMathSegments(
        escapeHtml(abstractText),
        diagnostics,
      )}</section>`
    : '';

  const refsHtml =
    citedOrder.length > 0
      ? `<section class="paper-references">
          <h2>References</h2>
          <ol>
            ${citedOrder
              .map((key) => {
                const entry = paperMap.get(key);
                if (!entry) {
                  return `<li id="ref-${escapeHtml(key)}" class="cite-missing"><strong>[${escapeHtml(
                    key,
                  )}]</strong> Missing from library</li>`;
                }
                const yearStr = entry.publication_year ? ` (${entry.publication_year})` : '';
                const doiStr = entry.doi ? ` DOI: ${escapeHtml(entry.doi)}.` : '';
                return `<li id="ref-${escapeHtml(key)}">${escapeHtml(
                  entry.authors,
                )}${yearStr}. <em>${escapeHtml(entry.title)}</em>.${doiStr} <code>@${escapeHtml(
                  entry.bibtex_key,
                )}</code></li>`;
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
