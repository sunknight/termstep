import { useState } from 'react';
import type { UpdateState } from '../../shared/types';
import { useTauriEvent } from './useTauriEvent';

// Subscribe to update-check state from the Rust backend. Initial value is idle;
// backend pushes the real current state shortly after window load (emit on
// check). Only `available` renders the sidebar badge; manual-check results
// surface transiently.
export function useUpdateState(): UpdateState {
  const [state, setState] = useState<UpdateState>({ status: 'idle' });
  useTauriEvent<UpdateState>('update:state', setState);
  return state;
}
