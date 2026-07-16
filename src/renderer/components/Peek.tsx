import { useLayoutEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface PeekProps {
  open: boolean;
  side: 'left' | 'right';
  anchorRef: React.RefObject<HTMLElement>; // the toggle button — peek sits below it
  contentProps: { onMouseEnter: () => void; onMouseLeave: () => void };
  closeOnDown?: boolean; // sidebar peek: mousedown dismisses; help peek: stays open
  onClose?: () => void;
  children: ReactNode;
}

// Floating overlay for a collapsed panel. position: fixed, portalled to body so
// it floats above the terminal without pushing it (the terminal keeps full
// width). Width comes from the child's own class (.sidebar / .help-area); the
// peek just positions and shadows. Top tracks the header bar's bottom edge so
// left and right peeks align on the same line. A transparent hover-bridge sits
// between the toggle button and the panel content so moving the pointer from
// the toggle into the panel does not snap it shut (PeekController grace period
// aside, the bridge removes any dead gap entirely).
export function Peek(props: PeekProps) {
  const [top, setTop] = useState<number | null>(null);

  useLayoutEffect(() => {
    if (!props.open) {
      setTop(null);
      return;
    }
    const measure = () => {
      // Anchor to the header bar (.term-header) bottom, not the toggle button's
      // bottom — the two toggle buttons sit at opposite ends of the header, and
      // using the header keeps both peeks' tops on the exact same line.
      const btn = props.anchorRef.current;
      const header = btn?.closest('.term-header') as HTMLElement | null;
      const r = (header ?? btn)?.getBoundingClientRect();
      if (r) setTop(r.bottom);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [props.open, props.anchorRef]);

  if (!props.open || top == null) return null;

  const style: React.CSSProperties = {
    position: 'fixed',
    top: `${top}px`,
    height: `calc(100% - ${top}px)`,
    ...(props.side === 'left' ? { left: 0 } : { right: 0 }),
  };

  return createPortal(
    <div
      className={'peek' + (props.side === 'left' ? ' peek-left' : ' peek-right')}
      style={style}
      onMouseEnter={props.contentProps.onMouseEnter}
      onMouseLeave={props.contentProps.onMouseLeave}
      // 用 mousedown 关闭，不用 click：触控板「轻点来点按」抬起时手指易横向滑动几像素，
      // 使 mousedown 与 mouseup 落在不同元素 → 不合成 click → peek 不会关闭。mousedown
      // 稳定触发，故用它。子元素（如侧边栏工具项）的 mousedown 先于冒泡到此，选中已入队。
      onMouseDown={props.closeOnDown ? props.onClose : undefined}
    >
      {props.children}
    </div>,
    document.body,
  );
}
