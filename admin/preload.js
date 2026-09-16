'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/** Pont vers le processus principal : l'interface n'a aucun acces a Node. */

async function call(channel, ...args) {
  const result = await ipcRenderer.invoke(channel, ...args);
  if (!result || result.ok !== true) throw new Error(result?.error || 'Erreur inconnue.');
  return result.data;
}

contextBridge.exposeInMainWorld('admin', {
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    close: () => ipcRenderer.send('window:close'),
  },
  connection: {
    saved: () => call('connection:saved'),
    connect: (options) => call('connection:connect', options),
    disconnect: () => call('connection:disconnect'),
    forget: () => call('connection:forget'),
    onLost: (cb) => ipcRenderer.on('connection:lost', () => cb()),
  },
  players: {
    online: () => call('players:online'),
    avatar: (pseudo) => call('players:avatar', pseudo),
    act: (action) => call('players:act', action),
    inventory: (pseudo, container) => call('players:inventory', pseudo, container),
    info: (pseudo) => call('players:info', pseudo),
  },
  console: {
    run: (command) => call('console:run', command),
  },
  journal: {
    list: () => call('journal:list'),
  },
  durations: () => call('durations'),
});
