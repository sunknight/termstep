import { useEffect, useState } from 'react';
import type { ScanResult } from '../../shared/types';

export function useTools(): ScanResult {
  const [result, setResult] = useState<ScanResult>({ tools: [], errors: [] });
  useEffect(() => {
    window.api.tools.list().then(setResult);
    return window.api.tools.onChanged(setResult);
  }, []);
  return result;
}
