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
// Un serveur qui ne repond plus ne doit pas figer le launcher : on abandonne
// (puis on reessaie) au bout de ces delais.
const TIMEOUT_REPONSE_MS = 60 * 1000;   // requete courte (JSON, petit fichier)
const TIMEOUT_SANS_DONNEES_MS = 45 * 1000; // telechargement : rien recu depuis ce temps
// Au-dela, c'est la connexion qui est en panne, pas un fichier : inutile de
// continuer a essayer des milliers de fichiers un par un.
const MAX_ECHECS_AVANT_ABANDON = 15;

const attendre = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Traduit une erreur technique (reseau, disque, serveur) en phrase courte qui
 * dit au joueur quoi faire. Le detail technique reste disponible a part.
 */
function expliquerErreur(err) {
  const texte = String(err?.message || err || '');
  const code = String(err?.code || err?.cause?.code || '');
  if (/HTTP (429|403)|rate limit/i.test(texte)) {
    return 'Le serveur de téléchargement est surchargé. Attends 5 minutes, puis réessaie.';
  }
  if (/HTTP 404/i.test(texte)) {
    return 'Un fichier est introuvable sur le serveur. Préviens l’équipe d’Aethoria sur Discord.';
  }
  if (/HTTP 5\d\d/i.test(texte)) {
    return 'Le serveur de téléchargement a un souci. Réessaie dans quelques minutes.';
  }
  if (/Empreinte incorrecte/i.test(texte)) {
    return 'Un fichier téléchargé est abîmé. Ton antivirus ou ton pare-feu le modifie peut-être. Réessaie, ou autorise le dossier du jeu dans ton antivirus.';
  }
  if (code === 'ENOSPC' || /no space left/i.test(texte)) {
    return 'Ton disque est plein. Libère de la place, puis réessaie.';
  }
  if (['EPERM', 'EACCES', 'EBUSY', 'EROFS'].includes(code)) {
    return 'Impossible d’écrire dans le dossier du jeu. Ton antivirus bloque peut-être le launcher : autorise le dossier du jeu, ou choisis un autre dossier dans les réglages.';
  }
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError' || /timeout|aborted|délai/i.test(texte)
    || ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(code)) {
    return 'La connexion est trop lente ou coupée. Vérifie ta connexion Internet, puis réessaie.';
  }
  if (['ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_SOCKET'].includes(code)
    || /fetch failed|network|socket/i.test(texte)) {
    return 'Impossible de joindre Internet. Vérifie ta connexion (ou ton pare-feu / VPN), puis réessaie.';
  }
  return null;
}

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
    // Sans delai, un serveur qui ne repond pas bloquerait le launcher a jamais.
    // Si l'appelant fournit son propre signal, c'est lui qui decide du delai.
    const res = await fetch(courante, {
      ...init,
      signal: init.signal || AbortSignal.timeout(TIMEOUT_REPONSE_MS),
      redirect: 'manual',
    });
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

/** Erreur HTTP qui garde son code et le delai demande par le serveur. */
function erreurHttp(res, url) {
  const err = new Error(`HTTP ${res.status} ${res.statusText || ''} sur ${url}`.replace(/\s+/g, ' '));
  err.status = res.status;
  const retryAfter = Number(res.headers?.get('retry-after'));
  err.retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 60) * 1000 : 0;
  return err;
}

/**
 * Attente avant un nouvel essai. Un serveur qui limite le debit (429, 403,
 * 503) a besoin de plus de temps qu'une simple coupure reseau.
 */
function delaiAvantEssai(attempt, err) {
  const simple = Math.min(400 * 2 ** (attempt - 1), 6400);
  if ([403, 429, 503].includes(err?.status)) {
    return Math.min(Math.max(err.retryAfterMs || 0, 2000 * attempt), 30000);
  }
  return simple;
}

/** Inutile de reessayer : le fichier n'existe pas. */
const definitif = (err) => err?.status === 404 || err?.status === 410;

async function fetchWithRetry(url, init = {}, retries = MAX_RETRIES) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const res = await secureFetch(url, init);
      if (!res.ok) {
        res.body?.cancel().catch(() => {});
        throw erreurHttp(res, url);
      }
      return res;
    } catch (err) {
      lastError = err;
      if (definitif(err)) break;
      if (attempt < retries) await attendre(delaiAvantEssai(attempt, err));
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
    // Surveillance : si plus rien n'arrive pendant 45 s (connexion gelee, serveur
    // muet), on coupe et on reessaie au lieu de rester bloque indefiniment.
    const controle = new AbortController();
    let minuterie = setTimeout(() => controle.abort(), TIMEOUT_SANS_DONNEES_MS);
    const vivant = () => {
      clearTimeout(minuterie);
      minuterie = setTimeout(() => controle.abort(), TIMEOUT_SANS_DONNEES_MS);
    };
    let compte = 0;
    try {
      const res = await secureFetch(url, { signal: controle.signal });
      if (!res.ok) {
        res.body?.cancel().catch(() => {});
        throw erreurHttp(res, url);
      }

      const out = fs.createWriteStream(part);
      const source = Readable.fromWeb(res.body);
      source.on('data', (chunk) => {
        vivant();
        compte += chunk.length;
        if (onChunk) onChunk(chunk.length);
      });
      await pipeline(source, out);

      // Le fichier n'est utilise qu'une fois son empreinte verifiee.
      if ((expect.sha1 || expect.sha256) && !(await correspond(part, expect))) {
        throw new Error(`Empreinte incorrecte pour ${path.basename(dest)} : fichier refusé`);
      }
      await renommerAvecInsistance(part, dest);
      clearTimeout(minuterie);
      return { skipped: false, dest };
    } catch (err) {
      clearTimeout(minuterie);
      await fsp.rm(part, { force: true }).catch(() => {});
      // Les octets d'un essai rate ne comptent pas : la barre ne doit pas depasser 100 %.
      if (compte && onChunk) onChunk(-compte);
      if (attempt === MAX_RETRIES || definitif(err)) throw err;
      await attendre(delaiAvantEssai(attempt, err));
    }
  }
  throw new Error(`Téléchargement impossible : ${url}`);
}

/**
 * Renommer le .part peut echouer un instant sous Windows (EPERM, EBUSY) : un
 * antivirus analyse le fichier qui vient d'etre ecrit. Quelques essais rapprochent
 * suffisent presque toujours.
 */
async function renommerAvecInsistance(de, vers) {
  for (let essai = 1; ; essai += 1) {
    try {
      await fsp.rename(de, vers);
      return;
    } catch (err) {
      if (essai >= 6 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
      await attendre(300 * essai);
    }
  }
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

  /**
   * Un passage sur une liste de fichiers. Un fichier qui echoue n'est compte
   * comme termine qu'au dernier passage ("final"), pour ne pas fausser l'avancement.
   */
  async function passage(liste, nombre, final) {
    const file = liste.slice();
    const echecs = [];
    async function worker() {
      while (file.length) {
        const task = file.shift();
        let counted = 0;
        let reussi = false;
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
          reussi = true;
        } catch (err) {
          bytes -= counted; // echec : on retire les octets deja comptes
          echecs.push({ task, err });
          // Beaucoup d'echecs de suite : la connexion est en panne, on arrete
          // tout de suite plutot que d'essayer des milliers de fichiers.
          if (echecs.length >= MAX_ECHECS_AVANT_ABANDON) file.length = 0;
        } finally {
          if (reussi || final) done += 1;
          report(task.name, true);
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(nombre, Math.max(1, liste.length)) }, worker));
    return echecs;
  }

  report(null, true);
  let errors = await passage(tasks, concurrency, false);

  // Deuxieme chance : une saturation passagere du serveur (limitation de debit)
  // se calme en quelques secondes. On reprend doucement les fichiers rates.
  if (errors.length && errors.length < MAX_ECHECS_AVANT_ABANDON) {
    await attendre(4000);
    errors = await passage(errors.map((e) => e.task), Math.min(3, concurrency), true);
  } else if (errors.length) {
    done += errors.length; // abandon : ces fichiers ne seront plus tentes
  }

  if (errors.length) {
    const detail = errors.slice(0, 3).map((e) => `${e.task.name || e.task.url} (${e.err.message})`).join(' ; ');
    const conseil = expliquerErreur(errors[0].err);
    throw new Error(`${conseil || `${errors.length} fichier(s) n'ont pas pu être téléchargés.`} [${errors.length} fichier(s) en échec : ${detail}]`);
  }
  return { done, total };
}

module.exports = {
  sha1, sha256, isValid, downloadFile, downloadAll, getJson, setSpeed, secureFetch, verifierUrl,
  fetchWithRetry, expliquerErreur,
};
