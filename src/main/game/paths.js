'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const { app } = require('electron');
const config = require('../../shared/config');

/**
 * Emplacement du dossier de jeu. Par defaut %APPDATA%/.aethoria sous Windows,
 * afin de ne pas polluer le .minecraft officiel du joueur : le modpack Aethoria
 * a son propre dossier mods, ses propres sauvegardes et sa propre config.
 */
function defaultRoot() {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), '.aethoria');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'aethoria');
  }
  return path.join(os.homedir(), '.aethoria');
}

let rootOverride = null;

const paths = {
  setRoot(dir) {
    rootOverride = dir || null;
  },
  get root() {
    return rootOverride || defaultRoot();
  },
  get versions() {
    return path.join(this.root, 'versions');
  },
  get libraries() {
    return path.join(this.root, 'libraries');
  },
  get assets() {
    return path.join(this.root, 'assets');
  },
  get natives() {
    return path.join(this.root, 'natives');
  },
  get mods() {
    return path.join(this.root, 'mods');
  },
  get config() {
    return path.join(this.root, 'config');
  },
  get runtime() {
    return path.join(this.root, 'runtime');
  },
  get temp() {
    return path.join(this.root, 'temp');
  },
  get logs() {
    return path.join(this.root, 'launcher-logs');
  },
  // Donnees du launcher (comptes, preferences) : stockees dans userData pour
  // survivre a une suppression du dossier de jeu.
  get userData() {
    return app.getPath('userData');
  },
  get settingsFile() {
    return path.join(this.userData, 'settings.json');
  },
  get accountsFile() {
    return path.join(this.userData, 'accounts.json');
  },
  versionDir(id) {
    return path.join(this.versions, id);
  },
  versionJson(id) {
    return path.join(this.versions, id, `${id}.json`);
  },
  versionJar(id) {
    return path.join(this.versions, id, `${id}.jar`);
  },
  ensure(...dirs) {
    for (const dir of dirs) {
      fs.mkdirSync(dir, { recursive: true });
    }
  },
  ensureAll() {
    this.ensure(
      this.root, this.versions, this.libraries, this.assets,
      this.natives, this.mods, this.config, this.runtime,
      this.temp, this.logs,
    );
  },
};

module.exports = paths;
module.exports.defaultRoot = defaultRoot;
module.exports.appName = config.appName;
