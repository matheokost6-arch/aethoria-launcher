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

/**
 * Memoire a allouer au jeu, deduite de la machine du joueur.
 *
 * C'est la premiere cause de mauvaise experience sur un modpack : trop peu de
 * memoire et le jeu se fige ou plante en OutOfMemoryError, trop et le systeme
 * se met a swapper, ce qui est pire encore. Les regles retenues :
 *   - jamais plus de la moitie de la memoire physique, l'OS et le launcher
 *     doivent respirer ;
 *   - plafond a 8 Go : au-dela, les pauses du ramasse-miettes s'allongent
 *     sans que le jeu tourne mieux ;
 *   - plancher a 2 Go, en dessous duquel ce modpack ne demarre pas.
 */
function recommendedRamMb() {
  const totalMb = Math.floor(os.totalmem() / 1024 / 1024);
  const moitie = Math.floor(totalMb / 2 / 512) * 512;
  return Math.min(8192, Math.max(2048, moitie));
}

const DEFAULT_SETTINGS = {
  gameRoot: null,          // null = emplacement par defaut
  // Ces deux valeurs sont recalculees au premier demarrage, cf. getSettings.
  minRamMb: config.defaults.minRamMb,
  maxRamMb: config.defaults.maxRamMb,
  jvmArgs: config.defaults.jvmArgs.join(' '),
  javaPath: null,          // null = runtime telecharge automatiquement
  closeOnLaunch: config.defaults.closeOnLaunch,
  joinServerOnLaunch: config.defaults.joinServerOnLaunch,
  // Identifiants des mods optionnels coches par le joueur.
  optionalMods: [],
};

// Reglages imposes par le serveur, que le joueur ne peut pas changer.
// keepExtraMods a false fait supprimer, a chaque lancement, tout fichier du
// dossier mods absent du manifest. Tout le monde joue ainsi avec exactement la
// meme liste : un mod ajoute par erreur ne fait plus planter le jeu, et un mod
// retire du pack ne provoque plus de rejet a la connexion.
const FORCED_SETTINGS = {
  keepExtraMods: false,
};

const store = {
  getSettings() {
    const saved = readJson(paths.settingsFile, {});

    // Au tout premier lancement, la memoire est calee sur la machine plutot
    // que sur une valeur arbitraire. Des que le joueur y touche, son choix est
    // enregistre et prime.
    if (saved.maxRamMb === undefined) {
      const recommande = recommendedRamMb();
      saved.maxRamMb = recommande;
      saved.minRamMb = Math.max(1024, Math.floor(recommande / 2 / 512) * 512);
    }

    // FORCED_SETTINGS vient en dernier : meme un settings.json modifie a la
    // main ne peut pas reactiver la conservation des mods etrangers.
    return { ...DEFAULT_SETTINGS, ...saved, ...FORCED_SETTINGS };
  },

  /** Memoire physique de la machine, pour l'affichage des parametres. */
  getSystemRamMb() {
    return Math.floor(os.totalmem() / 1024 / 1024);
  },

  getRecommendedRamMb: recommendedRamMb,

  saveSettings(patch) {
    const next = { ...this.getSettings(), ...patch, ...FORCED_SETTINGS };
    // Bornes de securite sur la RAM : en dessous de 1 Go le jeu ne demarre pas,
    // au dessus de la RAM physique le systeme se met a swapper.
    const totalMb = Math.floor(os.totalmem() / 1024 / 1024);
    next.maxRamMb = Math.min(Math.max(1024, Number(next.maxRamMb) || 4096), totalMb);
    next.minRamMb = Math.min(Math.max(512, Number(next.minRamMb) || 2048), next.maxRamMb);
    writeJson(paths.settingsFile, next);
    if (next.gameRoot) paths.setRoot(next.gameRoot);
    return next;
  },

  /**
   * { accounts: [le seul compte] | [], selectedId }
   *
   * Le launcher a connu une version a plusieurs pseudos. Un fichier herite de
   * cette epoque est ramene ici a un seul compte, en gardant celui que le
   * joueur avait selectionne — et non le premier de la liste, qui n'est
   * generalement pas le bon.
   */
  getAccounts() {
    const data = readJson(paths.accountsFile, { accounts: [], selectedId: null });
    const tous = (data.accounts || []).map((a) => ({
      ...a,
      refreshToken: a.refreshToken ? decrypt(a.refreshToken) : null,
    }));

    const retenu = tous.find((a) => a.id === data.selectedId) || tous[0] || null;
    return {
      accounts: retenu ? [retenu] : [],
      selectedId: retenu?.id || null,
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

  /**
   * Enregistre le compte du joueur. Il n'y en a qu'un : changer de pseudo
   * remplace le precedent au lieu d'allonger une liste. Un serveur ou seul le
   * pseudo fait foi n'a aucune raison de proposer plusieurs identites.
   */
  upsertAccount(account) {
    const state = { accounts: [account], selectedId: account.id };
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
