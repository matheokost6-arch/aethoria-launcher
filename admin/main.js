'use strict';

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, safeStorage, Menu } = require('electron');
const { Rcon } = require('./rcon');
const moderation = require('./moderation');

/**
 * Aethoria Admin : le launcher du staff. Il pilote le serveur par RCON et n'est
 * jamais distribue aux joueurs.
 */

if (!app.requestSingleInstanceLock()) app.quit();

const DEFAULT_CONNECTION = { host: 'aethoria.omgcraft.fr', port: 25575 };
const JOURNAL_LIMIT = 500;

let window = null;
let rcon = null;

const connectionFile = () => path.join(app.getPath('userData'), 'connexion.json');
const journalFile = () => path.join(app.getPath('userData'), 'journal.json');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(`${file}.tmp`, file);
}

function appendJournal(entry) {
  const journal = readJson(journalFile(), []);
  journal.push({ date: Date.now(), ...entry, output: String(entry.output || '').slice(0, 500) });
  writeJson(journalFile(), journal.slice(-JOURNAL_LIMIT));
}

function run(command) {
  if (!rcon?.connected) throw new Error('Non connecté au serveur.');
  return rcon.command(command);
}

function createWindow() {
  window = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 980,
    minHeight: 620,
    frame: false,
    backgroundColor: '#0b0c0f',
    show: false,
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  Menu.setApplicationMenu(null);
  window.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  window.once('ready-to-show', () => window.show());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.on('closed', () => { window = null; });
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });
}

function registerIpc() {
  ipcMain.on('window:minimize', () => window?.minimize());
  ipcMain.on('window:close', () => window?.close());

  handle('durations', () => moderation.DURATIONS);

  // --- Connexion ---
  handle('connection:saved', () => {
    const saved = readJson(connectionFile(), {});
    return {
      host: saved.host || DEFAULT_CONNECTION.host,
      port: saved.port || DEFAULT_CONNECTION.port,
      remembered: Boolean(saved.password),
    };
  });

  handle('connection:connect', async ({ host, port, password, remember }) => {
    const target = String(host || '').trim();
    const portNumber = Number(port);
    if (!target) throw new Error('Entre l’adresse du serveur.');
    if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) throw new Error('Port RCON invalide.');

    const saved = readJson(connectionFile(), {});
    let secret = String(password || '');
    // Champ laisse vide : on reprend le mot de passe memorise, chiffre par Windows.
    if (!secret && saved.password && safeStorage.isEncryptionAvailable()) {
      secret = safeStorage.decryptString(Buffer.from(saved.password, 'base64'));
    }
    if (!secret) throw new Error('Entre le mot de passe RCON.');

    rcon?.close();
    const client = new Rcon({ host: target, port: portNumber, password: secret });
    await client.connect();
    rcon = client;
    client.socket.on('close', () => {
      if (rcon !== client) return;
      rcon = null;
      window?.webContents.send('connection:lost');
    });

    // Jamais en clair : chiffre par Windows (DPAPI), lisible par ce seul compte.
    const keep = remember && safeStorage.isEncryptionAvailable();
    writeJson(connectionFile(), {
      host: target,
      port: portNumber,
      password: keep ? safeStorage.encryptString(secret).toString('base64') : null,
    });
    return { host: target, port: portNumber };
  });

  handle('connection:disconnect', () => {
    const client = rcon;
    rcon = null;
    client?.close();
    return true;
  });

  handle('connection:forget', () => {
    const saved = readJson(connectionFile(), {});
    writeJson(connectionFile(), { ...saved, password: null });
    return true;
  });

  // --- Joueurs ---
  handle('players:online', async () => {
    const list = moderation.parseList(await run('minecraft:list'));
    return { ...list, players: list.players.map((name) => ({ name, uuid: moderation.offlineUuid(name) })) };
  });

  handle('players:avatar', (pseudo) => moderation.offlineUuid(moderation.checkPseudo(pseudo)));

  handle('players:act', async ({ action, pseudo, duration, reason }) => {
    const name = moderation.checkPseudo(pseudo);

    // "mute" bascule : sur un joueur qui n'est pas muet, il le rendrait muet.
    if (action === 'unmute') {
      const seen = await run(`seen ${name}`);
      if (!moderation.isMuted(seen)) return { output: `${name} n’est pas muet : rien à faire.`, skipped: true };
    }

    const command = moderation.buildCommand(action, { pseudo: name, duration, reason });
    const output = await run(command);
    appendJournal({
      action,
      pseudo: name,
      duration: ['mute', 'ban'].includes(action) ? duration : null,
      reason: ['kick', 'mute', 'ban'].includes(action) ? moderation.cleanReason(reason) : null,
      command,
      output,
    });
    return { output: output || 'Commande envoyée.' };
  });

  handle('players:inventory', async (pseudo, container) => {
    const name = moderation.checkPseudo(pseudo);
    if (!['Inventory', 'EnderItems'].includes(container)) throw new Error('Contenu inconnu.');
    const items = moderation.parseInventory(await run(`minecraft:data get entity ${name} ${container}`));
    return items === null ? { online: false } : { online: true, items };
  });

  handle('players:info', async (pseudo) => {
    const name = moderation.checkPseudo(pseudo);
    const whois = await run(`whois ${name}`);
    const seen = await run(`seen ${name}`);
    return { whois, seen };
  });

  // --- Console et journal ---
  handle('console:run', async (command) => {
    const text = String(command || '').replace(/^\//, '').trim();
    if (!text) throw new Error('Entre une commande.');
    if (/[\r\n]/.test(text)) throw new Error('Une seule commande à la fois.');
    const output = await run(text);
    appendJournal({ action: 'console', command: text, output });
    return output;
  });

  handle('journal:list', () => readJson(journalFile(), []).reverse());
}

app.on('second-instance', () => {
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.focus();
});

app.whenReady().then(() => {
  app.setAppUserModelId('fr.aethoria.admin');
  registerIpc();
  createWindow();
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => rcon?.close());
