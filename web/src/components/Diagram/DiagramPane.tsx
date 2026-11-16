import React, { useEffect, useRef, useState } from 'react';
import { DEFAULT_DRAWIO_XML, decodeDrawioSvgDataUri } from './svgExport';

interface DiagramPaneProps {
  figureName: string;
  initialXmlOrSvg: string;
  hasActiveRepo: boolean;
  onSaveDiagram: (
    figureName: string,
    svgContent: string,
    xmlContent: string,
    insertIntoLatex: boolean,
  ) => Promise<void>;
}

const DRAWIO_EMBED_URL =
  'https://embed.diagrams.net/?embed=1&proto=json&spin=1&ui=dark&libraries=1&saveAndExit=0&noExitBtn=1';

interface DrawioMessage {
  event?: string;
  xml?: string;
  data?: string;
  format?: string;
}

export const DiagramPane: React.FC<DiagramPaneProps> = ({
  figureName,
  initialXmlOrSvg,
  hasActiveRepo,
  onSaveDiagram,
}) => {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const latestXmlRef = useRef<string>(initialXmlOrSvg || DEFAULT_DRAWIO_XML);
  const pendingInsertRef = useRef<boolean>(false);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);

  const postToDrawio = (payload: Record<string, unknown>) => {
    const win = iframeRef.current?.contentWindow;
    if (win) {
      win.postMessage(JSON.stringify(payload), '*');
    }
  };

  useEffect(() => {
    latestXmlRef.current = initialXmlOrSvg || DEFAULT_DRAWIO_XML;
    if (ready) {
      postToDrawio({
        action: 'load',
        xml: latestXmlRef.current,
        autosave: 1,
      });
    }
  }, [figureName, initialXmlOrSvg, ready]);

  useEffect(() => {
    const handleMessage = (ev: MessageEvent) => {
      if (typeof ev.data !== 'string' || !ev.data.startsWith('{')) {
        return;
      }
      let msg: DrawioMessage;
      try {
        msg = JSON.parse(ev.data) as DrawioMessage;
      } catch {
        return;
      }

      if (msg.event === 'init') {
        setReady(true);
        postToDrawio({
          action: 'load',
          xml: latestXmlRef.current,
          autosave: 1,
        });
        return;
      }

      if (msg.event === 'autosave' && msg.xml) {
        latestXmlRef.current = msg.xml;
        return;
      }

      if (msg.event === 'save') {
        if (msg.xml) {
          latestXmlRef.current = msg.xml;
        }
        postToDrawio({
          action: 'export',
          format: 'xmlsvg',
          xml: latestXmlRef.current,
          spinKey: 'export',
        });
        return;
      }

      if (msg.event === 'export' && msg.data) {
        const svgContent = decodeDrawioSvgDataUri(msg.data);
        const xmlContent = msg.xml || latestXmlRef.current;
        const shouldInsert = pendingInsertRef.current;
        pendingInsertRef.current = false;
        setSaving(true);
        void onSaveDiagram(figureName, svgContent, xmlContent, shouldInsert).finally(() => {
          setSaving(false);
          postToDrawio({ action: 'status', message: 'Saved to figures/' + figureName + '.svg', modified: false });
        });
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [figureName, onSaveDiagram]);

  const requestExport = (insertIntoLatex: boolean) => {
    pendingInsertRef.current = insertIntoLatex;
    postToDrawio({
      action: 'export',
      format: 'xmlsvg',
      xml: latestXmlRef.current,
      spinKey: 'export',
    });
  };

  return (
    <div className="diagram-pane">
      <div className="diagram-toolbar">
        <div className="row-gap">
          <code>figures/{figureName}.svg</code>
          <span className="muted-hint">
            Draw.io Studio · LaTeX math enabled (use <code>$$...$$</code> or <code>\(...\)</code> inside any shape)
          </span>
        </div>

        <div className="row-gap">
          <button
            type="button"
            className="btn-secondary btn-tiny"
            disabled={!ready || saving}
            onClick={() => requestExport(false)}
          >
            {saving ? 'Saving…' : `Save SVG${hasActiveRepo ? ' to Repo' : ''}`}
          </button>
          <button
            type="button"
            className="btn-primary btn-tiny"
            disabled={!ready || saving}
            onClick={() => requestExport(true)}
            title="Export figures/<name>.svg and insert \begin{figure} into active .tex file"
          >
            Save &amp; Insert \includegraphics
          </button>
        </div>
      </div>

      <div className="drawio-iframe-wrap">
        <iframe
          ref={iframeRef}
          src={DRAWIO_EMBED_URL}
          title={`Draw.io — ${figureName}`}
          className="drawio-iframe"
        />
      </div>
    </div>
  );
};
