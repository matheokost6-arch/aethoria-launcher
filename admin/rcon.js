'use strict';

const net = require('net');

/**
 * Client RCON : la console a distance integree a Minecraft.
 *
 * Paquet : longueur (int32 LE, sans compter ce champ), identifiant (int32 LE),
 * type (int32 LE), texte, puis deux octets nuls. Les commandes passent une par
 * une : la reponse est reconnue a son identifiant.
 *
 * Attention : RCON n'est pas chiffre. Le mot de passe et les commandes
 * circulent en clair entre ce PC et le serveur.
 */

const TYPE_AUTH = 3;
const TYPE_COMMAND = 2;
const TIMEOUT_MS = 8000;
// Une longue reponse arrive en plusieurs paquets : on attend ce silence avant
// de la considerer complete.
const END_OF_RESPONSE_MS = 180;
const MAX_PACKET = 4096 + 10; // taille maximale d'un paquet de reponse RCON

function encode(id, type, body) {
  const payload = Buffer.from(body, 'utf8');
  const packet = Buffer.alloc(14 + payload.length);
  packet.writeInt32LE(10 + payload.length, 0);
  packet.writeInt32LE(id, 4);
  packet.writeInt32LE(type, 8);
  payload.copy(packet, 12);
  return packet;
}

/** Retire les codes couleur Minecraft (§a, §l...). */
const stripColors = (text) => text.replace(/§./g, '');

class Rcon {
  constructor({ host, port, password }) {
    this.host = host;
    this.port = port;
    this.password = password;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.nextId = 10;
    this.pending = null;   // commande en attente de reponse
    this.queue = Promise.resolve();
  }

  get connected() {
    return Boolean(this.socket && !this.socket.destroyed);
  }

  connect() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (message) => {
        if (settled) return;
        settled = true;
        this.close();
        reject(new Error(message));
      };

      const socket = net.createConnection({ host: this.host, port: this.port });
      this.socket = socket;
      socket.setTimeout(TIMEOUT_MS);
      socket.on('timeout', () => fail('Le serveur ne répond pas (délai dépassé). Vérifie l’adresse et le port RCON.'));
      socket.on('error', (err) => fail(err.code === 'ECONNREFUSED'
        ? 'Connexion refusée : RCON n’est pas activé, ou le port est fermé chez l’hébergeur.'
        : `Connexion impossible : ${err.message}`));
      socket.on('close', () => {
        this.pending?.reject(new Error('Connexion au serveur perdue.'));
        this.pending = null;
        if (!settled) fail('Connexion fermée par le serveur.');
      });
      socket.on('data', (chunk) => this.receive(chunk));

      socket.on('connect', () => {
        this.onAuth = (id) => {
          this.onAuth = null;
          if (id === -1) {
            fail('Mot de passe RCON incorrect.');
            return;
          }
          settled = true;
          socket.setTimeout(0);
          resolve();
        };
        socket.write(encode(1, TYPE_AUTH, this.password));
      });
    });
  }

  receive(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readInt32LE(0);
      // Paquet impossible : reponse corrompue ou serveur hostile, on coupe.
      if (length < 10 || length > MAX_PACKET) {
        this.buffer = Buffer.alloc(0);
        this.socket?.destroy(new Error('Réponse RCON invalide.'));
        return;
      }
      if (this.buffer.length < length + 4) return;
      const id = this.buffer.readInt32LE(4);
      const type = this.buffer.readInt32LE(8);
      const body = this.buffer.toString('utf8', 12, 4 + length - 2);
      this.buffer = this.buffer.subarray(4 + length);

      if (this.onAuth && type === TYPE_COMMAND) {
        this.onAuth(id);
      } else if (this.pending && id === this.pending.id) {
        const current = this.pending;
        current.parts.push(body);
        clearTimeout(current.idle);
        // Lie a cette commande : jamais la suivante, si celle-ci a expire entre-temps.
        current.idle = setTimeout(() => { if (this.pending === current) current.finish(); }, END_OF_RESPONSE_MS);
      }
    }
  }

  /** Execute une commande (sans "/") et renvoie la reponse, codes couleur retires. */
  command(text) {
    const run = () => new Promise((resolve, reject) => {
      if (!this.connected) {
        reject(new Error('Non connecté au serveur.'));
        return;
      }
      const id = this.nextId;
      this.nextId += 1;
      const timeout = setTimeout(() => {
        clearTimeout(this.pending?.idle);
        this.pending = null;
        reject(new Error('Le serveur n’a pas répondu à la commande.'));
      }, TIMEOUT_MS);

      this.pending = {
        id,
        parts: [],
        idle: null,
        finish: () => {
          clearTimeout(timeout);
          const output = stripColors(this.pending.parts.join('')).trim();
          this.pending = null;
          resolve(output);
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
      };
      this.socket.write(encode(id, TYPE_COMMAND, text));
    });

    // Une commande a la fois : les reponses ne peuvent pas se melanger.
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    return result;
  }

  close() {
    if (this.socket && !this.socket.destroyed) this.socket.destroy();
    this.socket = null;
  }
}

module.exports = { Rcon, encode, stripColors };
