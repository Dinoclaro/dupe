import { LocalRefIndexEntry, Paper } from './types';

export type CitationContextKind = 'latex' | 'markdown_paper' | 'markdown_wiki' | 'markdown_tag';

export interface CitationTriggerMatch {
  kind: CitationContextKind;
  query: string;
  replaceStartOffset: number;
}

export interface CitationKeyOccurrence {
  kind: 'latex' | 'markdown';
  key: string;
  startOffset: number;
  endOffset: number;
}

const LATEX_CITE_TRIGGER_RE = /\\cite[a-zA-Z*]*\{(?:[^}]*,\s*)?([a-zA-Z0-9_:-]*)$/;
const MARKDOWN_PAPER_TRIGGER_RE = /\[\[paper:([a-zA-Z0-9_:-]*)$/;
const MARKDOWN_WIKI_TRIGGER_RE = /(!?)\[\[([^\]\n]*)$/;
const MARKDOWN_TAG_TRIGGER_RE = /(?:^|[\s,(])#([a-zA-Z0-9_/-]*)$/;
const LATEX_CITE_BLOCK_RE = /\\cite[a-zA-Z*]*\{([^}]+)\}/g;
const MARKDOWN_PAPER_LINK_RE = /\[\[paper:([a-zA-Z0-9_:-]+)\]\]/g;

export function detectCitationTrigger(
  linePrefix: string,
  languageId: string,
): CitationTriggerMatch | null {
  if (languageId === 'markdown') {
    const paperMatch = linePrefix.match(MARKDOWN_PAPER_TRIGGER_RE);
    if (paperMatch) {
      return {
        kind: 'markdown_paper',
        query: paperMatch[1],
        replaceStartOffset: linePrefix.length - paperMatch[1].length,
      };
    }

    const wikiMatch = linePrefix.match(MARKDOWN_WIKI_TRIGGER_RE);
    if (wikiMatch) {
      return {
        kind: 'markdown_wiki',
        query: wikiMatch[2],
        replaceStartOffset: linePrefix.length - wikiMatch[2].length,
      };
    }

    const tagMatch = linePrefix.match(MARKDOWN_TAG_TRIGGER_RE);
    if (tagMatch) {
      return {
        kind: 'markdown_tag',
        query: tagMatch[1],
        replaceStartOffset: linePrefix.length - tagMatch[1].length,
      };
    }
  }

  const latexMatch = linePrefix.match(LATEX_CITE_TRIGGER_RE);
  if (latexMatch) {
    return {
      kind: 'latex',
      query: latexMatch[1],
      replaceStartOffset: linePrefix.length - latexMatch[1].length,
    };
  }
  return null;
}

export function findCitationKeysInLine(lineText: string): CitationKeyOccurrence[] {
  const results: CitationKeyOccurrence[] = [];

  LATEX_CITE_BLOCK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = LATEX_CITE_BLOCK_RE.exec(lineText)) !== null) {
    const body = match[1];
    const bodyStart = match.index + match[0].indexOf('{') + 1;
    const partRe = /[a-zA-Z0-9_:-]+/g;
    let keyMatch: RegExpExecArray | null;
    while ((keyMatch = partRe.exec(body)) !== null) {
      results.push({
        kind: 'latex',
        key: keyMatch[0],
        startOffset: bodyStart + keyMatch.index,
        endOffset: bodyStart + keyMatch.index + keyMatch[0].length,
      });
    }
  }

  MARKDOWN_PAPER_LINK_RE.lastIndex = 0;
  while ((match = MARKDOWN_PAPER_LINK_RE.exec(lineText)) !== null) {
    const keyStart = match.index + '[[paper:'.length;
    results.push({
      kind: 'markdown',
      key: match[1],
      startOffset: keyStart,
      endOffset: keyStart + match[1].length,
    });
  }

  return results;
}

export function filterPapersByQuery(papers: Paper[], query: string): Paper[] {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return papers;
  }
  return papers.filter((p) => {
    const hay = [
      p.bibtex_key,
      p.title,
      p.authors,
      p.doi,
      p.publication_year ? String(p.publication_year) : '',
      ...(p.tags || []),
    ]
      .join(' ')
      .toLowerCase();
    return hay.includes(needle);
  });
}

export function formatCitationSnippet(bibtexKey: string, languageId: string): string {
  return languageId === 'markdown' ? `[[paper:${bibtexKey}]]` : `\\cite{${bibtexKey}}`;
}

export function paperFromLocalRefIndex(entry: LocalRefIndexEntry): Paper {
  return {
    id: entry.paper_id,
    owner_id: 0,
    title: entry.title,
    authors: entry.authors,
    publication_year: entry.publication_year,
    doi: entry.doi,
    bibtex_key: entry.bibtex_key,
    bibtex_raw: '',
    file_path: '',
    file_hash: '',
    is_shared: false,
    tags: entry.tags || [],
    updated_at: '',
  };
}
