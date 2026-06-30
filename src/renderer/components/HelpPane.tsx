import { useEffect, useMemo, useRef } from 'react';
import type { Tool } from '../../shared/types';
import { md } from '../lib/markdown';
import { runCommand } from '../lib/termRegistry';

export function HelpPane(props: { tool: Tool; activeToolId: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const html = useMemo(() => md.render(props.tool.helpMarkdown), [props.tool.helpMarkdown]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onClick = (e: MouseEvent) => {
      const btn = (e.target as HTMLElement).closest('.cmd-btn') as HTMLButtonElement | null;
      if (!btn) return;
      const command = btn.dataset['cmd'] ?? '';
      const edit = btn.dataset['edit'] === '1';
      const opts = {
        cwd: props.tool.meta.cwd,
        shell: props.tool.meta.shell,
        env: props.tool.meta.env,
      };
      runCommand(props.activeToolId, command, edit, opts);
    };
    el.addEventListener('click', onClick);
    return () => el.removeEventListener('click', onClick);
  }, [props.activeToolId, props.tool.meta]);

  return <div className="help" ref={ref} dangerouslySetInnerHTML={{ __html: html }} />;
}
