'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { nativeImage, shell, clipboard, ClipboardItem } = require('electron');
const paths = require('./paths');

/** Captures d'ecran prises en jeu avec F2. */

const folder = () => path.join(paths.root, 'screenshots');

/** Un nom de fichier seul : l'interface ne doit pas pouvoir viser autre chose. */
function screenshotPath(name) {
  if (typeof name !== 'string' || path.basename(name) !== name || !/^[^<>:"/\\|?*]+\.(png|jpe?g)$/i.test(name)) {
    throw new Error('Capture introuvable.');
  }
  return path.join(folder(), name);
}

async function thumbnail(file) {
  try {
    // Miniature fournie par Windows : bien plus rapide que de decoder une
    // capture de plusieurs megaoctets.
    return (await nativeImage.createThumbnailFromPath(file, { width: 320, height: 180 })).toDataURL();
  } catch {
    return nativeImage.createFromPath(file).resize({ width: 320 }).toDataURL();
  }
}

/** Noms et dates des captures, de la plus recente a la plus ancienne. */
async function recent() {
  let names;
  try {
    names = await fsp.readdir(folder());
  } catch {
    return [];
  }
  const images = await Promise.all(names
    .filter((name) => /\.(png|jpe?g)$/i.test(name))
    .map(async (name) => ({ name, date: (await fsp.stat(path.join(folder(), name))).mtimeMs })));
  return images.sort((a, b) => b.date - a.date);
}

/** Captures recentes, reduites en JPEG, pour servir de fond d'ecran au launcher. */
async function backgrounds(limit = 6) {
  return (await recent()).slice(0, limit).map(({ name }) => {
    const image = nativeImage.createFromPath(path.join(folder(), name));
    if (image.isEmpty()) return null;
    return `data:image/jpeg;base64,${image.resize({ width: 1600 }).toJPEG(82).toString('base64')}`;
  }).filter(Boolean);
}

/** Les captures les plus recentes, avec leur miniature. */
async function list(limit = 48) {
  const images = await recent();
  return Promise.all(images.slice(0, limit).map(async (image) => ({
    ...image,
    thumb: await thumbnail(path.join(folder(), image.name)),
  })));
}

function open(name) {
  return shell.openPath(screenshotPath(name));
}

/**
 * Copie l'image dans le presse-papiers, prete a coller sur Discord.
 * Electron 44 n'a plus clipboard.writeImage : on passe par le modele
 * ClipboardItem, en PNG (les captures JPG sont converties au passage).
 */
async function copy(name) {
  const image = nativeImage.createFromPath(screenshotPath(name));
  if (image.isEmpty()) throw new Error('Capture illisible.');
  const png = new Blob([image.toPNG()], { type: 'image/png' });
  await clipboard.write([new ClipboardItem({ 'image/png': png })]);
  return true;
}

/** Corbeille plutot que suppression : une erreur de clic se rattrape. */
function trash(name) {
  return shell.trashItem(screenshotPath(name));
}

function openFolder() {
  fs.mkdirSync(folder(), { recursive: true });
  return shell.openPath(folder());
}

module.exports = { list, backgrounds, open, copy, trash, openFolder };
