/* ===========================================================================
 * MYRAA — Electron preload
 * ---------------------------------------------------------------------------
 * Runs in an isolated context and exposes a minimal, explicit API surface to
 * the renderer via contextBridge. In Phase 1 this only advertises that the UI
 * is running inside the desktop shell (so the web UI can adapt if it wants);
 * tray/notification/window controls are added alongside those features.
 * ========================================================================= */

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('myraa', {
  isDesktop: true,
  platform: process.platform,
  version: process.versions.electron,

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
});

