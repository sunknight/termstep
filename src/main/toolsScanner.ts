import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import type { ScanResult, Tool } from '../shared/types';
import { parseToolMeta } from '../shared/toolConfig';

export const DEFAULT_AUTO_UPDATE_MINUTES = 0;

// Is the URL a local file reference (absolute path or file:// URL) rather than
// something fetch() can handle natively (http/https/data)? Bare relative paths
// are treated as local too: resolved against cwd, which for the editor's picker
// is always an absolute path anyway.
function isLocalPath(url: string): boolean {
  if (url.startsWith('file://')) return true;
  // `data:`/`http:`/`https:` go through fetch(); everything else is a path.
  return !/^[a-z][a-z0-9+.-]*:/i.test(url);
}

// --- Sensitive-path guard for local mdUrl subscriptions ---------------------
// A tool.json's mdUrl now reads arbitrary local files. That's fine when the
// user picks a file themselves, but a SHARED/IMPORTED tool.json could quietly
// point at credentials (e.g. mdUrl: "~/.ssh/id_rsa"). The content only renders
// locally (never leaves the machine), but rendering private keys into the help
// pane is still worth blocking as defense-in-depth. So before reading a local
// path we reject ones that look like sensitive locations.
//
// Two checks, both substring-based on the resolved absolute path (cheap, no
// stat calls, no fs walk):
//   1. Directory denylist — well-known macOS credential stores (ssh keys, AWS,
//      kube, gcloud, Docker, Keychain, etc.).
//   2. Filename denylist — generic credential-ish names anywhere on the path
//      (.env*, .netrc, .npmrc, id_rsa*, credentials, *.key, *.pem, …).
// Conservative on purpose: false positives just tell the user to pick a less
// sensitive-named file; the cost of a miss is leaking secrets into the UI.
const SENSITIVE_DIR_SEGMENTS = [
  '.ssh',           // SSH private keys / known_hosts
  '.aws',           // AWS CLI credentials/config
  '.kube',          // Kubernetes kubeconfig + tokens
  '.docker',        // Docker config (registry tokens)
  '.config/gcloud', // gcloud credentials
  '.gnupg',         // GPG keyring
  'Library/Keychains',        // macOS Keychain files
  'Library/Cookies',          // browser/Keychain cookies
  '.password-store',          // pass (gpg) store
];

const SENSITIVE_FILE_PATTERNS: RegExp[] = [
  /^\.env(\..*)?$/i,   // .env, .env.local, .env.production, …
  /^\.netrc$/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
  /^\.my\.cnf$/i,      // MySQL credentials
  /^id_[a-z0-9]+$/i,   // id_rsa, id_ed25519, id_ecdsa, … (pubkey id_*.pub also caught)
  /^_netrc$/i,
  /^credentials(\..*)?$/i, // credentials, credentials.json, …
  /^.*\.key$/i,        // private key files
  /^.*\.pem$/i,        // PEM (keys/certs)
  /^.*\.pfx$/i,
  /^.*\.keystore$/i,
];

// Returns a human-readable reason if the path is sensitive, else null.
function sensitivePathReason(p: string): string | null {
  // Normalize to forward-slash POSIX form and expand a leading ~ once.
  let abs = p.replace(/\\/g, '/');
  if (abs.startsWith('~/')) abs = path.join(os.homedir(), abs.slice(2));
  const lower = abs.toLowerCase();
  for (const seg of SENSITIVE_DIR_SEGMENTS) {
    const s = seg.toLowerCase();
    if (lower.includes('/' + s + '/') || lower.endsWith('/' + s)) {
      return `路径位于敏感目录 (/${seg}/)`;
    }
  }
  const base = lower.split('/').pop() ?? '';
  for (const re of SENSITIVE_FILE_PATTERNS) {
    if (re.test(base)) return `文件名疑似凭据文件 (${base})`;
  }
  return null;
}

// Fetch a (remote OR local) help.md. http(s)/data: URLs go through fetch();
// any other string — an absolute path or a file:// URL — is read from disk with
// fs. Returns {markdown, error}; on failure markdown is '' so a broken source
// degrades to an empty (but still present) copy rather than crashing the scan.
// Exported so the editor's "重新读取" can preview-fetch a draft URL before save.
export async function fetchRemoteMarkdown(url: string): Promise<{ markdown: string; error?: string }> {
  // Local file: read from disk. Covers absolute paths and file:// URLs.
  if (isLocalPath(url)) {
    try {
      const p = url.startsWith('file://') ? fileURLToPath(url) : url;
      const reason = sensitivePathReason(p);
      if (reason) {
        // Never read — refuse before any fs access.
        return { markdown: '', error: `拒绝读取敏感文件: ${reason}` };
      }
      const text = await fs.readFile(p, 'utf8');
      return { markdown: text };
    } catch (e) {
      return { markdown: '', error: (e as Error).message };
    }
  }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return { markdown: '', error: `HTTP ${res.status}` };
    const text = await res.text();
    return { markdown: text };
  } catch (e) {
    return { markdown: '', error: (e as Error).message };
  }
}

export async function scanTools(toolsDir: string): Promise<ScanResult> {
  const result: ScanResult = { tools: [], errors: [] };
  let entries: string[];
  try {
    entries = await fs.readdir(toolsDir);
  } catch {
    return result; // dir missing -> empty
  }
  for (const entry of entries) {
    const child = path.join(toolsDir, entry);
    let stat;
    try {
      stat = await fs.stat(child);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    const id = entry;
    const toolJsonPath = path.join(child, 'tool.json');
    let metaRaw: unknown;
    try {
      await fs.access(toolJsonPath);
      metaRaw = JSON.parse(await fs.readFile(toolJsonPath, 'utf8'));
    } catch (e) {
      // present-but-unparseable -> skip + report; missing -> defaults
      if (await exists(toolJsonPath)) {
        result.errors.push({ id, message: `tool.json 解析失败: ${(e as Error).message}` });
        continue;
      }
      metaRaw = {};
    }
    const meta = parseToolMeta(metaRaw, id);

    // Local help.md is always read — it is the editable source of truth and is
    // never overwritten by a remote subscription.
    let helpMarkdown = '';
    try {
      helpMarkdown = await fs.readFile(path.join(child, 'help.md'), 'utf8');
    } catch {
      // missing help -> empty
    }

    // A configured mdUrl adds a SEPARATE read-only remote copy (fetched). It does
    // not replace helpMarkdown, so clearing the URL later restores the local
    // content untouched.
    let remoteMarkdown: string | undefined;
    if (meta.mdUrl) {
      if (meta.autoUpdateMinutes === undefined) {
        meta.autoUpdateMinutes = DEFAULT_AUTO_UPDATE_MINUTES;
      }
      const fetched = await fetchRemoteMarkdown(meta.mdUrl);
      remoteMarkdown = fetched.markdown;
      if (fetched.error) {
        result.errors.push({ id, message: `远程帮助加载失败 (${meta.mdUrl}): ${fetched.error}` });
      }
    }
    result.tools.push({ meta, helpMarkdown, ...(remoteMarkdown !== undefined ? { remoteMarkdown } : {}) });
  }
  result.tools.sort(
    (a, b) => a.meta.order - b.meta.order || a.meta.id.localeCompare(b.meta.id)
  );
  return result;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
