import { useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface TipState {
  text: string;
  left: number;
  top: number;
  bottom: number;
  below: boolean;
}

// Custom instant tooltip that matches the help-pane button tips (.cmd-tip):
// dark, monospace, fixed-position, appears above the element (or below when near
// the top of the viewport). Only fires when the wrapped content actually
// overflows (`scrollWidth > clientWidth`), so text that already fits doesn't pop
// a redundant tip.
export function HoverTip(props: { text: string; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [tip, setTip] = useState<TipState | null>(null);

  return (
    <>
      <span
        ref={ref}
        className={props.className}
        onMouseEnter={() => {
          const el = ref.current;
          if (!el) return;
          if (el.scrollWidth <= el.clientWidth) return; // fits -> no tip
          const r = el.getBoundingClientRect();
          setTip({
            text: props.text,
            left: r.left + r.width / 2,
            top: r.top,
            bottom: r.bottom,
            below: r.top < 50,
          });
        }}
        onMouseLeave={() => setTip(null)}
      >
        {props.children}
      </span>
      {tip &&
        createPortal(
          <div
            className="cmd-tip"
            style={
              tip.below
                ? { left: `${tip.left}px`, top: `${tip.bottom + 6}px`, transform: 'translate(-50%, 0)' }
                : { left: `${tip.left}px`, top: `${tip.top - 6}px`, transform: 'translate(-50%, -100%)' }
            }
          >
            {tip.text}
          </div>,
          document.body
        )}
    </>
  );
}
