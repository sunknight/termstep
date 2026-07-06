// TermStep update checker (main process). Fetches a self-hosted JSON manifest,
// compares its version to app.getVersion(), and tracks a state that the renderer
// renders as a sidebar badge. No auto-download/install — clicking "去下载" opens
// the DMG url in the system browser (unsigned app, no Squirrel).
//
// All testable logic (semver compare, manifest parse) lives here as exported pure
// functions; the stateful check is a thin layer over them.

import type { UpdateState } from '../shared/types';

const MANIFEST_URL =
  process.env['TERMSTEP_UPDATE_URL'] ?? 'https://example.com/termstep/update.json';
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
