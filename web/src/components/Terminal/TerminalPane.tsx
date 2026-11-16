import React, { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { getStoredToken } from '../../api/client';

interface TerminalPaneProps {
  activeRepoId: string | null;
}

export function buildTerminalWsUrl(
  locationObj: { protocol: string; host: string },
  token: string | null,
  repoId: string | null,
  cols: number,
  rows: number,
): string {
  const wsProto = locationObj.protocol === 'https:' ? 'wss:' : 'ws:';
  const params = new URLSearchParams();
  if (token) {
    params.set('token', token);
  }
  if (repoId) {
    params.set('repo_id', repoId);
  }
  params.set('cols', String(cols));
  params.set('rows', String(rows));
  return `${wsProto}//${locationObj.host}/api/terminal/ws?${params.toString()}`;
}

export const TerminalPane: React.FC<TerminalPaneProps> = ({ activeRepoId }) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [sessionNonce, setSessionNonce] = useState(0);

  const sendCommand = (cmdText: string) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'input', data: `${cmdText}\r` }));
      termRef.current?.focus();
    }
  };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return undefined;
    }

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "'JetBrains Mono', 'Fira Code', Menlo, Monaco, 'Courier New', monospace",
      theme: {
        background: '#0d1117',
        foreground: '#e6edf3',
        cursor: '#58a6ff',
        selectionBackground: 'rgba(56, 139, 253, 0.35)',
      },
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);
    fitAddon.fit();
    termRef.current = term;

    const wsUrl = buildTerminalWsUrl(
      window.location,
      getStoredToken(),
      activeRepoId,
      term.cols || 100,
      term.rows || 30,
    );

    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      fitAddon.fit();
      ws.send(
        JSON.stringify({
          type: 'resize',
          cols: term.cols,
          rows: term.rows,
        }),
      );
      term.focus();
    };

    ws.onmessage = (ev: MessageEvent) => {
      if (ev.data instanceof ArrayBuffer) {
        term.write(new Uint8Array(ev.data));
      } else if (typeof ev.data === 'string') {
        term.write(ev.data);
      }
    };

    ws.onclose = () => {
      setConnected(false);
      term.writeln('\r\n\x1b[33m[Disconnected from server PTY]\x1b[0m');
    };

    const dataSub = term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }));
      }
    });

    const resizeSub = term.onResize(({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols, rows }));
      }
    });

    const observer = new ResizeObserver(() => {
      try {
        fitAddon.fit();
      } catch {
        // ignore transient layout errors
      }
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
      dataSub.dispose();
      resizeSub.dispose();
      ws.close();
      term.dispose();
      wsRef.current = null;
      termRef.current = null;
    };
  }, [activeRepoId, sessionNonce]);

  return (
    <div className="terminal-pane">
      <div className="reader-toolbar">
        <div className="reader-meta">
          <strong>&gt;_ Interactive Server PTY</strong>
          <span className={`status-dot ${connected ? 'online' : 'offline'}`}>
            {connected ? 'Connected' : 'Disconnected'}
          </span>
        </div>
        <div className="reader-controls">
          <button
            type="button"
            className="btn-tiny"
            onClick={() => sendCommand('gemini')}
            title="Launch Gemini / Antigravity CLI in terminal"
          >
            Run gemini
          </button>
          <button
            type="button"
            className="btn-tiny"
            onClick={() => sendCommand('claude')}
            title="Launch Claude Code CLI in terminal"
          >
            Run claude
          </button>
          <button
            type="button"
            className="btn-tiny"
            onClick={() => sendCommand('git status')}
          >
            git status
          </button>
          <button
            type="button"
            className="btn-tiny"
            onClick={() => setSessionNonce((n) => n + 1)}
          >
            Reconnect
          </button>
        </div>
      </div>

      <div className="xterm-stage" ref={containerRef} />
    </div>
  );
};
