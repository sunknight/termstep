#!/usr/bin/env node
// 同步设置整个项目的版本号。涉及的文件各用不同格式，逐一精确改：
//   - package.json             : "version": "x.y.z"
//   - src-tauri/Cargo.toml     : version = "x.y.z"   （package 段，首处）
//   - src-tauri/tauri.conf.json: "version": "x.y.z"
//   - src-tauri/Cargo.lock     : name = "termstep" 紧随的 version = "..."
//
// CHANGELOG.md 不由本脚本维护：git 提交记录是面向开发的，直接抽取会混入
// 实现细节，不适合给用户看。版本记录由人工编写面向用户的条目。
//
// 用法：
//   node scripts/set-version.mjs <version> [--dry-run] [--tag]
//   npm run version:set -- <version> [--dry-run] [--tag]
//
// --tag：在上述改动基础上，git add 版本文件 → commit（若有暂存改动）
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
// --tag 时被 git add 的文件（相对项目根）。
const versionFiles = [
  'package.json',
  'src-tauri/Cargo.toml',
  'src-tauri/tauri.conf.json',
  'src-tauri/Cargo.lock',
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

// ── --tag：提交版本文件并打轻量 tag ──────────────────────────────────────────
// 顺序：预检 tag 不存在 → git add 指定文件 → 有暂存才 commit → 打 tag。
// 不自动 push（用户手动）。返回结果交由末尾统一打印，避免盖在版本摘要之前。
function commitAndTag(version) {
  const tagName = `v${version}`;
  // 预检：tag 已存在则退出，避免覆盖。
  if (git(['tag', '-l', tagName]).trim()) {
    console.error(`\n⚠ tag ${tagName} 已存在，已中止`);
    process.exit(1);
  }
  // git add 版本文件（缺失的跳过，避免 add 报错）。
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
// --tag 时提交版本文件并打 tag（真跑）；dry-run 只生成预览。
let tagResult = null;
if (tagMode && !dryRun) {
  tagResult = commitAndTag(version);
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
// 版本文件（含 version 字段）匹配不到版本号才算"未匹配"。
const versionFileNames = Object.keys(files);
const missing = changes.filter((c) => c.before === null && versionFileNames.includes(c.file));
if (missing.length) {
  console.error(`\n⚠ 未能匹配到版本号的文件：${missing.map((m) => m.file).join(', ')}`);
  process.exit(1);
}
if (tagResult) {
  console.log(`\n${tagResult.committed ? '✓ git commit' : '· 无改动跳过 commit'}: ${tagResult.commitMsg}`);
  console.log(`✓ git tag: ${tagResult.tagName}`);
  console.log('（未 push，请手动 git push origin main --tags）');
}

// ── CHANGELOG 提示词：本脚本不碰 CHANGELOG，由人工按「面向用户」原则手写。
// 这里生成一段可复制的提示词，粘给 AI 即可按既定原则产出本版本条目。
// 提取范围 = 最近 tag..HEAD（与旧自动逻辑一致的范围，只是改由 AI 总结成用户视角）。
function buildChangelogPrompt(version) {
  const tags = git(['tag', '-l', '--sort=-v:refname']).trim();
  const range = tags ? `${tags.split('\n')[0]}..HEAD` : '全部历史';
  let subjects = [];
  try {
    subjects = git(['log', range, '--no-merges', '--format=- %s']).trim().split('\n').filter(Boolean);
  } catch {
    subjects = [];
  }
  const today = new Date().toISOString().slice(0, 10);
  return [
    `请为 TermStep ${version}（${today}）生成 CHANGELOG.md 条目，插入到文件顶部「## [」标题之前。`,
    '',
    '原则：面向用户，不面向开发。',
    '- 只写用户能看到/能做到的变化，不写模块名、函数名、数据字段、内部机制、重构/测试/文档改动。',
    '- 用「可/能/不再/现在」开头，每条一句话。',
    '- 段落为空就省略（Added / Changed / Fixed）。',
    '- 格式：',
    '  ## [' + version + '] - ' + today,
    '  ### Added',
    '  - ...',
    '',
    '本版本提交（' + range + '，仅作参考素材，需提炼成用户视角，不要照抄）：',
    ...subjects,
  ].join('\n');
}

console.log('\n──────── CHANGELOG 提示词（复制下方给 AI）────────');
console.log(buildChangelogPrompt(version));
console.log('─────────────────────────────────────────────────');
console.log('注：脚本不自动改 CHANGELOG.md。请把上面的提示词粘给 AI 生成条目，');
console.log('    人工核对后插入 CHANGELOG.md 顶部，再 git add CHANGELOG.md 并提交。');
console.log(dryRun ? '\n（dry-run，未写盘）\n' : '\n完成。\n');
