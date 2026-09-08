'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const paths = require('./paths');
const config = require('../../shared/config');
const { downloadAll, getJson } = require('./downloader');

const execFileAsync = promisify(execFile);

// Correspondance entre notre plateforme et les cles du manifest Mojang.
const RUNTIME_PLATFORM = (() => {
  if (process.platform === 'win32') return process.arch === 'arm64' ? 'windows-arm64' : (process.arch === 'ia32' ? 'windows-x86' : 'windows-x64');
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'mac-os-arm64' : 'mac-os';
  return process.arch === 'arm64' ? 'linux' : (process.arch === 'ia32' ? 'linux-i386' : 'linux');
})();

const EXE = process.platform === 'win32' ? '.exe' : '';

/**
 * Chemin de l'executable Java dans un runtime installe.
 * On prefere javaw (sans console) sous Windows pour ne pas afficher une fenetre
 * noire derriere le jeu ; java.exe reste utilise pour les taches en arriere-plan
 * (installation de Forge) dont on veut lire la sortie.
 */
function javaBinary(home, { console: wantConsole = false } = {}) {
  const name = (process.platform === 'win32' && !wantConsole) ? 'javaw' : 'java';
  const candidates = [
    path.join(home, 'bin', `${name}${EXE}`),
    path.join(home, 'jre.bundle', 'Contents', 'Home', 'bin', `${name}${EXE}`), // macOS
  ];
  return candidates.find((c) => fs.existsSync(c)) || candidates[0];
}

/** Interroge un java pour connaitre sa version majeure (8, 17, 21...). */
async function probeJavaVersion(binary) {
  try {
    // java -version ecrit sur stderr, y compris en cas de succes.
    const { stderr, stdout } = await execFileAsync(binary, ['-version'], { timeout: 10000 });
    const output = `${stderr}${stdout}`;
    const match = output.match(/version "(\d+)(?:\.(\d+))?/);
    if (!match) return null;
    const major = Number(match[1]);
    // Avant Java 9 la version s'ecrivait 1.8.x : la majeure est le second nombre.
    return major === 1 ? Number(match[2]) : major;
  } catch {
    return null;
  }
}

/** Cherche un Java deja installe sur la machine, compatible avec la version demandee. */
async function findSystemJava(requiredMajor) {
  const candidates = [];
  if (process.env.JAVA_HOME) candidates.push(javaBinary(process.env.JAVA_HOME, { console: true }));
  candidates.push(process.platform === 'win32' ? 'java.exe' : 'java');

  for (const dir of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean)) {
    for (const vendor of ['Java', 'Eclipse Adoptium', 'Microsoft', 'Zulu', 'Amazon Corretto']) {
      const base = path.join(dir, vendor);
      if (!fs.existsSync(base)) continue;
      for (const entry of fs.readdirSync(base)) {
        candidates.push(javaBinary(path.join(base, entry), { console: true }));
      }
    }
  }

  for (const candidate of candidates) {
    if (candidate.includes(path.sep) && !fs.existsSync(candidate)) continue;
    const major = await probeJavaVersion(candidate);
    if (major && (!requiredMajor || major === requiredMajor)) {
      // On renvoie le home, pas le binaire : l'appelant choisira java ou javaw.
      return path.dirname(path.dirname(candidate));
    }
  }
  return null;
}

/** Telecharge le runtime Java officiel correspondant au composant demande. */
async function downloadRuntime(component, { onProgress, onStatus } = {}) {
  const home = path.join(paths.runtime, component, RUNTIME_PLATFORM);
  const markerFile = path.join(home, '.installed');
  if (fs.existsSync(markerFile)) return home;

  onStatus?.(`Telechargement de Java (${component})...`);
  const all = await getJson(config.endpoints.javaRuntime);
  const entry = all[RUNTIME_PLATFORM]?.[component]?.[0];
  if (!entry) {
    throw new Error(`Aucun runtime Java "${component}" disponible pour ${RUNTIME_PLATFORM}.`);
  }

  const manifest = await getJson(entry.manifest.url);
  const tasks = [];
  const links = [];
  const executables = [];

  for (const [relative, file] of Object.entries(manifest.files || {})) {
    const dest = path.join(home, relative);
    if (file.type === 'directory') {
      await fsp.mkdir(dest, { recursive: true });
    } else if (file.type === 'link') {
      links.push({ dest, target: file.target });
    } else if (file.downloads?.raw) {
      tasks.push({
        name: relative,
        dest,
        url: file.downloads.raw.url,
        sha1: file.downloads.raw.sha1,
        size: file.downloads.raw.size,
      });
      if (file.executable) executables.push(dest);
    }
  }

  await downloadAll(tasks, { onProgress, concurrency: 16 });

  for (const link of links) {
    await fsp.mkdir(path.dirname(link.dest), { recursive: true });
    await fsp.rm(link.dest, { force: true });
    // Sous Windows, les liens symboliques demandent des droits particuliers :
    // une copie du fichier cible fait aussi bien l'affaire.
    const target = path.resolve(path.dirname(link.dest), link.target);
    try {
      await fsp.symlink(link.target, link.dest);
    } catch {
      if (fs.existsSync(target)) await fsp.copyFile(target, link.dest);
    }
  }

  if (process.platform !== 'win32') {
    for (const file of executables) {
      await fsp.chmod(file, 0o755).catch(() => {});
    }
  }

  await fsp.writeFile(markerFile, new Date().toISOString(), 'utf8');
  return home;
}

/**
 * Renvoie le home Java a utiliser pour une version donnee, dans cet ordre :
 *   1. le chemin choisi manuellement dans les parametres ;
 *   2. le runtime officiel telecharge par le launcher (le cas normal) ;
 *   3. un Java systeme compatible, si le telechargement echoue.
 */
async function ensureJava(version, settings = {}, hooks = {}) {
  if (settings.javaPath) {
    const home = settings.javaPath.match(/[/\\]bin[/\\]javaw?(\.exe)?$/i)
      ? path.dirname(path.dirname(settings.javaPath))
      : settings.javaPath;
    if (!fs.existsSync(javaBinary(home, { console: true }))) {
      throw new Error(`Le Java configure dans les parametres est introuvable : ${settings.javaPath}`);
    }
    return home;
  }

  const component = version.javaVersion?.component || 'jre-legacy';
  const requiredMajor = version.javaVersion?.majorVersion;

  try {
    return await downloadRuntime(component, hooks);
  } catch (err) {
    hooks.onStatus?.('Runtime Java officiel indisponible, recherche d’un Java installe...');
    const system = await findSystemJava(requiredMajor);
    if (system) return system;
    throw new Error(
      `Impossible d'obtenir Java ${requiredMajor || ''} (${err.message}). `
      + 'Installe Java manuellement puis indique son chemin dans les parametres du launcher.',
    );
  }
}

module.exports = { ensureJava, javaBinary, probeJavaVersion, findSystemJava, RUNTIME_PLATFORM };
