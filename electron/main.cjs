/**
 * Desktop shell (Windows / macOS / Linux).
 * Hardened: the page runs sandboxed with no Node access, is served from a private
 * app:// origin, cannot navigate away, cannot open windows, and every network
 * request that is not part of the app itself is cancelled.
 */
const { app, BrowserWindow, protocol, session, shell, Menu, net, Tray, ipcMain, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const DIST = path.join(__dirname, '..', 'dist');
const ORIGIN = 'app://studio';
// Only these link types may leave the app, and they open in the owner's own mail / phone / browser app.
const EXTERNAL = /^(mailto:|tel:|sms:|https:\/\/wa\.me\/)/i;

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

if (!app.requestSingleInstanceLock()) app.quit();

// ---- background mode: keep the agents working after the window is closed ----
const CONFIG = () => path.join(app.getPath('userData'), 'desktop.json');
let background = false;
let quitting = false;
let tray = null;
let mainWindow = null;

function loadConfig() {
  try { background = JSON.parse(fs.readFileSync(CONFIG(), 'utf8')).background === true; } catch { background = false; }
}
function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return createWindow();
  mainWindow.show();
  mainWindow.focus();
}
function applyBackground() {
  // Start with the computer so the agents resume after a restart (the owner still unlocks once).
  try { if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: background }); } catch { /* not supported on this system */ }
  if (background && !tray) {
    try {
      tray = new Tray(nativeImage.createFromPath(path.join(DIST, 'icons', 'icon-192.png')).resize({ width: 20, height: 20 }));
      tray.setToolTip('Marketing Studio — working in the background');
      tray.setContextMenu(Menu.buildFromTemplate([
        { label: 'Open Marketing Studio', click: showWindow },
        { label: 'Quit (stops background work)', click: () => { quitting = true; app.quit(); } },
      ]));
      tray.on('click', showWindow);
    } catch { tray = null; }
  } else if (!background && tray) {
    tray.destroy();
    tray = null;
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 380,
    minHeight: 560,
    backgroundColor: '#0b1020',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      devTools: !app.isPackaged,
      spellcheck: false,
      backgroundThrottling: false, // keep creating videos at full speed while hidden
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });
  mainWindow = win;
  win.on('close', (e) => {
    // With background mode on, closing the window only hides it; the tray icon brings it back.
    if (background && tray && !quitting) { e.preventDefault(); win.hide(); }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (EXTERNAL.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith(ORIGIN + '/')) return;
    e.preventDefault();
    if (EXTERNAL.test(url)) shell.openExternal(url);
  });
  win.webContents.on('will-attach-webview', (e) => e.preventDefault());
  win.loadURL(ORIGIN + '/index.html');
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  loadConfig();
  applyBackground();
  const fromApp = (e) => !!e.senderFrame && e.senderFrame.url.startsWith(ORIGIN + '/');
  ipcMain.handle('background:get', (e) => (fromApp(e) ? { enabled: background, tray: !!tray } : null));
  ipcMain.handle('background:set', (e, on) => {
    if (!fromApp(e)) return null;
    background = on === true;
    try { fs.writeFileSync(CONFIG(), JSON.stringify({ background })); } catch { /* keep in memory */ }
    applyBackground();
    return { enabled: background, tray: !!tray };
  });

  // Serve the bundled app files; refuse anything outside the app folder.
  protocol.handle('app', (request) => {
    const url = new URL(request.url);
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = path.normalize(path.join(DIST, rel));
    if (url.host !== 'studio' || !file.startsWith(DIST + path.sep)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });

  const ses = session.defaultSession;
  // No outside connections. The single exception is the owner's own AI engine on this same computer.
  ses.webRequest.onBeforeRequest((details, cb) => {
    const ok = /^(app|blob|data|devtools|file):/i.test(details.url) || /^http:\/\/(127\.0\.0\.1|localhost):11434\//i.test(details.url);
    cb({ cancel: !ok });
  });
  // No camera, microphone, location, notifications … unless the app needs them (it does not).
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'clipboard-sanitized-write'));
  ses.setPermissionCheckHandler((_wc, permission) => permission === 'clipboard-sanitized-write');

  createWindow();
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});

app.on('second-instance', () => {
  const [win] = BrowserWindow.getAllWindows();
  if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
});
app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => process.platform !== 'darwin' && app.quit());
