import * as pty from 'node-pty';
import os from 'node:os';
import path from 'node:path';
import type { PtySpawnOpts } from '../shared/types';

function defaultShell(): string {
  return process.env['SHELL'] || '/bin/zsh';
}

function expandHome(p?: string): string | undefined {
  if (!p) return undefined;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

export class PtyService {
  private ptys = new Map<string, pty.IPty>();
  private desired = new Map<string, { cols: number; rows: number }>();
  private listeners = new Set<(toolId: string, data: string) => void>();

  onData(cb: (toolId: string, data: string) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  private ensure(toolId: string, opts: PtySpawnOpts): pty.IPty {
    const existing = this.ptys.get(toolId);
    if (existing) return existing;
    const shell = opts.shell || defaultShell();
    const cwd = expandHome(opts.cwd) ?? os.homedir();
    const env = { ...process.env, ...(opts.env ?? {}) } as Record<string, string>;
    const d = this.desired.get(toolId);
    const p = pty.spawn(shell, [], {
      name: 'xterm-color',
      cols: d?.cols ?? 80,
      rows: d?.rows ?? 24,
      cwd,
      env,
    });
    p.onData((data) => {
      for (const cb of this.listeners) cb(toolId, data);
    });
    this.ptys.set(toolId, p);
    return p;
  }

  write(toolId: string, data: string, opts: PtySpawnOpts): void {
    this.ensure(toolId, opts).write(data);
  }

  resize(toolId: string, cols: number, rows: number): void {
    this.desired.set(toolId, { cols, rows });
    this.ptys.get(toolId)?.resize(cols, rows);
  }

  kill(toolId: string): void {
    const p = this.ptys.get(toolId);
    if (p) {
      try {
        p.kill();
      } catch {
        // already dead
      }
      this.ptys.delete(toolId);
    }
  }

  killAll(): void {
    for (const p of this.ptys.values()) {
      try {
        p.kill();
      } catch {
        // ignore
      }
    }
    this.ptys.clear();
    this.desired.clear();
  }
}
