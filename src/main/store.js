'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const paths = require('./game/paths');
const config = require('../shared/config');
const lock = require('./auth/lock');

/** Persistance en JSON des preferences, du pseudo et du temps de jeu. */

// Copie du pseudo hors du dossier de donnees du launcher : registre sous
// Windows, petit fichier cache sous macOS et Linux. Elle survit a la
// desinstallation comme a la suppression du dossier de donnees : c'est elle qui
// rend le pseudo definitif sur la machine.
const REGISTRE = 'HKCU\\Software\\Aethoria';

/** Emplacement du pseudo hors Windows, dans la configuration de l'utilisateur. */
function fichierPseudo() {
  const base = process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support', 'Aethoria')
    : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'aethoria');
  return path.join(base, 'pseudo');
}

/** Copie scellée de secours, dans les données du launcher. Sert à réparer le
 *  registre si sa valeur a été éditée à la main. */
function fichierSecours() {
  try {
    return path.join(paths.userData, 'pseudo.lock');
  } catch {
    return null;
  }
}

const estPseudo = (p) => (PSEUDO.test(String(p || '')) ? String(p) : null);

/** Lit la source principale : {pseudo, sig}. */
function lirePrincipal() {
  if (process.platform !== 'win32') {
    try {
      const [p, s] = fs.readFileSync(fichierPseudo(), 'utf8').split('\n');
      return { pseudo: estPseudo((p || '').trim()), sig: (s || '').trim() || null };
    } catch {
      return { pseudo: null, sig: null };
    }
  }
  const lireValeur = (nom) => {
    try {
      const sortie = execFileSync('reg', ['query', REGISTRE, '/v', nom], {
        encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
      });
      return sortie.match(new RegExp(`${nom}\\s+REG_SZ\\s+(\\S+)`))?.[1] || null;
    } catch {
      return null;
    }
  };
  return { pseudo: estPseudo(lireValeur('Pseudo')), sig: lireValeur('Sig') };
}

function lireSecours() {
  const file = fichierSecours();
  if (!file) return null;
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    return lock.sceauValide(d.pseudo, d.sig) ? estPseudo(d.pseudo) : null;
  } catch {
    return null;
  }
}

function lireRegistre() {
  const principal = lirePrincipal();

  // Cas normal : valeur scellée et intacte.
  if (principal.pseudo && principal.sig && lock.sceauValide(principal.pseudo, principal.sig)) {
    return principal.pseudo;
  }

  // Valeur éditée à la main (ou sceau faux) : on répare depuis la copie de secours.
  const secours = lireSecours();
  if (secours) {
    ecrireRegistre(secours); // réécrit le registre avec la bonne valeur scellée
    return secours;
  }

  // Migration douce : ancien launcher (pseudo sans sceau) dont le compte local
  // confirme la légitimité → on scelle cette valeur une fois.
  if (principal.pseudo && !principal.sig) {
    const compte = readJson(paths.accountsFile, {}).account;
    if (compte && compte.name === principal.pseudo) {
      ecrireRegistre(principal.pseudo);
      return principal.pseudo;
    }
  }

  return null; // jamais enregistré, ou édité sans copie de secours valide
}

function ecrireRegistre(pseudo) {
  if (!estPseudo(pseudo)) return;
  const sig = lock.sceau(pseudo);
  // Copie de secours scellée (sert à réparer une édition manuelle du registre).
  try {
    const file = fichierSecours();
    if (file) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ pseudo, sig }), 'utf8');
    }
  } catch { /* la source principale reste la référence */ }
  try {
    if (process.platform !== 'win32') {
      const file = fichierPseudo();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${pseudo}\n${sig}\n`, 'utf8');
      return;
    }
    execFileSync('reg', ['add', REGISTRE, '/v', 'Pseudo', '/t', 'REG_SZ', '/d', pseudo, '/f'],
      { windowsHide: true, stdio: 'ignore' });
    execFileSync('reg', ['add', REGISTRE, '/v', 'Sig', '/t', 'REG_SZ', '/d', sig, '/f'],
      { windowsHide: true, stdio: 'ignore' });
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
const BACKGROUNDS = ['rotation', 'screenshots', 'bg-chateau', 'bg-armee', 'bg-couchant', 'bg-chevaliers', 'bg-village'];
const DOWNLOAD_SPEEDS = ['fast', 'normal', 'eco'];
const ACCENTS = ['red', 'gold', 'blue', 'green'];
const GRAPHICS_PRESETS = ['performance', 'balanced', 'quality'];
const UI_SCALES = [0.9, 1, 1.1, 1.25];
const PSEUDO = /^[A-Za-z0-9_]{3,16}$/;

/**
 * Arguments Java acceptes : options du ramasse-miettes et proprietes simples.
 * Tout ce qui charge ou execute du code (-javaagent, -agentlib,
 * -XX:OnOutOfMemoryError, -Xbootclasspath, log4j...) est ecarte.
 */
const JVM_ARG = /^(-XX:[+-]?[A-Za-z0-9]+(=[A-Za-z0-9.%_-]+)?|-D[A-Za-z0-9._-]+=[A-Za-z0-9._:%-]*|-Xs[sm]\d+[kKmMgG]?|-Xmn\d+[kKmMgG]?)$/;
const JVM_FORBIDDEN = /^-XX:[+-]?(On|ErrorFile|HeapDumpPath|LogFile|Flags|VMOptionsFile|CompileCommandFile)|^-D(log4j|java\.security|java\.library|jdk\.|sun\.|java\.ext|java\.class|javax\.net|fml\.|forge\.|legacyClassPath|libraryDirectory)/i;

function cleanJvmArgs(value) {
  return String(value || '').trim().split(/\s+/)
    .filter((arg) => JVM_ARG.test(arg) && !JVM_FORBIDDEN.test(arg))
    .slice(0, 30)
    .join(' ');
}

/** Chemin absolu, ou null. */
function cleanPath(value) {
  return typeof value === 'string' && value.length < 260 && path.isAbsolute(value) ? path.normalize(value) : null;
}

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
  friends: [],             // pseudos suivis : mis en avant et notifies a leur connexion
  graphicsPreset: null,    // dernier prereglage graphique applique
  uiScale: 1,              // taille de l'interface du launcher
  sounds: true,            // sons discrets de l'interface
  breakReminder: 0,        // rappel de pause, en minutes de jeu (0 = jamais)
  quietWhilePlaying: true, // pas de notification d'amis ni d'actualites en partie
  tourDone: false,         // visite guidee deja vue
  unlockedAchievements: null, // succes deja annonces (null = jamais calcule)
  downloadSpeed: 'fast',   // parallelisme des telechargements : fast, normal ou eco
  autoPrepare: true,       // telecharger les mises a jour du modpack en avance
  autoPresetDone: false,   // graphismes deja regles automatiquement sur ce PC
  highContrast: false,     // accessibilite : textes et bordures plus marques
  accent: 'red',           // couleur d'accent de l'interface
  autoClean: true,         // nettoyage des anciens journaux chaque semaine
  lastAutoClean: 0,
  shaderActivated: false,  // pour le succes "Esthete"
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
    next.friends = [...new Set((Array.isArray(next.friends) ? next.friends : []).filter((f) => PSEUDO.test(f)))].slice(0, 50);
    if (!GRAPHICS_PRESETS.includes(next.graphicsPreset)) next.graphicsPreset = null;
    if (!UI_SCALES.includes(Number(next.uiScale))) next.uiScale = 1;
    next.uiScale = Number(next.uiScale);
    next.sounds = Boolean(next.sounds);
    next.breakReminder = [0, 60, 120, 180].includes(Number(next.breakReminder)) ? Number(next.breakReminder) : 0;
    next.quietWhilePlaying = Boolean(next.quietWhilePlaying);
    next.tourDone = Boolean(next.tourDone);
    next.unlockedAchievements = Array.isArray(next.unlockedAchievements)
      ? next.unlockedAchievements.map(String).slice(0, 50)
      : null;
    if (!DOWNLOAD_SPEEDS.includes(next.downloadSpeed)) next.downloadSpeed = DEFAULT_SETTINGS.downloadSpeed;
    if (!ACCENTS.includes(next.accent)) next.accent = DEFAULT_SETTINGS.accent;
    for (const key of ['autoPrepare', 'autoPresetDone', 'highContrast', 'autoClean', 'shaderActivated']) {
      next[key] = Boolean(next[key]);
    }
    next.lastAutoClean = Number(next.lastAutoClean) || 0;
    next.gameRoot = cleanPath(next.gameRoot);
    // Le racine d'un disque serait videe de ses mods et versions : refusee.
    if (next.gameRoot && path.parse(next.gameRoot).root === next.gameRoot) next.gameRoot = null;
    next.javaPath = cleanPath(next.javaPath);
    // Un executable qui n'est pas Java (ou un dossier "home" de Java) est refuse.
    if (next.javaPath && !/^javaw?(\.exe)?$/i.test(path.basename(next.javaPath))
      && !(fs.existsSync(next.javaPath) && fs.statSync(next.javaPath).isDirectory())) {
      next.javaPath = null;
    }
    next.jvmArgs = cleanJvmArgs(next.jvmArgs);
    next.autoJoinServer = Boolean(next.autoJoinServer);
    next.lastSeenVersion = typeof next.lastSeenVersion === 'string' ? next.lastSeenVersion.slice(0, 20) : null;
    next.optionalMods = (Array.isArray(next.optionalMods) ? next.optionalMods : []).map(String).slice(0, 100);
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
    return {
      totalSeconds: 0,
      sessions: 0,
      longestSeconds: 0,
      firstPlayedAt: null,
      lastSession: null,
      history: [],
      ...readJson(paths.statsFile, {}),
    };
  },

  addPlaySession(seconds) {
    const stats = this.getStats();
    const now = Date.now();
    writeJson(paths.statsFile, {
      totalSeconds: stats.totalSeconds + seconds,
      sessions: stats.sessions + 1,
      longestSeconds: Math.max(stats.longestSeconds, seconds),
      firstPlayedAt: stats.firstPlayedAt || now - seconds * 1000,
      lastSession: { endedAt: now, seconds },
      // Historique borne : graphique de la semaine et dernieres parties du profil.
      history: [...stats.history, { endedAt: now, seconds }].slice(-100),
    });
  },
};

module.exports = store;
