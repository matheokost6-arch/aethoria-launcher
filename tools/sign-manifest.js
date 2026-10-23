#!/usr/bin/env node
'use strict';

/**
 * Signature du manifest (voir src/main/game/signature.js).
 *
 *   node tools/sign-manifest.js --keygen <fichier-cle-privee>
 *       Cree la paire de cles. La cle privee est ecrite dans le fichier (garde-la
 *       HORS du depot, sauvegarde-la) ; la cle publique est affichee : colle-la
 *       dans manifestPublicKey de src/shared/config.js.
 *
 *   node tools/sign-manifest.js --key <fichier-cle-privee> [--manifest manifest.json]
 *       Signe le manifest. La cle peut aussi venir de la variable
 *       AETHORIA_SIGN_KEY (chemin du fichier).
 */

const fs = require('fs');
const path = require('path');
const config = require('../src/shared/config');
const { signerManifest, verifierManifest, genererCles } = require('../src/main/game/signature');

/** Signe le fichier en place ; renvoie false si aucune cle n'est disponible et qu'aucune n'est exigee. */
function signerFichier(fichier, fichierCle = process.env.AETHORIA_SIGN_KEY) {
  if (!fichierCle || !fs.existsSync(fichierCle)) {
    if (config.manifestPublicKey) {
      throw new Error('Le launcher exige un manifest signé, mais la clé privée est introuvable (variable AETHORIA_SIGN_KEY).');
    }
    return false;
  }
  const manifest = JSON.parse(fs.readFileSync(fichier, 'utf8'));
  const signe = signerManifest(manifest, fs.readFileSync(fichierCle, 'utf8'));
  fs.writeFileSync(fichier, `${JSON.stringify(signe, null, 2)}\n`, 'utf8');
  if (config.manifestPublicKey) verifierManifest(signe); // la cle publique du launcher doit correspondre
  return true;
}

function main() {
  const args = process.argv.slice(2);
  const valeur = (nom) => { const i = args.indexOf(nom); return i >= 0 ? args[i + 1] : null; };

  if (args.includes('--keygen')) {
    const sortie = path.resolve(valeur('--keygen') || '');
    if (!valeur('--keygen')) throw new Error('Indique où écrire la clé privée.');
    if (fs.existsSync(sortie)) throw new Error('Ce fichier existe déjà : rien n’est écrasé.');
    const { clePrivee, clePublique } = genererCles();
    fs.writeFileSync(sortie, clePrivee, { mode: 0o600 });
    console.log(`Clé privée écrite dans ${sortie} (ne la partage jamais, ne la mets pas dans git).`);
    console.log('\nClé publique à coller dans manifestPublicKey (src/shared/config.js) :\n');
    console.log(clePublique);
    return;
  }

  const fichier = path.resolve(valeur('--manifest') || 'manifest.json');
  if (!signerFichier(fichier, valeur('--key') || process.env.AETHORIA_SIGN_KEY)) {
    throw new Error('Aucune clé privée : utilise --key <fichier> ou AETHORIA_SIGN_KEY.');
  }
  console.log(`Manifest signé : ${fichier}`);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`Échec : ${err.message}`);
    process.exit(1);
  }
}

module.exports = { signerFichier };
