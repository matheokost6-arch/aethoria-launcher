'use strict';

const crypto = require('crypto');

// Regle Mojang pour les pseudos : 3 a 16 caracteres alphanumeriques ou underscore.
const NAME_PATTERN = /^[A-Za-z0-9_]{3,16}$/;

/**
 * UUID hors-ligne, calcule exactement comme le fait le serveur Minecraft quand
 * online-mode=false : UUID de version 3 (MD5) sur la chaine
 * "OfflinePlayer:<pseudo>".
 *
 * C'est essentiel : si le launcher generait un UUID aleatoire, le joueur
 * perdrait son inventaire, sa position et ses permissions a chaque connexion,
 * puisque le serveur, lui, recalcule toujours cet UUID-la a partir du pseudo.
 */
function offlineUuid(name) {
  const md5 = crypto.createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
  md5[6] = (md5[6] & 0x0f) | 0x30; // version 3
  md5[8] = (md5[8] & 0x3f) | 0x80; // variante RFC 4122
  const hex = md5.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function validateName(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw new Error('Entre un pseudo.');
  if (trimmed.length < 3) throw new Error('Le pseudo doit faire au moins 3 caracteres.');
  if (trimmed.length > 16) throw new Error('Le pseudo ne peut pas depasser 16 caracteres.');
  if (!NAME_PATTERN.test(trimmed)) {
    throw new Error('Le pseudo ne peut contenir que des lettres, des chiffres et des underscores.');
  }
  return trimmed;
}

/**
 * Cree un compte hors-ligne. Le jeton d'acces est une valeur factice : le
 * serveur en online-mode=false ne la verifie pas, mais le client refuse de
 * demarrer si le champ est vide.
 */
function login(name) {
  const validated = validateName(name);
  const uuid = offlineUuid(validated);
  return {
    id: `offline:${uuid}`,
    type: 'offline',
    name: validated,
    uuid,
    accessToken: '0'.repeat(32),
    refreshToken: null,
    expiresAt: null, // un compte hors-ligne n'expire jamais
    skinUrl: null,
    addedAt: Date.now(),
  };
}

module.exports = { login, offlineUuid, validateName };
