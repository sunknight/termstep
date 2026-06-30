import chokidar from 'chokidar';
import { scanTools } from './toolsScanner';
import type { ScanResult } from '../shared/types';

export class ToolManager {
  onChange: (r: ScanResult) => void = () => {};
  private watcher?: chokidar.FSWatcher;
  private timer?: NodeJS.Timeout;

  constructor(private toolsDir: string) {}

  scan(): Promise<ScanResult> {
    return scanTools(this.toolsDir);
  }

  start(): void {
    this.watcher = chokidar.watch(this.toolsDir, {
      ignoreInitial: true,
      depth: 2,
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
    });
    const fire = () => {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(async () => {
        this.onChange(await scanTools(this.toolsDir));
      }, 200);
    };
    for (const ev of ['add', 'change', 'unlink', 'addDir', 'unlinkDir']) {
      this.watcher.on(ev, fire);
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    await this.watcher?.close();
  }
}
