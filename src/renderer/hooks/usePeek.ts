import { useCallback, useEffect, useRef, useState } from 'react';
import { PeekController } from '../../shared/peekController';

interface HoverProps {
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}

export interface UsePeekResult {
  open: boolean;
  triggerProps: HoverProps;
  contentProps: HoverProps;
  close: () => void;
}

// Adapts the pure PeekController to React: mouse events on the toggle button
// (triggerProps) and on the floating panel (contentProps) both drive the same
// controller, so moving the pointer from the toggle into the panel does not snap
// the panel shut (the close-delay grace period covers the transit). Esc closes.
export function usePeek(opts: { openDelay?: number; closeDelay?: number } = {}): UsePeekResult {
  const [open, setOpen] = useState(false);
  const ctrlRef = useRef<PeekController | null>(null);
  if (ctrlRef.current === null) {
    ctrlRef.current = new PeekController({
      openDelay: opts.openDelay,
      closeDelay: opts.closeDelay,
      onChange: setOpen, // setState identity is stable for the controller's lifetime
    });
  }

  // Cancel any pending timer on unmount.
  useEffect(() => {
    const ctrl = ctrlRef.current;
    return () => ctrl?.dispose();
  }, []);

  // Esc closes the peek while it is open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') ctrlRef.current?.closeNow();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const triggerProps: HoverProps = {
    onMouseEnter: () => ctrlRef.current?.enter(),
    onMouseLeave: () => ctrlRef.current?.leave(),
  };
  const contentProps: HoverProps = {
    onMouseEnter: () => ctrlRef.current?.enter(),
    onMouseLeave: () => ctrlRef.current?.leave(),
  };
  const close = useCallback(() => ctrlRef.current?.closeNow(), []);

  return { open, triggerProps, contentProps, close };
}
