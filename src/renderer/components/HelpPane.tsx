import { useEffect, useMemo, useRef, useState } from 'react';
import type { Tool } from '../../shared/types';
import { md } from '../lib/markdown';
import { runCommandChecked } from '../lib/runCommandChecked';

interface TipState {
  text: string;
  left: number;
  top: number;
  bottom: number;
  below: boolean;
}

export function HelpPane(props: { tool: Tool; activeToolId: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const lastBtn = useRef<HTMLElement | null>(null);
  const [tip, setTip] = useState<TipState | null>(null);
  const html = useMemo(() => md.render(props.tool.helpMarkdown), [props.tool.helpMarkdown]);

  useEffect(() => {
    // Clear any showing tooltip when the rendered content changes.
    setTip(null);
  }, [html]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const onClick = (e: MouseEvent) => {
      // Command buttons: inject into the terminal (with a danger confirm).
      const btn = (e.target as HTMLElement).closest('.cmd-btn') as HTMLButtonElement | null;
      if (btn) {
        const command = btn.dataset['cmd'] ?? '';
        const edit = btn.dataset['edit'] === '1';
        const opts = {
          cwd: props.tool.meta.cwd,
          shell: props.tool.meta.shell,
          env: props.tool.meta.env,
          tmux: props.tool.meta.tmux,
          initCommands: props.tool.meta.initCommands,
        };
        runCommandChecked(props.activeToolId, command, edit, opts);
        return;
      }
      // Markdown links: open http(s)/mailto in the system browser instead of
      // trying to navigate the renderer.
      const anchor = (e.target as HTMLElement).closest('a') as HTMLAnchorElement | null;
      if (anchor) {
        const href = anchor.getAttribute('href') ?? '';
        if (/^(https?:|mailto:)/i.test(href)) {
          e.preventDefault();
          void window.api.shell.openExternal(href);
        }
      }
    };

    // Delegated hover: show a fixed-position tooltip with the full command for any
    // labeled button (those carrying data-tip). Instant, custom-styled, and not
    // clipped by the scrolling panel because it is position: fixed.
    const onOver = (e: MouseEvent) => {
      const btn = (e.target as HTMLElement).closest('.cmd-btn') as HTMLElement | null;
      if (btn === lastBtn.current) return; // same button -> no churn
      lastBtn.current = btn;
      const text = btn?.dataset['tip'];
      if (!btn || !text) {
        setTip(null);
        return;
      }
      const r = btn.getBoundingClientRect();
      setTip({ text, left: r.left + r.width / 2, top: r.top, bottom: r.bottom, below: r.top < 50 });
    };
    const onLeave = () => {
      lastBtn.current = null;
      setTip(null);
    };

    el.addEventListener('click', onClick);
    el.addEventListener('mouseover', onOver);
    el.addEventListener('mouseleave', onLeave);
    return () => {
      el.removeEventListener('click', onClick);
      el.removeEventListener('mouseover', onOver);
      el.removeEventListener('mouseleave', onLeave);
    };
  }, [props.activeToolId, props.tool.meta]);

  return (
    <>
      <div className="help" ref={ref} dangerouslySetInnerHTML={{ __html: html }} />
      {tip && (
        <div
          className="cmd-tip"
          style={
            tip.below
              ? { left: `${tip.left}px`, top: `${tip.bottom + 6}px`, transform: 'translate(-50%, 0)' }
              : { left: `${tip.left}px`, top: `${tip.top - 6}px`, transform: 'translate(-50%, -100%)' }
          }
        >
          {tip.text}
        </div>
      )}
    </>
  );
}
