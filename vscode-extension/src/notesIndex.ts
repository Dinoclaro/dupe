import fs from 'node:fs';
import path from 'node:path';
import { BacklinkHit, DiagramEntry, NoteEntry } from './types';

export interface WikiLinkOccurrence {
  kind: 'note' | 'paper' | 'diagram';
  raw: string;
  target: string;
  alias?: string;
  isEmbed: boolean;
  startOffset: number;
  endOffset: number;
}

const WIKI_LINK_RE = /(!?)\[\[([^\]\n]+)\]\]/g;
const MARKDOWN_TAG_RE = /(?:^|[\s,(])#([a-zA-Z][a-zA-Z0-9_/-]*)/g;
const LATEX_CITE_KEYS_RE = /\\cite[a-zA-Z*]*\{([^}]+)\}/g;

export function extractWikiLinksInLine(lineText: string): WikiLinkOccurrence[] {
  const results: WikiLinkOccurrence[] = [];
  WIKI_LINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WIKI_LINK_RE.exec(lineText)) !== null) {
    const isEmbed = m[1] === '!';
    const inner = m[2].trim();
    const pipeIdx = inner.indexOf('|');
    const rawTarget = (pipeIdx >= 0 ? inner.slice(0, pipeIdx) : inner).trim();
    const alias = pipeIdx >= 0 ? inner.slice(pipeIdx + 1).trim() : undefined;

    if (!rawTarget) {
      continue;
    }

    const innerStart = m.index + m[1].length + 2;
    const targetLen = pipeIdx >= 0 ? pipeIdx : inner.length;

    if (rawTarget.startsWith('paper:')) {
      const key = rawTarget.slice('paper:'.length).trim();
      if (!key) {
        continue;
      }
      results.push({
        kind: 'paper',
        raw: m[0],
        target: key,
        alias,
        isEmbed: false,
        startOffset: innerStart + 'paper:'.length,
        endOffset: innerStart + 'paper:'.length + key.length,
      });
      continue;
    }

    const lower = rawTarget.toLowerCase();
    const kind: 'note' | 'diagram' =
      isEmbed || lower.endsWith('.drawio.svg') || lower.endsWith('.svg') || lower.startsWith('diagrams/')
        ? 'diagram'
        : 'note';

    results.push({
      kind,
      raw: m[0],
      target: rawTarget.split('#')[0].trim(),
      alias,
      isEmbed,
      startOffset: innerStart,
      endOffset: innerStart + targetLen,
    });
  }
  return results;
}

export function extractMarkdownTags(content: string): string[] {
  const tags = new Set<string>();
  const lines = content.split(/\r?\n/);
  let inFence = false;
  for (const line of lines) {
    if (line.trimStart().startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }
    MARKDOWN_TAG_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = MARKDOWN_TAG_RE.exec(line)) !== null) {
      tags.add(m[1]);
    }
  }
  return Array.from(tags);
}

export function toggleCheckboxLine(line: string): string {
  const unchecked = line.match(/^(\s*[-*]\s+)\[ \]\s?(.*)$/);
  if (unchecked) {
    return `${unchecked[1]}[x] ${unchecked[2]}`;
  }
  const checked = line.match(/^(\s*[-*]\s+)\[[xX]\]\s?(.*)$/);
  if (checked) {
    return `${checked[1]}[ ] ${checked[2]}`;
  }
  const plainBullet = line.match(/^(\s*[-*]\s+)(.*)$/);
  if (plainBullet) {
    return `${plainBullet[1]}[ ] ${plainBullet[2]}`;
  }
  const indent = line.match(/^(\s*)(.*)$/);
  return `${indent ? indent[1] : ''}- [ ] ${indent ? indent[2] : line}`;
}

export function toggleWrappedFormat(text: string, prefix: string, suffix: string): string {
  if (text.startsWith(prefix) && text.endsWith(suffix) && text.length >= prefix.length + suffix.length) {
    return text.slice(prefix.length, text.length - suffix.length);
  }
  return `${prefix}${text}${suffix}`;
}

export function normalizeNoteRelPath(rawName: string): string {
  let clean = rawName.trim().replace(/\\/g, '/').replace(/^\/+/, '');
  clean = clean.split('#')[0].trim();
  if (clean.startsWith('notes/')) {
    clean = clean.slice('notes/'.length);
  }
  if (!clean.toLowerCase().endsWith('.md')) {
    clean = `${clean}.md`;
  }
  return path.posix.normalize(`notes/${clean}`);
}

export class NotesIndex {
  private notes: NoteEntry[] = [];
  private diagrams: DiagramEntry[] = [];
  private backlinksByTarget = new Map<string, BacklinkHit[]>();
  private backlinksByPaperKey = new Map<string, BacklinkHit[]>();
  private tagsIndex = new Map<string, NoteEntry[]>();

  rebuild(projectRoot: string | null): void {
    this.notes = [];
    this.diagrams = [];
    this.backlinksByTarget.clear();
    this.backlinksByPaperKey.clear();
    this.tagsIndex.clear();

    if (!projectRoot) {
      return;
    }

    const notesDir = path.join(projectRoot, 'notes');
    const diagramsDir = path.join(projectRoot, 'diagrams');
    const paperDir = path.join(projectRoot, 'paper');

    const mdFiles = this.walkFiles(notesDir, '.md');
    for (const absPath of mdFiles) {
      const relPath = path.relative(projectRoot, absPath).replace(/\\/g, '/');
      const slug = relPath.replace(/^notes\//, '').replace(/\.md$/i, '');
      const title = path.basename(absPath, '.md');
      let content = '';
      try {
        content = fs.readFileSync(absPath, 'utf8');
      } catch {
        continue;
      }

      const tags = extractMarkdownTags(content);
      const outgoingLinks: string[] = [];
      const lines = content.split(/\r?\n/);

      lines.forEach((lineText, idx) => {
        for (const link of extractWikiLinksInLine(lineText)) {
          if (link.kind === 'paper') {
            this.addPaperBacklink(link.target, {
              sourceRelPath: relPath,
              sourceAbsPath: absPath,
              line: idx + 1,
              preview: lineText.trim(),
            });
          } else if (link.kind === 'note') {
            outgoingLinks.push(link.target);
          }
        }
      });

      const entry: NoteEntry = {
        title,
        relPath,
        absPath,
        slug,
        tags,
        outgoingLinks,
      };
      this.notes.push(entry);

      for (const tag of tags) {
        const list = this.tagsIndex.get(tag) || [];
        list.push(entry);
        this.tagsIndex.set(tag, list);
      }
    }

    // Populate note backlinks after all notes are indexed so targets resolve accurately
    for (const note of this.notes) {
      let content = '';
      try {
        content = fs.readFileSync(note.absPath, 'utf8');
      } catch {
        continue;
      }
      const lines = content.split(/\r?\n/);
      lines.forEach((lineText, idx) => {
        for (const link of extractWikiLinksInLine(lineText)) {
          if (link.kind !== 'note') {
            continue;
          }
          const resolved = this.resolveNoteTarget(link.target);
          const key = resolved ? resolved.absPath : link.target.toLowerCase();
          if (resolved && resolved.absPath === note.absPath) {
            continue;
          }
          const list = this.backlinksByTarget.get(key) || [];
          list.push({
            sourceRelPath: note.relPath,
            sourceAbsPath: note.absPath,
            line: idx + 1,
            preview: lineText.trim(),
          });
          this.backlinksByTarget.set(key, list);
        }
      });
    }

    for (const absDiagram of this.walkFiles(diagramsDir)) {
      const relPath = path.relative(projectRoot, absDiagram).replace(/\\/g, '/');
      this.diagrams.push({
        name: path.basename(absDiagram),
        relPath,
        absPath: absDiagram,
      });
    }

    for (const absTex of this.walkFiles(paperDir, '.tex')) {
      const relPath = path.relative(projectRoot, absTex).replace(/\\/g, '/');
      let content = '';
      try {
        content = fs.readFileSync(absTex, 'utf8');
      } catch {
        continue;
      }
      const lines = content.split(/\r?\n/);
      lines.forEach((lineText, idx) => {
        LATEX_CITE_KEYS_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = LATEX_CITE_KEYS_RE.exec(lineText)) !== null) {
          for (const rawKey of m[1].split(',')) {
            const key = rawKey.trim();
            if (key) {
              this.addPaperBacklink(key, {
                sourceRelPath: relPath,
                sourceAbsPath: absTex,
                line: idx + 1,
                preview: lineText.trim(),
              });
            }
          }
        }
      });
    }

    this.notes.sort((a, b) => a.slug.localeCompare(b.slug));
    this.diagrams.sort((a, b) => a.relPath.localeCompare(b.relPath));
  }

  getNotes(): NoteEntry[] {
    return this.notes;
  }

  getDiagrams(): DiagramEntry[] {
    return this.diagrams;
  }

  getTagsMap(): Map<string, NoteEntry[]> {
    return this.tagsIndex;
  }

  resolveNoteTarget(target: string): NoteEntry | null {
    const clean = target.trim().replace(/\\/g, '/').replace(/^notes\//i, '').replace(/\.md$/i, '').toLowerCase();
    if (!clean) {
      return null;
    }
    return (
      this.notes.find((n) => n.slug.toLowerCase() === clean) ||
      this.notes.find((n) => n.title.toLowerCase() === clean) ||
      null
    );
  }

  resolveDiagramTarget(target: string): DiagramEntry | null {
    const clean = target.trim().replace(/\\/g, '/').replace(/^diagrams\//i, '').toLowerCase();
    return (
      this.diagrams.find((d) => d.relPath.toLowerCase() === `diagrams/${clean}`) ||
      this.diagrams.find((d) => d.name.toLowerCase() === clean) ||
      null
    );
  }

  getBacklinksForNote(absPath: string): BacklinkHit[] {
    return this.backlinksByTarget.get(absPath) || [];
  }

  getBacklinksForPaper(bibtexKey: string): BacklinkHit[] {
    return this.backlinksByPaperKey.get(bibtexKey) || [];
  }

  private addPaperBacklink(key: string, hit: BacklinkHit): void {
    const list = this.backlinksByPaperKey.get(key) || [];
    list.push(hit);
    this.backlinksByPaperKey.set(key, list);
  }

  private walkFiles(dir: string, suffix?: string): string[] {
    const out: string[] = [];
    if (!fs.existsSync(dir)) {
      return out;
    }
    const stack = [dir];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(cur, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (e.name.startsWith('.')) {
          continue;
        }
        const full = path.join(cur, e.name);
        if (e.isDirectory()) {
          stack.push(full);
        } else if (!suffix || e.name.toLowerCase().endsWith(suffix)) {
          out.push(full);
        }
      }
    }
    return out;
  }
}
