import fs from 'node:fs';
import * as vscode from 'vscode';
import { detectCitationTrigger, findCitationKeysInLine } from './citations';
import { NotesIndex, extractWikiLinksInLine } from './notesIndex';
import { BibMetadata } from './types';

export class DupeCitationFeatures
  implements
    vscode.CompletionItemProvider,
    vscode.HoverProvider,
    vscode.DocumentLinkProvider,
    vscode.DefinitionProvider
{
  constructor(
    private readonly getBibMap: () => Map<string, BibMetadata>,
    private readonly notesIndex: NotesIndex,
  ) {}

  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.CompletionItem[] | undefined {
    const linePrefix = document.lineAt(position.line).text.slice(0, position.character);
    const trigger = detectCitationTrigger(linePrefix, document.languageId);
    if (!trigger) {
      return undefined;
    }

    const replaceRange = new vscode.Range(
      position.line,
      trigger.replaceStartOffset,
      position.line,
      position.character,
    );

    if (trigger.kind === 'latex' || trigger.kind === 'markdown_paper') {
      const items: vscode.CompletionItem[] = [];
      for (const meta of this.getBibMap().values()) {
        const item = new vscode.CompletionItem(meta.key, vscode.CompletionItemKind.Reference);
        const year = meta.year ? ` (${meta.year})` : '';
        item.detail = `${meta.authors || 'Unknown'}${year}`;
        const docs = new vscode.MarkdownString();
        docs.appendMarkdown(`**${meta.title}**\n\n`);
        if (meta.raw) {
          docs.appendCodeblock(meta.raw, 'bibtex');
        }
        item.documentation = docs;
        item.filterText = `${meta.key} ${meta.title} ${meta.authors}`;
        item.insertText = meta.key;
        item.range = replaceRange;
        items.push(item);
      }
      return items;
    }

    if (trigger.kind === 'markdown_wiki') {
      const items: vscode.CompletionItem[] = [];
      const hasClosingBrackets = document.lineAt(position.line).text.slice(position.character).startsWith(']]');
      const suffix = hasClosingBrackets ? '' : ']]';

      for (const note of this.notesIndex.getNotes()) {
        const item = new vscode.CompletionItem(note.slug, vscode.CompletionItemKind.File);
        item.detail = note.relPath;
        item.filterText = `${note.slug} ${note.title} ${note.tags.join(' ')}`;
        item.insertText = `${note.slug}${suffix}`;
        item.range = replaceRange;
        items.push(item);
      }

      for (const diag of this.notesIndex.getDiagrams()) {
        const item = new vscode.CompletionItem(diag.relPath, vscode.CompletionItemKind.Color);
        item.detail = 'Diagram';
        item.insertText = `${diag.relPath}${suffix}`;
        item.range = replaceRange;
        items.push(item);
      }

      for (const meta of this.getBibMap().values()) {
        const label = `paper:${meta.key}`;
        const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Reference);
        item.detail = `${meta.title}${meta.year ? ` (${meta.year})` : ''}`;
        item.filterText = `paper:${meta.key} ${meta.title} ${meta.authors}`;
        item.insertText = `${label}${suffix}`;
        item.range = replaceRange;
        items.push(item);
      }
      return items;
    }

    if (trigger.kind === 'markdown_tag') {
      const items: vscode.CompletionItem[] = [];
      for (const [tag, matching] of this.notesIndex.getTagsMap().entries()) {
        const item = new vscode.CompletionItem(tag, vscode.CompletionItemKind.Keyword);
        item.detail = `${matching.length} note(s)`;
        item.insertText = tag;
        item.range = replaceRange;
        items.push(item);
      }
      return items;
    }

    return undefined;
  }

  provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
    const lineText = document.lineAt(position.line).text;
    const bibMap = this.getBibMap();

    const citeHit = findCitationKeysInLine(lineText).find(
      (occ) => position.character >= occ.startOffset && position.character <= occ.endOffset,
    );
    if (citeHit) {
      const meta = bibMap.get(citeHit.key);
      const md = new vscode.MarkdownString(undefined, true);
      md.isTrusted = true;
      if (!meta) {
        md.appendMarkdown(`Citation key \`${citeHit.key}\` not found in project .bib or library.`);
      } else {
        const year = meta.year ? ` (${meta.year})` : '';
        md.appendMarkdown(`**${meta.title}**\n\n`);
        if (meta.authors) {
          md.appendMarkdown(`*${meta.authors}*${year}\n\n`);
        }
        if (meta.doi) {
          md.appendMarkdown(`DOI: \`${meta.doi}\`\n\n`);
        }
        if (meta.paperId) {
          const args = encodeURIComponent(JSON.stringify([meta.key]));
          md.appendMarkdown(`[Open PDF in VS Code](command:dupe.openPaperByKey?${args})\n\n`);
        }
        if (meta.raw) {
          md.appendCodeblock(meta.raw, 'bibtex');
        }
      }
      return new vscode.Hover(
        md,
        new vscode.Range(position.line, citeHit.startOffset, position.line, citeHit.endOffset),
      );
    }

    if (document.languageId === 'markdown') {
      const wikiHit = extractWikiLinksInLine(lineText).find(
        (w) => w.kind !== 'paper' && position.character >= w.startOffset && position.character <= w.endOffset,
      );
      if (wikiHit) {
        const md = new vscode.MarkdownString(undefined, true);
        md.isTrusted = true;
        if (wikiHit.kind === 'diagram') {
          const diag = this.notesIndex.resolveDiagramTarget(wikiHit.target);
          md.appendMarkdown(diag ? `**Diagram:** \`${diag.relPath}\`` : `Diagram \`${wikiHit.target}\` (will create on click)`);
        } else {
          const note = this.notesIndex.resolveNoteTarget(wikiHit.target);
          if (note) {
            let preview = '';
            try {
              preview = fs.readFileSync(note.absPath, 'utf8').split(/\r?\n/).slice(0, 20).join('\n');
            } catch {
              preview = '';
            }
            md.appendMarkdown(`**${note.relPath}**\n\n`);
            if (preview) {
              md.appendMarkdown(preview);
            }
          } else {
            md.appendMarkdown(`Note **${wikiHit.target}** does not exist yet — *Ctrl+Click to create*`);
          }
        }
        return new vscode.Hover(
          md,
          new vscode.Range(position.line, wikiHit.startOffset, position.line, wikiHit.endOffset),
        );
      }
    }

    return undefined;
  }

  provideDocumentLinks(document: vscode.TextDocument): vscode.DocumentLink[] {
    const bibMap = this.getBibMap();
    const links: vscode.DocumentLink[] = [];

    for (let lineIdx = 0; lineIdx < document.lineCount; lineIdx++) {
      const lineText = document.lineAt(lineIdx).text;

      for (const occ of findCitationKeysInLine(lineText)) {
        const meta = bibMap.get(occ.key);
        if (!meta?.paperId) {
          continue;
        }
        const range = new vscode.Range(lineIdx, occ.startOffset, lineIdx, occ.endOffset);
        const args = encodeURIComponent(JSON.stringify([occ.key]));
        const link = new vscode.DocumentLink(range, vscode.Uri.parse(`command:dupe.openPaperByKey?${args}`));
        link.tooltip = `Open PDF: ${meta.title}`;
        links.push(link);
      }

      if (document.languageId === 'markdown') {
        for (const w of extractWikiLinksInLine(lineText)) {
          if (w.kind === 'paper') {
            continue;
          }
          const range = new vscode.Range(lineIdx, w.startOffset, lineIdx, w.endOffset);
          const args = encodeURIComponent(JSON.stringify([w.target, w.kind]));
          const link = new vscode.DocumentLink(
            range,
            vscode.Uri.parse(`command:dupe.openOrCreateWikiLink?${args}`),
          );
          link.tooltip = w.kind === 'diagram' ? `Open diagram ${w.target}` : `Open or create note [[${w.target}]]`;
          links.push(link);
        }
      }
    }

    return links;
  }

  provideDefinition(document: vscode.TextDocument, position: vscode.Position): vscode.Location | undefined {
    if (document.languageId !== 'markdown') {
      return undefined;
    }
    const lineText = document.lineAt(position.line).text;
    const hit = extractWikiLinksInLine(lineText).find(
      (w) => w.kind === 'note' && position.character >= w.startOffset && position.character <= w.endOffset,
    );
    if (!hit) {
      return undefined;
    }
    const resolved = this.notesIndex.resolveNoteTarget(hit.target);
    if (!resolved) {
      return undefined;
    }
    return new vscode.Location(vscode.Uri.file(resolved.absPath), new vscode.Position(0, 0));
  }
}
