import { RangeSetBuilder, StateEffect, StateField } from '@codemirror/state';
import {
  Decoration,
  DecorationSet,
  EditorView,
  GutterMarker,
  gutter,
} from '@codemirror/view';

export interface ParsedProjectComment {
  open: boolean;
  file: string;
  line: number | null;
  quote: string;
  comment: string;
  timestamp: string;
}

export interface ResolvedCommentAnchor {
  comment: ParsedProjectComment;
  line: number;
  from: number | null;
  to: number | null;
}

export function parseProjectComments(commentsMd: string): ParsedProjectComment[] {
  if (!commentsMd.trim()) {
    return [];
  }
  const lines = commentsMd.replace(/\r\n/g, '\n').split('\n');
  const results: ParsedProjectComment[] = [];

  let current: ParsedProjectComment | null = null;
  const flush = () => {
    if (current && current.file) {
      results.push(current);
    }
    current = null;
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    const isOpen = trimmed.startsWith('- [ ] ');
    const isClosed = trimmed.startsWith('- [x] ') || trimmed.startsWith('- [X] ');
    if (isOpen || isClosed) {
      flush();
      const targetMatch = trimmed.match(/`([^`]+)`/);
      const timeMatch = trimmed.match(/\[(\d{4}-\d{2}-\d{2}[^\]]*)\]/);
      const lineMatch = trimmed.match(/\(lines?\s+(\d+)/i);
      current = {
        open: isOpen,
        file: targetMatch ? targetMatch[1].trim() : '',
        line: lineMatch ? Number.parseInt(lineMatch[1], 10) : null,
        quote: '',
        comment: '',
        timestamp: timeMatch ? timeMatch[1].trim() : '',
      };
      continue;
    }
    if (!current) {
      continue;
    }
    if (trimmed.startsWith('>')) {
      const q = trimmed
        .replace(/^>\s*/, '')
        .replace(/^"/, '')
        .replace(/"$/, '')
        .replace(/…$/, '')
        .trim();
      current.quote = current.quote ? `${current.quote} ${q}` : q;
      continue;
    }
    if (trimmed.startsWith('**Comment:**')) {
      current.comment = trimmed.replace(/^\*\*Comment:\*\*\s*/, '').trim();
      continue;
    }
    if (trimmed.startsWith('#')) {
      flush();
    }
  }
  flush();
  return results;
}

export function buildCommentCountMap(
  commentsMd: string,
): Record<string, { open: number; addressed: number }> {
  const counts: Record<string, { open: number; addressed: number }> = {};
  for (const c of parseProjectComments(commentsMd)) {
    if (!c.file) {
      continue;
    }
    if (!counts[c.file]) {
      counts[c.file] = { open: 0, addressed: 0 };
    }
    if (c.open) {
      counts[c.file].open += 1;
    } else {
      counts[c.file].addressed += 1;
    }
  }
  return counts;
}

export function resolveCommentAnchors(
  commentsMd: string,
  filePath: string,
  docText: string,
): ResolvedCommentAnchor[] {
  const all = parseProjectComments(commentsMd).filter((c) => c.file === filePath);
  if (all.length === 0) {
    return [];
  }

  const lineStarts: number[] = [0];
  for (let i = 0; i < docText.length; i++) {
    if (docText.charCodeAt(i) === 10) {
      lineStarts.push(i + 1);
    }
  }
  const offsetToLine = (offset: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lineStarts[mid] <= offset) {
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return Math.max(1, hi + 1);
  };

  return all
    .map((c): ResolvedCommentAnchor | null => {
      if (c.quote.length >= 6) {
        const probe = c.quote.slice(0, 120);
        const idx = docText.indexOf(probe);
        if (idx !== -1) {
          const endIdx = Math.min(docText.length, idx + c.quote.length);
          return {
            comment: c,
            line: offsetToLine(idx),
            from: idx,
            to: endIdx,
          };
        }
      }
      if (c.line && c.line >= 1 && c.line <= lineStarts.length) {
        const lineStart = lineStarts[c.line - 1];
        const nextBreak = docText.indexOf('\n', lineStart);
        const lineEnd = nextBreak === -1 ? docText.length : nextBreak;
        return {
          comment: c,
          line: c.line,
          from: lineStart < lineEnd ? lineStart : null,
          to: lineStart < lineEnd ? lineEnd : null,
        };
      }
      return null;
    })
    .filter((a): a is ResolvedCommentAnchor => a !== null);
}

class CommentGutterMarker extends GutterMarker {
  constructor(
    private readonly openCount: number,
    private readonly addressedCount: number,
    private readonly tooltip: string,
  ) {
    super();
  }

  eq(other: CommentGutterMarker): boolean {
    return (
      other.openCount === this.openCount &&
      other.addressedCount === this.addressedCount &&
      other.tooltip === this.tooltip
    );
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className =
      this.openCount > 0 ? 'cm-comment-gutter-icon open' : 'cm-comment-gutter-icon addressed';
    span.textContent = this.openCount > 0 ? '💬' : '✓';
    span.title = this.tooltip;
    return span;
  }
}

export const setCommentAnchorsEffect = StateEffect.define<ResolvedCommentAnchor[]>();

const commentAnchorsField = StateField.define<ResolvedCommentAnchor[]>({
  create: () => [],
  update(value, tr) {
    for (const eff of tr.effects) {
      if (eff.is(setCommentAnchorsEffect)) {
        return eff.value;
      }
    }
    return value;
  },
});

const commentHighlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decos, tr) {
    for (const eff of tr.effects) {
      if (eff.is(setCommentAnchorsEffect)) {
        const builder = new RangeSetBuilder<Decoration>();
        const docLen = tr.state.doc.length;
        const sorted = [...eff.value]
          .filter((a) => a.from !== null && a.to !== null && a.from < a.to && a.to <= docLen)
          .sort((a, b) => (a.from! - b.from!) || (a.to! - b.to!));
        let prevTo = -1;
        for (const a of sorted) {
          if (a.from! < prevTo) {
            continue;
          }
          builder.add(
            a.from!,
            a.to!,
            Decoration.mark({
              class: a.comment.open ? 'cm-comment-range-open' : 'cm-comment-range-addressed',
              attributes: {
                title: `${a.comment.open ? 'Open comment' : 'Addressed comment'}: ${a.comment.comment}`,
              },
            }),
          );
          prevTo = a.to!;
        }
        return builder.finish();
      }
    }
    return decos.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

export const commentMarkerExtensions = [
  commentAnchorsField,
  commentHighlightField,
  gutter({
    class: 'cm-comment-gutter',
    lineMarker(view, line) {
      const anchors = view.state.field(commentAnchorsField, false) || [];
      if (anchors.length === 0) {
        return null;
      }
      const lineNum = view.state.doc.lineAt(line.from).number;
      const matching = anchors.filter((a) => a.line === lineNum);
      if (matching.length === 0) {
        return null;
      }
      const openCount = matching.filter((a) => a.comment.open).length;
      const addressedCount = matching.length - openCount;
      const tooltip = matching
        .map(
          (a) =>
            `${a.comment.open ? '[Open]' : '[Addressed]'} ${a.comment.comment}${
              a.comment.quote ? `\n> "${a.comment.quote}"` : ''
            }`,
        )
        .join('\n---\n');
      return new CommentGutterMarker(openCount, addressedCount, tooltip);
    },
    initialSpacer: () => new CommentGutterMarker(1, 0, ''),
  }),
];
