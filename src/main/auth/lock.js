'use strict';

const crypto = require('crypto');

/**
 * Scellé du pseudo.
 *
 * Le pseudo est gravé dans le registre (Windows) pour rester le même d'une
 * installation à l'autre. Problème : n'importe qui peut ouvrir regedit et
 * changer cette valeur à la main. On scelle donc le pseudo avec un HMAC : le
 * launcher n'accepte une valeur du registre que si son sceau correspond. Une
 * valeur éditée à la main n'a pas le bon sceau → elle est rejetée, et le
 * launcher se répare à partir d'une copie scellée de secours.
 *
 * Honnêteté : le secret ci-dessous vit dans le code du launcher, qui tourne sur
 * la machine du joueur. Quelqu'un de déterminé (ou une IA) peut l'extraire et
 * forger un sceau. Ce n'est donc pas une barrière absolue, mais un ralentisseur
 * sérieux contre l'édition « à la main ». La vraie protection du compte reste le
 * mot de passe AuthMe, côté serveur.
 */

// Secret de scellage (propre à ce launcher). L'obfuscation de build le masque.
const SECRET = Buffer.from('ae99789b49ada8aa4278bdf7ff0faa536dd935fb636e428c3f5b5db0087df98c', 'hex');

function sceau(pseudo) {
  return crypto.createHmac('sha256', SECRET).update(`aethoria:pseudo:${String(pseudo)}`, 'utf8').digest('hex');
}

function sceauValide(pseudo, sig) {
  if (typeof pseudo !== 'string' || typeof sig !== 'string') return false;
  const attendu = sceau(pseudo);
  if (sig.length !== attendu.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(attendu, 'hex'));
  } catch {
    return false;
  }
}

module.exports = { sceau, sceauValide };
