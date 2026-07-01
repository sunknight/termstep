import { useEffect, useRef, useState } from 'react';
import { parseButtonsFromMarkdown } from '../../shared/buttonBlock';
import { QUICK_TOOL_ID, type Tool, type PtySpawnOpts } from '../../shared/types';
import { runCommandChecked } from '../lib/runCommandChecked';

// Global quick-command dropdown, backed by the reserved _quick tool. Surfaces
// that tool's buttons app-wide; clicking one runs the command in the ACTIVE
// tool's terminal (so cwd/shell/tmux match whatever the user is looking at).
export function QuickCommands(props: { tools: Tool[]; activeTool: Tool | null }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const quick = props.tools.find((t) => t.meta.id === QUICK_TOOL_ID);
  const buttons = quick ? parseButtonsFromMarkdown(quick.helpMarkdown) : [];

  // Close on click-outside / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const run = (command: string, edit: boolean) => {
    const a = props.activeTool;
    if (!a) return;
    const opts: PtySpawnOpts = {
      cwd: a.meta.cwd,
      shell: a.meta.shell,
      env: a.meta.env,
      tmux: a.meta.tmux,
      initCommands: a.meta.initCommands,
    };
    runCommandChecked(a.meta.id, command, edit, opts);
    setOpen(false);
  };

  const disabled = !props.activeTool;

  return (
    <div className="quick-cmd" ref={wrapRef}>
      <button
        className="quick-cmd-toggle"
        title="快捷命令"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        ⚡ 快捷
      </button>
      {open && (
        <div className="quick-cmd-menu">
          {buttons.length === 0 ? (
            <div className="quick-cmd-empty">在「快捷命令」工具中编辑以添加按钮</div>
          ) : (
            buttons.map((b, i) => (
              <button
                key={`${b.command}-${i}`}
                className={'cmd-btn compact' + (b.edit ? ' edit' : '')}
                title={b.command}
                onClick={() => run(b.command, b.edit)}
              >
                <span className="cmd-label">{b.label}</span>
                {b.edit && <span className="cmd-edit-tag">编辑</span>}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
