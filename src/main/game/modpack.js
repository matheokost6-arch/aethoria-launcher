'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const paths = require('./paths');
const config = require('../../shared/config');
const { downloadAll, getJson, isValid } = require('./downloader');

// Journal des fichiers installes par le launcher. Il permet de distinguer un
// mod retire du modpack (a supprimer) d'un mod ajoute par le joueur (a garder).
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
function safeJoin(relative) {
  const normalized = path.normalize(relative).replace(/^([/\\])+/, '');
  const full = path.resolve(paths.root, normalized);
  if (full !== paths.root && !full.startsWith(paths.root + path.sep)) {
    throw new Error(`Chemin de fichier refuse dans le manifest : ${relative}`);
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
    onStatus?.('Recuperation du modpack Aethoria...');
    const manifest = await getJson(`${config.manifestUrl}?t=${Date.now()}`);
    await fsp.mkdir(paths.root, { recursive: true });
    await fsp.writeFile(cacheFile, JSON.stringify(manifest, null, 2), 'utf8');
    return { manifest, offline: false };
  } catch (err) {
    if (fs.existsSync(cacheFile)) {
      onStatus?.('Manifest injoignable, utilisation de la derniere version connue.');
      return { manifest: JSON.parse(await fsp.readFile(cacheFile, 'utf8')), offline: true, error: err };
    }
    onStatus?.('Manifest injoignable, utilisation de la configuration de secours.');
    return {
      manifest: {
        minecraftVersion: config.fallback.minecraftVersion,
        forgeVersion: config.fallback.forgeVersion,
        files: config.fallback.mods,
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
 */
function normalizeFiles(manifest, { optionalEnabled = [] } = {}) {
  const entries = manifest.files || manifest.mods || [];
  return entries
    .filter((entry) => !entry.optional || optionalEnabled.includes(entry.path || entry.name))
    .map((entry) => {
      const relative = entry.path || path.posix.join('mods', entry.name);
      return {
        name: entry.name || path.basename(relative),
        relative: relative.split('\\').join('/'),
        dest: safeJoin(relative),
        url: entry.url,
        sha1: entry.sha1 || entry.hash,
        size: entry.size,
      };
    });
}

/**
 * Supprime les fichiers que le launcher avait installes et qui ne font plus
 * partie du modpack. Un mod retire cote serveur doit disparaitre cote client,
 * sinon le joueur est rejete a la connexion pour desynchronisation de mods.
 */
async function pruneRemovedFiles(currentRelatives, { keepExtra = true, cleanDirs = [], onStatus } = {}) {
  const previous = await readLedger();
  const current = new Set(currentRelatives);
  const removed = [];

  for (const relative of previous) {
    if (current.has(relative)) continue;
    const full = path.resolve(paths.root, relative);
    if (!full.startsWith(paths.root + path.sep) || !fs.existsSync(full)) continue;
    await fsp.rm(full, { force: true });
    removed.push(relative);
  }

  // Mode strict : on vide aussi ce que le launcher n'a jamais installe. A
  // reserver aux dossiers entierement pilotes par le serveur, car cela efface
  // les ajouts du joueur.
  if (!keepExtra) {
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
  }

  if (removed.length) {
    onStatus?.(`${removed.length} fichier(s) obsolete(s) supprime(s).`);
  }
  return removed;
}

/** Telecharge et met a jour tous les fichiers du modpack. */
async function sync(manifest, { settings = {}, optionalEnabled = [], onProgress, onStatus } = {}) {
  paths.ensureAll();
  const files = normalizeFiles(manifest, { optionalEnabled });

  const removed = await pruneRemovedFiles(files.map((f) => f.relative), {
    keepExtra: settings.keepExtraMods !== false,
    cleanDirs: manifest.deleteExtraIn || ['mods'],
    onStatus,
  });

  const tasks = [];
  for (const file of files) {
    if (!file.url) {
      throw new Error(`Le fichier "${file.relative}" du manifest n'a pas d'URL.`);
    }
    if (await isValid(file.dest, { sha1: file.sha1, size: file.size })) continue;
    tasks.push({ name: file.name, dest: file.dest, url: file.url, sha1: file.sha1, size: file.size });
  }

  if (tasks.length) {
    onStatus?.(`Mise a jour du modpack : ${tasks.length} fichier(s)...`);
    await downloadAll(tasks, { onProgress, concurrency: 8 });
  } else {
    onStatus?.('Modpack a jour.');
  }

  await writeLedger(files.map((f) => f.relative));
  return { installed: tasks.length, removed: removed.length, total: files.length };
}

/** Mods presents dans le dossier mods mais absents du modpack officiel. */
async function listExtraMods() {
  const managed = new Set((await readLedger()).filter((f) => f.startsWith('mods/')).map((f) => path.basename(f)));
  if (!fs.existsSync(paths.mods)) return [];
  return (await fsp.readdir(paths.mods))
    .filter((f) => /\.jar$/i.test(f) && !managed.has(f));
}

module.exports = { fetchManifest, sync, listExtraMods, normalizeFiles, readLedger };
