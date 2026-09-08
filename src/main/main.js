'use strict';

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, shell, dialog, Menu } = require('electron');
const config = require('../shared/config');
const paths = require('./game/paths');
const store = require('./store');
const auth = require('./auth');
const launcher = require('./game/launcher');
const modpack = require('./game/modpack');
const serverStatus = require('./game/serverStatus');
const pkg = require('../../package.json');

const isDev = process.argv.includes('--dev');

// Une seule instance : deux launchers ouverts sur le meme dossier de jeu se
// marcheraient dessus pendant les telechargements.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let mainWindow = null;

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 680,
    minWidth: 940,
    minHeight: 600,
    frame: false,             // barre de titre dessinee par le renderer
    backgroundColor: '#0b0d13',
    show: false,
    icon: path.join(__dirname, '..', '..', 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  Menu.setApplicationMenu(null);
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });

  // Toute navigation externe part dans le navigateur du systeme : la fenetre du
  // launcher ne doit jamais devenir un navigateur generaliste.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

/* ------------------------------------------------------------------ *
 *  Mises a jour automatiques du launcher (GitHub Releases)
 * ------------------------------------------------------------------ */

function setupAutoUpdater() {
  if (isDev) return;
  let autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch {
    return; // module absent : le launcher fonctionne, sans mise a jour auto
  }

  autoUpdater.autoDownload = true;
  autoUpdater.on('update-available', (info) => send('updater:status', { state: 'available', version: info.version }));
  autoUpdater.on('download-progress', (p) => send('updater:status', { state: 'downloading', percent: p.percent }));
  autoUpdater.on('update-downloaded', (info) => send('updater:status', { state: 'ready', version: info.version }));
  autoUpdater.on('error', (err) => send('updater:status', { state: 'error', message: String(err.message || err) }));

  ipcMain.handle('updater:install', () => {
    autoUpdater.quitAndInstall();
  });

  autoUpdater.checkForUpdates().catch(() => {
    send('updater:status', { state: 'error', message: 'Verification des mises a jour impossible.' });
  });
}

/* ------------------------------------------------------------------ *
 *  Canaux IPC
 * ------------------------------------------------------------------ */

/** Enveloppe un handler pour renvoyer { ok, data } ou { ok:false, error }. */
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });
}

function registerIpc() {
  // --- Fenetre ---
  ipcMain.on('window:minimize', () => mainWindow?.minimize());
  ipcMain.on('window:close', () => mainWindow?.close());

  // --- Informations generales ---
  handle('app:info', () => ({
    name: config.appName,
    version: pkg.version,
    server: config.server,
    links: config.links,
    gameRoot: paths.root,
    defaultRoot: paths.defaultRoot(),
    platform: process.platform,
  }));

  // --- Comptes ---
  handle('accounts:list', () => auth.listAccounts());
  handle('accounts:loginMicrosoft', async () => {
    await auth.loginMicrosoft(mainWindow);
    return auth.listAccounts();
  });
  handle('accounts:loginOffline', (name) => {
    auth.loginOffline(name);
    return auth.listAccounts();
  });
  handle('accounts:remove', (id) => auth.removeAccount(id));
  handle('accounts:select', (id) => auth.selectAccount(id));

  // --- Parametres ---
  handle('settings:get', () => store.getSettings());
  handle('settings:save', (patch) => store.saveSettings(patch));
  handle('settings:pickFolder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choisir le dossier du jeu',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: paths.root,
    });
    return result.canceled ? null : result.filePaths[0];
  });
  handle('settings:pickJava', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choisir l’executable Java',
      properties: ['openFile'],
      filters: process.platform === 'win32'
        ? [{ name: 'Executable Java', extensions: ['exe'] }]
        : [],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  // --- Dossiers ---
  handle('shell:openGameFolder', async () => {
    paths.ensureAll();
    await shell.openPath(paths.root);
    return paths.root;
  });
  handle('shell:openModsFolder', async () => {
    paths.ensureAll();
    await shell.openPath(paths.mods);
    return paths.mods;
  });
  handle('shell:openLogsFolder', async () => {
    paths.ensureAll();
    await shell.openPath(paths.logs);
    return paths.logs;
  });
  handle('shell:openExternal', (url) => {
    if (!/^https?:\/\//.test(url)) throw new Error('Lien refuse.');
    return shell.openExternal(url);
  });

  // --- Modpack ---
  handle('modpack:info', async () => {
    const { manifest, offline } = await modpack.fetchManifest();
    return {
      offline,
      modpackVersion: manifest.modpackVersion || null,
      minecraftVersion: manifest.minecraftVersion || config.fallback.minecraftVersion,
      forgeVersion: manifest.forgeVersion || config.fallback.forgeVersion,
      news: manifest.news || [],
      server: { ...config.server, ...(manifest.server || {}) },
      // Les liens du manifest ecrasent ceux compiles dans l'exe : une
      // invitation Discord expiree se remplace en modifiant le manifest.
      links: { ...config.links, ...(manifest.links || {}) },
      fileCount: (manifest.files || manifest.mods || []).length,
    };
  });
  handle('modpack:extraMods', () => modpack.listExtraMods());

  // --- Etat du serveur ---
  handle('server:status', async (override) => {
    const target = { ...config.server, ...(override || {}) };
    return serverStatus.ping(target.host, target.port);
  });

  // --- Jeu ---
  handle('game:launch', async (accountId) => launcher.launch({
    accountId,
    onStatus: (message) => send('game:status', { message }),
    onProgress: (progress) => send('game:progress', progress),
    onLog: (line) => send('game:log', { line }),
    onExit: (result) => send('game:exit', result),
  }));
  handle('game:isRunning', () => launcher.isRunning());
  handle('game:stop', () => launcher.stop());
  handle('game:repair', async () => {
    const confirmation = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['Annuler', 'Reparer'],
      defaultId: 0,
      cancelId: 0,
      title: 'Reparer l’installation',
      message: 'Retelecharger tous les fichiers du jeu ?',
      detail: 'Les versions, bibliotheques et mods seront supprimes puis retelecharges. '
        + 'Tes sauvegardes, options et captures d’ecran sont conserves.',
    });
    if (confirmation.response !== 1) return false;
    return launcher.repair({ onStatus: (message) => send('game:status', { message }) });
  });
}

/* ------------------------------------------------------------------ *
 *  Cycle de vie
 * ------------------------------------------------------------------ */

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(() => {
  // Le dossier de jeu personnalise doit etre applique avant tout acces disque.
  const settings = store.getSettings();
  if (settings.gameRoot && fs.existsSync(path.dirname(settings.gameRoot))) {
    paths.setRoot(settings.gameRoot);
  }

  registerIpc();
  createWindow();
  setupAutoUpdater();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Une exception non capturee dans le processus principal fermerait la fenetre
// sans explication : on la montre au joueur.
process.on('uncaughtException', (err) => {
  dialog.showErrorBox('Erreur du launcher', err.stack || String(err));
});
