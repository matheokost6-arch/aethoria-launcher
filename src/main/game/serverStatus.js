'use strict';

const net = require('net');

/**
 * Interroge le serveur avec le "Server List Ping", le meme protocole que la
 * liste des serveurs du jeu : on annonce une poignee de main en etat "status",
 * puis on lit la reponse JSON (version, joueurs connectes, MOTD).
 *
 * Le launcher s'en sert uniquement pour l'affichage : un serveur injoignable ne
 * doit jamais empecher de lancer le jeu.
 */

const PROTOCOL_VERSION = 763; // 1.20.1 — sert seulement a formuler la requete
const TIMEOUT_MS = 6000;

/** Encode un entier au format VarInt attendu par le protocole Minecraft. */
function varInt(value) {
  const bytes = [];
  let rest = value;
  do {
    let byte = rest & 0x7f;
    rest >>>= 7;
    if (rest !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (rest !== 0);
  return Buffer.from(bytes);
}

function varString(text) {
  const body = Buffer.from(text, 'utf8');
  return Buffer.concat([varInt(body.length), body]);
}

/** Prefixe un paquet de sa longueur et de son identifiant. */
function packet(id, payload) {
  const body = Buffer.concat([varInt(id), payload]);
  return Buffer.concat([varInt(body.length), body]);
}

/** Retire les codes couleur Minecraft (§a, §l...) d'un texte. */
function stripFormatting(text) {
  return String(text).replace(/§./g, '');
}

/** Le MOTD peut etre une chaine, un objet, ou un arbre de composants. */
function extractMotd(description) {
  if (!description) return '';
  if (typeof description === 'string') return stripFormatting(description);
  const parts = [description.text || ''];
  for (const extra of description.extra || []) {
    parts.push(typeof extra === 'string' ? extra : extractMotd(extra));
  }
  return stripFormatting(parts.join('')).trim();
}

/**
 * Echantillon des joueurs connectes (le serveur en envoie une douzaine au
 * plus). Certains plugins y glissent des lignes de texte decoratives : seuls
 * les vrais pseudos et UUID sont conserves.
 */
function playerSample(sample) {
  return (Array.isArray(sample) ? sample : [])
    .filter((p) => /^[A-Za-z0-9_]{1,16}$/.test(p?.name) && /^[0-9a-f-]{32,36}$/i.test(p?.id))
    .map((p) => ({ name: p.name, id: p.id }));
}

/**
 * Renvoie l'etat du serveur, ou { online: false } s'il ne repond pas.
 * Cette fonction ne rejette jamais : l'appelant affiche simplement "hors ligne".
 */
function ping(host, port = 25565) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    const socket = net.createConnection({ host, port, timeout: TIMEOUT_MS });

    socket.on('connect', () => {
      const portBuffer = Buffer.alloc(2);
      portBuffer.writeUInt16BE(port);
      // Handshake : version du protocole, adresse, port, etat demande (1 = status)
      socket.write(packet(0x00, Buffer.concat([
        varInt(PROTOCOL_VERSION),
        varString(host),
        portBuffer,
        varInt(1),
      ])));
      socket.write(packet(0x00, Buffer.alloc(0))); // demande de status
      sentAt = Date.now();
    });
    let sentAt = Date.now();

    let buffer = Buffer.alloc(0);
    let latency = null;
    socket.on('data', (chunk) => {
      // Temps entre la demande et le premier octet de reponse : c'est ce que
      // le joueur ressentira comme latence en jeu.
      if (latency === null) latency = Date.now() - sentAt;
      buffer = Buffer.concat([buffer, chunk]);
      const start = buffer.indexOf(0x7b); // '{' : debut du JSON
      if (start < 0) return;
      try {
        // La reponse arrive en plusieurs morceaux : tant que le JSON est
        // incomplet, l'analyse echoue et on attend la suite.
        const data = JSON.parse(buffer.slice(start).toString('utf8'));
        done({
          online: true,
          version: data.version?.name || null,
          protocol: data.version?.protocol || null,
          players: {
            online: data.players?.online ?? 0,
            max: data.players?.max ?? 0,
            sample: playerSample(data.players?.sample),
          },
          latency,
          motd: extractMotd(data.description),
        });
      } catch {
        // JSON encore tronque
      }
    });

    socket.on('timeout', () => done({ online: false, reason: 'timeout' }));
    socket.on('error', (err) => done({ online: false, reason: err.code || err.message }));
    socket.on('close', () => done({ online: false, reason: 'closed' }));
  });
}

module.exports = { ping };
