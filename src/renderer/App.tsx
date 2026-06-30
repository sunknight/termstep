import { useEffect, useState } from 'react';
import { useTools } from './hooks/useTools';
import { Sidebar } from './components/Sidebar';
import { TerminalPane } from './components/TerminalPane';
import { HelpPane } from './components/HelpPane';
import { EditorPane } from './components/EditorPane';

export default function App() {
  const { tools, errors } = useTools();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const active = tools.find((t) => t.meta.id === activeId) ?? null;

  useEffect(() => {
    if (!activeId && tools.length > 0) setActiveId(tools[0].meta.id);
  }, [tools, activeId]);

  const createTool = async () => {
    const name = window.prompt('工具名称');
    if (!name) return;
    const id = await window.api.tool.create(name);
    setActiveId(id);
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
        onDelete={deleteTool}
        onMove={moveTool}
      />
      <section className="terminal-area">
        {activeId ? <TerminalPane tools={tools} activeId={activeId} /> : <div className="placeholder">选择一个工具</div>}
      </section>
      <section className="help-area">
        {active && editingId === active.meta.id ? (
          <EditorPane tool={active} onDone={() => setEditingId(null)} />
        ) : active ? (
          <>
            <div className="help-toolbar">
              <button onClick={() => setEditingId(active.meta.id)}>编辑</button>
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
