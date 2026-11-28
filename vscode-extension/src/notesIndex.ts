import fs from 'node:fs';
import path from 'node:path';
import {
  BacklinkHit,
  BrainGraphEdge,
  BrainGraphNode,
  BrainGraphPayload,
  BrainNodeKind,
  NoteEntry,
  Paper,
  UnlinkedMentionHit,
} from './types';

export interface WikiLinkOccurrence {
  kind: 'note' | 'paper';
  raw: string;
  target: string;
  alias?: string;
  isEmbed: boolean;
  startOffset: number;
  endOffset: number;
}

export interface ParsedFrontmatter {
  type?: string;
  status?: string;
  tags: string[];
  aliases: string[];
}

export const CURATED_BRAIN_MAX_LINES = 150;
export const CURATED_BRAIN_MAX_BYTES = 8 * 1024;

const WIKI_LINK_RE = /(!?)\[\[([^\]\n]+)\]\]/g;
const MARKDOWN_TAG_RE = /(?:^|[\s,(])#([a-zA-Z][a-zA-Z0-9_/-]*)/g;
const LATEX_CITE_KEYS_RE = /\\cite[a-zA-Z*]*\{([^}]+)\}/g;

function maskInlineCode(lineText: string): string {
  return lineText.replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length));
}

export function parseMarkdownFrontmatter(content: string): {
  frontmatter: ParsedFrontmatter;
  body: string;
  bodyStartLine: number;
} {
  const norm = content.replace(/\r\n/g, '\n');
  if (!norm.startsWith('---\n')) {
    return { frontmatter: { tags: [], aliases: [] }, body: norm, bodyStartLine: 0 };
  }
  const rest = norm.slice(4);
  let endIdx = rest.indexOf('\n---\n');
  let delimiterLen = 5;
  if (endIdx < 0) {
    if (rest.endsWith('\n---')) {
      endIdx = rest.length - 4;
      delimiterLen = 4;
    } else {
      return { frontmatter: { tags: [], aliases: [] }, body: norm, bodyStartLine: 0 };
    }
  }

  const header = rest.slice(0, endIdx);
  const body = rest.slice(endIdx + delimiterLen);
  const bodyStartLine = header.split('\n').length + 2;

  const frontmatter: ParsedFrontmatter = { tags: [], aliases: [] };
  let activeListKey: 'tags' | 'aliases' | null = null;
  for (const rawLine of header.split('\n')) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed.startsWith('- ') && activeListKey) {
      const item = trimmed
        .slice(2)
        .trim()
        .replace(/^['"]|['"]$/g, '');
      if (item) {
        if (activeListKey === 'tags') {
          frontmatter.tags.push(item.replace(/^#/, ''));
        } else {
          frontmatter.aliases.push(item);
        }
      }
      continue;
    }
    activeListKey = null;
    const colon = trimmed.indexOf(':');
    if (colon <= 0) {
      continue;
    }
    const key = trimmed.slice(0, colon).trim().toLowerCase();
    const rawVal = trimmed.slice(colon + 1).trim();
    if (key === 'type') {
      frontmatter.type = rawVal.replace(/^['"]|['"]$/g, '').toLowerCase();
    } else if (key === 'status') {
      frontmatter.status = rawVal.replace(/^['"]|['"]$/g, '');
    } else if (key === 'tags' || key === 'aliases') {
      if (!rawVal) {
        activeListKey = key;
        continue;
      }
      const cleaned = rawVal.replace(/^\[|\]$/g, '');
      for (const part of cleaned.split(',')) {
        const item = part.trim().replace(/^['"]|['"]$/g, '');
        if (!item) {
          continue;
        }
        if (key === 'tags') {
          frontmatter.tags.push(item.replace(/^#/, ''));
        } else {
          frontmatter.aliases.push(item);
        }
      }
    }
  }
  return { frontmatter, body, bodyStartLine };
}

export function extractWikiLinksInLine(lineText: string): WikiLinkOccurrence[] {
  const results: WikiLinkOccurrence[] = [];
  const cleanedLine = maskInlineCode(lineText);
  WIKI_LINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WIKI_LINK_RE.exec(cleanedLine)) !== null) {
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

    results.push({
      kind: 'note',
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
  const { frontmatter, body } = parseMarkdownFrontmatter(content);
  for (const t of frontmatter.tags) {
    if (t) {
      tags.add(t);
    }
  }
  const lines = body.split(/\r?\n/);
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
    const cleanedLine = maskInlineCode(line);
    while ((m = MARKDOWN_TAG_RE.exec(cleanedLine)) !== null) {
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

export type MarkdownEnterResult =
  | { action: 'insert'; text: string }
  | { action: 'clearPrefix' }
  | { action: 'default' };

export function computeMarkdownEnterEdit(lineText: string, cursorCol: number): MarkdownEnterResult {
  const before = lineText.slice(0, cursorCol);
  const after = lineText.slice(cursorCol);

  const taskMatch = before.match(/^(\s*)([-*])\s+\[(?: |x|X)\]\s(.*)$/);
  if (taskMatch) {
    if (!taskMatch[3].trim() && !after.trim()) {
      return { action: 'clearPrefix' };
    }
    return { action: 'insert', text: `\n${taskMatch[1]}${taskMatch[2]} [ ] ` };
  }

  const orderedMatch = before.match(/^(\s*)(\d+)([.)])\s(.*)$/);
  if (orderedMatch) {
    if (!orderedMatch[4].trim() && !after.trim()) {
      return { action: 'clearPrefix' };
    }
    const nextNum = parseInt(orderedMatch[2], 10) + 1;
    return { action: 'insert', text: `\n${orderedMatch[1]}${nextNum}${orderedMatch[3]} ` };
  }

  const bulletMatch = before.match(/^(\s*)([-*+])\s(.*)$/);
  if (bulletMatch) {
    if (!bulletMatch[3].trim() && !after.trim()) {
      return { action: 'clearPrefix' };
    }
    return { action: 'insert', text: `\n${bulletMatch[1]}${bulletMatch[2]} ` };
  }

  const quoteMatch = before.match(/^(\s*>)\s?(.*)$/);
  if (quoteMatch) {
    if (!quoteMatch[2].trim() && !after.trim()) {
      return { action: 'clearPrefix' };
    }
    return { action: 'insert', text: `\n${quoteMatch[1]} ` };
  }

  return { action: 'default' };
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

export function sanitizeBrainSlug(raw: string): string {
  const clean = raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '');
  return clean || 'concept';
}

function isUtilityHumanNote(relPath: string): boolean {
  const norm = relPath.replace(/\\/g, '/').toLowerCase();
  const base = path.posix.basename(norm);
  if (['comments.md', 'changes.md', 'paperchanges.md', 'agents.user.md'].includes(base)) {
    return true;
  }
  return norm.startsWith('notes/daily/');
}

export function formatCommentBlock(params: {
  source: string;
  location?: string;
  quote?: string;
  comment: string;
  timestamp?: string;
}): string {
  const stamp =
    params.timestamp ||
    new Date().toISOString().slice(0, 16).replace('T', ' ');
  const source = params.source.trim() || 'project';
  const loc = (params.location || '').trim();
  let header = `- [ ] **[${stamp}] \`${source}\``;
  if (loc) {
    header += ` (${loc})`;
  }
  header += '**';

  const lines = [header];
  const quoteClean = (params.quote || '').trim().replace(/\s+/g, ' ');
  if (quoteClean) {
    const truncated = quoteClean.length > 280 ? `${quoteClean.slice(0, 280)}…` : quoteClean;
    lines.push(`  > "${truncated}"`);
  }
  lines.push(`  **Comment:** ${params.comment.trim()}`);
  return lines.join('\n');
}

export function insertOpenCommentInMarkdown(existingRaw: string, commentBlock: string): string {
  const block = commentBlock.trim();
  if (!existingRaw.trim()) {
    return [
      '# Project Comments & Annotations',
      '',
      '## Open Comments',
      '',
      block,
      '',
      '## Addressed Comments',
      '',
      '_No addressed comments yet._',
      '',
    ].join('\n');
  }

  const normalized = existingRaw.replace(/\r\n/g, '\n');
  const openHeadingRe = /^## Open Comments\s*$/m;
  const match = openHeadingRe.exec(normalized);
  if (match) {
    const insertIdx = match.index + match[0].length;
    const before = normalized.slice(0, insertIdx);
    let after = normalized.slice(insertIdx);
    after = after.replace(/^\n*_No open comments\._\n*/, '\n\n');
    const cleanedAfter = after.replace(/^\n+/, '');
    return `${before}\n\n${block}\n\n${cleanedAfter}`.replace(/\n{3,}$/, '\n');
  }

  return `# Project Comments & Annotations\n\n## Open Comments\n\n${block}\n\n${normalized.trimStart()}`;
}

export function insertCommentIntoTargetNote(
  existingRaw: string,
  commentBlock: string,
  targetRelPath: string,
): string {
  const normRel = normalizeNoteRelPath(targetRelPath);
  if (normRel === 'notes/comments.md' || /^## Open Comments\s*$/m.test(existingRaw)) {
    return insertOpenCommentInMarkdown(existingRaw, commentBlock);
  }

  const block = commentBlock.trim();
  const baseName = path.posix.basename(normRel, '.md');
  if (!existingRaw.trim()) {
    return `# ${baseName}\n\n## Comments\n\n${block}\n`;
  }

  const normalized = existingRaw.replace(/\r\n/g, '\n');
  const commentsHeadingRe = /^## Comments\s*$/m;
  const headingMatch = commentsHeadingRe.exec(normalized);
  if (headingMatch) {
    const afterHeadingIdx = headingMatch.index + headingMatch[0].length;
    const rest = normalized.slice(afterHeadingIdx);
    const nextHeadingMatch = /\n##\s+/.exec(rest);
    if (nextHeadingMatch) {
      const sectionEndIdx = afterHeadingIdx + nextHeadingMatch.index;
      const before = normalized.slice(0, sectionEndIdx).replace(/\n+$/, '');
      const after = normalized.slice(sectionEndIdx).replace(/^\n+/, '');
      return `${before}\n\n${block}\n\n${after}`.replace(/\n{3,}$/, '\n');
    }
    return `${normalized.replace(/\n+$/, '')}\n\n${block}\n`;
  }

  return `${normalized.replace(/\n+$/, '')}\n\n## Comments\n\n${block}\n`;
}

function escapeRegex(raw: string): string {
  return raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class NotesIndex {
  private notes: NoteEntry[] = [];
  private backlinksByTarget = new Map<string, BacklinkHit[]>();
  private backlinksByPaperKey = new Map<string, BacklinkHit[]>();
  private tagsIndex = new Map<string, NoteEntry[]>();
  private contentByAbsPath = new Map<string, string>();
  private texCitations: Array<{ relPath: string; keys: string[] }> = [];

  rebuild(projectRoot: string | null): void {
    this.notes = [];
    this.backlinksByTarget.clear();
    this.backlinksByPaperKey.clear();
    this.tagsIndex.clear();
    this.contentByAbsPath.clear();
    this.texCitations = [];

    if (!projectRoot) {
      return;
    }

    const notesDir = path.join(projectRoot, 'notes');
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

      this.contentByAbsPath.set(absPath, content);
      const { frontmatter } = parseMarkdownFrontmatter(content);
      const tags = extractMarkdownTags(content);
      const outgoingLinks: string[] = [];
      const lines = content.split(/\r?\n/);
      const lineCount = lines.length;
      const byteSize = Buffer.byteLength(content, 'utf8');
      const isBloated =
        !isUtilityHumanNote(relPath) &&
        (lineCount > CURATED_BRAIN_MAX_LINES || byteSize > CURATED_BRAIN_MAX_BYTES);

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
        aliases: frontmatter.aliases,
        frontmatterType: frontmatter.type,
        outgoingLinks,
        lineCount,
        byteSize,
        isBloated,
      };
      this.notes.push(entry);

      for (const tag of tags) {
        const list = this.tagsIndex.get(tag) || [];
        list.push(entry);
        this.tagsIndex.set(tag, list);
      }
    }

    // Populate note backlinks after all notes are indexed so aliases/slugs resolve accurately
    for (const note of this.notes) {
      const content = this.contentByAbsPath.get(note.absPath) || '';
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

    for (const absTex of this.walkFiles(paperDir, '.tex')) {
      const relPath = path.relative(projectRoot, absTex).replace(/\\/g, '/');
      let content = '';
      try {
        content = fs.readFileSync(absTex, 'utf8');
      } catch {
        continue;
      }
      const lines = content.split(/\r?\n/);
      const keysInFile = new Set<string>();
      lines.forEach((lineText, idx) => {
        LATEX_CITE_KEYS_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = LATEX_CITE_KEYS_RE.exec(lineText)) !== null) {
          for (const rawKey of m[1].split(',')) {
            const key = rawKey.trim();
            if (key) {
              keysInFile.add(key);
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
      this.texCitations.push({ relPath, keys: Array.from(keysInFile) });
    }

    this.notes.sort((a, b) => a.slug.localeCompare(b.slug));
  }

  getNotes(): NoteEntry[] {
    return this.notes;
  }

  getArtifacts(): NoteEntry[] {
    return this.notes
      .filter((n) => n.relPath.startsWith('notes/artifacts/'))
      .sort((a, b) => {
        try {
          const mtimeDiff = fs.statSync(b.absPath).mtimeMs - fs.statSync(a.absPath).mtimeMs;
          if (mtimeDiff !== 0) {
            return mtimeDiff;
          }
        } catch {
          // fall back to reverse filename sort
        }
        return b.slug.localeCompare(a.slug);
      });
  }

  getTagsMap(): Map<string, NoteEntry[]> {
    return this.tagsIndex;
  }

  resolveNoteTarget(target: string): NoteEntry | null {
    const clean = target
      .trim()
      .replace(/\\/g, '/')
      .replace(/^notes\//i, '')
      .replace(/\.md$/i, '')
      .toLowerCase();
    if (!clean) {
      return null;
    }
    return (
      this.notes.find((n) => n.slug.toLowerCase() === clean) ||
      this.notes.find((n) => n.slug.replace(/^concepts\//i, '').toLowerCase() === clean) ||
      this.notes.find((n) => n.title.toLowerCase() === clean) ||
      this.notes.find((n) => (n.aliases || []).some((a) => a.toLowerCase() === clean)) ||
      null
    );
  }

  getBacklinksForNote(absPath: string): BacklinkHit[] {
    return this.backlinksByTarget.get(absPath) || [];
  }

  getBacklinksForPaper(bibtexKey: string): BacklinkHit[] {
    return this.backlinksByPaperKey.get(bibtexKey) || [];
  }

  getOutgoingLinksForNote(absPath: string): Array<{
    kind: 'note' | 'ghost' | 'paper';
    label: string;
    targetAbsPath?: string;
    targetRelPath?: string;
    paperKey?: string;
  }> {
    const content = this.contentByAbsPath.get(absPath) || '';
    const seen = new Set<string>();
    const out: Array<{
      kind: 'note' | 'ghost' | 'paper';
      label: string;
      targetAbsPath?: string;
      targetRelPath?: string;
      paperKey?: string;
    }> = [];
    for (const line of content.split(/\r?\n/)) {
      for (const link of extractWikiLinksInLine(line)) {
        if (link.kind === 'paper') {
          const k = `paper:${link.target}`;
          if (seen.has(k)) continue;
          seen.add(k);
          out.push({ kind: 'paper', label: `@${link.target}`, paperKey: link.target });
        } else {
          const resolved = this.resolveNoteTarget(link.target);
          if (resolved && resolved.absPath === absPath) continue;
          const k = resolved ? `note:${resolved.relPath}` : `ghost:${link.target.toLowerCase()}`;
          if (seen.has(k)) continue;
          seen.add(k);
          if (resolved) {
            out.push({
              kind: 'note',
              label: resolved.title,
              targetAbsPath: resolved.absPath,
              targetRelPath: resolved.relPath,
            });
          } else {
            out.push({
              kind: 'ghost',
              label: link.target,
              targetRelPath: `notes/concepts/${sanitizeBrainSlug(link.target)}.md`,
            });
          }
        }
      }
    }
    return out;
  }

  getAutoBrainGroups(): {
    artifacts: NoteEntry[];
    concepts: NoteEntry[];
    notes: NoteEntry[];
  } {
    const artifacts = this.getArtifacts();
    const concepts = this.notes.filter(
      (n) =>
        (n.relPath.startsWith('notes/concepts/') || n.frontmatterType === 'concept') &&
        !n.relPath.startsWith('notes/artifacts/'),
    );
    const notes = this.notes.filter(
      (n) =>
        !n.relPath.startsWith('notes/artifacts/') &&
        !n.relPath.startsWith('notes/concepts/') &&
        n.frontmatterType !== 'concept',
    );
    return { artifacts, concepts, notes };
  }

  getUnlinkedMentionsForNote(absPath: string): UnlinkedMentionHit[] {
    const targetNote = this.notes.find((n) => n.absPath === absPath);
    if (!targetNote || isUtilityHumanNote(targetNote.relPath)) {
      return [];
    }
    const terms = Array.from(
      new Set(
        [targetNote.title, targetNote.title.replace(/[-_]+/g, ' '), ...(targetNote.aliases || [])]
          .map((t) => t.trim())
          .filter((t) => t.length >= 4),
      ),
    );
    if (terms.length === 0) {
      return [];
    }

    const pattern = new RegExp(`\\b(${terms.map(escapeRegex).join('|')})\\b`, 'i');
    const hits: UnlinkedMentionHit[] = [];

    for (const source of this.notes) {
      if (source.absPath === absPath || isUtilityHumanNote(source.relPath)) {
        continue;
      }
      const raw = this.contentByAbsPath.get(source.absPath) || '';
      const { bodyStartLine } = parseMarkdownFrontmatter(raw);
      const lines = raw.split(/\r?\n/);
      let inFence = false;
      lines.forEach((lineText, idx) => {
        if (idx < bodyStartLine) {
          return;
        }
        const trimmed = lineText.trim();
        if (trimmed.startsWith('```')) {
          inFence = !inFence;
          return;
        }
        if (inFence || trimmed.startsWith('#')) {
          return;
        }
        const stripped = lineText.replace(/!?\[\[[^\]\n]+\]\]/g, (m) => ' '.repeat(m.length));
        const m = pattern.exec(stripped);
        if (m) {
          hits.push({
            sourceRelPath: source.relPath,
            sourceAbsPath: source.absPath,
            targetSlug: targetNote.slug,
            targetRelPath: targetNote.relPath,
            matchedText: m[1],
            line: idx + 1,
            preview: trimmed,
          });
        }
      });
    }
    return hits;
  }

  buildBrainGraphPayload(
    projectRoot: string | null,
    papers: Paper[],
    options: {
      focusPath?: string | null;
      depth?: number;
      includeAgentBrain?: boolean;
    } = {},
  ): BrainGraphPayload {
    const nodeMap = new Map<string, BrainGraphNode>();
    const edges: BrainGraphEdge[] = [];
    const edgeSeen = new Set<string>();

    const addEdge = (source: string, target: string, kind: BrainGraphEdge['kind']) => {
      if (!source || !target || source === target) {
        return;
      }
      const key = `${source}->${target}:${kind}`;
      if (edgeSeen.has(key)) {
        return;
      }
      edgeSeen.add(key);
      edges.push({ source, target, kind });
    };

    const noteKind = (n: NoteEntry): BrainNodeKind => {
      if (n.relPath === 'notes/MOC.md' || n.frontmatterType === 'moc') return 'moc';
      if (n.relPath.startsWith('notes/artifacts/') || n.frontmatterType === 'artifact') return 'artifact';
      if (n.relPath.startsWith('notes/concepts/') || n.frontmatterType === 'concept') return 'concept';
      return 'note';
    };

    for (const n of this.notes) {
      const id = `note:${n.relPath}`;
      nodeMap.set(id, {
        id,
        label: n.title,
        kind: noteKind(n),
        path: n.relPath,
        tags: n.tags,
        aliases: n.aliases,
        degree: 0,
        backlinks: 0,
        lines: n.lineCount,
        bloated: n.isBloated,
      });
    }

    const paperByKey = new Map<string, Paper>();
    for (const p of papers) {
      if (!p.bibtex_key) continue;
      paperByKey.set(p.bibtex_key.toLowerCase(), p);
      const pid = `paper:${p.bibtex_key}`;
      nodeMap.set(pid, {
        id: pid,
        label: `@${p.bibtex_key}`,
        kind: 'paper',
        path: `refs/text/${p.bibtex_key}.md`,
        tags: p.tags || [],
        degree: 0,
        backlinks: 0,
        snippet: p.title,
      });
    }

    const ensurePaper = (key: string): string => {
      const found = paperByKey.get(key.toLowerCase());
      const pid = `paper:${found ? found.bibtex_key : key}`;
      if (!nodeMap.has(pid)) {
        nodeMap.set(pid, {
          id: pid,
          label: `@${key}`,
          kind: 'paper',
          path: '',
          tags: [],
          degree: 0,
          backlinks: 0,
        });
      }
      return pid;
    };

    for (const n of this.notes) {
      const srcId = `note:${n.relPath}`;
      const raw = this.contentByAbsPath.get(n.absPath) || '';
      for (const line of raw.split(/\r?\n/)) {
        for (const link of extractWikiLinksInLine(line)) {
          if (link.kind === 'paper') {
            addEdge(srcId, ensurePaper(link.target), 'cite');
          } else {
            const resolved = this.resolveNoteTarget(link.target);
            if (resolved) {
              addEdge(srcId, `note:${resolved.relPath}`, 'wikilink');
            } else {
              const ghostSlug = sanitizeBrainSlug(link.target);
              const gid = `ghost:${ghostSlug}`;
              if (!nodeMap.has(gid)) {
                nodeMap.set(gid, {
                  id: gid,
                  label: link.target,
                  kind: 'ghost',
                  path: `notes/concepts/${ghostSlug}.md`,
                  tags: [],
                  degree: 0,
                  backlinks: 0,
                });
              }
              addEdge(srcId, gid, 'wikilink');
            }
          }
        }
      }
    }

    for (const tex of this.texCitations) {
      const tid = `tex:${tex.relPath}`;
      nodeMap.set(tid, {
        id: tid,
        label: path.posix.basename(tex.relPath),
        kind: 'tex',
        path: tex.relPath,
        tags: [],
        degree: 0,
        backlinks: 0,
      });
      for (const k of tex.keys) {
        addEdge(tid, ensurePaper(k), 'cite');
      }
    }

    if (projectRoot) {
      const provPath = path.join(projectRoot, '.dupe', 'provenance.json');
      try {
        const rawProv = fs.readFileSync(provPath, 'utf8');
        const entries = JSON.parse(rawProv) as Array<{ source_script?: string; target_path?: string }>;
        if (Array.isArray(entries)) {
          for (const pr of entries) {
            if (!pr.source_script || !pr.target_path) continue;
            const cid = `code:${pr.source_script}`;
            if (!nodeMap.has(cid)) {
              nodeMap.set(cid, {
                id: cid,
                label: path.posix.basename(pr.source_script),
                kind: 'code',
                path: pr.source_script,
                tags: [],
                degree: 0,
                backlinks: 0,
              });
            }
            const aid = `tex:${pr.target_path}`;
            if (!nodeMap.has(aid)) {
              nodeMap.set(aid, {
                id: aid,
                label: path.posix.basename(pr.target_path),
                kind: 'tex',
                path: pr.target_path,
                tags: [],
                degree: 0,
                backlinks: 0,
              });
            }
            addEdge(cid, aid, 'provenance');
          }
        }
      } catch {
        // provenance optional
      }

      if (options.includeAgentBrain) {
        const brainDir = path.join(projectRoot, '.dupe', 'brain');
        for (const absPath of this.walkFiles(brainDir, '.md')) {
          const relPath = path.relative(projectRoot, absPath).replace(/\\/g, '/');
          let content = '';
          try {
            content = fs.readFileSync(absPath, 'utf8');
          } catch {
            continue;
          }
          const bid = `blackboard:${relPath}`;
          nodeMap.set(bid, {
            id: bid,
            label: path.basename(absPath, '.md'),
            kind: 'blackboard',
            path: relPath,
            tags: extractMarkdownTags(content),
            degree: 0,
            backlinks: 0,
            lines: content.split(/\r?\n/).length,
          });
          for (const line of content.split(/\r?\n/)) {
            for (const link of extractWikiLinksInLine(line)) {
              if (link.kind === 'paper') {
                addEdge(bid, ensurePaper(link.target), 'cite');
              } else {
                const resolved = this.resolveNoteTarget(link.target);
                if (resolved) {
                  addEdge(bid, `note:${resolved.relPath}`, 'wikilink');
                }
              }
            }
          }
        }
      }
    }

    for (const e of edges) {
      const src = nodeMap.get(e.source);
      const dst = nodeMap.get(e.target);
      if (src) src.degree++;
      if (dst) {
        dst.degree++;
        dst.backlinks++;
      }
    }

    let summaryCurated = 0;
    let summaryArtifacts = 0;
    let summaryBlackboard = 0;
    let summaryOrphans = 0;
    let summaryGhosts = 0;
    let summaryBloated = 0;
    for (const n of nodeMap.values()) {
      if (n.kind === 'note' || n.kind === 'concept' || n.kind === 'moc') summaryCurated++;
      else if (n.kind === 'artifact') summaryArtifacts++;
      else if (n.kind === 'blackboard') summaryBlackboard++;
      else if (n.kind === 'ghost') summaryGhosts++;
      if (n.bloated) summaryBloated++;
      if ((n.kind === 'note' || n.kind === 'concept' || n.kind === 'artifact') && !isUtilityHumanNote(n.path) && n.degree === 0) {
        summaryOrphans++;
      }
    }

    let focusNodeId: string | null = null;
    if (options.focusPath && projectRoot) {
      const rel = path.relative(projectRoot, options.focusPath).replace(/\\/g, '/');
      for (const candidate of [`note:${rel}`, `tex:${rel}`, `blackboard:${rel}`, `code:${rel}`]) {
        if (nodeMap.has(candidate)) {
          focusNodeId = candidate;
          break;
        }
      }
    } else if (options.focusPath && nodeMap.has(options.focusPath)) {
      focusNodeId = options.focusPath;
    }

    let nodesOut = Array.from(nodeMap.values());
    let edgesOut = edges;

    if (focusNodeId && (options.depth ?? 0) > 0) {
      const depth = options.depth ?? 2;
      const keep = new Set<string>([focusNodeId]);
      let frontier = [focusNodeId];
      for (let hop = 0; hop < depth && frontier.length > 0; hop++) {
        const next: string[] = [];
        for (const cur of frontier) {
          for (const e of edges) {
            if (e.source === cur && !keep.has(e.target)) {
              keep.add(e.target);
              next.push(e.target);
            } else if (e.target === cur && !keep.has(e.source)) {
              keep.add(e.source);
              next.push(e.source);
            }
          }
        }
        frontier = next;
      }
      nodesOut = nodesOut.filter((n) => keep.has(n.id));
      edgesOut = edgesOut.filter((e) => keep.has(e.source) && keep.has(e.target));
    }

    return {
      nodes: nodesOut,
      edges: edgesOut,
      focusNodeId,
      summary: {
        curatedNoteCount: summaryCurated,
        artifactCount: summaryArtifacts,
        blackboardCount: summaryBlackboard,
        orphanCount: summaryOrphans,
        ghostCount: summaryGhosts,
        bloatedCount: summaryBloated,
      },
    };
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
