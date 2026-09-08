'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');

const MAX_RETRIES = 3;
const DEFAULT_CONCURRENCY = 12;

/** SHA1 d'un fichier, ou null s'il n'existe pas. */
async function sha1(file) {
  try {
    const hash = crypto.createHash('sha1');
    await pipeline(fs.createReadStream(file), hash);
    return hash.digest('hex');
  } catch {
    return null;
  }
}

/**
 * Un fichier est considere valide si son SHA1 correspond. Quand le manifest ne
 * fournit pas de hash (cas de certains artefacts Forge) on se rabat sur la
 * taille, et a defaut sur la simple existence du fichier.
 */
async function isValid(file, { sha1: expected, size } = {}) {
  let stat;
  try {
    stat = await fsp.stat(file);
  } catch {
    return false;
  }
  if (!stat.isFile() || stat.size === 0) return false;
  if (expected) return (await sha1(file)) === expected.toLowerCase();
  if (size) return stat.size === size;
  return true;
}

async function fetchWithRetry(url, init = {}, retries = MAX_RETRIES) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const res = await fetch(url, init);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} sur ${url}`);
      return res;
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        // Backoff exponentiel : 400ms, 800ms, 1600ms...
        await new Promise((r) => setTimeout(r, 400 * 2 ** (attempt - 1)));
      }
    }
  }
  throw lastError;
}

async function getJson(url, init) {
  const res = await fetchWithRetry(url, init);
  return res.json();
}

async function getText(url, init) {
  const res = await fetchWithRetry(url, init);
  return res.text();
}

async function getBuffer(url, init) {
  const res = await fetchWithRetry(url, init);
  return Buffer.from(await res.arrayBuffer());
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
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} sur ${url}`);

      const out = fs.createWriteStream(part);
      const source = Readable.fromWeb(res.body);
      if (onChunk) source.on('data', (chunk) => onChunk(chunk.length));
      await pipeline(source, out);

      if (expect.sha1) {
        const actual = await sha1(part);
        if (actual !== expect.sha1.toLowerCase()) {
          throw new Error(`Empreinte SHA1 incorrecte pour ${path.basename(dest)}`);
        }
      }
      await fsp.rename(part, dest);
      return { skipped: false, dest };
    } catch (err) {
      await fsp.rm(part, { force: true }).catch(() => {});
      if (attempt === MAX_RETRIES) throw err;
      await new Promise((r) => setTimeout(r, 400 * 2 ** (attempt - 1)));
    }
  }
  throw new Error(`Telechargement impossible : ${url}`);
}

/**
 * Telecharge une liste de fichiers en parallele borne, en rapportant
 * l'avancement en octets (pour une barre de progression fluide meme quand un
 * seul gros fichier est en cours).
 */
async function downloadAll(tasks, { concurrency = DEFAULT_CONCURRENCY, onProgress } = {}) {
  const pending = tasks.slice();
  const total = tasks.length;
  const totalBytes = tasks.reduce((sum, t) => sum + (t.size || 0), 0);
  let done = 0;
  let bytes = 0;
  const errors = [];

  const report = (currentName) => {
    if (!onProgress) return;
    onProgress({
      done,
      total,
      bytes,
      totalBytes,
      current: currentName,
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
        const result = await downloadFile(task.url, task.dest, { sha1: task.sha1, size: task.size }, (n) => {
          counted += n;
          bytes += n;
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
        report(task.name);
      }
    }
  }

  report(null);
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, total)) }, worker));

  if (errors.length) {
    const detail = errors.slice(0, 3).map((e) => `${e.task.name || e.task.url} (${e.err.message})`).join(' ; ');
    throw new Error(`${errors.length} fichier(s) n'ont pas pu etre telecharges : ${detail}`);
  }
  return { done, total };
}

module.exports = { sha1, isValid, downloadFile, downloadAll, getJson, getText, getBuffer, fetchWithRetry };
