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

export interface ExcalidrawCompatibleScene {
  type: 'excalidraw';
  version: 2;
  source: 'dupe';
  elements: DiagramElement[];
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
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 320" width="600" height="320"><rect width="100%" height="100%" fill="#ffffff"/></svg>`;
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
