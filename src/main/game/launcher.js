'use strict';

const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const paths = require('./paths');
const config = require('../../shared/config');
const vanilla = require('./vanilla');
const forge = require('./forge');
const modpack = require('./modpack');
const java = require('./java');
const auth = require('../auth');
const store = require('../store');
const pkg = require('../../../package.json');

let running = null; // un seul processus de jeu a la fois

/* ------------------------------------------------------------------ *
 *  Construction des arguments
 * ------------------------------------------------------------------ */

/** Remplace les ${placeholders} d'un argument par leur valeur. */
function substitute(value, vars) {
  return String(value).replace(/\$\{([\w_]+)\}/g, (match, key) => (
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : match
  ));
}

/**
 * Aplatit une liste d'arguments au format moderne : chaque entree est soit une
 * chaine, soit un objet { rules, value } dont les regles decident de l'inclusion.
 */
function flattenArguments(list, vars, features) {
  const out = [];
  for (const entry of list || []) {
    if (typeof entry === 'string') {
      out.push(substitute(entry, vars));
      continue;
    }
    if (!vanilla.rulesAllow(entry.rules, features)) continue;
    const values = Array.isArray(entry.value) ? entry.value : [entry.value];
    for (const value of values) out.push(substitute(value, vars));
  }
  return out;
}

/** Compare deux versions Minecraft ("1.20.1" >= "1.20"). */
function versionAtLeast(version, target) {
  const parse = (v) => String(v).split('.').map((n) => parseInt(n, 10) || 0);
  const a = parse(version);
  const b = parse(target);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] || 0) - (b[i] || 0);
    if (diff !== 0) return diff > 0;
  }
  return true;
}

function buildCommand({ version, jarId, clientJar, classpath, nativesDir, javaHome, account, settings, server }) {
  const separator = process.platform === 'win32' ? ';' : ':';
  // Le jar du client vient en dernier : les patches Forge presents dans les
  // bibliotheques doivent primer sur les classes vanilla.
  const fullClasspath = [...new Set([...classpath, clientJar])].join(separator);

  const assetsDir = version.assets === 'pre-1.6' || version.assets === 'legacy'
    ? path.join(paths.assets, 'virtual', 'legacy')
    : paths.assets;

  const vars = {
    natives_directory: nativesDir,
    launcher_name: config.launcherName,
    launcher_version: pkg.version,
    classpath: fullClasspath,
    classpath_separator: separator,
    library_directory: paths.libraries,
    version_name: version.id,
    game_directory: paths.root,
    assets_root: paths.assets,
    assets_index_name: version.assetIndex?.id || version.assets || 'legacy',
    game_assets: assetsDir,
    auth_player_name: account.name,
    auth_uuid: account.uuid.replace(/-/g, ''),
    auth_access_token: account.accessToken,
    auth_session: `token:${account.accessToken}:${account.uuid.replace(/-/g, '')}`,
    auth_xuid: account.xuid || '0',
    // Identifiant du launcher pour la telemetrie Mojang. Il ne doit pas etre
    // vide : un argument vide decale la lecture des options par le client.
    clientid: account.type === 'microsoft' ? config.msalClientId : '0',
    user_type: account.type === 'microsoft' ? 'msa' : 'legacy',
    version_type: config.appName,
    user_properties: '{}',
    resolution_width: 854,
    resolution_height: 480,
  };

  const jvmArgs = [];
  if (version.arguments?.jvm) {
    // Format moderne : le JSON declare deja tout, y compris java.library.path,
    // le classpath, la marque du launcher et les options propres a chaque OS.
    jvmArgs.push(...flattenArguments(version.arguments.jvm, vars, {}));
  } else {
    // Versions anterieures a 1.13 : rien n'est declare, il faut fournir
    // soi-meme le chemin des natives, le classpath et les options par OS.
    jvmArgs.push(
      `-Djava.library.path=${nativesDir}`,
      `-Dminecraft.launcher.brand=${config.launcherName}`,
      `-Dminecraft.launcher.version=${pkg.version}`,
      '-cp', fullClasspath,
    );
    if (process.platform === 'win32') {
      // Contournement d'un bug de fuite memoire du GC sous Windows,
      // repris des profils de lancement officiels de Mojang.
      jvmArgs.push('-XX:HeapDumpPath=MojangTricksIntelDriversForPerformance_javaw.exe_minecraft.exe.heapdump');
    }
    if (process.platform === 'darwin') jvmArgs.push('-XstartOnFirstThread');
  }

  jvmArgs.unshift(`-Xms${settings.minRamMb}M`, `-Xmx${settings.maxRamMb}M`);

  // Forge exclut du module path les jars enumeres dans -DignoreList, et y
  // attend "<version_name>.jar". Or le jar vanilla que nous mettons au
  // classpath porte le nom de la version parente (1.20.1.jar, pas
  // 1.20.1-forge-47.3.0.jar). Sans cet ajout, Java voit deux modules exporter
  // net.minecraft et refuse de demarrer :
  //   ResolutionException: Modules minecraft and _1._20._1 export package
  //   net.minecraft.server to module forge
  const clientJarName = path.basename(clientJar);
  for (let i = 0; i < jvmArgs.length; i += 1) {
    if (jvmArgs[i].startsWith('-DignoreList=') && !jvmArgs[i].includes(clientJarName)) {
      jvmArgs[i] += `,${clientJarName}`;
    }
  }

  const extra = String(settings.jvmArgs || '').trim();
  if (extra) jvmArgs.push(...extra.split(/\s+/));

  const gameArgs = version.arguments?.game
    ? flattenArguments(version.arguments.game, vars, {})
    : substitute(version.minecraftArguments || '', vars).split(/\s+/).filter(Boolean);

  // Connexion directe au serveur. Le drapeau a change en 1.20 : --server/--port
  // a laisse place a --quickPlayMultiplayer.
  if (server) {
    const mcVersion = version.inheritsFrom || version.jarId || version.id;
    if (versionAtLeast(mcVersion, '1.20')) {
      gameArgs.push('--quickPlayMultiplayer', `${server.host}:${server.port}`);
    } else {
      gameArgs.push('--server', server.host, '--port', String(server.port));
    }
  }

  return {
    binary: java.javaBinary(javaHome),
    args: [...jvmArgs, version.mainClass, ...gameArgs],
    jarId,
  };
}

/* ------------------------------------------------------------------ *
 *  Preparation et lancement
 * ------------------------------------------------------------------ */

// Place necessaire a une installation complete : client, bibliotheques,
// ressources, runtime Java et modpack, avec une marge de securite.
const ESPACE_REQUIS_OCTETS = 3 * 1024 * 1024 * 1024;

/**
 * Verifie qu'il reste assez de place avant de lancer plus d'un gigaoctet de
 * telechargement. Sans ce controle, le disque se remplit en cours de route et
 * l'echec survient au bout de plusieurs minutes, sur un message technique
 * incomprehensible pour le joueur.
 */
async function checkDiskSpace(onStatus) {
  try {
    const stats = await fsp.statfs(paths.root);
    const libre = stats.bavail * stats.bsize;
    if (libre >= ESPACE_REQUIS_OCTETS) return;

    const enGo = (octets) => (octets / 1024 / 1024 / 1024).toFixed(1);
    throw new Error(
      `Espace disque insuffisant : ${enGo(libre)} Go disponibles sur ${path.parse(paths.root).root}, `
      + `il en faut environ ${enGo(ESPACE_REQUIS_OCTETS)} Go. `
      + 'Libere de la place, ou choisis un autre dossier de jeu dans les parametres.',
    );
  } catch (err) {
    // statfs n'existe pas partout : l'absence de mesure ne doit pas empecher
    // de jouer, on ne bloque que sur un manque de place avere.
    if (err.message.startsWith('Espace disque insuffisant')) throw err;
    onStatus?.('Espace disque non verifiable, poursuite du lancement.');
  }
}

/**
 * Prepare tout ce qui est necessaire puis demarre le jeu.
 * Les etapes sont volontairement sequentielles et annoncees une par une :
 * quand un lancement echoue, le joueur doit pouvoir dire a quel moment.
 */
async function launch({ accountId, onStatus, onProgress, onLog, onExit }) {
  if (running) throw new Error('Le jeu est deja en cours de lancement ou d’execution.');

  const settings = store.getSettings();
  if (settings.gameRoot) paths.setRoot(settings.gameRoot);
  paths.ensureAll();

  const status = (message) => { onStatus?.(message); };

  status('Verification du compte...');
  const account = await auth.resolveForLaunch(accountId);

  await checkDiskSpace(status);

  const { manifest, offline } = await modpack.fetchManifest({ onStatus: status });
  if (offline) status('Mode hors ligne : le modpack ne sera pas verifie.');

  const mcVersion = manifest.minecraftVersion || config.fallback.minecraftVersion;
  const forgeVersion = manifest.forgeVersion || config.fallback.forgeVersion;

  // Le JSON de la version vanilla est necessaire avant Forge : l'installateur
  // s'appuie dessus, et il nous donne la version de Java a utiliser.
  status(`Preparation de Minecraft ${mcVersion}...`);
  const baseVersion = await vanilla.ensureVersionJson(mcVersion);
  const javaHome = await java.ensureJava(baseVersion, settings, { onStatus: status, onProgress });

  const versionId = await forge.install(mcVersion, forgeVersion, javaHome, {
    onStatus: status,
    fullVersion: manifest.forgeFullVersion,
  });

  status('Verification des fichiers du jeu...');
  const installed = await vanilla.install(versionId, { onStatus: status, onProgress });

  if (!offline) {
    await modpack.sync(manifest, {
      settings,
      optionalEnabled: settings.optionalMods || [],
      onStatus: status,
      onProgress,
    });
  }

  const server = settings.joinServerOnLaunch
    ? { ...config.server, ...(manifest.server || {}) }
    : null;

  const command = buildCommand({
    ...installed,
    javaHome,
    account,
    settings,
    server,
  });

  status('Demarrage de Minecraft...');
  await writeLaunchLog(command, account);

  const child = spawn(command.binary, command.args, {
    cwd: paths.root,
    detached: false,
    windowsHide: true,
  });
  running = child;

  const tail = [];
  const pushLine = (line) => {
    if (!line.trim()) return;
    tail.push(line);
    if (tail.length > 60) tail.shift(); // on ne garde que la fin, seule utile au diagnostic
    onLog?.(line);
  };
  child.stdout.on('data', (b) => b.toString().split(/\r?\n/).forEach(pushLine));
  child.stderr.on('data', (b) => b.toString().split(/\r?\n/).forEach(pushLine));

  child.on('error', (err) => {
    running = null;
    onExit?.({ code: -1, error: `Java n'a pas pu demarrer : ${err.message}` });
  });

  child.on('close', (code) => {
    running = null;
    if (code === 0) {
      onExit?.({ code });
      return;
    }
    onExit?.({
      code,
      error: `Minecraft s'est ferme avec le code ${code}.`,
      log: tail.join('\n'),
    });
  });

  // Le jeu met plusieurs secondes a afficher sa fenetre : on considere le
  // lancement reussi une fois le processus vivant et stable.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  if (!running) throw new Error('Le processus Minecraft s’est arrete immediatement. Consulte les journaux.');

  return { pid: child.pid, versionId };
}

/** Journalise la commande complete : indispensable pour diagnostiquer a distance. */
async function writeLaunchLog(command, account) {
  const file = path.join(paths.logs, `launch-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
  const redacted = command.args.map((arg) => (
    // Le jeton d'acces ne doit jamais finir dans un fichier que le joueur nous enverra.
    account.accessToken && arg === account.accessToken ? '<token masque>' : arg
  ));
  await fsp.mkdir(paths.logs, { recursive: true });
  await fsp.writeFile(file, [
    `Date      : ${new Date().toISOString()}`,
    `Launcher  : ${config.appName} ${pkg.version}`,
    `Compte    : ${account.name} (${account.type})`,
    `Java      : ${command.binary}`,
    '',
    'Commande :',
    redacted.join(' \\\n  '),
    '',
  ].join('\n'), 'utf8');
  await rotateLogs();
}

/** Conserve les 20 derniers journaux de lancement. */
async function rotateLogs() {
  try {
    const files = (await fsp.readdir(paths.logs))
      .filter((f) => f.startsWith('launch-'))
      .sort();
    for (const file of files.slice(0, Math.max(0, files.length - 20))) {
      await fsp.rm(path.join(paths.logs, file), { force: true });
    }
  } catch {
    // La rotation des journaux ne doit jamais empecher un lancement.
  }
}

function isRunning() {
  return Boolean(running);
}

function stop() {
  if (!running) return false;
  running.kill();
  return true;
}

/** Reinstallation propre : on supprime ce qui est reconstructible, pas les sauvegardes. */
async function repair({ onStatus } = {}) {
  if (running) throw new Error('Ferme Minecraft avant de reparer l’installation.');
  const settings = store.getSettings();
  if (settings.gameRoot) paths.setRoot(settings.gameRoot);

  for (const dir of [paths.versions, paths.libraries, paths.natives, paths.mods]) {
    onStatus?.(`Suppression de ${path.basename(dir)}...`);
    await fsp.rm(dir, { recursive: true, force: true });
  }
  await fsp.rm(path.join(paths.root, 'manifest.cache.json'), { force: true });
  await fsp.rm(path.join(paths.root, '.aethoria-managed.json'), { force: true });
  paths.ensureAll();
  onStatus?.('Installation reinitialisee. Relance le jeu pour tout retelecharger.');
  return true;
}

module.exports = { launch, isRunning, stop, repair, buildCommand, versionAtLeast, flattenArguments };
