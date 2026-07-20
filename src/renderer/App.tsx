import { useEffect, useRef, useState } from 'react';
import { useTools } from './hooks/useTools';
import { Sidebar } from './components/Sidebar';
import { TerminalPane } from './components/TerminalPane';
import { HelpPane } from './components/HelpPane';
import { EditorModal } from './components/EditorModal';
import { QuickAddModal } from './components/QuickAddModal';
import { HelpModal } from './components/HelpModal';
import { ConfigRecords } from './components/ConfigRecords';
import { QuickCommands } from './components/QuickCommands';
import { Notifications } from './components/Notifications';
import { HoverTip } from './components/HoverTip';
import { PanelToggle } from './components/PanelToggle';
import { Peek } from './components/Peek';
import { usePeek } from './hooks/usePeek';
import { PreviewOverlay } from './components/PreviewOverlay';
import type { PreviewState, PreviewRequest } from './components/PreviewOverlay';
import { termRegistry } from './lib/termRegistry';
import { api } from './lib/api';
import { confirmDialog, alertDialog } from './lib/dialog';

// Right panel width bounds. Match the sidebar's range so the two sides feel
// symmetric; the default keeps the old hardcoded 340px.
const HELP_DEFAULT_WIDTH = 340;

// 把导入预检返回的风险摘要格式化成确认对话框里的人类可读明细。
// 只列含风险项的工具，每项标注风险类型；启动命令逐条列出（最高风险）。
function formatImportRisks(risks: { name: string; shell?: string; initCommands: string[]; mdUrl?: string; envKeys: string[] }[]): string {
  const lines: string[] = [];
  for (const r of risks) {
    if (r.shell === undefined && r.initCommands.length === 0 && r.mdUrl === undefined && r.envKeys.length === 0) continue;
    lines.push(`• ${r.name}:`);
    if (r.shell) lines.push(`    自定义 shell: ${r.shell}`);
    if (r.initCommands.length > 0) {
      lines.push('    启动时自动执行:');
      for (const c of r.initCommands) lines.push(`      $ ${c}`);
    }
    if (r.mdUrl) lines.push(`    远程订阅: ${r.mdUrl}`);
    if (r.envKeys.length > 0) lines.push(`    环境变量: ${r.envKeys.join(', ')}`);
  }
  return lines.join('\n');
}

export default function App() {
  const { tools, errors, groups } = useTools();
  const existingGroups = Array.from(
    new Set(tools.map((t) => t.meta.group).filter((g): g is string => !!g)),
  );
  const [activeId, setActiveId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  // 配置记录 modal：null=关闭；string=per-tool（工具 id）；'__global__'=全部配置记录。
  const [recordsToolId, setRecordsToolId] = useState<string | null>(null);
  // 预览弹层：null=关闭；否则展示网页/文档/加载中/错误态之一。
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const active = tools.find((t) => t.meta.id === activeId) ?? null;
  const [liveCwd, setLiveCwd] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(
    () => localStorage.getItem('termstep:sidebar-collapsed') === '1',
  );
  // 文档折叠为浮动 Peek（保留旧 localStorage key 以兼容用户既有偏好）。
  const [docCollapsed, setDocCollapsed] = useState<boolean>(
    () => localStorage.getItem('termstep:help-collapsed') === '1',
  );
  // 终端显隐（运行时状态）。初值取自当前工具的 meta.terminalHidden；
  // 切换工具时重置（见下方 effect）。顶栏 toggle 改这个 state，不写回配置。
  const [termHidden, setTermHidden] = useState<boolean>(false);
  // 文档 hover-peek：docCollapsed 时 hover 文档按钮 → 浮动展开（带 grace period）。
  const docPeek = usePeek();
  const docToggleRef = useRef<HTMLButtonElement>(null);
  // sidebar 宽度（跟 Sidebar 组件读同一个 localStorage key，用于算 Peek 浮动文档宽度）。
  const sidebarWidth = Number(localStorage.getItem('termstep:sidebar-width')) || 180;
  // LR 布局下的终端宽度（px），全局共享。
  const [termSizeLr, setTermSizeLr] = useState<number>(() => {
    const v = Number(localStorage.getItem('termstep:term-size-lr'));
    return v >= 280 && v <= 1200 ? v : 560;
  });
  // TB 布局下的终端高度（px），全局共享。
  const [termSizeTb, setTermSizeTb] = useState<number>(() => {
    const v = Number(localStorage.getItem('termstep:term-size-tb'));
    return v >= 120 && v <= 1200 ? v : 320;
  });

  // 打开预览弹层。web 直接展示；doc 先 loading 再 fetch_md_preview（远程/本地统一复用）。
  // 本地路径已由 HelpPane 基于工具 cwd 解析为绝对路径后传入 url。
  const openPreview = async (req: PreviewRequest) => {
    if (req.type === 'web') {
      setPreview({ kind: 'web', url: req.url, title: req.title });
      return;
    }
    setPreview({ kind: 'loading', title: req.title });
    try {
      const r = await api.fetchMdPreview(req.url);
      if (r.error) {
        setPreview({ kind: 'error', title: req.title, message: r.error });
      } else {
        setPreview(
          req.isTxt
            ? { kind: 'txt', title: req.title, content: r.markdown }
            : { kind: 'md', title: req.title, content: r.markdown },
        );
      }
    } catch (e) {
      setPreview({ kind: 'error', title: req.title, message: String(e) });
    }
  };

  // 终端/文档之间的拖动条。方向由当前工具的 layout 决定：
  // LR = 左右拖（改 termSizeLr），TB = 上下拖（改 termSizeTb）。
  const startTermDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const layout = active?.meta.layout ?? 'LR';
    const startX = e.clientX;
    const startY = e.clientY;
    const startLr = termSizeLr;
    const startTb = termSizeTb;
    // 终端在左（LR）/ 下（TB）：LR 光标向右移 = 终端变宽；TB 光标向上移 = 终端变高。
    const onMove = (ev: MouseEvent) => {
      if (layout === 'LR') {
        const w = Math.min(1200, Math.max(280, startLr + (ev.clientX - startX)));
        setTermSizeLr(w);
      } else {
        const h = Math.min(1200, Math.max(120, startTb + (startY - ev.clientY)));
        setTermSizeTb(h);
      }
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    document.body.style.cursor = layout === 'LR' ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
  };

  // 切换工具时，termHidden 重置为新工具的 meta.terminalHidden（配置默认值）。
  // 只依赖 activeId，不依赖 active 对象（每帧新对象会重置，丢失用户 toggle）。
  useEffect(() => {
    setTermHidden(!!active?.meta.terminalHidden);
  }, [activeId]);
  useEffect(() => {
    localStorage.setItem('termstep:sidebar-collapsed', sidebarCollapsed ? '1' : '0');
  }, [sidebarCollapsed]);
  // 文档折叠（Peek）：保留旧 key 以兼容既有用户偏好。
  useEffect(() => {
    localStorage.setItem('termstep:help-collapsed', docCollapsed ? '1' : '0');
  }, [docCollapsed]);
  useEffect(() => {
    localStorage.setItem('termstep:term-size-lr', String(termSizeLr));
  }, [termSizeLr]);
  useEffect(() => {
    localStorage.setItem('termstep:term-size-tb', String(termSizeTb));
  }, [termSizeTb]);

  useEffect(() => {
    if (!activeId && tools.length > 0) setActiveId(tools[0].meta.id);
  }, [tools, activeId]);

  // Poll the active shell's live cwd (resolved from its OS pid) so the terminal
  // header follows the user's `cd`. Cheap readlink, ~1.5s cadence.
  useEffect(() => {
    if (!activeId) {
      setLiveCwd(null);
      return;
    }
    let cancelled = false;
    let timer: number | undefined;
    const tick = async () => {
      try {
        const c = await api.pty.cwd(activeId);
        if (!cancelled) setLiveCwd(c);
      } catch {
        // shell not spawned yet / gone — ignore
      }
      if (!cancelled) timer = window.setTimeout(tick, 1500);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [activeId]);

  // Electron's window.prompt() is not implemented (returns null), so we create the
  // tool with a placeholder name and drop straight into the editor, where the user
  // can set the real name, icon, and cwd.
  const createTool = async () => {
    const id = await api.tool.create('新工具');
    setActiveId(id);
    setEditingId(id);
  };
  const deleteTool = async (id: string) => {
    if (!(await confirmDialog('删除该工具？', '删除工具'))) return;
    await api.tool.del(id);
    if (activeId === id) setActiveId(null);
  };
  // Tool ordering is done by drag-and-drop in the sidebar now.
  const reorderTools = async (orderedIds: string[]) => {
    await api.tool.reorder(orderedIds);
  };
  // 跨分组移动：拖拽到别的分组时，改 group 字段并调整 order。
  const moveTool = async (toolId: string, targetGroup: string | null, beforeId: string | null) => {
    await api.tool.move(toolId, targetGroup, beforeId);
  };

  const exportTools = async () => {
    const res = await api.bundle.export();
    if (!res || res.canceled) return;
    if ('error' in res && res.error) await alertDialog(`导出失败: ${res.error}`);
    else await alertDialog(`已导出 ${res.count} 个工具到:\n${res.path}`);
  };
  const exportOne = async (id: string) => {
    const res = await api.bundle.exportOne(id);
    if (!res || res.canceled) return;
    if ('error' in res && res.error) await alertDialog(`导出失败: ${res.error}`);
    else if ('path' in res) await alertDialog(`已导出工具到:\n${res.path}`);
  };
  const importTools = async () => {
    // 两阶段导入：preview 选文件 + 解析 + 风险扫描（不写盘）→ 确认 → confirm 落盘。
    const pre = await api.bundle.importPreview();
    if (!pre || pre.canceled) return;
    if ('error' in pre) {
      await alertDialog(`导入失败: ${pre.error}`);
      return;
    }
    // 有风险字段（自定义 shell / 启动命令 / 远程订阅 / 环境变量）→ 弹确认列出明细。
    if (pre.hasRisk) {
      const detail = formatImportRisks(pre.risks);
      const ok = await confirmDialog(
        `⚠️ 即将导入 ${pre.count} 个工具，其中含以下风险项：\n\n${detail}\n\n工具可包含启动命令，导入后打开工具即执行。仅导入可信来源。确定继续？`,
        '导入风险确认',
      );
      if (!ok) return;
    }
    const res = await api.bundle.importConfirm();
    if ('error' in res) await alertDialog(`导入失败: ${res.error}`);
    else await alertDialog(`已导入 ${res.count} 个工具（新建 ${res.created}，更新 ${res.updated}）。`);
  };

  // Each panel's element is built once and used in exactly one place: docked
  // when expanded, or floated inside the Peek when collapsed. Same component =>
  // one source of truth for the tool list and the docs.
  const sidebarContent = (
    <Sidebar
      tools={tools}
      groups={groups}
      activeId={activeId}
      onSelect={setActiveId}
      onReorder={reorderTools}
      onMove={moveTool}
      onNew={createTool}
      onExport={exportTools}
      onImport={importTools}
      onHelp={() => setHelpOpen(true)}
      onVersions={() => setRecordsToolId('__global__')}
      floating={sidebarCollapsed}
    />
  );
  // 文档区内容（docked 主区和折叠 Peek 共用同一份）：工具栏（删除/导出/记录/
  // 重载/添加/编辑）+ HelpPane。外壳由调用方提供——docked 用 .doc-pane，Peek 用
  // .doc-peek-body。docked 显示工具栏；Peek 顶部有独立 header，内容区不重复。
  const renderDocContent = ({ withToolbar = true }: { withToolbar?: boolean } = {}) =>
    active ? (
      <>
        {withToolbar && (
          <div className="help-toolbar">
            <button title="删除" className="danger" onClick={() => deleteTool(active.meta.id)}>删除</button>
            <button title="导出该工具为 JSON" onClick={() => exportOne(active.meta.id)}>导出</button>
            <button title="该工具的配置记录" onClick={() => setRecordsToolId(active.meta.id)}>记录</button>
            {active.meta.useRemote && (
              <button title="重新拉取远程内容" onClick={() => api.refreshMd()}>重载</button>
            )}
            {!active.meta.useRemote && (
              <button title="快速添加命令（追加到末尾）" onClick={() => setQuickAddOpen(true)}>添加</button>
            )}
            <button title="编辑" className="primary" onClick={() => setEditingId(active.meta.id)}>编辑</button>
          </div>
        )}
        {/* HelpPane 内部自行管理 TOC（固定）+ 文档滚动区（.help-scroll）。 */}
        <HelpPane
          tool={active}
          activeToolId={active.meta.id}
          isRemote={!!active.meta.useRemote}
          markdown={
            active.meta.useRemote ? active.remoteMarkdown ?? '' : active.helpMarkdown
          }
          onPreview={openPreview}
          // 宽屏 TOC 仅在 docked 且终端隐藏（文档撑满主区）时启用；
          // Peek 浮动时永远是窄屏，不开 sidebar TOC。
          sidebarToc={termHidden && !docCollapsed}
          termHidden={termHidden}
        />
      </>
    ) : (
      <div className="placeholder">无选中工具</div>
    );

  // 统一布局：主区 = 顶栏 + 双面板主体（doc-pane | term-splitter | term-pane）。
  // layout(LR/TB) 决定 flex-direction；termHidden 运行时控制终端显隐；
  // docCollapsed 把文档折为浮动 Peek（终端撑满）。
  const layout = active?.meta.layout ?? 'LR';

  return (
    <div className="app">
      {!sidebarCollapsed && sidebarContent}
      <section className="main-area">
        {/* 顶栏：跨布局一致，始终在主区顶部 */}
        <div className="term-header">
          <PanelToggle
            side="left"
            collapsed={sidebarCollapsed}
            icon="☰"
            title="工具列表"
            onToggle={() => setSidebarCollapsed((v) => !v)}
            peekContent={sidebarContent}
            closePeekOnClick
          />
          {sidebarCollapsed && active && (
            <span className="term-active-tool" title={active.meta.name}>
              {active.meta.icon && <span className="term-active-tool-icon">{active.meta.icon}</span>}
              <span className="term-active-tool-name">{active.meta.name}</span>
            </span>
          )}
          <span className="term-cwd">
            <span className="term-cwd-icon">📂</span>
            <HoverTip className="term-cwd-path" text={liveCwd ?? active?.meta.cwd ?? '~'}>
              {liveCwd ?? active?.meta.cwd ?? '~'}
            </HoverTip>
          </span>
          <div className="term-actions">
            <QuickCommands activeTool={active} termHidden={termHidden} />
            {active && (
              <>
                <button
                  className="term-restart"
                  title="重启终端"
                  onClick={() => {
                    const id = active.meta.id;
                    termRegistry.get(id)?.reset();
                    api.pty.restart(id, {
                      cwd: active.meta.cwd,
                      shell: active.meta.shell,
                      env: active.meta.env,
                      tmux: active.meta.tmux,
                      initCommands: active.meta.initCommands,
                    });
                  }}
                >
                  ↻ 重启终端
                </button>
                <button
                  className="term-toggle"
                  title={termHidden ? '显示终端' : '隐藏终端'}
                  onClick={() => setTermHidden((v) => !v)}
                >
                  {termHidden ? '▸ 终端' : '▾ 终端'}
                </button>
                <button
                  className="term-restart"
                  title={docCollapsed ? '展开文档（hover 预览）' : '折叠文档为浮动小窗'}
                  ref={docToggleRef}
                  onClick={() => {
                    docPeek.close();
                    setDocCollapsed((v) => !v);
                  }}
                  {...(docCollapsed ? docPeek.triggerProps : {})}
                >
                  {docCollapsed ? '▤ 文档' : '▢ 文档'}
                </button>
              </>
            )}
          </div>
        </div>
        <div className={`main-body layout-${layout.toLowerCase()}`}>
          {/* 文档区（docked）。docCollapsed 时不渲染——内容移到浮动 doc-peek，
              避免与 HelpPane 实例重复（HelpPane 有内部 ref/state/监听）。 */}
          {!docCollapsed && (
            <div
              className="doc-pane"
              style={
                termHidden
                  ? { flex: 1, minWidth: 0 }
                  : layout === 'LR'
                    ? { flex: `0 0 calc(100% - ${termSizeLr}px - 6px)`, minWidth: 0 }
                    : { flex: `0 0 calc(100% - ${termSizeTb}px - 6px)`, minHeight: 0 }
              }
            >
              {renderDocContent()}
            </div>
          )}
          {/* 拖动条：终端隐藏或文档折叠时不渲染 */}
          {!termHidden && !docCollapsed && (
            <div
              className={`term-splitter ${layout === 'LR' ? 'lr' : 'tb'}`}
              onMouseDown={startTermDrag}
            />
          )}
          {/* 终端区。隐藏时 CSS 移出 flex 流但保留非零尺寸（pty + xterm 实例不销毁）。
              docCollapsed 时终端撑满；否则按 termSize 固定宽/高。 */}
          <div
            className={`term-pane ${termHidden ? 'hidden' : ''}`}
            style={
              termHidden
                ? undefined
                : docCollapsed
                  ? { flex: 1, minWidth: 0 }
                  : layout === 'LR'
                    ? { flex: `0 0 ${termSizeLr}px`, minWidth: 0 }
                    : { flex: `0 0 ${termSizeTb}px`, minHeight: 0 }
            }
          >
            {activeId ? (
              <TerminalPane tools={tools} activeId={activeId} />
            ) : (
              <div className="placeholder">选择一个工具</div>
            )}
          </div>
        </div>
        {/* 文档折叠后：主区不渲染文档，终端撑满；hover 顶栏文档按钮 → Peek 浮动展开。
            Peek 宽度：LR 跟 docked 右栏联动（calc 100vw - sidebar - 终端宽 - splitter），
            TB（文档模式）用默认宽度。 */}
        {docCollapsed && active && (
          <Peek
            open={docPeek.open}
            side="right"
            anchorRef={docToggleRef}
            contentProps={docPeek.contentProps}
          >
            <div
              className="doc-peek-body"
              style={{
                width:
                  layout === 'LR'
                    ? `calc(100vw - ${sidebarWidth}px - ${termSizeLr}px - 6px)`
                    : `${HELP_DEFAULT_WIDTH}px`,
              }}
            >
              {renderDocContent({ withToolbar: false })}
            </div>
          </Peek>
        )}
      </section>
      {editingId && active && (
        <EditorModal
          tool={active}
          onDone={() => setEditingId(null)}
          existingGroups={existingGroups}
        />
      )}
      {errors.length > 0 && <Notifications errors={errors} />}
      {quickAddOpen && active && (
        <QuickAddModal
          onSubmit={async (body) => {
            await api.tool.appendMd(active.meta.id, body);
          }}
          onClose={() => setQuickAddOpen(false)}
        />
      )}
      {helpOpen && <HelpModal onClose={() => setHelpOpen(false)} />}
      {recordsToolId && (
        <ConfigRecords
          onClose={() => setRecordsToolId(null)}
          toolId={recordsToolId === '__global__' ? undefined : recordsToolId}
        />
      )}
      {preview && <PreviewOverlay state={preview} onClose={() => setPreview(null)} />}
    </div>
  );
}
