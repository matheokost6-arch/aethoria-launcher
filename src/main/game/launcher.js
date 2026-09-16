'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const paths = require('./paths');
const config = require('../../shared/config');
const vanilla = require('./vanilla');
const forge = require('./forge');
const modpack = require('./modpack');
const java = require('./java');
const diagnostic = require('./diagnostic');
const downloader = require('./downloader');
const auth = require('../auth');
const store = require('../store');
const pkg = require('../../../package.json');

let running = null; // un seul processus de jeu a la fois
let stopRequested = false;

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

function buildCommand({ version, jarId, clientJar, classpath, nativesDir, javaHome, account, settings, server, menuServer }) {
  const separator = process.platform === 'win32' ? ';' : ':';
  // Le jar du client vient en dernier : les patches Forge presents dans les
  // bibliotheques doivent primer sur les classes vanilla.
  const fullClasspath = [...new Set([...classpath, clientJar])].join(separator);

  const assetsDir = version.assets === 'pre-1.6' || version.assets === 'legacy'
    ? path.join(paths.assets, 'virtual', 'legacy')
    : paths.assets;

  // Taille de la fenetre du jeu choisie dans les reglages ("1600x900").
  const size = /^(\d+)x(\d+)$/.exec(settings.gameResolution || '');
  const features = { has_custom_resolution: Boolean(size) };

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
    // Ces valeurs ne doivent pas etre vides : un argument vide decale la
    // lecture des options par le client.
    auth_xuid: '0',
    clientid: '0',
    user_type: 'legacy',
    version_type: config.appName,
    user_properties: '{}',
    resolution_width: size ? size[1] : 854,
    resolution_height: size ? size[2] : 480,
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

  // Adresse lue par le menu Aethoria du jeu : un serveur change dans le
  // manifest est pris en compte sans nouvelle version du mod.
  if (menuServer) jvmArgs.push(`-Daethoria.server=${menuServer.host}:${menuServer.port}`);

  const extra = String(settings.jvmArgs || '').trim();
  if (extra) jvmArgs.push(...extra.split(/\s+/));

  const gameArgs = version.arguments?.game
    ? flattenArguments(version.arguments.game, vars, features)
    : substitute(version.minecraftArguments || '', vars).split(/\s+/).filter(Boolean);

  if (settings.gameResolution === 'fullscreen') gameArgs.push('--fullscreen');

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
      + 'Libère de la place, ou choisis un autre dossier de jeu dans les paramètres.',
    );
  } catch (err) {
    // statfs n'existe pas partout : l'absence de mesure ne doit pas empecher
    // de jouer, on ne bloque que sur un manque de place avere.
    if (err.message.startsWith('Espace disque insuffisant')) throw err;
    onStatus?.('Espace disque non vérifiable, poursuite du lancement.');
  }
}

/** Chaine NBT : longueur sur deux octets, puis le texte. */
function nbtString(text) {
  const body = Buffer.from(text, 'utf8');
  const length = Buffer.alloc(2);
  length.writeUInt16BE(body.length);
  return Buffer.concat([length, body]);
}

const nbtTag = (type, name, payload) => Buffer.concat([Buffer.from([type]), nbtString(name), payload]);

/**
 * Ajoute Aethoria a la liste multijoueur de Minecraft (servers.dat, NBT non
 * compresse). Seulement si le fichier n'existe pas encore : une liste que le
 * joueur a deja remplie n'est jamais reecrite.
 */
async function ensureServerListed(server) {
  const file = path.join(paths.root, 'servers.dat');
  if (fs.existsSync(file)) return;

  const address = server.port === 25565 ? server.host : `${server.host}:${server.port}`;
  const entry = Buffer.concat([
    nbtTag(8, 'name', nbtString(config.appName)),
    nbtTag(8, 'ip', nbtString(address)),
    Buffer.from([0]),
  ]);
  const count = Buffer.alloc(4);
  count.writeInt32BE(1);
  const servers = nbtTag(9, 'servers', Buffer.concat([Buffer.from([10]), count, entry]));
  await fsp.writeFile(file, nbtTag(10, '', Buffer.concat([servers, Buffer.from([0])])));
}

/**
 * Minecraft s'ouvre en francais des la premiere partie. Une langue deja
 * choisie par le joueur dans options.txt est respectee.
 */
async function ensureFrenchByDefault() {
  const file = path.join(paths.root, 'options.txt');
  const content = await fsp.readFile(file, 'utf8').catch(() => '');
  if (/^lang:/m.test(content)) return;
  const separator = content && !content.endsWith('\n') ? '\n' : '';
  await fsp.writeFile(file, `${content}${separator}lang:fr_fr\n`, 'utf8');
}

/**
 * Prepare tout ce qui est necessaire puis demarre le jeu.
 * Les etapes sont volontairement sequentielles et annoncees une par une :
 * quand un lancement echoue, le joueur doit pouvoir dire a quel moment.
 */
async function launch({
  prepareOnly = false, onStatus, onProgress, onLog, onExit, onFirstRun, onReady, onStep, onModpackChanges,
}) {
  if (running) throw new Error('Le jeu est déjà en cours de lancement ou d’exécution.');

  const settings = store.getSettings();
  if (settings.gameRoot) paths.setRoot(settings.gameRoot);
  paths.ensureAll();
  downloader.setSpeed(settings.downloadSpeed);

  const status = (message) => { onStatus?.(message); };
  // Etapes affichees au joueur : 1 modpack, 2 Java, 3 Forge, 4 fichiers, 5 mods, 6 demarrage.
  const step = (number) => { onStep?.(number); };

  // Premiere installation : rien n'a encore ete telecharge. On previent
  // le joueur, sinon il croit a un blocage pendant les minutes de
  // telechargement et ferme le launcher au pire moment.
  const premiereFois = !fs.existsSync(paths.versions)
    || fs.readdirSync(paths.versions).length === 0;
  if (premiereFois) onFirstRun?.();

  const account = auth.resolveForLaunch();

  await checkDiskSpace(status);

  step(1);
  const { manifest, offline } = await modpack.fetchManifest({ onStatus: status });
  if (offline) status('Mode hors ligne : le modpack ne sera pas vérifié.');

  const mcVersion = manifest.minecraftVersion || config.fallback.minecraftVersion;
  const forgeVersion = manifest.forgeVersion || config.fallback.forgeVersion;

  // Le JSON de la version vanilla est necessaire avant Forge : l'installateur
  // s'appuie dessus, et il nous donne la version de Java a utiliser.
  status(`Préparation de Minecraft ${mcVersion}...`);
  step(2);
  const baseVersion = await vanilla.ensureVersionJson(mcVersion);
  const javaHome = await java.ensureJava(baseVersion, settings, { onStatus: status, onProgress });

  step(3);
  const versionId = await forge.install(mcVersion, forgeVersion, javaHome, {
    onStatus: status,
    fullVersion: manifest.forgeFullVersion,
  });

  status('Vérification des fichiers du jeu...');
  step(4);
  const installed = await vanilla.install(versionId, { onStatus: status, onProgress });

  if (!offline) {
    step(5);
    const changes = await modpack.sync(manifest, {
      optionalEnabled: settings.optionalMods || [],
      onStatus: status,
      onProgress,
    });
    if (changes.modsAdded.length || changes.modsRemoved.length) onModpackChanges?.(changes);
  }

  // "Vérifier les fichiers" : tout est controle et retelecharge si besoin,
  // sans demarrer le jeu.
  if (prepareOnly) {
    status('Tous les fichiers du jeu sont à jour.');
    return { prepared: true, versionId };
  }

  const serveur = { ...config.server, ...(manifest.server || {}) };
  const command = buildCommand({
    ...installed,
    javaHome,
    account,
    settings,
    server: settings.autoJoinServer ? serveur : null,
    menuServer: serveur,
  });

  status('Démarrage de Minecraft...');
  step(6);
  await ensureFrenchByDefault();
  await ensureServerListed(serveur);
  await writeLaunchLog(command, account);

  // Detache : sous Windows, un processus enfant non detache est tue avec le
  // launcher. Fermer le launcher (ou le voir planter) fermerait alors le jeu.
  const child = spawn(command.binary, command.args, {
    cwd: paths.root,
    detached: true,
    windowsHide: true,
  });
  running = child;
  stopRequested = false;
  const startedAt = Date.now();

  const tail = [];
  let ready = false;
  const pushLine = (line) => {
    if (!line.trim()) return;
    tail.push(line);
    if (tail.length > 60) tail.shift(); // on ne garde que la fin, seule utile au diagnostic
    onLog?.(line);
    // Le moteur audio demarre juste avant l'affichage du menu : le jeu est pret.
    if (!ready && /Sound engine started/i.test(line)) {
      ready = true;
      onReady?.();
    }
  };
  child.stdout.on('data', (b) => b.toString().split(/\r?\n/).forEach(pushLine));
  child.stderr.on('data', (b) => b.toString().split(/\r?\n/).forEach(pushLine));

  child.on('error', (err) => {
    running = null;
    onExit?.({ code: -1, error: `Java n'a pas pu démarrer : ${err.message}` });
  });

  child.on('close', (code) => {
    running = null;
    const durationSeconds = Math.round((Date.now() - startedAt) / 1000);
    store.addPlaySession(durationSeconds);

    if (code === 0 || stopRequested) {
      onExit?.({ code, durationSeconds, stopped: stopRequested });
      return;
    }
    const journal = tail.join('\n');
    onExit?.({
      code,
      durationSeconds,
      error: `Minecraft s'est fermé avec le code ${code}.`,
      log: journal,
      // Le journal contient presque toujours la cause : on la traduit ici
      // plutot que de laisser le joueur devant un code de sortie.
      diagnostic: diagnostic.analyser(journal, code),
    });
  });

  // Le jeu met plusieurs secondes a afficher sa fenetre : on considere le
  // lancement reussi une fois le processus vivant et stable.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  if (!running) throw new Error('Le processus Minecraft s’est arrêté immédiatement. Consulte les journaux.');

  return { pid: child.pid, versionId };
}

/** Journalise la commande complete : indispensable pour diagnostiquer a distance. */
async function writeLaunchLog(command, account) {
  const file = path.join(paths.logs, `launch-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
  await fsp.mkdir(paths.logs, { recursive: true });
  await fsp.writeFile(file, [
    `Date      : ${new Date().toISOString()}`,
    `Launcher  : ${config.appName} ${pkg.version}`,
    `Pseudo    : ${account.name}`,
    `Java      : ${command.binary}`,
    '',
    'Commande :',
    command.args.join(' \\\n  '),
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

/** Ramene la fenetre du jeu au premier plan. */
function focusGame() {
  if (!running) return false;
  spawn('powershell', [
    '-NoProfile', '-WindowStyle', 'Hidden', '-Command',
    `(New-Object -ComObject WScript.Shell).AppActivate(${Number(running.pid)}) | Out-Null`,
  ], { windowsHide: true, stdio: 'ignore' });
  return true;
}

function stop() {
  if (!running) return false;
  stopRequested = true;
  running.kill();
  return true;
}

/** Reinstallation propre : on supprime ce qui est reconstructible, pas les sauvegardes. */
async function repair({ onStatus } = {}) {
  if (running) throw new Error('Ferme Minecraft avant de réparer l’installation.');
  const settings = store.getSettings();
  if (settings.gameRoot) paths.setRoot(settings.gameRoot);

  for (const dir of [paths.versions, paths.libraries, paths.natives, paths.mods]) {
    onStatus?.(`Suppression de ${path.basename(dir)}...`);
    await fsp.rm(dir, { recursive: true, force: true });
  }
  await fsp.rm(path.join(paths.root, 'manifest.cache.json'), { force: true });
  await fsp.rm(path.join(paths.root, '.aethoria-managed.json'), { force: true });
  paths.ensureAll();
  onStatus?.('Installation réinitialisée. Relance le jeu pour tout retélécharger.');
  return true;
}

module.exports = { launch, isRunning, focusGame, stop, repair };
