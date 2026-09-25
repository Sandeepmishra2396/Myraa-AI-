/* ===========================================================================
 * MYRAA — Electron main process (Phase 1)
 * ---------------------------------------------------------------------------
 * Responsibilities in this phase:
 *   1. Enforce a single running instance.
 *   2. Launch the existing Node backend (server.ts, bundled to dist/server.cjs)
 *      silently as a child process — no console window, no browser tab.
 *   3. Show a splash window while the backend boots, then load the real UI
 *      (http://localhost:3000) into the main application window.
 *   4. Clean up the backend (and its child Python agent) on quit.
 *
 * Tray, window-state persistence, close-to-tray and notifications arrive in
 * Phase 2; installer/auto-update/PyInstaller in later phases. The backend and
 * AI logic are reused verbatim — nothing here reimplements chat/memory/voice.
 * ========================================================================= */

'use strict';

const { app, BrowserWindow, Menu, shell, dialog, screen, ipcMain, session, desktopCapturer } = require('electron');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');
const fs = require('fs');

// --- Constants & Dynamic Port State ----------------------------------------
const DEFAULT_SERVER_PORT = 3000;
let serverPort = DEFAULT_SERVER_PORT;
let serverOrigin = `http://localhost:${serverPort}`;
const SERVER_READY_TIMEOUT_MS = 40_000;

// In development we run from the repo root; when packaged the app files live in
// resources/app (asar-unpacked handling is added in the packaging phase).
const APP_ROOT = app.isPackaged
  ? path.join(process.resourcesPath, 'app')
  : path.join(__dirname, '..');

const SERVER_ENTRY = path.join(APP_ROOT, 'dist', 'server.cjs');
const APP_ICON = path.join(APP_ROOT, 'assets', 'icon.ico');

/** @type {import('child_process').ChildProcess | null} */
let serverProcess = null;
/** @type {string[]} */
const recentBackendLogs = [];
/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {BrowserWindow | null} */
let splashWindow = null;
/** @type {BrowserWindow | null} */
let floatingWindow = null;
let floatingWindowBounds = null;
let floatingAlwaysOnTop = true;
let isQuitting = false;

/**
 * Scrubs any potential credentials, API keys, or tokens before logging.
 */
function sanitizeLogLine(raw) {
  return String(raw || '')
    .replace(/AIza[0-9A-Za-z_-]{30,}/g, 'AIzaSy...[REDACTED]')
    .replace(/AQ\.[0-9A-Za-z_-]{20,}/g, 'AQ....[REDACTED]')
    .replace(/sora_dev_[0-9A-Za-z_-]+/g, 'sora_dev_[REDACTED]')
    .replace(/myraa_(?:at|rt)_[0-9A-Za-z_-]+/g, 'myraa_token_[REDACTED]')
    .replace(/Bearer\s+[0-9A-Za-z._-]+/gi, 'Bearer [REDACTED]');
}

function logElectron(message) {
  try {
    const dataDir = app.getPath('userData');
    const logsDir = path.join(dataDir, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    const clean = sanitizeLogLine(message).trim();
    if (!clean) return;
    const line = `[${new Date().toISOString()}] ${clean}\n`;
    fs.appendFileSync(path.join(logsDir, 'electron.log'), line, 'utf-8');
  } catch {
    /* best-effort diagnostic logging */
  }
}

/**
 * Checks whether a TCP port is completely unused on both 127.0.0.1 and 0.0.0.0.
 * First probes with a TCP client connection (because on Windows SO_REUSEADDR can
 * allow binding 127.0.0.1 even when 0.0.0.0:port is already listening), then
 * verifies exclusive bind capability.
 */
function isPortAvailable(port) {
  return new Promise((resolve) => {
    // Step 1: Check if anything is already accepting connections on 127.0.0.1:port
    const probe = net.connect({ port, host: '127.0.0.1' });
    let settled = false;
    const finish = (free) => {
      if (settled) return;
      settled = true;
      try { probe.destroy(); } catch {}
      resolve(free);
    };

    probe.setTimeout(250);
    probe.once('connect', () => {
      // A process is actively listening on this port!
      finish(false);
    });
    probe.once('timeout', () => {
      try { probe.destroy(); } catch {}
      verifyBind();
    });
    probe.once('error', () => {
      // ECONNREFUSED means nothing is listening on 127.0.0.1:port; now verify bind
      verifyBind();
    });

    function verifyBind() {
      const tester = net.createServer();
      tester.once('error', () => finish(false));
      tester.once('listening', () => {
        tester.close(() => finish(true));
      });
      tester.listen({ port, host: '127.0.0.1', exclusive: true });
    }
  });
}

async function findAvailablePort(startPort = DEFAULT_SERVER_PORT, maxAttempts = 20) {
  for (let i = 0; i < maxAttempts; i++) {
    const candidate = startPort + i;
    const free = await isPortAvailable(candidate);
    if (free) {
      if (candidate !== startPort) {
        logElectron(`Port ${startPort} is already occupied by another process; selected free port ${candidate}.`);
      }
      return candidate;
    }
  }
  throw new Error(`Could not find an available local port between ${startPort} and ${startPort + maxAttempts - 1}.`);
}

// ---------------------------------------------------------------------------
// Single-instance guard — second launches focus the existing window instead of
// starting a second backend on the same port.
// ---------------------------------------------------------------------------
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
  app.whenReady().then(bootstrap);
}

// ---------------------------------------------------------------------------
// Backend lifecycle
// ---------------------------------------------------------------------------
function startBackend(port) {
  if (!fs.existsSync(SERVER_ENTRY)) {
    throw new Error(
      `Backend bundle not found at ${SERVER_ENTRY}. Run "npm run build" first.`,
    );
  }

  serverPort = port;
  serverOrigin = `http://localhost:${serverPort}`;

  // Use the Node runtime bundled with Electron (ELECTRON_RUN_AS_NODE) so the
  // machine does not need a separate Node install once packaged.
  // Data (memories, settings, secrets, logs) must live in a writable per-user
  // folder — the install dir under Program Files is read-only.
  const dataDir = app.getPath('userData');

  // Frozen Python desktop agent (bundled as an extraResource when packaged).
  // In development this file won't exist, so the backend falls back to running
  // the agent from source with a local Python interpreter.
  const agentExe = app.isPackaged
    ? path.join(process.resourcesPath, 'agent', 'myraa-agent.exe')
    : path.join(APP_ROOT, 'agent_dist', 'myraa-agent', 'myraa-agent.exe');

  const env = {
    ...process.env,
    NODE_ENV: 'production',
    ELECTRON_RUN_AS_NODE: '1',
    SORA_LAUNCHED_BY: 'electron',
    PORT: String(serverPort),
    HOST: '127.0.0.1',
    SORA_DATA_DIR: dataDir,
    SORA_APP_ROOT: APP_ROOT,
  };
  if (fs.existsSync(agentExe)) {
    env.SORA_AGENT_EXE = agentExe;
  }

  logElectron(
    `Spawning backend: execPath="${process.execPath}" entry="${SERVER_ENTRY}" cwd="${APP_ROOT}" port=${serverPort} isPackaged=${app.isPackaged} agentExeExists=${fs.existsSync(agentExe)}`,
  );

  serverProcess = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: APP_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  logElectron(`Backend spawned with PID=${serverProcess.pid}`);

  const recordOutput = (prefix, chunk) => {
    const text = sanitizeLogLine(chunk.toString());
    process.stdout.write(`[${prefix}] ${text}`);
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed) {
        recentBackendLogs.push(`[${prefix}] ${trimmed}`);
        if (recentBackendLogs.length > 15) recentBackendLogs.shift();
        logElectron(`[${prefix}] ${trimmed}`);
      }
    }
  };

  serverProcess.stdout?.on('data', (d) => recordOutput('server:out', d));
  serverProcess.stderr?.on('data', (d) => recordOutput('server:err', d));
  serverProcess.on('exit', (code, signal) => {
    logElectron(`Backend process exited (code=${code}, signal=${signal}, isQuitting=${isQuitting})`);
    if (!isQuitting) {
      const tail = recentBackendLogs.slice(-5).join('\n');
      dialog.showErrorBox(
        'MYRAA backend stopped',
        `The MYRAA backend process exited unexpectedly (code ${code}, signal ${signal}).${tail ? `\n\nRecent logs:\n${tail}` : ''}`,
      );
      app.quit();
    }
  });
}

function stopBackend() {
  if (serverProcess && !serverProcess.killed) {
    try {
      if (process.platform === 'win32') {
        // Kill the whole tree so the auto-spawned Python agent goes too.
        spawn('taskkill', ['/pid', String(serverProcess.pid), '/T', '/F'], { windowsHide: true });
        spawn('taskkill', ['/IM', 'myraa-agent.exe', '/F'], { windowsHide: true });
      } else {
        serverProcess.kill('SIGTERM');
      }
    } catch {
      /* best-effort */
    }
  }
  serverProcess = null;
}

/** Poll the backend until our spawned child answers /api/health, or reject on exit/timeout. */
function waitForBackend(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      if (!serverProcess || serverProcess.exitCode !== null) {
        const code = serverProcess ? serverProcess.exitCode : 'unknown';
        return reject(new Error(`Backend process exited prematurely during startup (code ${code}).`));
      }
      const req = http.get(`http://127.0.0.1:${serverPort}/api/health`, (res) => {
        res.resume();
        if (res.statusCode === 200 && serverProcess && serverProcess.exitCode === null) {
          logElectron(`Backend health check succeeded on ${serverOrigin}/api/health`);
          resolve();
        } else if (Date.now() > deadline) {
          reject(new Error(`Backend health returned status ${res.statusCode}`));
        } else {
          setTimeout(tryOnce, 300);
        }
      });
      req.on('error', () => {
        if (Date.now() > deadline) {
          reject(new Error('Backend did not become ready in time.'));
        } else {
          setTimeout(tryOnce, 300);
        }
      });
      req.setTimeout(2000, () => req.destroy());
    };
    tryOnce();
  });
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------
function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 420,
    height: 300,
    frame: false,
    transparent: true,
    resizable: false,
    center: true,
    show: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: '#00000000',
    icon: fs.existsSync(APP_ICON) ? APP_ICON : undefined,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  splashWindow.loadFile(path.join(__dirname, 'splash.html'));
  splashWindow.on('closed', () => (splashWindow = null));
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 940,
    minHeight: 600,
    show: false, // revealed on ready-to-show to avoid a white flash
    backgroundColor: '#0a0a0f',
    autoHideMenuBar: true,
    title: 'MYRAA',
    icon: fs.existsSync(APP_ICON) ? APP_ICON : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
      backgroundThrottling: false,
    },
  });

  Menu.setApplicationMenu(null);

  // Open external links (http/https to non-local hosts) in the real browser
  // instead of navigating the app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http') && !url.startsWith(serverOrigin)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  mainWindow.once('ready-to-show', () => {
    if (splashWindow) splashWindow.close();
    mainWindow?.show();
    mainWindow?.focus();
  });

  mainWindow.on('close', (event) => {
    // If the floating companion is active on the desktop, hide mainWindow instead
    // of terminating the process so the Gemini Live voice session continues!
    if (!isQuitting && floatingWindow && !floatingWindow.isDestroyed() && floatingWindow.isVisible()) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on('closed', () => (mainWindow = null));

  mainWindow.loadURL(serverOrigin);
}

function getSafeFloatingPosition(width, height) {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { x: workX, y: workY, width: workW, height: workH } = primaryDisplay.workArea;

  if (floatingWindowBounds) {
    const clampedX = Math.max(workX, Math.min(floatingWindowBounds.x, workX + workW - width));
    const clampedY = Math.max(workY, Math.min(floatingWindowBounds.y, workY + workH - height));
    return { x: clampedX, y: clampedY };
  }

  return {
    x: workX + workW - width - 24,
    y: workY + workH - height - 24,
  };
}

function createFloatingWindow() {
  if (floatingWindow && !floatingWindow.isDestroyed()) {
    floatingWindow.show();
    floatingWindow.focus();
    return floatingWindow;
  }

  const width = 320;
  const height = 380;
  const pos = getSafeFloatingPosition(width, height);

  floatingWindow = new BrowserWindow({
    width,
    height,
    x: pos.x,
    y: pos.y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: floatingAlwaysOnTop,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: false,
    hasShadow: false,
    title: 'MYRAA Companion',
    icon: fs.existsSync(APP_ICON) ? APP_ICON : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });

  floatingWindow.on('moved', () => {
    if (floatingWindow && !floatingWindow.isDestroyed()) {
      const [x, y] = floatingWindow.getPosition();
      floatingWindowBounds = { x, y };
    }
  });

  floatingWindow.on('closed', () => {
    floatingWindow = null;
  });

  floatingWindow.loadURL(`${serverOrigin}/?mode=floating`);
  return floatingWindow;
}

function setupIpcHandlers() {
  ipcMain.handle('desktop:execute-tool', async (_event, payload) => {
    try {
      const tool = String(payload?.tool || '');
      let effectiveArgs = payload?.args && typeof payload.args === 'object' ? { ...payload.args } : {};
      if (tool === 'openApplication') {
        const rawKey = String(effectiveArgs.name ?? effectiveArgs.app ?? effectiveArgs.application ?? '').trim().toLowerCase();
        const aliasMap = {
          'file manager': 'file explorer',
          'filemanager': 'file explorer',
          'explorer': 'file explorer',
          'files': 'file explorer',
          'windows explorer': 'file explorer',
          'vs code': 'vscode',
          'visual studio code': 'vscode',
          'code': 'vscode',
        };
        if (aliasMap[rawKey]) {
          if ('name' in effectiveArgs) effectiveArgs.name = aliasMap[rawKey];
          else if ('app' in effectiveArgs) effectiveArgs.app = aliasMap[rawKey];
          else if ('application' in effectiveArgs) effectiveArgs.application = aliasMap[rawKey];
          else effectiveArgs.name = aliasMap[rawKey];
        }
      }

      const res = await fetch('http://127.0.0.1:8765/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool, args: effectiveArgs }),
      });
      const data = await res.json();
      if (data && data.ok) {
        return data.result ?? { result: 'Done.' };
      }
      return { error: data?.error || `Desktop agent error (${res.status})` };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.on('floating:open', () => {
    createFloatingWindow();
  });

  ipcMain.on('floating:close', () => {
    if (floatingWindow && !floatingWindow.isDestroyed()) {
      floatingWindow.hide();
    }
  });

  ipcMain.on('floating:toggle', () => {
    if (!floatingWindow || floatingWindow.isDestroyed()) {
      createFloatingWindow();
    } else if (floatingWindow.isVisible()) {
      floatingWindow.hide();
    } else {
      floatingWindow.show();
      floatingWindow.focus();
    }
  });

  ipcMain.on('floating:focus-main', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  ipcMain.on('floating:sync-state', (_event, state) => {
    if (floatingWindow && !floatingWindow.isDestroyed()) {
      floatingWindow.webContents.send('floating:state-updated', state);
    }
  });

  ipcMain.on('floating:request-state', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('floating:request-state');
    }
  });

  ipcMain.on('floating:toggle-mic', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('floating:toggle-mic');
    }
  });

  ipcMain.on('floating:set-always-on-top', (_event, val) => {
    floatingAlwaysOnTop = !!val;
    if (floatingWindow && !floatingWindow.isDestroyed()) {
      floatingWindow.setAlwaysOnTop(floatingAlwaysOnTop);
    }
  });

  ipcMain.on('floating:move-window', (_event, { dx, dy }) => {
    if (floatingWindow && !floatingWindow.isDestroyed()) {
      const [currX, currY] = floatingWindow.getPosition();
      const [w, h] = floatingWindow.getSize();
      const primaryDisplay = screen.getPrimaryDisplay();
      const { x: workX, y: workY, width: workW, height: workH } = primaryDisplay.workArea;

      const nextX = Math.max(workX, Math.min(currX + Math.round(dx), workX + workW - w));
      const nextY = Math.max(workY, Math.min(currY + Math.round(dy), workY + workH - h));

      floatingWindow.setPosition(nextX, nextY);
      floatingWindowBounds = { x: nextX, y: nextY };
    }
  });

  ipcMain.on('floating:context-menu', (event, currentSettings) => {
    if (!floatingWindow || floatingWindow.isDestroyed()) return;

    const menu = Menu.buildFromTemplate([
      {
        label: 'Return to Full App',
        click: () => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.show();
            mainWindow.focus();
          }
        },
      },
      { type: 'separator' },
      {
        label: 'Always on Top',
        type: 'checkbox',
        checked: floatingAlwaysOnTop,
        click: (item) => {
          floatingAlwaysOnTop = item.checked;
          floatingWindow?.setAlwaysOnTop(floatingAlwaysOnTop);
          event.sender.send('floating:setting-changed', { alwaysOnTop: floatingAlwaysOnTop });
        },
      },
      {
        label: 'Transparent Background',
        type: 'checkbox',
        checked: !!currentSettings?.transparentBackground,
        click: (item) => {
          event.sender.send('floating:setting-changed', { transparentBackground: item.checked });
        },
      },
      { type: 'separator' },
      {
        label: 'Hide Floating Avatar',
        click: () => {
          floatingWindow?.hide();
        },
      },
      {
        label: 'Exit MYRAA',
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]);

    menu.popup({ window: floatingWindow });
  });
}

// ---------------------------------------------------------------------------
// Bootstrap sequence
// ---------------------------------------------------------------------------
async function bootstrap() {
  app.setAppUserModelId('com.myraa.desktop');

  // Grant microphone, camera, and display-capture permissions to the local MYRAA origin
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const url = webContents.getURL() || '';
    if (url.startsWith(serverOrigin) || url.startsWith('http://localhost:') || url.startsWith('http://127.0.0.1')) {
      if (['media', 'MediaKeySystem', 'geolocation', 'notifications', 'fullscreen', 'pointerLock', 'display-capture'].includes(permission)) {
        return callback(true);
      }
    }
    callback(false);
  });

  // Enable navigator.mediaDevices.getDisplayMedia() in Electron for Vision / Screen Share
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
      if (sources && sources.length > 0) {
        callback({ video: sources[0] });
      } else {
        callback({});
      }
    } catch (err) {
      console.error('[Electron] getDisplayMedia error:', err);
      callback({});
    }
  });

  createSplashWindow();
  setupIpcHandlers();

  try {
    const port = await findAvailablePort(DEFAULT_SERVER_PORT, 20);
    startBackend(port);
    await waitForBackend(SERVER_READY_TIMEOUT_MS);
    createMainWindow();
  } catch (err) {
    logElectron(`Bootstrap error: ${err instanceof Error ? err.stack || err.message : String(err)}`);
    if (splashWindow) splashWindow.close();
    dialog.showErrorBox(
      'MYRAA failed to start',
      `${err instanceof Error ? err.message : String(err)}`,
    );
    app.quit();
  }
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
});

app.on('window-all-closed', () => {
  // If floating companion is still alive on desktop, don't quit
  if (floatingWindow && !floatingWindow.isDestroyed() && floatingWindow.isVisible()) {
    return;
  }
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  isQuitting = true;
  stopBackend();
});

process.on('exit', stopBackend);

