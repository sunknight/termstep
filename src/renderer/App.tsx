import { useEffect, useState } from 'react';
import { useTools } from './hooks/useTools';
import { Sidebar } from './components/Sidebar';
import { TerminalPane } from './components/TerminalPane';
import { HelpPane } from './components/HelpPane';
import { EditorPane } from './components/EditorPane';
import { QuickAddModal } from './components/QuickAddModal';
import { QuickCommands } from './components/QuickCommands';
import { Notifications } from './components/Notifications';
import { HoverTip } from './components/HoverTip';
import { PanelToggle } from './components/PanelToggle';
import { termRegistry } from './lib/termRegistry';
import { api } from './lib/api';
import { confirmDialog, alertDialog } from './lib/dialog';

// Right panel width bounds. Match the sidebar's range so the two sides feel
// symmetric; the default keeps the old hardcoded 340px.
const HELP_MIN_WIDTH = 200;
const HELP_MAX_WIDTH = 560;
const HELP_DEFAULT_WIDTH = 340;

export default function App() {
  const { tools, errors } = useTools();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [quickAddOpen, setQuickAddOpen] = useState(false);
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
    const res = await api.bundle.import();
    if (!res || res.canceled) return;
    if ('error' in res && res.error) await alertDialog(`导入失败: ${res.error}`);
    else await alertDialog(`已导入 ${res.count} 个工具。`);
  };

  // Each panel's element is built once and used in exactly one place: docked
  // when expanded, or floated inside the Peek when collapsed. Same component =>
  // one source of truth for the tool list and the docs.
  const sidebarContent = (
    <Sidebar
      tools={tools}
      activeId={activeId}
      onSelect={setActiveId}
      onReorder={reorderTools}
      onNew={createTool}
      onExport={exportTools}
      onImport={importTools}
      floating={sidebarCollapsed}
    />
  );
  // `floating` = rendered inside the collapsed peek: hide the delete/export/edit
  // toolbar there (the peek is for reading docs / running commands, not editing).
  const renderHelp = (floating: boolean) => (
    <div
      className="help-area"
      // Width applies in both docked and floating states so the collapsed
      // hover-peek has a real width (it has none from CSS, and without one it
      // collapses / escapes the window). Only the flex shorthand is dock-only
      // (the floating peek is position:fixed, not in the flex row).
      style={{
        width: `${helpWidth}px`,
        ...(floating ? {} : { flex: `0 0 ${helpWidth}px` }),
      }}
    >
      {active && editingId === active.meta.id ? (
        <EditorPane tool={active} onDone={() => setEditingId(null)} />
      ) : active ? (
        <>
          {!floating && (
            <div className="help-toolbar">
              <button title="删除" className="danger" onClick={() => deleteTool(active.meta.id)}>✕ 删除</button>
              <button title="导出该工具为 JSON" onClick={() => exportOne(active.meta.id)}>⤓ 导出</button>
              {active.meta.useRemote && (
                <button title="重新读取远程内容" onClick={() => api.refreshMd()}>⟳ 重新读取</button>
              )}
              {!active.meta.useRemote && (
                <button title="快速添加命令（追加到末尾）" onClick={() => setQuickAddOpen(true)}>+</button>
              )}
              <button title="编辑" className="primary" onClick={() => setEditingId(active.meta.id)}>编辑</button>
            </div>
          )}
          <HelpPane
            tool={active}
            activeToolId={active.meta.id}
            markdown={
              active.meta.useRemote ? active.remoteMarkdown ?? '' : active.helpMarkdown
            }
          />
        </>
      ) : (
        <div className="placeholder">无选中工具</div>
      )}
      {!floating && <div className="help-resizer" onMouseDown={startHelpDrag} title="拖动调整宽度" />}
    </div>
  );

  return (
    <div className="app">
      {!sidebarCollapsed && sidebarContent}
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
      {errors.length > 0 && <Notifications errors={errors} />}
      {quickAddOpen && active && (
        <QuickAddModal
          onSubmit={async (body) => {
            await api.tool.appendButtons(active.meta.id, body);
          }}
          onClose={() => setQuickAddOpen(false)}
        />
      )}
    </div>
  );
}
