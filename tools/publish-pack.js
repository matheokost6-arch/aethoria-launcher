#!/usr/bin/env node
'use strict';

/**
 * Publie les fichiers du dossier pack/ sur une release GitHub, en utilisant
 * l'outil officiel "gh". Chaque fichier devient un asset de la release, aux
 * URLs exactes attendues par manifest.json.
 *
 * Prerequis : gh installe et connecte (gh auth login).
 *
 * Utilisation :
 *   node tools/publish-pack.js --tag pack-1.1.0
 *   node tools/publish-pack.js --tag pack-1.1.0 --clobber   (remplace les assets existants)
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { execFileSync, spawnSync } = require('child_process');

const config = require('../src/shared/config');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true;
    args[key] = value;
    if (value !== true) i += 1;
  }
  return args;
}

async function walk(dir, base = dir) {
  const out = [];
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(full, base));
    else if (entry.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

function assetName(relative) {
  return relative.split('/').join('_').replace(/[^A-Za-z0-9._-]/g, '.');
}

function hasGh() {
  const probe = spawnSync(process.platform === 'win32' ? 'gh.exe' : 'gh', ['--version'], { encoding: 'utf8' });
  return probe.status === 0;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.tag) {
    console.error('Erreur : --tag est obligatoire (ex. --tag pack-1.1.0).');
    process.exit(1);
  }
  if (!hasGh()) {
    console.error('Erreur : l’outil GitHub CLI ("gh") est introuvable.');
    console.error('Installe-le depuis https://cli.github.com puis lance : gh auth login');
    process.exit(1);
  }

  const packDir = path.resolve(args.pack || 'pack');
  const repo = `${args.owner || config.github.owner}/${args.repo || config.github.repo}`;
  const relatives = (await walk(packDir)).sort();

  console.log(`Depot  : ${repo}`);
  console.log(`Release: ${args.tag}`);
  console.log(`Fichiers: ${relatives.length}\n`);

  // Cree la release si elle n'existe pas encore.
  const exists = spawnSync('gh', ['release', 'view', args.tag, '--repo', repo], { encoding: 'utf8' });
  if (exists.status !== 0) {
    console.log('Creation de la release...');
    execFileSync('gh', [
      'release', 'create', args.tag,
      '--repo', repo,
      '--title', `Modpack ${args.tag.replace(/^pack-/, '')}`,
      '--notes', 'Fichiers du modpack Aethoria. Cette release est utilisee par le launcher.',
    ], { stdio: 'inherit' });
  }

  // GitHub normalise les noms d'assets : on copie chaque fichier sous son nom
  // final dans un dossier temporaire, sinon les URLs du manifest ne
  // correspondraient pas aux assets reellement crees.
  const staging = await fsp.mkdtemp(path.join(os.tmpdir(), 'aethoria-pack-'));
  try {
    const uploads = [];
    for (const relative of relatives) {
      const dest = path.join(staging, assetName(relative));
      await fsp.copyFile(path.join(packDir, relative), dest);
      uploads.push(dest);
    }

    // Envoi par lots : une commande unique avec 71 arguments depasse la limite
    // de longueur de ligne de commande sous Windows.
    const BATCH = 10;
    for (let i = 0; i < uploads.length; i += BATCH) {
      const batch = uploads.slice(i, i + BATCH);
      console.log(`Envoi ${i + 1}-${i + batch.length} / ${uploads.length}...`);
      execFileSync('gh', [
        'release', 'upload', args.tag, ...batch,
        '--repo', repo,
        ...(args.clobber ? ['--clobber'] : []),
      ], { stdio: 'inherit' });
    }
  } finally {
    await fsp.rm(staging, { recursive: true, force: true });
  }

  console.log('\nPublication terminee.');
  console.log('Verifie que manifest.json a bien ete regenere avec le meme tag,');
  console.log('puis commite-le pour que les joueurs recoivent la mise a jour.');
}

main().catch((err) => {
  console.error(`\nEchec : ${err.message}`);
  process.exit(1);
});
