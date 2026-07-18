#!/usr/bin/env node
// 同步设置整个项目的版本号。涉及的文件各用不同格式，逐一精确改：
//   - package.json             : "version": "x.y.z"
//   - src-tauri/Cargo.toml     : version = "x.y.z"   （package 段，首处）
//   - src-tauri/tauri.conf.json: "version": "x.y.z"
//   - src-tauri/Cargo.lock     : name = "termstep" 紧随的 version = "..."
//   - CHANGELOG.md             : 顶部自动插入新版本条目（从 git log 提取并分类）
//
// 用法：
//   node scripts/set-version.mjs <version> [--dry-run] [--tag]
//   npm run version:set -- <version> [--dry-run] [--tag]
//
// --tag：在上述改动基础上，git add 版本文件 + CHANGELOG → commit（若有暂存改动）
//        → 打轻量 tag v<version>。不自动 push。未加 --tag 则只改文件不碰 git。
//
// Cargo.lock 只改 termstep 包那一处——文件里有大量无关 crate 的 version 行
// （如 serde 1.x、tauri 2.x），绝不能用全局替换误伤。改成 termstep 那条是
// `cargo update -p termstep` 的等价手写，避免脚本依赖 cargo 可执行文件。

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const files = {
  'package.json': join(root, 'package.json'),
  'src-tauri/Cargo.toml': join(root, 'src-tauri/Cargo.toml'),
  'src-tauri/tauri.conf.json': join(root, 'src-tauri/tauri.conf.json'),
  'src-tauri/Cargo.lock': join(root, 'src-tauri/Cargo.lock'),
};
// --tag 时被 git add 的文件（相对项目根）。CHANGELOG.md 为自动生成条目的载体。
const versionFiles = [
  'package.json',
  'src-tauri/Cargo.toml',
  'src-tauri/tauri.conf.json',
  'src-tauri/Cargo.lock',
  'CHANGELOG.md',
];

// 语义化版本：X.Y.Z 或 X.Y.Z-pre（含预发布标签）。拒收 v 前缀和非法字符。
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const tagMode = argv.includes('--tag');
const version = argv.find((a) => !a.startsWith('--'));

if (!version) {
  console.error('用法: node scripts/set-version.mjs <version> [--dry-run] [--tag]');
  console.error('示例: node scripts/set-version.mjs 0.8.0');
  process.exit(1);
}
if (!SEMVER_RE.test(version)) {
  console.error(`非法版本号: "${version}"（应为 X.Y.Z 或 X.Y.Z-pre，不带 v 前缀）`);
  process.exit(1);
}

const changes = [];

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

// ── git 调用封装：同步、不经 shell、失败即清晰报错退出 ────────────────────────
function git(args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const stderr = (e.stderr || '').trim();
    console.error(`\n⚠ git ${args.join(' ')} 失败：${stderr || e.message}`);
    process.exit(1);
  }
}

// ── CHANGELOG.md：自动提取提交，生成新版本条目并插入顶部 ────────────────────
// 提取范围下界：最近的 git tag（`<last-tag>..HEAD`）。
// 纯 tag-based，要求先给已发布版本打 tag。无 tag 时报错退出，避免误把全部历史
// 塞进新版本（早期用"引入版本号的 commit"作下界，但版本号提交点与版本内容结束点
// 不一致——功能提交后常跟修补提交，会把上个版本的修补错算进新版本）。
function collectCommits() {
  const tags = git(['tag', '-l', '--sort=-v:refname']).trim();
  if (!tags) {
    console.error('\n⚠ 无 git tag，无法确定提取范围。请先给已发布版本打 tag（如 git tag v0.9.2 <commit>）后再运行。');
    process.exit(1);
  }
  const range = `${tags.split('\n')[0]}..HEAD`;
  const out = git(['log', range, '--no-merges', '--format=%s']);
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

// 过滤噪声 + 按前缀分类。返回 { added, changed, fixed }。
function classifyCommits(subjects) {
  const skipPrefixes = ['docs:', 'chore:', 'test:', 'build:', 'ci:', 'style:'];
  const added = [];
  const changed = [];
  const fixed = [];
  for (const s of subjects) {
    if (skipPrefixes.some((p) => s.toLowerCase().startsWith(p))) continue;
    const m = s.match(/^(\w+)(\([^)]*\))?!?:\s*(.+)$/);
    if (!m) {
      changed.push(s);
      continue;
    }
    const type = m[1].toLowerCase();
    const msg = m[3].trim();
    if (type === 'feat') added.push(msg);
    else if (type === 'fix') fixed.push(msg);
    else changed.push(msg); // refactor/ui/perf/improvement 等
  }
  return { added, changed, fixed };
}

function buildEntryText(version, { added, changed, fixed }) {
  const today = new Date().toISOString().slice(0, 10);
  const sections = [];
  if (added.length) sections.push('### Added\n' + added.map((s) => `- ${s}`).join('\n'));
  if (changed.length) sections.push('### Changed\n' + changed.map((s) => `- ${s}`).join('\n'));
  if (fixed.length) sections.push('### Fixed\n' + fixed.map((s) => `- ${s}`).join('\n'));
  if (!sections.length) sections.push('### Changed\n- （本版本无可见改动）');
  return `## [${version}] - ${today}\n${sections.join('\n\n')}`;
}

// 在 CHANGELOG.md 顶部插入新版本条目；幂等：已含该版本则跳过。
function updateChangelog(version) {
  const abs = join(root, 'CHANGELOG.md');
  if (!existsSync(abs)) {
    console.error('\n⚠ CHANGELOG.md 不存在，无法插入新版本条目');
    process.exit(1);
  }
  const raw = readFileSync(abs, 'utf8');
  if (raw.includes(`## [${version}]`)) {
    changes.push({ file: 'CHANGELOG.md', before: version, after: version, noop: true });
    return { skipped: true, count: 0 };
  }
  const subjects = collectCommits();
  const classified = classifyCommits(subjects);
  const entry = buildEntryText(version, classified);
  const count = classified.added.length + classified.changed.length + classified.fixed.length;

  if (dryRun) {
    changes.push({ file: 'CHANGELOG.md', before: null, after: `## [${version}]`, noop: false });
    return { skipped: false, count, entry };
  }

  // 插入到第一个 `## [` 标题行之前；无则追加到文件末尾。
  const lines = raw.split('\n');
  const idx = lines.findIndex((l) => /^## \[/.test(l));
  let next;
  if (idx >= 0) {
    next = [...lines.slice(0, idx), entry, '', ...lines.slice(idx)].join('\n');
  } else {
    next = raw.endsWith('\n') ? `${raw}${entry}\n` : `${raw}\n${entry}\n`;
  }
  writeFileSync(abs, next);
  changes.push({ file: 'CHANGELOG.md', before: null, after: `## [${version}]`, noop: false });
  return { skipped: false, count, entry };
}

// ── --tag：提交版本文件 + CHANGELOG 并打轻量 tag ────────────────────────────
// 顺序：预检 tag 不存在 → git add 指定文件 → 有暂存才 commit → 打 tag。
// 不自动 push（用户手动）。返回结果交由末尾统一打印，避免盖在版本摘要之前。
function commitAndTag(version) {
  const tagName = `v${version}`;
  // 预检：tag 已存在则退出，避免覆盖。
  if (git(['tag', '-l', tagName]).trim()) {
    console.error(`\n⚠ tag ${tagName} 已存在，已中止`);
    process.exit(1);
  }
  // git add 版本文件（CHANGELOG 不存在时跳过它，避免 add 报错）。
  const toAdd = versionFiles.filter((f) => existsSync(join(root, f)));
  git(['add', ...toAdd]);
  // 有暂存改动才 commit（否则跳过 commit 直接打 tag，例如纯 noop 重跑）。
  let committed = false;
  try {
    execFileSync('git', ['diff', '--cached', '--quiet'], { cwd: root, stdio: 'ignore' });
    committed = false; // 返回 0 = 无暂存改动
  } catch {
    committed = true; // 返回非 0 = 有暂存改动
  }
  if (committed) {
    git(['commit', '-m', `chore(release): ${version}`]);
  }
  git(['tag', tagName]);
  return { committed, commitMsg: `chore(release): ${version}`, tagName };
}

setJsonVersion('package.json');
setCargoTomlVersion();
setJsonVersion('src-tauri/tauri.conf.json');
setCargoLockVersion();
// 更新 CHANGELOG（每次 version:set 都做，自动提取提交生成条目）
const changelogResult = updateChangelog(version);
// --tag 时提交版本文件 + CHANGELOG 并打 tag（真跑）；dry-run 只生成预览。
let tagResult = null;
if (tagMode && !dryRun) {
  tagResult = commitAndTag(version);
} else if (tagMode && dryRun) {
  changelogResult.gitPreview = [
    '# git add ' + versionFiles.join(' '),
    '# git commit -m "chore(release): ' + version + '"',
    '# git tag v' + version,
  ];
}

// ── 输出 ────────────────────────────────────────────────────────────────────
const tagPrefix = dryRun ? '[dry-run] ' : '';
console.log(`\n${tagPrefix}设置版本号 → ${version}\n`);
const maxFile = Math.max(...changes.map((c) => c.file.length));
for (const c of changes) {
  const before = c.before ?? '(新增)';
  const pad = ' '.repeat(maxFile - c.file.length);
  if (c.noop) {
    console.log(`  ${c.file}${pad}  ${before}  (已是该版本，跳过)`);
  } else {
    console.log(`  ${c.file}${pad}  ${before}  →  ${c.after}`);
  }
}
// 只有真正的版本文件（含 version 字段）才算"未匹配"；CHANGELOG 无版本字段属正常。
const versionFileNames = Object.keys(files);
const missing = changes.filter((c) => c.before === null && versionFileNames.includes(c.file));
if (missing.length) {
  console.error(`\n⚠ 未能匹配到版本号的文件：${missing.map((m) => m.file).join(', ')}`);
  process.exit(1);
}
// CHANGELOG 条目预览（dry-run 时打印将插入的内容）。
if (dryRun && changelogResult?.entry) {
  console.log(`\n将插入 CHANGELOG 条目（${changelogResult.count} 条提交）：`);
  console.log(changelogResult.entry.split('\n').map((l) => l ? `  ${l}` : '').join('\n'));
}
if (dryRun && changelogResult?.gitPreview) {
  console.log('\n将执行的 git 命令（--tag）：');
  console.log(changelogResult.gitPreview.map((l) => `  ${l}`).join('\n'));
}
if (tagResult) {
  console.log(`\n${tagResult.committed ? '✓ git commit' : '· 无改动跳过 commit'}: ${tagResult.commitMsg}`);
  console.log(`✓ git tag: ${tagResult.tagName}`);
  console.log('（未 push，请手动 git push origin main --tags）');
}
console.log(dryRun ? '\n（dry-run，未写盘）\n' : '\n完成。\n');
