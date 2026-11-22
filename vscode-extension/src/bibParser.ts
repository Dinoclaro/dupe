import fs from 'node:fs';
import path from 'node:path';
import { BibMetadata, Paper } from './types';

function cleanBibValue(raw: string): string {
  return raw
    .replace(/\s+/g, ' ')
    .replace(/\\['"`^~=.uvHcdbtr]\{?([a-zA-Z])\}?/g, '$1')
    .replace(/[{}]/g, '')
    .trim();
}

function readBracedOrQuoted(text: string, startIdx: number): { value: string; nextIdx: number } {
  const ch = text[startIdx];
  if (ch === '{') {
    let depth = 1;
    let i = startIdx + 1;
    while (i < text.length && depth > 0) {
      if (text[i] === '{' && text[i - 1] !== '\\') {
        depth++;
      } else if (text[i] === '}' && text[i - 1] !== '\\') {
        depth--;
      }
      i++;
    }
    return { value: text.slice(startIdx + 1, i - 1), nextIdx: i };
  }
  if (ch === '"') {
    let i = startIdx + 1;
    while (i < text.length) {
      if (text[i] === '"' && text[i - 1] !== '\\') {
        i++;
        break;
      }
      i++;
    }
    return { value: text.slice(startIdx + 1, i - 1), nextIdx: i };
  }
  const rest = text.slice(startIdx);
  const m = rest.match(/^[a-zA-Z0-9_:-]+/);
  const val = m ? m[0] : '';
  return { value: val, nextIdx: startIdx + val.length };
}

export function parseBibtexContent(content: string): BibMetadata[] {
  const entries: BibMetadata[] = [];
  let idx = 0;
  while (idx < content.length) {
    const atIdx = content.indexOf('@', idx);
    if (atIdx === -1) {
      break;
    }
    const headerMatch = content.slice(atIdx).match(/^@([a-zA-Z]+)\s*[{(]\s*([^,\s}]+)\s*,/);
    if (!headerMatch) {
      idx = atIdx + 1;
      continue;
    }
    const entryType = headerMatch[1].toLowerCase();
    const key = headerMatch[2].trim();
    const openBraceIdx = content.indexOf(headerMatch[0].includes('{') ? '{' : '(', atIdx);
    const openCh = content[openBraceIdx];
    const closeCh = openCh === '{' ? '}' : ')';

    let depth = 1;
    let i = openBraceIdx + 1;
    while (i < content.length && depth > 0) {
      if (content[i] === openCh && content[i - 1] !== '\\') {
        depth++;
      } else if (content[i] === closeCh && content[i - 1] !== '\\') {
        depth--;
      }
      i++;
    }

    const rawEntry = content.slice(atIdx, i);
    idx = i;

    if (entryType === 'string' || entryType === 'preamble' || entryType === 'comment') {
      continue;
    }

    const body = content.slice(atIdx + headerMatch[0].length, i - 1);
    const fields: Record<string, string> = {};
    let bIdx = 0;
    while (bIdx < body.length) {
      while (bIdx < body.length && /[\s,]/.test(body[bIdx])) {
        bIdx++;
      }
      const fieldMatch = body.slice(bIdx).match(/^([a-zA-Z0-9_-]+)\s*=\s*/);
      if (!fieldMatch) {
        bIdx++;
        continue;
      }
      const fieldName = fieldMatch[1].toLowerCase();
      bIdx += fieldMatch[0].length;
      if (bIdx >= body.length) {
        break;
      }
      const { value, nextIdx } = readBracedOrQuoted(body, bIdx);
      fields[fieldName] = cleanBibValue(value);
      bIdx = nextIdx;
    }

    entries.push({
      key,
      title: fields.title || key,
      authors: fields.author || fields.editor || '',
      year: fields.year || '',
      doi: fields.doi || '',
      raw: rawEntry.trim(),
    });
  }
  return entries;
}

export function loadProjectBibMetadata(projectRoot: string | null, papers: Paper[]): Map<string, BibMetadata> {
  const map = new Map<string, BibMetadata>();

  if (projectRoot) {
    const paperDir = path.join(projectRoot, 'paper');
    try {
      const files = fs.readdirSync(paperDir).filter((f) => f.endsWith('.bib'));
      for (const file of files) {
        try {
          const content = fs.readFileSync(path.join(paperDir, file), 'utf8');
          for (const entry of parseBibtexContent(content)) {
            if (!map.has(entry.key)) {
              map.set(entry.key, entry);
            }
          }
        } catch {
          // ignore unreadable bib file
        }
      }
    } catch {
      // ignore missing paper dir
    }
  }

  for (const paper of papers) {
    if (!paper.bibtex_key) {
      continue;
    }
    const existing = map.get(paper.bibtex_key);
    map.set(paper.bibtex_key, {
      key: paper.bibtex_key,
      title: paper.title || existing?.title || paper.bibtex_key,
      authors: paper.authors || existing?.authors || '',
      year: paper.publication_year ? String(paper.publication_year) : existing?.year || '',
      doi: paper.doi || existing?.doi || '',
      raw: paper.bibtex_raw || existing?.raw || '',
      paperId: paper.id,
    });
  }

  return map;
}
