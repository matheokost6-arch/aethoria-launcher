'use strict';

const crypto = require('crypto');

/**
 * Regles de moderation : construction des commandes EssentialsX et lecture des
 * reponses du serveur. Aucune dependance a Electron : testable seul.
 */

const PSEUDO = /^[A-Za-z0-9_]{3,16}$/;

// Durees au format EssentialsX (datediff).
const DURATIONS = {
  '10m': '10 minutes',
  '1h': '1 heure',
  '1d': '1 jour',
  '7d': '7 jours',
  '30d': '30 jours',
  perm: 'Définitif',
};

function checkPseudo(pseudo) {
  const name = String(pseudo || '').trim();
  if (!PSEUDO.test(name)) throw new Error('Pseudo invalide : 3 à 16 caractères, lettres, chiffres et _.');
  return name;
}

/** Une raison tient sur une ligne : un retour a la ligne pourrait glisser une seconde commande. */
function cleanReason(reason) {
  return String(reason || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)
    || 'Aucune raison précisée';
}

function checkDuration(duration) {
  if (!Object.hasOwn(DURATIONS, duration)) throw new Error('Durée inconnue.');
  return duration;
}

/** Commande EssentialsX pour une sanction. */
function buildCommand(action, { pseudo, duration, reason } = {}) {
  const name = checkPseudo(pseudo);
  const why = cleanReason(reason);
  switch (action) {
    case 'kick':
      return `kick ${name} ${why}`;
    case 'mute':
      return checkDuration(duration) === 'perm' ? `mute ${name} ${why}` : `mute ${name} ${duration} ${why}`;
    case 'ban':
      return checkDuration(duration) === 'perm' ? `ban ${name} ${why}` : `tempban ${name} ${duration} ${why}`;
    case 'unban':
      return `unban ${name}`;
    case 'unmute':
      // Avec EssentialsX, "mute" sans duree bascule : il rend la parole a un
      // joueur muet. L'appelant doit verifier l'etat avant (voir isMuted).
      return `mute ${name}`;
    default:
      throw new Error('Action inconnue.');
  }
}

/** Lecture de "seen" (EssentialsX) : le joueur est-il muet ? */
function isMuted(seenOutput) {
  return /Muted:\s*true/i.test(seenOutput);
}

/** Reponse de "minecraft:list" : "There are 2 of a max of 20 players online: Baron, Sirelle". */
function parseList(output) {
  const counts = output.match(/There are (\d+) of a max of (\d+)/i);
  const names = (output.split(/players online:/i)[1] || '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => PSEUDO.test(name));
  return {
    online: counts ? Number(counts[1]) : names.length,
    max: counts ? Number(counts[2]) : null,
    players: names,
  };
}

/**
 * Remplace le contenu imbrique ({...} et [...] a l'interieur d'une entree) par
 * des espaces : les enchantements ont eux aussi des champs "id", qu'il ne faut
 * pas confondre avec l'identifiant de l'objet.
 */
function topLevelOnly(entry) {
  let depth = 0;
  let inString = false;
  let out = '';
  for (let i = 0; i < entry.length; i += 1) {
    const c = entry[i];
    if (c === '"' && entry[i - 1] !== '\\') inString = !inString;
    if (!inString && (c === '{' || c === '[')) depth += 1;
    out += depth > 1 ? ' ' : c;
    if (!inString && (c === '}' || c === ']')) depth -= 1;
  }
  return out;
}

/** Decoupe la liste SNBT "[{...}, {...}]" en entrees de premier niveau. */
function splitEntries(list) {
  const entries = [];
  let depth = 0;
  let inString = false;
  let start = -1;
  for (let i = 0; i < list.length; i += 1) {
    const c = list[i];
    if (c === '"' && list[i - 1] !== '\\') inString = !inString;
    if (inString) continue;
    if (c === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (c === '}') {
      depth -= 1;
      if (depth === 0 && start >= 0) entries.push(list.slice(start, i + 1));
    }
  }
  return entries;
}

function prettyItem(id) {
  const [namespace, name] = id.includes(':') ? id.split(':') : ['minecraft', id];
  return {
    label: name.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
    mod: namespace === 'minecraft' ? null : namespace,
  };
}

/**
 * Reponse de "minecraft:data get entity <pseudo> Inventory|EnderItems".
 * Renvoie null si le joueur n'est pas connecte.
 */
function parseInventory(output) {
  if (/No entity was found|found no elements|Found no elements/i.test(output)) return null;
  const start = output.indexOf('[');
  if (start < 0) return null;

  return splitEntries(output.slice(start)).map((entry) => {
    const fields = topLevelOnly(entry);
    const id = fields.match(/id:\s*"([^"]+)"/)?.[1];
    if (!id) return null;
    return {
      slot: Number(fields.match(/Slot:\s*(-?\d+)b/)?.[1] ?? -1),
      id,
      count: Number(fields.match(/Count:\s*(\d+)b/)?.[1] ?? 1),
      enchanted: /Enchantments:/.test(entry),
      ...prettyItem(id),
    };
  }).filter(Boolean);
}

/** UUID hors ligne, comme le serveur : utile pour afficher la tete du joueur. */
function offlineUuid(name) {
  const md5 = crypto.createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
  md5[6] = (md5[6] & 0x0f) | 0x30;
  md5[8] = (md5[8] & 0x3f) | 0x80;
  const hex = md5.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

module.exports = {
  DURATIONS, checkPseudo, cleanReason, buildCommand, isMuted, parseList, parseInventory, offlineUuid,
};
