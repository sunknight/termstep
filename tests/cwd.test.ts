import { describe, it, expect } from 'vitest';
import process from 'node:process';
import { liveCwd } from '../src/main/cwd';

describe('liveCwd', () => {
  it('resolves an absolute cwd for the current process (macOS lsof / Linux /proc)', async () => {
    const c = await liveCwd(process.pid);
    expect(c).toBeTruthy();
    expect(c!.startsWith('/')).toBe(true);
  });

  it('returns null for an invalid / missing pid', async () => {
    expect(await liveCwd(undefined)).toBeNull();
    expect(await liveCwd(0)).toBeNull();
    expect(await liveCwd(-1)).toBeNull();
  });
});
