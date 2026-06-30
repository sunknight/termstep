import { useEffect, useState } from 'react';
import { useTools } from './hooks/useTools';
import { Sidebar } from './components/Sidebar';

export default function App() {
  const { tools, errors } = useTools();
  const [activeId, setActiveId] = useState<string | null>(null);

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
        <div className="placeholder">终端（Task 9）</div>
      </section>
      <section className="help-area">
        <div className="placeholder">帮助（Task 10）</div>
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
