import { useEffect, useRef, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import type { Tool, ToolMeta } from '../../shared/types';

// A small, curated set of icons that read well at sidebar size. Shown in a
// popup next to the icon input so it no longer eats vertical space in the form.
const COMMON_ICONS = [
  '★', '☆', '▶', '◆', '●', '◐',
  '🛠️', '⚙️', '🔧', '🧰', '🗄️', '🗃️',
  '📁', '📂', '📦', '💾', '🖥️', '💻',
  '🚀', '⚡', '🔥', '🌐', '🌍', '🌙',
  '🐳', '📟', '📊', '📈', '📝', '🔍',
  '🔑', '🔒', '🧪', '🐛', '🎨', '⏱️',
];

export function EditorPane(props: { tool: Tool; onDone: () => void }) {
  const { meta } = props.tool;
  const isReadOnly = !!meta.readOnly;
  const [markdownText, setMarkdownText] = useState(props.tool.helpMarkdown);
  const [name, setName] = useState(meta.name);
  const [icon, setIcon] = useState(meta.icon);
  const [cwd, setCwd] = useState(meta.cwd ?? '');
  const [tmux, setTmux] = useState(meta.tmux ?? '');
  const [initCommands, setInitCommands] = useState((meta.initCommands ?? []).join('\n'));
  const [mdUrl, setMdUrl] = useState(meta.mdUrl ?? '');
  const [autoUpdate, setAutoUpdate] = useState(meta.autoUpdateMinutes?.toString() ?? '');
  const [iconOpen, setIconOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const iconWrapRef = useRef<HTMLDivElement>(null);

  // Close the icon popup on outside-click / Escape.
  useEffect(() => {
    if (!iconOpen) return;
    const onDown = (e: MouseEvent) => {
      if (iconWrapRef.current && !iconWrapRef.current.contains(e.target as Node)) setIconOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIconOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [iconOpen]);

  const save = async () => {
    setSaving(true);
    setError(null);
    const initList = initCommands
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const meta: Partial<ToolMeta> = { name, icon, order: props.tool.meta.order };
    if (cwd.trim()) meta.cwd = cwd.trim();
    if (tmux.trim()) meta.tmux = tmux.trim();
    if (initList.length > 0) meta.initCommands = initList;
    if (mdUrl.trim()) meta.mdUrl = mdUrl.trim();
    const mins = Number(autoUpdate);
    if (autoUpdate.trim() !== '' && Number.isFinite(mins)) meta.autoUpdateMinutes = mins;
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
      <div className="editor-header">
        编辑工具{meta.special ? '（特殊）' : ''}
      </div>

      <div className="meta-form">
        <fieldset className="form-section">
          <legend>基本</legend>
          <label className="field">
            <span className="field-label">名称</span>
            <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </label>
          <div className="field">
            <span className="field-label">图标</span>
            <div className="icon-control" ref={iconWrapRef}>
              <input
                className="icon-input"
                value={icon}
                onChange={(e) => setIcon(e.target.value)}
              />
              <button
                type="button"
                className="icon-popup-toggle"
                title="选择图标"
                onClick={() => setIconOpen((v) => !v)}
              >
                ▾
              </button>
              {iconOpen && (
                <div className="icon-popup" role="listbox" aria-label="常用图标">
                  {COMMON_ICONS.map((ic) => (
                    <button
                      key={ic}
                      type="button"
                      className={'icon-cell' + (ic === icon ? ' selected' : '')}
                      title={ic}
                      onClick={() => {
                        setIcon(ic);
                        setIconOpen(false);
                      }}
                    >
                      {ic}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </fieldset>

        <fieldset className="form-section">
          <legend>终端</legend>
          <label className="field">
            <span className="field-label">起始目录 (cwd)</span>
            <input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="~" />
          </label>
          <label className="field">
            <span className="field-label">
              tmux 会话名 <em>留空不开；已存在则 attach，否则新建</em>
            </span>
            <input value={tmux} onChange={(e) => setTmux(e.target.value)} placeholder="dev" />
          </label>
          <label className="field">
            <span className="field-label">
              启动命令 <em>每行一条，进入终端后依次执行</em>
            </span>
            <textarea
              className="init-commands"
              rows={3}
              value={initCommands}
              onChange={(e) => setInitCommands(e.target.value)}
              placeholder={'cd ~/project\nsource venv/bin/activate'}
            />
          </label>
        </fieldset>

        <fieldset className="form-section">
          <legend>远程内容（可选）</legend>
          <label className="field">
            <span className="field-label">
              Markdown URL <em>设置后只读、自动更新；留空用本地</em>
            </span>
            <input
              value={mdUrl}
              onChange={(e) => setMdUrl(e.target.value)}
              placeholder="https://example.com/help.md"
            />
          </label>
          {mdUrl.trim() && (
            <label className="field">
              <span className="field-label">自动更新间隔（分钟，0 关闭）</span>
              <input
                className="num-input"
                type="number"
                min={0}
                value={autoUpdate}
                onChange={(e) => setAutoUpdate(e.target.value)}
                placeholder="5"
              />
            </label>
          )}
        </fieldset>
      </div>

      {isReadOnly && (
        <div className="editor-readonly-banner">
          📡 帮助内容来自远程 URL（只读）。清空 URL 则转回本地编辑。
          <button className="link-btn" onClick={() => window.api.refreshMd()}>立即重新读取</button>
        </div>
      )}

      <div className="editor-md">
        <div className="editor-md-head">
          📝 帮助文档 (Markdown){isReadOnly ? ' · 远程只读' : ''}
        </div>
        <div className="cm-wrap">
          <CodeMirror
            value={markdownText}
            height="100%"
            theme="light"
            editable={!isReadOnly}
            readOnly={isReadOnly}
            extensions={[markdown({ base: markdownLanguage })]}
            onChange={(v) => setMarkdownText(v)}
          />
        </div>
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
