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
  const offDataRef = useRef<(() => void) | null>(null);

  // Create the xterm terminal lazily the first time this tool becomes visible.
  // Opening xterm while its container is display:none leaves the renderer unable
  // to paint — which is why the auto-selected first tool showed a blank terminal
  // on startup (it mounted hidden, then was activated before the renderer settled).
  useEffect(() => {
    if (!props.active) return;

    if (!termRef.current && containerRef.current) {
      const term = new Terminal({ fontFamily: 'Menlo, monospace', fontSize: 13, scrollback: 5000 });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(containerRef.current); // container is visible (active => display:block)
      termRef.current = term;
      fitRef.current = fit;
      termRegistry.set(props.toolId, term);

      // xterm v5 sometimes skips its first paint after open()+fit() until the next
      // user interaction, leaving the startup prompt invisible ("blank terminal
      // until Enter"). The first bytes have landed in the buffer by now, so force a
      // full repaint on the next frame to make the prompt show immediately.
      let firstData = true;
      offDataRef.current = window.api.pty.onData((tid, data) => {
        if (tid !== props.toolId) return;
        term.write(data);
        if (firstData) {
          firstData = false;
          requestAnimationFrame(() => term.refresh(0, term.rows - 1));
        }
      });
      term.onData((data) => window.api.pty.write(props.toolId, data, props.spawnOpts));
      term.onResize(({ cols, rows }) => window.api.pty.resize(props.toolId, cols, rows));
    }

    // Defer fit + spawn to the next frame so the just-shown container is laid out.
    const raf = requestAnimationFrame(() => {
      const term = termRef.current;
      try {
        fitRef.current?.fit();
      } catch {
        // ignore
      }
      if (term && term.cols > 0 && term.rows > 0) {
        window.api.pty.resize(props.toolId, term.cols, term.rows);
      }
      window.api.pty.open(props.toolId, props.spawnOpts);
      term?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [props.active]);

  // Refit the terminal when its container resizes — window height changes, the
  // sidebar being dragged, or tool switches all resize the visible pane. Without
  // this the xterm keeps its old rows/cols: shrinking overflows (page scroll),
  // growing leaves blank space. fit() propagates the new size to the pty via the
  // term.onResize handler. Only the active (visible) terminal is refit — fit()
  // on a display:none container breaks xterm's renderer.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      if (!props.active || !termRef.current || !fitRef.current) return;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        try {
          fitRef.current?.fit();
        } catch {
          // container not measurable yet (e.g. mid-transition) — ignore
        }
      });
    });
    ro.observe(el);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [props.active]);

  // Dispose the terminal (and its global data listener) when the tool unmounts.
  useEffect(() => {
    return () => {
      offDataRef.current?.();
      offDataRef.current = null;
      const term = termRef.current;
      if (term) {
        termRegistry.del(props.toolId);
        term.dispose();
        termRef.current = null;
      }
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className="term"
      style={{ display: props.active ? 'block' : 'none', height: '100%' }}
    />
  );
}
