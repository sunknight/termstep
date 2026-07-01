import { useLayoutEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface PeekProps {
  open: boolean;
  side: 'left' | 'right';
  anchorRef: React.RefObject<HTMLElement>; // the toggle button — peek sits below it
  contentProps: { onMouseEnter: () => void; onMouseLeave: () => void };
  closeOnClick?: boolean; // sidebar peek: click dismisses; help peek: stays open
  onClose?: () => void;
  children: ReactNode;
}

// Floating overlay for a collapsed panel. position: fixed, portalled to body so
// it floats above the terminal without pushing it (the terminal keeps full
// width). Width comes from the child's own class (.sidebar / .help-area); the
// peek just positions and shadows. Top tracks the toggle button's bottom edge so
// it always sits just under the header.
export function Peek(props: PeekProps) {
  const [top, setTop] = useState<number | null>(null);

  useLayoutEffect(() => {
    if (!props.open) {
      setTop(null);
      return;
    }
    const measure = () => {
      const r = props.anchorRef.current?.getBoundingClientRect();
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
      onClick={props.closeOnClick ? props.onClose : undefined}
    >
      {props.children}
    </div>,
    document.body,
  );
}
