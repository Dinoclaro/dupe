import { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import { Paper } from '../../api/client';

export interface CitationMatch {
  from: number;
  query: string;
  mode: 'at' | 'cite' | 'wikilink';
}

export function matchCitationTrigger(linePrefix: string, cursorPos: number): CitationMatch | null {
  const wikiMatch = linePrefix.match(/\[\[paper:([a-zA-Z0-9_:-]*)$/);
  if (wikiMatch) {
    const query = wikiMatch[1];
    return {
      from: cursorPos - query.length - 8,
      query: query.toLowerCase(),
      mode: 'wikilink',
    };
  }

  const citeMatch = linePrefix.match(/\\cite[a-zA-Z*]*\{([^}]*)$/);
  if (citeMatch) {
    const fullInside = citeMatch[1];
    const lastCommaIdx = fullInside.lastIndexOf(',');
    const token = lastCommaIdx >= 0 ? fullInside.slice(lastCommaIdx + 1) : fullInside;
    const trimmed = token.trimStart();
    return {
      from: cursorPos - trimmed.length,
      query: trimmed.toLowerCase(),
      mode: 'cite',
    };
  }

  const atMatch = linePrefix.match(/(?:^|[\s([{~])@([a-zA-Z0-9_:-]*)$/);
  if (atMatch) {
    const query = atMatch[1];
    return {
      from: cursorPos - query.length - 1,
      query: query.toLowerCase(),
      mode: 'at',
    };
  }

  return null;
}

export function filterPapersForCitation(papers: Paper[], query: string): Paper[] {
  const q = query.trim().toLowerCase();
  return papers.filter((p) => {
    if (!p.bibtex_key) {
      return false;
    }
    if (!q) {
      return true;
    }
    return (
      p.bibtex_key.toLowerCase().includes(q) ||
      p.title.toLowerCase().includes(q) ||
      p.authors.toLowerCase().includes(q) ||
      String(p.publication_year || '').includes(q)
    );
  });
}

export function createCitationCompletionSource(
  getPapers: () => Paper[],
  isMarkdown = false,
) {
  return (context: CompletionContext): CompletionResult | null => {
    const line = context.state.doc.lineAt(context.pos);
    const linePrefix = line.text.slice(0, context.pos - line.from);
    const trigger = matchCitationTrigger(linePrefix, context.pos);
    if (!trigger) {
      return null;
    }

    const candidates = filterPapersForCitation(getPapers(), trigger.query);
    const options: Completion[] = candidates.map((p) => ({
      label:
        trigger.mode === 'wikilink'
          ? `[[paper:${p.bibtex_key}]]`
          : trigger.mode === 'at'
            ? `@${p.bibtex_key}`
            : p.bibtex_key,
      detail: p.publication_year ? `(${p.publication_year}) ${p.authors}` : p.authors,
      info: p.title,
      type: 'keyword',
      apply:
        trigger.mode === 'wikilink' || (isMarkdown && trigger.mode === 'at')
          ? `[[paper:${p.bibtex_key}]]`
          : trigger.mode === 'at'
            ? `\\cite{${p.bibtex_key}}`
            : p.bibtex_key,
    }));

    return {
      from: trigger.from,
      options,
      filter: false,
    };
  };
}
