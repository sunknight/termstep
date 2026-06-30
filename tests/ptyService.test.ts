// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import { PtyService } from '../src/main/ptyService';

describe('PtyService', () => {
  let svc: PtyService;
  afterEach(() => svc?.killAll());

  it('spawns a shell and streams output for a command', async () => {
    svc = new PtyService();
    const seen: string[] = [];
    svc.onData((_id, data) => seen.push(data));
    svc.write('t1', 'echo hello_cmdgui\r\n', {});
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout')), 8000);
      const check = setInterval(() => {
        if (seen.join('').includes('hello_cmdgui')) {
          clearTimeout(t);
          clearInterval(check);
          resolve();
        }
      }, 100);
    });
    expect(seen.join('').includes('hello_cmdgui')).toBe(true);
  }, 10000);

  it('kill removes the pty', () => {
    svc = new PtyService();
    svc.write('t2', '', {});
    svc.kill('t2');
    // no throw; writing again spawns a fresh one
    svc.write('t2', '', {});
  });
});
