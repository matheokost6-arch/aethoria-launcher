'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');

// GitHub renvoie parfois une erreur passagere (500, 503) sur un fichier :
// sans insistance, toute l'installation du joueur echouerait pour si peu.
// 6 essais, jusqu'a 12 secondes d'attente au total.
const MAX_RETRIES = 6;
const DEFAULT_CONCURRENCY = 12;
const MAX_REDIRECTS = 5;

// Seuls ces serveurs ont le droit de fournir un fichier au launcher, y compris
// apres une redirection. GitHub renvoie les telechargements vers ses propres
// serveurs de fichiers : ils sont donc listes aussi. Tout le reste est refuse,
// meme si le manifest ou une reponse reseau le demande.
const HOTES_AUTORISES = new Set([
  'github.com',
  'raw.githubusercontent.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'github-releases.githubusercontent.com',
  'cdn.modrinth.com',
  'api.modrinth.com',
  'launchermeta.mojang.com',
  'launcher.mojang.com',
  'piston-meta.mojang.com',
  'piston-data.mojang.com',
  'resources.download.minecraft.net',
  'libraries.minecraft.net',
  'api.mojang.com',
  'sessionserver.mojang.com',
  'textures.minecraft.net',
  'maven.minecraftforge.net',
  'files.minecraftforge.net',
]);

/** Refuse tout ce qui n'est pas en https ou ne vient pas d'un serveur de la liste. */
function verifierUrl(url) {
  let adresse;
  try {
    adresse = new URL(url);
  } catch {
    throw new Error('Adresse de téléchargement invalide.');
  }
  if (adresse.protocol !== 'https:' || adresse.username || adresse.password) {
    throw new Error(`Téléchargement refusé (adresse non sécurisée) : ${adresse.host}`);
  }
  if (!HOTES_AUTORISES.has(adresse.hostname.toLowerCase())) {
    throw new Error(`Téléchargement refusé (serveur non autorisé) : ${adresse.hostname}`);
  }
  return adresse;
}

/**
 * fetch qui suit lui-meme les redirections : chaque etape doit etre en https et
 * rester chez un serveur autorise, sinon un lien detourne pourrait envoyer le
 * launcher chercher un fichier n'importe ou.
 */
async function secureFetch(url, init = {}) {
  let courante = verifierUrl(url).href;
  for (let saut = 0; saut <= MAX_REDIRECTS; saut += 1) {
    const res = await fetch(courante, { ...init, redirect: 'manual' });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      res.body?.cancel().catch(() => {});
      courante = verifierUrl(new URL(res.headers.get('location'), courante)).href;
      continue;
    }
    return res;
  }
  throw new Error('Trop de redirections.');
}

// Vitesse choisie par le joueur : fraction du parallelisme prevu par chaque
// appel. "Econome" laisse de la bande passante au reste de la maison.
const SPEED_FACTORS = { fast: 1, normal: 0.5, eco: 0.2 };
let speedFactor = 1;

function setSpeed(level) {
  speedFactor = SPEED_FACTORS[level] ?? 1;
}

/** Empreinte d'un fichier (sha1 ou sha256), ou null s'il n'existe pas. */
async function empreinte(file, algorithme) {
  try {
    const hash = crypto.createHash(algorithme);
    await pipeline(fs.createReadStream(file), hash);
    return hash.digest('hex');
  } catch {
    return null;
  }
}

const sha1 = (file) => empreinte(file, 'sha1');
const sha256 = (file) => empreinte(file, 'sha256');

/**
 * Compare le fichier a l'empreinte attendue. Si le manifest donne un sha256, il
 * est exige en plus du sha1 : les deux doivent correspondre.
 */
async function correspond(file, { sha1: attendu1, sha256: attendu256 }) {
  if (attendu1 && (await sha1(file)) !== String(attendu1).toLowerCase()) return false;
  if (attendu256 && (await sha256(file)) !== String(attendu256).toLowerCase()) return false;
  return true;
}

/**
 * Un fichier est considere valide si son SHA1 correspond. Quand le manifest ne
 * fournit pas de hash (cas de certains artefacts Forge) on se rabat sur la
 * taille, et a defaut sur la simple existence du fichier.
 */
async function isValid(file, { sha1: expected, sha256: expected256, size } = {}) {
  let stat;
  try {
    stat = await fsp.stat(file);
  } catch {
    return false;
  }
  if (!stat.isFile() || stat.size === 0) return false;
  if (expected || expected256) return correspond(file, { sha1: expected, sha256: expected256 });
  if (size) return stat.size === size;
  return true;
}

async function fetchWithRetry(url, init = {}, retries = MAX_RETRIES) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const res = await secureFetch(url, init);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} sur ${url}`);
      return res;
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        // Backoff exponentiel : 400ms, 800ms, 1600ms...
        await new Promise((r) => setTimeout(r, Math.min(400 * 2 ** (attempt - 1), 4000)));
      }
    }
  }
  throw lastError;
}

async function getJson(url, init) {
  const res = await fetchWithRetry(url, init);
  return res.json();
}

/**
 * Telecharge un fichier unique. Ecrit d'abord dans un .part puis renomme :
 * un telechargement interrompu ne laisse jamais un fichier valide en apparence
 * mais tronque, qui ferait planter le jeu de facon incomprehensible.
 */
async function downloadFile(url, dest, expect = {}, onChunk) {
  if (await isValid(dest, expect)) return { skipped: true, dest };

  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const part = `${dest}.part`;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const res = await secureFetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} sur ${url}`);

      const out = fs.createWriteStream(part);
      const source = Readable.fromWeb(res.body);
      if (onChunk) source.on('data', (chunk) => onChunk(chunk.length));
      await pipeline(source, out);

      // Le fichier n'est utilise qu'une fois son empreinte verifiee.
      if ((expect.sha1 || expect.sha256) && !(await correspond(part, expect))) {
        throw new Error(`Empreinte incorrecte pour ${path.basename(dest)} : fichier refusé`);
      }
      await fsp.rename(part, dest);
      return { skipped: false, dest };
    } catch (err) {
      await fsp.rm(part, { force: true }).catch(() => {});
      if (attempt === MAX_RETRIES) throw err;
      await new Promise((r) => setTimeout(r, 400 * 2 ** (attempt - 1)));
    }
  }
  throw new Error(`Téléchargement impossible : ${url}`);
}

/**
 * Telecharge une liste de fichiers en parallele borne, en rapportant
 * l'avancement en octets (pour une barre de progression fluide meme quand un
 * seul gros fichier est en cours).
 */
async function downloadAll(tasks, { concurrency: requested = DEFAULT_CONCURRENCY, onProgress } = {}) {
  const concurrency = Math.max(1, Math.round(requested * speedFactor));
  const pending = tasks.slice();
  const total = tasks.length;
  const totalBytes = tasks.reduce((sum, t) => sum + (t.size || 0), 0);
  let done = 0;
  let bytes = 0;
  const errors = [];

  // Debit mesure sur une fenetre glissante : une moyenne depuis le debut
  // resterait bloquee sur les premieres secondes, quand rien n'est encore
  // etabli, et l'estimation ne bougerait plus.
  const FENETRE_MS = 4000;
  const echantillons = [{ at: Date.now(), bytes: 0 }];
  let dernierRapport = 0;

  const debit = () => {
    const maintenant = Date.now();
    while (echantillons.length > 1 && maintenant - echantillons[0].at > FENETRE_MS) {
      echantillons.shift();
    }
    const premier = echantillons[0];
    const duree = (maintenant - premier.at) / 1000;
    if (duree < 0.4) return 0;
    return Math.max(0, (bytes - premier.bytes) / duree);
  };

  const report = (currentName, forcer = false) => {
    if (!onProgress) return;
    const maintenant = Date.now();
    // On limite a environ 8 rapports par seconde : au-dela, l'interface passe
    // son temps a se redessiner pour rien.
    if (!forcer && maintenant - dernierRapport < 120) return;
    dernierRapport = maintenant;

    echantillons.push({ at: maintenant, bytes });
    const vitesse = debit();
    const restant = Math.max(0, totalBytes - bytes);

    onProgress({
      done,
      total,
      bytes,
      totalBytes,
      current: currentName,
      bytesPerSecond: vitesse,
      // Sans debit mesurable, mieux vaut ne rien annoncer qu'un chiffre faux.
      etaSeconds: vitesse > 0 && totalBytes > 0 ? Math.round(restant / vitesse) : null,
      percent: totalBytes > 0
        ? Math.min(100, (bytes / totalBytes) * 100)
        : (total ? (done / total) * 100 : 100),
    });
  };

  async function worker() {
    while (pending.length) {
      const task = pending.shift();
      let counted = 0;
      try {
        const result = await downloadFile(task.url, task.dest, { sha1: task.sha1, sha256: task.sha256, size: task.size }, (n) => {
          counted += n;
          bytes += n;
          report(task.name);
        });
        // Un fichier deja present ne passe pas par onChunk : on comptabilise sa
        // taille ici, sinon la barre n'atteindrait jamais 100% sur une
        // reinstallation ou tout est deja en cache.
        if (result.skipped && task.size) {
          counted = task.size;
          bytes += task.size;
        }
      } catch (err) {
        bytes -= counted; // echec : on retire les octets deja comptes
        errors.push({ task, err });
      } finally {
        done += 1;
        report(task.name, true);
      }
    }
  }

  report(null, true);
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, total)) }, worker));

  if (errors.length) {
    const detail = errors.slice(0, 3).map((e) => `${e.task.name || e.task.url} (${e.err.message})`).join(' ; ');
    throw new Error(`${errors.length} fichier(s) n'ont pas pu être téléchargés : ${detail}`);
  }
  return { done, total };
}

module.exports = {
  sha1, sha256, isValid, downloadFile, downloadAll, getJson, setSpeed, secureFetch, verifierUrl,
};
