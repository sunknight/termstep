import { useEffect, useState } from 'react';
import type { Tool } from '../../shared/types';
import { UpdateChecker } from './UpdateChecker';

const MIN_WIDTH = 140;
const MAX_WIDTH = 380;
const DEFAULT_WIDTH = 180;
const STORAGE_KEY = 'termstep:sidebar-width';

export function Sidebar(props: {
  tools: Tool[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onReorder: (orderedIds: string[]) => void;
  onNew: () => void;
  onExport: () => void;
  onImport: () => void;
  floating?: boolean;
}) {
  const [width, setWidth] = useState<number>(() => {
    const v = Number(localStorage.getItem(STORAGE_KEY));
    return v >= MIN_WIDTH && v <= MAX_WIDTH ? v : DEFAULT_WIDTH;
  });
  // Drag-to-reorder state for the normal tool list.
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

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

  // Reorder the list by dropping dragId onto overId's position.
  const handleDrop = () => {
    if (dragId && overId && dragId !== overId) {
      const ids = props.tools.map((t) => t.meta.id);
      const from = ids.indexOf(dragId);
      const to = ids.indexOf(overId);
      if (from >= 0 && to >= 0) {
        ids.splice(from, 1);
        ids.splice(to, 0, dragId);
        props.onReorder(ids);
      }
    }
    setDragId(null);
    setOverId(null);
  };

  return (
    <nav className="sidebar" style={{ width: `${width}px`, flex: `0 0 ${width}px` }}>
      <ul>
        {props.tools.map((t) => {
          const id = t.meta.id;
          const cls = [
            id === props.activeId ? 'active' : '',
            dragId === id ? 'dragging' : '',
            overId === id && dragId && dragId !== id ? 'drag-over' : '',
          ]
            .filter(Boolean)
            .join(' ');
          return (
            <li
              key={id}
              className={cls}
              draggable
              onDragStart={() => setDragId(id)}
              onDragOver={(e) => {
                e.preventDefault();
                if (overId !== id) setOverId(id);
              }}
              onDrop={(e) => {
                e.preventDefault();
                handleDrop();
              }}
              onDragEnd={() => {
                setDragId(null);
                setOverId(null);
              }}
              onClick={() => props.onSelect(id)}
              title="拖动以排序"
            >
              <span className="icon">{t.meta.icon}</span>
              <span className="name">{t.meta.name}</span>
            </li>
          );
        })}
      </ul>
      {!props.floating && (
        <>
          <button className="new-tool" onClick={props.onNew}>+ 新建工具</button>
          <div className="sidebar-io">
            <button className="io-btn" onClick={props.onExport} title="导出全部工具为 JSON">⤓ 导出</button>
            <button className="io-btn" onClick={props.onImport} title="从 JSON 导入工具">⤒ 导入</button>
          </div>
          <UpdateChecker />
          <div className="sidebar-resizer" onMouseDown={startDrag} title="拖动调整宽度" />
        </>
      )}
    </nav>
  );
}
