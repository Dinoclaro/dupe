export type DiagramShapeType = 'rect' | 'ellipse' | 'diamond' | 'arrow' | 'text';

export interface DiagramElement {
  id: string;
  type: DiagramShapeType;
  x: number;
  y: number;
  width: number;
  height: number;
  stroke: string;
  fill: string;
  label: string;
}

export const DEFAULT_DRAWIO_XML = `<mxfile host="embed.diagrams.net" agent="dupe" version="24.0.0">
  <diagram id="dupe-fig" name="Page-1">
    <mxGraphModel dx="1000" dy="600" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="850" pageHeight="600" math="1" shadow="0">
      <root>
        <mxCell id="0" />
        <mxCell id="1" parent="0" />
        <mxCell id="2" value="PDF Library&#xa;$$\mathcal{D}_{pdf}$$" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;fontSize=14;" vertex="1" parent="1">
          <mxGeometry x="80" y="140" width="150" height="70" as="geometry" />
        </mxCell>
        <mxCell id="3" value="Auto-BibTeX&#xa;\texttt{references.bib}" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;fontSize=14;" vertex="1" parent="1">
          <mxGeometry x="320" y="140" width="160" height="70" as="geometry" />
        </mxCell>
        <mxCell id="4" value="Overleaf / LaTeX&#xa;$$f_\theta(x)$$" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#e1d5e7;strokeColor=#9673a6;fontSize=14;" vertex="1" parent="1">
          <mxGeometry x="570" y="140" width="160" height="70" as="geometry" />
        </mxCell>
        <mxCell id="5" value="PyMuPDF" style="edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;html=1;entryX=0;entryY=0.5;entryDx=0;entryDy=0;strokeWidth=2;" edge="1" parent="1" source="2" target="3">
          <mxGeometry relative="1" as="geometry" />
        </mxCell>
        <mxCell id="6" value="Git Push" style="edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;html=1;entryX=0;entryY=0.5;entryDx=0;entryDy=0;strokeWidth=2;" edge="1" parent="1" source="3" target="4">
          <mxGeometry relative="1" as="geometry" />
        </mxCell>
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>`;

export function decodeDrawioSvgDataUri(dataUriOrSvg: string): string {
  const trimmed = dataUriOrSvg.trim();
  if (trimmed.startsWith('<svg') || trimmed.startsWith('<?xml')) {
    return trimmed;
  }
  const base64Prefix = 'data:image/svg+xml;base64,';
  if (trimmed.startsWith(base64Prefix)) {
    const b64 = trimmed.slice(base64Prefix.length);
    const binary = atob(b64);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder('utf-8').decode(bytes);
  }
  const utf8Prefix = 'data:image/svg+xml;utf8,';
  if (trimmed.startsWith(utf8Prefix)) {
    return decodeURIComponent(trimmed.slice(utf8Prefix.length));
  }
  return trimmed;
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function exportDiagramToSvg(elements: DiagramElement[]): string {
  if (elements.length === 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 220" width="600" height="220"><rect width="100%" height="100%" fill="#ffffff"/></svg>`;
  }

  const padding = 32;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const el of elements) {
    const x1 = Math.min(el.x, el.x + el.width);
    const y1 = Math.min(el.y, el.y + el.height);
    const x2 = Math.max(el.x, el.x + el.width);
    const y2 = Math.max(el.y, el.y + el.height);
    minX = Math.min(minX, x1);
    minY = Math.min(minY, y1);
    maxX = Math.max(maxX, x2);
    maxY = Math.max(maxY, y2);
  }

  const vbX = Math.floor(minX - padding);
  const vbY = Math.floor(minY - padding);
  const vbW = Math.max(240, Math.ceil(maxX - minX + padding * 2));
  const vbH = Math.max(140, Math.ceil(maxY - minY + padding * 2));

  const shapesXml = elements
    .map((el) => {
      const cx = el.x + el.width / 2;
      const cy = el.y + el.height / 2;
      const labelXml = el.label
        ? `<text x="${cx}" y="${cy}" dominant-baseline="middle" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="14" fill="#1e293b">${escapeXml(
            el.label,
          )}</text>`
        : '';

      switch (el.type) {
        case 'rect':
          return `<g><rect x="${el.x}" y="${el.y}" width="${Math.max(10, el.width)}" height="${Math.max(
            10,
            el.height,
          )}" rx="8" fill="${escapeXml(el.fill)}" stroke="${escapeXml(
            el.stroke,
          )}" stroke-width="2"/>${labelXml}</g>`;
        case 'ellipse':
          return `<g><ellipse cx="${cx}" cy="${cy}" rx="${Math.max(5, Math.abs(el.width) / 2)}" ry="${Math.max(
            5,
            Math.abs(el.height) / 2,
          )}" fill="${escapeXml(el.fill)}" stroke="${escapeXml(
            el.stroke,
          )}" stroke-width="2"/>${labelXml}</g>`;
        case 'diamond': {
          const pts = `${cx},${el.y} ${el.x + el.width},${cy} ${cx},${el.y + el.height} ${el.x},${cy}`;
          return `<g><polygon points="${pts}" fill="${escapeXml(el.fill)}" stroke="${escapeXml(
            el.stroke,
          )}" stroke-width="2"/>${labelXml}</g>`;
        }
        case 'arrow': {
          const x2 = el.x + el.width;
          const y2 = el.y + el.height;
          return `<g><line x1="${el.x}" y1="${el.y}" x2="${x2}" y2="${y2}" stroke="${escapeXml(
            el.stroke,
          )}" stroke-width="2.5" marker-end="url(#dupe-arrow)"/>${labelXml}</g>`;
        }
        case 'text':
          return `<text x="${el.x}" y="${el.y + 18}" font-family="Inter, system-ui, sans-serif" font-size="16" font-weight="600" fill="${escapeXml(
            el.stroke,
          )}">${escapeXml(el.label || 'Label')}</text>`;
      }
    })
    .join('\n  ');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vbX} ${vbY} ${vbW} ${vbH}" width="${vbW}" height="${vbH}">
  <defs>
    <marker id="dupe-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M 0 1 L 10 5 L 0 9 z" fill="#334155"/>
    </marker>
  </defs>
  <rect x="${vbX}" y="${vbY}" width="${vbW}" height="${vbH}" fill="#ffffff" rx="6"/>
  ${shapesXml}
</svg>`;
}
