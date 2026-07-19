import { useEffect, useState } from 'react';
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
import { PreviewOverlay } from './components/PreviewOverlay';
import type { PreviewState, PreviewRequest } from './components/PreviewOverlay';
import { termRegistry } from './lib/termRegistry';
import { api } from './lib/api';
import { confirmDialog, alertDialog } from './lib/dialog';

// Right panel width bounds. Match the sidebar's range so the two sides feel
// symmetric; the default keeps the old hardcoded 340px.
const HELP_MIN_WIDTH = 200;
const HELP_MAX_WIDTH = 560;
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
  const [helpCollapsed, setHelpCollapsed] = useState<boolean>(
    () => localStorage.getItem('termstep:help-collapsed') === '1',
  );
  // Right panel width, persisted like the sidebar's. Drag direction is mirrored:
  // on the right edge, moving the cursor LEFT widens the panel.
  const [helpWidth, setHelpWidth] = useState<number>(() => {
    const v = Number(localStorage.getItem('termstep:help-width'));
    return v >= HELP_MIN_WIDTH && v <= HELP_MAX_WIDTH ? v : HELP_DEFAULT_WIDTH;
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

  const startHelpDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = helpWidth;
    const onMove = (ev: MouseEvent) => {
      // Cursor moves left (ev.clientX < startX) -> panel grows.
      const w = Math.min(HELP_MAX_WIDTH, Math.max(HELP_MIN_WIDTH, startW + (startX - ev.clientX)));
      setHelpWidth(w);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  useEffect(() => {
    localStorage.setItem('termstep:sidebar-collapsed', sidebarCollapsed ? '1' : '0');
  }, [sidebarCollapsed]);
  useEffect(() => {
    localStorage.setItem('termstep:help-collapsed', helpCollapsed ? '1' : '0');
  }, [helpCollapsed]);
  useEffect(() => {
    localStorage.setItem('termstep:help-width', String(helpWidth));
  }, [helpWidth]);

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
  // `floating` = rendered inside the collapsed peek: hide the delete/export/edit
  // toolbar there (the peek is for reading docs / running commands, not editing).
  // `documentMode` = 仅文档型工具：撑满中+右栏位置（flex:1），不渲染 resizer
  // （产品/运营阅读视图，宽度不需要手动调）。
  const renderHelp = (floating: boolean, documentMode = false) => (
    <div
      className={documentMode ? 'help-area document-mode' : 'help-area'}
      // Width applies in both docked and floating states so the collapsed
      // hover-peek has a real width (it has none from CSS, and without one it
      // collapses / escapes the window). Only the flex shorthand is dock-only
      // (the floating peek is position:fixed, not in the flex row).
      // documentMode 用 flex:1 撑满，覆盖固定宽度。
      style={
        documentMode
          ? { flex: 1, minWidth: 0 }
          : {
              width: `${helpWidth}px`,
              ...(floating ? {} : { flex: `0 0 ${helpWidth}px` }),
            }
      }
    >
      {active ? (
        <>
          {!floating && (
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
            sidebarToc={documentMode}
          />
        </>
      ) : (
        <div className="placeholder">无选中工具</div>
      )}
      {!floating && !documentMode && (
        <div className="help-resizer" onMouseDown={startHelpDrag} title="拖动调整宽度" />
      )}
    </div>
  );

  // 文档型工具（tool.json 的 type === 'document'）：不建终端，整屏渲染文档。
  const isDocument = active?.meta.type === 'document';

  return (
    <div className="app">
      {!sidebarCollapsed && sidebarContent}
      {isDocument ? (
        renderHelp(false, true)
      ) : (
        <>
          <section className="terminal-area">
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
                <QuickCommands activeTool={active} />
                {active && (
                  <button
                    className="term-restart"
                    title="重启终端"
                    onClick={() => {
                      termRegistry.get(active.meta.id)?.reset();
                      api.pty.restart(active.meta.id, {
                        cwd: active.meta.cwd,
                        shell: active.meta.shell,
                        env: active.meta.env,
                        tmux: active.meta.tmux,
                        initCommands: active.meta.initCommands,
                        type: active.meta.type,
                      });
                    }}
                  >
                    ↻ 重启终端
                  </button>
                )}
              </div>
              <PanelToggle
                side="right"
                collapsed={helpCollapsed}
                icon="📖"
                title="工具文档"
                onToggle={() => setHelpCollapsed((v) => !v)}
                peekContent={renderHelp(true)}
              />
            </div>
            <div className="term-pane-wrap">
              {activeId ? (
                <TerminalPane tools={tools} activeId={activeId} />
              ) : (
                <div className="placeholder">选择一个工具</div>
              )}
            </div>
          </section>
          {!helpCollapsed && renderHelp(false)}
        </>
      )}
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
