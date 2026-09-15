'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { nativeImage, shell } = require('electron');
const paths = require('./paths');

/** Captures d'ecran prises en jeu avec F2. */

const folder = () => path.join(paths.root, 'screenshots');

async function thumbnail(file) {
  try {
    // Miniature fournie par Windows : bien plus rapide que de decoder une
    // capture de plusieurs megaoctets.
    return (await nativeImage.createThumbnailFromPath(file, { width: 320, height: 180 })).toDataURL();
  } catch {
    return nativeImage.createFromPath(file).resize({ width: 320 }).toDataURL();
  }
}

/** Les captures les plus recentes, avec leur miniature. */
async function list(limit = 48) {
  let names;
  try {
    names = await fsp.readdir(folder());
  } catch {
    return [];
  }
  const images = await Promise.all(names
    .filter((name) => /\.(png|jpe?g)$/i.test(name))
    .map(async (name) => ({ name, date: (await fsp.stat(path.join(folder(), name))).mtimeMs })));

  images.sort((a, b) => b.date - a.date);
  return Promise.all(images.slice(0, limit).map(async (image) => ({
    ...image,
    thumb: await thumbnail(path.join(folder(), image.name)),
  })));
}

function open(name) {
  // Un nom de fichier seul : l'interface ne doit pas pouvoir ouvrir autre chose.
  if (path.basename(String(name)) !== name) throw new Error('Capture introuvable.');
  return shell.openPath(path.join(folder(), name));
}

function openFolder() {
  fs.mkdirSync(folder(), { recursive: true });
  return shell.openPath(folder());
}

module.exports = { list, open, openFolder };
