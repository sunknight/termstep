import { useEffect, useMemo, useRef, useState } from 'react';
import type { Tool, ToolMeta } from '../../shared/types';
import { api } from '../lib/api';
import { draftFromTool, isDraftDirty, type EditorDraft } from '../../shared/editorDraft';
import { insertButtonAttr, insertButtonsFence, type InsertAttrResult } from '../../shared/buttonAttrInsert';
import { normalizeWebUrl } from '../../shared/toolConfig';
import { confirmDialog } from '../lib/dialog';
import { SyntaxHelp } from './SyntaxHelp';

// ### 属性快捷插入 chips（点击插到本地内容光标处，规则见 shared/buttonAttrInsert）。
const ATTR_CHIPS = ['label=', 'edit', 'tag=', 'tag-color='];

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

// Disable macOS WKWebView's smart punctuation / text replacement on free-text
// inputs (it turns "--" into "—", straight quotes into curly ones, etc., which
// corrupts commands and JSON). All user-typed text fields below spread these.
const noTransform = {
  autoCorrect: 'off' as const,
  autoCapitalize: 'off' as const,
  spellCheck: false,
};

/** 表单字段标签旁的 ? 悬停提示：CSS tooltip（data-hint + ::after），hover 即显。 */
function Hint(props: { text: string }) {
  return (
    <span className="fi-hint" data-hint={props.text} aria-label={props.text}>
      ?
    </span>
  );
}

export function EditorPane(props: {
  tool: Tool;
  onDone: () => void;
  /** 已有分组名（去重），供分组输入下拉选择。 */
  existingGroups: string[];
  /** 该编辑器当前是否可见（= 激活工具）。多编辑器常驻时，隐藏实例不响应 Cmd+Enter。 */
  active: boolean;
}) {
  const { meta } = props.tool;
  // 多编辑器实例常驻时，radio name / datalist id 必须每实例唯一——它们是
  // document 级键，重名会让不同工具的编辑器互相干扰单选与下拉建议。
  const groupsListId = `ts-groups-${meta.id}`;
  const layoutRadioName = `tool-layout-${meta.id}`;
  const kindRadioName = `tool-kind-${meta.id}`;
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
  const [layout, setLayout] = useState<'LR' | 'TB'>(meta.layout === 'TB' ? 'TB' : 'LR');
  const [terminalHidden, setTerminalHidden] = useState<boolean>(!!meta.terminalHidden);
  // 工具形态：'web' = 网页型（隐藏终端/内容区，显示网页配置）。默认态下 webUrl
  // 仍留在表单 state——临时切网页再切回不丢输入；保存时默认态不发送（磁盘保留旧值）。
  const [kind, setKind] = useState<'default' | 'web'>(meta.kind === 'web' ? 'web' : 'default');
  const [webUrl, setWebUrl] = useState(meta.webUrl ?? '');
  const [iconOpen, setIconOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewMarkdown, setPreviewMarkdown] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [syntaxOpen, setSyntaxOpen] = useState(false);
  const iconWrapRef = useRef<HTMLDivElement>(null);
  const mdRef = useRef<HTMLTextAreaElement>(null);
  const syntaxBtnRef = useRef<HTMLButtonElement>(null);

  // 快捷插入（shared 纯函数：属性片段 / 空 buttons 围栏）：按光标位置计算，
  // 插入后光标落在建议位置（= 后 / 围栏内首行），下一帧恢复焦点再设置光标。
  const applyInsert = (fn: (text: string, caret: number) => InsertAttrResult) => {
    const ta = mdRef.current;
    const caret = ta ? ta.selectionStart ?? markdownText.length : markdownText.length;
    const r = fn(markdownText, caret);
    setMarkdownText(r.text);
    requestAnimationFrame(() => {
      ta?.focus();
      ta?.setSelectionRange(r.caret, r.caret);
    });
  };
  const insertAttr = (attr: string) => applyInsert((t, c) => insertButtonAttr(t, c, attr));

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

  // 挂载时的草稿快照，仅捕获一次：之后 tools:changed 刷新 props.tool 也不更新
  // （表单 state 本就不随 prop 重置）。保存语义是 last-writer-wins，configs/ 下
  // 有 vcs git 快照兜底，编辑期间的外部磁盘变更不做合并提醒。
  const initialDraft = useMemo(() => draftFromTool(props.tool), []);

  const currentDraft = (): EditorDraft => ({
    name,
    icon,
    cwd,
    rootDir,
    tmux,
    initCommands,
    mdUrl,
    autoUpdate,
    group,
    layout,
    terminalHidden,
    kind,
    webUrl,
    markdown: markdownText,
    useRemote: effective === 'remote',
  });

  // × 与「取消」共用：有未保存修改先确认再丢弃；保存走 save()，不经过这里。
  const close = async () => {
    if (isDraftDirty(currentDraft(), initialDraft)) {
      if (!(await confirmDialog('有未保存的修改，确定丢弃？', '放弃修改'))) return;
    }
    props.onDone();
  };

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
      // LR（默认布局）发空串让 mergeToolJson 裁掉 layout 字段（保持 tool.json 干净）；
      // TB 保留显式 'TB'。terminalHidden 显式发 false（不能 || undefined——否则
      // mergeToolJson 会跳过这个 key，旧的 true 值无法清除）；false 由 mergeToolJson 裁剪。
      layout: (layout === 'LR' ? '' : 'TB') as 'LR' | 'TB',
      terminalHidden,
      // kind 同 layout 的空串裁剪模式：默认形态发 '' 让 mergeToolJson 裁掉。
      kind: (kind === 'web' ? 'web' : '') as 'web',
      initCommands: initList,
    };
    // webUrl 仅网页态发送（规范化补 http://）；默认态不发 → 磁盘旧值保留，
    // 误切回默认再切网页可无损恢复。
    if (kind === 'web') meta.webUrl = normalizeWebUrl(webUrl);
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
    if (!props.active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void saveRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props.active]);

  // WKWebView：常驻编辑层从 display:none 切回可见（首次打开/切回工具）时，首次
  // 绘制可能沿用过期的布局度量——表现为内容间距错误（如表单与 tab 行间出现空白，
  // 窗口高于内容自然高度时才触发），任意点击触发重绘后才恢复。这里在变为可见时
  // 主动强制一次同步布局（读几何）+ 层重绘（translateZ 写读），代替用户的那次点击。
  useEffect(() => {
    if (!props.active) return;
    const panel = mdRef.current?.closest('.editor-panel') as HTMLElement | null;
    if (!panel) return;
    void panel.getBoundingClientRect();
    panel.style.transform = 'translateZ(0)';
    void panel.getBoundingClientRect();
    panel.style.transform = '';
  }, [props.active]);

  return (
    <>
      {/* 编辑器以工具内覆盖层展开（盖住主区顶栏与面板，侧栏保留），这是它的固定标题栏。 */}
      <div className="editor-header">
        <span className="editor-title" title={props.tool.meta.name}>
          编辑工具：{props.tool.meta.name}
        </span>
        <button
          className="modal-close"
          onClick={() => void close()}
          aria-label="关闭"
          title="关闭"
        >
          ×
        </button>
      </div>
      <div className="editor">
      {/* Always-visible main form（紧凑布局：标签同行 + 同类字段拼行，备注收进 ? 悬停） */}
      <div className="meta-form">
        <fieldset className="form-section">
          <legend>基本</legend>
          <div className="form-grid">
            <label className="field-in span4">
              <span className="fi-label">名称</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                {...noTransform}
                autoFocus
              />
            </label>
            <div className="field-in span4">
              <span className="fi-label">图标</span>
              <div className="icon-control" ref={iconWrapRef}>
                <input
                  className="icon-input"
                  value={icon}
                  onChange={(e) => setIcon(e.target.value)}
                  {...noTransform}
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
            <label className="field-in span4">
              <span className="fi-label">
                分组
                <Hint text="留空 = 未分组；输入新名字即新建" />
              </span>
              <input
                list={groupsListId}
                value={group}
                onChange={(e) => setGroup(e.target.value)}
                placeholder="未分组"
                {...noTransform}
              />
              <datalist id={groupsListId}>
                {props.existingGroups.map((g) => (
                  <option key={g} value={g} />
                ))}
              </datalist>
            </label>
            <div className="field-in span4">
              <span className="fi-label">
                类型
                <Hint text="默认 = 终端+文档；网页 = 主区内嵌网页（无终端/文档）" />
              </span>
              <div className="mode-radio-group" role="radiogroup" aria-label="工具类型">
                <label className="mode-radio">
                  <input
                    type="radio"
                    name={kindRadioName}
                    value="default"
                    checked={kind === 'default'}
                    onChange={() => setKind('default')}
                  />
                  <span>默认</span>
                </label>
                <label className="mode-radio">
                  <input
                    type="radio"
                    name={kindRadioName}
                    value="web"
                    checked={kind === 'web'}
                    onChange={() => setKind('web')}
                  />
                  <span>网页</span>
                </label>
              </div>
            </div>
            {kind === 'default' && (
              <div className="field-in span4">
                <span className="fi-label">
                  布局
                  <Hint text="LR = 终端左/文档右（默认）；TB = 文档上/终端下" />
                </span>
                <div className="mode-radio-group" role="radiogroup" aria-label="布局方向">
                  <label className="mode-radio">
                    <input
                      type="radio"
                      name={layoutRadioName}
                      value="LR"
                      checked={layout === 'LR'}
                      onChange={() => setLayout('LR')}
                    />
                    <span>LR</span>
                  </label>
                  <label className="mode-radio">
                    <input
                      type="radio"
                      name={layoutRadioName}
                      value="TB"
                      checked={layout === 'TB'}
                      onChange={() => setLayout('TB')}
                    />
                    <span>TB</span>
                  </label>
                </div>
              </div>
            )}
            {kind === 'default' && (
              <label className="field-in span4">
                <span className="fi-label">
                  隐藏终端
                  <Hint text="默认隐藏（打开工具只看文档）；运行时可随时显示" />
                </span>
                <input
                  type="checkbox"
                  checked={terminalHidden}
                  onChange={(e) => setTerminalHidden(e.target.checked)}
                />
              </label>
            )}
          </div>
        </fieldset>

        {kind === 'default' && (
          <fieldset className="form-section">
            <legend>终端</legend>
          <div className="form-grid">
            <label className="field-in span6">
              <span className="fi-label">起始目录</span>
              <input
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
                placeholder="~"
                {...noTransform}
              />
            </label>
            <label className="field-in span6">
              <span className="fi-label">
                根目录
                <Hint text="即按钮里的 @/；留空同起始目录" />
              </span>
              <input
                value={rootDir}
                onChange={(e) => setRootDir(e.target.value)}
                placeholder="留空同起始目录"
                {...noTransform}
              />
            </label>
            <label className="field-in span6">
              <span className="fi-label">
                tmux
                <Hint text="会话名；留空不开。已存在则 attach，否则新建" />
              </span>
              <input
                value={tmux}
                onChange={(e) => setTmux(e.target.value)}
                placeholder="dev"
                {...noTransform}
              />
            </label>
            <label className="field-in span6 area">
              <span className="fi-label">
                启动命令
                <Hint text="每行一条，进入终端后依次执行" />
              </span>
              <textarea
                className="init-commands"
                rows={2}
                value={initCommands}
                onChange={(e) => setInitCommands(e.target.value)}
                placeholder={'cd ~/project\nsource venv/bin/activate'}
                {...noTransform}
              />
            </label>
          </div>
        </fieldset>
        )}
      </div>

      {/* Tabbed sub-region: switches only the markdown / URL area. 网页型工具
          整个子区替换为网页配置（URL）——本地/远程 markdown 配置对它无意义。 */}
      {kind === 'web' ? (
        <div className="md-subregion web-subregion">
          <fieldset className="form-section">
            <legend>网页</legend>
            <div className="form-grid">
              <label className="field-in span8">
                <span className="fi-label">
                  URL
                  <Hint text="http(s) 地址；不带协议保存时自动补 http://" />
                </span>
                <input
                  value={webUrl}
                  onChange={(e) => setWebUrl(e.target.value)}
                  placeholder="http://localhost:38311/"
                  {...noTransform}
                />
              </label>
            </div>
            <div className="md-hint">
              打开工具时在主区内嵌该网页，切换工具不重载。部分站点（如 Google）设置
              X-Frame-Options 拒绝内嵌、会显示空白——届时可用顶栏「↗ 浏览器」按钮在
              外部浏览器打开。
            </div>
          </fieldset>
        </div>
      ) : (
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
          <div className="editor-tabs-extra">
            {tab === 'local' && (
              <div
                className="attr-chips"
                role="toolbar"
                aria-label="插入 ### 按钮属性"
                title="插入到光标所在行；该行无 ### 时自动在行尾补"
              >
                <button
                  type="button"
                  className="attr-chip fence"
                  onClick={() => applyInsert(insertButtonsFence)}
                  title="在光标处插入空的 ```buttons 围栏块（光标所在行为空行时占用该行，否则新起一行）"
                >
                  {'```'}buttons
                </button>
                {ATTR_CHIPS.map((a) => (
                  <button key={a} type="button" className="attr-chip" onClick={() => insertAttr(a)}>
                    {a}
                  </button>
                ))}
              </div>
            )}
            <button
              ref={syntaxBtnRef}
              type="button"
              className="syntax-help-toggle"
              onClick={() => setSyntaxOpen((v) => !v)}
              title="buttons 语法速查"
            >
              ? 语法
            </button>
            {syntaxOpen && <SyntaxHelp anchorRef={syntaxBtnRef} onClose={() => setSyntaxOpen(false)} />}
          </div>
        </div>

        {tab === 'local' ? (
          <textarea
            className="md-editor"
            ref={mdRef}
            value={markdownText}
            onChange={(e) => setMarkdownText(e.target.value)}
            placeholder={'# 标题\n\n```buttons\nls\n```\n'}
            {...noTransform}
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
              <div className="form-grid">
                <label className="field-in span8">
                  <span className="fi-label">
                    URL
                    <Hint text="Markdown URL 或本地文件路径；与本地内容独立，清空即恢复本地" />
                  </span>
                  <div className="mdurl-control">
                    <input
                      value={mdUrl}
                      onChange={(e) => setMdUrl(e.target.value)}
                      placeholder="https://example.com/help.md 或 /Users/me/help.md"
                      {...noTransform}
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
                  <label className="field-in span4">
                    <span className="fi-label">
                      自动更新
                      <Hint text="分钟；0 = 不自动更新" />
                    </span>
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
              </div>
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
      )}

      </div>
      <div className="editor-footer">
        <div className="editor-actions">
          <button className="primary" onClick={save} disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </button>
          <button onClick={() => void close()}>取消</button>
        </div>
        {error && <span className="editor-error">{error}</span>}
      </div>
    </>
  );
}
