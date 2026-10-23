'use strict';

const crypto = require('crypto');
const config = require('../../shared/config');

/**
 * Signature du manifest (Ed25519).
 *
 * Le manifest dit quels mods sont autorises. Sans signature, quiconque modifie
 * la copie gardee sur son disque (manifest.cache.json), puis coupe Internet,
 * pourrait y ajouter ses propres mods. Avec une signature, le launcher ne croit
 * que les manifests signes par la cle privee d'Aethoria, qui ne quitte jamais
 * la machine du proprietaire. La cle publique, elle, est dans config.js.
 *
 * Tant que config.manifestPublicKey est vide, le controle est inactif.
 */

/** JSON a l'ordre des cles fixe : la meme chose est signee et verifiee. */
function canonique(valeur) {
  if (Array.isArray(valeur)) return `[${valeur.map(canonique).join(',')}]`;
  if (valeur && typeof valeur === 'object') {
    return `{${Object.keys(valeur).sort()
      .filter((cle) => valeur[cle] !== undefined)
      .map((cle) => `${JSON.stringify(cle)}:${canonique(valeur[cle])}`).join(',')}}`;
  }
  return JSON.stringify(valeur);
}

const sansSignature = ({ signature, ...reste }) => reste;

function cleActive() {
  return String(config.manifestPublicKey || '').trim();
}

/** Lance une erreur si le manifest n'est pas signe par Aethoria. */
function verifierManifest(manifest) {
  const cle = cleActive();
  if (!cle) return true;
  if (!manifest || typeof manifest.signature !== 'string') {
    throw new Error('La liste des mods n’est pas signée par Aethoria.');
  }
  let valide = false;
  try {
    valide = crypto.verify(
      null,
      Buffer.from(canonique(sansSignature(manifest)), 'utf8'),
      { key: Buffer.from(cle, 'base64'), format: 'der', type: 'spki' },
      Buffer.from(manifest.signature, 'base64'),
    );
  } catch {
    valide = false;
  }
  if (!valide) throw new Error('La signature de la liste des mods est fausse.');
  return true;
}

/** Signe un manifest avec une cle privee PEM (outil du proprietaire). */
function signerManifest(manifest, clePriveePem) {
  const corps = sansSignature(manifest);
  const signature = crypto.sign(null, Buffer.from(canonique(corps), 'utf8'), crypto.createPrivateKey(clePriveePem));
  return { ...corps, signature: signature.toString('base64') };
}

/** Nouvelle paire de cles : { clePrivee (PEM), clePublique (base64 DER) }. */
function genererCles() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    clePrivee: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    clePublique: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  };
}

module.exports = { verifierManifest, signerManifest, genererCles, canonique };
