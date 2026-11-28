import * as vscode from 'vscode';
import { BrainGraphPayload } from './types';

export interface BrainGraphCallbacks {
  onOpenPath: (relPath: string) => Promise<void>;
  onOpenPaperByKey: (bibtexKey: string) => Promise<void>;
  onCreateGhostNote: (label: string, relPath: string) => Promise<void>;
  onRequestRefresh: (opts: { includeAgentBrain: boolean; localMode: boolean; depth: number }) => Promise<void>;
}

export class BrainGraphPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | null = null;
  private includeAgentBrain = false;
  private localMode = false;
  private localDepth = 2;
  private callbacks: BrainGraphCallbacks | null = null;

  open(initialGraph: BrainGraphPayload, callbacks: BrainGraphCallbacks): void {
    this.callbacks = callbacks;
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside);
      this.postGraph(initialGraph);
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'dupe.brainGraph',
      'dupe: Knowledge Brain Graph',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      },
    );
    this.panel.webview.html = this.buildHtml();

    this.panel.webview.onDidReceiveMessage(async (msg: Record<string, unknown>) => {
      if (!this.callbacks) return;
      switch (msg.type) {
        case 'ready':
          await this.callbacks.onRequestRefresh({
            includeAgentBrain: this.includeAgentBrain,
            localMode: this.localMode,
            depth: this.localDepth,
          });
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
        case 'openNode': {
          const kind = String(msg.kind || '');
          const nodePath = String(msg.path || '');
          const label = String(msg.label || '');
          if (kind === 'paper') {
            const key = label.replace(/^@/, '');
            await this.callbacks.onOpenPaperByKey(key);
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

    this.postGraph(initialGraph);
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

  postGraph(graph: BrainGraphPayload): void {
    if (!this.panel) return;
    void this.panel.webview.postMessage({
      type: 'graphData',
      graph,
      options: this.getQueryOptions(),
    });
  }

  dispose(): void {
    this.panel?.dispose();
    this.panel = null;
  }

  private buildHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>
  :root {
    --bg: var(--vscode-editor-background, #18181b);
    --fg: var(--vscode-editor-foreground, #e4e4e7);
    --muted: var(--vscode-descriptionForeground, #a1a1aa);
    --panel: var(--vscode-sideBar-background, #1f1f24);
    --border: var(--vscode-panel-border, #2e2e36);
    --accent: var(--vscode-textLink-foreground, #60a5fa);
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: var(--bg); color: var(--fg); font-family: var(--vscode-font-family, system-ui, sans-serif); font-size: 12px; }
  .toolbar {
    position: absolute; top: 10px; left: 10px; right: 10px; z-index: 10;
    display: flex; flex-wrap: wrap; gap: 6px; align-items: center;
    background: color-mix(in srgb, var(--panel) 88%, transparent);
    backdrop-filter: blur(8px);
    border: 1px solid var(--border); border-radius: 8px; padding: 7px 10px;
  }
  .toolbar input[type="search"] {
    background: var(--bg); color: var(--fg); border: 1px solid var(--border);
    border-radius: 5px; padding: 4px 8px; width: 150px; outline: none;
  }
  .btn, label.pill {
    display: inline-flex; align-items: center; gap: 4px;
    background: var(--bg); color: var(--fg); border: 1px solid var(--border);
    border-radius: 5px; padding: 3px 8px; cursor: pointer; user-select: none;
  }
  .btn:hover, label.pill:hover { border-color: var(--accent); }
  .btn.active { background: color-mix(in srgb, var(--accent) 22%, var(--bg)); border-color: var(--accent); }
  .stats { margin-left: auto; color: var(--muted); display: flex; gap: 10px; flex-wrap: wrap; }
  .stat-warn { color: #f59e0b; font-weight: 600; }
  .legend {
    position: absolute; bottom: 10px; left: 10px; z-index: 10;
    display: flex; flex-wrap: wrap; gap: 10px; align-items: center;
    background: color-mix(in srgb, var(--panel) 88%, transparent);
    border: 1px solid var(--border); border-radius: 8px; padding: 6px 10px;
    color: var(--muted);
  }
  .dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 4px; vertical-align: middle; }
  .tooltip {
    position: absolute; pointer-events: none; z-index: 20; display: none;
    background: var(--panel); color: var(--fg); border: 1px solid var(--border);
    border-radius: 7px; padding: 7px 10px; max-width: 280px; box-shadow: 0 6px 18px rgba(0,0,0,0.35);
  }
  canvas { display: block; width: 100%; height: 100%; cursor: grab; }
  canvas:active { cursor: grabbing; }
</style>
</head>
<body>
  <div class="toolbar">
    <input id="search" type="search" placeholder="Filter title or #tag..." />
    <button id="modeBtn" class="btn" title="Switch between full project graph and 1-2 hop local neighborhood">Global</button>
    <button id="depthBtn" class="btn" style="display:none;" title="Local neighborhood depth">2-hop</button>
    <label class="pill"><input type="checkbox" id="fPapers" checked /> Papers</label>
    <label class="pill"><input type="checkbox" id="fTex" checked /> LaTeX</label>
    <label class="pill"><input type="checkbox" id="fArtifacts" checked /> Artifacts</label>
    <label class="pill"><input type="checkbox" id="fGhosts" checked /> Ghosts</label>
    <label class="pill" title="Show .dupe/brain agent brainstorm files (hidden by default so human brain stays clean)"><input type="checkbox" id="fAgent" /> Agent Brain</label>
    <label class="pill"><input type="checkbox" id="fOrphans" /> Orphans Only</label>
    <button id="pauseBtn" class="btn">Pause</button>
    <button id="resetBtn" class="btn">Fit</button>
    <div id="stats" class="stats"></div>
  </div>
  <div class="legend">
    <span><i class="dot" style="background:#f59e0b"></i>MOC</span>
    <span><i class="dot" style="background:#38bdf8"></i>Concept</span>
    <span><i class="dot" style="background:#34d399"></i>Note</span>
    <span><i class="dot" style="background:#c084fc"></i>Artifact</span>
    <span><i class="dot" style="background:#fb7185"></i>Paper</span>
    <span><i class="dot" style="background:#facc15"></i>LaTeX</span>
    <span><i class="dot" style="background:#2dd4bf"></i>Code</span>
    <span><i class="dot" style="border:1.5px dashed #9ca3af;background:transparent"></i>Ghost (click to create)</span>
    <span><i class="dot" style="background:#94a3b8"></i>Agent Brain</span>
  </div>
  <div id="tooltip" class="tooltip"></div>
  <canvas id="canvas"></canvas>
<script>
const vscode = acquireVsCodeApi();
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const tooltip = document.getElementById('tooltip');

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

let rawGraph = { nodes: [], edges: [], focusNodeId: null, summary: {} };
let simNodes = [];
let simEdges = [];
let nodeById = new Map();
let cam = { x: 0, y: 0, zoom: 1 };
let paused = false;
let localMode = false;
let localDepth = 2;
let hovered = null;
let dragNode = null;
let panning = false;
let panStart = { x: 0, y: 0 };
let pointerMoved = false;

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

function resize() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = window.innerWidth * dpr;
  canvas.height = window.innerHeight * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resize);
resize();

function screenToWorld(sx, sy) {
  return {
    x: (sx - window.innerWidth / 2) / cam.zoom + cam.x,
    y: (sy - window.innerHeight / 2) / cam.zoom + cam.y,
  };
}

function worldToScreen(wx, wy) {
  return {
    x: (wx - cam.x) * cam.zoom + window.innerWidth / 2,
    y: (wy - cam.y) * cam.zoom + window.innerHeight / 2,
  };
}

function rebuildVisibleGraph() {
  const q = elSearch.value.trim().toLowerCase();
  const prevPositions = new Map(simNodes.map((n) => [n.id, { x: n.x, y: n.y, vx: n.vx, vy: n.vy }]));

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
        radius: n.kind === 'moc' ? 11 : Math.min(12, 4.5 + Math.sqrt(n.degree || 0) * 1.6),
      };
    });

  nodeById = new Map(simNodes.map((n) => [n.id, n]));
  simEdges = rawGraph.edges.filter((e) => nodeById.has(e.source) && nodeById.has(e.target));

  const s = rawGraph.summary || {};
  elStats.innerHTML =
    '<span><b>' + simNodes.length + '</b> nodes · <b>' + simEdges.length + '</b> links</span>' +
    (s.orphanCount ? '<span class="stat-warn">' + s.orphanCount + ' orphans</span>' : '') +
    (s.bloatedCount ? '<span class="stat-warn">' + s.bloatedCount + ' bloated (&gt;150L)</span>' : '');
}

function tickPhysics() {
  if (paused || simNodes.length === 0) return;
  const nLen = simNodes.length;
  for (let i = 0; i < nLen; i++) {
    const a = simNodes[i];
    // Center gravity
    a.vx -= a.x * 0.0028;
    a.vy -= a.y * 0.0028;
    for (let j = i + 1; j < nLen; j++) {
      const b = simNodes[j];
      const dx = b.x - a.x || 0.01;
      const dy = b.y - a.y || 0.01;
      const distSq = dx * dx + dy * dy + 16;
      const force = 520 / distSq;
      const fx = (dx / Math.sqrt(distSq)) * force;
      const fy = (dy / Math.sqrt(distSq)) * force;
      a.vx -= fx;
      a.vy -= fy;
      b.vx += fx;
      b.vy += fy;
    }
  }

  for (const e of simEdges) {
    const src = nodeById.get(e.source);
    const dst = nodeById.get(e.target);
    if (!src || !dst) continue;
    const dx = dst.x - src.x;
    const dy = dst.y - src.y;
    const dist = Math.hypot(dx, dy) || 1;
    const targetLen = 95;
    const pull = (dist - targetLen) * 0.016;
    const fx = (dx / dist) * pull;
    const fy = (dy / dist) * pull;
    src.vx += fx;
    src.vy += fy;
    dst.vx -= fx;
    dst.vy -= fy;
  }

  for (const n of simNodes) {
    if (dragNode === n) continue;
    n.vx *= 0.84;
    n.vy *= 0.84;
    n.x += Math.max(-12, Math.min(12, n.vx));
    n.y += Math.max(-12, Math.min(12, n.vy));
  }
}

function draw() {
  tickPhysics();
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);

  const neighborSet = new Set();
  if (hovered) {
    neighborSet.add(hovered.id);
    for (const e of simEdges) {
      if (e.source === hovered.id) neighborSet.add(e.target);
      if (e.target === hovered.id) neighborSet.add(e.source);
    }
  }

  // Draw edges
  for (const e of simEdges) {
    const a = nodeById.get(e.source);
    const b = nodeById.get(e.target);
    if (!a || !b) continue;
    const pa = worldToScreen(a.x, a.y);
    const pb = worldToScreen(b.x, b.y);
    const active = !hovered || (e.source === hovered.id || e.target === hovered.id);
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
    if (e.kind === 'cite') ctx.strokeStyle = active ? 'rgba(251,113,133,0.45)' : 'rgba(251,113,133,0.08)';
    else if (e.kind === 'provenance') ctx.strokeStyle = active ? 'rgba(45,212,191,0.5)' : 'rgba(45,212,191,0.08)';
    else ctx.strokeStyle = active ? 'rgba(148,163,184,0.45)' : 'rgba(148,163,184,0.08)';
    ctx.lineWidth = active && hovered ? 1.6 : 1;
    ctx.stroke();
  }

  // Draw nodes & labels
  for (const n of simNodes) {
    const p = worldToScreen(n.x, n.y);
    const dim = hovered && !neighborSet.has(n.id);
    ctx.save();
    ctx.globalAlpha = dim ? 0.2 : 1;
    const r = n.radius * Math.max(0.75, Math.min(1.4, cam.zoom));

    if (n.bloated) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, r + 4, 0, Math.PI * 2);
      ctx.strokeStyle = '#ef4444';
      ctx.lineWidth = 1.6;
      ctx.stroke();
    }

    if (n.id === rawGraph.focusNodeId) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, r + 4, 0, Math.PI * 2);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.6;
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    if (n.kind === 'ghost') {
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = KIND_COLOR.ghost;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    } else {
      ctx.fillStyle = KIND_COLOR[n.kind] || '#38bdf8';
      ctx.fill();
    }

    if (cam.zoom >= 0.65 || n.degree >= 2 || hovered === n || neighborSet.has(n.id)) {
      ctx.font = (n.kind === 'moc' ? '600 11px ' : '10.5px ') + 'system-ui, sans-serif';
      ctx.fillStyle = '#e4e4e7';
      ctx.textAlign = 'center';
      ctx.fillText(n.label, p.x, p.y + r + 12);
    }
    ctx.restore();
  }
  requestAnimationFrame(draw);
}
requestAnimationFrame(draw);

function hitTest(sx, sy) {
  const w = screenToWorld(sx, sy);
  for (let i = simNodes.length - 1; i >= 0; i--) {
    const n = simNodes[i];
    const hitR = n.radius + 6 / cam.zoom;
    if (Math.hypot(n.x - w.x, n.y - w.y) <= hitR) return n;
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
    const w = screenToWorld(ev.clientX, ev.clientY);
    dragNode.x = w.x; dragNode.y = w.y; dragNode.vx = 0; dragNode.vy = 0;
  } else if (panning) {
    cam.x -= (ev.clientX - panStart.x) / cam.zoom;
    cam.y -= (ev.clientY - panStart.y) / cam.zoom;
    panStart = { x: ev.clientX, y: ev.clientY };
  } else {
    hovered = hitTest(ev.clientX, ev.clientY);
    if (hovered) {
      tooltip.style.display = 'block';
      tooltip.style.left = Math.min(window.innerWidth - 290, ev.clientX + 14) + 'px';
      tooltip.style.top = Math.min(window.innerHeight - 90, ev.clientY + 14) + 'px';
      const tagsStr = (hovered.tags || []).map((t) => '#' + t).join(' ');
      tooltip.innerHTML =
        '<div><b>' + hovered.label + '</b> <span style="opacity:.7">(' + hovered.kind + ')</span></div>' +
        (hovered.path ? '<div style="opacity:.75;font-size:11px">' + hovered.path + '</div>' : '') +
        (hovered.lines ? '<div style="font-size:11px">' + hovered.lines + ' lines · ' + hovered.backlinks + ' backlinks</div>' : '<div style="font-size:11px">' + hovered.backlinks + ' backlinks</div>') +
        (tagsStr ? '<div style="color:#38bdf8;font-size:11px">' + tagsStr + '</div>' : '') +
        (hovered.bloated ? '<div style="color:#ef4444;font-size:11px">Over 150-line anti-bloat limit</div>' : '');
    } else {
      tooltip.style.display = 'none';
    }
  }
});

window.addEventListener('pointerup', (ev) => {
  if (!pointerMoved && dragNode) {
    vscode.postMessage({ type: 'openNode', id: dragNode.id, kind: dragNode.kind, path: dragNode.path, label: dragNode.label });
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
elReset.addEventListener('click', () => {
  cam = { x: 0, y: 0, zoom: 1 };
});

window.addEventListener('message', (ev) => {
  const msg = ev.data;
  if (msg && msg.type === 'graphData') {
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
    rebuildVisibleGraph();
  }
});

vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
  }
}
