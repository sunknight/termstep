import { useEffect, useState } from 'react';
import { useTools } from './hooks/useTools';
import { Sidebar } from './components/Sidebar';
import { TerminalPane } from './components/TerminalPane';
import { HelpPane } from './components/HelpPane';

export default function App() {
  const { tools, errors } = useTools();
  const [activeId, setActiveId] = useState<string | null>(null);
  const active = tools.find((t) => t.meta.id === activeId) ?? null;

  useEffect(() => {
    if (!activeId && tools.length > 0) setActiveId(tools[0].meta.id);
  }, [tools, activeId]);

  return (
    <div className="app">
      <Sidebar
        tools={tools}
        activeId={activeId}
        onSelect={setActiveId}
        onNew={() => {
          /* Task 12 */
        }}
      />
      <section className="terminal-area">
        {activeId ? <TerminalPane tools={tools} activeId={activeId} /> : <div className="placeholder">选择一个工具</div>}
      </section>
      <section className="help-area">
        {active ? (
          <HelpPane tool={active} activeToolId={active.meta.id} />
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
