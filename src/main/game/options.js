'use strict';

const fsp = require('fs/promises');
const path = require('path');
const paths = require('./paths');

/**
 * Options de Minecraft (options.txt) : prereglages graphiques et
 * reinitialisation. Seules les cles du prereglage sont modifiees : touches,
 * son et langue du joueur restent intacts.
 */

const PRESETS = {
  performance: {
    renderDistance: 6, simulationDistance: 5, graphicsMode: 0, particles: 2, ao: false,
    entityShadows: false, biomeBlendRadius: 0, entityDistanceScaling: 0.75, renderClouds: '"false"', mipmapLevels: 0,
  },
  balanced: {
    renderDistance: 10, simulationDistance: 8, graphicsMode: 1, particles: 1, ao: true,
    entityShadows: true, biomeBlendRadius: 1, entityDistanceScaling: 1.0, renderClouds: '"fast"', mipmapLevels: 2,
  },
  quality: {
    renderDistance: 14, simulationDistance: 10, graphicsMode: 1, particles: 0, ao: true,
    entityShadows: true, biomeBlendRadius: 2, entityDistanceScaling: 1.25, renderClouds: '"true"', mipmapLevels: 4,
  },
};

const optionsFile = () => path.join(paths.root, 'options.txt');

// Sauvegardes conservees hors du dossier de jeu : "Tout reinstaller" ou un
// changement de dossier ne les efface pas.
const backupDir = () => path.join(paths.userData, 'options-backups');
const BACKUP_LIMIT = 10;
const BACKUP_NAME = /^options-[\w-]+\.txt$/;

/** Copie datee d'options.txt. Renvoie son nom, ou null s'il n'y a rien a copier. */
async function backup() {
  const content = await fsp.readFile(optionsFile(), 'utf8').catch(() => null);
  if (content === null) return null;

  await fsp.mkdir(backupDir(), { recursive: true });
  const name = `options-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
  await fsp.writeFile(path.join(backupDir(), name), content, 'utf8');

  // Noms horodates en ISO : l'ordre alphabetique est l'ordre chronologique.
  const all = (await fsp.readdir(backupDir())).filter((f) => BACKUP_NAME.test(f)).sort();
  await Promise.all(all.slice(0, -BACKUP_LIMIT).map((f) => fsp.rm(path.join(backupDir(), f), { force: true })));
  return name;
}

async function listBackups() {
  const names = (await fsp.readdir(backupDir()).catch(() => [])).filter((f) => BACKUP_NAME.test(f));
  const backups = await Promise.all(names.map(async (name) => ({
    name,
    date: (await fsp.stat(path.join(backupDir(), name))).mtimeMs,
  })));
  return backups.sort((a, b) => b.date - a.date);
}

async function restore(name) {
  if (path.basename(String(name)) !== name || !BACKUP_NAME.test(name)) throw new Error('Sauvegarde introuvable.');
  // Les reglages actuels sont sauvegardes d'abord : une restauration ne perd rien.
  await backup();
  await fsp.mkdir(paths.root, { recursive: true });
  await fsp.copyFile(path.join(backupDir(), name), optionsFile());
}

async function applyPreset(name) {
  const preset = PRESETS[name];
  if (!preset) throw new Error('Préréglage graphique inconnu.');
  await backup();

  const content = await fsp.readFile(optionsFile(), 'utf8').catch(() => '');
  const pending = new Map(Object.entries(preset));
  const lines = content.split(/\r?\n/).filter(Boolean).map((line) => {
    const key = line.includes(':') ? line.slice(0, line.indexOf(':')) : null;
    if (!pending.has(key)) return line;
    const value = pending.get(key);
    pending.delete(key);
    return `${key}:${value}`;
  });
  for (const [key, value] of pending) lines.push(`${key}:${value}`);

  await fsp.mkdir(paths.root, { recursive: true });
  await fsp.writeFile(optionsFile(), `${lines.join('\n')}\n`, 'utf8');
}

/** Minecraft recree un options.txt par defaut au prochain lancement. */
async function reset() {
  await backup();
  await fsp.rm(optionsFile(), { force: true });
}

module.exports = { applyPreset, reset, backup, listBackups, restore };
