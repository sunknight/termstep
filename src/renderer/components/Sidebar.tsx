import { useEffect, useState } from 'react';
import type { Tool } from '../../shared/types';

const MIN_WIDTH = 140;
const MAX_WIDTH = 380;
const DEFAULT_WIDTH = 180;
const STORAGE_KEY = 'gui-anything:sidebar-width';

export function Sidebar(props: {
  tools: Tool[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
}) {
  const [width, setWidth] = useState<number>(() => {
    const v = Number(localStorage.getItem(STORAGE_KEY));
    return v >= MIN_WIDTH && v <= MAX_WIDTH ? v : DEFAULT_WIDTH;
  });

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, String(width));
    document.documentElement.style.setProperty('--sidebar-w', `${width}px`);
  }, [width]);

  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const onMove = (ev: MouseEvent) => {
      const w = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startW + (ev.clientX - startX)));
      setWidth(w);
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

  return (
    <nav className="sidebar" style={{ width: `${width}px`, flex: `0 0 ${width}px` }}>
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
      <button className="new-tool" onClick={props.onNew}>+ 新建工具</button>
      <div className="sidebar-resizer" onMouseDown={startDrag} title="拖动调整宽度" />
    </nav>
  );
}
