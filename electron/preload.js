'use strict';

// Sandboxed preload: only `electron` may be required here.
const { contextBridge, ipcRenderer } = require('electron');

const CHANNEL_RE = /^[a-zA-Z]+:[a-zA-Z]+$/;

/** UI prefs passed by main.js via additionalArguments, so the theme applies before first paint. */
function initialUiPrefs() {
  const arg = process.argv.find((a) => a.startsWith('--pc-ui='));
  if (!arg) return null;
  try {
    return JSON.parse(atob(arg.slice('--pc-ui='.length)));
  } catch {
    return null;
  }
}

function subscribe(channel, callback) {
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('api', {
  initialUiPrefs: initialUiPrefs(),

  invoke(channel, payload) {
    if (typeof channel !== 'string' || !CHANNEL_RE.test(channel)) {
      return Promise.resolve({
        ok: false,
        error: { message: 'Invalid channel.', code: 'FORBIDDEN' },
      });
    }
    return ipcRenderer.invoke(channel, payload);
  },

  /** Main process is closing (backup in progress). Returns an unsubscribe fn. */
  onAppClosing: (callback) => subscribe('app:closing', callback),

  /** Startup stage for the loader: opening | checking | backup | migrating | ready. */
  onStartupProgress: (callback) => subscribe('app:startupProgress', callback),
});
