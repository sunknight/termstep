// TermStep update checker (main process). Fetches a self-hosted JSON manifest,
// compares its version to app.getVersion(), and tracks a state that the renderer
// renders as a sidebar badge. No auto-download/install — clicking "去下载" opens
// the DMG url in the system browser (unsigned app, no Squirrel).
//
// All testable logic (semver compare, manifest parse) lives here as exported pure
// functions; the stateful check is a thin layer over them.

import type { UpdateState } from '../shared/types';
import fs from 'node:fs';
import path from 'node:path';
import { app, net } from 'electron';

const MANIFEST_URL = process.env['TERMSTEP_UPDATE_URL'] ?? 'https://plainraw.com/raw/87c5a6f119b5';
const FETCH_TIMEOUT_MS = 10_000;

// Compare two `X.Y.Z` version strings. Returns >0 if `remote > current`, 0 if
// equal, <0 if `remote < current`, or null if `remote` is not a valid `X.Y.Z`
// (each of X/Y/Z must be a non-negative integer). `current` is assumed valid
// (it comes from package.json); we still guard it defensively.
export function compareVersions(remote: string, current: string): number | null {
  const r = parseSemver(remote);
  const c = parseSemver(current);
  if (!r || !c) return null;
  for (let i = 0; i < 3; i++) {
    if (r[i] > c[i]) return 1;
    if (r[i] < c[i]) return -1;
  }
  return 0;
}

// Validated manifest shape. `parseManifest` returns this or null.
export interface ParsedManifest {
  version: string;
  url: string;
  notes: string;
}

// Parse and validate the remote manifest JSON. Returns null for any malformed
// payload (non-JSON, missing version/url, wrong types, empty version/url).
// notes defaults to "". We deliberately accept ONLY these three fields and
// ignore extras.
export function parseManifest(raw: string): ParsedManifest | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  const version = o['version'];
  const url = o['url'];
  const notes = o['notes'];
  if (typeof version !== 'string' || typeof url !== 'string') return null;
  if (version.length === 0 || url.length === 0) return null;
  return { version, url, notes: typeof notes === 'string' ? notes : '' };
}

// Parse "X.Y.Z" into [major, minor, patch] numbers, or null if malformed.
// Rejects: non-numeric, negative, missing segments, extra segments, leading
// zeros are allowed (0.03.0 == 0.3.0 numerically).
function parseSemver(v: string): [number, number, number] | null {
  if (typeof v !== 'string') return null;
  const parts = v.split('.');
  if (parts.length !== 3) return null;
  const nums: number[] = [];
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    nums.push(Number(p));
  }
  return [nums[0], nums[1], nums[2]];
}

// --- Stateful layer (main process only) ---
// Dedup store path: <userData>/update-state.json holds the last version we
// notified the user about, so a repeat launch with the same available version
// doesn't re-flag. Manual checks ignore this.
const STATE_FILE = () => path.join(app.getPath('userData'), 'update-state.json');

let state: UpdateState = { status: 'idle' };
let checking = false;
const listeners = new Set<(s: UpdateState) => void>();

// Read the "already notified" version from disk (if any). Used to suppress
// repeat auto-notifications for the same version across launches.
function readNotifiedVersion(): string | null {
  try {
    const raw = fs.readFileSync(STATE_FILE(), 'utf8');
    const obj = JSON.parse(raw) as { version?: unknown };
    return typeof obj.version === 'string' ? obj.version : null;
  } catch {
    return null;
  }
}

// Record that we've notified the user about `version`.
function writeNotifiedVersion(version: string): void {
  try {
    fs.writeFileSync(STATE_FILE(), JSON.stringify({ version }));
  } catch {
    // non-fatal — dedup is best-effort
  }
}

function setState(next: UpdateState): void {
  state = next;
  for (const cb of listeners) cb(state);
}

export function getUpdateState(): UpdateState {
  return state;
}

export function onUpdateState(cb: (s: UpdateState) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

// Fetch the manifest and update state. `manual=true` surfaces errors to the UI
// (user clicked "检查更新"); `manual=false` (auto check) fails silently.
// Guarded against re-entry (concurrent calls return current state).
export async function checkForUpdates(opts: { manual: boolean }): Promise<UpdateState> {
  if (checking) return state;
  checking = true;
  try {
    if (opts.manual) setState({ status: 'checking' });
    const raw = await fetchManifest(MANIFEST_URL);
    const manifest = parseManifest(raw);
    if (!manifest) {
      if (opts.manual) setState({ status: 'error', error: '更新信息格式无效' });
      // silent on auto — leave state as-is
      return state;
    }
    const cmp = compareVersions(manifest.version, app.getVersion());
    if (cmp === null) {
      if (opts.manual) setState({ status: 'error', error: '更新版本号格式无效' });
      return state;
    }
    if (cmp > 0) {
      // Dedup: an auto check for a version we already notified about stays idle.
      if (!opts.manual && readNotifiedVersion() === manifest.version) {
        return state;
      }
      setState({
        status: 'available',
        version: manifest.version,
        url: manifest.url,
        notes: manifest.notes,
      });
      writeNotifiedVersion(manifest.version);
    } else {
      if (opts.manual) setState({ status: 'upToDate' });
    }
    return state;
  } catch {
    if (opts.manual) setState({ status: 'error', error: '检查更新失败，请检查网络后重试' });
    return state;
  } finally {
    checking = false;
  }
}

// Fetch `url` with a 10s timeout, return its body text. Throws on non-2xx or
// network error. Uses Electron's `net` (respects system proxy settings).
function fetchManifest(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = net.request(url);
    const timer = setTimeout(() => {
      req.abort();
      reject(new Error('timeout'));
    }, FETCH_TIMEOUT_MS);
    req.on('response', (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        clearTimeout(timer);
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) resolve(body);
        else reject(new Error(`HTTP ${res.statusCode}`));
      });
    });
    req.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    req.end();
  });
}
