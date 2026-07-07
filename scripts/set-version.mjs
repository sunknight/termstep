#!/usr/bin/env node
// 同步设置整个项目的版本号。涉及的文件各用不同格式，逐一精确改：
//   - package.json          : "version": "x.y.z"
//   - src-tauri/Cargo.toml  : version = "x.y.z"   （package 段，首处）
//   - src-tauri/tauri.conf.json : "version": "x.y.z"
//   - src-tauri/Cargo.lock  : name = "termstep" 紧随的 version = "..."
//
// 用法：
//   node scripts/set-version.mjs <version> [--dry-run]
//   npm run version:set -- <version> [--dry-run]
//
// Cargo.lock 只改 termstep 包那一处——文件里有大量无关 crate 的 version 行
// （如 serde 1.x、tauri 2.x），绝不能用全局替换误伤。改成 termstep 那条是
// `cargo update -p termstep` 的等价手写，避免脚本依赖 cargo 可执行文件。

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const files = {
  'package.json': join(root, 'package.json'),
  'src-tauri/Cargo.toml': join(root, 'src-tauri/Cargo.toml'),
  'src-tauri/tauri.conf.json': join(root, 'src-tauri/tauri.conf.json'),
  'src-tauri/Cargo.lock': join(root, 'src-tauri/Cargo.lock'),
};

// 语义化版本：X.Y.Z 或 X.Y.Z-pre（含预发布标签）。拒收 v 前缀和非法字符。
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const version = argv.find((a) => !a.startsWith('--'));

if (!version) {
  console.error('用法: node scripts/set-version.mjs <version> [--dry-run]');
  console.error('示例: node scripts/set-version.mjs 0.8.0');
  process.exit(1);
}
if (!SEMVER_RE.test(version)) {
  console.error(`非法版本号: "${version}"（应为 X.Y.Z 或 X.Y.Z-pre，不带 v 前缀）`);
  process.exit(1);
}

const changes = [];

// 读出当前版本号（用于 before/after 对比 + 同值时提示无变化）。
function readCurrent(label, content, matcher) {
  const m = content.match(matcher);
  if (!m) return null;
  return m[1];
}

// ── package.json / tauri.conf.json：JSON，保留缩进重写 ──────────────────────
// 用 JSON.parse + stringify 会丢注释/改格式，这两个文件正好是纯 JSON（无注释），
// 可以安全重新序列化。缩进保留各自原样（package.json 2 空格，tauri.conf.json 2 空格）。
function setJsonVersion(relPath, key = 'version') {
  const abs = files[relPath];
  const raw = readFileSync(abs, 'utf8');
  const json = JSON.parse(raw);
  const before = json[key];
  if (before === version) {
    changes.push({ file: relPath, before, after: version, noop: true });
    return;
  }
  changes.push({ file: relPath, before, after: version });
  if (!dryRun) {
    json[key] = version;
    // 探测原缩进（首行非空白处的空格数），尽量保持原格式。
    const indentMatch = raw.match(/^\n*(\s+)"/);
    const indent = indentMatch ? indentMatch[1] : '  ';
    writeFileSync(abs, JSON.stringify(json, null, indent) + '\n');
  }
}

// ── Cargo.toml：只改 [package] 段的 version（首处 `version = "..."`）────────
// Cargo.toml 的 version = "..." 只在 [package] 出现一次（依赖用 name/version 分行，
// 但形式不同）。用行级替换，只换第一个匹配，避免动到 [dependencies] 区。
function setCargoTomlVersion() {
  const relPath = 'src-tauri/Cargo.toml';
  const abs = files[relPath];
  const raw = readFileSync(abs, 'utf8');
  // 匹配行首的 version = "..."（package 段第一行就是它）。
  const re = /^version\s*=\s*"([^"]+)"/m;
  const m = raw.match(re);
  const before = m ? m[1] : null;
  if (before === version) {
    changes.push({ file: relPath, before, after: version, noop: true });
    return;
  }
  changes.push({ file: relPath, before, after: version });
  if (!dryRun) {
    // 只替换第一处，用回调计数。
    let replaced = false;
    const next = raw.replace(re, (line, _old) => {
      if (replaced) return line;
      replaced = true;
      return `version = "${version}"`;
    });
    writeFileSync(abs, next);
  }
}

// ── Cargo.lock：只改 name = "termstep" 紧随的 version = "..." ───────────────
// Cargo.lock 含上百个无关 crate 的 version 行，必须定位 termstep 包再改它的下一行。
function setCargoLockVersion() {
  const relPath = 'src-tauri/Cargo.lock';
  const abs = files[relPath];
  const raw = readFileSync(abs, 'utf8');
  // 匹配 `name = "termstep"\nversion = "..."` 这一对。
  const re = /(^name = "termstep"\nversion = ")([^"]+)"/m;
  const m = raw.match(re);
  const before = m ? m[2] : null;
  if (before === version) {
    changes.push({ file: relPath, before, after: version, noop: true });
    return;
  }
  changes.push({ file: relPath, before, after: version });
  if (!dryRun) {
    const next = raw.replace(re, `$1${version}"`);
    writeFileSync(abs, next);
  }
}

setJsonVersion('package.json');
setCargoTomlVersion();
setJsonVersion('src-tauri/tauri.conf.json');
setCargoLockVersion();

// ── 输出 ────────────────────────────────────────────────────────────────────
const tag = dryRun ? '[dry-run] ' : '';
console.log(`\n${tag}设置版本号 → ${version}\n`);
const maxFile = Math.max(...changes.map((c) => c.file.length));
for (const c of changes) {
  const before = c.before ?? '(缺失)';
  const pad = ' '.repeat(maxFile - c.file.length);
  if (c.noop) {
    console.log(`  ${c.file}${pad}  ${before}  (已是该版本，跳过)`);
  } else {
    console.log(`  ${c.file}${pad}  ${before}  →  ${c.after}`);
  }
}
const missing = changes.filter((c) => c.before === null);
if (missing.length) {
  console.error(`\n⚠ 未能匹配到版本号的文件：${missing.map((m) => m.file).join(', ')}`);
  process.exit(1);
}
console.log(dryRun ? '\n（dry-run，未写盘）\n' : '\n完成。\n');
