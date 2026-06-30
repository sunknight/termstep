import type { Tool } from '../../shared/types';
import { TerminalView } from './TerminalView';

export function TerminalPane(props: { tools: Tool[]; activeId: string | null }) {
  return (
    <>
      {props.tools.map((t) => (
        <TerminalView
          key={t.meta.id}
          toolId={t.meta.id}
          active={t.meta.id === props.activeId}
          spawnOpts={{ cwd: t.meta.cwd, shell: t.meta.shell, env: t.meta.env }}
        />
      ))}
    </>
  );
}
