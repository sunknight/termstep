import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { PtySpawnOpts } from '../../shared/types';
import { termRegistry } from '../lib/termRegistry';
import { api } from '../lib/api';
import { useTauriEvent } from '../hooks/useTauriEvent';

export function TerminalView(props: {
  toolId: string;
  spawnOpts: PtySpawnOpts;
  active: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  // pty:data 订阅提到组件顶层：handler 通过 termRef 写入对应终端。
  // firstData 标志强制首帧重绘（xterm v5 首次 open+fit 后偶尔漏画 prompt）。
  const firstDataRef = useRef(true);
  useTauriEvent<{ toolId: string; data: string }>('pty:data', ({ toolId, data }) => {
    if (toolId !== props.toolId) return;
    const term = termRef.current;
    if (!term) return;
    term.write(data);
    if (firstDataRef.current) {
      firstDataRef.current = false;
      requestAnimationFrame(() => term.refresh(0, term.rows - 1));
    }
  });

  // Create the xterm terminal lazily the first time this tool becomes visible.
  // Opening xterm while its container is display:none leaves the renderer unable
  // to paint — which is why the auto-selected first tool showed a blank terminal
  // on startup (it mounted hidden, then was activated before the renderer settled).
  useEffect(() => {
    if (!props.active) return;

    if (!termRef.current && containerRef.current) {
      // macOptionClickForcesSelection: when an app captures the mouse (e.g. tmux
      // `set -g mouse on`), xterm disables its selection service. On macOS the
      // only way to force a native drag-selection through that capture is to hold
      // Option (⌥) — but only if this option is on. Without it, Option+drag is
      // reported to the app and the xterm selection never sticks, so users can't
      // select-and-copy inside tmux. (The mouse-event dispatcher also honors this
      // and skips reporting to the pty while Option is held.)
      const term = new Terminal({
        fontFamily: 'Menlo, monospace',
        fontSize: 13,
        scrollback: 5000,
        macOptionClickForcesSelection: true,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(containerRef.current); // container is visible (active => display:block)
      termRef.current = term;
      fitRef.current = fit;
      termRegistry.set(props.toolId, term);

      // Copy-on-select (iTerm2-style): whenever the user makes (or extends) an
      // xterm selection — including an Option-forced selection under tmux mouse
      // capture — push it to the system clipboard. tmux's own mouse-mode
      // selections never trigger this (they don't fire onSelectionChange), so
      // only real xterm selections are copied.
      term.onSelectionChange(() => {
        const text = term.getSelection();
        if (text) void api.clipboard.writeText(text);
      });

      // ⌘C copies the current selection; ⌘V pastes the clipboard into the pty.
      // Returning false tells xterm not to also process the keystroke.
      term.attachCustomKeyEventHandler((ev) => {
        if (ev.type !== 'keydown') return true;
        const key = ev.key.toLowerCase();
        if (ev.metaKey && key === 'c') {
          if (term.hasSelection()) {
            void api.clipboard.writeText(term.getSelection());
            return false;
          }
          return true; // nothing selected — let it pass (no-op)
        }
        if (ev.metaKey && key === 'v') {
          // preventDefault is essential: returning false only stops xterm's
          // *key* handling — it does NOT stop the browser's default Cmd+V.
          // xterm also registers a `paste` event listener on the textarea
          // (Terminal.ts -> Clipboard.ts handlePasteEvent) that would read
          // event.clipboardData and paste again, duplicating the text
          // ("tmux" -> "tmuxtmux"). Without this the native paste fires too.
          ev.preventDefault();
          api.clipboard.readText().then((text) => {
            if (text) term.paste(text);
          });
          return false;
        }
        return true;
      });

      // OSC 52 clipboard passthrough: when a program in the terminal copies text
      // (e.g. a remote tmux with `set -g set-clipboard on`, where a plain drag
      // selects inside tmux), it emits `ESC ] 52 ; <target> ; <base64> ST`.
      // Decode it onto the local system clipboard so those copies reach the Mac
      // even over SSH. We implement only the SET direction; read queries ('?')
      // and clear requests (empty) are ignored (don't expose the clipboard to
      // remote programs, don't clobber it on a clear).
      term.parser.registerOscHandler(52, (data) => {
        // data = "<target>;<base64>"  (target may be empty or "c,p,..." — we
        // write to the clipboard regardless, macOS has a single clipboard).
        const sep = data.indexOf(';');
        if (sep < 0) return true;
        const b64 = data.slice(sep + 1);
        if (!b64 || b64 === '?') return true;
        try {
          const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
          const text = new TextDecoder('utf-8').decode(bytes);
          void api.clipboard.writeText(text);
        } catch {
          // malformed base64 — ignore
        }
        return true;
      });

      // xterm v5 sometimes skips its first paint after open()+fit() until the next
      // user interaction, leaving the startup prompt invisible ("blank terminal
      // until Enter"). The pty:data subscription (component-top useTauriEvent)
      // forces a repaint on the first data frame.
      term.onData((data) => api.pty.write(props.toolId, data, props.spawnOpts));
      term.onResize(({ cols, rows }) => api.pty.resize(props.toolId, cols, rows));
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
        api.pty.resize(props.toolId, term.cols, term.rows);
      }
      api.pty.open(props.toolId, props.spawnOpts);
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

  // Dispose the terminal when the tool unmounts. (The pty:data subscription is
  // owned by useTauriEvent and cleaned up automatically.)
  useEffect(() => {
    return () => {
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
