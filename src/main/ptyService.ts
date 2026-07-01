import * as pty from 'node-pty';
import os from 'node:os';
import path from 'node:path';
import type { PtySpawnOpts } from '../shared/types';
import { sanitizeTmuxName, tmuxArgv } from '../shared/tmux';

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
    // GUI-launched (packaged) apps inherit no UTF-8 locale, so BSD `ls` prints '?'
    // for non-ASCII filenames (e.g. Chinese). Fall back to a UTF-8 locale when
    // unset (only when unset, so a user-set locale in dev/tool env is preserved).
    if (!env['LANG']) env['LANG'] = 'en_US.UTF-8';
    if (!env['LC_CTYPE']) env['LC_CTYPE'] = 'en_US.UTF-8';
    // Advertise color capability: xterm.js renders 256-color and truecolor, but
    // node-pty defaults TERM to the limited `xterm-color` and COLORTERM is unset
    // in GUI launches — so tools dim down to mono. `name` below sets TERM.
    if (!env['COLORTERM']) env['COLORTERM'] = 'truecolor';
    // tmux: when a sanitized session name is configured, exec into
    // `tmux new -A -s NAME` (attach if it exists, else create). An invalid name
    // is silently ignored so a bad tool.json never bricks spawning.
    const tmuxName = opts.tmux ? sanitizeTmuxName(opts.tmux) : null;
    // Always spawn a LOGIN shell (`-l`). GUI-launched (packaged) apps inherit a
    // minimal launchd PATH (e.g. /usr/bin:/bin) that lacks Homebrew's
    // /opt/homebrew/bin — which ~/.zprofile adds. Without `-l` the profile isn't
    // sourced and commands like tmux/brew are "not found" in the packaged app.
    // (Dev worked only because it inherited the launching terminal's PATH.) `-l`
    // before the optional `-c exec tmux ...` keeps the tmux path working too.
    const args = ['-l', ...(tmuxName ? tmuxArgv(tmuxName) : [])];
    const d = this.desired.get(toolId);
    const p = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols: d?.cols ?? 80,
      rows: d?.rows ?? 24,
      cwd,
      env,
    });
    p.onData((data) => {
      for (const cb of this.listeners) cb(toolId, data);
    });
    // When the shell exits (e.g. user runs `exit'), drop it so the next open/write
    // spawns a fresh shell. Guard with identity: restart swaps in a new pty, and the
    // old pty's late onExit must not evict the new one or reset the terminal size.
    p.onExit(() => {
      if (this.ptys.get(toolId) === p) {
        this.ptys.delete(toolId);
      }
    });
    this.ptys.set(toolId, p);
    // Inject startup init commands. The pty buffers input until the shell (or
    // tmux, when used) is ready to read, so no delay is needed — they appear as
    // if typed at the first prompt.
    if (opts.initCommands && opts.initCommands.length > 0) {
      const batch = opts.initCommands.map((c) => c + '\r').join('');
      try {
        p.write(batch);
      } catch {
        // pty closed before we could write — ignore; ensure already registered it.
      }
    }
    return p;
  }

  write(toolId: string, data: string, opts: PtySpawnOpts): void {
    this.ensure(toolId, opts).write(data);
  }

  // Eagerly spawn the shell for a tool so its prompt appears without waiting for
  // the first keystroke. No-op if already spawned.
  open(toolId: string, opts: PtySpawnOpts): void {
    this.ensure(toolId, opts);
  }

  // Kill the current shell (if any) and spawn a fresh one. Used by the restart
  // button to recover after the shell exits.
  restart(toolId: string, opts: PtySpawnOpts): void {
    this.kill(toolId);
    this.ensure(toolId, opts);
  }

  resize(toolId: string, cols: number, rows: number): void {
    this.desired.set(toolId, { cols, rows });
    this.ptys.get(toolId)?.resize(cols, rows);
  }

  // OS pid of the spawned shell (if alive). Used to look up its live cwd.
  pidOf(toolId: string): number | undefined {
    return this.ptys.get(toolId)?.pid;
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
