'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Pont entre le renderer et le processus principal.
 *
 * Le renderer n'a aucun acces a Node : il ne peut appeler que les canaux
 * enumeres ici. Chaque invocation renvoie directement la donnee utile, ou lance
 * une Error avec le message renvoye par le processus principal — ce qui permet
 * d'ecrire du try/catch classique cote interface.
 */

async function call(channel, ...args) {
  const result = await ipcRenderer.invoke(channel, ...args);
  if (!result || result.ok !== true) {
    throw new Error(result?.error || 'Erreur inconnue du launcher.');
  }
  return result.data;
}

/** Abonnement a un evenement pousse par le processus principal. */
function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('aethoria', {
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    close: () => ipcRenderer.send('window:close'),
  },

  app: {
    info: () => call('app:info'),
  },

  account: {
    get: () => call('account:get'),
    connecter: (pseudo) => call('account:connecter', pseudo),
  },

  settings: {
    get: () => call('settings:get'),
    save: (patch) => call('settings:save', patch),
    pickFolder: () => call('settings:pickFolder'),
    pickJava: () => call('settings:pickJava'),
  },

  modpack: {
    info: () => call('modpack:info'),
    optionalMods: () => call('modpack:optionalMods'),
    setOptionalMods: (ids) => call('modpack:setOptionalMods', ids),
  },

  server: {
    status: (target) => call('server:status', target),
  },

  game: {
    launch: () => call('game:launch'),
    isRunning: () => call('game:isRunning'),
    stop: () => call('game:stop'),
    repair: () => call('game:repair'),
    onStatus: (cb) => subscribe('game:status', cb),
    onProgress: (cb) => subscribe('game:progress', cb),
    onLog: (cb) => subscribe('game:log', cb),
    onFirstRun: (cb) => subscribe('game:firstRun', cb),
    onExit: (cb) => subscribe('game:exit', cb),
  },

  folders: {
    game: () => call('shell:openGameFolder'),
    logs: () => call('shell:openLogsFolder'),
    external: (url) => call('shell:openExternal', url),
  },

  updater: {
    onStatus: (cb) => subscribe('updater:status', cb),
    install: () => ipcRenderer.invoke('updater:install'),
  },
});
