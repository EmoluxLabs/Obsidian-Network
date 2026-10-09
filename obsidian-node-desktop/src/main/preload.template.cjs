'use strict';
/**
 * Preload (sandboxed, context-isolated).
 *
 * The ONLY thing the renderer gets is `window.obsidian`, with `invoke` for the channels in the
 * allowlist below and `on` for the three event channels. It exposes no Node API, no
 * filesystem, no shell and no raw ipcRenderer. The allowlist is generated at build time from
 * src/shared/contract.ts, so this file and the main process can never disagree.
 */
const { contextBridge, ipcRenderer } = require('electron');

const ALLOWED = new Set(/*CHANNELS*/[]);
const EVENTS = new Set(['event:node-state', 'event:chain', 'event:log']);

contextBridge.exposeInMainWorld('obsidian', {
  invoke(channel, payload) {
    if (typeof channel !== 'string' || !ALLOWED.has(channel)) {
      return Promise.reject(new Error('That action is not available.'));
    }
    return ipcRenderer.invoke(channel, payload);
  },
  on(event, listener) {
    if (typeof event !== 'string' || !EVENTS.has(event) || typeof listener !== 'function') return () => {};
    const wrapped = (_e, data) => listener(data);
    ipcRenderer.on(event, wrapped);
    return () => ipcRenderer.removeListener(event, wrapped);
  },
});
