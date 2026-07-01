// Detects commands that are destructive enough to warrant a confirm dialog
// before blind-injecting them into a live shell. Conservative: only flags the
// system-destroying cases (rm -rf on root/home, mkfs, dd to a device, fork bomb,
// shutdown, piping a remote download into a shell). Routine `rm -rf ./build`
// is left alone — the app's whole point is running dev commands frictionlessly.
export interface DangerVerdict {
  dangerous: boolean;
  reason?: string;
}

const PIPE_TO_SHELL = /\|\s*(sh|bash|zsh|fish|python\d*|perl|ruby|node|nc|ncat|netcat)\b/i;
const NET_FETCHERS = /\b(curl|wget|fetch)\b/i;

function tokenize(s: string): string[] {
  return s.trim().split(/\s+/).filter(Boolean);
}

function hasLong(tokens: string[], name: string): boolean {
  return tokens.includes('--' + name);
}

// Short-flag block like -rf / -irf / -Rf containing the given letters.
function shortHas(tokens: string[], ...letters: string[]): boolean {
  return tokens.some((t) => {
    if (!t.startsWith('-') || t.startsWith('--')) return false;
    return letters.every((l) => t.slice(1).toLowerCase().includes(l));
  });
}

// After `rm` and its flags, do the path arguments target something root-ish?
function rmTargetsRoot(c: string): boolean {
  const m = c.match(/\brm\b(.*)/i);
  if (!m) return false;
  const paths = tokenize(m[1]).filter((t) => !t.startsWith('-') && !t.includes('='));
  if (paths.length === 0) return true; // `rm -rf` with no target is itself alarming
  const scary = ['/', '/*', '.', '..', '*', '~', '~/', '~/*', '$HOME', '$HOME/', '$HOME/*'];
  return paths.some((p) => scary.includes(p) || /^\/+$/.test(p) || /^\.\.+\/?$/.test(p));
}

export function isDangerousCommand(input: string): DangerVerdict {
  const c = input.replace(/\s+/g, ' ').trim();
  if (!c) return { dangerous: false };

  if (/:\s*\(\)\s*\{/.test(c)) return { dangerous: true, reason: 'fork bomb' };
  if (/\bmkfs\b/i.test(c)) return { dangerous: true, reason: 'mkfs — 格式化磁盘' };
  if (/\bdd\b/i.test(c) && /of=\/dev\//i.test(c)) return { dangerous: true, reason: 'dd 写入块设备' };
  if (/>\s*\/dev\/(sd|nvme|disk|hd|rdisk)/i.test(c)) {
    return { dangerous: true, reason: '重定向写入块设备' };
  }
  if (/\b(shutdown|reboot|halt|poweroff)\b/i.test(c)) {
    return { dangerous: true, reason: '关机/重启' };
  }
  if (/\binit\s+0\b/i.test(c)) return { dangerous: true, reason: '关机 (init 0)' };

  if (/\brm\b/i.test(c)) {
    const tokens = tokenize(c);
    const hasR = shortHas(tokens, 'r') || hasLong(tokens, 'recursive');
    const hasF = shortHas(tokens, 'f') || hasLong(tokens, 'force');
    if (hasR && hasF && rmTargetsRoot(c)) {
      return { dangerous: true, reason: 'rm -rf 删除根/家目录' };
    }
  }

  // curl/wget ... | sh — remote code execution.
  if (PIPE_TO_SHELL.test(c) && NET_FETCHERS.test(c)) {
    return { dangerous: true, reason: '管道执行远程脚本' };
  }

  return { dangerous: false };
}
