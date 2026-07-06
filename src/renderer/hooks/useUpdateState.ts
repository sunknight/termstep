import { useEffect, useState } from 'react';
import type { UpdateState } from '../../shared/types';

// Subscribe to update-check state from the main process. Initial value is idle;
// main pushes the real current state shortly after window load (see
// index.ts browser-window-created / did-finish-load broadcast). Only `available`
// renders the sidebar badge; manual-check results surface transiently.
export function useUpdateState(): UpdateState {
  const [state, setState] = useState<UpdateState>({ status: 'idle' });
  useEffect(() => window.api.update.onState(setState), []);
  return state;
}
