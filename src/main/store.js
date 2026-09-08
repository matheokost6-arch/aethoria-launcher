'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const paths = require('./game/paths');
const config = require('../shared/config');

/**
 * Persistance simple en JSON : preferences du launcher et comptes enregistres.
 *
 * Les jetons Microsoft (refresh token notamment) sont chiffres avec une cle
 * derivee de la machine. Ce n'est pas un coffre-fort — un attaquant ayant deja
 * un acces local peut la reconstruire — mais cela evite que le refresh token
 * traine en clair dans un fichier facilement exfiltrable.
 */

function machineKey() {
  const seed = [os.hostname(), os.userInfo().username, process.platform, config.launcherName].join('|');
  return crypto.createHash('sha256').update(seed).digest();
}

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', machineKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return `${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${enc.toString('base64')}`;
}

function decrypt(payload) {
  try {
    const [iv, tag, data] = String(payload).split('.');
    const decipher = crypto.createDecipheriv('aes-256-gcm', machineKey(), Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null; // jeton illisible (machine differente, fichier corrompu) : on redemande une connexion
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file); // ecriture atomique : pas de fichier tronque si crash
}

const DEFAULT_SETTINGS = {
  gameRoot: null,          // null = emplacement par defaut
  minRamMb: config.defaults.minRamMb,
  maxRamMb: config.defaults.maxRamMb,
  jvmArgs: config.defaults.jvmArgs.join(' '),
  javaPath: null,          // null = runtime telecharge automatiquement
  closeOnLaunch: config.defaults.closeOnLaunch,
  joinServerOnLaunch: config.defaults.joinServerOnLaunch,
  keepExtraMods: true,     // conserver les mods ajoutes manuellement par le joueur
};

const store = {
  getSettings() {
    const saved = readJson(paths.settingsFile, {});
    return { ...DEFAULT_SETTINGS, ...saved };
  },

  saveSettings(patch) {
    const next = { ...this.getSettings(), ...patch };
    // Bornes de securite sur la RAM : en dessous de 1 Go le jeu ne demarre pas,
    // au dessus de la RAM physique le systeme se met a swapper.
    const totalMb = Math.floor(os.totalmem() / 1024 / 1024);
    next.maxRamMb = Math.min(Math.max(1024, Number(next.maxRamMb) || 4096), totalMb);
    next.minRamMb = Math.min(Math.max(512, Number(next.minRamMb) || 2048), next.maxRamMb);
    writeJson(paths.settingsFile, next);
    if (next.gameRoot) paths.setRoot(next.gameRoot);
    return next;
  },

  /** { accounts: [...], selectedId: string|null } */
  getAccounts() {
    const data = readJson(paths.accountsFile, { accounts: [], selectedId: null });
    return {
      accounts: (data.accounts || []).map((a) => ({
        ...a,
        refreshToken: a.refreshToken ? decrypt(a.refreshToken) : null,
      })),
      selectedId: data.selectedId || null,
    };
  },

  saveAccounts(state) {
    writeJson(paths.accountsFile, {
      accounts: (state.accounts || []).map((a) => ({
        ...a,
        // Le jeton d'acces est volatile (24h) : inutile de le persister.
        accessToken: undefined,
        refreshToken: a.refreshToken ? encrypt(a.refreshToken) : null,
      })),
      selectedId: state.selectedId || null,
    });
  },

  upsertAccount(account) {
    const state = this.getAccounts();
    const idx = state.accounts.findIndex((a) => a.id === account.id);
    if (idx >= 0) state.accounts[idx] = { ...state.accounts[idx], ...account };
    else state.accounts.push(account);
    state.selectedId = account.id;
    this.saveAccounts(state);
    return state;
  },

  removeAccount(id) {
    const state = this.getAccounts();
    state.accounts = state.accounts.filter((a) => a.id !== id);
    if (state.selectedId === id) state.selectedId = state.accounts[0]?.id || null;
    this.saveAccounts(state);
    return state;
  },

  selectAccount(id) {
    const state = this.getAccounts();
    if (state.accounts.some((a) => a.id === id)) {
      state.selectedId = id;
      this.saveAccounts(state);
    }
    return state;
  },
};

module.exports = store;
