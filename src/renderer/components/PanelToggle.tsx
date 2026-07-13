import { useRef, type ReactNode } from 'react';
import { usePeek } from '../hooks/usePeek';
import { Peek } from './Peek';

interface PanelToggleProps {
  side: 'left' | 'right';
  collapsed: boolean;
  icon: string; // glyph shown when collapsed
  title: string; // used in the tooltip
  onToggle: () => void; // expand when collapsed, collapse when expanded
  peekContent: ReactNode; // floated when collapsed + hovered
  closePeekOnClick?: boolean; // sidebar: true; help: false
}

// Permanent header control for one side panel. Expanded -> chevron (click to
// collapse). Collapsed -> panel icon (click to re-dock, hover to peek).
export function PanelToggle(props: PanelToggleProps) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const peek = usePeek();
  const chevron = props.side === 'left' ? '‹' : '›';

  return (
    <>
      <button
        ref={btnRef}
        className={'panel-toggle ' + (props.side === 'left' ? 'pt-left' : 'pt-right')}
        title={props.collapsed ? `展开${props.title}` : `收起${props.title}`}
        onClick={() => {
          peek.close(); // a click is an explicit toggle: dismiss any open peek
          props.onToggle();
        }}
        {...(props.collapsed ? peek.triggerProps : {})}
      >
        {props.collapsed ? props.icon : chevron}
      </button>
      {props.collapsed && (
        <Peek
          open={peek.open}
          side={props.side}
          anchorRef={btnRef}
          contentProps={peek.contentProps}
          closeOnDown={props.closePeekOnClick}
          onClose={peek.close}
        >
          {props.peekContent}
        </Peek>
      )}
    </>
  );
}
