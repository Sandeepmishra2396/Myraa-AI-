/* ===========================================================================
 * MYRAA — Electron Desktop Production Shell (Mishtron Labs)
 * ---------------------------------------------------------------------------
 * Phase 13A-WIN.6: One-Click Windows App + Cloud/Local Hybrid Runtime
 *
 * Responsibilities:
 *   1. Enforce a single running instance (com.myraa.desktop).
 *   2. Determine an available local loopback port dynamically (3000..3019).
 *   3. Start the local MYRAA Node backend on 127.0.0.1:<PORT> and verify /health.
 *   4. Start the bundled native desktop control agent (myraa-agent.exe) on
 *      loopback 127.0.0.1:8765 solely for local OS control and verify /health.
 *   5. Load the local UI into BrowserWindow with zero terminal/npm needed.
 *   6. Handle offline resilience: starts cleanly without internet, keeping local
 *      device capabilities functional while marking cloud services OFFLINE.
 *   7. Implement auto-recovery with bounded retry/backoff for crashed children.
 *   8. Cleanly shut down all child processes on exit with zero orphan processes.
 * ========================================================================= */

'use strict';

const { app, BrowserWindow, Menu, shell, dialog, screen, ipcMain, session, desktopCapturer } = require('electron');
const path = require('path');
const http = require('http');
const https = require('https');
const net = require('net');
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

// Canonical desktop runtime environment markers
process.env.SORA_LAUNCHED_BY = 'electron';
process.env.MYRAA_LOCAL_DESKTOP = 'true';

// --- Constants & Production Cloud Configuration ------------------------------
const PRODUCTION_BACKEND_URL = (
  process.env.MYRAA_BACKEND_URL || 'https://myraa-ai-q0h3.onrender.com'
).replace(/\/+$/, '');
const SERVER_READY_TIMEOUT_MS = 40_000;

const APP_ROOT = app.isPackaged
  ? path.join(process.resourcesPath, 'app')
  : path.join(__dirname, '..');

const APP_ICON = path.join(APP_ROOT, 'assets', 'icon.ico');

// Runtime state
let localBackendPort = 3000;
let localBackendUrl = 'http://127.0.0.1:3000';
let serverOrigin = localBackendUrl;

/** @type {import('child_process').ChildProcess | null} */
let backendProcess = null;
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

// Health & Diagnostic tracking
let isBackendHealthy = false;
let agentStatus = 'STARTING'; // 'ONLINE' | 'OFFLINE' | 'STARTING' | 'ERROR'
let agentToolCount = 0;
let agentVersion = '1.0.0';
let cloudStatus = 'CONNECTING'; // 'CONNECTED' | 'OFFLINE' | 'CONNECTING'
let backendRestartCount = 0;
let agentRestartCount = 0;
const MAX_CHILD_RESTARTS = 3;

/**
 * Scrubs credentials, API keys, or tokens before writing to log files.
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
// Dynamic Local Port Selection (3000 -> 3001 -> ... -> 3019)
// ---------------------------------------------------------------------------
function testPortFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once('error', () => {
      resolve(false);
    });
    tester.once('listening', () => {
      tester.close(() => resolve(true));
    });
    tester.listen(port, host);
  });
}

async function findAvailableLocalPort(startPort = 3000, endPort = 3019, host = '127.0.0.1') {
  for (let p = startPort; p <= endPort; p++) {
    const free = await testPortFree(p, host);
    if (free) {
      logElectron(`Dynamic port scan selected available local port: ${p}`);
      return p;
    }
  }
  logElectron(`Warning: No free port found in range ${startPort}-${endPort}, falling back to ${startPort}`);
  return startPort;
}

// ---------------------------------------------------------------------------
// Local Node Backend Lifecycle
// ---------------------------------------------------------------------------
function resolveServerBundlePath() {
  const candidates = [
    path.join(APP_ROOT, 'dist', 'server.cjs'),
    path.join(process.resourcesPath || '', 'app', 'dist', 'server.cjs'),
    path.join(__dirname, '..', 'dist', 'server.cjs'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[0];
}

function startLocalBackend(port) {
  const serverScript = resolveServerBundlePath();
  if (!fs.existsSync(serverScript)) {
    logElectron(`Local backend bundle not found at ${serverScript}. Cannot start local backend process.`);
    return;
  }

  try {
    const dataDir = app.getPath('userData');
    logElectron(`Starting local MYRAA Node backend on 127.0.0.1:${port} (script: "${serverScript}")...`);

    // In both dev and packaged desktop app, process.execPath has full Node.js runtime embedded
    // via ELECTRON_RUN_AS_NODE=1. User needs NO node/npm installed!
    backendProcess = spawn(process.execPath, [serverScript], {
      cwd: APP_ROOT,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        PORT: String(port),
        HOST: '127.0.0.1',
        NODE_ENV: 'production',
        SORA_LAUNCHED_BY: 'electron',
        MYRAA_LOCAL_DESKTOP: 'true',
        MYRAA_LOCAL_BACKEND_PORT: String(port),
        MYRAA_LOCAL_BACKEND_URL: `http://127.0.0.1:${port}`,
        MYRAA_DATA_DIR: dataDir,
        SORA_DATA_DIR: dataDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    backendProcess.stdout?.on('data', (chunk) => {
      const msg = chunk.toString();
      logElectron(`[backend:out] ${msg}`);
    });

    backendProcess.stderr?.on('data', (chunk) => {
      const msg = chunk.toString();
      logElectron(`[backend:err] ${msg}`);
    });

    backendProcess.on('exit', (code, signal) => {
      logElectron(`Local backend process exited (code=${code}, signal=${signal})`);
      isBackendHealthy = false;
      backendProcess = null;

      // Auto-recovery with bounded retries if unexpected crash occurred
      if (!isQuitting && backendRestartCount < MAX_CHILD_RESTARTS) {
        backendRestartCount++;
        const backoffMs = backendRestartCount * 1000;
        logElectron(`Attempting auto-recovery of local backend (attempt ${backendRestartCount}/${MAX_CHILD_RESTARTS}) in ${backoffMs}ms...`);
        setTimeout(async () => {
          if (isQuitting) return;
          startLocalBackend(localBackendPort);
          try {
            await waitForLocalBackend(localBackendPort, 15000);
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.loadURL(localBackendUrl);
            }
            broadcastSystemStatus();
          } catch (err) {
            logElectron(`Backend recovery attempt failed: ${err.message}`);
          }
        }, backoffMs);
      }
    });

    logElectron(`Local backend process spawned (PID=${backendProcess.pid})`);
  } catch (err) {
    logElectron(`Failed to spawn local backend process: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Polls local backend /health and strictly verifies port ownership.
 * Checks that response is HTTP 200 AND body JSON has service === 'myraa-backend'.
 */
function waitForLocalBackend(port, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  const targetUrl = `http://127.0.0.1:${port}/health`;

  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const req = http.get(targetUrl, (res) => {
        let rawBody = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { rawBody += chunk; });
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              const data = JSON.parse(rawBody);
              // Strict verification of port ownership
              if (data && data.service === 'myraa-backend') {
                logElectron(`Local backend verified at ${targetUrl} (service=${data.service}, uptime=${data.uptime}s)`);
                isBackendHealthy = true;
                resolve();
                return;
              }
            } catch {
              /* not MYRAA backend yet */
            }
          }

          if (Date.now() > deadline) {
            reject(new Error(`Port ${port} does not belong to MYRAA backend or returned HTTP ${res.statusCode}`));
          } else {
            setTimeout(tryOnce, 350);
          }
        });
      });

      req.on('error', (err) => {
        if (Date.now() > deadline) {
          reject(new Error(`Local backend unreachable at ${targetUrl}: ${err.message}`));
        } else {
          setTimeout(tryOnce, 350);
        }
      });

      req.setTimeout(2500, () => req.destroy());
    };
    tryOnce();
  });
}

// ---------------------------------------------------------------------------
// Bundled Native Desktop Agent Lifecycle (myraa-agent.exe)
// ---------------------------------------------------------------------------
function resolveDesktopAgentPath() {
  const candidates = [
    path.join(process.resourcesPath || '', 'agent', 'myraa-agent.exe'),
    path.join(APP_ROOT, 'agent_dist', 'myraa-agent', 'myraa-agent.exe'),
    path.join(__dirname, '..', 'agent_dist', 'myraa-agent', 'myraa-agent.exe'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[0];
}

function startBundledDesktopAgent() {
  const agentExe = resolveDesktopAgentPath();

  if (!fs.existsSync(agentExe)) {
    logElectron(`Bundled desktop agent not found at ${agentExe}; skipping agent spawn.`);
    agentStatus = 'OFFLINE';
    return;
  }

  try {
    const dataDir = app.getPath('userData');
    agentStatus = 'STARTING';

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
      agentProcess = null;
      agentStatus = 'OFFLINE';
      broadcastSystemStatus();

      // Auto-recovery with bounded retries if unexpected crash occurred
      if (!isQuitting && agentRestartCount < MAX_CHILD_RESTARTS) {
        agentRestartCount++;
        const backoffMs = agentRestartCount * 1200;
        logElectron(`Attempting auto-recovery of desktop agent (attempt ${agentRestartCount}/${MAX_CHILD_RESTARTS}) in ${backoffMs}ms...`);
        setTimeout(async () => {
          if (isQuitting) return;
          startBundledDesktopAgent();
          try {
            await waitForDesktopAgent(10000);
            broadcastSystemStatus();
          } catch (err) {
            logElectron(`Agent recovery attempt failed: ${err.message}`);
          }
        }, backoffMs);
      }
    });

    logElectron(`Bundled desktop agent spawned (PID=${agentProcess.pid}, path="${agentExe}")`);
  } catch (err) {
    logElectron(`Failed to spawn bundled desktop agent: ${err instanceof Error ? err.message : String(err)}`);
    agentStatus = 'ERROR';
  }
}

function waitForDesktopAgent(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  const targetUrl = 'http://127.0.0.1:8765/health';

  return new Promise((resolve) => {
    const tryOnce = () => {
      const req = http.get(targetUrl, (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              const data = JSON.parse(raw);
              if (data && (data.status === 'ok' || data.status === 'online')) {
                agentStatus = 'ONLINE';
                agentToolCount = data.tool_count || (Array.isArray(data.tools) ? data.tools.length : 0);
                agentVersion = data.version || '1.0.0';
                logElectron(`Desktop agent verified online at ${targetUrl} (${agentToolCount} tools registered)`);
                resolve(true);
                return;
              }
            } catch {
              /* continue polling */
            }
          }

          if (Date.now() > deadline) {
            logElectron(`Desktop agent health check timed out at ${targetUrl}`);
            agentStatus = 'ERROR';
            resolve(false);
          } else {
            setTimeout(tryOnce, 400);
          }
        });
      });

      req.on('error', () => {
        if (Date.now() > deadline) {
          logElectron(`Desktop agent not reachable at ${targetUrl}`);
          agentStatus = 'ERROR';
          resolve(false);
        } else {
          setTimeout(tryOnce, 400);
        }
      });

      req.setTimeout(2000, () => req.destroy());
    };
    tryOnce();
  });
}

// ---------------------------------------------------------------------------
// Cloud Services Connectivity Probe (Non-blocking, Offline Resilient)
// ---------------------------------------------------------------------------
function probeCloudConnectivity() {
  const targetUrl = `${PRODUCTION_BACKEND_URL}/health`;
  const client = targetUrl.startsWith('https:') ? https : http;

  try {
    const req = client.get(targetUrl, (res) => {
      res.resume();
      const prev = cloudStatus;
      cloudStatus = res.statusCode === 200 ? 'CONNECTED' : 'OFFLINE';
      if (prev !== cloudStatus) {
        logElectron(`Cloud connectivity state changed: ${prev} -> ${cloudStatus}`);
        broadcastSystemStatus();
      }
    });

    req.on('error', () => {
      const prev = cloudStatus;
      cloudStatus = 'OFFLINE';
      if (prev !== cloudStatus) {
        logElectron(`Cloud connectivity state changed: ${prev} -> OFFLINE (network unreachable)`);
        broadcastSystemStatus();
      }
    });

    req.setTimeout(4000, () => req.destroy());
  } catch {
    cloudStatus = 'OFFLINE';
  }
}

function waitForProductionBackend(timeoutMs = SERVER_READY_TIMEOUT_MS) {
  probeCloudConnectivity();
  return Promise.resolve(cloudStatus);
}

function broadcastSystemStatus() {
  const statusPayload = getSystemStatusPayload();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('desktop:system-status-updated', statusPayload);
  }
  if (floatingWindow && !floatingWindow.isDestroyed()) {
    floatingWindow.webContents.send('desktop:system-status-updated', statusPayload);
  }
}

function getSystemStatusPayload() {
  return {
    runtimeMode: 'DESKTOP_LOCAL',
    isDesktop: true,
    backend: isBackendHealthy ? 'LOCAL' : 'OFFLINE',
    backendUrl: localBackendUrl,
    localBackendPort,
    desktopAgent: agentStatus,
    desktopAgentUrl: 'http://127.0.0.1:8765',
    desktopAgentToolCount: agentToolCount,
    desktopAgentVersion: agentVersion,
    gemini: cloudStatus === 'CONNECTED' ? 'READY' : 'OFFLINE',
    cloudServices: cloudStatus,
    cloudUrl: PRODUCTION_BACKEND_URL,
    security: 'ACTIVE',
    isOfflineMode: cloudStatus === 'OFFLINE',
  };
}

// ---------------------------------------------------------------------------
// Clean Process Shutdown — Zero Orphan Processes Guaranteed
// ---------------------------------------------------------------------------
function stopAllProcesses() {
  isQuitting = true;

  // 1. Close windows
  try {
    if (floatingWindow && !floatingWindow.isDestroyed()) {
      floatingWindow.destroy();
    }
  } catch { /* best-effort */ }
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.destroy();
    }
  } catch { /* best-effort */ }

  // 2. Kill local Node backend process
  if (backendProcess && !backendProcess.killed) {
    try {
      logElectron(`Stopping local backend child process (PID=${backendProcess.pid})...`);
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(backendProcess.pid), '/T', '/F'], { windowsHide: true });
      } else {
        backendProcess.kill('SIGTERM');
      }
    } catch { /* best-effort */ }
    backendProcess = null;
  }

  // 3. Kill desktop Python agent process
  if (agentProcess && !agentProcess.killed) {
    try {
      logElectron(`Stopping desktop agent child process (PID=${agentProcess.pid})...`);
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(agentProcess.pid), '/T', '/F'], { windowsHide: true });
      } else {
        agentProcess.kill('SIGTERM');
      }
    } catch { /* best-effort */ }
    agentProcess = null;
  }

  // 4. Fallback cleanup by image name on Windows to prevent orphaned myraa-agent.exe
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/IM', 'myraa-agent.exe', '/F'], { windowsHide: true });
    } catch { /* best-effort */ }
  }
}

// ---------------------------------------------------------------------------
// Windows Management
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
    show: false, // revealed on ready-to-show to prevent flash
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

  // Open external links (non-local hosts) in default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http') && !url.startsWith(serverOrigin) && !url.startsWith(localBackendUrl)) {
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

  // Automated smoke testing harness support
  if (process.env.MYRAA_SMOKE_TEST_OUT) {
    const outFile = process.env.MYRAA_SMOKE_TEST_OUT;
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const report = await mainWindow.webContents.executeJavaScript(`
            (async () => {
              const healthRes = await fetch('/health').then(r => r.json()).catch(e => ({ error: String(e) }));
              const configRes = await fetch('/api/config').then(r => r.json()).catch(e => ({ error: String(e) }));
              let agentResult = null;
              for (let i = 0; i < 5; i++) {
                if (window.myraa && window.myraa.executeDesktopTool) {
                  const res = await window.myraa.executeDesktopTool('systemInfo', {});
                  if (res && !res.error) {
                    agentResult = res;
                    break;
                  }
                  agentResult = res;
                }
                await new Promise(r => setTimeout(r, 600));
              }
              return {
                href: window.location.href,
                origin: window.location.origin,
                protocol: window.location.protocol,
                title: document.title,
                isDesktop: Boolean(window.myraa && window.myraa.isDesktop),
                runtimeMode: window.myraa ? window.myraa.runtimeMode : null,
                localBackendUrl: window.myraa ? window.myraa.localBackendUrl : null,
                localBackendPort: window.myraa ? window.myraa.localBackendPort : null,
                appVersion: window.myraa ? window.myraa.appVersion : null,
                health: healthRes,
                config: configRes,
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
            localBackendPort,
            localBackendUrl,
            serverOrigin,
            agentStatus,
            cloudStatus,
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

// ---------------------------------------------------------------------------
// IPC Handlers
// ---------------------------------------------------------------------------
function setupIpcHandlers() {
  // System status query
  ipcMain.handle('desktop:get-system-status', async () => {
    return getSystemStatusPayload();
  });

  // Manually retry starting desktop agent
  ipcMain.handle('desktop:retry-agent', async () => {
    logElectron('Renderer requested manual retry of desktop agent...');
    if (!agentProcess || agentProcess.killed) {
      startBundledDesktopAgent();
    }
    await waitForDesktopAgent(8000);
    broadcastSystemStatus();
    return getSystemStatusPayload();
  });

  // Execute native desktop agent tool on loopback 127.0.0.1:8765
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

  // Floating companion window controls
  ipcMain.on('floating:open', () => createFloatingWindow());
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
// Bootstrap Sequence
// ---------------------------------------------------------------------------
async function bootstrap() {
  app.setAppUserModelId('com.myraa.desktop');

  createSplashWindow();
  setupIpcHandlers();

  try {
    // 1. Determine available local port dynamically
    localBackendPort = await findAvailableLocalPort(3000, 3019, '127.0.0.1');
    localBackendUrl = `http://127.0.0.1:${localBackendPort}`;
    serverOrigin = localBackendUrl;

    // Export discovery variables for preload script
    process.env.MYRAA_LOCAL_BACKEND_PORT = String(localBackendPort);
    process.env.MYRAA_LOCAL_BACKEND_URL = localBackendUrl;

    // Grant media permissions to the local origin and production origin
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
      const url = webContents.getURL() || '';
      if (url.startsWith(serverOrigin) || url.startsWith('http://127.0.0.1') || url.startsWith(PRODUCTION_BACKEND_URL)) {
        if (['media', 'MediaKeySystem', 'geolocation', 'notifications', 'fullscreen', 'pointerLock', 'display-capture'].includes(permission)) {
          return callback(true);
        }
      }
      callback(false);
    });

    session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
      try {
        const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
        if (sources && sources.length > 0) {
          callback({ video: sources[0] });
        } else {
          callback({});
        }
      } catch (err) {
        logElectron(`getDisplayMedia error: ${err.message}`);
        callback({});
      }
    });

    // 2. Start local Node backend
    startLocalBackend(localBackendPort);

    // 3. Start bundled desktop agent
    startBundledDesktopAgent();

    // 4. Wait for local backend health check
    await waitForLocalBackend(localBackendPort, 30000);

    // 5. Wait for desktop agent (non-fatal if offline, records diagnostic state)
    await waitForDesktopAgent(8000);

    // 6. Non-blocking cloud connectivity check (offline resilience)
    waitForProductionBackend(SERVER_READY_TIMEOUT_MS);
    setInterval(probeCloudConnectivity, 30000);

    // 7. Load local UI into main window
    createMainWindow();
    logElectron(`MYRAA Desktop runtime initialized successfully at ${localBackendUrl}`);
  } catch (err) {
    logElectron(`Bootstrap error: ${err instanceof Error ? err.stack || err.message : String(err)}`);
    if (splashWindow) splashWindow.close();
    dialog.showErrorBox(
      'MYRAA failed to start',
      `Failed to initialize local MYRAA runtime:\n${err instanceof Error ? err.message : String(err)}`,
    );
    stopAllProcesses();
    app.quit();
  }
}

// ---------------------------------------------------------------------------
// App Lifecycle
// ---------------------------------------------------------------------------
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
});

app.on('window-all-closed', () => {
  if (floatingWindow && !floatingWindow.isDestroyed() && floatingWindow.isVisible()) {
    return;
  }
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  isQuitting = true;
  stopAllProcesses();
});

app.on('will-quit', () => {
  isQuitting = true;
  stopAllProcesses();
});

process.on('exit', stopAllProcesses);
