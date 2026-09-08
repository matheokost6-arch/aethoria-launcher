'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const paths = require('./paths');
const config = require('../../shared/config');
const { downloadFile } = require('./downloader');
const { javaBinary } = require('./java');

const INSTALL_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Coordonnees Maven de l'installateur Forge.
 * La plupart des versions s'ecrivent "<mc>-<forge>", mais certaines anciennes
 * branches (1.7.10, 1.8.9, 1.9.4) ajoutent un suffixe : le manifest peut alors
 * fournir forgeFullVersion pour court-circuiter la deduction.
 */
function installerCoords(mcVersion, forgeVersion, fullVersion) {
  const full = fullVersion || `${mcVersion}-${forgeVersion}`;
  return {
    full,
    url: `${config.endpoints.forgeMaven}/net/minecraftforge/forge/${full}/forge-${full}-installer.jar`,
    jar: path.join(paths.temp, `forge-${full}-installer.jar`),
  };
}

/** Liste les identifiants de version presents localement. */
function listVersionIds() {
  if (!fs.existsSync(paths.versions)) return [];
  return fs.readdirSync(paths.versions, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

/**
 * Cherche une installation Forge deja presente pour ce couple de versions.
 * On se fie au JSON de version plutot qu'au seul nom de dossier : c'est le
 * fichier que le launcher lira reellement au lancement.
 */
function findInstalledForge(mcVersion, forgeVersion) {
  for (const id of listVersionIds()) {
    if (!/forge/i.test(id)) continue;
    const jsonPath = paths.versionJson(id);
    if (!fs.existsSync(jsonPath)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      const inherits = data.inheritsFrom || data.jar;
      if (inherits === mcVersion && id.includes(forgeVersion)) return id;
    } catch {
      // JSON illisible : installation interrompue, on la reinstallera.
    }
  }
  return null;
}

/**
 * L'installateur Forge refuse de demarrer sans launcher_profiles.json : il
 * cherche a y ajouter un profil comme le ferait le launcher officiel. On lui
 * fournit un fichier minimal, qu'il modifiera sans consequence pour nous.
 */
async function ensureLauncherProfiles() {
  const file = path.join(paths.root, 'launcher_profiles.json');
  if (fs.existsSync(file)) return;
  await fsp.writeFile(file, JSON.stringify({
    profiles: {},
    settings: {},
    version: 3,
  }, null, 2), 'utf8');
}

function runInstaller(javaHome, jar, onLog) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      javaBinary(javaHome, { console: true }),
      ['-jar', jar, '--installClient', paths.root],
      { cwd: paths.root, windowsHide: true },
    );

    let output = '';
    const capture = (buffer) => {
      const text = buffer.toString();
      output += text;
      // On garde la sortie brute pour le diagnostic, mais on ne remonte a l'UI
      // que les lignes utiles : l'installateur est tres bavard.
      for (const line of text.split(/\r?\n/)) {
        if (/considering|processor|downloading|extract/i.test(line) && line.trim()) {
          onLog?.(line.trim());
        }
      }
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("L'installation de Forge a depasse 15 minutes et a ete interrompue."));
    }, INSTALL_TIMEOUT_MS);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Impossible de lancer l'installateur Forge : ${err.message}`));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve(output);
      const tail = output.trim().split(/\r?\n/).slice(-8).join('\n');
      reject(new Error(`L'installateur Forge a echoue (code ${code}).\n${tail}`));
    });
  });
}

/**
 * Installe Forge si necessaire et renvoie l'identifiant de version a lancer.
 * L'installateur officiel est utilise tel quel : il execute les processeurs
 * (deobfuscation, patch du client) que Forge met a jour a chaque version, ce
 * qu'une reimplementation maison casserait a chaque nouvelle branche.
 */
async function install(mcVersion, forgeVersion, javaHome, { onStatus, fullVersion } = {}) {
  const existing = findInstalledForge(mcVersion, forgeVersion);
  if (existing) return existing;

  paths.ensureAll();
  const coords = installerCoords(mcVersion, forgeVersion, fullVersion);

  onStatus?.(`Telechargement de Forge ${coords.full}...`);
  try {
    await downloadFile(coords.url, coords.jar);
  } catch (err) {
    throw new Error(
      `Forge ${coords.full} est introuvable sur le depot officiel (${err.message}). `
      + 'Verifie minecraftVersion et forgeVersion dans le manifest.',
    );
  }

  await ensureLauncherProfiles();

  const before = new Set(listVersionIds());
  onStatus?.('Installation de Forge (cela peut prendre quelques minutes)...');
  await runInstaller(javaHome, coords.jar, (line) => onStatus?.(`Forge : ${line}`));

  const created = listVersionIds().filter((id) => !before.has(id));
  const forgeId = created.find((id) => /forge/i.test(id))
    || findInstalledForge(mcVersion, forgeVersion);

  if (!forgeId) {
    throw new Error(
      "L'installateur Forge s'est termine sans erreur mais aucune version n'a ete creee. "
      + `Supprime le dossier ${paths.versions} et relance le launcher.`,
    );
  }

  await fsp.rm(coords.jar, { force: true }).catch(() => {});
  onStatus?.(`Forge ${coords.full} installe.`);
  return forgeId;
}

module.exports = { install, findInstalledForge, installerCoords };
