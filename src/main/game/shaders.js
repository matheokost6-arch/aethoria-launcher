'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const paths = require('./paths');
const { downloadFile, getJson } = require('./downloader');

/**
 * Shaders pour Oculus, inclus dans le modpack. Les packs sont telecharges
 * directement depuis Modrinth, dans leur version d'origine : rien n'est
 * rediffuse par le serveur.
 */

const API = 'https://api.modrinth.com/v2';
const MC_VERSION = '1.20.1';
const HEADERS = { 'User-Agent': 'aethoria-launcher (github.com/aethoria-mc/aethoria)' };
const CACHE_MS = 60 * 60 * 1000;

// Du plus leger au plus gourmand.
const CATALOG = [
  { slug: 'makeup-ultra-fast-shaders', name: 'MakeUp Ultra Fast', weight: 'Léger', description: 'Lumières et ombres soignées, même sur un PC modeste.' },
  { slug: 'complementary-reimagined', name: 'Complementary Reimagined', weight: 'Équilibré', description: 'Fidèle au style de Minecraft, en bien plus beau. Le choix sûr.' },
  { slug: 'sildurs-vibrant-shaders', name: 'Sildur’s Vibrant', weight: 'Équilibré', description: 'Couleurs vives et ciels spectaculaires.' },
  { slug: 'bsl-shaders', name: 'BSL', weight: 'Gourmand', description: 'Eau, reflets et brume dignes d’un film.' },
  { slug: 'complementary-unbound', name: 'Complementary Unbound', weight: 'Gourmand', description: 'La version la plus spectaculaire de Complementary.' },
];

let cache = null;

const shaderDir = () => path.join(paths.root, 'shaderpacks');
const oculusConfig = () => path.join(paths.root, 'config', 'oculus.properties');

/** Proprietes d'Oculus, lignes inconnues conservees telles quelles. */
async function readOculus() {
  const content = await fsp.readFile(oculusConfig(), 'utf8').catch(() => '');
  const props = new Map();
  for (const line of content.split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator > 0 && !line.startsWith('#')) props.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  return props;
}

async function writeOculus(changes) {
  const props = await readOculus();
  for (const [key, value] of Object.entries(changes)) props.set(key, value);
  await fsp.mkdir(path.dirname(oculusConfig()), { recursive: true });
  await fsp.writeFile(oculusConfig(), `${[...props].map(([key, value]) => `${key}=${value}`).join('\n')}\n`, 'utf8');
}

/** Derniere version compatible de chaque shader, gardee une heure en memoire. */
async function catalog() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.items;
  const query = `loaders=${encodeURIComponent('["iris"]')}&game_versions=${encodeURIComponent(`["${MC_VERSION}"]`)}`;

  const items = await Promise.all(CATALOG.map(async (entry) => {
    try {
      const [version] = await getJson(`${API}/project/${entry.slug}/version?${query}`, { headers: HEADERS });
      const file = version && (version.files.find((f) => f.primary) || version.files[0]);
      // Seul le CDN de Modrinth est accepte comme source de telechargement.
      if (!file || new URL(file.url).hostname !== 'cdn.modrinth.com') return null;
      return {
        ...entry,
        version: version.version_number,
        filename: path.basename(file.filename),
        url: file.url,
        sha1: file.hashes.sha1,
        size: file.size,
      };
    } catch {
      return null;
    }
  }));

  const available = items.filter(Boolean);
  if (available.length) cache = { at: Date.now(), items: available };
  return available;
}

async function find(slug) {
  const item = (await catalog()).find((entry) => entry.slug === slug);
  if (!item) throw new Error('Shader indisponible. Vérifie ta connexion internet.');
  return item;
}

async function list() {
  const [items, props] = await Promise.all([catalog(), readOculus()]);
  const active = props.get('enableShaders') === 'true' ? props.get('shaderPack') : null;
  return items.map(({ url, sha1, filename, ...item }) => ({
    ...item,
    installed: fs.existsSync(path.join(shaderDir(), filename)),
    active: filename === active,
  }));
}

async function install(slug) {
  const item = await find(slug);
  await fsp.mkdir(shaderDir(), { recursive: true });
  // Empreinte SHA1 verifiee : un fichier altere en route est refuse.
  await downloadFile(item.url, path.join(shaderDir(), item.filename), { sha1: item.sha1, size: item.size });
}

/** Active un shader (installe au besoin), ou les desactive tous avec null. */
async function activate(slug) {
  if (!slug) {
    await writeOculus({ enableShaders: 'false' });
    return;
  }
  const item = await find(slug);
  if (!fs.existsSync(path.join(shaderDir(), item.filename))) await install(slug);
  await writeOculus({ shaderPack: item.filename, enableShaders: 'true' });
}

async function remove(slug) {
  const item = await find(slug);
  const props = await readOculus();
  if (props.get('shaderPack') === item.filename) await writeOculus({ enableShaders: 'false' });
  await fsp.rm(path.join(shaderDir(), item.filename), { force: true });
}

module.exports = { list, install, activate, remove };
