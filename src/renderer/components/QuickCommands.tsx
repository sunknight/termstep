import { useEffect, useRef, useState } from 'react';
import { parseButtonsFromMarkdown } from '../../shared/buttonBlock';
import type { Tool, PtySpawnOpts } from '../../shared/types';
import { runCommandChecked } from '../lib/runCommandChecked';

// Global quick-command dropdown. The command list lives in a single markdown
// file (read/written via api.quick) — NOT a tool. Its `buttons` blocks are
// surfaced app-wide; clicking one runs the command in the ACTIVE tool's
// terminal. "编辑" opens a modal that edits only that markdown.
export function QuickCommands(props: { activeTool: Tool | null }) {
  const [md, setMd] = useState('');
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    window.api.quick.get().then(setMd);
  }, []);
  // Re-read whenever the dropdown opens, so edits/external changes are picked up.
  useEffect(() => {
    if (open) window.api.quick.get().then(setMd);
  }, [open]);

  // Close the dropdown on outside-click / Escape.
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

  const buttons = parseButtonsFromMarkdown(md);

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

  const openEditor = () => {
    setDraft(md);
    setEditing(true);
    setOpen(false);
  };
  const saveDraft = async () => {
    setSaving(true);
    try {
      await window.api.quick.save(draft);
      setMd(draft);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  const disabled = !props.activeTool;

  return (
    <>
      <div className="quick-cmd" ref={wrapRef}>
        <button
          className="quick-cmd-toggle"
          title="快捷命令"
          disabled={disabled}
          onClick={() => setOpen((v) => !v)}
        >
          ⚡ 快捷命令
        </button>
        {open && (
          <div className="quick-cmd-menu">
            {buttons.length === 0 ? (
              <div className="quick-cmd-empty">暂无快捷命令，点底部「编辑」添加</div>
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
            <button className="quick-cmd-edit" onClick={openEditor}>
              ✎ 编辑
            </button>
          </div>
        )}
      </div>

      {editing && (
        <div className="modal-overlay" onClick={() => setEditing(false)}>
          <div className="modal quick-editor" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">编辑快捷命令</div>
            <div className="modal-hint">
              用 <code>```buttons</code> 围栏块定义按钮，每行一条，语法 <code>命令 [# 标签] [// edit]</code>。
            </div>
            <textarea
              className="quick-editor-md"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              autoFocus
              spellCheck={false}
              placeholder={'```buttons\npwd # 当前目录\nls -la\nclear\n```'}
            />
            <div className="modal-actions">
              <button className="primary" onClick={saveDraft} disabled={saving}>
                {saving ? '保存中…' : '保存'}
              </button>
              <button onClick={() => setEditing(false)}>取消</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
