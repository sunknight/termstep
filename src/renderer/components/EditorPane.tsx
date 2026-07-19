import { useEffect, useRef, useState } from 'react';
import type { Tool, ToolMeta } from '../../shared/types';
import { api } from '../lib/api';

// A small, curated set of icons that read well at sidebar size. Shown in a
// popup beside the icon input so it doesn't eat vertical space in the form.
const COMMON_ICONS = [
  '★', '☆', '▶', '◆', '●', '◐',
  '🛠️', '⚙️', '🔧', '🧰', '🗄️', '🗃️',
  '📁', '📂', '📦', '💾', '🖥️', '💻',
  '🚀', '⚡', '🔥', '🌐', '🌍', '🌙',
  '🐳', '📟', '📊', '📈', '📝', '🔍',
  '🔑', '🔒', '🧪', '🐛', '🎨', '⏱️',
];

// Plain textarea markdown editor (no CodeMirror): a textarea always scrolls
// vertically for long content and has no folding UI.
//
// Layout: the main form (基本 / 终端) is always visible. Below it, ONE sub-region
// has a 本地/远程 tab that swaps only that sub-region's content:
//   - 本地内容 : the editable LOCAL markdown (help.md)
//   - 远程订阅 : the mdUrl / auto-refresh config + a read-only preview of the
//                fetched remote copy, with a re-read button.
// Local and remote stay independent; saving persists every field regardless of
// which sub-tab is active.

export function EditorPane(props: {
  tool: Tool;
  onDone: () => void;
  /** 已有分组名（去重），供分组输入下拉选择。 */
  existingGroups: string[];
}) {
  const { meta } = props.tool;
  // The open tab is also the source selection: the checked (✓) tab is the
  // EFFECTIVE source — the one the tool's help will use.
  const [tab, setTab] = useState<'local' | 'remote'>(meta.useRemote ? 'remote' : 'local');
  const [markdownText, setMarkdownText] = useState(props.tool.helpMarkdown);
  const [name, setName] = useState(meta.name);
  const [icon, setIcon] = useState(meta.icon);
  const [cwd, setCwd] = useState(meta.cwd ?? '');
  const [rootDir, setRootDir] = useState(meta.rootDir ?? '');
  const [tmux, setTmux] = useState(meta.tmux ?? '');
  const [initCommands, setInitCommands] = useState((meta.initCommands ?? []).join('\n'));
  const [mdUrl, setMdUrl] = useState(meta.mdUrl ?? '');
  const [autoUpdate, setAutoUpdate] = useState(meta.autoUpdateMinutes?.toString() ?? '');
  const [group, setGroup] = useState(meta.group ?? '');
  const [iconOpen, setIconOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewMarkdown, setPreviewMarkdown] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const iconWrapRef = useRef<HTMLDivElement>(null);

  // Discard the preview whenever the URL field changes, so a stale fetch from a
  // previous URL is never shown as if it were current.
  useEffect(() => {
    setPreviewMarkdown(null);
  }, [mdUrl]);

  // Preview-fetch the DRAFT url (not yet saved) so the user can see what a new
  // URL returns before committing. After save, the normal scan re-fetches the
  // persisted URL and updates remoteMarkdown.
  const readRemote = async () => {
    const url = mdUrl.trim();
    if (!url) return;
    setPreviewLoading(true);
    try {
      const res = await api.fetchMdPreview(url);
      if (res?.error) {
        setError(`远程读取失败: ${res.error}`);
      } else {
        setError(null);
        setPreviewMarkdown(res?.markdown ?? '');
      }
    } catch (e) {
      setError(`远程读取失败: ${String((e as Error)?.message ?? e)}`);
    } finally {
      setPreviewLoading(false);
    }
  };

  // Remote can only be the effective source when a URL is set; otherwise local
  // stays effective (✓ stays on 本地) even while the 远程 tab is open for setup.
  const effective: 'local' | 'remote' = tab === 'remote' && mdUrl.trim() ? 'remote' : 'local';

  // Close the icon popup on outside-click or Escape.
  useEffect(() => {
    if (!iconOpen) return;
    const onDown = (e: MouseEvent) => {
      if (iconWrapRef.current && !iconWrapRef.current.contains(e.target as Node)) setIconOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation();
        setIconOpen(false);
      }
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [iconOpen]);

  const save = async () => {
    setSaving(true);
    setError(null);
    const initList = initCommands
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    // Send CURRENT values for every managed optional field (empty when cleared)
    // so TOOL_SAVE can prune them — clearing mdUrl must actually remove it.
    const meta: Partial<ToolMeta> = {
      name,
      icon,
      cwd: cwd.trim(),
      rootDir: rootDir.trim(),
      tmux: tmux.trim(),
      mdUrl: mdUrl.trim(),
      group: group.trim(),
      initCommands: initList,
    };
    const mins = Number(autoUpdate);
    if (mdUrl.trim() && autoUpdate.trim() !== '' && Number.isFinite(mins)) {
      meta.autoUpdateMinutes = mins;
    }
    // Persist which source is effective (the ✓ tab). Sent as a bool so a switch
    // back to local clears a previously-true useRemote.
    meta.useRemote = effective === 'remote';
    try {
      // Always saves the LOCAL markdown; the remote copy is fetched, never written.
      await api.tool.save(props.tool.meta.id, markdownText, meta);
      props.onDone();
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setSaving(false);
    }
  };

  // Cmd/Ctrl + Enter 快速保存（用 ref 避免闭包捕获旧 state）
  const saveRef = useRef(save);
  saveRef.current = save;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void saveRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="editor">
      {/* Always-visible main form */}
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
              <label className="field">
                <span className="field-label">
                  分组 <em>留空 = 未分组；输入新名字即新建</em>
                </span>
                <input
                  list="ts-groups"
                  value={group}
                  onChange={(e) => setGroup(e.target.value)}
                  placeholder="未分组"
                />
                <datalist id="ts-groups">
                  {props.existingGroups.map((g) => (
                    <option key={g} value={g} />
                  ))}
                </datalist>
              </label>
            </fieldset>

        <fieldset className="form-section">
          <legend>终端</legend>
          <label className="field">
            <span className="field-label">起始目录 (cwd)</span>
            <input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="~" />
          </label>
          <label className="field">
            <span className="field-label">
              工具根目录 (@/) <em>留空同 cwd；按钮里 @/ 锚定此目录</em>
            </span>
            <input value={rootDir} onChange={(e) => setRootDir(e.target.value)} placeholder="留空同 cwd" />
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
      </div>

      {/* Tabbed sub-region: switches only the markdown / URL area */}
      <div className="md-subregion">
        <div className="editor-tabs" role="tablist">
          <button
            role="tab"
            aria-selected={tab === 'local'}
            className={tab === 'local' ? 'active' : ''}
            onClick={() => setTab('local')}
            title="使用本地内容（help.md）"
          >
            {effective === 'local' && <span className="tab-check" aria-hidden>✓</span>}
            本地内容
          </button>
          <button
            role="tab"
            aria-selected={tab === 'remote'}
            className={tab === 'remote' ? 'active' : ''}
            onClick={() => setTab('remote')}
            title="使用远程内容（需填写 URL）"
          >
            {effective === 'remote' && <span className="tab-check" aria-hidden>✓</span>}
            远程订阅
          </button>
        </div>

        {tab === 'local' ? (
          <textarea
            className="md-editor"
            value={markdownText}
            onChange={(e) => setMarkdownText(e.target.value)}
            placeholder={'# 标题\n\n```buttons\nls\n```\n'}
          />
        ) : (
          <div className="md-remote-pane">
            {!mdUrl.trim() && (
              <div className="md-hint">
                填写 URL 或选择本地文件并保存后，「远程订阅」会被勾选（✓）并生效；届时本地内容将不再作为帮助显示。清空则自动回到本地。
              </div>
            )}
            <fieldset className="form-section">
              <legend>远程订阅</legend>
              <label className="field">
                <span className="field-label">
                  Markdown URL / 本地文件 <em>与本地独立；清空即恢复本地</em>
                </span>
                <div className="mdurl-control">
                  <input
                    value={mdUrl}
                    onChange={(e) => setMdUrl(e.target.value)}
                    placeholder="https://example.com/help.md 或 /Users/me/help.md"
                  />
                  <button
                    type="button"
                    className="mdurl-pick"
                    title="在 Finder 中选择本地 Markdown 文件（仅记录路径）"
                    onClick={async () => {
                      const res = await api.pickMdFile();
                      if (!res.canceled) setMdUrl(res.path);
                    }}
                  >
                    📂
                  </button>
                </div>
              </label>
              {mdUrl.trim() && (
                <label className="field">
                  <span className="field-label">自动更新间隔（分钟，0 = 不自动更新）</span>
                  <input
                    className="num-input"
                    type="number"
                    min={0}
                    value={autoUpdate}
                    onChange={(e) => setAutoUpdate(e.target.value)}
                    placeholder="0"
                  />
                </label>
              )}
            </fieldset>
            <div className="md-head">
              <span>📡 远程内容（只读预览）</span>
              <button
                type="button"
                onClick={readRemote}
                disabled={!mdUrl.trim() || previewLoading}
                title="按当前填写的 URL 拉取预览（保存前即可用）"
              >
                {previewLoading ? '读取中…' : '⟳ 重新读取'}
              </button>
            </div>
            <textarea
              className="md-editor"
              readOnly
              value={previewMarkdown ?? props.tool.remoteMarkdown ?? ''}
              placeholder="(填写 URL 并点「重新读取」预览；保存后即生效)"
            />
          </div>
        )}
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
