'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const paths = require('./paths');
const config = require('../../shared/config');
const { downloadAll, getJson, isValid, verifierUrl } = require('./downloader');
const { verifierManifest } = require('./signature');

// Journal des fichiers installes par le launcher, hors des dossiers nettoyes
// integralement : un fichier retire du manifest y est retrouve et supprime.
const LEDGER_NAME = '.aethoria-managed.json';

function ledgerPath() {
  return path.join(paths.root, LEDGER_NAME);
}

async function readLedger() {
  try {
    const data = JSON.parse(await fsp.readFile(ledgerPath(), 'utf8'));
    return Array.isArray(data.files) ? data.files : [];
  } catch {
    return [];
  }
}

async function writeLedger(files) {
  await fsp.mkdir(paths.root, { recursive: true });
  await fsp.writeFile(ledgerPath(), JSON.stringify({
    updatedAt: new Date().toISOString(),
    files: [...files].sort(),
  }, null, 2), 'utf8');
}

/** Refuse toute destination sortant du dossier de jeu (manifest compromis ou mal ecrit). */
/** Le chemin reste-t-il dans le dossier de jeu ? Correct aussi pour une racine comme D:\\. */
function isInsideRoot(full) {
  const relative = path.relative(paths.root, full);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Dossiers que le modpack a le droit d'ecrire. Les mondes, les options, les
 * captures et les donnees du launcher n'en font pas partie : meme un manifest
 * malveillant ne peut ni les remplacer ni les supprimer.
 */
const DOSSIERS_AUTORISES = ['mods', 'config', 'defaultconfigs', 'resourcepacks', 'shaderpacks', 'kubejs', 'scripts'];

function estAutorise(relative) {
  const premier = String(relative).split(/[/\\]/)[0];
  return DOSSIERS_AUTORISES.includes(premier);
}

function safeJoin(relative) {
  const normalized = path.normalize(String(relative)).replace(/^([/\\])+/, '');
  const full = path.resolve(paths.root, normalized);
  if (!isInsideRoot(full) || !estAutorise(normalized)) {
    throw new Error(`Chemin de fichier refusé dans le manifest : ${relative}`);
  }
  return full;
}

/**
 * Recupere le manifest du modpack. En cas d'echec reseau on repart sur la
 * derniere copie connue : le joueur peut ainsi lancer le jeu hors ligne, ou
 * quand GitHub est momentanement injoignable.
 */
async function fetchManifest({ onStatus } = {}) {
  const cacheFile = path.join(paths.root, 'manifest.cache.json');
  try {
    onStatus?.('Récupération du modpack Aethoria...');
    const manifest = await getJson(`${config.manifestUrl}?t=${Date.now()}`);
    // Un manifest dont la signature est fausse est traite comme injoignable.
    verifierManifest(manifest);
    await fsp.mkdir(paths.root, { recursive: true });
    await fsp.writeFile(cacheFile, JSON.stringify(manifest, null, 2), 'utf8');
    return { manifest, offline: false };
  } catch (err) {
    if (fs.existsSync(cacheFile)) {
      onStatus?.('Manifest injoignable, utilisation de la dernière version connue.');
      // La copie gardee sur le disque appartient au joueur : elle est reverifiee
      // comme le manifest d'origine, sinon on pourrait la modifier a la main.
      try {
        const copie = JSON.parse(await fsp.readFile(cacheFile, 'utf8'));
        verifierManifest(copie);
        return { manifest: copie, offline: true, error: err };
      } catch {
        // copie abimee ou modifiee : on la jette et on repart du secours
        await fsp.rm(cacheFile, { force: true });
      }
    }
    onStatus?.('Manifest injoignable, utilisation de la configuration de secours.');
    return {
      manifest: {
        minecraftVersion: config.fallback.minecraftVersion,
        forgeVersion: config.fallback.forgeVersion,
        files: [],
      },
      offline: true,
      secours: true, // aucune liste fiable : les mods ne peuvent pas etre verifies
      error: err,
    };
  }
}

/**
 * Normalise les entrees du manifest. Deux ecritures sont acceptees :
 *   { "path": "mods/jei.jar", "url": "...", "sha1": "..." }
 *   { "name": "jei.jar", "url": "..." }            -> place dans mods/
 *
 * La section optionalMods rejoint la liste, mais seulement pour les mods que
 * le joueur a coches. Ceux qu'il decoche sont volontairement absents du
 * resultat : la synchronisation les supprimera donc du dossier.
 */
function normalizeFiles(manifest, { optionalEnabled = [] } = {}) {
  const entries = manifest.files || manifest.mods || [];
  const actifs = (manifest.optionalMods || []).filter((m) => optionalEnabled.includes(m.id));

  // Un mod optionnel entraine ses bibliotheques. Sans elles, Forge refuse de
  // demarrer ("Mod justzoom requires konkrete") et le joueur subit un plantage
  // sans rapport visible avec la case qu'il vient de cocher.
  //
  // Deux mods peuvent dependre de la meme bibliotheque : on dedoublonne par
  // chemin, sinon elle serait telechargee deux fois au meme endroit.
  //
  // Une bibliotheque peut aussi faire partie du modpack de base : elle est
  // alors deja installee, et la compter une seconde fois ferait croire au
  // joueur qu'il reste un fichier a telecharger.
  const optionnels = [];
  const vus = new Set(entries.map((entry) => entry.path || (entry.name && `mods/${entry.name}`)).filter(Boolean));
  for (const mod of actifs) {
    for (const element of [mod, ...(mod.requires || [])]) {
      if (vus.has(element.path)) continue;
      vus.add(element.path);
      optionnels.push(element);
    }
  }

  return [...entries, ...optionnels]
    .filter((entry) => !entry.optional || optionalEnabled.includes(entry.path || entry.name))
    .map((entry) => {
      const relative = entry.path || path.posix.join('mods', entry.name);
      // Aucun fichier n'est installe sans empreinte a verifier, ni depuis un
      // serveur que le launcher ne connait pas.
      if (!entry.sha1 && !entry.hash && !entry.sha256) {
        throw new Error(`Le fichier "${relative}" n'a pas d'empreinte dans le manifest.`);
      }
      if (entry.url) verifierUrl(entry.url);
      return {
        name: entry.name || path.basename(relative),
        relative: relative.split('\\').join('/'),
        dest: safeJoin(relative),
        url: /^https:\/\//.test(entry.url) ? entry.url : null,
        sha1: entry.sha1 || entry.hash,
        sha256: entry.sha256,
        size: entry.size,
        keepExisting: entry.keepExisting === true,
      };
    });
}

/**
 * Dossier de quarantaine : les fichiers etrangers au modpack y sont deplaces,
 * jamais supprimes, pour que le joueur puisse les recuperer. Les 5 derniers
 * lots sont gardes.
 */
const quarantaineDir = () => path.join(paths.root, 'quarantaine');

async function mettreEnQuarantaine(entrees) {
  if (!entrees.length) return null;
  const lot = path.join(quarantaineDir(), new Date().toISOString().replace(/[:.]/g, '-'));
  await fsp.mkdir(lot, { recursive: true });
  for (const { relative, full } of entrees) {
    const dest = path.join(lot, relative.split('/').join('_'));
    try {
      await fsp.rename(full, dest);
    } catch {
      // autre disque ou fichier verrouille : copie puis suppression
      await fsp.cp(full, dest, { recursive: true });
      await fsp.rm(full, { recursive: true, force: true });
    }
  }
  const lots = (await fsp.readdir(quarantaineDir())).sort();
  for (const ancien of lots.slice(0, -5)) await fsp.rm(path.join(quarantaineDir(), ancien), { recursive: true, force: true });
  return lot;
}

/**
 * Retire les fichiers qui ne font plus partie du modpack. Les mods sont imposes
 * par le serveur : tout ce qui se trouve dans le dossier mods sans figurer dans
 * le manifest est mis en quarantaine, qu'il vienne d'une ancienne version du
 * pack ou d'un ajout du joueur. Tout le monde joue ainsi avec la meme liste.
 *
 * Deux cas sont retires sans bruit, car ils ne sont pas une triche : un fichier
 * qu'un ancien lancement avait installe (journal) et un mod optionnel decoche.
 * Tout le reste est signale au joueur.
 */
async function pruneRemovedFiles(currentRelatives, { cleanDirs = [], optionalPaths = new Set(), onStatus } = {}) {
  const previous = await readLedger();
  const current = new Set(currentRelatives);
  const removed = [];
  const quarantined = [];

  for (const relative of previous) {
    if (current.has(relative)) continue;
    // Meme filtre qu'a l'installation : un ancien journal ne doit pas servir a
    // faire supprimer une sauvegarde ou les reglages du joueur.
    if (!estAutorise(relative)) continue;
    const full = path.resolve(paths.root, relative);
    if (full === paths.root || !isInsideRoot(full) || !fs.existsSync(full)) continue;
    await fsp.rm(full, { force: true });
    removed.push(relative);
  }

  const aMettreDeCote = [];
  for (const dir of cleanDirs) {
    const full = safeJoin(dir);
    if (!fs.existsSync(full)) continue;
    for (const entry of await fsp.readdir(full)) {
      const relative = path.posix.join(dir.split('\\').join('/'), entry);
      if (current.has(relative)) continue;
      if (optionalPaths.has(relative)) {
        await fsp.rm(path.join(full, entry), { force: true, recursive: true });
        removed.push(relative);
      } else {
        aMettreDeCote.push({ relative, full: path.join(full, entry) });
      }
    }
  }
  if (aMettreDeCote.length) {
    await mettreEnQuarantaine(aMettreDeCote);
    quarantined.push(...aMettreDeCote.map((e) => path.posix.basename(e.relative)));
  }

  if (removed.length) {
    onStatus?.(`${removed.length} fichier(s) obsolète(s) supprimé(s).`);
  }
  if (quarantined.length) {
    onStatus?.(`${quarantined.length} fichier(s) étranger(s) mis de côté.`);
  }
  return { removed, quarantined };
}

/** Chemins de tous les mods optionnels du catalogue (coches ou non). */
function optionalPathsOf(manifest) {
  return new Set((manifest.optionalMods || [])
    .flatMap((mod) => [mod, ...(mod.requires || [])])
    .map((entry) => entry.path)
    .filter(Boolean));
}

/** Dossiers que le manifest nettoie : seul mods peut l'etre. */
const dossiersNettoyes = (manifest) => (manifest.deleteExtraIn || ['mods']).filter((dir) => dir === 'mods');

/**
 * Controle final, sans rien telecharger : le dossier mods ne contient que des
 * fichiers du manifest (le reste part en quarantaine) et chacun a la bonne
 * empreinte. Sert hors ligne, et juste avant de demarrer le jeu.
 */
async function verifyInstalled(manifest, { optionalEnabled = [], onStatus } = {}) {
  const files = normalizeFiles(manifest, { optionalEnabled });
  const { quarantined } = await pruneRemovedFiles(files.map((f) => f.relative), {
    cleanDirs: dossiersNettoyes(manifest),
    optionalPaths: optionalPathsOf(manifest),
    onStatus,
  });

  const abimes = [];
  for (const file of files) {
    if (file.keepExisting) continue; // reglages du joueur : non imposes
    if (!(await isValid(file.dest, { sha1: file.sha1, sha256: file.sha256, size: file.size }))) abimes.push(file.name);
  }
  return { quarantined, abimes };
}

/** Telecharge et met a jour tous les fichiers du modpack. */
async function sync(manifest, { optionalEnabled = [], onProgress, onStatus } = {}) {
  paths.ensureAll();
  const files = normalizeFiles(manifest, { optionalEnabled });
  const previous = await readLedger();

  // Les fichiers "de depart" (configs) n'entrent pas dans le journal : ils
  // appartiennent au joueur des qu'ils sont poses, et ne sont jamais supprimes.
  // Ils restent dans la liste des fichiers voulus : un ancien journal qui les
  // contenait encore ne doit pas les faire effacer.
  const managed = files.filter((f) => !f.keepExisting);
  const { removed, quarantined } = await pruneRemovedFiles(files.map((f) => f.relative), {
    // Seul le dossier mods peut etre vide : un manifest ne doit jamais effacer
    // les mondes, options ou captures du joueur.
    // (voir DOSSIERS_AUTORISES : le manifest ne sort jamais de ces dossiers)
    cleanDirs: dossiersNettoyes(manifest),
    optionalPaths: optionalPathsOf(manifest),
    onStatus,
  });

  const tasks = [];
  for (const file of files) {
    if (!file.url) {
      throw new Error(`Le fichier "${file.relative}" du manifest n'a pas d'URL.`);
    }
    if (file.keepExisting && fs.existsSync(file.dest)) continue;
    if (await isValid(file.dest, { sha1: file.sha1, sha256: file.sha256, size: file.size })) continue;
    tasks.push({ name: file.name, dest: file.dest, url: file.url, sha1: file.sha1, sha256: file.sha256, size: file.size });
  }

  if (tasks.length) {
    onStatus?.(`Mise à jour du modpack : ${tasks.length} fichier(s)...`);
    await downloadAll(tasks, { onProgress, concurrency: 8 });
  } else {
    onStatus?.('Modpack à jour.');
  }

  const current = managed.map((f) => f.relative);
  await writeLedger(current);
  return {
    installed: tasks.length, removed: removed.length, quarantined, total: files.length, ...modChanges(manifest, previous, current),
  };
}

const modName = (relative) => path.posix.basename(relative).replace(/\.jar$/i, '');

/**
 * Mods du serveur ajoutes ou retires depuis la derniere synchronisation. Les
 * mods optionnels coches ou decoches par le joueur ne comptent pas : ce sont
 * ses propres choix, pas une mise a jour du serveur.
 */
function modChanges(manifest, previous, current) {
  // Premiere installation : aucun journal precedent, rien a annoncer.
  if (!previous.length) return { modsAdded: [], modsRemoved: [] };
  const optional = new Set((manifest.optionalMods || [])
    .flatMap((mod) => [mod, ...(mod.requires || [])])
    .map((entry) => entry.path));
  const serverMod = (relative) => relative.startsWith('mods/') && relative.endsWith('.jar') && !optional.has(relative);
  return {
    modsAdded: current.filter((r) => serverMod(r) && !previous.includes(r)).map(modName),
    modsRemoved: previous.filter((r) => serverMod(r) && !current.includes(r)).map(modName),
  };
}

/** Mods imposes par le serveur, pour la liste consultable par le joueur. */
function listServerMods(manifest) {
  return (manifest.files || [])
    .filter((file) => String(file.path || '').startsWith('mods/'))
    .map((file) => ({ name: modName(file.path), size: file.size || 0 }))
    .sort((a, b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' }));
}

/**
 * Ce que le prochain lancement devra telecharger, estime sur la taille des
 * fichiers : immediat, contrairement au controle SHA1 fait au lancement.
 */
async function pendingDownload(manifest, optionalEnabled = []) {
  const files = normalizeFiles(manifest, { optionalEnabled });
  let count = 0;
  let bytes = 0;
  await Promise.all(files.map(async (file) => {
    const size = await fsp.stat(file.dest).then((s) => s.size, () => -1);
    if (file.keepExisting && size !== -1) return;
    if (size === -1 || (file.size && size !== file.size)) {
      count += 1;
      bytes += file.size || 0;
    }
  }));
  const firstInstall = !fs.existsSync(paths.versions) || fs.readdirSync(paths.versions).length === 0;
  return { count, bytes, total: files.length, firstInstall };
}

/**
 * Catalogue des mods optionnels, enrichi de l'etat choisi par le joueur.
 * Ces mods sont purement clients : le serveur n'a rien a installer, et un
 * joueur qui n'en prend aucun joue exactement la meme partie.
 */
function listOptionalMods(manifest, enabled = []) {
  return (manifest.optionalMods || []).map((mod) => ({
    id: mod.id,
    name: mod.name,
    description: mod.description,
    version: mod.version,
    // Poids reel : le mod et les bibliotheques qu'il entraine.
    size: mod.size + (mod.requires || []).reduce((total, dep) => total + dep.size, 0),
    requires: (mod.requires || []).map((dep) => dep.name),
    page: mod.page || null,
    enabled: enabled.includes(mod.id),
  }));
}

module.exports = { fetchManifest, sync, verifyInstalled, pendingDownload, listOptionalMods, listServerMods };
