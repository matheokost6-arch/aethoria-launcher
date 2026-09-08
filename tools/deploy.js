#!/usr/bin/env node
'use strict';

/**
 * Publie tout, en une seule commande : npm run deploy
 *
 * Le projet vit sur deux depots :
 *   - le depot du CODE, qui peut rester prive ;
 *   - le depot de DISTRIBUTION, obligatoirement public, car le launcher
 *     installe chez un joueur n'a aucun moyen de lire un depot prive.
 *
 * Ce script enchaine tout ce qui doit l'etre, dans l'ordre, et verifie a la fin
 * qu'un joueur sans compte GitHub peut reellement tout telecharger. C'est cette
 * verification finale qui compte : une publication a moitie faite ne se voit
 * pas autrement, et le launcher se rabat alors en silence sur sa copie locale.
 *
 * Etapes :
 *   1. verifications prealables (gh, connexion, depot public)
 *   2. mise a jour du manifest depuis pack/
 *   3. envoi des mods manquants sur la release du modpack
 *   4. publication du manifest sur le depot public
 *   5. construction et publication de l'installateur
 *   6. enregistrement du code sur le depot prive
 *   7. controle d'acces anonyme
 *
 * Options :
 *   --pack-tag <tag>   Release hebergeant les mods   (defaut : pack-<version du manifest>)
 *   --skip-build       Reutilise dist/ tel quel
 *   --skip-pack        Ne touche pas aux mods (publication du launcher seul)
 *   --message "..."    Message du commit de code
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');

const config = require('../src/shared/config');
const pkg = require('../package.json');

const CODE = `${config.github.owner}/${config.github.repo}`;
const DIST = `${config.github.owner}/${config.github.dist}`;
const DOSSIER_DIST = path.resolve('dist');
const DOSSIER_PACK = path.resolve('pack');

const ARTEFACTS = [
  'Aethoria-Setup.exe',
  'Aethoria-Portable.exe',
  'Aethoria-Setup.exe.blockmap',
  'latest.yml',
];

/* ------------------------------------------------------------------ *
 *  Utilitaires
 * ------------------------------------------------------------------ */

let etape = 0;
const titre = (texte) => {
  etape += 1;
  console.log(`\n[${etape}/7] ${texte}`);
};
const info = (texte) => console.log(`      ${texte}`);

function echec(message) {
  console.error(`\nEchec : ${message}\n`);
  process.exit(1);
}

function gh(args, options = {}) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: 'pipe', ...options });
}

function ghSilencieux(args) {
  return spawnSync('gh', args, { encoding: 'utf8' });
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const cle = argv[i].slice(2);
    const valeur = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true;
    args[cle] = valeur;
    if (valeur !== true) i += 1;
  }
  return args;
}

/** Nom d'asset tel que GitHub le normalisera. */
function nomAsset(relatif) {
  return relatif.split('/').join('_').replace(/[^A-Za-z0-9._-]/g, '.');
}

function listerFichiers(dossier, base = dossier) {
  const sortie = [];
  for (const entree of fs.readdirSync(dossier, { withFileTypes: true })) {
    if (entree.name.startsWith('.')) continue;
    const complet = path.join(dossier, entree.name);
    if (entree.isDirectory()) sortie.push(...listerFichiers(complet, base));
    else if (entree.isFile()) sortie.push(path.relative(base, complet).split(path.sep).join('/'));
  }
  return sortie;
}

/* ------------------------------------------------------------------ *
 *  1. Verifications prealables
 * ------------------------------------------------------------------ */

function verifierPrealables() {
  titre('Verifications');

  if (ghSilencieux(['--version']).status !== 0) {
    echec('GitHub CLI ("gh") est introuvable. Installe-le, puis lance : gh auth login');
  }
  if (ghSilencieux(['auth', 'status']).status !== 0) {
    echec('Non connecte a GitHub. Lance : gh auth login');
  }

  // Le depot de distribution DOIT etre public, sinon le launcher installe chez
  // les joueurs recevra 404 sur tout et se figera sur sa derniere copie locale.
  const vue = ghSilencieux(['repo', 'view', DIST, '--json', 'visibility']);
  if (vue.status !== 0) {
    echec(`Le depot de distribution ${DIST} est introuvable.\n`
      + `        Cree-le : gh repo create ${config.github.dist} --public`);
  }
  const visibilite = JSON.parse(vue.stdout).visibility;
  if (visibilite !== 'PUBLIC') {
    echec(`Le depot de distribution ${DIST} est ${visibilite}.\n`
      + '        Il doit etre public : le launcher des joueurs ne peut pas lire un depot prive.\n'
      + `        Corrige : gh repo edit ${DIST} --visibility public --accept-visibility-change-consequences`);
  }

  info(`code         : ${CODE}`);
  info(`distribution : ${DIST} (public)`);

  initialiserDepot();
}

/**
 * GitHub refuse de creer une release ou un tag sur un depot sans aucun commit
 * ("Repository is empty"). On y depose donc un premier fichier, qui sert aussi
 * de page d'accueil a quiconque tombe sur le depot.
 */
function initialiserDepot() {
  const vide = ghSilencieux(['api', `repos/${DIST}/commits`, '--jq', 'length']);
  if (vide.status === 0 && Number(vide.stdout.trim()) > 0) return;

  info('depot de distribution vide, initialisation...');

  const accueil = [
    '# Aethoria',
    '',
    'Fichiers publics du launcher du serveur Minecraft **Aethoria**.',
    '',
    'Ce depot ne contient pas de code : seulement ce que le launcher doit',
    'pouvoir telecharger sans compte GitHub.',
    '',
    '- `manifest.json` : versions du jeu et liste des fichiers du modpack',
    '- Releases `pack-*` : les mods du modpack',
    '- Releases `v*` : le programme d installation du launcher',
    '',
    '## Telecharger le launcher',
    '',
    `https://github.com/${DIST}/releases/latest/download/Aethoria-Setup.exe`,
    '',
    `Serveur : ${config.server.host}`,
    '',
  ].join('\n');

  const corps = {
    message: 'Initialisation du depot de distribution',
    content: Buffer.from(accueil, 'utf8').toString('base64'),
  };
  const tmp = path.join(os.tmpdir(), `aethoria-readme-${Date.now()}.json`);
  fs.writeFileSync(tmp, JSON.stringify(corps));
  try {
    gh(['api', `repos/${DIST}/contents/README.md`, '-X', 'PUT', '--input', tmp]);
    info('depot initialise.');
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/* ------------------------------------------------------------------ *
 *  2. Manifest
 * ------------------------------------------------------------------ */

function majManifest(packTag, sauterPack) {
  titre('Manifest');

  if (sauterPack) {
    info('--skip-pack : le manifest n\'est pas regenere.');
    return JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
  }
  if (!fs.existsSync(DOSSIER_PACK)) {
    echec(`Le dossier ${DOSSIER_PACK} n'existe pas. Places-y les mods a distribuer.`);
  }

  execFileSync(process.execPath, [
    path.join(__dirname, 'build-manifest.js'),
    '--tag', packTag,
    '--repo', config.github.dist, // les URLs doivent pointer vers le depot PUBLIC
  ], { stdio: 'pipe' });

  const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
  info(`${manifest.files.length} mods imposes, ${(manifest.optionalMods || []).length} optionnels`);
  return manifest;
}

/* ------------------------------------------------------------------ *
 *  3. Mods
 * ------------------------------------------------------------------ */

function envoyerMods(manifest, packTag) {
  titre('Mods du modpack');

  const existe = ghSilencieux(['release', 'view', packTag, '--repo', DIST]).status === 0;
  if (!existe) {
    info(`creation de la release ${packTag}...`);
    gh(['release', 'create', packTag, '--repo', DIST,
      '--title', `Modpack ${manifest.modpackVersion}`,
      '--notes', 'Fichiers du modpack Aethoria, utilises par le launcher.']);
  }

  // On ne renvoie que ce qui manque reellement en ligne : reexpedier 456 Mo a
  // chaque publication serait aussi long qu'inutile.
  const enLigne = new Map(
    JSON.parse(gh(['release', 'view', packTag, '--repo', DIST, '--json', 'assets']))
      .assets.map((a) => [a.name, a.size]),
  );

  const relatifs = listerFichiers(DOSSIER_PACK).sort();
  const aEnvoyer = relatifs.filter((rel) => {
    const attendu = nomAsset(rel);
    const taille = fs.statSync(path.join(DOSSIER_PACK, rel)).size;
    return enLigne.get(attendu) !== taille;
  });

  if (!aEnvoyer.length) {
    info(`${relatifs.length} fichiers deja en ligne, rien a envoyer.`);
    return;
  }

  info(`${aEnvoyer.length} fichier(s) a envoyer sur ${relatifs.length}...`);

  // GitHub renomme les assets : on prepare les fichiers sous leur nom final,
  // sans quoi les URLs du manifest ne correspondraient a rien.
  const tampon = fs.mkdtempSync(path.join(os.tmpdir(), 'aethoria-pack-'));
  try {
    const chemins = aEnvoyer.map((rel) => {
      const cible = path.join(tampon, nomAsset(rel));
      fs.copyFileSync(path.join(DOSSIER_PACK, rel), cible);
      return cible;
    });

    const LOT = 10; // au-dela, la ligne de commande Windows deborde
    for (let i = 0; i < chemins.length; i += LOT) {
      const lot = chemins.slice(i, i + LOT);
      info(`  envoi ${i + 1}-${i + lot.length} / ${chemins.length}`);
      gh(['release', 'upload', packTag, ...lot, '--repo', DIST, '--clobber'], { stdio: 'inherit' });
    }
  } finally {
    fs.rmSync(tampon, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ *
 *  4. Manifest en ligne
 * ------------------------------------------------------------------ */

function publierManifest() {
  titre('Publication du manifest');

  const contenu = fs.readFileSync('manifest.json');
  const base64 = contenu.toString('base64');

  // On passe par l'API plutot que par un second clone : moins de choses a
  // garder synchronisees, et le depot public reste minimal.
  let sha = null;
  const actuel = ghSilencieux(['api', `repos/${DIST}/contents/manifest.json`]);
  if (actuel.status === 0) {
    const donnees = JSON.parse(actuel.stdout);
    sha = donnees.sha;
    if (Buffer.from(donnees.content || '', 'base64').equals(contenu)) {
      info('manifest deja identique en ligne.');
      return;
    }
  }

  const corps = {
    message: `Manifest du modpack ${JSON.parse(contenu).modpackVersion}`,
    content: base64,
    branch: config.github.branch,
  };
  if (sha) corps.sha = sha;

  const tmp = path.join(os.tmpdir(), `aethoria-manifest-${Date.now()}.json`);
  fs.writeFileSync(tmp, JSON.stringify(corps));
  try {
    gh(['api', `repos/${DIST}/contents/manifest.json`, '-X', 'PUT', '--input', tmp]);
    info('manifest mis en ligne.');
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/* ------------------------------------------------------------------ *
 *  5. Installateur
 * ------------------------------------------------------------------ */

function publierLauncher(sauterBuild) {
  titre('Installateur');

  if (!sauterBuild) {
    info('construction en cours...');
    execFileSync(process.execPath, [require.resolve('electron-builder/out/cli/cli.js'), '--win'],
      { stdio: 'pipe' });
  }

  const chemins = ARTEFACTS.map((n) => path.join(DOSSIER_DIST, n));
  const absents = chemins.filter((f) => !fs.existsSync(f));
  if (absents.length) {
    echec(`fichiers absents de dist/ :\n        ${absents.map((f) => path.basename(f)).join('\n        ')}`);
  }

  // latest.yml decrit l'installateur : des tailles differentes signalent un
  // dist/ melangeant deux constructions, et la mise a jour echouerait.
  const yaml = fs.readFileSync(path.join(DOSSIER_DIST, 'latest.yml'), 'utf8');
  const annonce = Number((yaml.match(/size: (\d+)/) || [])[1]);
  const reelle = fs.statSync(path.join(DOSSIER_DIST, 'Aethoria-Setup.exe')).size;
  if (annonce !== reelle) {
    echec(`latest.yml est perime (${annonce} octets annonces, ${reelle} reels). Relance sans --skip-build.`);
  }

  const tag = `v${pkg.version}`;

  // GitHub refuse de publier une release dont le tag n'existe pas.
  if (ghSilencieux(['api', `repos/${DIST}/git/ref/tags/${tag}`]).status !== 0) {
    const principale = gh(['api', `repos/${DIST}`, '--jq', '.default_branch']).trim();
    const sha = gh(['api', `repos/${DIST}/git/ref/heads/${principale}`, '--jq', '.object.sha']).trim();
    gh(['api', `repos/${DIST}/git/refs`, '-X', 'POST',
      '-f', `ref=refs/tags/${tag}`, '-f', `sha=${sha}`]);
    info(`tag ${tag} cree.`);
  }

  if (ghSilencieux(['release', 'view', tag, '--repo', DIST]).status !== 0) {
    gh(['release', 'create', tag, '--repo', DIST,
      '--title', `Aethoria Launcher ${pkg.version}`,
      '--notes', `Version ${pkg.version}.\n\nTelecharge **Aethoria-Setup.exe** et lance-le.`]);
  }

  gh(['release', 'upload', tag, ...chemins, '--repo', DIST, '--clobber'], { stdio: 'inherit' });
  info(`version ${pkg.version} publiee.`);
}

/* ------------------------------------------------------------------ *
 *  6. Code source
 * ------------------------------------------------------------------ */

function enregistrerCode(message) {
  titre('Code source');

  const modifie = spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).stdout.trim();
  if (modifie) {
    execFileSync('git', ['add', '-A'], { stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', message || `Publication ${pkg.version}`], { stdio: 'pipe' });
    info('modifications enregistrees.');
  } else {
    info('rien a enregistrer.');
  }

  const envoi = spawnSync('git', ['push', 'origin', 'HEAD'], { encoding: 'utf8' });
  info(envoi.status === 0 ? `pousse sur ${CODE}.` : `push impossible : ${envoi.stderr.trim()}`);
}

/* ------------------------------------------------------------------ *
 *  7. Controle final
 * ------------------------------------------------------------------ */

async function verifierAcces(manifest) {
  titre('Controle d\'acces, comme un joueur sans compte GitHub');

  // Sans en-tete d'authentification : c'est exactement ce que voit un joueur.
  const tester = async (libelle, url) => {
    try {
      const reponse = await fetch(url, { method: 'HEAD', redirect: 'follow' });
      const ok = reponse.ok;
      info(`${ok ? 'ok   ' : 'ECHEC'} ${libelle.padEnd(22)} HTTP ${reponse.status}`);
      return ok;
    } catch (err) {
      info(`ECHEC ${libelle.padEnd(22)} ${err.message}`);
      return false;
    }
  };

  const controles = [
    await tester('manifest', config.manifestUrl),
    await tester('installateur', `https://github.com/${DIST}/releases/latest/download/Aethoria-Setup.exe`),
    await tester('mises a jour', `https://github.com/${DIST}/releases/latest/download/latest.yml`),
  ];

  // Trois mods pris au hasard : verifier les 71 serait long, et une URL fausse
  // l'est generalement pour toutes.
  const echantillon = manifest.files
    .map((f) => f)
    .sort(() => Math.random() - 0.5)
    .slice(0, 3);
  for (const fichier of echantillon) {
    controles.push(await tester(`mod ${path.basename(fichier.path).slice(0, 16)}`, fichier.url));
  }

  if (controles.includes(false)) {
    echec('des fichiers ne sont pas accessibles publiquement. Le launcher des joueurs ne pourra pas les telecharger.');
  }

  console.log('\nTout est en ligne et accessible.');
  console.log(`\nLien a donner aux joueurs :`);
  console.log(`  https://github.com/${DIST}/releases/latest/download/Aethoria-Setup.exe`);
}

/* ------------------------------------------------------------------ *
 *  Enchainement
 * ------------------------------------------------------------------ */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`Publication d'Aethoria ${pkg.version}`);

  verifierPrealables();

  const manifestActuel = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
  const packTag = args['pack-tag'] || `pack-${manifestActuel.modpackVersion}`;

  const manifest = majManifest(packTag, args['skip-pack']);
  if (!args['skip-pack']) envoyerMods(manifest, packTag);
  else { etape += 1; console.log(`\n[${etape}/7] Mods du modpack\n      --skip-pack : ignore.`); }

  publierManifest();
  publierLauncher(args['skip-build']);
  enregistrerCode(args.message);
  await verifierAcces(manifest);
}

main().catch((err) => echec(err.message));
