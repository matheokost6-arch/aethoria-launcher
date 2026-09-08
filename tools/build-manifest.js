#!/usr/bin/env node
'use strict';

/**
 * Genere manifest.json a partir du contenu du dossier pack/.
 *
 * Le manifest est la source de verite du launcher : version de Minecraft,
 * version de Forge, et liste des fichiers a installer chez le joueur avec leur
 * empreinte SHA1. Il doit etre regenere a chaque modification du modpack.
 *
 * Utilisation :
 *   node tools/build-manifest.js --tag pack-1.1.0
 *   node tools/build-manifest.js --tag pack-1.1.0 --mc 1.20.1 --forge 47.3.0
 *
 * Options :
 *   --tag <nom>     Tag de la release GitHub qui heberge les fichiers (obligatoire)
 *   --mc <version>  Version de Minecraft          (defaut : 1.20.1)
 *   --forge <ver>   Version de Forge              (defaut : 47.3.0)
 *   --pack <dir>    Dossier source                (defaut : pack)
 *   --out <fichier> Manifest a ecrire             (defaut : manifest.json)
 *   --owner <nom>   Compte GitHub                 (defaut : lu dans src/shared/config.js)
 *   --repo <nom>    Depot GitHub                  (defaut : lu dans src/shared/config.js)
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');

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

async function sha1(file) {
  const hash = crypto.createHash('sha1');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
}

/** Liste recursivement les fichiers d'un dossier, en chemins relatifs POSIX. */
async function walk(dir, base = dir) {
  const out = [];
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.name.startsWith('.')) continue;
    if (entry.isDirectory()) {
      out.push(...await walk(full, base));
    } else if (entry.isFile()) {
      out.push(path.relative(base, full).split(path.sep).join('/'));
    }
  }
  return out;
}

/**
 * Nom du fichier tel qu'il apparaitra dans la release GitHub.
 * GitHub remplace les caracteres non alphanumeriques des noms d'assets : on
 * applique la meme regle nous-memes pour que les URLs soient correctes du
 * premier coup, y compris pour les mods dont le nom contient des espaces.
 */
function assetName(relative) {
  return relative.split('/').join('_').replace(/[^A-Za-z0-9._-]/g, '.');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.tag) {
    console.error('Erreur : --tag est obligatoire (ex. --tag pack-1.1.0).\n');
    console.error(fs.readFileSync(__filename, 'utf8').split('*/')[0].split('/**')[1]);
    process.exit(1);
  }

  const packDir = path.resolve(args.pack || 'pack');
  const outFile = path.resolve(args.out || 'manifest.json');
  const owner = args.owner || config.github.owner;
  const repo = args.repo || config.github.repo;

  if (!fs.existsSync(packDir)) {
    console.error(`Erreur : le dossier "${packDir}" n'existe pas.`);
    console.error('Cree-le et places-y les dossiers a synchroniser (mods/, config/, ...).');
    process.exit(1);
  }
  if (owner.startsWith('AETHORIA_')) {
    console.error('Erreur : renseigne github.owner et github.repo dans src/shared/config.js,');
    console.error('ou passe --owner et --repo en ligne de commande.');
    process.exit(1);
  }

  const relatives = (await walk(packDir)).sort();
  if (!relatives.length) {
    console.error(`Erreur : aucun fichier trouve dans ${packDir}.`);
    process.exit(1);
  }

  const baseUrl = `https://github.com/${owner}/${repo}/releases/download/${args.tag}`;
  const files = [];
  let totalBytes = 0;

  for (const relative of relatives) {
    const full = path.join(packDir, relative);
    const stat = await fsp.stat(full);
    totalBytes += stat.size;
    files.push({
      path: relative,
      url: `${baseUrl}/${assetName(relative)}`,
      sha1: await sha1(full),
      size: stat.size,
    });
    process.stdout.write(`\r  ${files.length}/${relatives.length} fichiers analyses`);
  }
  process.stdout.write('\n');

  // On preserve les actualites et les reglages deja presents dans le manifest :
  // ce script ne gere que la liste des fichiers.
  let previous = {};
  if (fs.existsSync(outFile)) {
    try {
      previous = JSON.parse(await fsp.readFile(outFile, 'utf8'));
    } catch {
      console.warn('Manifest existant illisible, il sera remplace.');
    }
  }

  const manifest = {
    modpackVersion: args.tag.replace(/^pack-/, ''),
    minecraftVersion: args.mc || previous.minecraftVersion || config.fallback.minecraftVersion,
    forgeVersion: args.forge || previous.forgeVersion || config.fallback.forgeVersion,
    server: previous.server || config.server,
    news: previous.news || [],
    deleteExtraIn: previous.deleteExtraIn || ['mods'],
    files,
  };

  await fsp.writeFile(outFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const mb = (totalBytes / 1024 / 1024).toFixed(1);
  console.log(`\nManifest ecrit : ${outFile}`);
  console.log(`  ${files.length} fichiers, ${mb} Mo au total`);
  console.log(`  Minecraft ${manifest.minecraftVersion} / Forge ${manifest.forgeVersion}`);
  console.log('\nEtape suivante — publier les fichiers sur la release GitHub :');
  console.log(`  node tools/publish-pack.js --tag ${args.tag}`);
  console.log('\nPuis commiter le manifest :');
  console.log(`  git add ${path.basename(outFile)} && git commit -m "Modpack ${manifest.modpackVersion}" && git push`);
}

main().catch((err) => {
  console.error(`\nEchec : ${err.message}`);
  process.exit(1);
});
