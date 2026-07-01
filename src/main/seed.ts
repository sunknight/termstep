import { promises as fs } from 'node:fs';
import path from 'node:path';
import { QUICK_TOOL_ID } from '../shared/types';

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// Create a starter "git" tool if the tools dir is empty, so first run isn't blank.
export async function seedDefaultTools(toolsDir: string): Promise<void> {
  await fs.mkdir(toolsDir, { recursive: true });
  const entries = await fs.readdir(toolsDir);
  if (entries.length > 0) return;
  const dir = path.join(toolsDir, 'git');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'tool.json'),
    JSON.stringify({ name: 'Git', icon: '🌿', order: 0 }, null, 2) + '\n'
  );
  await fs.writeFile(
    path.join(dir, 'help.md'),
    [
      '# Git',
      '',
      '常用命令：',
      '',
      '```buttons',
      'git status # 查看状态',
      'git log --oneline -20',
      'git commit -m "" // edit',
      'git push # 推送',
      '```',
      '',
    ].join('\n')
  );
}

// The global quick-command dropdown is backed by a reserved special tool. Make
// sure it always exists (created if missing) so the dropdown is never empty on
// a fresh install. The user edits its buttons like any other tool.
export async function ensureQuickTool(toolsDir: string): Promise<void> {
  await fs.mkdir(toolsDir, { recursive: true });
  const dir = path.join(toolsDir, QUICK_TOOL_ID);
  if (await exists(dir)) return;
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'tool.json'),
    // High order pins it last in the sidebar.
    JSON.stringify({ name: '快捷命令', icon: '⚡', order: 999999 }, null, 2) + '\n'
  );
  await fs.writeFile(
    path.join(dir, 'help.md'),
    [
      '# 快捷命令',
      '',
      '这里的按钮会出现在终端右上角的全局下拉菜单里，可在任意工具的终端中执行。',
      '点击「编辑」修改下面的命令：',
      '',
      '```buttons',
      'pwd # 当前目录',
      'ls -la # 列出文件',
      'clear # 清屏',
      '```',
      '',
    ].join('\n')
  );
}
