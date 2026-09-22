'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const paths = require('./paths');
const config = require('../../shared/config');
const { downloadAll, getJson, isValid } = require('./downloader');

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

function safeJoin(relative) {
  const normalized = path.normalize(String(relative)).replace(/^([/\\])+/, '');
  const full = path.resolve(paths.root, normalized);
  if (!isInsideRoot(full)) {
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
    await fsp.mkdir(paths.root, { recursive: true });
    await fsp.writeFile(cacheFile, JSON.stringify(manifest, null, 2), 'utf8');
    return { manifest, offline: false };
  } catch (err) {
    if (fs.existsSync(cacheFile)) {
      onStatus?.('Manifest injoignable, utilisation de la dernière version connue.');
      return { manifest: JSON.parse(await fsp.readFile(cacheFile, 'utf8')), offline: true, error: err };
    }
    onStatus?.('Manifest injoignable, utilisation de la configuration de secours.');
    return {
      manifest: {
        minecraftVersion: config.fallback.minecraftVersion,
        forgeVersion: config.fallback.forgeVersion,
        files: [],
      },
      offline: true,
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
  const optionnels = [];
  const vus = new Set();
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
      return {
        name: entry.name || path.basename(relative),
        relative: relative.split('\\').join('/'),
        dest: safeJoin(relative),
        url: /^https:\/\//.test(entry.url) ? entry.url : null,
        sha1: entry.sha1 || entry.hash,
        size: entry.size,
        keepExisting: entry.keepExisting === true,
      };
    });
}

/**
 * Supprime les fichiers qui ne font plus partie du modpack. Les mods sont
 * imposes par le serveur : tout fichier du dossier mods absent du manifest est
 * retire, qu'il vienne d'une ancienne version du pack ou d'un ajout du joueur.
 * Tout le monde joue ainsi avec exactement la meme liste.
 */
async function pruneRemovedFiles(currentRelatives, { cleanDirs = [], onStatus } = {}) {
  const previous = await readLedger();
  const current = new Set(currentRelatives);
  const removed = [];

  for (const relative of previous) {
    if (current.has(relative)) continue;
    const full = path.resolve(paths.root, relative);
    if (full === paths.root || !isInsideRoot(full) || !fs.existsSync(full)) continue;
    await fsp.rm(full, { force: true });
    removed.push(relative);
  }

  for (const dir of cleanDirs) {
    const full = safeJoin(dir);
    if (!fs.existsSync(full)) continue;
    for (const entry of await fsp.readdir(full)) {
      const relative = path.posix.join(dir.split('\\').join('/'), entry);
      if (current.has(relative)) continue;
      await fsp.rm(path.join(full, entry), { force: true, recursive: true });
      removed.push(relative);
    }
  }

  if (removed.length) {
    onStatus?.(`${removed.length} fichier(s) obsolète(s) supprimé(s).`);
  }
  return removed;
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
  const removed = await pruneRemovedFiles(files.map((f) => f.relative), {
    // Seul le dossier mods peut etre vide : un manifest ne doit jamais effacer
    // les mondes, options ou captures du joueur.
    cleanDirs: (manifest.deleteExtraIn || ['mods']).filter((dir) => dir === 'mods'),
    onStatus,
  });

  const tasks = [];
  for (const file of files) {
    if (!file.url) {
      throw new Error(`Le fichier "${file.relative}" du manifest n'a pas d'URL.`);
    }
    if (file.keepExisting && fs.existsSync(file.dest)) continue;
    if (await isValid(file.dest, { sha1: file.sha1, size: file.size })) continue;
    tasks.push({ name: file.name, dest: file.dest, url: file.url, sha1: file.sha1, size: file.size });
  }

  if (tasks.length) {
    onStatus?.(`Mise à jour du modpack : ${tasks.length} fichier(s)...`);
    await downloadAll(tasks, { onProgress, concurrency: 8 });
  } else {
    onStatus?.('Modpack à jour.');
  }

  const current = managed.map((f) => f.relative);
  await writeLedger(current);
  return { installed: tasks.length, removed: removed.length, total: files.length, ...modChanges(manifest, previous, current) };
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

module.exports = { fetchManifest, sync, pendingDownload, listOptionalMods, listServerMods };
