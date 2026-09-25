'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { app } = require('electron');
const paths = require('./paths');

/**
 * Skin du joueur, pour afficher sa tete dans le launcher.
 *
 * Un pseudo sans compte Microsoft n'a pas de skin officiel : on cherche donc,
 * dans l'ordre,
 *   1. le skin choisi en jeu, que le mod QuickSkin enregistre dans le dossier
 *      du jeu (quickskin/uploads/skins/<pseudo>.png) ;
 *   2. le skin officiel, si le pseudo correspond a un vrai compte Minecraft ;
 *   3. rien : l'interface garde la tete par defaut.
 *
 * Seules les textures servies par Mojang sont telechargees, et le resultat est
 * garde en cache : ni l'interface ni le reseau ne sont sollicites a chaque
 * affichage.
 */

const TEXTURES = /^https?:\/\/textures\.minecraft\.net\/texture\/([0-9a-f]{32,64})$/i;
const CACHE_MS = 10 * 60 * 1000;
const TAILLE_MAX = 512 * 1024; // un skin fait quelques kilo-octets
const SIGNATURE_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PSEUDO = /^[A-Za-z0-9_]{3,16}$/;

let cache = null; // { at, id, dataUrl, source }

const dossierSkins = () => path.join(paths.root, 'quickskin', 'uploads', 'skins');
const fichierCache = () => path.join(app.getPath('userData'), 'skin-cache.json');

function enImage(octets) {
  if (octets.length < 8 || octets.length > TAILLE_MAX || !octets.subarray(0, 8).equals(SIGNATURE_PNG)) {
    throw new Error('Skin refusé : ce n’est pas une image PNG valide.');
  }
  return `data:image/png;base64,${octets.toString('base64')}`;
}

async function demander(url) {
  const reponse = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!reponse.ok) throw new Error(`HTTP ${reponse.status}`);
  return reponse;
}

/**
 * Skin choisi en jeu. QuickSkin nomme le fichier d'apres le pseudo, et ajoute
 * un numero a chaque nouveau skin : le plus recent est le bon.
 */
async function skinDuJeu(pseudo) {
  try {
    const dossier = dossierSkins();
    const debut = `${pseudo.toLowerCase()}`;
    const candidats = (await fsp.readdir(dossier))
      .filter((nom) => nom.toLowerCase().startsWith(debut) && nom.toLowerCase().endsWith('.png'));
    if (!candidats.length) return null;

    const avecDate = await Promise.all(candidats.map(async (nom) => {
      const complet = path.join(dossier, nom);
      return { complet, date: (await fsp.stat(complet)).mtimeMs };
    }));
    const recent = avecDate.sort((a, b) => b.date - a.date)[0];
    return { id: `local:${path.basename(recent.complet)}:${Math.round(recent.date)}`, fichier: recent.complet };
  } catch {
    return null; // le mod n'a pas encore servi, ou le dossier est illisible
  }
}

/** Adresse du skin du compte Minecraft officiel portant ce pseudo. */
async function skinOfficiel(pseudo) {
  if (!PSEUDO.test(pseudo)) return null;
  try {
    const profil = await (await demander(`https://api.mojang.com/users/profiles/minecraft/${pseudo}`)).json();
    if (!profil?.id) return null;
    const details = await (await demander(`https://sessionserver.mojang.com/session/minecraft/profile/${profil.id}`)).json();
    const textures = details?.properties?.find((p) => p.name === 'textures')?.value;
    if (!textures) return null;
    const url = JSON.parse(Buffer.from(textures, 'base64').toString('utf8'))?.textures?.SKIN?.url || '';
    const empreinte = TEXTURES.exec(url)?.[1];
    // Mojang annonce parfois l'adresse en http : on telecharge toujours en https.
    return empreinte ? { id: empreinte, url: `https://textures.minecraft.net/texture/${empreinte}` } : null;
  } catch {
    return null; // pseudo sans compte officiel, ou Mojang injoignable
  }
}

function lireCacheDisque() {
  try {
    const donnees = JSON.parse(fs.readFileSync(fichierCache(), 'utf8'));
    return donnees?.dataUrl?.startsWith('data:image/png;base64,') ? donnees : null;
  } catch {
    return null;
  }
}

/**
 * Skin du joueur : { dataUrl, source } ou null.
 * L'interface en decoupe la tete ; le launcher ne fait que le fournir.
 */
async function get({ name } = {}, { force = false } = {}) {
  if (!name) return null;
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache;

  const connu = cache || lireCacheDisque();
  const local = await skinDuJeu(name);
  const officiel = local ? null : await skinOfficiel(name);
  const trouve = local || officiel;
  if (!trouve) return connu;

  // Meme skin que la derniere fois : inutile de le relire ou de le retelecharger.
  if (connu?.id === trouve.id) {
    cache = { ...connu, at: Date.now() };
    return cache;
  }

  try {
    const octets = local
      ? await fsp.readFile(local.fichier)
      : Buffer.from(await (await demander(officiel.url)).arrayBuffer());
    cache = {
      at: Date.now(),
      id: trouve.id,
      dataUrl: enImage(octets),
      source: local ? 'jeu' : 'minecraft',
    };
    // Le cache disque n'est qu'un confort : s'il echoue, le skin reste affiche.
    try {
      await fsp.writeFile(fichierCache(), JSON.stringify({ id: cache.id, dataUrl: cache.dataUrl, source: cache.source }), 'utf8');
    } catch {
      // dossier de donnees indisponible
    }
    return cache;
  } catch {
    return connu; // le dernier skin connu vaut mieux que rien
  }
}

module.exports = { get };
