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
const social = require('./publish.cjs');
const link = require('./link.cjs');
const voice = require('./voice.cjs');

const DIST = path.join(__dirname, '..', 'dist');
const ORIGIN = 'app://studio';
// Only these link types may leave the app, and they open in the owner's own mail / phone / browser app.
const EXTERNAL_LINK = /^(mailto:|tel:|sms:|https:\/\/wa\.me\/)/i;
// Web pages the app may open in the owner's browser: the platforms' own sites (published posts and
// the developer consoles used once during setup). Anything else is refused.
const EXTERNAL_HOST = /(^|\.)(youtube\.com|youtu\.be|google\.com|facebook\.com|instagram\.com|linkedin\.com|x\.com)$/i;
const EXTERNAL = { test: (url) => {
  if (EXTERNAL_LINK.test(url)) return true;
  try { const u = new URL(url); return u.protocol === 'https:' && EXTERNAL_HOST.test(u.hostname); } catch { return false; }
} };

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

  // ---- social publishing: the page hands over an approved video; uploads happen here, to platform hosts only ----
  // Development-only hook so the flows can be exercised against a simulated platform.
  let deps = {};
  if (!app.isPackaged && process.env.MS_SOCIAL_TEST) {
    deps = { endpoints: JSON.parse(process.env.MS_SOCIAL_TEST), allowHost: (u) => new URL(u).hostname === '127.0.0.1', sleep: () => Promise.resolve() };
  }
  const openBrowser = deps.endpoints ? (url) => fetch(url).then(() => {}) : (url) => shell.openExternal(url);
  ipcMain.handle('social:connect', async (e, provider, creds) => {
    if (!fromApp(e)) return { ok: false, error: 'Not allowed.' };
    try {
      return { ok: true, account: await social.connect(String(provider), { clientId: String(creds?.clientId ?? '').trim(), clientSecret: String(creds?.clientSecret ?? '').trim(), organizationId: String(creds?.organizationId ?? '').trim(), redirectUri: String(creds?.redirectUri ?? '').trim(), configId: String(creds?.configId ?? '').trim() }, openBrowser, deps) };
    } catch (err) {
      return { ok: false, error: String(err?.message ?? err).slice(0, 500) };
    }
  });
  // ---- phone link and automation API: a local-network server whose requests are answered by the unlocked app ----
  let linkServer = null;
  let linkSeq = 0;
  const linkWaiting = new Map();
  ipcMain.on('link:reply', (e, id, reply) => {
    if (!fromApp(e)) return;
    const done = linkWaiting.get(id);
    if (done) { linkWaiting.delete(id); done(reply); }
  });
  const askApp = (req) => new Promise((resolve) => {
    const win = mainWindow;
    if (!win || win.isDestroyed()) return resolve({ status: 503, json: { error: 'Marketing Studio is not running on the PC.' } });
    const id = ++linkSeq;
    const timer = setTimeout(() => { linkWaiting.delete(id); resolve({ status: 504, json: { error: 'The PC took too long to answer.' } }); }, 30_000);
    linkWaiting.set(id, (reply) => { clearTimeout(timer); resolve(reply); });
    win.webContents.send('link:request', id, req);
  });
  const stopLink = async () => { if (linkServer) { const s = linkServer; linkServer = null; await s.close(); } };
  ipcMain.handle('link:start', async (e, cfg) => {
    if (!fromApp(e)) return { ok: false, error: 'Not allowed.' };
    await stopLink();
    const code = link.normalizeCode(cfg?.code);
    if (code.length < 16) return { ok: false, error: 'The pairing code is too short.' };
    const port = Number.isInteger(cfg?.port) && cfg.port >= 1024 && cfg.port <= 65535 ? cfg.port : link.DEFAULT_PORT;
    const server = link.createLinkServer({ code, handle: askApp });
    try {
      await server.listen(port);
      linkServer = server;
      return { ok: true, port, addresses: link.lanAddresses() };
    } catch (err) {
      return { ok: false, error: err?.code === 'EADDRINUSE' ? `Port ${port} is already used by another program on this PC.` : 'The phone link could not be started.' };
    }
  });
  ipcMain.handle('link:stop', async (e) => { if (fromApp(e)) await stopLink(); });
  ipcMain.handle('link:notify', (e, url, signingKey, event, data) => (fromApp(e) ? link.notify(url, signingKey, String(event), data) : { ok: false, error: 'Not allowed.' }));
  app.on('before-quit', () => { void stopLink(); });

  ipcMain.handle('voice:speak', (e, text, opts) => (fromApp(e) ? voice.speak(text, opts) : { ok: false, error: 'Not allowed.' }));
  ipcMain.handle('voice:list', (e) => (fromApp(e) ? voice.voices() : { ok: false, error: 'Not allowed.' }));

  ipcMain.handle('social:publish', (e, target, account, job) => {
    if (!fromApp(e)) return { ok: false, error: 'Not allowed.' };
    return social.publish(String(target), account, job, deps);
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
