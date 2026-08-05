import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { PtySpawnOpts } from '../../shared/types';
import { termRegistry } from '../lib/termRegistry';
import { api } from '../lib/api';
import { getXtermTheme } from '../lib/theme';
import { useTauriEvent } from '../hooks/useTauriEvent';

// Squared pixel distance a left-button press must travel to count as a drag
// (and thus keep its xterm selection). Presses that release within this radius
// are treated as clicks and their single-point selection anchor is cleared, so
// trackpad taps / click-to-focus / sub-pixel jitter leave no highlight. 5px
// matches typical editor click-vs-drag thresholds and feels natural.
const DRAG_THRESHOLD = 5;

export function TerminalView(props: {
  toolId: string;
  spawnOpts: PtySpawnOpts;
  active: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  // Holds the teardown for the capture-phase mousedown/mouseup listeners that
  // suppress stray selections (see the selection-jitter effect below). Rebuilt
  // each time a terminal is (re)created in the active-effect.
  const selectionCleanupRef = useRef<(() => void) | null>(null);
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
      const term = new Terminal({
        fontFamily: 'SF Mono, Menlo, monospace',
        fontSize: 13,
        scrollback: 5000,
        // rightClickSelectsWord defaults to true on macOS (xterm's isMac). We
        // have no context menu, so a right-click / two-finger tap would only
        // flash a stray word selection with no way to act on it — disable it so
        // right-clicks stay clean.
        rightClickSelectsWord: false,
        theme: getXtermTheme(),
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(containerRef.current); // container is visible (active => display:block)
      termRef.current = term;
      fitRef.current = fit;
      termRegistry.set(props.toolId, term);

      // Copy-on-select (iTerm2-style): whenever the user makes (or extends) an
      // xterm selection, push it to the system clipboard. tmux's own mouse-mode
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

    // Suppress stray xterm selections from bare clicks / tiny trackpad jitter.
    // xterm has NO option to disable "mousedown establishes a selection anchor":
    // handleMouseDown -> _handleSingleClick sets selectionStart on EVERY left
    // press, then the mousemove listener (registered on mousedown) extends it
    // into a visible highlight on any movement. So a click-to-focus or a tap
    // with a few pixels of drift leaves an annoying highlight. macOptionClick-
    // ForcesSelection / rightClickSelectsWord don't touch this main path, which
    // is why the earlier round did not fix it.
    //
    // Fix: let xterm start its selection normally (so real DRAG selection keeps
    // working from the press-down point), but watch the press in the CAPTURE
    // phase on the outer .term container. On mouseup, if the pointer moved less
    // than DRAG_THRESHOLD px since press-down, call clearSelection() to wipe the
    // single-point anchor xterm just created — leaving clean clicks with no
    // highlight. Only left-button (button 0) presses are tracked; right/middle
    // click and program-mouse-mode (tmux `set -g mouse on`) are untouched
    // because xterm short-circuits them before _handleSingleClick.
    const downEl = containerRef.current;
    if (downEl) {
      let downX = 0;
      let downY = 0;
      let tracking = false;
      const onDown = (e: MouseEvent) => {
        // Only track plain left-button presses. Modifier-clicks (shift+click
        // extends selection, alt+click column-selects, cmd/ctrl are copy) and
        // multi-clicks (double/triple = word/line) are intentional and must be
        // left entirely to xterm — never cleared by the jitter guard.
        if (e.button !== 0 || e.detail > 1 || e.shiftKey || e.altKey || e.metaKey || e.ctrlKey) {
          tracking = false;
          return;
        }
        tracking = true;
        downX = e.clientX;
        downY = e.clientY;
      };
      const onUp = (e: MouseEvent) => {
        if (!tracking) return;
        tracking = false;
        const dx = e.clientX - downX;
        const dy = e.clientY - downY;
        // Pure click or sub-threshold jitter: wipe the anchor xterm set on
        // mousedown so no highlight lingers. A real drag exceeds the threshold
        // and keeps its selection (xterm extended it via its own mousemove).
        // (onDown already declined to track modifier-clicks and multi-clicks,
        // so those intentional selections reach this point with tracking=false
        // and are left untouched.)
        if (dx * dx + dy * dy < DRAG_THRESHOLD * DRAG_THRESHOLD) {
          termRef.current?.clearSelection();
        }
      };
      downEl.addEventListener('mousedown', onDown, true); // capture: fires before xterm
      downEl.addEventListener('mouseup', onUp, true);
      selectionCleanupRef.current = () => {
        downEl.removeEventListener('mousedown', onDown, true);
        downEl.removeEventListener('mouseup', onUp, true);
      };
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
      // Tear down the stray-selection capture listeners too.
      selectionCleanupRef.current?.();
      selectionCleanupRef.current = null;
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className="term"
      // height uses calc instead of 100%: the xterm ResizeObserver watches this
      // element, and only an actual height reduction triggers fit() to recompute
      // rows and lift the last line off the window's bottom edge. padding on the
      // wrapper wouldn't reliably shrink height:100% (percentage-height through
      // padded parents isn't honored in every layout path), leaving the canvas
      // glued to the bottom. 8px keeps the last text row ~6-8px clear of the edge.
      style={{ display: props.active ? 'block' : 'none', height: 'calc(100% - 8px)' }}
    />
  );
}
