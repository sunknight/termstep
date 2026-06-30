import type { Tool } from '../../shared/types';

export function Sidebar(props: {
  tools: Tool[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
}) {
  return (
    <nav className="sidebar">
      <ul>
        {props.tools.map((t) => (
          <li
            key={t.meta.id}
            className={t.meta.id === props.activeId ? 'active' : ''}
            onClick={() => props.onSelect(t.meta.id)}
          >
            <span className="icon">{t.meta.icon}</span>
            <span className="name">{t.meta.name}</span>
          </li>
        ))}
      </ul>
      <button className="new-tool" onClick={props.onNew}>
        + 新建工具
      </button>
    </nav>
  );
}
