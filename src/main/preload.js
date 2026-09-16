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
    restore: () => ipcRenderer.send('window:restore'),
    hide: () => ipcRenderer.send('window:hide'),
    setZoom: (factor) => ipcRenderer.send('window:setZoom', factor),
    close: () => ipcRenderer.send('window:close'),
  },

  app: {
    info: () => call('app:info'),
    system: () => call('app:system'),
    notify: (title, body) => call('app:notify', { title, body }),
    copyText: (text) => call('app:copyText', text),
    checkup: () => call('checkup:run'),
    onTrayPlay: (cb) => subscribe('tray:play', cb),
    onShortcutPlay: (cb) => subscribe('shortcut:play', cb),
    createPlayShortcut: () => call('shortcut:create'),
  },

  account: {
    get: () => call('account:get'),
    valider: (pseudo) => call('account:valider', pseudo),
    connecter: (pseudo) => call('account:connecter', pseudo),
  },

  stats: {
    get: () => call('stats:get'),
  },

  settings: {
    get: () => call('settings:get'),
    save: (patch) => call('settings:save', patch),
    pickFolder: () => call('settings:pickFolder'),
    pickJava: () => call('settings:pickJava'),
  },

  modpack: {
    info: () => call('modpack:info'),
    pending: () => call('modpack:pending'),
    optionalMods: () => call('modpack:optionalMods'),
    setOptionalMods: (ids) => call('modpack:setOptionalMods', ids),
  },

  server: {
    status: (target) => call('server:status', target),
  },

  screenshots: {
    list: () => call('screenshots:list'),
    open: (name) => call('screenshots:open', name),
    folder: () => call('screenshots:folder'),
    copy: (name) => call('screenshots:copy', name),
    trash: (name) => call('screenshots:trash', name),
  },

  storage: {
    info: () => call('storage:info'),
    clean: () => call('storage:clean'),
  },

  game: {
    launch: () => call('game:launch'),
    prepare: () => call('game:prepare'),
    focus: () => call('game:focus'),
    isRunning: () => call('game:isRunning'),
    stop: () => call('game:stop'),
    repair: () => call('game:repair'),
    onStatus: (cb) => subscribe('game:status', cb),
    onProgress: (cb) => subscribe('game:progress', cb),
    onLog: (cb) => subscribe('game:log', cb),
    onFirstRun: (cb) => subscribe('game:firstRun', cb),
    onReady: (cb) => subscribe('game:ready', cb),
    onExit: (cb) => subscribe('game:exit', cb),
  },

  options: {
    preset: (name) => call('options:preset', name),
    reset: () => call('options:reset'),
    backup: () => call('options:backup'),
    backups: () => call('options:backups'),
    restore: (name) => call('options:restore', name),
  },

  folders: {
    game: () => call('shell:openGameFolder'),
    logs: () => call('shell:openLogsFolder'),
    external: (url) => call('shell:openExternal', url),
  },

  updater: {
    onStatus: (cb) => subscribe('updater:status', cb),
    install: () => ipcRenderer.invoke('updater:install'),
    check: () => call('updater:check'),
  },
});
