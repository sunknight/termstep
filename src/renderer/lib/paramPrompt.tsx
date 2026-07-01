import { useCallback, useRef, useState, type ReactNode } from 'react';
import type { ButtonParam } from '../../shared/buttonBlock';
import { ParamPromptModal } from '../components/ParamPromptModal';

export interface ParamPromptSpec {
  command: string; // template containing {{name}}
  edit: boolean;
  params: ButtonParam[];
}

type Resolve = (values: Record<string, string> | null) => void;

// Shared hook: each consumer (HelpPane, QuickCommands) calls this once and
// renders {node} at the end of its JSX. `open` stores the resolve callback in
// a ref and calls it from `close` OUTSIDE any setState updater, so React 18
// StrictMode's double-invocation of updaters can't fire the command twice.
export function useParamPrompt(): { open: (spec: ParamPromptSpec, resolve: Resolve) => void; node: ReactNode } {
  const [spec, setSpec] = useState<ParamPromptSpec | null>(null);
  const resolveRef = useRef<Resolve | null>(null);

  const open = useCallback((s: ParamPromptSpec, resolve: Resolve) => {
    resolveRef.current = resolve;
    setSpec(s);
  }, []);

  const close = useCallback((values: Record<string, string> | null) => {
    const r = resolveRef.current;
    resolveRef.current = null;
    setSpec(null);
    r?.(values);
  }, []);

  const node: ReactNode = spec ? <ParamPromptModal spec={spec} onClose={close} /> : null;
  return { open, node };
}
