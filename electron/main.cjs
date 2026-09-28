/* ===========================================================================
 * MYRAA — Electron Desktop Production Shell (Mishtron Labs)
 * ---------------------------------------------------------------------------
 * Responsibilities:
 *   1. Enforce a single running instance (com.myraa.desktop).
 *   2. Spawn the bundled native desktop control agent (myraa-agent.exe) on
 *      loopback 127.0.0.1:8765 solely for local OS control.
 *   3. Show a splash window while verifying the MYRAA production cloud backend
 *      (https://myraa-ai-q0h3.onrender.com), then load the production UI.
 *   4. Clean up the child desktop agent process on quit.
 * ========================================================================= */

'use strict';

const { app, BrowserWindow, Menu, shell, dialog, screen, ipcMain, session, desktopCapturer } = require('electron');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const fs = require('fs');

// Support custom isolated userData directory for fresh-install / upgrade testing
if (process.env.MYRAA_USER_DATA_DIR) {
  try {
    fs.mkdirSync(process.env.MYRAA_USER_DATA_DIR, { recursive: true });
    app.setPath('userData', process.env.MYRAA_USER_DATA_DIR);
  } catch {
    /* best-effort override */
  }
}

// --- Constants & Production Backend Configuration ---------------------------
const PRODUCTION_BACKEND_URL = (
  process.env.MYRAA_BACKEND_URL || 'https://myraa-ai-q0h3.onrender.com'
).replace(/\/+$/, '');
let serverOrigin = PRODUCTION_BACKEND_URL;
const SERVER_READY_TIMEOUT_MS = 40_000;

// In development we run from the repo root; when packaged the app files live in
// resources/app (asar-unpacked).
const APP_ROOT = app.isPackaged
  ? path.join(process.resourcesPath, 'app')
  : path.join(__dirname, '..');

const APP_ICON = path.join(APP_ROOT, 'assets', 'icon.ico');

/** @type {import('child_process').ChildProcess | null} */
let agentProcess = null;
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
    .replace(/myraa_(?:at|rt|rf)_[0-9A-Za-z_-]+/g, 'myraa_token_[REDACTED]')
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

// ---------------------------------------------------------------------------
// Single-instance guard — second launches focus the existing window
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
// Bundled Native Desktop Agent & Production Backend Lifecycle
// ---------------------------------------------------------------------------
function startBundledDesktopAgent() {
  const agentExe = app.isPackaged
    ? path.join(process.resourcesPath, 'agent', 'myraa-agent.exe')
    : path.join(APP_ROOT, 'agent_dist', 'myraa-agent', 'myraa-agent.exe');

  if (!fs.existsSync(agentExe)) {
    logElectron(`Bundled desktop agent not found at ${agentExe}; skipping standalone agent spawn.`);
    return;
  }

  try {
    const dataDir = app.getPath('userData');
    agentProcess = spawn(agentExe, [], {
      cwd: path.dirname(agentExe),
      env: {
        ...process.env,
        MYRAA_AGENT_HOST: '127.0.0.1',
        MYRAA_AGENT_PORT: '8765',
        MYRAA_DATA_DIR: dataDir,
        SORA_AGENT_HOST: '127.0.0.1',
        SORA_AGENT_PORT: '8765',
        SORA_DATA_DIR: dataDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    agentProcess.stdout?.on('data', (chunk) => {
      logElectron(`[agent:out] ${chunk.toString()}`);
    });
    agentProcess.stderr?.on('data', (chunk) => {
      logElectron(`[agent:err] ${chunk.toString()}`);
    });
    agentProcess.on('exit', (code, signal) => {
      logElectron(`Bundled desktop agent exited (code=${code}, signal=${signal})`);
    });
    logElectron(`Bundled desktop agent spawned (PID=${agentProcess.pid}, path="${agentExe}")`);
  } catch (err) {
    logElectron(`Failed to spawn bundled desktop agent: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function waitForProductionBackend(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const targetUrl = `${PRODUCTION_BACKEND_URL}/health`;
  const client = targetUrl.startsWith('https:') ? https : http;

  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const req = client.get(targetUrl, (res) => {
        res.resume();
        if (res.statusCode === 200) {
          logElectron(`Production backend health verified at ${targetUrl}`);
          resolve();
        } else if (Date.now() > deadline) {
          reject(new Error(`Production backend returned HTTP ${res.statusCode}`));
        } else {
          setTimeout(tryOnce, 500);
        }
      });
      req.on('error', (err) => {
        if (Date.now() > deadline) {
          reject(new Error(`Production backend unreachable at ${targetUrl}: ${err.message}`));
        } else {
          setTimeout(tryOnce, 500);
        }
      });
      req.setTimeout(5000, () => req.destroy());
    };
    tryOnce();
  });
}

function stopBackend() {
  if (agentProcess && !agentProcess.killed) {
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(agentProcess.pid), '/T', '/F'], { windowsHide: true });
      } else {
        agentProcess.kill('SIGTERM');
      }
    } catch {
      /* best-effort */
    }
  }
  agentProcess = null;

  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/IM', 'myraa-agent.exe', '/F'], { windowsHide: true });
    } catch {
      /* best-effort */
    }
  }
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

  // Open external links (http/https to non-backend hosts) in the real browser
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
    if (!process.env.MYRAA_HEADLESS_SMOKE) {
      mainWindow?.show();
      mainWindow?.focus();
    }
  });

  if (process.env.MYRAA_SMOKE_TEST_OUT) {
    const outFile = process.env.MYRAA_SMOKE_TEST_OUT;
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const report = await mainWindow.webContents.executeJavaScript(`
            (async () => {
              const healthRes = await fetch('/health').then(r => r.json()).catch(e => ({ error: String(e) }));
              const pairStatus = await fetch('/api/remote/pair-code/status').then(r => r.json()).catch(e => ({ error: String(e) }));
              let agentResult = null;
              for (let i = 0; i < 10; i++) {
                if (window.myraa && window.myraa.executeDesktopTool) {
                  const res = await window.myraa.executeDesktopTool('systemInfo', {});
                  if (res && !res.error) {
                    agentResult = res;
                    break;
                  }
                  agentResult = res;
                }
                await new Promise(r => setTimeout(r, 800));
              }
              return {
                href: window.location.href,
                origin: window.location.origin,
                protocol: window.location.protocol,
                title: document.title,
                isDesktop: Boolean(window.myraa && window.myraa.isDesktop),
                appVersion: window.myraa ? window.myraa.appVersion : null,
                productionBackendUrl: window.myraa ? window.myraa.productionBackendUrl : null,
                hasPairingModalOrUi: document.body.innerText.includes('Pairing') || document.body.innerText.includes('MYRAA'),
                storedSessionPresent: Boolean(localStorage.getItem('sora_remote_session')),
                health: healthRes,
                pairStatus,
                desktopAgentSystemInfo: agentResult,
              };
            })();
          `);
          fs.writeFileSync(outFile, JSON.stringify({
            ok: true,
            timestamp: new Date().toISOString(),
            execPath: process.execPath,
            userDataDir: app.getPath('userData'),
            isPackaged: app.isPackaged,
            serverOrigin,
            ...report,
          }, null, 2), 'utf-8');
        } catch (err) {
          fs.writeFileSync(outFile, JSON.stringify({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          }, null, 2), 'utf-8');
        } finally {
          isQuitting = true;
          app.quit();
        }
      }, 2500);
    });
  }

  mainWindow.on('close', (event) => {
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

  // Grant microphone, camera, and display-capture permissions to the MYRAA production origin
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const url = webContents.getURL() || '';
    if (url.startsWith(serverOrigin) || url.startsWith(PRODUCTION_BACKEND_URL)) {
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
    serverOrigin = PRODUCTION_BACKEND_URL;
    startBundledDesktopAgent();
    await waitForProductionBackend(SERVER_READY_TIMEOUT_MS);
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

