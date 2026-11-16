import React, { useRef, useState } from 'react';

export interface PaneDescriptor {
  id: string;
  title: string;
  visible: boolean;
  defaultWeight?: number;
  content: React.ReactNode;
}

interface SplitWorkspaceProps {
  panes: PaneDescriptor[];
}

export const SplitWorkspace: React.FC<SplitWorkspaceProps> = ({ panes }) => {
  const visiblePanes = panes.filter((p) => p.visible);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [weights, setWeights] = useState<Record<string, number>>(() => {
    const initial: Record<string, number> = {};
    panes.forEach((p) => {
      initial[p.id] = p.defaultWeight ?? 1;
    });
    return initial;
  });

  const handleDividerPointerDown = (
    leftId: string,
    rightId: string,
    event: React.PointerEvent<HTMLDivElement>,
  ) => {
    event.preventDefault();
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const totalWidth = container.getBoundingClientRect().width;
    const totalWeight = visiblePanes.reduce((acc, p) => acc + (weights[p.id] ?? 1), 0);
    const startX = event.clientX;
    const startLeft = weights[leftId] ?? 1;
    const startRight = weights[rightId] ?? 1;

    const onMove = (moveEvent: PointerEvent) => {
      const deltaPx = moveEvent.clientX - startX;
      const deltaWeight = (deltaPx / Math.max(1, totalWidth)) * totalWeight;
      const minWeight = 0.35;
      const clampedDelta = Math.max(
        minWeight - startLeft,
        Math.min(startRight - minWeight, deltaWeight),
      );
      setWeights((prev) => ({
        ...prev,
        [leftId]: startLeft + clampedDelta,
        [rightId]: startRight - clampedDelta,
      }));
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  if (visiblePanes.length === 0) {
    return (
      <div className="empty-workspace">
        Enable at least one pane from the top toolbar to start working.
      </div>
    );
  }

  return (
    <div className="split-workspace" ref={containerRef}>
      {visiblePanes.map((pane, idx) => {
        const weight = weights[pane.id] ?? pane.defaultWeight ?? 1;
        const nextPane = visiblePanes[idx + 1];
        return (
          <React.Fragment key={pane.id}>
            <section className="workspace-pane" style={{ flex: `${weight} 1 0%` }}>
              <header className="pane-header">
                <span className="pane-title">{pane.title}</span>
              </header>
              <div className="pane-body">{pane.content}</div>
            </section>
            {nextPane && (
              <div
                className="pane-divider"
                role="separator"
                aria-orientation="vertical"
                onPointerDown={(e) => handleDividerPointerDown(pane.id, nextPane.id, e)}
              />
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
};
