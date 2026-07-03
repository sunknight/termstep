import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { PtyService } from './ptyService';
import { ToolManager } from './toolManager';
import { registerIpc } from './ipc';
import { seedDefaultTools } from './seed';
import { setAppMenu } from './menu';
import { IPC, type ScanResult } from '../shared/types';

// In dev we run the bare `electron` binary, so macOS's menu bar and Dock default
// to "Electron". Force the app name so the app-menu title, About box, and
// userData path all read TermStep. (The packaged .app already gets its name
// from electron-builder's productName; this is what fixes dev.)
app.setName('TermStep');

const TOOLS_DIR = path.join(app.getPath('userData'), 'tools');
let ptyService: PtyService | null = null;

// The app was renamed (cmd_gui/cmd-gui/gui_anything -> TermStep); userData is
// derived from the app name, so storage moved. One-time: carry forward the
// tools/ directory and the quick-commands.md file created under any previous
// name so they aren't silently lost.
function migrateOldUserData(userDataDir: string, toolsDir: string): void {
  const hasTools = fs.existsSync(toolsDir) && fs.readdirSync(toolsDir).length > 0;
  if (hasTools) return; // already initialized — don't clobber
  const appData = app.getPath('appData');
  // Most-recent prior name FIRST: take the latest dataset, not stale older ones
  // (checking cmd-gui before gui_anything once copied ancient cmd-gui tools and
  // returned, skipping the user's actual current data under gui_anything).
  for (const oldName of ['gui_anything', 'cmd_gui', 'cmd-gui']) {
    const oldDir = path.join(appData, oldName);
    const oldTools = path.join(oldDir, 'tools');
    const oldQuick = path.join(oldDir, 'quick-commands.md');
    const hasOldTools = fs.existsSync(oldTools) && fs.readdirSync(oldTools).length > 0;
    const hasOldQuick = fs.existsSync(oldQuick);
    if (!hasOldTools && !hasOldQuick) continue;
    if (hasOldTools) {
      fs.mkdirSync(toolsDir, { recursive: true });
      for (const entry of fs.readdirSync(oldTools)) {
        fs.cpSync(path.join(oldTools, entry), path.join(toolsDir, entry), { recursive: true });
      }
    }
    if (hasOldQuick) {
      fs.cpSync(oldQuick, path.join(userDataDir, 'quick-commands.md'));
    }
    return;
  }
}

async function createWindow(): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'TermStep',
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
  // In dev the bare electron binary shows the default Electron Dock icon; the
  // packaged .app gets its icon from the bundle (electron-builder mac.icon).
  if (process.platform === 'darwin' && !app.isPackaged) {
    const devIcon = path.join(__dirname, '..', '..', 'build', 'icon.png');
    if (fs.existsSync(devIcon)) {
      try {
        app.dock?.setIcon(devIcon);
      } catch {
        // ignore — non-fatal
      }
    }
  }

  migrateOldUserData(app.getPath('userData'), TOOLS_DIR);
  await seedDefaultTools(TOOLS_DIR);

  // Native app menu (first item's label = the bold menu-bar name on macOS) and a
  // correct About panel — both replace Electron's defaults.
  setAppMenu();
  app.setAboutPanelOptions({
    applicationName: 'TermStep',
    applicationVersion: app.getVersion(),
    version: app.getVersion(),
    credits: 'TermStep',
  });

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
