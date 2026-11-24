import { app, BrowserWindow, Menu, dialog, ipcMain, safeStorage, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { AppModel } from './model.js';
import { validURL } from './core.js';
import { UpdateController } from './updates.js';

// Two companions on one Mac would fight over the server's publishing lease.
if (!app.requestSingleInstanceLock()) app.quit();

let win, model, updater, lastSent = '';
const view = () => ({ ...model.view(), updates: updater.view() });

// The device token is encrypted with a key held in the macOS Keychain; only the ciphertext is on disk.
const tokenFile = () => path.join(app.getPath('userData'), 'token.bin');
const loadToken = () => (fs.existsSync(tokenFile()) ? safeStorage.decryptString(fs.readFileSync(tokenFile())) : '');
function saveToken(token) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Could not save the device token: the macOS Keychain is unavailable.');
  fs.mkdirSync(path.dirname(tokenFile()), { recursive: true });
  fs.writeFileSync(tokenFile(), safeStorage.encryptString(token), { mode: 0o600 });
}

async function exportProfile() {
  const { filePath } = await dialog.showSaveDialog(win, { title: 'Export saved link mappings', defaultPath: 'proclaim-tap-links.json' });
  if (!filePath) return;
  try { fs.writeFileSync(filePath, JSON.stringify(model.profileJSON(), null, 2)); }
  catch (error) { model.storageError = `Export failed: ${error.message}`; }
}

// Everything the window may ask for. Arguments cross a trust boundary, so each is coerced to its expected type.
const actions = {
  view: () => {},
  start: () => model.start(),
  stop: () => model.stop(),
  sync: () => model.sync(),
  select: id => model.select(String(id)),
  setLink: (link, itemId, expected) => model.setLink(String(link), String(itemId), expected == null ? null : String(expected)),
  setFallback: link => model.setFallback(String(link)),
  setForceFallback: on => { model.forceFallback = on === true; },
  configureServer: o => model.configureServer({ url: String(o.url), token: String(o.token ?? ''), enabled: o.enabled === true,
    cloudEnabled: o.cloudEnabled === true, monitorLocal: o.monitorLocal === true }),
  choosePresentation: id => model.chooseCloudPresentation(String(id)),
  importLinks: () => model.importCurrentLocalLinks(),
  showDemo: () => model.showDemo(),
  showDemoItem: id => model.showDemoItem(String(id)),
  exportProfile,
  checkUpdates: () => updater.check(),
  downloadUpdate: () => updater.downloadUpdate(),
  showDownload: () => updater.revealDownload(),
  open: url => { if (validURL(url)) shell.openExternal(url); },
};

function push() {
  if (!win || win.isDestroyed()) return;
  const state = JSON.stringify(view());
  if (state === lastSent) return;
  lastSent = state;
  win.webContents.send('state', JSON.parse(state));
}

app.whenReady().then(() => {
  model = new AppModel({ dir: app.getPath('userData'), loadToken, saveToken });
  updater = new UpdateController({ currentVersion: app.getVersion(), connection: () => model.updateConnection(),
    packaged: app.isPackaged,
    downloadDirectory: app.getPath('downloads'), reveal: file => shell.showItemInFolder(file) });
  ipcMain.handle('tap', async (event, name, ...args) => {
    if (event.sender !== win?.webContents || !Object.hasOwn(actions, name)) throw new Error('Unknown action');
    await actions[name](...args);
    return view();
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: app.name, submenu: [
      { role: 'about' },
      { label: 'Check for Updates…', click: () => { win.webContents.send('show-settings'); updater.check(); } },
      { type: 'separator' }, { role: 'services' }, { type: 'separator' },
      { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' },
    ] }, { role: 'editMenu' },
    { label: 'Presentation', submenu: [
      { label: 'Sync Presentation', accelerator: 'CmdOrCtrl+R', click: () => { if (model.isMonitoring) model.sync(); } },
      { label: 'Export Link Mappings…', click: exportProfile },
    ] },
    { role: 'windowMenu' },
  ]));
  win = new BrowserWindow({
    width: 1180, height: 800, minWidth: 1000, minHeight: 680, show: false, title: 'Proclaim Tap',
    backgroundColor: '#111215', titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 18 },
    webPreferences: { preload: path.join(import.meta.dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, spellcheck: false },
  });
  // The window only ever shows the bundled page; links open in the user's browser through the `open` action.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(import.meta.dirname, '../ui/index.html'));
  if (process.argv.includes('--demo')) model.showDemo(); else model.start();
  // ponytail: the model has no change events; diffing its view 4×/s is plenty for a 1 s poll. Add events if this ever shows in a profile.
  setInterval(push, 250);
});

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
// Closing the window stops monitoring, as before; the server falls back when the heartbeat expires.
app.on('window-all-closed', () => app.quit());
