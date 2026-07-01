import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';

// macOS has no /proc; ask lsof for the process's cwd. Returns null if lsof is
// missing or the pid is gone.
function lsofCwd(pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], (err, stdout) => {
      if (err) return resolve(null);
      // The line starting with 'n' carries the cwd path.
      const line = stdout.split('\n').find((l) => l.startsWith('n'));
      resolve(line && line.length > 1 ? line.slice(1) : null);
    });
  });
}

// Resolve the live cwd of a process — `/proc/<pid>/cwd` on Linux, lsof on macOS.
// Returns null when there's nothing to report (bad pid, gone, or unreadable).
export async function liveCwd(pid: number | undefined): Promise<string | null> {
  if (!pid || pid <= 0) return null;
  try {
    const link = await fs.readlink(`/proc/${pid}/cwd`);
    if (link) return link;
  } catch {
    // not linux, or unreadable — fall through to lsof
  }
  return lsofCwd(pid);
}
