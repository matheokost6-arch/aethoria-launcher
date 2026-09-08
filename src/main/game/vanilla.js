'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const AdmZip = require('adm-zip');
const paths = require('./paths');
const config = require('../../shared/config');
const { downloadAll, downloadFile, getJson } = require('./downloader');

/* ------------------------------------------------------------------ *
 *  Regles de plateforme
 * ------------------------------------------------------------------ */

const OS_NAME = { win32: 'windows', darwin: 'osx', linux: 'linux' }[process.platform] || 'linux';
const OS_ARCH = { x64: 'x86_64', ia32: 'x86', arm64: 'arm64' }[process.arch] || process.arch;

/**
 * Evalue les regles allow/disallow d'une bibliotheque ou d'un argument.
 * Sans regle, l'element s'applique. Sinon la derniere regle qui matche gagne.
 */
function rulesAllow(rules, features = {}) {
  if (!rules || rules.length === 0) return true;
  let allowed = false;
  for (const rule of rules) {
    let matches = true;
    if (rule.os) {
      if (rule.os.name && rule.os.name !== OS_NAME) matches = false;
      if (rule.os.arch && rule.os.arch !== process.arch && rule.os.arch !== OS_ARCH) matches = false;
      if (rule.os.version && !new RegExp(rule.os.version).test(os.release())) matches = false;
    }
    if (matches && rule.features) {
      for (const [key, expected] of Object.entries(rule.features)) {
        if (Boolean(features[key]) !== Boolean(expected)) { matches = false; break; }
      }
    }
    if (matches) allowed = rule.action === 'allow';
  }
  return allowed;
}

/** Convertit "group:artifact:version[:classifier]" en chemin Maven. */
function mavenPath(name) {
  const [group, artifact, versionPart, classifier] = name.split(':');
  const [version, ext = 'jar'] = (versionPart || '').split('@');
  const suffix = classifier ? `-${classifier.split('@')[0]}` : '';
  const finalExt = classifier && classifier.includes('@') ? classifier.split('@')[1] : ext;
  return path.join(
    ...group.split('.'),
    artifact,
    version,
    `${artifact}-${version}${suffix}.${finalExt}`,
  );
}

/**
 * Depuis 1.19, les bibliotheques natives ne sont plus distinguees par des
 * regles mais par le suffixe de leur nom : lwjgl:3.3.1:natives-windows (x64),
 * natives-windows-x86, natives-windows-arm64. Les trois portent les memes
 * regles {os: windows} et seraient donc toutes retenues.
 *
 * Comme les DLL sont extraites a plat dans un dossier commun, celle de la
 * derniere variante extraite ecrase les precedentes : une JVM 64 bits se
 * retrouve alors avec une lwjgl.dll 32 bits et echoue sur UnsatisfiedLinkError.
 * On ne garde donc que la variante correspondant a l'architecture courante.
 */
function nativeMatchesArch(name) {
  const match = /natives-(windows|linux|macos|osx)(-\w+)?/.exec(name);
  if (!match) return true; // ce n'est pas une bibliotheque native
  const suffix = (match[2] || '').slice(1); // '', 'x86', 'arm64', 'x86_64'...
  switch (process.arch) {
    case 'arm64': return suffix === 'arm64';
    case 'ia32': return suffix === 'x86';
    // Sur x64, la variante par defaut est celle sans suffixe.
    default: return suffix === '' || suffix === 'x86_64' || suffix === 'x64';
  }
}

/** Cle d'identite d'une bibliotheque, sans la version (pour la deduplication). */
function libraryKey(name) {
  const [group, artifact, , classifier] = name.split(':');
  return `${group}:${artifact}${classifier ? `:${classifier.split('@')[0]}` : ''}`;
}

/* ------------------------------------------------------------------ *
 *  Manifest et JSON de version
 * ------------------------------------------------------------------ */

async function getVersionManifest() {
  return getJson(config.endpoints.versionManifest);
}

/** Telecharge le JSON d'une version vanilla si absent, puis le renvoie. */
async function ensureVersionJson(versionId) {
  const jsonPath = paths.versionJson(versionId);
  if (fs.existsSync(jsonPath)) {
    return JSON.parse(await fsp.readFile(jsonPath, 'utf8'));
  }
  const manifest = await getVersionManifest();
  const entry = manifest.versions.find((v) => v.id === versionId);
  if (!entry) throw new Error(`Version Minecraft inconnue : ${versionId}`);
  await downloadFile(entry.url, jsonPath, { sha1: entry.sha1 });
  return JSON.parse(await fsp.readFile(jsonPath, 'utf8'));
}

/**
 * Charge un JSON de version en resolvant la chaine inheritsFrom.
 * Forge ne redefinit qu'un delta (mainClass, ses bibliotheques, ses arguments)
 * et herite du reste de la version vanilla correspondante.
 */
async function resolveVersion(versionId) {
  const jsonPath = paths.versionJson(versionId);
  if (!fs.existsSync(jsonPath)) {
    return ensureVersionJson(versionId);
  }
  const version = JSON.parse(await fsp.readFile(jsonPath, 'utf8'));
  if (!version.inheritsFrom) return version;

  const parent = await resolveVersion(version.inheritsFrom);
  return mergeVersions(parent, version);
}

function mergeVersions(parent, child) {
  const merged = { ...parent, ...child };

  // Bibliotheques : celles de l'enfant sont prioritaires a nom egal, sinon on
  // se retrouverait avec deux versions de la meme lib dans le classpath (source
  // classique de NoSuchMethodError avec Forge).
  const byKey = new Map();
  for (const lib of parent.libraries || []) byKey.set(libraryKey(lib.name), lib);
  for (const lib of child.libraries || []) byKey.set(libraryKey(lib.name), lib);
  merged.libraries = [...byKey.values()];

  if (parent.arguments || child.arguments) {
    merged.arguments = {
      game: [...(parent.arguments?.game || []), ...(child.arguments?.game || [])],
      jvm: [...(parent.arguments?.jvm || []), ...(child.arguments?.jvm || [])],
    };
  }

  // L'enfant n'a pas de client.jar propre : c'est celui du parent qui est lance.
  merged.downloads = parent.downloads;
  merged.assetIndex = child.assetIndex || parent.assetIndex;
  merged.assets = child.assets || parent.assets;
  merged.javaVersion = child.javaVersion || parent.javaVersion;
  merged.jarId = parent.id; // identifiant du jar a utiliser dans le classpath
  merged.id = child.id;
  return merged;
}

/* ------------------------------------------------------------------ *
 *  Bibliotheques, natives, assets
 * ------------------------------------------------------------------ */

/**
 * Liste les bibliotheques applicables et leur emplacement local.
 * Gere les deux conventions de natives :
 *   - ancienne (<= 1.18) : cle "natives" + downloads.classifiers
 *   - moderne (>= 1.19)  : artefact normal dont le nom contient natives-<os>
 */
function collectLibraries(version) {
  const classpath = [];
  const natives = [];
  const downloads = [];

  for (const lib of version.libraries || []) {
    if (!rulesAllow(lib.rules)) continue;
    if (!nativeMatchesArch(lib.name)) continue;

    const artifact = lib.downloads?.artifact;
    if (artifact) {
      const dest = path.join(paths.libraries, artifact.path || mavenPath(lib.name));
      const entry = { name: lib.name, dest, url: artifact.url, sha1: artifact.sha1, size: artifact.size };
      downloads.push(entry);
      if (/natives-(windows|linux|macos|osx)/.test(lib.name)) natives.push(dest);
      else classpath.push(dest);
    } else if (!lib.natives && lib.url !== undefined) {
      // Bibliotheque au format Maven simple (courant chez Forge) : pas de bloc
      // downloads, seulement une base d'URL.
      const relative = mavenPath(lib.name);
      const base = (lib.url || `${config.endpoints.forgeMaven}/`).replace(/\/$/, '');
      const entry = {
        name: lib.name,
        dest: path.join(paths.libraries, relative),
        url: `${base}/${relative.split(path.sep).join('/')}`,
        sha1: lib.checksums?.[0],
      };
      downloads.push(entry);
      classpath.push(entry.dest);
    } else if (!lib.natives) {
      // Aucune source de telechargement : la bibliotheque doit deja etre
      // presente (produite par les processeurs d'installation Forge).
      classpath.push(path.join(paths.libraries, mavenPath(lib.name)));
    }

    const nativeKey = lib.natives?.[OS_NAME];
    if (nativeKey) {
      const classifier = nativeKey.replace('${arch}', process.arch === 'ia32' ? '32' : '64');
      const nativeArtifact = lib.downloads?.classifiers?.[classifier];
      if (nativeArtifact) {
        const dest = path.join(paths.libraries, nativeArtifact.path || mavenPath(`${lib.name}:${classifier}`));
        downloads.push({
          name: `${lib.name}:${classifier}`,
          dest,
          url: nativeArtifact.url,
          sha1: nativeArtifact.sha1,
          size: nativeArtifact.size,
        });
        natives.push(dest);
      }
    }
  }

  return { classpath, natives, downloads };
}

/** Extrait les jars natifs (.dll/.so/.dylib) dans le dossier natives de la version. */
async function extractNatives(nativeJars, versionId) {
  const target = path.join(paths.natives, versionId);
  await fsp.mkdir(target, { recursive: true });

  for (const jar of nativeJars) {
    if (!fs.existsSync(jar)) continue;
    const zip = new AdmZip(jar);
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory) continue;
      const base = path.basename(entry.entryName);
      if (!/\.(dll|so|dylib|jnilib)$/i.test(base)) continue;
      if (entry.entryName.startsWith('META-INF/')) continue;
      const dest = path.join(target, base);
      // On ne reextrait pas ce qui est deja a la bonne taille : sur un
      // relancement, cela evite de reecrire une DLL potentiellement verrouillee.
      if (fs.existsSync(dest) && fs.statSync(dest).size === entry.header.size) continue;
      await fsp.writeFile(dest, entry.getData());
    }
  }
  return target;
}

/**
 * Construit la liste de telechargement des assets a partir de l'index.
 * Renvoie aussi de quoi materialiser les assets "virtuels" des vieilles
 * versions, qui lisent leurs ressources par nom de fichier et non par hash.
 */
async function collectAssets(version) {
  if (!version.assetIndex) return { tasks: [], virtual: null };

  const indexPath = path.join(paths.assets, 'indexes', `${version.assetIndex.id}.json`);
  await downloadFile(version.assetIndex.url, indexPath, { sha1: version.assetIndex.sha1 });
  const index = JSON.parse(await fsp.readFile(indexPath, 'utf8'));

  const objectsDir = path.join(paths.assets, 'objects');
  const tasks = [];
  for (const [name, asset] of Object.entries(index.objects || {})) {
    const sub = asset.hash.slice(0, 2);
    tasks.push({
      name,
      dest: path.join(objectsDir, sub, asset.hash),
      url: `${config.endpoints.assets}/${sub}/${asset.hash}`,
      sha1: asset.hash,
      size: asset.size,
    });
  }

  const virtual = (index.virtual || index.map_to_resources)
    ? { index, dir: path.join(paths.assets, 'virtual', 'legacy') }
    : null;

  return { tasks, virtual };
}

async function materializeVirtualAssets(virtual) {
  if (!virtual) return;
  for (const [name, asset] of Object.entries(virtual.index.objects || {})) {
    const source = path.join(paths.assets, 'objects', asset.hash.slice(0, 2), asset.hash);
    const dest = path.join(virtual.dir, name);
    if (!fs.existsSync(source) || fs.existsSync(dest)) continue;
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.copyFile(source, dest);
  }
}

/**
 * Installe tout ce qu'il faut pour une version : jar client, bibliotheques,
 * natives extraites et assets. Renvoie de quoi construire la ligne de commande.
 */
async function install(versionId, { onProgress, onStatus } = {}) {
  paths.ensureAll();
  const version = await resolveVersion(versionId);
  const jarId = version.jarId || version.id;

  onStatus?.('Analyse des fichiers du jeu...');
  const { classpath, natives, downloads } = collectLibraries(version);

  const tasks = [...downloads];
  const clientJar = paths.versionJar(jarId);
  if (version.downloads?.client) {
    tasks.push({
      name: `minecraft-${jarId}.jar`,
      dest: clientJar,
      url: version.downloads.client.url,
      sha1: version.downloads.client.sha1,
      size: version.downloads.client.size,
    });
  }

  onStatus?.('Verification des ressources...');
  const assets = await collectAssets(version);
  tasks.push(...assets.tasks);

  onStatus?.(`Telechargement de ${tasks.length} fichiers...`);
  await downloadAll(tasks, { onProgress });
  await materializeVirtualAssets(assets.virtual);

  onStatus?.('Extraction des bibliotheques natives...');
  const nativesDir = await extractNatives(natives, jarId);

  return { version, jarId, clientJar, classpath, nativesDir };
}

module.exports = {
  install,
  resolveVersion,
  nativeMatchesArch,
  ensureVersionJson,
  getVersionManifest,
  collectLibraries,
  rulesAllow,
  mavenPath,
  libraryKey,
  OS_NAME,
  OS_ARCH,
};
