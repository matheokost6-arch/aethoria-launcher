#!/usr/bin/env node
'use strict';

/**
 * Construit puis publie le launcher sur une release GitHub.
 *
 * Pourquoi ce script plutot que "electron-builder --publish always" :
 * electron-builder publie ses cibles (nsis et portable) en parallele, et
 * chacune tente de creer la release. Les deux appels partent avant que l'une
 * ait abouti, ce qui cree DEUX releases portant le meme tag ; les fichiers se
 * repartissent alors entre elles et il en manque toujours d'un cote. Pire,
 * latest.yml peut manquer sans qu'aucune erreur ne soit signalee — et sans ce
 * fichier, la mise a jour automatique ne fonctionne plus, en silence.
 *
 * Ici la release est creee une seule fois, puis les fichiers sont envoyes, puis
 * le resultat est verifie.
 *
 * Prerequis : gh installe et connecte (gh auth login).
 *
 * Utilisation :
 *   node tools/publish-launcher.js
 *   node tools/publish-launcher.js --skip-build   (reutilise dist/ tel quel)
 */

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const config = require('../src/shared/config');
const pkg = require('../package.json');

const REPO = `${config.github.owner}/${config.github.repo}`;
const TAG = `v${pkg.version}`;
const DIST = path.resolve('dist');

function gh(args, options = {}) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: 'pipe', ...options });
}

function ghQuiet(args) {
  return spawnSync('gh', args, { encoding: 'utf8' });
}

function fail(message) {
  console.error(`\nEchec : ${message}`);
  process.exit(1);
}

function main() {
  if (ghQuiet(['--version']).status !== 0) {
    fail('GitHub CLI ("gh") introuvable. Installe-le puis lance : gh auth login');
  }
  if (ghQuiet(['auth', 'status']).status !== 0) {
    fail('Non connecte a GitHub. Lance : gh auth login');
  }

  console.log(`Depot   : ${REPO}`);
  console.log(`Version : ${pkg.version}\n`);

  if (!process.argv.includes('--skip-build')) {
    console.log('Construction du launcher...');
    // On appelle le binaire directement plutot que via un shell : avec
    // shell:true, Node avertit que les arguments ne sont pas echappes.
    const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    execFileSync(npx, ['electron-builder', '--win'], { stdio: 'inherit' });
  }

  // Les quatre fichiers attendus par les joueurs et par electron-updater.
  const artifacts = [
    `Aethoria-Setup-${pkg.version}.exe`,
    `Aethoria-Portable-${pkg.version}.exe`,
    `Aethoria-Setup-${pkg.version}.exe.blockmap`,
    'latest.yml',
  ].map((name) => path.join(DIST, name));

  const missing = artifacts.filter((f) => !fs.existsSync(f));
  if (missing.length) {
    fail(`fichiers absents de dist/ :\n  ${missing.map((f) => path.basename(f)).join('\n  ')}`);
  }

  // latest.yml decrit l'installateur : si les tailles divergent, c'est qu'il
  // provient d'une construction precedente et la mise a jour echouerait.
  const yaml = fs.readFileSync(path.join(DIST, 'latest.yml'), 'utf8');
  const declared = Number((yaml.match(/size: (\d+)/) || [])[1]);
  const actual = fs.statSync(path.join(DIST, `Aethoria-Setup-${pkg.version}.exe`)).size;
  if (declared !== actual) {
    fail(`latest.yml est perime (il annonce ${declared} octets, l'installateur en fait ${actual}). Relance la construction.`);
  }
  console.log('latest.yml coherent avec l\'installateur.\n');

  // GitHub refuse de publier une release dont le tag n'existe pas.
  if (ghQuiet(['api', `repos/${REPO}/git/ref/tags/${TAG}`]).status !== 0) {
    console.log(`Creation du tag ${TAG}...`);
    try {
      execFileSync('git', ['tag', TAG], { stdio: 'pipe' });
    } catch {
      // Le tag existe deja localement.
    }
    execFileSync('git', ['push', 'origin', TAG], { stdio: 'inherit' });
  }

  const exists = ghQuiet(['release', 'view', TAG, '--repo', REPO]).status === 0;
  if (!exists) {
    console.log(`Creation de la release ${TAG}...`);
    gh(['release', 'create', TAG, '--repo', REPO,
      '--title', `Aethoria Launcher ${pkg.version}`,
      '--notes', `Version ${pkg.version} du launcher Aethoria.\n\n`
        + `Telecharge **Aethoria-Setup-${pkg.version}.exe** et lance-le.`], { stdio: 'inherit' });
  } else {
    console.log(`La release ${TAG} existe deja, les fichiers seront remplaces.`);
  }

  console.log('Envoi des fichiers...');
  gh(['release', 'upload', TAG, ...artifacts, '--repo', REPO, '--clobber'], { stdio: 'inherit' });

  // Verification finale : c'est le seul moyen de detecter un envoi partiel.
  const uploaded = JSON.parse(gh(['release', 'view', TAG, '--repo', REPO, '--json', 'assets']))
    .assets.map((a) => a.name);
  const absent = artifacts.map((f) => path.basename(f)).filter((n) => !uploaded.includes(n));
  if (absent.length) {
    fail(`envoi incomplet, il manque :\n  ${absent.join('\n  ')}`);
  }

  console.log('\nPublication verifiee. Fichiers en ligne :');
  for (const name of uploaded) console.log(`  ${name}`);
  console.log(`\nLien a donner aux joueurs :`);
  console.log(`  https://github.com/${REPO}/releases/latest`);
}

try {
  main();
} catch (err) {
  fail(err.message);
}
