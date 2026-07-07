import { useEffect, useState } from 'react';
import type { ScanResult } from '../../shared/types';
import { api } from '../lib/api';
import { useTauriEvent } from './useTauriEvent';

export function useTools(): ScanResult {
  const [result, setResult] = useState<ScanResult>({ tools: [], errors: [] });
  useTauriEvent<ScanResult>('tools:changed', setResult);
  useEffect(() => {
    api.tools.list().then(setResult);
  }, []);
  return result;
}
