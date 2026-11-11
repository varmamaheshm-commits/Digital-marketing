/**
 * Desktop shell (Windows / macOS / Linux).
 * Hardened: the page runs sandboxed with no Node access, is served from a private
 * app:// origin, cannot navigate away, cannot open windows, and every network
 * request that is not part of the app itself is cancelled.
 */
const { app, BrowserWindow, protocol, session, shell, Menu, net } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');

const DIST = path.join(__dirname, '..', 'dist');
const ORIGIN = 'app://studio';
// Only these link types may leave the app, and they open in the owner's own mail / phone / browser app.
const EXTERNAL = /^(mailto:|tel:|sms:|https:\/\/wa\.me\/)/i;

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

if (!app.requestSingleInstanceLock()) app.quit();

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
    },
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
  // No outside connections at all.
  ses.webRequest.onBeforeRequest((details, cb) => {
    const ok = /^(app|blob|data|devtools|file):/i.test(details.url);
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
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});
app.on('window-all-closed', () => process.platform !== 'darwin' && app.quit());
