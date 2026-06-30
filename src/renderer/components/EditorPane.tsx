import { useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import type { Tool, ToolMeta } from '../../shared/types';

// A small, curated set of icons that read well at sidebar size. Clicking one fills
// the icon input above the grid.
const COMMON_ICONS = [
  '★', '☆', '▶', '◆', '●', '◐',
  '🛠️', '⚙️', '🔧', '🧰', '🗄️', '🗃️',
  '📁', '📂', '📦', '💾', '🖥️', '💻',
  '🚀', '⚡', '🔥', '🌐', '🌍', '🌙',
  '🐳', '📟', '📊', '📈', '📝', '🔍',
  '🔑', '🔒', '🧪', '🐛', '🎨', '⏱️',
];

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
      <div className="editor-header">编辑工具</div>
      <div className="meta-form">
        <label className="field">
          <span className="field-label">名称</span>
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </label>
        <label className="field">
          <span className="field-label">图标</span>
          <input
            className="icon-input"
            value={icon}
            onChange={(e) => setIcon(e.target.value)}
          />
        </label>
        <div className="icon-picker" role="listbox" aria-label="常用图标">
          {COMMON_ICONS.map((ic) => (
            <button
              key={ic}
              type="button"
              className={'icon-cell' + (ic === icon ? ' selected' : '')}
              title={ic}
              onClick={() => setIcon(ic)}
            >
              {ic}
            </button>
          ))}
        </div>
        <label className="field">
          <span className="field-label">起始目录</span>
          <input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="~" />
        </label>
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
        <button className="primary" onClick={save} disabled={saving}>
          {saving ? '保存中…' : '保存'}
        </button>
        <button onClick={props.onDone}>取消</button>
      </div>
      {error && <div className="editor-error">{error}</div>}
    </div>
  );
}
