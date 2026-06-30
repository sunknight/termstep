import { promises as fs } from 'node:fs';
import path from 'node:path';

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
