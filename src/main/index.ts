import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { PtyService } from './ptyService';
import { ToolManager } from './toolManager';
import { registerIpc } from './ipc';
import { seedDefaultTools } from './seed';
import { IPC, type ScanResult } from '../shared/types';

const TOOLS_DIR = path.join(app.getPath('userData'), 'tools');
let ptyService: PtyService | null = null;

// The app was renamed (cmd_gui/cmd-gui -> gui_anything); userData is derived from
// the app name, so storage moved. One-time: carry forward tools created under the
// old name so they aren't silently lost.
function migrateOldTools(toolsDir: string): void {
  const hasCurrent = fs.existsSync(toolsDir) && fs.readdirSync(toolsDir).length > 0;
  if (hasCurrent) return;
  const appData = app.getPath('appData');
  for (const oldName of ['cmd-gui', 'cmd_gui']) {
    const oldTools = path.join(appData, oldName, 'tools');
    if (fs.existsSync(oldTools) && fs.readdirSync(oldTools).length > 0) {
      fs.mkdirSync(toolsDir, { recursive: true });
      for (const entry of fs.readdirSync(oldTools)) {
        fs.cpSync(path.join(oldTools, entry), path.join(toolsDir, entry), { recursive: true });
      }
      return;
    }
  }
}

async function createWindow(): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  if (process.env['ELECTRON_RENDERER_URL']) await win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  else await win.loadFile(path.join(__dirname, '../renderer/index.html'));
  return win;
}

app.whenReady().then(async () => {
  migrateOldTools(TOOLS_DIR);
  await seedDefaultTools(TOOLS_DIR);

  ptyService = new PtyService();
  const toolManager = new ToolManager(TOOLS_DIR);

  const send = (channel: string, payload: unknown) => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, payload);
  };

  toolManager.onChange = (r: ScanResult) => send(IPC.TOOLS_CHANGED, r);
  ptyService.onData((toolId, data) => send(IPC.PTY_DATA, { toolId, data }));

  registerIpc({ toolsDir: TOOLS_DIR, toolManager, ptyService });
  await toolManager.start();

  await createWindow();

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) await createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  ptyService?.killAll();
});
