'use strict';
// Electron main process — Option A: wraps existing server.js over WebSocket/Express
// Requires Electron 22+ (uses utilityProcess to fork server.js inside Electron's Node runtime)

const { app, BrowserWindow, shell, utilityProcess } = require('electron');
const path = require('path');
const http = require('http');

const isDev  = !app.isPackaged;
const PORT   = 3001;
let server   = null;

// ── Spawn server.js inside Electron's embedded Node runtime ──────────────────
function startServer() {
  const serverPath = isDev
    ? path.join(__dirname, '..', 'server.js')
    : path.join(app.getAppPath(), 'server.js');

  server = utilityProcess.fork(serverPath, [], {
    serviceName: 'ssh-backend',
    env: { ...process.env, PORT: String(PORT) },
  });

  server.on('exit', (code) => console.log(`[server] exited (${code})`));
}

// ── Poll until Express is accepting connections ───────────────────────────────
// 30 s — Windows + ssh2 crypto startup can be slow
function waitForServer(timeout = 30000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeout;
    const attempt  = () => {
      http.get(`http://127.0.0.1:${PORT}/hosts`, (res) => {
        res.resume();
        resolve();
      }).on('error', () => {
        if (Date.now() > deadline) reject(new Error('Backend did not start in time'));
        else setTimeout(attempt, 300);
      });
    };
    attempt();
  });
}

// ── Browser window ────────────────────────────────────────────────────────────
function createWindow() {
  const win = new BrowserWindow({
    width:  1400,
    height: 900,
    backgroundColor: '#0d1117',
    title: 'Big Bog Term',
    webPreferences: {
      nodeIntegration:  false,
      contextIsolation: true,
    },
  });

  win.removeMenu();

  // In dev, Vite serves the frontend (run `npm run dev` in client/ separately).
  // In prod, Express serves the built frontend from client/dist.
  const url = isDev ? `http://localhost:5173` : `http://127.0.0.1:${PORT}`;
  win.loadURL(url);

  // External links open in the OS browser, not inside Electron
  win.webContents.setWindowOpenHandler(({ url: href }) => {
    shell.openExternal(href);
    return { action: 'deny' };
  });
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  startServer();
  try {
    await waitForServer();
  } catch (err) {
    // Backend took too long — open the window anyway; the React app will show
    // its "Backend not running" error page until the server catches up.
    console.error('[electron] waitForServer:', err.message);
  }
  createWindow();
});

app.on('window-all-closed', () => {
  if (server) { server.kill(); server = null; }
  app.quit();
});
