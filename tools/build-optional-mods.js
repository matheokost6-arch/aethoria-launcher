#!/usr/bin/env node
'use strict';

/**
 * Remplit la section "optionalMods" du manifest a partir de Modrinth.
 *
 * Ces mods sont proposes au joueur dans le launcher, qui peut les activer ou
 * les desactiver librement. Ils sont **uniquement clients** : le serveur n'a
 * rien a installer, et un joueur qui ne les prend pas joue normalement.
 *
 * Les fichiers ne sont pas rediffuses : le manifest pointe vers le CDN officiel
 * de Modrinth, avec l'empreinte SHA1 fournie par l'API. Le mod est donc
 * toujours telecharge depuis sa source, dans sa version exacte.
 *
 * Utilisation :
 *   node tools/build-optional-mods.js
 *   node tools/build-optional-mods.js --add jade --add betterf3
 *   node tools/build-optional-mods.js --mc 1.20.1 --loader forge
 */

const fs = require('fs');
const path = require('path');

const API = 'https://api.modrinth.com/v2';
const UA = 'aethoria-launcher (github.com/matheokost6-arch/aethoria-launcher)';

// Liste par defaut : du confort visuel et ergonomique. Aucun de ces mods ne
// modifie les regles du jeu ni ne demande quoi que ce soit au serveur.
//
// "Luminosite maximale" est le seul a donner un avantage reel : voir dans le
// noir aide en exploration comme en combat nocturne. Il est propose ici a la
// demande de l'administrateur du serveur ; le retirer se fait en supprimant
// sa ligne puis en relancant ce script.
const PAR_DEFAUT = [
  { slug: 'xaeros-minimap', nom: 'Minimap de Xaero', description: 'Une minimap dans le coin de l’ecran, avec les points de repere que tu poses.' },
  { slug: 'xaeros-world-map', nom: 'Carte du monde', description: 'La carte complete des regions que tu as explorees, en plein ecran.' },
  { slug: 'jade', nom: 'Jade', description: 'Affiche le nom du bloc ou de la creature que tu regardes, et son etat.' },
  { slug: 'just-zoom', nom: 'Zoom', description: 'Une touche pour zoomer au loin, comme avec une longue-vue.' },
  { slug: 'sound-physics-remastered', nom: 'Acoustique realiste', description: 'Echo dans les grottes, sons etouffes derriere les murs. Tres immersif.' },
  { slug: 'legendary-tooltips', nom: 'Infobulles ameliorees', description: 'Des infobulles d’objets plus lisibles et plus soignees.' },
  { slug: 'better-advancements', nom: 'Progres ameliores', description: 'Un ecran de progres plus clair et plus agreable a parcourir.' },
  { slug: 'betterf3', nom: 'Ecran technique', description: 'Remplace l’ecran F3 par un affichage lisible et configurable.' },
  { slug: 'toast-control', nom: 'Controle des notifications', description: 'Choisis quelles notifications apparaissent en haut de l’ecran.' },
  { slug: 'full-brightness-toggle', nom: 'Luminosite maximale', description: 'La touche G eclaire tout : grottes, donjons et nuits deviennent parfaitement visibles.' },
];

function parseArgs(argv) {
  const args = { add: [] };
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true;
    if (key === 'add') args.add.push(value);
    else args[key] = value;
    if (value !== true) i += 1;
  }
  return args;
}

async function api(chemin) {
  const res = await fetch(`${API}${chemin}`, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`Modrinth a repondu HTTP ${res.status} sur ${chemin}`);
  return res.json();
}

/**
 * Resout les bibliotheques dont un mod a besoin pour demarrer.
 *
 * Sans elles, Forge refuse de charger le jeu : "Mod justzoom requires konkrete
 * 1.8.0 or above". Le joueur voit alors un plantage au demarrage, sans rapport
 * apparent avec la case qu'il vient de cocher.
 *
 * Les bibliotheques deja imposees par le pack sont ignorees : les reinstaller
 * en double provoquerait un conflit de versions.
 */
async function resoudreDependances(version, mcVersion, loader, dejaInstalles) {
  const requises = (version.dependencies || []).filter((d) => d.dependency_type === 'required');
  const resultats = [];

  for (const dep of requises) {
    if (!dep.project_id) continue; // dependance sur une version precise, deja resolue

    const projet = await api(`/project/${dep.project_id}`);
    const versions = await api(
      `/project/${dep.project_id}/version?loaders=["${loader}"]&game_versions=["${mcVersion}"]`,
    );
    if (!versions.length) {
      throw new Error(`aucune version ${loader} ${mcVersion} pour la dependance "${projet.title}"`);
    }

    const fichier = versions[0].files.find((f) => f.primary) || versions[0].files[0];
    if (dejaInstalles.has(fichier.filename.toLowerCase())) continue;

    resultats.push({
      id: projet.slug,
      name: projet.title,
      version: versions[0].version_number,
      path: `mods/${fichier.filename}`,
      url: fichier.url,
      sha1: fichier.hashes.sha1,
      size: fichier.size,
    });
  }

  return resultats;
}

/** Recupere le fichier a telecharger pour un mod, dans la bonne version. */
async function resoudre(entree, mcVersion, loader, dejaInstalles) {
  const projet = await api(`/project/${entree.slug}`);

  // Un mod dont le serveur est "required" n'a rien a faire ici : il faudrait
  // l'installer aussi cote serveur, et le joueur serait rejete a la connexion.
  if (projet.server_side === 'required') {
    throw new Error(`"${projet.title}" exige une installation cote serveur.`);
  }

  const versions = await api(
    `/project/${entree.slug}/version?loaders=["${loader}"]&game_versions=["${mcVersion}"]`,
  );
  if (!versions.length) {
    throw new Error(`aucune version ${loader} ${mcVersion} pour "${projet.title}"`);
  }

  // L'API renvoie les versions de la plus recente a la plus ancienne.
  const version = versions[0];
  const fichier = version.files.find((f) => f.primary) || version.files[0];
  const requires = await resoudreDependances(version, mcVersion, loader, dejaInstalles);

  return {
    id: entree.slug,
    requires,
    name: entree.nom || projet.title,
    description: entree.description || projet.description,
    version: version.version_number,
    path: `mods/${fichier.filename}`,
    url: fichier.url,
    sha1: fichier.hashes.sha1,
    size: fichier.size,
    page: `https://modrinth.com/mod/${entree.slug}`,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifestPath = path.resolve(args.out || 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const mcVersion = args.mc || manifest.minecraftVersion;
  const loader = args.loader || 'forge';

  // --add ajoute a la liste existante ; sans argument on reconstruit la liste
  // par defaut, ce qui met a jour toutes les versions d'un coup.
  const cibles = args.add.length
    ? args.add.map((slug) => ({ slug }))
    : PAR_DEFAUT;

  console.log(`Minecraft ${mcVersion} / ${loader}\n`);

  // Les mods deja imposes par le pack ne doivent pas etre proposes en double.
  const dejaInstalles = new Set(
    (manifest.files || []).map((f) => path.basename(f.path).toLowerCase()),
  );

  const resultats = [];
  for (const entree of cibles) {
    try {
      const mod = await resoudre(entree, mcVersion, loader, dejaInstalles);
      if (dejaInstalles.has(path.basename(mod.path).toLowerCase())) {
        console.log(`  ${entree.slug.padEnd(26)} deja dans le pack, ignore`);
        continue;
      }
      resultats.push(mod);
      const suffixe = mod.requires.length
        ? `  + ${mod.requires.map((d) => d.id).join(', ')}`
        : '';
      console.log(`  ${entree.slug.padEnd(26)} ${mod.version.padEnd(24)} ${Math.round(mod.size / 1024)} Ko${suffixe}`);
    } catch (err) {
      console.warn(`  ${entree.slug.padEnd(26)} IGNORE : ${err.message}`);
    }
  }

  if (args.add.length) {
    // Fusion : on remplace les entrees de meme identifiant, on garde le reste.
    const existants = (manifest.optionalMods || []).filter(
      (m) => !resultats.some((r) => r.id === m.id),
    );
    manifest.optionalMods = [...existants, ...resultats];
  } else {
    manifest.optionalMods = resultats;
  }

  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const total = manifest.optionalMods.reduce(
    (s, m) => s + m.size + (m.requires || []).reduce((t, d) => t + d.size, 0),
    0,
  );
  console.log(`\n${manifest.optionalMods.length} mods optionnels, ${(total / 1024 / 1024).toFixed(1)} Mo au total.`);
  console.log(`Manifest mis a jour : ${manifestPath}`);
  console.log('\nCommite-le pour que les joueurs voient la nouvelle liste :');
  console.log('  git add manifest.json && git commit -m "Mods optionnels" && git push');
}

main().catch((err) => {
  console.error(`\nEchec : ${err.message}`);
  process.exit(1);
});
