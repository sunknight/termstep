// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PtyService } from '../src/main/ptyService';
import { liveCwd } from '../src/main/cwd';

describe('PtyService', () => {
  let svc: PtyService;
  afterEach(() => svc?.killAll());

  it('spawns a shell and streams output for a command', async () => {
    svc = new PtyService();
    const seen: string[] = [];
    svc.onData((_id, data) => seen.push(data));
    svc.write('t1', 'echo hello_termstep\r\n', {});
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout')), 8000);
      const check = setInterval(() => {
        if (seen.join('').includes('hello_termstep')) {
          clearTimeout(t);
          clearInterval(check);
          resolve();
        }
      }, 100);
    });
    expect(seen.join('').includes('hello_termstep')).toBe(true);
  }, 10000);

  it('kill removes the pty', () => {
    svc = new PtyService();
    svc.write('t2', '', {});
    svc.kill('t2');
    // no throw; writing again spawns a fresh one
    svc.write('t2', '', {});
  });

  it('open spawns a shell and emits output with no input (prompt shows without Enter)', async () => {
    svc = new PtyService();
    const seen: string[] = [];
    svc.onData((_id, data) => seen.push(data));
    svc.open('t3', {}); // no write / no keystroke
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout: no output emitted after open')), 8000);
      const check = setInterval(() => {
        if (seen.join('').length > 0) {
          clearTimeout(t);
          clearInterval(check);
          resolve();
        }
      }, 100);
    });
    expect(seen.join('').length).toBeGreaterThan(0);
  }, 10000);

  it('restart keeps the resized terminal size (no shrink to 80x24)', async () => {
    svc = new PtyService();
    const seen: string[] = [];
    svc.onData((_id, data) => seen.push(data));
    svc.resize('t4', 120, 40);
    svc.open('t4', {});
    await new Promise<void>((r) => setTimeout(r, 400)); // let the prompt settle
    seen.length = 0;
    svc.restart('t4', {});
    await new Promise<void>((r) => setTimeout(r, 400)); // let the respawned prompt settle
    seen.length = 0;
    svc.write('t4', 'tput cols\r', {});
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout: tput cols never reported 120')), 8000);
      const check = setInterval(() => {
        if (seen.join('').includes('120')) {
          clearTimeout(t);
          clearInterval(check);
          resolve();
        }
      }, 100);
    });
    // If restart shrank the pty to the 80x24 default, tput cols would print 80.
    expect(seen.join('')).toContain('120');
  }, 12000);

  it('spawns the shell in the configured cwd on first open', async () => {
    svc = new PtyService();
    const target = path.join(os.homedir(), 'gui-cwd-test-tmp');
    fs.mkdirSync(target, { recursive: true });
    try {
      const seen: string[] = [];
      svc.onData((_id, data) => seen.push(data));
      svc.open('cwdt', { cwd: target });
      await new Promise<void>((r) => setTimeout(r, 400)); // let the prompt settle
      seen.length = 0;
      svc.write('cwdt', 'pwd\r', {});
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(
          () => reject(new Error('timeout: pwd never reported ' + target)),
          8000,
        );
        const check = setInterval(() => {
          if (seen.join('').includes(target)) {
            clearTimeout(t);
            clearInterval(check);
            resolve();
          }
        }, 100);
      });
      expect(seen.join('')).toContain(target);
    } finally {
      fs.rmSync(target, { recursive: true, force: true });
    }
  }, 12000);

  it('restart respawns the shell in the configured cwd', async () => {
    svc = new PtyService();
    const target = path.join(os.homedir(), 'gui-cwd-restart-tmp');
    fs.mkdirSync(target, { recursive: true });
    try {
      const seen: string[] = [];
      svc.onData((_id, data) => seen.push(data));
      svc.open('rcwd', { cwd: target });
      await new Promise<void>((r) => setTimeout(r, 400));
      svc.restart('rcwd', { cwd: target });
      await new Promise<void>((r) => setTimeout(r, 400)); // let the respawned prompt settle
      seen.length = 0;
      svc.write('rcwd', 'pwd\r', {});
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(
          () => reject(new Error('timeout: pwd never reported ' + target)),
          8000,
        );
        const check = setInterval(() => {
          if (seen.join('').includes(target)) {
            clearTimeout(t);
            clearInterval(check);
            resolve();
          }
        }, 100);
      });
      expect(seen.join('')).toContain(target);
    } finally {
      fs.rmSync(target, { recursive: true, force: true });
    }
  }, 12000);

  it('injects initCommands right after spawn (they run without a manual write)', async () => {
    svc = new PtyService();
    const seen: string[] = [];
    svc.onData((_id, data) => seen.push(data));
    // open() with initCommands — no subsequent write; the marker must appear on its own.
    svc.open('init', { initCommands: ['echo init_marker_xyz789'] });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout: init command never ran')), 8000);
      const check = setInterval(() => {
        if (seen.join('').includes('init_marker_xyz789')) {
          clearTimeout(t);
          clearInterval(check);
          resolve();
        }
      }, 100);
    });
    expect(seen.join('')).toContain('init_marker_xyz789');
  }, 10000);

  it('pidOf + liveCwd track the shell cwd after the user cd-s', async () => {
    svc = new PtyService();
    const target = path.join(os.homedir(), 'gui-cwd-track-tmp');
    fs.mkdirSync(target, { recursive: true });
    try {
      svc.open('track', { cwd: os.homedir() });
      await new Promise<void>((r) => setTimeout(r, 500)); // let the prompt settle
      svc.write('track', `cd ${JSON.stringify(target)}\r`, {});
      // Poll liveCwd until it reflects the new cwd (cd + OS accounting).
      const pid = svc.pidOf('track');
      expect(pid).toBeTruthy();
      const resolved = await new Promise<string | null>((resolve) => {
        const t = setTimeout(() => resolve(null), 8000);
        const check = setInterval(async () => {
          const c = await liveCwd(pid);
          if (c === target) {
            clearTimeout(t);
            clearInterval(check);
            resolve(c);
          }
        }, 200);
      });
      expect(resolved).toBe(target);
    } finally {
      fs.rmSync(target, { recursive: true, force: true });
    }
  }, 12000);
});
