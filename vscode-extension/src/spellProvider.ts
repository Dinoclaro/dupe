import path from 'node:path';
import * as vscode from 'vscode';
import { findDupeProjectRoot } from './projectLocator';
import {
  SpellDictionary,
  appendWordToProjectDictionary,
  extractSpellableWords,
  loadProjectDictionaryFile,
} from './spellCheck';

const SPELL_LANGUAGES = new Set(['latex', 'tex', 'markdown']);
const MAX_DIAGNOSTICS_PER_FILE = 400;

export class DupeSpellProvider implements vscode.CodeActionProvider, vscode.Disposable {
  private readonly diagnostics = vscode.languages.createDiagnosticCollection('dupe-spell');
  private readonly dictCache = new Map<'en-US' | 'en-GB', SpellDictionary>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly getActiveProjectRoot: () => string | null,
  ) {}

  dispose(): void {
    for (const t of this.timers.values()) {
      clearTimeout(t);
    }
    this.timers.clear();
    this.diagnostics.dispose();
  }

  private getConfig(): { enabled: boolean; dialect: 'en-US' | 'en-GB'; extraWords: string[] } {
    const cfg = vscode.workspace.getConfiguration('dupe');
    const enabled = cfg.get<boolean>('spellCheck.enabled', true);
    const rawDialect = cfg.get<string>('spellCheck.dialect', 'en-US');
    const dialect = rawDialect === 'en-GB' ? 'en-GB' : 'en-US';
    const extraWords = cfg.get<string[]>('spellCheck.extraWords', []) || [];
    return { enabled, dialect, extraWords };
  }

  private getDictionary(projectRoot: string | null): SpellDictionary {
    const { dialect, extraWords } = this.getConfig();
    let dict = this.dictCache.get(dialect);
    if (!dict) {
      const gzPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'dict', `${dialect}.txt.gz`).fsPath;
      const sysFallback =
        dialect === 'en-GB' ? '/usr/share/dict/british-english' : '/usr/share/dict/american-english';
      dict = SpellDictionary.loadFromGzipFile(gzPath, sysFallback);
      this.dictCache.set(dialect, dict);
    }
    const projectWords = loadProjectDictionaryFile(projectRoot);
    dict.setCustomWords([...extraWords, ...projectWords]);
    return dict;
  }

  refreshAllOpenDocuments(): void {
    const { enabled } = this.getConfig();
    if (!enabled) {
      this.diagnostics.clear();
      return;
    }
    for (const doc of vscode.workspace.textDocuments) {
      this.checkDocument(doc);
    }
  }

  scheduleCheck(doc: vscode.TextDocument): void {
    if (!SPELL_LANGUAGES.has(doc.languageId) || doc.uri.scheme !== 'file') {
      return;
    }
    const key = doc.uri.toString();
    const prev = this.timers.get(key);
    if (prev) {
      clearTimeout(prev);
    }
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        this.checkDocument(doc);
      }, 350),
    );
  }

  clearDocument(uri: vscode.Uri): void {
    const key = uri.toString();
    const prev = this.timers.get(key);
    if (prev) {
      clearTimeout(prev);
      this.timers.delete(key);
    }
    this.diagnostics.delete(uri);
  }

  checkDocument(doc: vscode.TextDocument): void {
    if (!SPELL_LANGUAGES.has(doc.languageId) || doc.uri.scheme !== 'file') {
      return;
    }
    const { enabled } = this.getConfig();
    if (!enabled) {
      this.diagnostics.delete(doc.uri);
      return;
    }

    const docProjectRoot =
      findDupeProjectRoot(path.dirname(doc.uri.fsPath)) || this.getActiveProjectRoot();
    const dict = this.getDictionary(docProjectRoot);
    const tokens = extractSpellableWords(doc.getText(), doc.languageId);

    const diags: vscode.Diagnostic[] = [];
    for (const tok of tokens) {
      if (dict.isWordValid(tok.word)) {
        continue;
      }
      const range = new vscode.Range(
        doc.positionAt(tok.startOffset),
        doc.positionAt(tok.endOffset),
      );
      const diag = new vscode.Diagnostic(
        range,
        `Unknown word: "${tok.word}"`,
        vscode.DiagnosticSeverity.Information,
      );
      diag.source = 'dupe spell';
      diag.code = 'dupe-spell';
      diags.push(diag);
      if (diags.length >= MAX_DIAGNOSTICS_PER_FILE) {
        break;
      }
    }
    this.diagnostics.set(doc.uri, diags);
  }

  provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    const spellDiags = context.diagnostics.filter((d) => d.code === 'dupe-spell');
    if (spellDiags.length === 0) {
      return [];
    }
    const docProjectRoot =
      findDupeProjectRoot(path.dirname(document.uri.fsPath)) || this.getActiveProjectRoot();
    const dict = this.getDictionary(docProjectRoot);
    const actions: vscode.CodeAction[] = [];

    for (const diag of spellDiags) {
      const word = document.getText(diag.range);
      if (!word) {
        continue;
      }
      const suggestions = dict.suggest(word, 5);
      suggestions.forEach((sug, idx) => {
        const fix = new vscode.CodeAction(
          `Replace with "${sug}"`,
          vscode.CodeActionKind.QuickFix,
        );
        const edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, diag.range, sug);
        fix.edit = edit;
        fix.diagnostics = [diag];
        if (idx === 0) {
          fix.isPreferred = true;
        }
        actions.push(fix);
      });

      if (docProjectRoot) {
        const projAction = new vscode.CodeAction(
          `Add "${word}" to project dictionary (.dupe/dictionary.txt)`,
          vscode.CodeActionKind.QuickFix,
        );
        projAction.command = {
          command: 'dupe.addWordToProjectDict',
          title: 'Add to Project Dictionary',
          arguments: [word, docProjectRoot],
        };
        projAction.diagnostics = [diag];
        actions.push(projAction);
      }

      const userAction = new vscode.CodeAction(
        `Add "${word}" to user dictionary`,
        vscode.CodeActionKind.QuickFix,
      );
      userAction.command = {
        command: 'dupe.addWordToUserDict',
        title: 'Add to User Dictionary',
        arguments: [word],
      };
      userAction.diagnostics = [diag];
      actions.push(userAction);
    }

    return actions;
  }

  async addToProjectDictionary(word: string, explicitRoot?: string): Promise<void> {
    const root = explicitRoot || this.getActiveProjectRoot();
    if (!root || !word.trim()) {
      return;
    }
    appendWordToProjectDictionary(root, word.trim());
    this.refreshAllOpenDocuments();
  }

  async addToUserDictionary(word: string): Promise<void> {
    const clean = word.trim();
    if (!clean) {
      return;
    }
    const cfg = vscode.workspace.getConfiguration('dupe');
    const existing = cfg.get<string[]>('spellCheck.extraWords', []) || [];
    if (!existing.some((w) => w.toLowerCase() === clean.toLowerCase())) {
      await cfg.update(
        'spellCheck.extraWords',
        [...existing, clean],
        vscode.ConfigurationTarget.Global,
      );
    }
    this.refreshAllOpenDocuments();
  }
}
