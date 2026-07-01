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
  onExport: () => void;
  onImport: () => void;
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

  // Special tools (e.g. the _quick command source) are shown in their own section
  // above "新建工具", separated from the normal tool list.
  const normal = props.tools.filter((t) => !t.meta.special);
  const special = props.tools.filter((t) => t.meta.special);

  return (
    <nav className="sidebar" style={{ width: `${width}px`, flex: `0 0 ${width}px` }}>
      <ul>
        {normal.map((t) => (
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
      {special.length > 0 && (
        <div className="sidebar-special">
          {special.map((t) => (
            <div
              key={t.meta.id}
              className={'sidebar-special-item' + (t.meta.id === props.activeId ? ' active' : '')}
              title="快捷命令：其按钮在任意工具终端的全局下拉中可用"
              onClick={() => props.onSelect(t.meta.id)}
            >
              <span className="icon">{t.meta.icon}</span>
              <span className="name">{t.meta.name}</span>
            </div>
          ))}
        </div>
      )}
      <button className="new-tool" onClick={props.onNew}>+ 新建工具</button>
      <div className="sidebar-io">
        <button className="io-btn" onClick={props.onExport} title="导出全部工具为 JSON">⤓ 导出</button>
        <button className="io-btn" onClick={props.onImport} title="从 JSON 导入工具">⤒ 导入</button>
      </div>
      <div className="sidebar-resizer" onMouseDown={startDrag} title="拖动调整宽度" />
    </nav>
  );
}
