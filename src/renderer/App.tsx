import { useEffect, useState } from 'react';
import { useTools } from './hooks/useTools';
import { Sidebar } from './components/Sidebar';
import { TerminalPane } from './components/TerminalPane';
import { HelpPane } from './components/HelpPane';
import { EditorPane } from './components/EditorPane';
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

  return (
    <div className="app">
      <Sidebar
        tools={tools}
        activeId={activeId}
        onSelect={setActiveId}
        onNew={createTool}
      />
      <section className="terminal-area">
        {activeId ? <TerminalPane tools={tools} activeId={activeId} /> : <div className="placeholder">选择一个工具</div>}
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
              });
            }}
          >
            ↻ 重启终端
          </button>
        )}
      </section>
      <section className="help-area">
        {active && editingId === active.meta.id ? (
          <EditorPane tool={active} onDone={() => setEditingId(null)} />
        ) : active ? (
          <>
            <div className="help-toolbar">
              <button title="上移" disabled={activeIndex <= 0} onClick={() => moveTool(active.meta.id, -1)}>↑ 上移</button>
              <button title="下移" disabled={activeIndex >= tools.length - 1} onClick={() => moveTool(active.meta.id, 1)}>↓ 下移</button>
              <button title="删除" className="danger" onClick={() => deleteTool(active.meta.id)}>✕ 删除</button>
              <button title="编辑" className="primary" onClick={() => setEditingId(active.meta.id)}>编辑</button>
            </div>
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
