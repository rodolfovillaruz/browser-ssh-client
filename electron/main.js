// Electron shell: a frameless window around the same front-end used by the Isolated Web App.
//
// The page still does all SSH work (protocol, crypto, terminal). The main process only opens TCP
// sockets and shuttles raw — already encrypted — bytes, standing in for the Direct Sockets API.

import { app, BrowserWindow, ipcMain, net as electronNet, protocol, screen, session, shell } from 'electron';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCHEME = 'app';
const ORIGIN = `${SCHEME}://bssh`;

// Same allow-list as dev/serve.mjs: only the app's public files are served.
const PUBLIC = ['index.html', 'styles.css', 'src/', 'icons/', '.well-known/'];

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

function serveApp() {
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.resolve(ROOT, rel);
    const resolved = path.relative(ROOT, file).split(path.sep).join('/');
    const allowed =
      url.host === 'bssh' &&
      !resolved.startsWith('..') &&
      PUBLIC.some((p) => resolved === p || resolved.startsWith(p));
    if (!allowed) return new Response('not found', { status: 404 });

    const res = await electronNet.fetch(pathToFileURL(file).toString());
    const headers = new Headers(res.headers);
    headers.set('Content-Security-Policy', CSP);
    headers.set('X-Content-Type-Options', 'nosniff');
    if (file.endsWith('.js')) headers.set('Content-Type', 'text/javascript; charset=utf-8');
    if (file.endsWith('.webmanifest')) headers.set('Content-Type', 'application/manifest+json');
    return new Response(res.body, { status: res.status, headers });
  });
}

// ---- TCP sockets for the renderer ------------------------------------------------------------

const sockets = new Map(); // id -> { socket, owner: WebContents }

function fromApp(event) {
  return event.senderFrame?.url.startsWith(`${ORIGIN}/`);
}

ipcMain.handle('tcp:connect', (event, id, host, port) => {
  if (!fromApp(event)) throw new Error('forbidden');
  if (typeof id !== 'string' || typeof host !== 'string' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('bad arguments');
  }
  const owner = event.sender;
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port, noDelay: true });
    socket.setKeepAlive(true, 30_000);
    const send = (channel, ...args) => !owner.isDestroyed() && owner.send(channel, id, ...args);

    socket.once('connect', () => {
      sockets.set(id, { socket, owner });
      resolve();
    });
    socket.on('data', (chunk) => send('tcp:data', new Uint8Array(chunk)));
    socket.on('error', (err) => {
      if (!sockets.has(id)) reject(new Error(`${err.code ?? 'error'}: could not connect to ${host}:${port}`));
      else send('tcp:error', err.message);
    });
    socket.on('close', () => {
      sockets.delete(id);
      send('tcp:end');
    });
  });
});

ipcMain.handle('tcp:write', (event, id, bytes) => {
  const entry = sockets.get(id);
  if (!entry || entry.owner !== event.sender) throw new Error('socket closed');
  return new Promise((resolve, reject) => entry.socket.write(bytes, (err) => (err ? reject(err) : resolve())));
});

ipcMain.on('tcp:close', (event, id) => {
  const entry = sockets.get(id);
  if (entry && entry.owner === event.sender) entry.socket.destroy();
});

ipcMain.on('window:close', (event) => {
  if (fromApp(event)) BrowserWindow.fromWebContents(event.sender)?.close();
});

ipcMain.on('window:minimize', (event) => {
  if (fromApp(event)) BrowserWindow.fromWebContents(event.sender)?.minimize();
});

// ---- window ----------------------------------------------------------------------------------

const MIN_HEIGHT = 300;
const INITIAL_SCALE = 0.6; // initial window size as a fraction of the display's work area

// Width / height of the monitor the window is (mostly) on.
function displayRatio(bounds) {
  const { size } = screen.getDisplayMatching(bounds);
  return size.width / size.height;
}

// Size with the given aspect ratio that fits the display's work area at `scale`.
function fittedSize(display, ratio, scale) {
  const area = display.workAreaSize;
  let width = Math.round(area.width * scale);
  let height = Math.round(width / ratio);
  if (height > area.height * scale) {
    height = Math.round(area.height * scale);
    width = Math.round(height * ratio);
  }
  return { width, height };
}

// Keeps the window at the aspect ratio of the display it is on. Electron's setAspectRatio
// constrains interactive resizing (verified on KDE Wayland); we only need to re-apply it, and
// reshape the window once, when the window moves to a display with different proportions.
function lockAspectRatio(win) {
  let ratio = 0;
  let timer = null;

  // One-time reshape to the new ratio: keep the width, derive the height, stay on the display.
  const reshape = () => {
    if (win.isMaximized() || win.isFullScreen() || win.isMinimized()) return;
    const [width, height] = win.getSize();
    if (Math.abs(width / height - ratio) < 0.005) return;
    const area = screen.getDisplayMatching(win.getBounds()).workAreaSize;
    let w = Math.min(width, area.width);
    let h = Math.round(w / ratio);
    if (h > area.height) {
      h = area.height;
      w = Math.round(h * ratio);
    }
    win.setSize(w, h);
  };

  const apply = () => {
    if (win.isDestroyed()) return;
    const next = displayRatio(win.getBounds());
    if (Math.abs(next - ratio) < 0.001) return;
    ratio = next;
    win.setAspectRatio(ratio);
    win.setMinimumSize(Math.round(MIN_HEIGHT * ratio), MIN_HEIGHT);
    reshape();
  };

  // Moving to another monitor (or that monitor changing resolution) changes the target ratio.
  win.on('move', () => {
    clearTimeout(timer);
    timer = setTimeout(apply, 150);
  });
  screen.on('display-metrics-changed', apply);
  screen.on('display-added', apply);
  screen.on('display-removed', apply);
  win.on('closed', () => {
    clearTimeout(timer);
    screen.off('display-metrics-changed', apply);
    screen.off('display-added', apply);
    screen.off('display-removed', apply);
  });

  apply();
}

function createWindow() {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const ratio = display.size.width / display.size.height;
  const { width, height } = fittedSize(display, ratio, INITIAL_SCALE);

  const win = new BrowserWindow({
    width,
    height,
    minWidth: Math.round(MIN_HEIGHT * ratio),
    minHeight: MIN_HEIGHT,
    frame: false,
    backgroundColor: '#16181d',
    title: 'Browser SSH',
    icon: path.join(ROOT, 'icons/icon-512.png'),
    webPreferences: {
      preload: path.join(ROOT, 'electron/preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  // Destroy this window's sockets when it goes away.
  win.webContents.on('destroyed', () => {
    for (const [id, entry] of sockets) {
      if (entry.owner.isDestroyed()) {
        entry.socket.destroy();
        sockets.delete(id);
      }
    }
  });

  // Never navigate away from the app; open external links in the system browser.
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(`${ORIGIN}/`)) e.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });

  lockAspectRatio(win);
  win.loadURL(`${ORIGIN}/index.html`);
}

app.whenReady().then(() => {
  serveApp();
  // Clipboard writes (copy on select) are the only permission the app needs.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'clipboard-sanitized-write');
  });
  createWindow();
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
