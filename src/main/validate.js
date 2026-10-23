'use strict';

/**
 * Controles des arguments recus de l'interface. Le processus principal ne fait
 * jamais confiance a ce que la page lui envoie : chaque canal verifie ses
 * arguments ici avant d'agir.
 */

const PSEUDO = /^[A-Za-z0-9_]{3,16}$/;
const NOM_FICHIER = /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,150}$/;
const IDENTIFIANT = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const HOTE = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;

// Sites que le launcher accepte d'ouvrir dans le navigateur du joueur.
const SITES_AUTORISES = [
  'discord.gg', 'discord.com', 'www.discord.com',
  'youtube.com', 'www.youtube.com', 'youtu.be',
  'github.com', 'aethoria-mc.github.io',
  'modrinth.com', 'www.modrinth.com',
];

function texte(valeur, { max = 200, nom = 'valeur' } = {}) {
  if (typeof valeur !== 'string' || valeur.length > max) throw new Error(`Donnée refusée : ${nom}.`);
  return valeur;
}

function pseudo(valeur) {
  if (typeof valeur !== 'string' || !PSEUDO.test(valeur.trim())) {
    throw new Error('Le pseudo doit faire 3 à 16 caractères : lettres, chiffres ou « _ ».');
  }
  return valeur.trim();
}

/** Nom de fichier seul (capture, rapport, sauvegarde) : jamais un chemin. */
function nomDeFichier(valeur) {
  if (typeof valeur !== 'string' || !NOM_FICHIER.test(valeur) || valeur.includes('..')) {
    throw new Error('Nom de fichier refusé.');
  }
  return valeur;
}

function identifiant(valeur) {
  if (typeof valeur !== 'string' || !IDENTIFIANT.test(valeur)) throw new Error('Identifiant refusé.');
  return valeur;
}

function listeIdentifiants(valeur, max = 100) {
  if (!Array.isArray(valeur) || valeur.length > max) throw new Error('Liste refusée.');
  return valeur.map(identifiant);
}

/** Adresse de serveur : nom de machine et port. */
function serveur(valeur) {
  if (valeur == null) return {};
  const { host, port } = valeur;
  if (typeof host !== 'string' || !HOTE.test(host)) throw new Error('Adresse du serveur refusée.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port du serveur refusé.');
  return { host, port };
}

/** Lien web https vers un site de la liste, ou null. */
function lienAutorise(url) {
  try {
    const adresse = new URL(url);
    if (adresse.protocol !== 'https:' || adresse.username || adresse.password) return null;
    const hote = adresse.hostname.toLowerCase();
    return SITES_AUTORISES.includes(hote) ? adresse.href : null;
  } catch {
    return null;
  }
}

module.exports = { PSEUDO, texte, pseudo, nomDeFichier, identifiant, listeIdentifiants, serveur, lienAutorise };
