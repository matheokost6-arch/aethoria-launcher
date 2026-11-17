'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow, ipcMain, shell, dialog, Menu, Notification, Tray, clipboard, protocol, session } = require('electron');
const config = require('../shared/config');
const paths = require('./game/paths');
const store = require('./store');
const auth = require('./auth');
const launcher = require('./game/launcher');
const modpack = require('./game/modpack');
const serverStatus = require('./game/serverStatus');
const screenshots = require('./game/screenshots');
const storage = require('./game/storage');
const checkup = require('./game/checkup');
const gameOptions = require('./game/options');
const shaders = require('./game/shaders');
const crashes = require('./game/crashes');
const skin = require('./game/skin');
const check = require('./validate');

const DAY_MS = 24 * 60 * 60 * 1000;
const pkg = require('../../package.json');

// Le mode --dev (outils de developpement) n'existe pas dans la version installee.
const isDev = !app.isPackaged && process.argv.includes('--dev');
// Lance avec Windows : le launcher demarre discretement pres de l'horloge.
const startHidden = process.argv.includes('--hidden');
// Raccourci "Jouer a Aethoria" : le jeu demarre des l'ouverture.
const startPlaying = process.argv.includes('--play');

// Une seule instance : deux launchers ouverts sur le meme dossier de jeu se
// marcheraient dessus pendant les telechargements.
const instanceUnique = app.requestSingleInstanceLock();
if (!instanceUnique) {
  app.quit();
}

// Toutes les pages et tous les processus de rendu tournent dans le bac a sable
// de Chromium, sans acces a Node.
app.enableSandbox();

// L'interface est servie par un protocole a elle (app://), pas par file:// :
// elle n'a ainsi aucun des privileges speciaux des fichiers locaux, et le
// processus principal choisit exactement ce qui peut etre lu.
const SCHEME = 'app';
const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const RENDERER_URL = `${SCHEME}://interface/index.html`;
protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// Meme politique que la balise <meta> de index.html, rappelee en en-tete.
const CSP = "default-src 'self'; img-src 'self' data: https://crafatar.com; style-src 'self'; style-src-attr 'unsafe-inline'; "
  + "script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; "
  + "frame-ancestors 'none'; connect-src 'none'";

/** Sert un fichier de src/renderer, et rien d'autre. */
async function servirInterface(request) {
  const url = new URL(request.url);
  if (url.hostname !== 'interface') return new Response('Refusé', { status: 403 });
  let relatif;
  try {
    relatif = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
  } catch {
    return new Response('Refusé', { status: 400 });
  }
  const fichier = path.resolve(RENDERER_DIR, relatif);
  const dansLeDossier = path.relative(RENDERER_DIR, fichier);
  const type = CONTENT_TYPES[path.extname(fichier).toLowerCase()];
  if (!type || dansLeDossier.startsWith('..') || path.isAbsolute(dansLeDossier)) {
    return new Response('Refusé', { status: 403 });
  }
  try {
    return new Response(await fs.promises.readFile(fichier), {
      headers: { 'Content-Type': type, 'Content-Security-Policy': CSP },
    });
  } catch {
    return new Response('Introuvable', { status: 404 });
  }
}

let mainWindow = null;
let tray = null;
let updater = null;

// Windows lit le .ico ; macOS et Linux veulent une image PNG.
const ICON = path.join(__dirname, '..', '..', 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png');

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

/** Notification Windows, seulement si le joueur regarde ailleurs. */
function notify(title, body) {
  if (!Notification.isSupported() || mainWindow?.isFocused()) return;
  const notification = new Notification({ title, body, icon: ICON });
  notification.on('click', () => showWindow());
  notification.show();
}

function showWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/** Icone pres de l'horloge : le launcher cache pendant la partie y reste accessible. */
function createTray() {
  // Tous les bureaux Linux n'ont pas de zone de notification : son absence ne
  // doit pas empecher le launcher de s'ouvrir.
  try {
    tray = new Tray(ICON);
  } catch {
    tray = null;
    return;
  }
  tray.setToolTip(config.appName);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Afficher Aethoria', click: showWindow },
    { label: 'Jouer', click: () => { showWindow(); send('tray:play', {}); } },
    { type: 'separator' },
    { label: 'Quitter', click: () => app.quit() },
  ]));
  tray.on('click', showWindow);
}

/** Fichier .desktop : le format commun aux bureaux Linux (raccourcis et demarrage). */
/** Copie l'icone hors de l'application : un .desktop ne sait pas lire dedans. */
function iconeInstallee() {
  try {
    const dossier = path.join(app.getPath('home'), '.local', 'share', 'icons');
    const dest = path.join(dossier, 'aethoria.png');
    fs.mkdirSync(dossier, { recursive: true });
    fs.copyFileSync(ICON, dest);
    return dest;
  } catch {
    return ICON;
  }
}

function desktopEntry({ play = false } = {}) {
  const exec = process.env.APPIMAGE || process.execPath;
  return [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${play ? 'Jouer à Aethoria' : 'Aethoria'}`,
    `Comment=${play ? 'Ouvre Aethoria et lance directement le jeu' : 'Launcher du serveur Aethoria'}`,
    `Exec="${exec}"${play ? ' --play' : ' --hidden'}`,
    `Icon=${iconeInstallee()}`,
    'Terminal=false',
    'Categories=Game;',
    '',
  ].join('\n');
}

function applyOpenAtLogin(enabled) {
  // En developpement, l'executable est Electron lui-meme : rien a enregistrer.
  if (!app.isPackaged) return;
  if (process.platform === 'linux') {
    // Electron ne gere pas le demarrage automatique sous Linux : on ecrit
    // nous-memes le fichier attendu par les bureaux (GNOME, KDE, XFCE...).
    const file = path.join(app.getPath('home'), '.config', 'autostart', 'aethoria.desktop');
    try {
      if (!enabled) {
        fs.rmSync(file, { force: true });
        return;
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, desktopEntry(), 'utf8');
    } catch {
      // dossier non accessible : le reglage reste sans effet
    }
    return;
  }
  app.setLoginItemSettings({ openAtLogin: enabled, args: ['--hidden'] });
}

/**
 * Premiere partie sur ce PC : graphismes regles selon la machine, pour que le
 * modpack tourne correctement sans que le joueur ait a chercher. Un joueur qui
 * a deja des options (ancienne installation) n'est pas touche.
 */
async function autoGraphicsPreset() {
  const settings = store.getSettings();
  if (settings.autoPresetDone) return;
  store.saveSettings({ autoPresetDone: true });
  if (settings.graphicsPreset || fs.existsSync(path.join(paths.root, 'options.txt'))) return;

  let gpu = '';
  try {
    gpu = (await app.getGPUInfo('complete')).auxAttributes?.glRenderer || '';
  } catch {
    // carte graphique inconnue : on se fie a la memoire
  }
  const dedicated = /NVIDIA|GeForce|RTX|GTX|Radeon RX|Arc A/i.test(gpu);
  const ramMb = store.getSystemRamMb();
  let preset = 'balanced';
  if (ramMb < 7000 || !dedicated) preset = 'performance';
  else if (ramMb >= 15000 && /RTX|RX [6-9]\d{3}|Arc A7/i.test(gpu)) preset = 'quality';

  await gameOptions.applyPreset(preset);
  store.saveSettings({ graphicsPreset: preset });
  send('game:autoPreset', { preset });
}

/** Nettoyage des anciens journaux, une fois par semaine, si le joueur l'accepte. */
async function weeklyClean() {
  const settings = store.getSettings();
  if (!settings.autoClean || launcher.isRunning() || Date.now() - settings.lastAutoClean < 7 * DAY_MS) return;
  store.saveSettings({ lastAutoClean: Date.now() });
  const { freed } = await storage.clean();
  if (freed > 1024 * 1024) send('storage:autoCleaned', { freed });
}

/** Progression dans la barre des taches : 0 a 1, 2 = indeterminee, -1 = aucune. */
function setTaskbarProgress(value) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setProgressBar(value);
}

function appliquerMenu() {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
    return;
  }
  // macOS : sans menu, les raccourcis Cmd+Q, Cmd+C et Cmd+V disparaissent.
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: config.appName,
      submenu: [
        { role: 'about', label: `À propos d'${config.appName}` },
        { type: 'separator' },
        { role: 'hide', label: 'Masquer' },
        { role: 'hideOthers', label: 'Masquer les autres' },
        { type: 'separator' },
        { role: 'quit', label: 'Quitter' },
      ],
    },
    {
      label: 'Édition',
      submenu: [
        { role: 'undo', label: 'Annuler' },
        { role: 'redo', label: 'Rétablir' },
        { type: 'separator' },
        { role: 'cut', label: 'Couper' },
        { role: 'copy', label: 'Copier' },
        { role: 'paste', label: 'Coller' },
        { role: 'selectAll', label: 'Tout sélectionner' },
      ],
    },
  ]));
}

/**
 * Reglages de la session : aucune permission (camera, micro, position...),
 * et la page ne peut charger que ses propres fichiers, des images encodees et
 * les tetes de joueurs.
 */
function securiserSession() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  ses.webRequest.onBeforeRequest((details, callback) => {
    let autorise = false;
    try {
      const { protocol: schema, hostname } = new URL(details.url);
      autorise = schema === `${SCHEME}:` || schema === 'data:' || schema === 'devtools:'
        || (schema === 'https:' && hostname === 'crafatar.com' && details.resourceType === 'image');
    } catch {
      autorise = false;
    }
    callback({ cancel: !autorise });
  });
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
    icon: ICON,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      // Pas d'outils de developpement (F12, Ctrl+Maj+I) chez les joueurs.
      devTools: !app.isPackaged,
    },
  });

  appliquerMenu();
  mainWindow.loadURL(RENDERER_URL);
  mainWindow.once('ready-to-show', () => {
    // Sans zone de notification (GNOME par exemple), une fenetre cachee serait
    // introuvable : on l'affiche quand meme.
    if (!startHidden || !tray) mainWindow.show();
  });
  // Filet de securite : si l'interface ne signale jamais qu'elle est prete
  // (pilote graphique capricieux, chargement bloque), la fenetre resterait
  // invisible et le launcher semblerait ne pas demarrer. On l'affiche apres 10 s.
  const filetAffichage = setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible() && (!startHidden || !tray)) mainWindow.show();
  }, 10000);
  mainWindow.once('closed', () => clearTimeout(filetAffichage));
  // Page qui n'a pas pu se charger : on retente une fois plutot que d'afficher du blanc.
  let rechargee = false;
  mainWindow.webContents.on('did-fail-load', (_event, code, _description, url, principale) => {
    if (!principale || code === -3 || rechargee) return; // -3 = chargement annule volontairement
    rechargee = true;
    setTimeout(() => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL(RENDERER_URL); }, 500);
  });
  // Le processus de l'interface a plante (memoire, pilote graphique) : on le recharge.
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit' || !mainWindow || mainWindow.isDestroyed()) return;
    setTimeout(() => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.reload(); }, 500);
  });
  if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });

  // Toute navigation externe part dans le navigateur du systeme : la fenetre du
  // launcher ne doit jamais devenir un navigateur generaliste.
  // Seuls les liens https partent dans le navigateur : un autre protocole
  // (ms-msdt:, search-ms:, file:...) pourrait lancer un programme.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    ouvrirLien(url);
    return { action: 'deny' };
  });
  // La fenetre n'affiche jamais que l'interface du launcher : un fichier ou un
  // lien glisse dessus ne doit pas remplacer la page et profiter de son pont.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    ouvrirLien(url);
  });
  mainWindow.webContents.on('will-redirect', (event) => event.preventDefault());
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
  // Si un outil de developpement s'ouvrait malgre tout, il est referme.
  if (app.isPackaged) mainWindow.webContents.on('devtools-opened', () => mainWindow.webContents.closeDevTools());

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

  updater = autoUpdater;
  // Le flux est fixe ici, dans le code : il ne depend pas du fichier
  // app-update.yml. Seules les versions publiees sur le depot public
  // d'Aethoria sont acceptees, et jamais une version plus ancienne.
  autoUpdater.setFeedURL({
    provider: 'github',
    owner: config.github.distOwner,
    repo: config.github.dist,
  });
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowDowngrade = false;
  autoUpdater.allowPrerelease = false;
  autoUpdater.on('update-available', (info) => send('updater:status', { state: 'available', version: info.version }));
  autoUpdater.on('download-progress', (p) => send('updater:status', { state: 'downloading', percent: p.percent }));
  autoUpdater.on('update-downloaded', (info) => send('updater:status', { state: 'ready', version: info.version }));
  autoUpdater.on('error', (err) => send('updater:status', {
    state: 'error',
    message: String(err.message || err),
  }));

  const verifier = () => autoUpdater.checkForUpdates().catch((err) => {
    send('updater:status', {
      state: 'error',
      message: String(err?.message || 'Vérification des mises à jour impossible.'),
    });
  });
  verifier();
  // Un launcher laisse ouvert toute la journee cherche de nouveau.
  setInterval(verifier, 6 * 60 * 60 * 1000).unref();
}

/* ------------------------------------------------------------------ *
 *  Canaux IPC
 * ------------------------------------------------------------------ */

/** Enveloppe un handler pour renvoyer { ok, data } ou { ok:false, error }. */
/** Ouvre un lien dans le navigateur du joueur, seulement s'il est https et sur un site de la liste. */
function ouvrirLien(url) {
  const lien = check.lienAutorise(url);
  if (!lien) return false;
  shell.openExternal(lien);
  return true;
}

/** Seule la page principale du launcher peut appeler le processus principal. */
function appelAutorise(event) {
  const frame = event.senderFrame;
  return Boolean(frame && mainWindow && !mainWindow.isDestroyed()
    && frame === mainWindow.webContents.mainFrame
    && frame.url.split(/[?#]/)[0] === RENDERER_URL);
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!appelAutorise(event)) return { ok: false, error: 'Appel refusé.' };
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });
}

/** Message sans reponse (fenetre) : meme controle de l'appelant. */
function surMessage(channel, fn) {
  ipcMain.on(channel, (event, ...args) => {
    if (appelAutorise(event)) fn(...args);
  });
}

/** Affiche la barre de mise a jour et lance la recherche, car le launcher ne peut plus jouer. */
function signalerLauncherTropVieux(minimum) {
  send('updater:status', { state: 'outdated', minimum });
  updater?.checkForUpdates().catch(() => {});
}

function registerIpc() {
  // --- Fenetre ---
  surMessage('window:minimize', () => mainWindow?.minimize());
  surMessage('window:close', () => mainWindow?.close());
  surMessage('window:restore', () => showWindow());
  // Sans zone de notification (certains bureaux Linux), une fenetre cachee
  // serait introuvable : on la reduit dans la barre des taches a la place.
  surMessage('window:hide', () => (tray ? mainWindow?.hide() : mainWindow?.minimize()));
  surMessage('window:setZoom', (factor) => {
    if (!mainWindow) return;
    const zoom = [0.9, 1, 1.1, 1.25].includes(factor) ? factor : 1;
    mainWindow.webContents.setZoomFactor(zoom);
    // La taille minimale grandit avec l'interface, sinon la mise en page deborde.
    const minWidth = Math.round(940 * zoom);
    const minHeight = Math.round(600 * zoom);
    mainWindow.setMinimumSize(minWidth, minHeight);
    const [width, height] = mainWindow.getSize();
    if (width < minWidth || height < minHeight) {
      mainWindow.setSize(Math.max(width, minWidth), Math.max(height, minHeight));
    }
  });

  // --- Informations generales ---
  handle('app:info', () => ({
    name: config.appName,
    version: pkg.version,
    server: config.server,
    links: config.links,
    authNotice: config.authNotice,
    downloadUrl: config.downloadFor(),
    downloadPage: config.downloadPage,
    gameRoot: paths.root,
    defaultRoot: paths.defaultRoot(),
    platform: process.platform,
    autoPlay: startPlaying,
  }));

  handle('shortcut:create', () => {
    if (process.platform === 'linux') {
      // Un fichier .desktop executable : l'equivalent Linux du raccourci.
      const file = path.join(app.getPath('desktop'), 'jouer-a-aethoria.desktop');
      fs.writeFileSync(file, desktopEntry({ play: true }), 'utf8');
      fs.chmodSync(file, 0o755);
      return file;
    }
    if (process.platform !== 'win32') {
      throw new Error('Sur macOS, garde Aethoria dans le Dock : clic droit sur son icône, Options, Garder dans le Dock.');
    }
    const file = path.join(app.getPath('desktop'), 'Jouer à Aethoria.lnk');
    // "create" cree ou ecrase ; "replace" echouerait si le raccourci n'existe pas encore.
    const created = shell.writeShortcutLink(file, 'create', {
      target: process.execPath,
      // En developpement, l'executable est Electron : il faut lui donner l'application.
      args: app.isPackaged ? '--play' : `"${app.getAppPath()}" --play`,
      description: 'Ouvre Aethoria et lance directement le jeu',
      icon: app.isPackaged ? process.execPath : ICON,
      iconIndex: 0,
    });
    if (!created) throw new Error('Impossible de créer le raccourci sur le bureau.');
    return file;
  });

  handle('app:notify', (message) => notify(
    check.texte(message?.title, { max: 120, nom: 'titre' }),
    check.texte(message?.body, { max: 400, nom: 'texte' }),
  ));

  // Copie cote processus principal : navigator.clipboard echoue quand la
  // fenetre n'a pas le focus, ce qui arrive juste apres un plantage du jeu.
  handle('app:copyText', (text) => clipboard.writeText(check.texte(text, { max: 30000, nom: 'texte' })));

  // Joint au rapport de plantage : la plupart des plantages dependent de la machine.
  handle('app:system', async () => {
    let gpu = null;
    try {
      gpu = (await app.getGPUInfo('complete')).auxAttributes?.glRenderer || null;
    } catch {
      // information facultative
    }
    return {
      os: `${os.type()} ${os.release()}`,
      cpu: os.cpus()[0]?.model?.trim() || null,
      ramMb: store.getSystemRamMb(),
      gpu,
    };
  });

  handle('stats:get', () => store.getStats());

  // --- Compte ---
  handle('account:get', () => auth.getAccount());
  // Le skin sert a afficher la tete du joueur : "force" le relit apres une partie.
  handle('account:skin', (force) => skin.get(auth.getAccount() || {}, { force: force === true }));
  handle('account:valider', (pseudo) => auth.validerPseudo(check.pseudo(pseudo)));
  handle('account:connecter', (pseudo) => auth.connecterAvecPseudo(check.pseudo(pseudo)));

  // --- Parametres ---
  const dossiersChoisis = new Set();
  const javasChoisis = new Set();
  handle('settings:get', () => ({
    ...store.getSettings(),
    systemRamMb: store.getSystemRamMb(),
    recommendedRamMb: store.getRecommendedRamMb(),
  }));
  handle('settings:save', (patch) => {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Réglages refusés.');
    // Seuls les vrais reglages passent : pas de champ inventé dans settings.json.
    const connus = Object.keys(store.getSettings());
    const inconnu = Object.keys(patch).find((cle) => !connus.includes(cle));
    if (inconnu) throw new Error(`Réglage inconnu : ${inconnu}`);
    // Un dossier de jeu ou un Java ne peut venir que d'une fenetre de choix du
    // systeme (ou etre deja enregistre) : jamais d'un chemin ecrit par la page.
    const actuel = store.getSettings();
    for (const [cle, choisis] of [['gameRoot', dossiersChoisis], ['javaPath', javasChoisis]]) {
      if (cle in patch && patch[cle] !== null && patch[cle] !== actuel[cle] && !choisis.has(patch[cle])) {
        throw new Error('Choisis cet emplacement avec le bouton « Parcourir ».');
      }
    }
    if (('gameRoot' in patch || 'javaPath' in patch || 'jvmArgs' in patch) && launcher.isRunning()) {
      throw new Error('Attends la fin du téléchargement ou de la partie pour modifier ce réglage.');
    }
    const next = store.saveSettings(patch);
    if (patch && 'openAtLogin' in patch) applyOpenAtLogin(next.openAtLogin);
    return next;
  });
  handle('settings:pickFolder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choisir le dossier du jeu',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: paths.root,
    });
    if (result.canceled) return null;
    const chosen = result.filePaths[0];
    // Le launcher supprime les mods inconnus et, en reparation, les versions :
    // un dossier qui contient deja autre chose (un .minecraft, un disque
    // entier...) recoit un sous-dossier dedie.
    const entries = fs.readdirSync(chosen).filter((name) => !/^desktop\.ini$/i.test(name));
    const managed = fs.existsSync(path.join(chosen, '.aethoria-managed.json'));
    const retenu = entries.length && !managed ? path.join(chosen, 'Aethoria') : chosen;
    dossiersChoisis.add(retenu);
    return retenu;
  });
  handle('settings:pickJava', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choisir l’exécutable Java',
      properties: ['openFile'],
      filters: process.platform === 'win32'
        ? [{ name: 'Exécutable Java', extensions: ['exe'] }]
        : [{ name: 'Exécutable Java', extensions: ['*'] }],
    });
    if (result.canceled) return null;
    javasChoisis.add(result.filePaths[0]);
    return result.filePaths[0];
  });

  // --- Dossiers ---
  handle('updater:install', () => {
    if (!updater) throw new Error('Aucune mise à jour à installer.');
    updater.quitAndInstall();
  });

  handle('shell:openGameFolder', async () => {
    paths.ensureAll();
    await shell.openPath(paths.root);
    return paths.root;
  });
  handle('shell:openLogsFolder', async () => {
    paths.ensureAll();
    await shell.openPath(paths.logs);
    return paths.logs;
  });
  handle('screenshots:list', () => screenshots.list());
  handle('screenshots:open', (name) => screenshots.open(check.nomDeFichier(name)));
  handle('screenshots:folder', () => screenshots.openFolder());
  handle('screenshots:copy', (name) => screenshots.copy(check.nomDeFichier(name)));
  handle('screenshots:trash', (name) => screenshots.trash(check.nomDeFichier(name)));

  handle('checkup:run', () => checkup.run(store.getSettings(), store.getSystemRamMb()));

  handle('storage:info', () => storage.info());
  handle('storage:clean', () => {
    if (launcher.isRunning()) throw new Error('Attends la fin du téléchargement ou de la partie pour nettoyer.');
    return storage.clean();
  });

  handle('shell:openExternal', (url) => {
    if (!ouvrirLien(url)) throw new Error('Ce lien n’est pas autorisé.');
  });

  // --- Modpack ---
  handle('modpack:info', async () => {
    const { manifest, offline } = await modpack.fetchManifest();
    const launcherTropVieux = launcher.launcherTropVieux(manifest);
    if (launcherTropVieux) signalerLauncherTropVieux(manifest.minLauncherVersion);
    return {
      offline,
      launcherTropVieux,
      minLauncherVersion: manifest.minLauncherVersion || null,
      modpackVersion: manifest.modpackVersion || null,
      minecraftVersion: manifest.minecraftVersion || config.fallback.minecraftVersion,
      forgeVersion: manifest.forgeVersion || config.fallback.forgeVersion,
      news: manifest.news || [],
      server: { ...config.server, ...(manifest.server || {}) },
      // Les liens du manifest ecrasent ceux compiles dans l'exe : une
      // invitation Discord expiree se remplace en modifiant le manifest.
      links: { ...config.links, ...(manifest.links || {}) },
      authNotice: manifest.authNotice || config.authNotice,
      fileCount: (manifest.files || manifest.mods || []).length,
    };
  });

  handle('modpack:pending', async () => {
    const { manifest, offline } = await modpack.fetchManifest();
    if (offline) return null;
    return modpack.pendingDownload(manifest, store.getSettings().optionalMods);
  });

  // --- Mods optionnels (client uniquement) ---
  handle('modpack:optionalMods', async () => {
    const { manifest } = await modpack.fetchManifest();
    return modpack.listOptionalMods(manifest, store.getSettings().optionalMods || []);
  });

  handle('modpack:setOptionalMods', async (ids) => {
    ids = check.listeIdentifiants(ids);
    const { manifest } = await modpack.fetchManifest();
    // On ne retient que des identifiants reellement proposes : l'interface ne
    // doit pas pouvoir faire installer un fichier absent du catalogue.
    const connus = new Set((manifest.optionalMods || []).map((m) => m.id));
    const retenus = (Array.isArray(ids) ? ids : []).filter((id) => connus.has(id));
    store.saveSettings({ optionalMods: retenus });
    return modpack.listOptionalMods(manifest, retenus);
  });

  // --- Etat du serveur ---
  handle('server:status', async (override) => {
    const target = { ...config.server, ...check.serveur(override) };
    return serverStatus.ping(target.host, target.port);
  });

  // --- Jeu ---
  const gameHooks = {
    onStep: (step) => send('game:step', { step }),
    onProblem: (probleme) => send('game:problem', probleme),
    onModpackChanges: (changes) => send('game:modpackChanges', changes),
    onStatus: (message) => {
      setTaskbarProgress(2);
      send('game:status', { message });
    },
    onProgress: (progress) => {
      setTaskbarProgress(Math.max(0, Math.min(1, (progress.percent || 0) / 100)));
      send('game:progress', progress);
    },
    onLog: (line) => send('game:log', { line }),
    onFirstRun: () => send('game:firstRun', {}),
    // Des fichiers etrangers au jeu ont ete ranges a part : le joueur est prevenu.
    onQuarantine: ({ files }) => send('game:quarantine', { files }),
    // Launcher trop ancien : on cherche tout de suite la mise a jour.
    onOutdated: ({ minimum }) => signalerLauncherTropVieux(minimum),
    onReady: () => {
      setTaskbarProgress(-1);
      notify('Aethoria est prêt', 'Minecraft est lancé. Bon jeu !');
      send('game:ready', {});
    },
    onExit: (result) => {
      setTaskbarProgress(-1);
      if (result.error) {
        mainWindow?.flashFrame(true);
        notify('Minecraft s’est fermé', result.diagnostic?.titre || 'Ouvre le launcher pour voir la cause.');
      }
      send('game:exit', result);
    },
  };

  /** Lance le jeu, ou verifie seulement les fichiers (prepareOnly). */
  const runGame = async (prepareOnly) => {
    setTaskbarProgress(2);
    try {
      if (!prepareOnly) await autoGraphicsPreset();
      const result = await launcher.launch({ prepareOnly, ...gameHooks });
      // Apres un lancement, la barre reste en attente jusqu'a l'ouverture du jeu.
      if (prepareOnly) setTaskbarProgress(-1);
      return result;
    } catch (err) {
      setTaskbarProgress(-1);
      throw err;
    }
  };

  handle('game:launch', () => runGame(false));
  handle('game:prepare', () => runGame(true));
  handle('game:focus', () => launcher.focusGame());

  // --- Options de Minecraft ---
  // Minecraft reecrit options.txt en quittant : modifie pendant la partie, le
  // changement serait perdu.
  const refuseIfRunning = () => {
    if (launcher.isRunning()) throw new Error('Ferme Minecraft d’abord : le jeu réécrit ses options en quittant.');
  };
  handle('options:preset', (name) => {
    refuseIfRunning();
    return gameOptions.applyPreset(check.identifiant(name));
  });
  // --- Shaders (Oculus) : Oculus reecrit sa configuration en quittant ---
  handle('shaders:list', () => shaders.list());
  handle('shaders:install', async (slug) => {
    slug = check.identifiant(slug);
    refuseIfRunning();
    await shaders.install(slug);
    return shaders.list();
  });
  handle('shaders:activate', async (slug) => {
    if (slug !== null) slug = check.identifiant(slug);
    refuseIfRunning();
    await shaders.activate(slug);
    if (slug) store.saveSettings({ shaderActivated: true });
    return shaders.list();
  });
  handle('shaders:remove', async (slug) => {
    slug = check.identifiant(slug);
    refuseIfRunning();
    await shaders.remove(slug);
    return shaders.list();
  });

  // --- Plantages et mods du serveur ---
  handle('crashes:list', () => crashes.list());
  handle('crashes:open', (name) => crashes.open(check.nomDeFichier(name)));
  handle('crashes:copy', async (name) => clipboard.writeText(await crashes.read(check.nomDeFichier(name))));
  handle('modpack:serverMods', async () => modpack.listServerMods((await modpack.fetchManifest()).manifest));
  handle('screenshots:backgrounds', () => screenshots.backgrounds());

  handle('options:backup', async () => {
    const name = await gameOptions.backup();
    if (!name) throw new Error('Aucun réglage à sauvegarder : lance d’abord une partie.');
    return name;
  });
  handle('options:backups', () => gameOptions.listBackups());
  handle('options:restore', (name) => {
    refuseIfRunning();
    return gameOptions.restore(check.nomDeFichier(name));
  });
  handle('options:reset', async () => {
    refuseIfRunning();
    const confirmation = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['Annuler', 'Réinitialiser'],
      defaultId: 0,
      cancelId: 0,
      title: 'Réinitialiser les options de Minecraft',
      message: 'Remettre toutes les options du jeu par défaut ?',
      detail: 'Graphismes, son et touches reviennent aux réglages d’origine. Tes mondes et captures ne sont pas touchés.',
    });
    if (confirmation.response !== 1) return false;
    await gameOptions.reset();
    return true;
  });

  // --- Mise a jour du launcher, a la demande ---
  handle('updater:check', async () => {
    if (!app.isPackaged || !updater) {
      throw new Error('La recherche de mise à jour ne fonctionne que dans la version installée.');
    }
    const result = await updater.checkForUpdates();
    const latest = result?.updateInfo?.version || pkg.version;
    return { current: pkg.version, latest, available: latest !== pkg.version };
  });
  handle('game:stop', () => launcher.stop());
  handle('game:repair', async () => {
    const confirmation = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['Annuler', 'Réparer'],
      defaultId: 0,
      cancelId: 0,
      title: 'Réparer l’installation',
      message: 'Retélécharger tous les fichiers du jeu ?',
      detail: 'Les versions, bibliothèques et mods seront supprimés puis retéléchargés. '
        + 'Tes sauvegardes, options et captures d’écran sont conservés.',
    });
    if (confirmation.response !== 1) return false;
    if (launcher.isRunning()) throw new Error('Attends la fin du téléchargement ou de la partie pour réparer.');
    return launcher.repair({ onStatus: (message) => send('game:status', { message }) });
  });
}

/* ------------------------------------------------------------------ *
 *  Cycle de vie
 * ------------------------------------------------------------------ */

// Double-clic sur le raccourci alors que le launcher tourne deja, parfois cache
// pres de l'horloge : on remontre la fenetre existante.
app.on('second-instance', (_event, argv) => {
  showWindow();
  if (argv.includes('--play')) send('shortcut:play', {});
});

app.whenReady().then(() => {
  // Deuxieme exemplaire : il se ferme, la fenetre deja ouverte reprend la main.
  if (!instanceUnique) return;
  protocol.handle(SCHEME, servirInterface);
  securiserSession();

  // Sans identifiant d'application, Windows n'affiche pas les notifications.
  app.setAppUserModelId('fr.aethoria.launcher');

  // Le dossier de jeu personnalise doit etre applique avant tout acces disque.
  const settings = store.getSettings();
  try {
    if (settings.gameRoot && fs.existsSync(path.dirname(settings.gameRoot))) paths.setRoot(settings.gameRoot);
  } catch {
    // dossier illisible : l'emplacement par defaut reste utilise
  }

  registerIpc();
  // La zone de notification d'abord : la fenetre en a besoin pour savoir si
  // elle peut demarrer cachee sans devenir introuvable.
  createTray();
  createWindow();
  // Apres le chargement de l'interface, pour qu'elle puisse annoncer le resultat.
  mainWindow.webContents.once('did-finish-load', () => weeklyClean().catch(() => {}));
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
// Le detail est ecrit dans un fichier (a envoyer a l'equipe) ; le joueur lit
// une phrase courte. Une seule boite : une erreur qui se repete ne doit pas
// empiler des dizaines de fenetres.
let erreurDejaMontree = false;
function journaliserErreur(err) {
  try {
    const dossier = app.getPath('userData');
    fs.mkdirSync(dossier, { recursive: true });
    fs.appendFileSync(path.join(dossier, 'erreurs-launcher.log'), `[${new Date().toISOString()}] ${err?.stack || err}\n`, 'utf8');
  } catch {
    // journal impossible : tant pis, l'erreur est quand meme affichee
  }
}

process.on('uncaughtException', (err) => {
  journaliserErreur(err);
  if (erreurDejaMontree) return;
  erreurDejaMontree = true;
  dialog.showErrorBox(
    'Aethoria a rencontré un problème',
    'Le launcher a eu une erreur inattendue. Ferme-le puis rouvre-le.\n'
    + 'Si cela recommence, envoie le fichier « erreurs-launcher.log » (dossier %APPDATA%\\Aethoria) à l’équipe sur Discord.\n\n'
    + String(err?.message || err),
  );
});

// Une promesse rejetee sans personne pour l'attendre (reseau, disque...) ne doit
// ni passer inapercue ni faire planter le launcher : on la note, c'est tout.
process.on('unhandledRejection', (raison) => {
  journaliserErreur(raison instanceof Error ? raison : new Error(String(raison)));
});
