import * as vscode from 'vscode';
import { detectCitationTrigger, findCitationKeysInLine } from './citations';
import { Paper } from './types';

export class DupeCitationFeatures
  implements vscode.CompletionItemProvider, vscode.HoverProvider, vscode.DocumentLinkProvider
{
  constructor(private readonly getPapers: () => Paper[]) {}

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

    return this.getPapers()
      .filter((p) => Boolean(p.bibtex_key))
      .map((paper) => {
        const item = new vscode.CompletionItem(paper.bibtex_key, vscode.CompletionItemKind.Reference);
        const year = paper.publication_year ? ` (${paper.publication_year})` : '';
        item.detail = `${paper.authors || 'Unknown'}${year}`;
        const docs = new vscode.MarkdownString();
        docs.appendMarkdown(`**${paper.title}**\n\n`);
        if (paper.bibtex_raw) {
          docs.appendCodeblock(paper.bibtex_raw, 'bibtex');
        }
        item.documentation = docs;
        item.filterText = `${paper.bibtex_key} ${paper.title} ${paper.authors}`;
        item.insertText = paper.bibtex_key;
        item.range = replaceRange;
        return item;
      });
  }

  provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
    const lineText = document.lineAt(position.line).text;
    const occurrences = findCitationKeysInLine(lineText);
    const hit = occurrences.find(
      (occ) => position.character >= occ.startOffset && position.character <= occ.endOffset,
    );
    if (!hit) {
      return undefined;
    }

    const paper = this.getPapers().find((p) => p.bibtex_key === hit.key);
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = true;

    if (!paper) {
      md.appendMarkdown(`Citation key \`${hit.key}\` not found in synced library.`);
      return new vscode.Hover(md, new vscode.Range(position.line, hit.startOffset, position.line, hit.endOffset));
    }

    const year = paper.publication_year ? ` (${paper.publication_year})` : '';
    md.appendMarkdown(`**${paper.title}**\n\n`);
    if (paper.authors) {
      md.appendMarkdown(`*${paper.authors}*${year}\n\n`);
    }
    if (paper.doi) {
      md.appendMarkdown(`DOI: \`${paper.doi}\`\n\n`);
    }
    const args = encodeURIComponent(JSON.stringify([paper.bibtex_key]));
    md.appendMarkdown(`[Open PDF in VS Code](command:dupe.openPaperByKey?${args})`);
    if (paper.bibtex_raw) {
      md.appendMarkdown('\n\n');
      md.appendCodeblock(paper.bibtex_raw, 'bibtex');
    }

    return new vscode.Hover(
      md,
      new vscode.Range(position.line, hit.startOffset, position.line, hit.endOffset),
    );
  }

  provideDocumentLinks(document: vscode.TextDocument): vscode.DocumentLink[] {
    const papers = this.getPapers();
    const knownKeys = new Set(papers.map((p) => p.bibtex_key).filter(Boolean));
    const links: vscode.DocumentLink[] = [];

    for (let lineIdx = 0; lineIdx < document.lineCount; lineIdx++) {
      const lineText = document.lineAt(lineIdx).text;
      const occurrences = findCitationKeysInLine(lineText);
      for (const occ of occurrences) {
        if (!knownKeys.has(occ.key)) {
          continue;
        }
        const range = new vscode.Range(lineIdx, occ.startOffset, lineIdx, occ.endOffset);
        const args = encodeURIComponent(JSON.stringify([occ.key]));
        const target = vscode.Uri.parse(`command:dupe.openPaperByKey?${args}`);
        const link = new vscode.DocumentLink(range, target);
        link.tooltip = `Open PDF for ${occ.key}`;
        links.push(link);
      }
    }

    return links;
  }
}
