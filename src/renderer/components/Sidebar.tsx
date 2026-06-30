import type { Tool } from '../../shared/types';

export function Sidebar(props: {
  tools: Tool[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onMove: (id: string, dir: -1 | 1) => void;
}) {
  return (
    <nav className="sidebar">
      <ul>
        {props.tools.map((t, i) => (
          <li key={t.meta.id} className={t.meta.id === props.activeId ? 'active' : ''}>
            <span className="row" onClick={() => props.onSelect(t.meta.id)}>
              <span className="icon">{t.meta.icon}</span>
              <span className="name">{t.meta.name}</span>
            </span>
            <span className="row-actions">
              <button title="上移" disabled={i === 0} onClick={() => props.onMove(t.meta.id, -1)}>↑</button>
              <button title="下移" disabled={i === props.tools.length - 1} onClick={() => props.onMove(t.meta.id, 1)}>↓</button>
              <button title="删除" onClick={() => props.onDelete(t.meta.id)}>✕</button>
            </span>
          </li>
        ))}
      </ul>
      <button className="new-tool" onClick={props.onNew}>+ 新建工具</button>
    </nav>
  );
}
