import { isDangerousCommand } from '../../shared/dangerous';
import { runCommand } from './termRegistry';
import { confirmDialog } from './dialog';
import type { PtySpawnOpts } from '../../shared/types';

// runCommand + a confirm dialog when the command looks destructive. Shared by
// the help buttons and the global quick-command dropdown so the guard lives in
// one place. Returns true if the command was sent, false if the user cancelled.
// Async because the native confirm (Tauri plugin dialog) is awaitable — the old
// window.confirm was sync but never actually worked in the WKWebView.
export async function runCommandChecked(
  toolId: string,
  command: string,
  edit: boolean,
  opts: PtySpawnOpts
): Promise<boolean> {
  const d = isDangerousCommand(command);
  if (d.dangerous) {
    const verb = edit ? '粘贴' : '执行';
    const ok = await confirmDialog(
      `⚠️ 危险命令（${d.reason}）\n\n${command}\n\n确定要${verb}吗？`,
      '危险命令确认'
    );
    if (!ok) return false;
  }
  runCommand(toolId, command, edit, opts);
  return true;
}
