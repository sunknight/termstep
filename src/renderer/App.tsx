import { useEffect, useRef, useState } from 'react';
import { useTools } from './hooks/useTools';
import { Sidebar } from './components/Sidebar';
import { TerminalPane } from './components/TerminalPane';
import { HelpPane } from './components/HelpPane';
import { EditorPane } from './components/EditorPane';
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
import { WebPane } from './components/WebPane';
import { termRegistry } from './lib/termRegistry';
import { api } from './lib/api';
import { confirmDialog, alertDialog } from './lib/dialog';
import { resetTerminalModes } from './lib/termReset';
import { showToast } from './lib/clipboardToast';

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
  // 工具内编辑器（可多个同时打开）：key=打开编辑器的工具 id。编辑器实例随工具
  // 常驻（切工具只隐藏不卸载，草稿保留），关闭（保存/确认丢弃）才从 map 移除。
  const [editingIds, setEditingIds] = useState<Record<string, true>>({});
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  // 配置记录 modal：null=关闭；string=per-tool（工具 id）；'__global__'=全部配置记录。
  const [recordsToolId, setRecordsToolId] = useState<string | null>(null);
  // 工具内预览弹层（可多个同时打开）：key=打开预览的工具 id，值=该工具当前
  // 展示的网页/文档/加载中/错误态。实例随工具常驻（切工具只隐藏不卸载，iframe
  // 不重载），关闭才从 map 移除。
  const [previews, setPreviews] = useState<Record<string, PreviewState>>({});
  // 网页型工具（kind=web）的刷新计数：+1 = WebPane 按配置 URL 强制重载该工具。
  const [webRefreshTick, setWebRefreshTick] = useState<Record<string, number>>({});
  const active = tools.find((t) => t.meta.id === activeId) ?? null;
  // 网页型工具派生：激活工具是否网页型、全部网页型工具列表。
  const activeIsWeb = !!active && active.meta.kind === 'web';
  const webTools = tools.filter((t) => t.meta.kind === 'web');
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
  // key 捕获发起时的 activeId：async 期间用户可能切走工具，结果仍写回发起工具。
  const openPreview = async (req: PreviewRequest) => {
    const id = activeId;
    if (!id) return;
    if (req.type === 'web') {
      setPreviews((m) => ({ ...m, [id]: { kind: 'web', url: req.url, title: req.title } }));
      return;
    }
    setPreviews((m) => ({ ...m, [id]: { kind: 'loading', title: req.title } }));
    try {
      const r = await api.fetchMdPreview(req.url);
      // 完成态写入前确认预览未被关掉（loading 期间关闭则不复活）。
      setPreviews((m) => {
        if (!(id in m)) return m;
        if (r.error) {
          return { ...m, [id]: { kind: 'error', title: req.title, message: r.error } };
        }
        return {
          ...m,
          [id]: req.isTxt
            ? { kind: 'txt', title: req.title, content: r.markdown }
            : { kind: 'md', title: req.title, content: r.markdown },
        };
      });
    } catch (e) {
      setPreviews((m) =>
        id in m ? { ...m, [id]: { kind: 'error', title: req.title, message: String(e) } } : m,
      );
    }
  };

  // 关闭某工具的预览（×/Esc/点遮罩共用）。
  const closePreview = (id: string) => {
    setPreviews((m) => {
      if (!(id in m)) return m;
      const next = { ...m };
      delete next[id];
      return next;
    });
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

  // per-tool 常驻弹层状态（编辑器/预览）随 tools 清理：工具被删（含导入替换/
  // 外部变更）时移除其条目，避免残留 key 让渲染层挂着不存在的工具。
  useEffect(() => {
    const prune = <T,>(m: Record<string, T>): Record<string, T> => {
      const ids = Object.keys(m);
      if (ids.length === 0) return m;
      const alive = new Set(tools.map((t) => t.meta.id));
      const next = ids.filter((id) => alive.has(id));
      if (next.length === ids.length) return m;
      return Object.fromEntries(next.map((id) => [id, m[id]]));
    };
    setEditingIds((m) => prune(m));
    setPreviews((m) => prune(m));
    setWebRefreshTick((m) => prune(m));
  }, [tools]);

  // Poll the active shell's live cwd (resolved from its OS pid) so the terminal
  // header follows the user's `cd`. Cheap readlink, ~1.5s cadence.
  // 同一轮询顺带取「前台程序退出回到 shell」跳变标志（SSH/tmux 异常断开后
  // 鼠标追踪等 private mode 残留），静默复位 xterm —— 不清屏、不写 pty。
  // 网页型工具没有终端，轮询无意义，跳过。
  useEffect(() => {
    if (!activeId || activeIsWeb) {
      setLiveCwd(null);
      return;
    }
    let cancelled = false;
    let timer: number | undefined;
    const tick = async () => {
      try {
        const { cwd, modesReset } = await api.pty.probe(activeId);
        if (!cancelled) {
          setLiveCwd(cwd);
          if (modesReset) {
            const term = termRegistry.get(activeId);
            if (term) resetTerminalModes(term);
          }
        }
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
  }, [activeId, activeIsWeb]);

  // 网页型工具不持有终端：工具由终端型改成网页型后（保存 → scan → tools 更新），
  // 回收其残留 shell。ref 集合按「当前是否 web」增删——每次进入 web 形态只 kill
  // 一次（scan 会频繁重发 tools 数组，不能每次都 invoke）；切回终端形态时清记录，
  // 再改回网页仍能回收。未 spawn 过的 id 是 no-op。
  const webKilledRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const t of tools) {
      if (t.meta.kind === 'web') {
        if (!webKilledRef.current.has(t.meta.id)) {
          webKilledRef.current.add(t.meta.id);
          void api.pty.kill(t.meta.id);
        }
      } else {
        webKilledRef.current.delete(t.meta.id);
      }
    }
  }, [tools]);

  // Electron's window.prompt() is not implemented (returns null), so we create the
  // tool with a placeholder name and drop straight into the editor, where the user
  // can set the real name, icon, and cwd.
  const createTool = async () => {
    const id = await api.tool.create('新工具');
    setActiveId(id);
    setEditingIds((m) => ({ ...m, [id]: true }));
  };
  const deleteTool = async (id: string) => {
    if (!(await confirmDialog('删除该工具？', '删除工具'))) return;
    await api.tool.del(id);
    if (activeId === id) setActiveId(null);
    setEditingIds((m) => {
      if (!(id in m)) return m;
      const next = { ...m };
      delete next[id];
      return next;
    });
  };
  // Tool ordering is done by drag-and-drop in the sidebar now.
  const reorderTools = async (orderedIds: string[]) => {
    await api.tool.reorder(orderedIds);
  };
  // 分组头拖拽排序：重写 order.json 的 groups（工具 order 不动）。
  const reorderGroups = async (orderedGroups: string[]) => {
    await api.tool.reorderGroups(orderedGroups);
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
      onReorderGroups={reorderGroups}
      onMove={moveTool}
      onNew={createTool}
      onCollapse={() => setSidebarCollapsed(true)}
      onExport={exportTools}
      onImport={importTools}
      onHelp={() => setHelpOpen(true)}
      onVersions={() => setRecordsToolId('__global__')}
      editingIds={editingIds}
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
  // 覆盖层（编辑/预览）打开时锁定顶栏操作按钮（CSS .overlay-open）：这些按钮
  // 作用于终端/文档区，覆盖态下点击会产生错乱状态；☰ 工具列表开关保持可点。
  const overlayOpen = !!activeId && !!(editingIds[activeId] || previews[activeId]);
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
        {/* 顶栏：跨布局一致，始终在主区顶部。覆盖层打开时加 .overlay-open
            锁定终端/文档操作按钮（☰ 开关保持可点，用于收起/展开工具列表）。 */}
        <div className={`term-header${overlayOpen ? ' overlay-open' : ''}`}>
          {/* 折叠态的展开入口（☰ + hover peek）留在这里；展开态的收起入口在
              侧栏顶行（Sidebar onCollapse）——编辑/预览覆盖层盖住主区顶栏，
              收起按钮放顶栏会在覆盖层打开时不可点。 */}
          {sidebarCollapsed && (
            <PanelToggle
              side="left"
              collapsed={sidebarCollapsed}
              icon="☰"
              title="工具列表"
              onToggle={() => setSidebarCollapsed((v) => !v)}
              peekContent={sidebarContent}
              closePeekOnClick
            />
          )}
          {sidebarCollapsed && active && (
            <span className="term-active-tool" title={active.meta.name}>
              {active.meta.icon && <span className="term-active-tool-icon">{active.meta.icon}</span>}
              <span className="term-active-tool-name">{active.meta.name}</span>
            </span>
          )}
          {activeIsWeb ? (
            /* 网页型工具：左侧显示配置的网页地址（长 URL 右侧省略，title 看全）。 */
            <span className="term-cwd">
              <span className="term-cwd-icon">🔗</span>
              <HoverTip className="term-cwd-path web-url-path" text={active.meta.webUrl ?? ''}>
                {active.meta.webUrl ?? ''}
              </HoverTip>
            </span>
          ) : (
            <span className="term-cwd">
              <span className="term-cwd-icon">📂</span>
              <HoverTip className="term-cwd-path" text={liveCwd ?? active?.meta.cwd ?? '~'}>
                {liveCwd ?? active?.meta.cwd ?? '~'}
              </HoverTip>
            </span>
          )}
          <div className="term-actions">
            {active ? (
              activeIsWeb ? (
                /* 网页型工具：只留网页相关按钮（刷新 / 浏览器兜底）+ 编辑。
                   终端/文档组按钮全部隐藏（无对应面板，语义不成立）。 */
                <>
                  <div className="term-group">
                    <button
                      className="term-restart"
                      title="按配置 URL 强制刷新网页"
                      onClick={() => {
                        const id = active.meta.id;
                        setWebRefreshTick((m) => ({ ...m, [id]: (m[id] ?? 0) + 1 }));
                      }}
                    >
                      ⟳ 刷新
                    </button>
                    <button
                      className="term-restart"
                      title="在默认浏览器打开（拒绝被内嵌的站点显示空白时用）"
                      onClick={() => {
                        if (active.meta.webUrl) void api.shell.openExternal(active.meta.webUrl);
                      }}
                    >
                      ↗ 浏览器
                    </button>
                    <button
                      title="编辑"
                      className="term-restart primary"
                      onClick={() => setEditingIds((m) => ({ ...m, [active.meta.id]: true }))}
                    >
                      编辑
                    </button>
                  </div>
                </>
              ) : (
              <>
                {/* 终端组：终端按钮在最右侧，快捷命令/重启终端向左展开。 */}
                <div className="term-group">
                  <QuickCommands activeTool={active} termHidden={termHidden} />
                  <button
                    className="term-restart"
                    title="复位鼠标/备用屏等残留模式（SSH/tmux 异常断开后点击滚动变乱码时用）"
                    onClick={() => {
                      const term = termRegistry.get(active.meta.id);
                      if (term) {
                        resetTerminalModes(term);
                        showToast('已复位终端模式');
                      }
                    }}
                  >
                    修复终端
                  </button>
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
                    重启终端
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
                    ❯ 终端
                  </button>
                </div>
                {/* 终端组与文档组之间的竖线分隔。 */}
                <span className="term-actions-sep" aria-hidden="true" />
                {/* 文档组：文档按钮在最左侧，删除/导出/记录/重载/添加/编辑向右展开。
                    这些操作作用于工具本身（不依赖文档是否可见），文档折叠为 Peek 时也始终显示。 */}
                <div className="term-group">
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
                    📖 文档
                  </button>
                  <button title="删除" className="term-restart danger" onClick={() => deleteTool(active.meta.id)}>删除</button>
                  <button title="导出该工具为 JSON" className="term-restart" onClick={() => exportOne(active.meta.id)}>导出</button>
                  <button title="该工具的配置记录" className="term-restart" onClick={() => setRecordsToolId(active.meta.id)}>记录</button>
                  {active.meta.useRemote && (
                    <button title="重新拉取远程内容" className="term-restart" onClick={() => api.refreshMd()}>重载</button>
                  )}
                  {!active.meta.useRemote && (
                    <button title="快速添加命令（追加到末尾）" className="term-restart" onClick={() => setQuickAddOpen(true)}>添加</button>
                  )}
                  <button title="编辑" className="term-restart primary" onClick={() => setEditingIds((m) => ({ ...m, [active.meta.id]: true }))}>编辑</button>
                </div>
              </>
              )
            ) : (
              <QuickCommands activeTool={active} termHidden={termHidden} />
            )}
          </div>
        </div>
        {/* web-mode：激活工具是网页型——终端/文档三件套经 CSS display:none 隐藏
            （必须保持挂载：TerminalPane 内所有常驻终端不能卸载），.web-pane 撑满。 */}
        <div className={`main-body layout-${layout.toLowerCase()}${activeIsWeb ? ' web-mode' : ''}`}>
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
              <TerminalPane tools={tools.filter((t) => t.meta.kind !== 'web')} activeId={activeId} />
            ) : (
              <div className="placeholder">选择一个工具</div>
            )}
          </div>
          {/* 网页型工具面板：常驻（默认 display:none），web-mode 时撑满主区。
              每工具一个 iframe 实例，切工具不重载。放在三件套之后、覆盖层之前。 */}
          <WebPane tools={webTools} activeId={activeId} refreshTick={webRefreshTick} />
          {/* 工具内编辑层：挂 .main-body 内（absolute inset:0 只盖文档/终端主体，
              露出顶栏——折叠态 ☰ 展开按钮保持可点；顶栏操作按钮经 .overlay-open
              锁定）。切工具时非激活工具的编辑器仅隐藏（display:none），EditorPane
              常驻不卸载，草稿保留；切回即恢复。关闭（保存/确认丢弃）才从
              editingIds 移除。 */}
          {tools
            .filter((t) => editingIds[t.meta.id])
            .map((t) => (
              <div
                key={t.meta.id}
                className="editor-overlay"
                role="dialog"
                aria-label={`编辑工具 ${t.meta.name}`}
                style={{ display: t.meta.id === activeId ? 'flex' : 'none' }}
              >
                <div className="editor-panel">
                  <EditorPane
                    tool={t}
                    active={t.meta.id === activeId}
                    onDone={() =>
                      setEditingIds((m) => {
                        if (!(t.meta.id in m)) return m;
                        const next = { ...m };
                        delete next[t.meta.id];
                        return next;
                      })
                    }
                    existingGroups={existingGroups}
                  />
                </div>
              </div>
            ))}
          {/* 工具内预览层：同编辑层——挂 .main-body 只盖主体、露出顶栏。切工具时
              非激活工具的预览仅隐藏（display:none），实例常驻不卸载（iframe
              不重载），切回即恢复；关闭才从 previews 移除。面板全宽（编辑限
              900px）。点遮罩关闭（预览无草稿，区别于编辑器的防误关）。 */}
          {tools.map((t) => {
            const p = previews[t.meta.id];
            if (!p) return null;
            return (
              <div
                key={t.meta.id}
                className="preview-overlay"
                role="dialog"
                aria-label={`预览 ${p.title}`}
                style={{ display: t.meta.id === activeId ? 'flex' : 'none' }}
                onClick={() => closePreview(t.meta.id)}
              >
                <div className="preview-panel" onClick={(e) => e.stopPropagation()}>
                  <PreviewOverlay
                    state={p}
                    active={t.meta.id === activeId}
                    onClose={() => closePreview(t.meta.id)}
                  />
                </div>
              </div>
            );
          })}
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
    </div>
  );
}
