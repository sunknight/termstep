import chokidar from 'chokidar';
import { scanTools } from './toolsScanner';
import type { ScanResult, Tool } from '../shared/types';

const AUTO_TICK_MS = 30_000;

export class ToolManager {
  onChange: (r: ScanResult) => void = () => {};
  private watcher?: chokidar.FSWatcher;
  private timer?: NodeJS.Timeout;
  private autoTimer?: NodeJS.Timeout;
  // Most recent tool list + per-mdUrl-tool last-fetch time, so the auto-refresh
  // tick can decide whose interval has elapsed without re-scanning every tick.
  private lastTools: Tool[] = [];
  private lastFetched = new Map<string, number>();

  constructor(private toolsDir: string) {}

  scan(): Promise<ScanResult> {
    return scanTools(this.toolsDir);
  }

  async start(): Promise<void> {
    // Seed state up front: an initial scan so the auto-refresh tick has tools to
    // reason about even before any file change fires. (The renderer separately
    // pulls the same list via TOOLS_LIST.)
    await this.refresh();

    this.watcher = chokidar.watch(this.toolsDir, {
      ignoreInitial: true,
      depth: 2,
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
    });
    const fire = () => {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        void this.refresh();
      }, 200);
    };
    for (const ev of ['add', 'change', 'unlink', 'addDir', 'unlinkDir']) {
      this.watcher.on(ev, fire);
    }

    this.autoTimer = setInterval(() => void this.maybeAutoRefresh(), AUTO_TICK_MS);
  }

  // Force a re-scan now and broadcast. Used by chokidar (debounced), the manual
  // "re-read" button, and start(). Also keeps lastTools/lastFetched in sync.
  async refresh(): Promise<ScanResult> {
    const r = await scanTools(this.toolsDir);
    this.lastTools = r.tools;
    const now = Date.now();
    // Seed unseen mdUrl tools as "just fetched" so their first auto-refresh waits
    // a full interval rather than firing immediately.
    for (const t of r.tools) {
      if (t.meta.mdUrl && !this.lastFetched.has(t.meta.id)) this.lastFetched.set(t.meta.id, now);
    }
    this.onChange(r);
    return r;
  }

  // Every tick: if any mdUrl tool's autoUpdateMinutes has elapsed, re-scan.
  // Note: one scan re-fetches ALL mdUrl tools, so they effectively sync to the
  // shortest configured interval — acceptable for a local app with few remotes.
  private async maybeAutoRefresh(): Promise<void> {
    const now = Date.now();
    let due = false;
    for (const t of this.lastTools) {
      if (!t.meta.mdUrl) continue;
      const mins = t.meta.autoUpdateMinutes ?? 0;
      if (mins <= 0) continue;
      const last = this.lastFetched.get(t.meta.id);
      if (last !== undefined && now - last >= mins * 60_000) due = true;
    }
    if (due) await this.refresh();
  }

  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    if (this.autoTimer) clearInterval(this.autoTimer);
    await this.watcher?.close();
  }
}
