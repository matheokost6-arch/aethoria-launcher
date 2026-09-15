'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const paths = require('./game/paths');
const config = require('../shared/config');

/** Persistance en JSON des preferences, du pseudo et du temps de jeu. */

// Copie du pseudo dans le registre de Windows. Elle survit a la
// desinstallation du launcher comme a la suppression de son dossier de
// donnees : c'est elle qui rend le pseudo definitif sur la machine.
const REGISTRE = 'HKCU\\Software\\Aethoria';

function lireRegistre() {
  if (process.platform !== 'win32') return null;
  try {
    const sortie = execFileSync('reg', ['query', REGISTRE, '/v', 'Pseudo'], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return sortie.match(/Pseudo\s+REG_SZ\s+(\S+)/)?.[1] || null;
  } catch {
    return null; // cle absente
  }
}

function ecrireRegistre(pseudo) {
  if (process.platform !== 'win32') return;
  try {
    execFileSync('reg', ['add', REGISTRE, '/v', 'Pseudo', '/t', 'REG_SZ', '/d', pseudo, '/f'], {
      windowsHide: true,
      stdio: 'ignore',
    });
  } catch {
    // Filet de securite seulement : le fichier du compte reste la reference.
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

const BEHAVIORS = ['keep', 'minimize', 'close'];
const RESOLUTIONS = ['default', '1280x720', '1600x900', '1920x1080', 'fullscreen'];
const BACKGROUNDS = ['rotation', 'bg-chateau', 'bg-armee', 'bg-couchant', 'bg-chevaliers', 'bg-village'];

const DEFAULT_SETTINGS = {
  gameRoot: null,          // null = emplacement par defaut
  minRamMb: config.defaults.minRamMb,
  maxRamMb: config.defaults.maxRamMb,
  jvmArgs: config.defaults.jvmArgs.join(' '),
  javaPath: null,          // null = runtime telecharge automatiquement
  autoJoinServer: config.defaults.autoJoinServer,
  launcherBehavior: config.defaults.launcherBehavior,
  gameResolution: config.defaults.gameResolution,
  optionalMods: [],        // identifiants des mods optionnels coches
  lastSeenVersion: null,   // derniere version dont le joueur a vu les nouveautes
  seenNews: [],            // actualites deja affichees, pour le badge "Nouveau"
  background: 'rotation',  // fond d'ecran : defilement ou une image fixe
  lightMode: false,        // sans animations ni flou, pour les PC modestes
  openAtLogin: false,      // demarrer avec Windows
};

const store = {
  getSettings() {
    // joinServerOnLaunch est volontairement abandonne : avec le menu Aethoria,
    // tous les joueurs arrivent sur ce menu, meme ceux qui avaient l'ancien reglage.
    const { closeOnLaunch, joinServerOnLaunch, ...saved } = readJson(paths.settingsFile, {});

    // Reglage des versions precedentes, remplace par launcherBehavior.
    if (saved.launcherBehavior === undefined && closeOnLaunch) saved.launcherBehavior = 'close';

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
    if (!BEHAVIORS.includes(next.launcherBehavior)) next.launcherBehavior = DEFAULT_SETTINGS.launcherBehavior;
    if (!RESOLUTIONS.includes(next.gameResolution)) next.gameResolution = DEFAULT_SETTINGS.gameResolution;
    if (!BACKGROUNDS.includes(next.background)) next.background = DEFAULT_SETTINGS.background;
    next.seenNews = (Array.isArray(next.seenNews) ? next.seenNews : []).map(String).slice(-50);
    next.lightMode = Boolean(next.lightMode);
    next.openAtLogin = Boolean(next.openAtLogin);
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

  saveAccount(account) {
    writeJson(paths.accountsFile, { account });
    ecrireRegistre(account.name);
  },

  /** Pseudo conserve dans le registre, ou null. */
  getRegistryPseudo: lireRegistre,
  saveRegistryPseudo: ecrireRegistre,

  /** Temps de jeu cumule, compte par le launcher. */
  getStats() {
    return { totalSeconds: 0, sessions: 0, lastSession: null, ...readJson(paths.statsFile, {}) };
  },

  addPlaySession(seconds) {
    const stats = this.getStats();
    writeJson(paths.statsFile, {
      totalSeconds: stats.totalSeconds + seconds,
      sessions: stats.sessions + 1,
      lastSession: { endedAt: Date.now(), seconds },
    });
  },
};

module.exports = store;
