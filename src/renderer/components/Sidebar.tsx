import { useEffect, useRef, useState } from 'react';
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
  // overId 的 ref 镜像：pointerup 回调是拖拽开始时那次渲染的闭包，读到的是旧值
  // （null）。drop 时必须读最新值，所以用 ref 同步。
  const overIdRef = useRef<string | null>(null);
  useEffect(() => {
    overIdRef.current = overId;
  }, [overId]);
  // 自实现拖拽，用 pointer 事件而非 mouse 事件。关键原因：触控板「轻点来点按」抬起
  // 时 mouseup 经常不被 WebKit 派发（mousedown 与 mouseup 落在不同元素，或合成缺陷），
  // 导致 mouseup 监听永不触发 → 拖拽无法结束（mousemove 一直挂着，鼠标动一下就拖）。
  // pointerup 派发更可靠，配合 setPointerCapture 把指针锁到图标元素，move/up 稳定到达。
  // 阈值区分点击与拖拽：pointerdown→up 位移 < DRAG_THRESHOLD 当作点击（不拖），否则拖。
  const DRAG_THRESHOLD = 4;
  const dragStartRef = useRef<{ id: string; x: number; y: number } | null>(null);
  const dragActiveRef = useRef(false); // 超过阈值、真正进入拖拽态

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
  // 读 ref（最新值）而非 state：此函数可能由拖拽开始时那次渲染的闭包调用，state 是
  // 旧值。dragId 取自 dragStartRef（拖拽起始记录），overId 取自 overIdRef（mousemove
  // 同步）。
  const handleDrop = () => {
    const fromId = dragStartRef.current?.id ?? dragId;
    const toId = overIdRef.current ?? overId;
    if (fromId && toId && fromId !== toId) {
      const ids = props.tools.map((t) => t.meta.id);
      const from = ids.indexOf(fromId);
      const to = ids.indexOf(toId);
      if (from >= 0 && to >= 0) {
        ids.splice(from, 1);
        ids.splice(to, 0, fromId);
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
              data-key={id}
              className={cls}
              title={props.floating ? undefined : '拖动图标以排序'}
              // 整行（含 padding 上下空白）pointerdown 即选中。不用 click——触控板「轻点
              // 来点按」抬起时手指易横向滑动几像素，使 mousedown 与 mouseup 落在不同
              // 元素，浏览器不合成 click → 轻点失败。pointerdown/mousedown 稳定触发，
              // 不受抬手滑动影响，故用它选中，且覆盖整个 li（包括文字之外的空白）。
              // 用 pointer 而非 mouse，是为了和图标手柄用同一事件流——这样图标手柄的
              // stopPropagation 才能阻止冒泡到这里（pointer 与 mouse 是两条独立流）。
              // 展开态的图标手柄 stopPropagation 阻止选中（图标仅拖拽）；折叠态图标不
              // 绑 handler，pointerdown 冒泡到这里选中。
              onPointerDown={(e) => {
                if (e.button !== 0) return; // 仅左键
                props.onSelect(id);
              }}
            >
              {/* 图标：
                  - 展开态：仅作拖拽手柄，pointerdown stopPropagation 阻止冒泡到 <li>
                    （否则会选中），轻点图标不选中。位移超过阈值才算拖拽。
                  - 折叠态（浮层）：不可拖拽，不绑 handler，pointerdown 冒泡到 <li> 选中。
                  拖拽用 pointer 事件而非 mouse：触控板轻点的 mouseup 经常不派发，会导致
                  拖拽无法结束（见组件上方注释）。用 setPointerCapture 把后续 move/up 锁
                  定到本元素，确保 pointerup 稳定到达、拖拽可靠结束。 */}
              <span
                className={'icon' + (props.floating ? '' : ' drag-handle')}
                onPointerDown={
                  props.floating
                    ? undefined
                    : (e) => {
                        if (e.button !== 0) return; // 仅左键
                        e.stopPropagation(); // 图标是拖拽手柄，不让 <li> 的选中冒泡上来
                        // 捕获元素引用：pointerdown 事件结束后 e.currentTarget 会变 null，
                        // 后续 pointerup 回调里不能再从 e 上读，必须用闭包里的 handle。
                        const handle = e.currentTarget;
                        const pointerId = e.pointerId;
                        dragStartRef.current = { id, x: e.clientX, y: e.clientY };
                        dragActiveRef.current = false;
                        // 锁定指针：后续 move/up/cancel 都派发给本元素，即使指针移出图标。
                        handle.setPointerCapture(pointerId);
                        const onMove = (ev: PointerEvent) => {
                          const s = dragStartRef.current;
                          if (!s) return;
                          if (!dragActiveRef.current) {
                            const dx = ev.clientX - s.x;
                            const dy = ev.clientY - s.y;
                            if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return; // 阈值内不算拖拽
                            dragActiveRef.current = true; // 超过阈值 → 进入拖拽态
                            setDragId(s.id);
                          }
                          // 拖拽中：用 elementFromPoint 命中指针下的 <li> 更新 drop 目标
                          const el = document.elementFromPoint(ev.clientX, ev.clientY);
                          const li = el?.closest?.('li');
                          const overKey = li?.getAttribute('data-key') ?? null;
                          setOverId((cur) => (cur === overKey ? cur : overKey));
                        };
                        const finish = () => {
                          handle.removeEventListener('pointermove', onMove);
                          handle.removeEventListener('pointerup', finish);
                          handle.removeEventListener('pointercancel', finish);
                          try {
                            handle.releasePointerCapture(pointerId);
                          } catch {
                            // pointerId 已失效（如元素已卸载）——忽略
                          }
                          if (dragActiveRef.current) {
                            handleDrop(); // 真拖拽 → 执行 reorder
                          }
                          dragStartRef.current = null;
                          dragActiveRef.current = false;
                          setDragId(null);
                          setOverId(null);
                        };
                        handle.addEventListener('pointermove', onMove);
                        handle.addEventListener('pointerup', finish);
                        handle.addEventListener('pointercancel', finish);
                      }
                }
              >
                {t.meta.icon}
              </span>
              <span className="name">
                {t.meta.name}
              </span>
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
