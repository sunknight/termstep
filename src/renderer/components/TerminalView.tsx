import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { PtySpawnOpts } from '../../shared/types';
import { termRegistry } from '../lib/termRegistry';

export function TerminalView(props: {
  toolId: string;
  spawnOpts: PtySpawnOpts;
  active: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    if (!containerRef.current || termRef.current) return;
    const term = new Terminal({ fontFamily: 'Menlo, monospace', fontSize: 13, scrollback: 5000 });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    try {
      fit.fit();
    } catch {
      // container not laid out yet; refit on active change
    }
    termRef.current = term;
    fitRef.current = fit;
    termRegistry.set(props.toolId, term);

    const offData = window.api.pty.onData((tid, data) => {
      if (tid === props.toolId) term.write(data);
    });
    const dInput = term.onData((data) => window.api.pty.write(props.toolId, data, props.spawnOpts));
    const dResize = term.onResize(({ cols, rows }) => window.api.pty.resize(props.toolId, cols, rows));

    return () => {
      offData();
      dInput.dispose();
      dResize.dispose();
      termRegistry.del(props.toolId);
      term.dispose();
      termRef.current = null;
    };
  }, [props.toolId]);

  useEffect(() => {
    if (props.active) {
      try {
        fitRef.current?.fit();
      } catch {
        // ignore
      }
      termRef.current?.focus();
    }
  }, [props.active]);

  return (
    <div
      ref={containerRef}
      className="term"
      style={{ display: props.active ? 'block' : 'none', height: '100%' }}
    />
  );
}
