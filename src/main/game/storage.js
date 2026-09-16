'use strict';

const fsp = require('fs/promises');
const path = require('path');
const paths = require('./paths');

/**
 * Espace occupe par le dossier de jeu, et nettoyage de ce qui ne sert plus :
 * rapports de plantage, anciens journaux et fichiers temporaires. Les mondes,
 * captures, options et mods ne sont jamais touches.
 */

async function dirSize(dir) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  const sizes = await Promise.all(entries.map(async (entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return dirSize(full);
    try {
      return (await fsp.stat(full)).size;
    } catch {
      return 0;
    }
  }));
  return sizes.reduce((total, size) => total + size, 0);
}

async function listFiles(dir) {
  try {
    return (await fsp.readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

/** Fichiers supprimables sans consequence pour le joueur. */
async function cleanableFiles() {
  const [crashReports, gameLogs, launchLogs, temp] = await Promise.all([
    listFiles(path.join(paths.root, 'crash-reports')),
    listFiles(path.join(paths.root, 'logs')),
    listFiles(paths.logs),
    listFiles(paths.temp),
  ]);
  // Les plantages de moins de 7 jours restent : l'onglet Aide les affiche.
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const oldCrashReports = (await Promise.all(crashReports.map(async (file) => (
    (await fsp.stat(file).then((s) => s.mtimeMs, () => 0)) < weekAgo ? file : null
  )))).filter(Boolean);

  return [
    ...oldCrashReports,
    // Minecraft archive chaque ancien journal en .gz ; latest.log reste.
    ...gameLogs.filter((file) => file.endsWith('.gz')),
    // Les 5 derniers journaux de lancement servent encore au diagnostic.
    ...launchLogs.filter((file) => path.basename(file).startsWith('launch-')).sort().slice(0, -5),
    ...temp,
  ];
}

async function sizeOf(files) {
  const sizes = await Promise.all(files.map((file) => fsp.stat(file).then((s) => s.size, () => 0)));
  return sizes.reduce((total, size) => total + size, 0);
}

async function info() {
  const [total, cleanable] = await Promise.all([
    dirSize(paths.root),
    cleanableFiles().then(sizeOf),
  ]);
  return { total, cleanable };
}

async function clean() {
  const files = await cleanableFiles();
  const freed = await sizeOf(files);
  await Promise.all(files.map((file) => fsp.rm(file, { force: true })));
  return { freed, count: files.length };
}

module.exports = { info, clean };
