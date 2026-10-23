'use strict';

/**
 * Controles de securite hors ligne (aucun reseau, aucun jeu) :
 *   node tests/integrite.js
 * Verifie la quarantaine des mods etrangers, la detection d'un mod modifie, la
 * signature du manifest et le filtre des adresses de telechargement.
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const racine = fs.mkdtempSync(path.join(os.tmpdir(), 'aethoria-test-'));
const paths = require('../src/main/game/paths');
paths.setRoot(racine);
const modpack = require('../src/main/game/modpack');
const { verifierUrl } = require('../src/main/game/downloader');
const signature = require('../src/main/game/signature');
const config = require('../src/shared/config');
const check = require('../src/main/validate');

const sha1 = (texte) => crypto.createHash('sha1').update(texte).digest('hex');
let nb = 0;
const ok = (nom, fn) => Promise.resolve().then(fn).then(() => { nb += 1; console.log(`OK    ${nom}`); }, (err) => {
  console.error(`ECHEC ${nom} : ${err.message}`);
  process.exitCode = 1;
});

(async () => {
  fs.mkdirSync(path.join(racine, 'mods'), { recursive: true });
  fs.writeFileSync(path.join(racine, 'mods', 'officiel.jar'), 'contenu officiel');
  fs.writeFileSync(path.join(racine, 'mods', 'triche.jar'), 'mod du joueur');
  fs.mkdirSync(path.join(racine, 'mods', '1.20.1'));
  fs.writeFileSync(path.join(racine, 'mods', 'optionnel.jar'), 'mod optionnel decoche');

  const manifest = {
    files: [{ path: 'mods/officiel.jar', url: 'https://github.com/aethoria-mc/aethoria/x.jar', sha1: sha1('contenu officiel'), size: 16 }],
    optionalMods: [{ id: 'opt', requires: [], path: 'mods/optionnel.jar', url: 'https://cdn.modrinth.com/x.jar', sha1: sha1('autre'), size: 5 }],
  };

  await ok('un mod ajoute par le joueur part en quarantaine', async () => {
    const r = await modpack.verifyInstalled(manifest);
    assert.deepStrictEqual(r.quarantined.sort(), ['1.20.1', 'triche.jar']);
    assert.ok(!fs.existsSync(path.join(racine, 'mods', 'triche.jar')));
    assert.ok(fs.readdirSync(path.join(racine, 'quarantaine')).length === 1);
    assert.deepStrictEqual(r.abimes, []);
  });
  await ok('un mod optionnel decoche est retire sans alerte', async () => {
    assert.ok(!fs.existsSync(path.join(racine, 'mods', 'optionnel.jar')));
  });
  await ok('un mod officiel modifie est detecte', async () => {
    fs.writeFileSync(path.join(racine, 'mods', 'officiel.jar'), 'contenu OFFICIEL modifie');
    assert.deepStrictEqual((await modpack.verifyInstalled(manifest)).abimes, ['officiel.jar']);
  });
  await ok('un fichier du manifest sans empreinte est refuse', async () => {
    const sans = { files: [{ path: 'mods/x.jar', url: 'https://github.com/a/b/x.jar' }] };
    await assert.rejects(() => modpack.verifyInstalled(sans), /empreinte/);
  });
  await ok('un chemin hors des dossiers autorises est refuse', async () => {
    const piege = { files: [{ path: '../evil.jar', url: 'https://github.com/a/b/x.jar', sha1: 'a'.repeat(40) }] };
    await assert.rejects(() => modpack.verifyInstalled(piege), /refusé/);
  });
  await ok('les adresses non https ou hors liste sont refusees', async () => {
    verifierUrl('https://github.com/aethoria-mc/aethoria/releases/download/x/y.jar');
    verifierUrl('https://cdn.modrinth.com/data/x.jar');
    for (const mauvaise of ['http://github.com/x', 'https://evil.example.com/x.jar', 'https://github.com.evil.com/x', 'ftp://github.com/x', 'https://u:p@github.com/x']) {
      assert.throws(() => verifierUrl(mauvaise), /refusé|invalide/, mauvaise);
    }
  });
  await ok('la signature du manifest est verifiee', async () => {
    const { clePrivee, clePublique } = signature.genererCles();
    const signe = signature.signerManifest({ b: 1, a: [1, 2], files: [] }, clePrivee);
    config.manifestPublicKey = clePublique;
    signature.verifierManifest(signe);
    assert.throws(() => signature.verifierManifest({ ...signe, files: [{ path: 'mods/x.jar' }] }), /fausse/);
    assert.throws(() => signature.verifierManifest({ a: 1 }), /pas signée/);
    config.manifestPublicKey = '';
    signature.verifierManifest({ a: 1 }); // controle inactif sans cle publique
  });
  await ok('les arguments de l’interface sont filtres', async () => {
    assert.strictEqual(check.pseudo(' Bob_12 '), 'Bob_12');
    for (const mauvais of ['ab', 'a'.repeat(17), 'bob bob', 'bob;rm', 12, null]) assert.throws(() => check.pseudo(mauvais));
    assert.strictEqual(check.lienAutorise('https://discord.gg/xyz'), 'https://discord.gg/xyz');
    for (const mauvais of ['file:///C:/x', 'ms-msdt:/x', 'http://discord.gg', 'https://discord.gg.evil.com']) assert.strictEqual(check.lienAutorise(mauvais), null);
    assert.throws(() => check.nomDeFichier('../../x.png'));
    assert.throws(() => check.serveur({ host: 'a b', port: 25565 }));
  });

  fs.rmSync(racine, { recursive: true, force: true });
  console.log(`\n${nb} controles passes${process.exitCode ? ', avec des échecs' : ''}.`);
})();
