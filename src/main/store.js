'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const paths = require('./game/paths');
const config = require('../shared/config');

/** Persistance en JSON des preferences du launcher et du pseudo du joueur. */

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

function systemRamMb() {
  return Math.floor(os.totalmem() / 1024 / 1024);
}

/**
 * Memoire a allouer au jeu, deduite de la machine du joueur : la moitie de la
 * memoire physique, entre 2 Go (en dessous le modpack ne demarre pas) et 8 Go
 * (au-dela les pauses du ramasse-miettes s'allongent sans gain).
 */
function recommendedRamMb() {
  const moitie = Math.floor(systemRamMb() / 2 / 512) * 512;
  return Math.min(8192, Math.max(2048, moitie));
}

const DEFAULT_SETTINGS = {
  gameRoot: null,          // null = emplacement par defaut
  minRamMb: config.defaults.minRamMb,
  maxRamMb: config.defaults.maxRamMb,
  jvmArgs: config.defaults.jvmArgs.join(' '),
  javaPath: null,          // null = runtime telecharge automatiquement
  closeOnLaunch: config.defaults.closeOnLaunch,
  joinServerOnLaunch: config.defaults.joinServerOnLaunch,
  optionalMods: [],        // identifiants des mods optionnels coches
};

const store = {
  getSettings() {
    const saved = readJson(paths.settingsFile, {});

    // Au premier lancement, la memoire est calee sur la machine. Des que le
    // joueur y touche, son choix est enregistre et prime.
    if (saved.maxRamMb === undefined) {
      const recommande = recommendedRamMb();
      saved.maxRamMb = recommande;
      saved.minRamMb = Math.max(1024, Math.floor(recommande / 2 / 512) * 512);
    }

    return { ...DEFAULT_SETTINGS, ...saved };
  },

  getSystemRamMb: systemRamMb,
  getRecommendedRamMb: recommendedRamMb,

  saveSettings(patch) {
    const next = { ...this.getSettings(), ...patch };
    // En dessous de 1 Go le jeu ne demarre pas, au dessus de la memoire
    // physique le systeme se met a swapper.
    next.maxRamMb = Math.min(Math.max(1024, Number(next.maxRamMb) || 4096), systemRamMb());
    next.minRamMb = Math.min(Math.max(512, Number(next.minRamMb) || 2048), next.maxRamMb);
    writeJson(paths.settingsFile, next);
    if (next.gameRoot) paths.setRoot(next.gameRoot);
    return next;
  },

  /** Le compte du joueur, ou null. */
  getAccount() {
    const data = readJson(paths.accountsFile, {});
    if (data.account) return data.account;
    // Fichier des anciennes versions : { accounts: [...], selectedId }.
    const anciens = data.accounts || [];
    return anciens.find((a) => a.id === data.selectedId) || anciens[0] || null;
  },

  /** Il n'y a qu'un compte : changer de pseudo remplace le precedent. */
  saveAccount(account) {
    writeJson(paths.accountsFile, { account });
  },
};

module.exports = store;
