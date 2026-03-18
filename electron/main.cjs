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

// ── Generic URL poller ────────────────────────────────────────────────────────
function waitForURL(url, label, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeout;
    const attempt  = () => {
      http.get(url, (res) => { res.resume(); resolve(); })
        .on('error', () => {
          if (Date.now() > deadline) reject(new Error(`${label} did not start in time`));
          else setTimeout(attempt, 300);
        });
    };
    attempt();
  });
}

const waitForServer = () => waitForURL(`http://127.0.0.1:${PORT}/hosts`, 'Backend');
const waitForVite   = () => waitForURL('http://localhost:5173',           'Vite');

// ── Browser window ────────────────────────────────────────────────────────────
function createWindow() {
  const win = new BrowserWindow({
    width:  1400,
    height: 900,
    backgroundColor: '#0d1117',
    title: 'Big Bog Term',
    // Remove the native title bar; keep native traffic-light controls via overlay
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color:       '#161b22', // matches tab bar background
      symbolColor: '#c9d1d9', // icon colour
      height: 36,             // matches our 36 px tab bar
    },
    webPreferences: {
      nodeIntegration:  false,
      contextIsolation: true,
    },
  });

  win.removeMenu();

  // In dev, Vite serves the frontend; in prod, Express serves client/dist.
  const url = isDev ? 'http://localhost:5173' : `http://127.0.0.1:${PORT}`;
  win.loadURL(url);

  // Open DevTools automatically in dev so console errors are immediately visible
  if (isDev) win.webContents.openDevTools();

  // External links open in the OS browser, not inside Electron
  win.webContents.setWindowOpenHandler(({ url: href }) => {
    shell.openExternal(href);
    return { action: 'deny' };
  });
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  startServer();
  // Wait for both the backend and (in dev) Vite — whichever is slower wins
  const waits = [waitForServer()];
  if (isDev) waits.push(waitForVite());
  try {
    await Promise.all(waits);
  } catch (err) {
    console.error('[electron]', err.message);
  }
  createWindow();
});

app.on('window-all-closed', () => {
  if (server) { server.kill(); server = null; }
  app.quit();
});
