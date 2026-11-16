import React, { useMemo, useRef, useState } from 'react';
import {
  DiagramElement,
  DiagramShapeType,
  ExcalidrawCompatibleScene,
  exportDiagramToSvg,
} from './svgExport';

interface DiagramPaneProps {
  figureName: string;
  elements: DiagramElement[];
  hasActiveRepo: boolean;
  onChangeFigureName: (name: string) => void;
  onChangeElements: (elements: DiagramElement[]) => void;
  onExportFigureToProject: (
    figureName: string,
    svgContent: string,
    sceneJson: string,
    insertIntoLatex: boolean,
  ) => Promise<void>;
}

const DEFAULT_COLORS = [
  { stroke: '#1e40af', fill: '#dbeafe', name: 'Blue' },
  { stroke: '#065f46', fill: '#d1fae5', name: 'Emerald' },
  { stroke: '#92400e', fill: '#fef3c7', name: 'Amber' },
  { stroke: '#6b21a8', fill: '#f3e8ff', name: 'Purple' },
  { stroke: '#334155', fill: '#f1f5f9', name: 'Slate' },
];

export const DiagramPane: React.FC<DiagramPaneProps> = ({
  figureName,
  elements,
  hasActiveRepo,
  onChangeFigureName,
  onChangeElements,
  onExportFigureToProject,
}) => {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeColorIdx, setActiveColorIdx] = useState(0);
  const [exporting, setExporting] = useState(false);
  const svgStageRef = useRef<SVGSVGElement | null>(null);

  const selectedElement = useMemo(
    () => elements.find((el) => el.id === selectedId) || null,
    [elements, selectedId],
  );

  const addShape = (type: DiagramShapeType) => {
    const palette = DEFAULT_COLORS[activeColorIdx] || DEFAULT_COLORS[0];
    const offset = (elements.length % 5) * 28;
    const newEl: DiagramElement = {
      id: crypto.randomUUID(),
      type,
      x: 80 + offset,
      y: 60 + offset,
      width: type === 'arrow' ? 140 : 150,
      height: type === 'arrow' ? 0 : 72,
      stroke: palette.stroke,
      fill: palette.fill,
      label:
        type === 'rect'
          ? 'Module'
          : type === 'ellipse'
            ? 'State'
            : type === 'diamond'
              ? 'Decision'
              : type === 'text'
                ? 'Annotation'
                : '',
    };
    onChangeElements([...elements, newEl]);
    setSelectedId(newEl.id);
  };

  const updateSelected = (patch: Partial<DiagramElement>) => {
    if (!selectedId) {
      return;
    }
    onChangeElements(
      elements.map((el) => (el.id === selectedId ? { ...el, ...patch } : el)),
    );
  };

  const deleteSelected = () => {
    if (!selectedId) {
      return;
    }
    onChangeElements(elements.filter((el) => el.id !== selectedId));
    setSelectedId(null);
  };

  const handleShapePointerDown = (
    el: DiagramElement,
    event: React.PointerEvent<SVGGElement>,
  ) => {
    event.stopPropagation();
    setSelectedId(el.id);
    const startX = event.clientX;
    const startY = event.clientY;
    const origX = el.x;
    const origY = el.y;

    const onMove = (moveEvent: PointerEvent) => {
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;
      onChangeElements(
        elements.map((item) =>
          item.id === el.id
            ? { ...item, x: Math.round(origX + dx), y: Math.round(origY + dy) }
            : item,
        ),
      );
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const handleExport = async (insertIntoLatex: boolean) => {
    setExporting(true);
    try {
      const cleanName =
        figureName
          .trim()
          .replace(/\.(svg|excalidraw|pdf)$/i, '')
          .replace(/[^a-zA-Z0-9_-]/g, '_') || 'architecture';
      const svgContent = exportDiagramToSvg(elements);
      const scene: ExcalidrawCompatibleScene = {
        type: 'excalidraw',
        version: 2,
        source: 'dupe',
        elements,
      };
      await onExportFigureToProject(
        cleanName,
        svgContent,
        JSON.stringify(scene, null, 2),
        insertIntoLatex,
      );
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="diagram-pane">
      <div className="diagram-toolbar">
        <div className="row-gap">
          <button type="button" className="btn-tiny" onClick={() => addShape('rect')}>
            + Box
          </button>
          <button type="button" className="btn-tiny" onClick={() => addShape('ellipse')}>
            + Ellipse
          </button>
          <button type="button" className="btn-tiny" onClick={() => addShape('diamond')}>
            + Diamond
          </button>
          <button type="button" className="btn-tiny" onClick={() => addShape('arrow')}>
            + Arrow
          </button>
          <button type="button" className="btn-tiny" onClick={() => addShape('text')}>
            + Text
          </button>
          <div className="color-swatches">
            {DEFAULT_COLORS.map((c, idx) => (
              <button
                key={c.name}
                type="button"
                className={`color-dot ${idx === activeColorIdx ? 'active' : ''}`}
                style={{ backgroundColor: c.fill, borderColor: c.stroke }}
                title={c.name}
                onClick={() => {
                  setActiveColorIdx(idx);
                  if (selectedId) {
                    updateSelected({ stroke: c.stroke, fill: c.fill });
                  }
                }}
              />
            ))}
          </div>
        </div>

        <div className="row-gap">
          <input
            type="text"
            className="figure-name-input"
            value={figureName}
            onChange={(e) => onChangeFigureName(e.target.value)}
            placeholder="figure_name"
          />
          <button
            type="button"
            className="btn-secondary btn-small"
            disabled={exporting}
            onClick={() => void handleExport(false)}
          >
            Save SVG {hasActiveRepo ? 'to Repo' : ''}
          </button>
          <button
            type="button"
            className="btn-primary btn-small"
            disabled={exporting}
            onClick={() => void handleExport(true)}
            title="Export figures/<name>.svg and insert \begin{figure} into LaTeX"
          >
            Export & Insert \includegraphics
          </button>
        </div>
      </div>

      {selectedElement && (
        <div className="diagram-inspector">
          <label>
            Label:
            <input
              type="text"
              value={selectedElement.label}
              onChange={(e) => updateSelected({ label: e.target.value })}
            />
          </label>
          <label>
            W:
            <input
              type="number"
              value={selectedElement.width}
              onChange={(e) => updateSelected({ width: Number(e.target.value) })}
            />
          </label>
          <label>
            H:
            <input
              type="number"
              value={selectedElement.height}
              onChange={(e) => updateSelected({ height: Number(e.target.value) })}
            />
          </label>
          <button type="button" className="btn-tiny danger" onClick={deleteSelected}>
            Delete Shape
          </button>
        </div>
      )}

      <div className="diagram-canvas-wrap" onPointerDown={() => setSelectedId(null)}>
        <svg ref={svgStageRef} className="diagram-svg-stage" viewBox="0 0 800 500">
          <defs>
            <marker
              id="stage-arrow"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 1 L 10 5 L 0 9 z" fill="#334155" />
            </marker>
          </defs>
          {elements.map((el) => {
            const isSel = el.id === selectedId;
            const cx = el.x + el.width / 2;
            const cy = el.y + el.height / 2;
            return (
              <g
                key={el.id}
                className={`diagram-node ${isSel ? 'selected' : ''}`}
                onPointerDown={(e) => handleShapePointerDown(el, e)}
              >
                {el.type === 'rect' && (
                  <rect
                    x={el.x}
                    y={el.y}
                    width={Math.max(10, el.width)}
                    height={Math.max(10, el.height)}
                    rx={8}
                    fill={el.fill}
                    stroke={el.stroke}
                    strokeWidth={isSel ? 3 : 2}
                  />
                )}
                {el.type === 'ellipse' && (
                  <ellipse
                    cx={cx}
                    cy={cy}
                    rx={Math.max(8, Math.abs(el.width) / 2)}
                    ry={Math.max(8, Math.abs(el.height) / 2)}
                    fill={el.fill}
                    stroke={el.stroke}
                    strokeWidth={isSel ? 3 : 2}
                  />
                )}
                {el.type === 'diamond' && (
                  <polygon
                    points={`${cx},${el.y} ${el.x + el.width},${cy} ${cx},${
                      el.y + el.height
                    } ${el.x},${cy}`}
                    fill={el.fill}
                    stroke={el.stroke}
                    strokeWidth={isSel ? 3 : 2}
                  />
                )}
                {el.type === 'arrow' && (
                  <line
                    x1={el.x}
                    y1={el.y}
                    x2={el.x + el.width}
                    y2={el.y + el.height}
                    stroke={el.stroke}
                    strokeWidth={2.5}
                    markerEnd="url(#stage-arrow)"
                  />
                )}
                {el.type === 'text' ? (
                  <text
                    x={el.x}
                    y={el.y + 18}
                    fontSize={16}
                    fontWeight={600}
                    fill={el.stroke}
                  >
                    {el.label || 'Label'}
                  </text>
                ) : (
                  el.label && (
                    <text
                      x={cx}
                      y={cy}
                      dominantBaseline="middle"
                      textAnchor="middle"
                      fontSize={14}
                      fill="#1e293b"
                    >
                      {el.label}
                    </text>
                  )
                )}
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
};
