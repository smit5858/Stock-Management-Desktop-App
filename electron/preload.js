'use strict';

// Sandboxed preload: only `electron` may be required here.
const { contextBridge, ipcRenderer } = require('electron');

const CHANNEL_RE = /^[a-zA-Z]+:[a-zA-Z]+$/;

contextBridge.exposeInMainWorld('api', {
  invoke(channel, payload) {
    if (typeof channel !== 'string' || !CHANNEL_RE.test(channel)) {
      return Promise.resolve({
        ok: false,
        error: { message: 'Invalid channel.', code: 'FORBIDDEN' },
      });
    }
    return ipcRenderer.invoke(channel, payload);
  },

  /** Main process tells the UI it is closing (backup in progress). Returns an unsubscribe fn. */
  onAppClosing(callback) {
    const listener = () => callback();
    ipcRenderer.on('app:closing', listener);
    return () => ipcRenderer.removeListener('app:closing', listener);
  },
});
