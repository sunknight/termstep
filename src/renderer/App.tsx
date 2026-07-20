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
  // 文档折叠为浮动 Peek（per-tool，内存记忆，不持久化——app 重启恢复默认展开）。
  // 切换工具再回来时保持各自状态。
  const [docCollapsedMap, setDocCollapsedMap] = useState<Record<string, boolean>>({});
  // 终端显隐（per-tool，内存记忆，不持久化）。首次访问某工具时用其
  // meta.terminalHidden（配置默认值）初始化；之后 toggle 改这个 map，不写回配置。
  const [termHiddenMap, setTermHiddenMap] = useState<Record<string, boolean>>({});
  // 文档 hover-peek：docCollapsed 时 hover 文档按钮 → 浮动展开（带 grace period）。
  const docPeek = usePeek();
  const docToggleRef = useRef<HTMLButtonElement>(null);
  // LR 布局下的文档宽度（px），全局共享。文档是固定宽面板，终端弹性占剩余空间：
  // 这样调整窗口尺寸时只改变终端宽度，文档宽度稳定不变（不被挤压）。
  const [docSizeLr, setDocSizeLr] = useState<number>(() => {
    const v = Number(localStorage.getItem('termstep:doc-size-lr'));
    return v >= 280 && v <= 1000 ? v : 380;
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
  // LR = 左右拖（改 docSizeLr，文档是固定宽面板），TB = 上下拖（改 termSizeTb，终端是固定高面板）。
  const startTermDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const layout = active?.meta.layout ?? 'LR';
    const startX = e.clientX;
    const startY = e.clientY;
    const startLr = docSizeLr;
    const startTb = termSizeTb;
    // LR：终端在左、文档在右，光标向左移 = 文档变窄；TB：文档在上、终端在下，光标向上移 = 终端变高。
    const onMove = (ev: MouseEvent) => {
      if (layout === 'LR') {
        const w = Math.min(1000, Math.max(280, startLr - (ev.clientX - startX)));
        setDocSizeLr(w);
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

  // 切换工具时，若该工具尚未有运行时记录（首次访问），用 meta.terminalHidden
  // （配置默认值）初始化；已有记录则保留（切换工具再回来保持 toggle 状态）。
  // 只依赖 activeId，不依赖 active 对象（每帧新对象会重复触发，覆盖用户 toggle）。
  useEffect(() => {
    if (!active || !activeId) return;
    setTermHiddenMap((m) => {
      if (activeId in m) return m; // 已有记录，不动
      return { ...m, [activeId]: !!active.meta.terminalHidden };
    });
  }, [activeId]);
  useEffect(() => {
    localStorage.setItem('termstep:sidebar-collapsed', sidebarCollapsed ? '1' : '0');
  }, [sidebarCollapsed]);
  useEffect(() => {
    localStorage.setItem('termstep:doc-size-lr', String(docSizeLr));
  }, [docSizeLr]);
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
  // 文档区内容（docked 主区和折叠 Peek 共用同一份）：仅 HelpPane。
  // 文档操作按钮（编辑/删除/导出/记录/重载/添加）已上移到主顶栏的 .term-actions，
  // 与「重启终端」「显隐终端」「显隐文档」同行，保持视觉单一入口。
  const renderDocContent = () =>
    active ? (
      <HelpPane
        tool={active}
        activeToolId={active.meta.id}
        isRemote={!!active.meta.useRemote}
        markdown={
          active.meta.useRemote ? active.remoteMarkdown ?? '' : active.helpMarkdown
        }
        onPreview={openPreview}
        // 宽屏 TOC（左章节右正文）的启用条件：
        //   - TB 布局：文档始终横向铺满（宽屏）→ 永远 sidebar TOC（docked 时）；
        //   - LR 布局：仅终端隐藏（文档撑满主区）时宽屏 → 那时才 sidebar TOC。
        // Peek 浮动时（docCollapsed）永远是窄屏，不开 sidebar TOC。
        sidebarToc={!docCollapsed && (layout === 'TB' || termHidden)}
        termHidden={termHidden}
      />
    ) : (
      <div className="placeholder">无选中工具</div>
    );

  // 统一布局：主区 = 顶栏 + 双面板主体（doc-pane | term-splitter | term-pane）。
  // layout(LR/TB) 决定 flex-direction；termHidden 运行时控制终端显隐；
  // docCollapsed 把文档折为浮动 Peek（终端撑满）。派生自 per-tool map。
  const layout = active?.meta.layout ?? 'LR';
  const docCollapsed = !!activeId && !!docCollapsedMap[activeId];
  // termHidden 派生：map 有记录用记录，否则用配置默认值（effect 会异步补进 map）。
  const termHidden = activeId
    ? activeId in termHiddenMap
      ? termHiddenMap[activeId]
      : !!active?.meta.terminalHidden
    : false;

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
                  className={`term-toggle ${termHidden ? '' : 'active'}`}
                  title={termHidden ? '显示终端' : '隐藏终端'}
                  onClick={() => {
                    if (!active) return;
                    const id = active.meta.id;
                    setTermHiddenMap((m) => ({ ...m, [id]: !(id in m ? m[id] : !!active.meta.terminalHidden) }));
                  }}
                >
                  {termHidden ? '▸ 终端' : '▾ 终端'}
                </button>
                <button
                  className={`term-toggle ${docCollapsed ? '' : 'active'}`}
                  title={docCollapsed ? '展开文档（hover 预览）' : '折叠文档为浮动小窗'}
                  ref={docToggleRef}
                  onClick={() => {
                    if (!active) return;
                    docPeek.close();
                    const id = active.meta.id;
                    setDocCollapsedMap((m) => ({ ...m, [id]: !m[id] }));
                  }}
                  {...(docCollapsed ? docPeek.triggerProps : {})}
                >
                  {docCollapsed ? '▤ 文档' : '▢ 文档'}
                </button>
                {/* 文档操作（编辑/删除/导出/记录/重载/添加）：始终显示，文档折叠为
                    Peek 时也不隐藏——这些操作作用于工具本身（不依赖文档是否可见），
                    且隐藏会导致编辑按钮的 margin-left:auto 跳到最右，产生布局抖动。
                    与左侧布局按钮之间用竖线分隔，视觉上区分「布局/显隐」与「文档编辑」两组。 */}
                <span className="term-actions-sep" aria-hidden="true" />
                <button title="删除" className="term-restart danger" onClick={() => deleteTool(active.meta.id)}>删除</button>
                <button title="导出该工具为 JSON" className="term-restart" onClick={() => exportOne(active.meta.id)}>导出</button>
                <button title="该工具的配置记录" className="term-restart" onClick={() => setRecordsToolId(active.meta.id)}>记录</button>
                {active.meta.useRemote && (
                  <button title="重新拉取远程内容" className="term-restart" onClick={() => api.refreshMd()}>重载</button>
                )}
                {!active.meta.useRemote && (
                  <button title="快速添加命令（追加到末尾）" className="term-restart" onClick={() => setQuickAddOpen(true)}>添加</button>
                )}
                <button title="编辑" className="term-restart primary" onClick={() => setEditingId(active.meta.id)}>编辑</button>
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
                    ? { flex: `0 0 ${docSizeLr}px`, minWidth: 0 }
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
                    ? { flex: '1 1 0', minWidth: 0 }
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
                    ? `${docSizeLr}px`
                    : `${HELP_DEFAULT_WIDTH}px`,
              }}
            >
              {renderDocContent()}
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
