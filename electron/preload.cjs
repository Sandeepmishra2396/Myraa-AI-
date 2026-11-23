/* ===========================================================================
 * MYRAA — Electron Preload (Mishtron Labs)
 * ---------------------------------------------------------------------------
 * Phase 13A-WIN.6: Local Desktop Application + Cloud/Local Hybrid Runtime
 *
 * Runs in an isolated context and exposes a minimal, explicit, typed API surface
 * to the renderer via contextBridge. Zero Node API leakage, contextIsolation: true.
 * ========================================================================= */

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const localBackendUrl = (
  process.env.MYRAA_LOCAL_BACKEND_URL || 'http://127.0.0.1:3000'
).replace(/\/+$/, '');

const localBackendPort = parseInt(
  process.env.MYRAA_LOCAL_BACKEND_PORT ||
  (localBackendUrl.match(/:(\d+)$/) ? localBackendUrl.match(/:(\d+)$/)[1] : '3000'),
  10
);

const cloudBackendUrl = (
  process.env.MYRAA_BACKEND_URL || 'https://myraa-ai-q0h3.onrender.com'
).replace(/\/+$/, '');

const myraaApi = {
  isDesktop: true,
  runtimeMode: 'DESKTOP_LOCAL',
  platform: process.platform,
  version: process.versions.electron,
  appId: 'com.myraa.desktop',
  productName: 'MYRAA',
  publisher: 'Mishtron Labs',
  appVersion: '1.0.0',

  // Canonical runtime URLs
  localBackendUrl,
  localBackendPort,
  cloudBackendUrl,
  productionBackendUrl: 'https://myraa-ai-q0h3.onrender.com',
  desktopAgentUrl: 'http://127.0.0.1:8765',

  // System diagnostic & health inspection
  getSystemStatus: () => ipcRenderer.invoke('desktop:get-system-status'),
  retryDesktopAgent: () => ipcRenderer.invoke('desktop:retry-agent'),
  onSystemStatus: (callback) => {
    const handler = (_event, status) => callback(status);
    ipcRenderer.on('desktop:system-status-updated', handler);
    return () => ipcRenderer.removeListener('desktop:system-status-updated', handler);
  },

  // Window controls
  openFloating: () => ipcRenderer.send('floating:open'),
  closeFloating: () => ipcRenderer.send('floating:close'),
  toggleFloating: () => ipcRenderer.send('floating:toggle'),
  focusMain: () => ipcRenderer.send('floating:focus-main'),
  moveFloatingWindow: (dx, dy) => ipcRenderer.send('floating:move-window', { dx, dy }),
  setAlwaysOnTop: (val) => ipcRenderer.send('floating:set-always-on-top', val),

  // State synchronization
  syncFloatingState: (state) => ipcRenderer.send('floating:sync-state', state),
  requestFloatingState: () => ipcRenderer.send('floating:request-state'),
  onFloatingState: (callback) => {
    const handler = (_event, state) => callback(state);
    ipcRenderer.on('floating:state-updated', handler);
    return () => ipcRenderer.removeListener('floating:state-updated', handler);
  },
  onFloatingStateRequest: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('floating:request-state', handler);
    return () => ipcRenderer.removeListener('floating:request-state', handler);
  },

  // Interactions
  toggleMic: () => ipcRenderer.send('floating:toggle-mic'),
  onToggleMic: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('floating:toggle-mic', handler);
    return () => ipcRenderer.removeListener('floating:toggle-mic', handler);
  },

  // Context menu
  showFloatingContextMenu: (options) => ipcRenderer.send('floating:context-menu', options),
  onFloatingSetting: (callback) => {
    const handler = (_event, setting) => callback(setting);
    ipcRenderer.on('floating:setting-changed', handler);
    return () => ipcRenderer.removeListener('floating:setting-changed', handler);
  },

  // Native Desktop Agent execution bridge (loopback 127.0.0.1:8765)
  executeDesktopTool: (tool, args) => ipcRenderer.invoke('desktop:execute-tool', { tool, args }),
};

contextBridge.exposeInMainWorld('myraa', myraaApi);
contextBridge.exposeInMainWorld('electronAPI', myraaApi);
