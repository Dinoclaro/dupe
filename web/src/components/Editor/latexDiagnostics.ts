import { RangeSetBuilder, StateEffect, StateField } from '@codemirror/state';
import {
  Decoration,
  DecorationSet,
  EditorView,
  GutterMarker,
  gutter,
} from '@codemirror/view';
import { CompileProjectResponse, LatexDiagnostic } from '../../api/client';

export const setLatexDiagnosticsEffect = StateEffect.define<LatexDiagnostic[]>();

function stripLatexComments(rawLine: string): string {
  let out = '';
  for (let i = 0; i < rawLine.length; i++) {
    const ch = rawLine[i];
    if (ch === '\\' && i + 1 < rawLine.length) {
      out += ch + rawLine[i + 1];
      i++;
      continue;
    }
    if (ch === '%') {
      break;
    }
    out += ch;
  }
  return out;
}

export function checkLatexStructure(
  source: string,
  fileLabel: string,
): LatexDiagnostic[] {
  const diagnostics: LatexDiagnostic[] = [];
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const envStack: Array<{ name: string; line: number }> = [];
  const braceStack: number[] = [];
  let inVerbatim = false;

  for (let idx = 0; idx < lines.length; idx++) {
    const lineNum = idx + 1;
    const line = lines[idx];

    if (inVerbatim) {
      if (/\\end\{verbatim\*?\}/.test(line)) {
        inVerbatim = false;
      }
      continue;
    }
    if (/\\begin\{verbatim\*?\}/.test(line)) {
      inVerbatim = true;
      continue;
    }

    const clean = stripLatexComments(line).replace(/\\verb\*?([^\s]).*?\1/g, '');
    const envMatches = clean.matchAll(/\\(begin|end)\{([A-Za-z0-9_*]+)\}/g);
    for (const m of envMatches) {
      const kind = m[1];
      const name = m[2];
      if (kind === 'begin') {
        envStack.push({ name, line: lineNum });
      } else {
        const top = envStack[envStack.length - 1];
        if (!top) {
          diagnostics.push({
            level: 'error',
            file: fileLabel,
            line: lineNum,
            message: `Unexpected \\end{${name}} without matching \\begin{${name}}`,
            source: 'client',
            category: 'syntax',
          });
        } else if (top.name !== name) {
          diagnostics.push({
            level: 'error',
            file: fileLabel,
            line: lineNum,
            message: `Mismatched \\end{${name}} (expected \\end{${top.name}} opened on line ${top.line})`,
            source: 'client',
            category: 'syntax',
          });
          envStack.pop();
        } else {
          envStack.pop();
        }
      }
    }

    for (let i = 0; i < clean.length; i++) {
      const ch = clean[i];
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === '{') {
        braceStack.push(lineNum);
      } else if (ch === '}') {
        if (braceStack.length === 0) {
          diagnostics.push({
            level: 'error',
            file: fileLabel,
            line: lineNum,
            message: 'Unmatched closing brace "}"',
            source: 'client',
            category: 'syntax',
          });
          break;
        }
        braceStack.pop();
      }
    }
  }

  if (envStack.length > 0 && diagnostics.length < 4) {
    const unclosed = envStack[envStack.length - 1];
    diagnostics.push({
      level: 'error',
      file: fileLabel,
      line: unclosed.line,
      message: `Unclosed \\begin{${unclosed.name}} (missing \\end{${unclosed.name}})`,
      source: 'client',
      category: 'syntax',
    });
  }
  if (braceStack.length > 0 && diagnostics.length < 6) {
    const unclosedBraceLine = braceStack[braceStack.length - 1];
    diagnostics.push({
      level: 'error',
      file: fileLabel,
      line: unclosedBraceLine,
      message: 'Unclosed opening brace "{"',
      source: 'client',
      category: 'syntax',
    });
  }

  return diagnostics;
}

export function normalizeDiagnosticRelPath(diagFile: string): string {
  const clean = (diagFile || '').replace(/^\.\//, '');
  if (!clean) {
    return '';
  }
  return clean.startsWith('paper/') ? clean : `paper/${clean}`;
}

export function matchDiagnosticsForFile(
  compileResult: CompileProjectResponse | null,
  fileLabel: string,
): LatexDiagnostic[] {
  if (!compileResult) {
    return [];
  }
  const matchesFile = (diagFile: string) => {
    const normalized = normalizeDiagnosticRelPath(diagFile);
    return normalized === fileLabel || diagFile === fileLabel;
  };
  const errs = (compileResult.errors || []).filter((d) => matchesFile(d.file));
  const warns = (compileResult.warnings || []).filter(
    (d) => matchesFile(d.file) && d.category !== 'typography',
  );
  return [...errs, ...warns];
}

class LatexDiagGutterMarker extends GutterMarker {
  constructor(
    private readonly level: 'error' | 'warning',
    private readonly tooltipText: string,
  ) {
    super();
  }

  eq(other: LatexDiagGutterMarker): boolean {
    return this.level === other.level && this.tooltipText === other.tooltipText;
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = `cm-diag-gutter-icon ${this.level}`;
    span.title = this.tooltipText;
    span.textContent = this.level === 'error' ? '✕' : '▲';
    return span;
  }
}

const diagStateField = StateField.define<LatexDiagnostic[]>({
  create: () => [],
  update(diags, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setLatexDiagnosticsEffect)) {
        return effect.value;
      }
    }
    return diags;
  },
});

const diagDecorationsField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decos, tr) {
    const updated = tr.effects.find((e) => e.is(setLatexDiagnosticsEffect));
    if (!updated) {
      return decos.map(tr.changes);
    }
    const items = updated.value;
    if (items.length === 0) {
      return Decoration.none;
    }
    const byLine = new Map<number, LatexDiagnostic>();
    for (const item of items) {
      const ln = item.line || 1;
      const prev = byLine.get(ln);
      if (!prev || (prev.level !== 'error' && item.level === 'error')) {
        byLine.set(ln, item);
      }
    }
    const builder = new RangeSetBuilder<Decoration>();
    const sortedLines = Array.from(byLine.keys()).sort((a, b) => a - b);
    for (const ln of sortedLines) {
      if (ln < 1 || ln > tr.state.doc.lines) {
        continue;
      }
      const lineInfo = tr.state.doc.line(ln);
      const diag = byLine.get(ln)!;
      const lineClass = diag.level === 'error' ? 'cm-tex-error-line' : 'cm-tex-warn-line';
      builder.add(
        lineInfo.from,
        lineInfo.from,
        Decoration.line({
          class: lineClass,
          attributes: { title: diag.message },
        }),
      );
      if (lineInfo.to > lineInfo.from) {
        const markClass = diag.level === 'error' ? 'cm-tex-error-mark' : 'cm-tex-warn-mark';
        builder.add(
          lineInfo.from,
          lineInfo.to,
          Decoration.mark({
            class: markClass,
            attributes: { title: diag.message },
          }),
        );
      }
    }
    return builder.finish();
  },
  provide: (field) => EditorView.decorations.from(field),
});

const diagGutter = gutter({
  class: 'cm-diag-gutter',
  markers(view) {
    const items = view.state.field(diagStateField);
    if (items.length === 0) {
      return new RangeSetBuilder<GutterMarker>().finish();
    }
    const grouped = new Map<number, { level: 'error' | 'warning'; lines: string[] }>();
    for (const item of items) {
      const ln = Math.min(Math.max(1, item.line || 1), view.state.doc.lines);
      const cur = grouped.get(ln);
      const prefix = item.source === 'client' ? '[Syntax] ' : '';
      const text = `${prefix}${item.message}${item.context ? ` (${item.context})` : ''}`;
      if (!cur) {
        grouped.set(ln, { level: item.level, lines: [text] });
      } else {
        if (item.level === 'error') {
          cur.level = 'error';
        }
        cur.lines.push(text);
      }
    }
    const builder = new RangeSetBuilder<GutterMarker>();
    const sorted = Array.from(grouped.keys()).sort((a, b) => a - b);
    for (const ln of sorted) {
      const lineInfo = view.state.doc.line(ln);
      const g = grouped.get(ln)!;
      builder.add(lineInfo.from, lineInfo.from, new LatexDiagGutterMarker(g.level, g.lines.join('\n')));
    }
    return builder.finish();
  },
  initialSpacer: () => new LatexDiagGutterMarker('warning', ''),
});

export const latexDiagnosticExtensions = [
  diagStateField,
  diagDecorationsField,
  diagGutter,
];
