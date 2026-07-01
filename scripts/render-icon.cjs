// Render build/icon.svg → build/icon.png at 1024×1024 using Electron's Chromium.
// Run: npm run icon. Dep-free (Electron already bundles a renderer). The PNG is
// what electron-builder turns into the .icns and what we set as the dev Dock icon.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const SIZE = 1024;
const root = path.join(__dirname, '..');
const svgPath = path.join(root, 'build', 'icon.svg');
const outPath = path.join(root, 'build', 'icon.png');

app.whenReady().then(async () => {
  const svg = fs.readFileSync(svgPath, 'utf8');
  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
  });
  const html =
    '<!doctype html><html><head><meta charset="utf-8"><style>' +
    'html,body{margin:0;padding:0;background:transparent;overflow:hidden}' +
    '</style></head><body>' +
    svg +
    '</body></html>';
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  // Give Chromium a tick to paint, then capture.
  setTimeout(async () => {
    try {
      const img = await win.webContents.capturePage();
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, img.toPNG());
      const { width, height } = img.getSize();
      console.log(`icon written: ${outPath} (${width}x${height})`);
    } catch (e) {
      console.error('icon render failed:', e);
      process.exitCode = 1;
    } finally {
      app.quit();
    }
  }, 300);
});
