import fs from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import { parseMarkdownFrontmatter } from './notesIndex';
import { BrainGraphPayload } from './types';

export interface BrainGraphCallbacks {
  onOpenPath: (relPath: string) => Promise<void>;
  onOpenPaperByKey: (bibtexKey: string) => Promise<void>;
  onCreateGhostNote: (label: string, relPath: string) => Promise<void>;
  onRequestRefresh: (opts: { includeAgentBrain: boolean; localMode: boolean; depth: number }) => Promise<void>;
  getProjectRoot: () => string | null;
}

export interface InspectorDocPayload {
  id: string;
  label: string;
  kind: string;
  relPath: string;
  bodyMarkdown: string;
  tags: string[];
  aliases: string[];
  status?: string;
  lines?: number;
  bloated?: boolean;
  backlinks: Array<{ id: string; label: string; kind: string; path: string }>;
  outgoing: Array<{ id: string; label: string; kind: string; path: string }>;
}

export class BrainGraphPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | null = null;
  private includeAgentBrain = false;
  private localMode = false;
  private localDepth = 2;
  private selectedNodeId: string | null = null;
  private lastGraph: BrainGraphPayload | null = null;
  private callbacks: BrainGraphCallbacks | null = null;

  constructor(private readonly extensionUri?: vscode.Uri) {}

  open(
    initialGraph: BrainGraphPayload,
    callbacks: BrainGraphCallbacks,
    initialSelectedNodeId?: string | null,
    initialTab: 'graph' | 'docs' = 'graph',
  ): void {
    this.callbacks = callbacks;
    this.lastGraph = initialGraph;
    if (initialSelectedNodeId !== undefined) {
      this.selectedNodeId = initialSelectedNodeId;
    }

    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside);
      this.postGraph(initialGraph, initialTab);
      if (this.selectedNodeId) {
        this.pushInspectorForNodeId(this.selectedNodeId);
      }
      return;
    }

    const mediaRoots = this.extensionUri
      ? [vscode.Uri.joinPath(this.extensionUri, 'media')]
      : [];

    this.panel = vscode.window.createWebviewPanel(
      'dupe.brainGraph',
      'dupe: Brain Studio',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: mediaRoots,
      },
    );
    this.panel.webview.html = this.buildHtml(this.panel.webview);

    this.panel.webview.onDidReceiveMessage(async (msg: Record<string, unknown>) => {
      if (!this.callbacks) return;
      switch (msg.type) {
        case 'ready':
          await this.callbacks.onRequestRefresh({
            includeAgentBrain: this.includeAgentBrain,
            localMode: this.localMode,
            depth: this.localDepth,
          });
          if (initialTab) {
            void this.panel?.webview.postMessage({ type: 'setTab', tab: initialTab });
          }
          if (this.selectedNodeId) {
            this.pushInspectorForNodeId(this.selectedNodeId);
          }
          break;
        case 'setOptions':
          this.includeAgentBrain = Boolean(msg.includeAgentBrain);
          this.localMode = Boolean(msg.localMode);
          this.localDepth = typeof msg.depth === 'number' && msg.depth > 0 ? msg.depth : 2;
          await this.callbacks.onRequestRefresh({
            includeAgentBrain: this.includeAgentBrain,
            localMode: this.localMode,
            depth: this.localDepth,
          });
          break;
        case 'selectNode': {
          const nodeId = String(msg.id || '');
          this.selectedNodeId = nodeId || null;
          if (this.selectedNodeId) {
            this.pushInspectorForNodeId(this.selectedNodeId);
          }
          break;
        }
        case 'openLink': {
          const target = String(msg.target || '').trim();
          if (!target) break;
          if (target.startsWith('paper:')) {
            await this.callbacks.onOpenPaperByKey(target.slice('paper:'.length));
            break;
          }
          const resolved = this.resolveNodeByTarget(target);
          if (resolved) {
            this.selectedNodeId = resolved.id;
            this.pushInspectorForNodeId(resolved.id);
          } else {
            await this.callbacks.onCreateGhostNote(target, `notes/concepts/${target}.md`);
          }
          break;
        }
        case 'editSource': {
          const kind = String(msg.kind || '');
          const nodePath = String(msg.path || '');
          const label = String(msg.label || '');
          if (kind === 'paper') {
            await this.callbacks.onOpenPaperByKey(label.replace(/^@/, ''));
          } else if (kind === 'ghost') {
            await this.callbacks.onCreateGhostNote(label, nodePath);
          } else if (nodePath) {
            await this.callbacks.onOpenPath(nodePath);
          }
          break;
        }
      }
    });

    this.panel.onDidDispose(() => {
      this.panel = null;
    });

    this.postGraph(initialGraph, initialTab);
  }

  selectNode(nodeId: string): void {
    this.selectedNodeId = nodeId;
    if (this.panel) {
      this.pushInspectorForNodeId(nodeId);
    }
  }

  getQueryOptions(): { includeAgentBrain: boolean; localMode: boolean; depth: number } {
    return {
      includeAgentBrain: this.includeAgentBrain,
      localMode: this.localMode,
      depth: this.localDepth,
    };
  }

  isOpen(): boolean {
    return this.panel !== null;
  }

  postGraph(graph: BrainGraphPayload, switchTab?: 'graph' | 'docs'): void {
    this.lastGraph = graph;
    if (!this.panel) return;
    void this.panel.webview.postMessage({
      type: 'graphData',
      graph,
      options: this.getQueryOptions(),
      tab: switchTab,
    });
    if (this.selectedNodeId) {
      this.pushInspectorForNodeId(this.selectedNodeId);
    }
  }

  dispose(): void {
    this.panel?.dispose();
    this.panel = null;
  }

  private resolveNodeByTarget(target: string) {
    if (!this.lastGraph) return null;
    const clean = target.toLowerCase().replace(/^notes\//, '').replace(/\.md$/, '');
    return (
      this.lastGraph.nodes.find((n) => n.id.toLowerCase() === target.toLowerCase()) ||
      this.lastGraph.nodes.find((n) => n.label.toLowerCase() === clean) ||
      this.lastGraph.nodes.find((n) => n.path.toLowerCase().replace(/^notes\//, '').replace(/\.md$/, '') === clean) ||
      this.lastGraph.nodes.find((n) => (n.aliases || []).some((a) => a.toLowerCase() === clean)) ||
      null
    );
  }

  private pushInspectorForNodeId(nodeId: string): void {
    if (!this.panel || !this.lastGraph || !this.callbacks) return;
    const node = this.lastGraph.nodes.find((n) => n.id === nodeId);
    if (!node) return;

    const projectRoot = this.callbacks.getProjectRoot();
    let bodyMarkdown = node.snippet || '';
    let status: string | undefined;
    let aliases = node.aliases || [];
    let tags = node.tags || [];

    if (projectRoot && node.path && node.kind !== 'ghost') {
      const absPath = path.join(projectRoot, node.path);
      try {
        const raw = fs.readFileSync(absPath, 'utf8');
        if (node.path.toLowerCase().endsWith('.md')) {
          const parsed = parseMarkdownFrontmatter(raw);
          bodyMarkdown = parsed.body.trim();
          status = parsed.frontmatter.status;
          if (parsed.frontmatter.aliases.length > 0) aliases = parsed.frontmatter.aliases;
        } else {
          bodyMarkdown = '```\n' + raw.slice(0, 6000) + '\n```';
        }
      } catch {
        bodyMarkdown = node.snippet || '';
      }
    } else if (node.kind === 'ghost') {
      bodyMarkdown = `Unresolved link **[[${node.label}]]**. Click **Create Concept Note** to turn this ghost into a note at \`${node.path}\`.`;
    }

    const nodeById = new Map(this.lastGraph.nodes.map((n) => [n.id, n]));
    const backlinks: InspectorDocPayload['backlinks'] = [];
    const outgoing: InspectorDocPayload['outgoing'] = [];
    for (const e of this.lastGraph.edges) {
      if (e.target === node.id) {
        const src = nodeById.get(e.source);
        if (src) backlinks.push({ id: src.id, label: src.label, kind: src.kind, path: src.path });
      }
      if (e.source === node.id) {
        const dst = nodeById.get(e.target);
        if (dst) outgoing.push({ id: dst.id, label: dst.label, kind: dst.kind, path: dst.path });
      }
    }

    const payload: InspectorDocPayload = {
      id: node.id,
      label: node.label,
      kind: node.kind,
      relPath: node.path,
      bodyMarkdown,
      tags,
      aliases,
      status,
      lines: node.lines,
      bloated: node.bloated,
      backlinks,
      outgoing,
    };
    void this.panel.webview.postMessage({ type: 'inspectorDoc', doc: payload });
  }

  private buildHtml(webview: vscode.Webview): string {
    const mermaidUri = this.extensionUri
      ? webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'mermaid', 'mermaid.min.js')).toString()
      : '';

    return String.raw`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>
  :root {
    --bg: var(--vscode-editor-background, #141519);
    --fg: var(--vscode-editor-foreground, #e4e4e7);
    --muted: var(--vscode-descriptionForeground, #a1a1aa);
    --panel: var(--vscode-sideBar-background, #1b1c22);
    --card: color-mix(in srgb, var(--panel) 82%, var(--bg));
    --border: var(--vscode-panel-border, #2b2d36);
    --accent: var(--vscode-textLink-foreground, #60a5fa);
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden;
    background: var(--bg); color: var(--fg);
    font-family: var(--vscode-font-family, system-ui, sans-serif); font-size: 12.5px;
  }
  .shell { display: flex; width: 100%; height: 100%; }
  .stage { position: relative; flex: 1 1 auto; min-width: 0; height: 100%; overflow: hidden; }
  .inspector {
    width: 46%; min-width: 340px; max-width: 680px; height: 100%;
    border-left: 1px solid var(--border); background: var(--panel);
    display: none; flex-direction: column;
  }
  .inspector.open { display: flex; }
  .toolbar {
    position: absolute; top: 10px; left: 10px; right: 10px; z-index: 10;
    display: flex; flex-wrap: wrap; gap: 6px; align-items: center;
    background: color-mix(in srgb, var(--panel) 90%, transparent);
    backdrop-filter: blur(10px);
    border: 1px solid var(--border); border-radius: 9px; padding: 7px 10px;
  }
  .seg { display: inline-flex; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
  .seg button {
    border: 0; background: transparent; color: var(--muted); padding: 4px 10px; cursor: pointer; font-weight: 500;
  }
  .seg button.active { background: color-mix(in srgb, var(--accent) 22%, var(--bg)); color: var(--fg); }
  .toolbar input[type="search"] {
    background: var(--bg); color: var(--fg); border: 1px solid var(--border);
    border-radius: 6px; padding: 4px 9px; width: 155px; outline: none;
  }
  .btn, label.pill {
    display: inline-flex; align-items: center; gap: 4px;
    background: var(--bg); color: var(--fg); border: 1px solid var(--border);
    border-radius: 6px; padding: 3.5px 8px; cursor: pointer; user-select: none; font-size: 11.5px;
  }
  .btn:hover, label.pill:hover { border-color: var(--accent); }
  .btn.active { background: color-mix(in srgb, var(--accent) 22%, var(--bg)); border-color: var(--accent); }
  .stats { margin-left: auto; color: var(--muted); display: flex; gap: 10px; flex-wrap: wrap; font-size: 11.5px; }
  .stat-warn { color: #f59e0b; font-weight: 600; }
  .legend {
    position: absolute; bottom: 10px; left: 10px; z-index: 10;
    display: flex; flex-wrap: wrap; gap: 10px; align-items: center;
    background: color-mix(in srgb, var(--panel) 88%, transparent);
    border: 1px solid var(--border); border-radius: 8px; padding: 6px 10px;
    color: var(--muted); font-size: 11px;
  }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 4px; vertical-align: middle; }
  .tooltip {
    position: absolute; pointer-events: none; z-index: 20; display: none;
    background: var(--panel); color: var(--fg); border: 1px solid var(--border);
    border-radius: 7px; padding: 7px 10px; max-width: 280px; box-shadow: 0 8px 22px rgba(0,0,0,0.4);
  }
  canvas { display: block; width: 100%; height: 100%; cursor: grab; }
  canvas:active { cursor: grabbing; }

  /* Living Brain Cards Tab */
  .docs-view {
    display: none; width: 100%; height: 100%; overflow-y: auto;
    padding: 66px 18px 24px;
  }
  .docs-view.active { display: block; }
  .docs-section { margin-bottom: 22px; }
  .docs-section h3 {
    margin: 0 0 10px; font-size: 11px; text-transform: uppercase; letter-spacing: .07em; color: var(--muted);
  }
  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 10px; }
  .card {
    background: var(--card); border: 1px solid var(--border); border-radius: 9px;
    padding: 11px 13px; cursor: pointer; transition: border-color .15s, transform .1s;
  }
  .card:hover { border-color: var(--accent); transform: translateY(-1px); }
  .card.selected { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
  .card-title { font-weight: 600; font-size: 13px; margin-bottom: 4px; display: flex; align-items: center; gap: 6px; }
  .card-snippet { color: var(--muted); font-size: 11.5px; line-height: 1.45; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .card-meta { margin-top: 8px; display: flex; flex-wrap: wrap; gap: 5px; align-items: center; font-size: 10.5px; color: var(--muted); }

  /* Right Inspector Reader */
  .insp-header {
    padding: 12px 15px; border-bottom: 1px solid var(--border);
    display: flex; align-items: flex-start; gap: 8px;
  }
  .insp-title-wrap { flex: 1; min-width: 0; }
  .insp-title { font-size: 15px; font-weight: 650; margin: 0 0 3px; word-break: break-word; }
  .insp-path { font-size: 11px; color: var(--muted); font-family: var(--vscode-editor-font-family, monospace); }
  .insp-badges { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 7px; }
  .chip {
    display: inline-flex; align-items: center; gap: 4px; font-size: 11px;
    padding: 2px 7px; border-radius: 999px; border: 1px solid var(--border); background: var(--bg); color: var(--fg);
  }
  .chip.link { cursor: pointer; border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); color: var(--accent); }
  .chip.link:hover { background: color-mix(in srgb, var(--accent) 16%, var(--bg)); }
  .chip.paper { color: #fb7185; border-color: rgba(251,113,133,0.4); }
  .chip.warn { color: #f59e0b; border-color: rgba(245,158,11,0.5); }
  .insp-body {
    flex: 1; overflow-y: auto; padding: 16px 18px; line-height: 1.62; font-size: 13px;
  }
  .insp-body h1 { font-size: 18px; margin: 4px 0 12px; border-bottom: 1px solid var(--border); padding-bottom: 6px; }
  .insp-body h2 { font-size: 15px; margin: 18px 0 8px; color: var(--fg); }
  .insp-body h3 { font-size: 13.5px; margin: 14px 0 6px; }
  .insp-body p { margin: 8px 0; }
  .insp-body ul, .insp-body ol { margin: 8px 0; padding-left: 20px; }
  .insp-body li { margin: 4px 0; }
  .insp-body pre {
    background: var(--bg); border: 1px solid var(--border); border-radius: 7px; padding: 10px 12px; overflow-x: auto; font-size: 12px;
  }
  .insp-body code { background: color-mix(in srgb, var(--bg) 80%, transparent); padding: 1px 4px; border-radius: 4px; font-family: var(--vscode-editor-font-family, monospace); font-size: 11.5px; }
  .insp-body blockquote {
    margin: 10px 0; padding: 7px 12px; border-left: 3px solid var(--accent);
    background: color-mix(in srgb, var(--accent) 8%, var(--bg)); border-radius: 0 6px 6px 0;
  }
  .insp-body table { width: 100%; border-collapse: collapse; margin: 10px 0; font-size: 12px; }
  .insp-body th, .insp-body td { border: 1px solid var(--border); padding: 6px 8px; text-align: left; }
  .insp-body th { background: var(--bg); }
  .mermaid-wrap {
    margin: 12px 0; padding: 10px; background: var(--bg); border: 1px solid var(--border);
    border-radius: 8px; overflow-x: auto; text-align: center;
  }
  .wikilink {
    color: var(--accent); cursor: pointer; text-decoration: none;
    border-bottom: 1px dashed color-mix(in srgb, var(--accent) 60%, transparent);
  }
  .wikilink.paper { color: #fb7185; border-bottom-color: rgba(251,113,133,0.6); }
  .insp-footer {
    border-top: 1px solid var(--border); padding: 10px 15px; background: var(--bg);
    max-height: 155px; overflow-y: auto;
  }
  .conn-group { margin-bottom: 6px; display: flex; flex-wrap: wrap; gap: 5px; align-items: center; }
  .conn-label { font-size: 10.5px; color: var(--muted); text-transform: uppercase; letter-spacing: .05em; margin-right: 4px; }
</style>
</head>
<body>
<div class="shell">
  <div class="stage">
    <div class="toolbar">
      <div class="seg">
        <button id="tabGraph" class="active">Graph</button>
        <button id="tabDocs">Living Brain</button>
      </div>
      <input id="search" type="search" placeholder="Filter title or #tag..." />
      <button id="modeBtn" class="btn" title="Switch between full project graph and 1-2 hop local neighborhood">Global</button>
      <button id="depthBtn" class="btn" style="display:none;">2-hop</button>
      <label class="pill"><input type="checkbox" id="fPapers" checked /> Papers</label>
      <label class="pill"><input type="checkbox" id="fTex" checked /> LaTeX</label>
      <label class="pill"><input type="checkbox" id="fArtifacts" checked /> Artifacts</label>
      <label class="pill"><input type="checkbox" id="fGhosts" checked /> Ghosts</label>
      <label class="pill" title="Show .dupe/brain agent brainstorm files (hidden by default)"><input type="checkbox" id="fAgent" /> Agent Brain</label>
      <label class="pill"><input type="checkbox" id="fOrphans" /> Orphans</label>
      <button id="pauseBtn" class="btn">Pause</button>
      <button id="resetBtn" class="btn">Fit</button>
      <div id="stats" class="stats"></div>
    </div>

    <div id="docsView" class="docs-view"></div>
    <canvas id="canvas"></canvas>

    <div id="legend" class="legend">
      <span><i class="dot" style="background:#f59e0b"></i>MOC</span>
      <span><i class="dot" style="background:#38bdf8"></i>Concept</span>
      <span><i class="dot" style="background:#34d399"></i>Note</span>
      <span><i class="dot" style="background:#c084fc"></i>Artifact</span>
      <span><i class="dot" style="background:#fb7185"></i>Paper</span>
      <span><i class="dot" style="background:#facc15"></i>LaTeX</span>
      <span><i class="dot" style="background:#2dd4bf"></i>Code</span>
      <span><i class="dot" style="border:1.5px dashed #9ca3af;background:transparent"></i>Ghost</span>
      <span><i class="dot" style="background:#94a3b8"></i>Agent Brain</span>
    </div>
    <div id="tooltip" class="tooltip"></div>
  </div>

  <aside id="inspector" class="inspector">
    <div class="insp-header">
      <div class="insp-title-wrap">
        <div id="inspTitle" class="insp-title"></div>
        <div id="inspPath" class="insp-path"></div>
        <div id="inspBadges" class="insp-badges"></div>
      </div>
      <button id="inspEditBtn" class="btn">Edit Source</button>
      <button id="inspCloseBtn" class="btn" title="Close Reader">✕</button>
    </div>
    <div id="inspBody" class="insp-body"></div>
    <div id="inspFooter" class="insp-footer"></div>
  </aside>
</div>

${mermaidUri ? '<script src="' + mermaidUri + '"></script>' : ''}
<script>
const vscode = acquireVsCodeApi();
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const tooltip = document.getElementById('tooltip');
const docsView = document.getElementById('docsView');
const legendEl = document.getElementById('legend');
const inspectorEl = document.getElementById('inspector');
const inspTitle = document.getElementById('inspTitle');
const inspPath = document.getElementById('inspPath');
const inspBadges = document.getElementById('inspBadges');
const inspBody = document.getElementById('inspBody');
const inspFooter = document.getElementById('inspFooter');
const inspEditBtn = document.getElementById('inspEditBtn');
const inspCloseBtn = document.getElementById('inspCloseBtn');

if (window.mermaid) {
  window.mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'loose' });
}

const KIND_COLOR = {
  moc: '#f59e0b',
  concept: '#38bdf8',
  note: '#34d399',
  artifact: '#c084fc',
  paper: '#fb7185',
  tex: '#facc15',
  code: '#2dd4bf',
  ghost: '#9ca3af',
  blackboard: '#94a3b8',
};

let currentTab = 'graph';
let rawGraph = { nodes: [], edges: [], focusNodeId: null, summary: {} };
let simNodes = [];
let simEdges = [];
let nodeById = new Map();
let cam = { x: 0, y: 0, zoom: 1 };
let paused = false;
let localMode = false;
let localDepth = 2;
let selectedId = null;
let currentDoc = null;
let hovered = null;
let dragNode = null;
let panning = false;
let panStart = { x: 0, y: 0 };
let pointerMoved = false;

const elTabGraph = document.getElementById('tabGraph');
const elTabDocs = document.getElementById('tabDocs');
const elSearch = document.getElementById('search');
const elModeBtn = document.getElementById('modeBtn');
const elDepthBtn = document.getElementById('depthBtn');
const elPapers = document.getElementById('fPapers');
const elTex = document.getElementById('fTex');
const elArtifacts = document.getElementById('fArtifacts');
const elGhosts = document.getElementById('fGhosts');
const elAgent = document.getElementById('fAgent');
const elOrphans = document.getElementById('fOrphans');
const elPause = document.getElementById('pauseBtn');
const elReset = document.getElementById('resetBtn');
const elStats = document.getElementById('stats');

function setActiveTab(tab) {
  currentTab = tab === 'docs' ? 'docs' : 'graph';
  elTabGraph.classList.toggle('active', currentTab === 'graph');
  elTabDocs.classList.toggle('active', currentTab === 'docs');
  canvas.style.display = currentTab === 'graph' ? 'block' : 'none';
  legendEl.style.display = currentTab === 'graph' ? 'flex' : 'none';
  docsView.classList.toggle('active', currentTab === 'docs');
  if (currentTab === 'graph') resize();
  else renderLivingDocs();
}
elTabGraph.addEventListener('click', () => setActiveTab('graph'));
elTabDocs.addEventListener('click', () => setActiveTab('docs'));

function resize() {
  const stage = canvas.parentElement;
  const w = stage.clientWidth || window.innerWidth;
  const h = stage.clientHeight || window.innerHeight;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resize);
new ResizeObserver(resize).observe(canvas.parentElement);
resize();

function screenToWorld(sx, sy) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (sx - rect.width / 2) / cam.zoom + cam.x,
    y: (sy - rect.height / 2) / cam.zoom + cam.y,
  };
}

function worldToScreen(wx, wy) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (wx - cam.x) * cam.zoom + rect.width / 2,
    y: (wy - cam.y) * cam.zoom + rect.height / 2,
  };
}

function filterNodes() {
  const q = elSearch.value.trim().toLowerCase();
  const allowed = new Set();
  for (const n of rawGraph.nodes) {
    if (n.kind === 'paper' && !elPapers.checked) continue;
    if (n.kind === 'tex' && !elTex.checked) continue;
    if (n.kind === 'artifact' && !elArtifacts.checked) continue;
    if (n.kind === 'ghost' && !elGhosts.checked) continue;
    if (n.kind === 'blackboard' && !elAgent.checked) continue;
    if (elOrphans.checked && n.degree > 0) continue;
    if (q) {
      const inLabel = n.label.toLowerCase().includes(q);
      const inPath = (n.path || '').toLowerCase().includes(q);
      const inTags = (n.tags || []).some((t) => ('#' + t).toLowerCase().includes(q));
      if (!inLabel && !inPath && !inTags) continue;
    }
    allowed.add(n.id);
  }
  return allowed;
}

function rebuildVisibleGraph() {
  const allowed = filterNodes();
  const prevPositions = new Map(simNodes.map((n) => [n.id, { x: n.x, y: n.y, vx: n.vx, vy: n.vy }]));

  simNodes = rawGraph.nodes
    .filter((n) => allowed.has(n.id))
    .map((n, idx) => {
      const prev = prevPositions.get(n.id);
      const angle = (idx / Math.max(1, rawGraph.nodes.length)) * Math.PI * 2;
      const r = 60 + Math.sqrt(idx) * 26;
      return {
        ...n,
        x: prev ? prev.x : Math.cos(angle) * r,
        y: prev ? prev.y : Math.sin(angle) * r,
        vx: prev ? prev.vx : 0,
        vy: prev ? prev.vy : 0,
        radius: n.kind === 'moc' ? 11 : Math.min(12, 4.8 + Math.sqrt(n.degree || 0) * 1.6),
      };
    });

  nodeById = new Map(simNodes.map((n) => [n.id, n]));
  simEdges = rawGraph.edges.filter((e) => nodeById.has(e.source) && nodeById.has(e.target));

  const s = rawGraph.summary || {};
  elStats.innerHTML =
    '<span><b>' + simNodes.length + '</b> nodes · <b>' + simEdges.length + '</b> links</span>' +
    (s.orphanCount ? '<span class="stat-warn">' + s.orphanCount + ' orphans</span>' : '') +
    (s.bloatedCount ? '<span class="stat-warn">' + s.bloatedCount + ' bloated (&gt;150L)</span>' : '');

  if (currentTab === 'docs') renderLivingDocs();
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderLivingDocs() {
  const groups = [
    { title: 'Living Artifacts', kinds: ['artifact'] },
    { title: 'Concepts', kinds: ['concept'] },
    { title: 'Hubs & Notes', kinds: ['moc', 'note'] },
    { title: 'Agent Blackboard (.dupe/brain)', kinds: ['blackboard'] },
  ];
  let html = '';
  for (const g of groups) {
    const items = simNodes
      .filter((n) => g.kinds.includes(n.kind))
      .sort((a, b) => (b.degree || 0) - (a.degree || 0) || a.label.localeCompare(b.label));
    if (items.length === 0) continue;
    html += '<div class="docs-section"><h3>' + g.title + ' (' + items.length + ')</h3><div class="cards">';
    for (const n of items) {
      const color = KIND_COLOR[n.kind] || '#38bdf8';
      const tags = (n.tags || []).slice(0, 3).map((t) => '<span class="chip">#' + escapeHtml(t) + '</span>').join('');
      html += '<div class="card' + (selectedId === n.id ? ' selected' : '') + '" data-node-id="' + escapeHtml(n.id) + '">' +
        '<div class="card-title"><i class="dot" style="background:' + color + '"></i>' + escapeHtml(n.label) + '</div>' +
        '<div class="card-snippet">' + escapeHtml(n.path || '') + '</div>' +
        '<div class="card-meta">' +
          '<span>' + (n.backlinks || 0) + ' in · ' + Math.max(0, (n.degree || 0) - (n.backlinks || 0)) + ' out</span>' +
          (n.lines ? '<span>· ' + n.lines + 'L</span>' : '') +
          (n.bloated ? '<span style="color:#ef4444">· bloated</span>' : '') +
          tags +
        '</div>' +
      '</div>';
    }
    html += '</div></div>';
  }
  if (!html) {
    html = '<div style="color:var(--muted);padding:30px;text-align:center;">No notes match current filters.</div>';
  }
  docsView.innerHTML = html;
  for (const card of docsView.querySelectorAll('.card')) {
    card.addEventListener('click', () => {
      const id = card.getAttribute('data-node-id');
      if (id) selectAndInspect(id);
    });
  }
}

function selectAndInspect(nodeId) {
  selectedId = nodeId;
  if (currentTab === 'docs') renderLivingDocs();
  vscode.postMessage({ type: 'selectNode', id: nodeId });
}

function renderInlineMarkdown(text) {
  // Split out inline code spans cleanly first so documentation examples render verbatim
  const parts = String(text).split(/(\x60[^\x60\n]+\x60)/g);
  return parts.map((part, idx) => {
    if (idx % 2 === 1) {
      return '<code>' + escapeHtml(part.slice(1, -1)) + '</code>';
    }
    let out = escapeHtml(part);
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" style="color:var(--accent)">$1</a>');
    out = out.replace(/\[\[([^\]\n]+)\]\]/g, (_m, inner) => {
      const pipe = inner.indexOf('|');
      const target = (pipe >= 0 ? inner.slice(0, pipe) : inner).trim();
      const label = (pipe >= 0 ? inner.slice(pipe + 1) : inner).trim();
      const isPaper = target.toLowerCase().startsWith('paper:');
      return '<a class="wikilink' + (isPaper ? ' paper' : '') + '" data-wiki="' + escapeHtml(target) + '">' + escapeHtml(label) + '</a>';
    });
    return out;
  }).join('');
}

let mermaidSeq = 0;
function renderMarkdownBody(md) {
  const lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
  let html = '';
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trim = line.trim();

    if (trim.startsWith('\x60\x60\x60')) {
      const lang = trim.slice(3).trim().toLowerCase();
      i++;
      const block = [];
      while (i < lines.length && !lines[i].trim().startsWith('\x60\x60\x60')) {
        block.push(lines[i]);
        i++;
      }
      i++;
      const code = block.join('\n');
      if (lang === 'mermaid') {
        const mid = 'mermaid-' + (++mermaidSeq);
        html += '<div class="mermaid-wrap" data-mermaid-id="' + mid + '" data-mermaid-src="' + escapeHtml(code) + '"><pre>' + escapeHtml(code) + '</pre></div>';
      } else {
        html += '<pre><code>' + escapeHtml(code) + '</code></pre>';
      }
      continue;
    }

    if (/^#{1,3}\s+/.test(trim)) {
      const level = trim.match(/^#+/)[0].length;
      html += '<h' + level + '>' + renderInlineMarkdown(trim.slice(level).trim()) + '</h' + level + '>';
      i++; continue;
    }

    if (trim.startsWith('>')) {
      const q = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        q.push(renderInlineMarkdown(lines[i].trim().replace(/^>\s?/, '')));
        i++;
      }
      html += '<blockquote>' + q.join('<br/>') + '</blockquote>';
      continue;
    }

    if (trim.startsWith('|') && i + 1 < lines.length && /^\|[\s:|-]+\|/.test(lines[i + 1].trim())) {
      const splitRow = (r) => r.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
      const headers = splitRow(line);
      i += 2;
      html += '<table><thead><tr>' + headers.map((h) => '<th>' + renderInlineMarkdown(h) + '</th>').join('') + '</tr></thead><tbody>';
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        const cols = splitRow(lines[i]);
        html += '<tr>' + cols.map((c) => '<td>' + renderInlineMarkdown(c) + '</td>').join('') + '</tr>';
        i++;
      }
      html += '</tbody></table>';
      continue;
    }

    if (/^[-*]\s+/.test(trim)) {
      html += '<ul>';
      while (i < lines.length && /^[-*]\s+/.test(lines[i].trim())) {
        let item = lines[i].trim().replace(/^[-*]\s+/, '');
        item = item.replace(/^\[ \]\s*/, '☐ ').replace(/^\[[xX]\]\s*/, '☑ ');
        html += '<li>' + renderInlineMarkdown(item) + '</li>';
        i++;
      }
      html += '</ul>';
      continue;
    }

    if (trim === '') { i++; continue; }
    const para = [];
    while (i < lines.length && lines[i].trim() !== '' && !/^(#{1,3}\s|\x60\x60\x60|>|[-*]\s|\|)/.test(lines[i].trim())) {
      para.push(renderInlineMarkdown(lines[i].trim()));
      i++;
    }
    html += '<p>' + para.join(' ') + '</p>';
  }
  return html;
}

async function renderInspector(doc) {
  currentDoc = doc;
  selectedId = doc.id;
  inspectorEl.classList.add('open');
  resize();

  inspTitle.textContent = doc.label;
  inspPath.textContent = doc.relPath || '';
  inspEditBtn.textContent = doc.kind === 'ghost' ? 'Create Note' : doc.kind === 'paper' ? 'Open PDF' : 'Edit Source';

  let badges = '<span class="chip">' + escapeHtml(doc.kind) + '</span>';
  if (doc.status) badges += '<span class="chip">' + escapeHtml(doc.status) + '</span>';
  if (doc.lines) badges += '<span class="chip">' + doc.lines + ' lines</span>';
  if (doc.bloated) badges += '<span class="chip warn">Over 150-line cap</span>';
  for (const t of (doc.tags || [])) badges += '<span class="chip">#' + escapeHtml(t) + '</span>';
  inspBadges.innerHTML = badges;

  inspBody.innerHTML = renderMarkdownBody(doc.bodyMarkdown || '');

  for (const el of inspBody.querySelectorAll('.wikilink')) {
    el.addEventListener('click', () => {
      const target = el.getAttribute('data-wiki');
      if (target) vscode.postMessage({ type: 'openLink', target });
    });
  }

  if (window.mermaid) {
    for (const el of inspBody.querySelectorAll('.mermaid-wrap')) {
      const id = el.getAttribute('data-mermaid-id');
      const src = el.getAttribute('data-mermaid-src');
      try {
        const res = await window.mermaid.render(id, src);
        el.innerHTML = res.svg;
      } catch {
        // Keep clean fallback code block if diagram syntax invalid
      }
    }
  }

  let footHtml = '';
  if (doc.backlinks && doc.backlinks.length > 0) {
    footHtml += '<div class="conn-group"><span class="conn-label">Backlinks (' + doc.backlinks.length + ')</span>';
    for (const b of doc.backlinks) {
      footHtml += '<span class="chip link' + (b.kind === 'paper' ? ' paper' : '') + '" data-jump-id="' + escapeHtml(b.id) + '">' + escapeHtml(b.label) + '</span>';
    }
    footHtml += '</div>';
  }
  if (doc.outgoing && doc.outgoing.length > 0) {
    footHtml += '<div class="conn-group"><span class="conn-label">Links Out (' + doc.outgoing.length + ')</span>';
    for (const o of doc.outgoing) {
      footHtml += '<span class="chip link' + (o.kind === 'paper' ? ' paper' : '') + '" data-jump-id="' + escapeHtml(o.id) + '">' + escapeHtml(o.label) + '</span>';
    }
    footHtml += '</div>';
  }
  inspFooter.innerHTML = footHtml || '<div class="conn-label">No connections yet</div>';
  for (const chip of inspFooter.querySelectorAll('[data-jump-id]')) {
    chip.addEventListener('click', () => {
      const id = chip.getAttribute('data-jump-id');
      if (id) selectAndInspect(id);
    });
  }
}

inspEditBtn.addEventListener('click', () => {
  if (!currentDoc) return;
  vscode.postMessage({ type: 'editSource', id: currentDoc.id, kind: currentDoc.kind, path: currentDoc.relPath, label: currentDoc.label });
});
inspCloseBtn.addEventListener('click', () => {
  inspectorEl.classList.remove('open');
  selectedId = null;
  currentDoc = null;
  resize();
});

function tickPhysics() {
  if (paused || simNodes.length === 0 || currentTab !== 'graph') return;
  const nLen = simNodes.length;
  for (let i = 0; i < nLen; i++) {
    const a = simNodes[i];
    a.vx -= a.x * 0.0028;
    a.vy -= a.y * 0.0028;
    for (let j = i + 1; j < nLen; j++) {
      const b = simNodes[j];
      const dx = b.x - a.x || 0.01;
      const dy = b.y - a.y || 0.01;
      const distSq = dx * dx + dy * dy + 16;
      const force = 540 / distSq;
      const fx = (dx / Math.sqrt(distSq)) * force;
      const fy = (dy / Math.sqrt(distSq)) * force;
      a.vx -= fx; a.vy -= fy;
      b.vx += fx; b.vy += fy;
    }
  }
  for (const e of simEdges) {
    const src = nodeById.get(e.source);
    const dst = nodeById.get(e.target);
    if (!src || !dst) continue;
    const dx = dst.x - src.x;
    const dy = dst.y - src.y;
    const dist = Math.hypot(dx, dy) || 1;
    const pull = (dist - 96) * 0.016;
    const fx = (dx / dist) * pull;
    const fy = (dy / dist) * pull;
    src.vx += fx; src.vy += fy;
    dst.vx -= fx; dst.vy -= fy;
  }
  for (const n of simNodes) {
    if (dragNode === n) continue;
    n.vx *= 0.84; n.vy *= 0.84;
    n.x += Math.max(-12, Math.min(12, n.vx));
    n.y += Math.max(-12, Math.min(12, n.vy));
  }
}

function draw() {
  if (currentTab === 'graph') {
    tickPhysics();
    const rect = canvas.getBoundingClientRect();
    ctx.clearRect(0, 0, rect.width, rect.height);
    const activeNode = hovered || (selectedId ? nodeById.get(selectedId) : null);
    const neighborSet = new Set();
    if (activeNode) {
      neighborSet.add(activeNode.id);
      for (const e of simEdges) {
        if (e.source === activeNode.id) neighborSet.add(e.target);
        if (e.target === activeNode.id) neighborSet.add(e.source);
      }
    }

    for (const e of simEdges) {
      const a = nodeById.get(e.source);
      const b = nodeById.get(e.target);
      if (!a || !b) continue;
      const pa = worldToScreen(a.x, a.y);
      const pb = worldToScreen(b.x, b.y);
      const active = !activeNode || (e.source === activeNode.id || e.target === activeNode.id);
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      if (e.kind === 'cite') ctx.strokeStyle = active ? 'rgba(251,113,133,0.48)' : 'rgba(251,113,133,0.08)';
      else if (e.kind === 'provenance') ctx.strokeStyle = active ? 'rgba(45,212,191,0.52)' : 'rgba(45,212,191,0.08)';
      else ctx.strokeStyle = active ? 'rgba(148,163,184,0.48)' : 'rgba(148,163,184,0.08)';
      ctx.lineWidth = active && activeNode ? 1.6 : 1;
      ctx.stroke();
    }

    for (const n of simNodes) {
      const p = worldToScreen(n.x, n.y);
      const dim = activeNode && !neighborSet.has(n.id);
      ctx.save();
      ctx.globalAlpha = dim ? 0.2 : 1;
      const r = n.radius * Math.max(0.75, Math.min(1.4, cam.zoom));

      if (n.bloated) {
        ctx.beginPath(); ctx.arc(p.x, p.y, r + 4, 0, Math.PI * 2);
        ctx.strokeStyle = '#ef4444'; ctx.lineWidth = 1.6; ctx.stroke();
      }
      if (n.id === selectedId || n.id === rawGraph.focusNodeId) {
        ctx.beginPath(); ctx.arc(p.x, p.y, r + 4, 0, Math.PI * 2);
        ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.6; ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      if (n.kind === 'ghost') {
        ctx.setLineDash([3, 3]); ctx.strokeStyle = KIND_COLOR.ghost; ctx.lineWidth = 1.5; ctx.stroke();
      } else {
        ctx.fillStyle = KIND_COLOR[n.kind] || '#38bdf8'; ctx.fill();
      }
      if (cam.zoom >= 0.65 || n.degree >= 2 || activeNode === n || neighborSet.has(n.id)) {
        ctx.font = (n.kind === 'moc' ? '600 11px ' : '10.5px ') + 'system-ui, sans-serif';
        ctx.fillStyle = '#e4e4e7'; ctx.textAlign = 'center';
        ctx.fillText(n.label, p.x, p.y + r + 12);
      }
      ctx.restore();
    }
  }
  requestAnimationFrame(draw);
}
requestAnimationFrame(draw);

function hitTest(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const w = screenToWorld(clientX - rect.left, clientY - rect.top);
  for (let i = simNodes.length - 1; i >= 0; i--) {
    const n = simNodes[i];
    if (Math.hypot(n.x - w.x, n.y - w.y) <= n.radius + 6 / cam.zoom) return n;
  }
  return null;
}

canvas.addEventListener('pointerdown', (ev) => {
  pointerMoved = false;
  panStart = { x: ev.clientX, y: ev.clientY };
  const hit = hitTest(ev.clientX, ev.clientY);
  if (hit) dragNode = hit;
  else panning = true;
});

window.addEventListener('pointermove', (ev) => {
  if (Math.hypot(ev.clientX - panStart.x, ev.clientY - panStart.y) > 3) pointerMoved = true;
  if (dragNode) {
    const rect = canvas.getBoundingClientRect();
    const w = screenToWorld(ev.clientX - rect.left, ev.clientY - rect.top);
    dragNode.x = w.x; dragNode.y = w.y; dragNode.vx = 0; dragNode.vy = 0;
  } else if (panning) {
    cam.x -= (ev.clientX - panStart.x) / cam.zoom;
    cam.y -= (ev.clientY - panStart.y) / cam.zoom;
    panStart = { x: ev.clientX, y: ev.clientY };
  } else if (currentTab === 'graph') {
    hovered = hitTest(ev.clientX, ev.clientY);
    if (hovered) {
      tooltip.style.display = 'block';
      tooltip.style.left = Math.min(canvas.clientWidth - 290, ev.clientX + 14) + 'px';
      tooltip.style.top = Math.min(canvas.clientHeight - 90, ev.clientY + 14) + 'px';
      const tagsStr = (hovered.tags || []).map((t) => '#' + t).join(' ');
      tooltip.innerHTML =
        '<div><b>' + escapeHtml(hovered.label) + '</b> <span style="opacity:.7">(' + hovered.kind + ')</span></div>' +
        (hovered.path ? '<div style="opacity:.75;font-size:11px">' + escapeHtml(hovered.path) + '</div>' : '') +
        '<div style="font-size:11px">' + (hovered.lines ? hovered.lines + ' lines · ' : '') + hovered.backlinks + ' backlinks</div>' +
        (tagsStr ? '<div style="color:#38bdf8;font-size:11px">' + escapeHtml(tagsStr) + '</div>' : '');
    } else {
      tooltip.style.display = 'none';
    }
  }
});

window.addEventListener('pointerup', () => {
  if (!pointerMoved && dragNode) {
    selectAndInspect(dragNode.id);
  }
  dragNode = null;
  panning = false;
});

canvas.addEventListener('wheel', (ev) => {
  ev.preventDefault();
  const factor = ev.deltaY < 0 ? 1.12 : 0.89;
  cam.zoom = Math.max(0.25, Math.min(3.5, cam.zoom * factor));
}, { passive: false });

elSearch.addEventListener('input', rebuildVisibleGraph);
for (const cb of [elPapers, elTex, elArtifacts, elGhosts, elOrphans]) {
  cb.addEventListener('change', rebuildVisibleGraph);
}
elAgent.addEventListener('change', () => {
  vscode.postMessage({ type: 'setOptions', includeAgentBrain: elAgent.checked, localMode, depth: localDepth });
});
elModeBtn.addEventListener('click', () => {
  localMode = !localMode;
  elModeBtn.textContent = localMode ? 'Local' : 'Global';
  elModeBtn.classList.toggle('active', localMode);
  elDepthBtn.style.display = localMode ? 'inline-flex' : 'none';
  vscode.postMessage({ type: 'setOptions', includeAgentBrain: elAgent.checked, localMode, depth: localDepth });
});
elDepthBtn.addEventListener('click', () => {
  localDepth = localDepth === 1 ? 2 : 1;
  elDepthBtn.textContent = localDepth + '-hop';
  vscode.postMessage({ type: 'setOptions', includeAgentBrain: elAgent.checked, localMode, depth: localDepth });
});
elPause.addEventListener('click', () => {
  paused = !paused;
  elPause.textContent = paused ? 'Resume' : 'Pause';
  elPause.classList.toggle('active', paused);
});
elReset.addEventListener('click', () => { cam = { x: 0, y: 0, zoom: 1 }; });

window.addEventListener('message', (ev) => {
  const msg = ev.data;
  if (!msg) return;
  if (msg.type === 'setTab') setActiveTab(msg.tab);
  if (msg.type === 'graphData') {
    rawGraph = msg.graph;
    if (msg.options) {
      localMode = Boolean(msg.options.localMode);
      localDepth = msg.options.depth || 2;
      elAgent.checked = Boolean(msg.options.includeAgentBrain);
      elModeBtn.textContent = localMode ? 'Local' : 'Global';
      elModeBtn.classList.toggle('active', localMode);
      elDepthBtn.style.display = localMode ? 'inline-flex' : 'none';
      elDepthBtn.textContent = localDepth + '-hop';
    }
    if (msg.tab) setActiveTab(msg.tab);
    rebuildVisibleGraph();
  }
  if (msg.type === 'inspectorDoc' && msg.doc) {
    void renderInspector(msg.doc);
  }
});

vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
  }
}
