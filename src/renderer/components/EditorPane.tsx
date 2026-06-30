import { useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import type { Tool, ToolMeta } from '../../shared/types';

export function EditorPane(props: { tool: Tool; onDone: () => void }) {
  const [markdownText, setMarkdownText] = useState(props.tool.helpMarkdown);
  const [name, setName] = useState(props.tool.meta.name);
  const [icon, setIcon] = useState(props.tool.meta.icon);
  const [cwd, setCwd] = useState(props.tool.meta.cwd ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setError(null);
    const meta: Partial<ToolMeta> = { name, icon, order: props.tool.meta.order };
    if (cwd.trim()) meta.cwd = cwd.trim();
    try {
      await window.api.tool.save(props.tool.meta.id, markdownText, meta);
      props.onDone();
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="editor">
      <div className="meta-form">
        <label>名称<input value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label>图标<input value={icon} onChange={(e) => setIcon(e.target.value)} size={4} /></label>
        <label>起始目录<input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="~" /></label>
      </div>
      <div className="editor-md">
        <CodeMirror
          value={markdownText}
          height="100%"
          theme="light"
          extensions={[markdown({ base: markdownLanguage })]}
          onChange={(v) => setMarkdownText(v)}
        />
      </div>
      <div className="editor-actions">
        <button onClick={save} disabled={saving}>{saving ? '保存中…' : '保存'}</button>
        <button onClick={props.onDone}>取消</button>
      </div>
      {error && <div className="editor-error">{error}</div>}
    </div>
  );
}
