'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const config = require('../../shared/config');
const paths = require('./paths');
const serverStatus = require('./serverStatus');

/**
 * Test de connexion et de la machine, lance depuis les reglages. Chaque
 * verification renvoie ok, warn ou error avec une explication lisible : le
 * joueur sait tout de suite si le probleme vient de chez lui ou d'ailleurs.
 */

const Go = (bytes) => `${(bytes / 1024 / 1024 / 1024).toFixed(1).replace('.0', '').replace('.', ',')} Go`;

// Une barrette de 8 Go n'en montre qu'environ 7,9 a Windows : le seuil laisse
// passer ces machines, et n'alerte que les vraies configurations a 6 Go ou moins.
const RAM_ALERTE_MB = 7000;

async function check(label, fn) {
  try {
    return { label, status: 'ok', ...(await fn()) };
  } catch (err) {
    return { label, status: 'error', detail: err.message };
  }
}

async function reach(url) {
  const start = Date.now();
  const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Réponse ${res.status}`);
  return { detail: `Joignable (${Date.now() - start} ms)` };
}

function run(settings, systemRamMb) {
  const { host, port } = config.server;
  return Promise.all([
    check('Téléchargement du modpack (GitHub)', () => reach(config.manifestUrl)),
    check('Serveurs de Minecraft (Mojang)', () => reach(config.endpoints.versionManifest)),
    check('Serveur Aethoria', async () => {
      const status = await serverStatus.ping(host, port);
      if (!status.online) throw new Error('Ne répond pas : il est peut-être éteint, ou ta connexion le bloque.');
      return { status: status.latency > 180 ? 'warn' : 'ok', detail: `En ligne (${status.latency} ms)` };
    }),
    check('Espace disque', async () => {
      const dir = fs.existsSync(paths.root) ? paths.root : path.parse(paths.root).root;
      const stats = await fsp.statfs(dir);
      const free = stats.bavail * stats.bsize;
      if (free < 3 * 1024 ** 3) throw new Error(`${Go(free)} libres : il en faut au moins 3.`);
      return { detail: `${Go(free)} libres` };
    }),
    check('Mémoire', async () => {
      const detail = `${Go(systemRamMb * 1024 ** 2)} au total, ${Go(settings.maxRamMb * 1024 ** 2)} pour le jeu`;
      return systemRamMb < RAM_ALERTE_MB
        ? { status: 'warn', detail: `${detail}. Moins de 8 Go : le modpack risque de ramer.` }
        : { detail };
    }),
    check('Java', async () => {
      const installed = fs.existsSync(paths.runtime) && fs.readdirSync(paths.runtime).length > 0;
      return { detail: installed ? 'Installé' : 'Sera téléchargé au premier lancement' };
    }),
  ]);
}

module.exports = { run };
