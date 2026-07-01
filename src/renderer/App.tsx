import { useEffect, useState } from 'react';
import { useTools } from './hooks/useTools';
import { Sidebar } from './components/Sidebar';
import { TerminalPane } from './components/TerminalPane';
import { HelpPane } from './components/HelpPane';
import { EditorPane } from './components/EditorPane';
import { QuickCommands } from './components/QuickCommands';
import { termRegistry } from './lib/termRegistry';

export default function App() {
  const { tools, errors } = useTools();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const active = tools.find((t) => t.meta.id === activeId) ?? null;
  const activeIndex = activeId ? tools.findIndex((t) => t.meta.id === activeId) : -1;

  useEffect(() => {
    if (!activeId && tools.length > 0) setActiveId(tools[0].meta.id);
  }, [tools, activeId]);

  // Electron's window.prompt() is not implemented (returns null), so we create the
  // tool with a placeholder name and drop straight into the editor, where the user
  // can set the real name, icon, and cwd.
  const createTool = async () => {
    const id = await window.api.tool.create('新工具');
    setActiveId(id);
    setEditingId(id);
  };
  const deleteTool = async (id: string) => {
    if (!window.confirm('删除该工具？')) return;
    await window.api.tool.del(id);
    if (activeId === id) setActiveId(null);
  };
  const moveTool = async (id: string, dir: -1 | 1) => {
    const ids = tools.map((t) => t.meta.id);
    const i = ids.indexOf(id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    await window.api.tool.reorder(ids);
  };

  const exportTools = async () => {
    const res = await window.api.bundle.export();
    if (!res || res.canceled) return;
    if ('error' in res && res.error) window.alert(`导出失败: ${res.error}`);
    else window.alert(`已导出 ${res.count} 个工具到:\n${res.path}`);
  };
  const exportOne = async (id: string) => {
    const res = await window.api.bundle.exportOne(id);
    if (!res || res.canceled) return;
    if ('error' in res && res.error) window.alert(`导出失败: ${res.error}`);
    else if ('path' in res) window.alert(`已导出工具到:\n${res.path}`);
  };
  const importTools = async () => {
    const res = await window.api.bundle.import();
    if (!res || res.canceled) return;
    if ('error' in res && res.error) window.alert(`导入失败: ${res.error}`);
    else window.alert(`已导入 ${res.count} 个工具。`);
  };

  return (
    <div className="app">
      <Sidebar
        tools={tools}
        activeId={activeId}
        onSelect={setActiveId}
        onNew={createTool}
        onExport={exportTools}
        onImport={importTools}
      />
      <section className="terminal-area">
        {activeId ? <TerminalPane tools={tools} activeId={activeId} /> : <div className="placeholder">选择一个工具</div>}
        <div className="term-toolbar">
          <QuickCommands tools={tools} activeTool={active} />
          {active && (
            <button
              className="term-restart"
              title="重启终端"
              onClick={() => {
                termRegistry.get(active.meta.id)?.reset();
                window.api.pty.restart(active.meta.id, {
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
      </section>
      <section className="help-area">
        {active && editingId === active.meta.id ? (
          <EditorPane tool={active} onDone={() => setEditingId(null)} />
        ) : active ? (
          <>
            <div className="help-toolbar">
              <button title="上移" disabled={activeIndex <= 0} onClick={() => moveTool(active.meta.id, -1)}>↑ 上移</button>
              <button title="下移" disabled={activeIndex >= tools.length - 1} onClick={() => moveTool(active.meta.id, 1)}>↓ 下移</button>
              {!active.meta.special && (
                <button title="删除" className="danger" onClick={() => deleteTool(active.meta.id)}>✕ 删除</button>
              )}
              <button title="导出该工具为 JSON" onClick={() => exportOne(active.meta.id)}>⤓ 导出</button>
              {active.meta.readOnly && (
                <button title="重新读取远程内容" onClick={() => window.api.refreshMd()}>⟳ 重新读取</button>
              )}
              <button title="编辑" className="primary" onClick={() => setEditingId(active.meta.id)}>编辑</button>
            </div>
            {active.meta.readOnly && (
              <div className="readonly-banner">📡 远程只读 · 来自 {active.meta.mdUrl}</div>
            )}
            <HelpPane tool={active} activeToolId={active.meta.id} />
          </>
        ) : (
          <div className="placeholder">无选中工具</div>
        )}
      </section>
      {errors.length > 0 && (
        <div className="errors">
          {errors.map((e) => (
            <div key={e.id}>
              {e.id}: {e.message}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
