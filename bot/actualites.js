'use strict';

/**
 * Publication des actualites du launcher Aethoria, depuis le bot Discord.
 *
 * A copier dans ton bot. Aucune dependance : tout passe par fetch, disponible
 * nativement a partir de Node 18.
 *
 * Le principe : le manifest du launcher vit dans le depot public, et le
 * launcher le relit a chaque demarrage. Ecrire une annonce revient donc a
 * modifier la section "news" de ce fichier — ce que ce module fait via l'API
 * GitHub, sans avoir a cloner quoi que ce soit.
 *
 * Configuration (variables d'environnement du bot) :
 *   GITHUB_TOKEN   jeton avec le droit d'ecrire dans le depot public
 *   GITHUB_OWNER   defaut : matheokost6-arch
 *   GITHUB_REPO    defaut : aethoria
 *
 * Le jeton doit etre un "fine-grained token" limite au seul depot public,
 * avec la permission "Contents: Read and write". Il reste chez le bot et
 * n'est jamais livre dans le launcher.
 */

const API = 'https://api.github.com';

const OWNER = process.env.GITHUB_OWNER || 'matheokost6-arch';
const REPO = process.env.GITHUB_REPO || 'aethoria';
const CHEMIN = 'manifest.json';

// Au-dela, le panneau du launcher devient une liste interminable que plus
// personne ne lit. Les annonces les plus recentes chassent les plus anciennes.
const MAX_ACTUALITES = 6;

const MOIS = ['janvier', 'fevrier', 'mars', 'avril', 'mai', 'juin',
  'juillet', 'aout', 'septembre', 'octobre', 'novembre', 'decembre'];

/* ------------------------------------------------------------------ *
 *  Acces au manifest
 * ------------------------------------------------------------------ */

function entetes() {
  const jeton = process.env.GITHUB_TOKEN;
  if (!jeton) {
    throw new Error('GITHUB_TOKEN absent : le bot ne peut pas ecrire dans le depot.');
  }
  return {
    Authorization: `Bearer ${jeton}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'AethoriaBot',
  };
}

/**
 * Recupere le manifest et l'empreinte de sa version actuelle.
 * Cette empreinte est indispensable pour ecrire : GitHub refuse la
 * modification si le fichier a change entre-temps, ce qui evite qu'une
 * publication simultanee en ecrase une autre.
 */
async function lireManifest() {
  const reponse = await fetch(`${API}/repos/${OWNER}/${REPO}/contents/${CHEMIN}`, {
    headers: entetes(),
  });

  if (reponse.status === 401 || reponse.status === 403) {
    throw new Error('Jeton GitHub refuse. Verifie GITHUB_TOKEN et ses permissions.');
  }
  if (reponse.status === 404) {
    throw new Error(`manifest.json introuvable dans ${OWNER}/${REPO}.`);
  }
  if (!reponse.ok) {
    throw new Error(`GitHub a repondu HTTP ${reponse.status}`);
  }

  const donnees = await reponse.json();
  return {
    manifest: JSON.parse(Buffer.from(donnees.content, 'base64').toString('utf8')),
    sha: donnees.sha,
  };
}

async function ecrireManifest(manifest, sha, message) {
  const reponse = await fetch(`${API}/repos/${OWNER}/${REPO}/contents/${CHEMIN}`, {
    method: 'PUT',
    headers: { ...entetes(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      content: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8').toString('base64'),
      sha,
    }),
  });

  if (reponse.status === 409) {
    throw new Error('Le manifest a change entre-temps. Relance la commande.');
  }
  if (!reponse.ok) {
    const detail = await reponse.json().catch(() => ({}));
    throw new Error(detail.message || `GitHub a repondu HTTP ${reponse.status}`);
  }
}

/* ------------------------------------------------------------------ *
 *  Mise en forme
 * ------------------------------------------------------------------ */

function dateEnClair(quand = new Date()) {
  return `${quand.getDate()} ${MOIS[quand.getMonth()]} ${quand.getFullYear()}`;
}

/**
 * Nettoie un texte ecrit sur Discord.
 *
 * Le panneau du launcher n'affiche que du texte : mentions, emojis
 * personnalises et liens Markdown y apparaitraient sous leur forme brute
 * (<@123456789>, <:epee:987654>), ce qui serait illisible.
 */
function nettoyer(texte) {
  return String(texte || '')
    .replace(/<#\d+>/g, '')
    .replace(/<@[&!]?\d+>/g, '')
    .replace(/<a?:(\w+):\d+>/g, '$1')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '$1')
    .replace(/\*\*\*(.+?)\*\*\*/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/`{1,3}([^`]+)`{1,3}/g, '$1')
    .replace(/^>\s?/gm, '')
    .replace(/^#{1,3}\s?/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Separe titre et corps quand l'annonce arrive d'un seul bloc. */
function decouper(contenu) {
  const lignes = nettoyer(contenu).split('\n').filter((l) => l.trim());
  if (!lignes.length) return null;

  const premiere = lignes[0].trim();
  if (lignes.length > 1 && premiere.length <= 80) {
    return { titre: premiere, corps: lignes.slice(1).join(' ').trim() };
  }

  const texte = lignes.join(' ');
  if (texte.length <= 80) return { titre: texte, corps: '' };
  const coupe = texte.slice(0, 77);
  const espace = coupe.lastIndexOf(' ');
  return { titre: `${coupe.slice(0, espace > 40 ? espace : 77)}...`, corps: texte };
}

/* ------------------------------------------------------------------ *
 *  Operations publiques
 * ------------------------------------------------------------------ */

/**
 * Publie une actualite dans le launcher.
 *
 * @param {string} titre  Titre affiche en gras. Si vide, il est deduit du texte.
 * @param {string} corps  Le texte de l'annonce.
 * @returns {Promise<{title:string, body:string, date:string, total:number}>}
 */
async function publier(titre, corps) {
  const propre = {
    titre: nettoyer(titre),
    corps: nettoyer(corps),
  };

  // Un seul champ rempli suffit : on en deduit l'autre plutot que de refuser.
  if (!propre.titre && !propre.corps) {
    throw new Error('Annonce vide.');
  }
  if (!propre.titre) {
    const parts = decouper(propre.corps);
    propre.titre = parts.titre;
    // parts.corps est vide quand l'annonce tient sur une ligne : la repeter
    // sous le titre afficherait deux fois la meme phrase dans le launcher.
    propre.corps = parts.corps;
  }

  const { manifest, sha } = await lireManifest();
  const actualite = {
    title: propre.titre,
    body: propre.corps,
    date: dateEnClair(),
  };

  manifest.news = [actualite, ...(manifest.news || [])].slice(0, MAX_ACTUALITES);
  await ecrireManifest(manifest, sha, `Actualite : ${propre.titre.slice(0, 60)}`);

  return { ...actualite, total: manifest.news.length };
}

/**
 * Publie une annonce directement depuis un message Discord.
 * Pratique pour brancher le module sur un salon : tout message poste y devient
 * une actualite.
 */
async function publierDepuisMessage(message) {
  const parts = decouper(message.content);
  if (!parts) throw new Error('Ce message ne contient pas de texte.');
  return publier(parts.titre, parts.corps);
}

/** Retire l'actualite la plus recente, en cas de fausse manoeuvre. */
async function retirerDerniere() {
  const { manifest, sha } = await lireManifest();
  if (!manifest.news || !manifest.news.length) {
    throw new Error('Aucune actualite a retirer.');
  }
  const retiree = manifest.news.shift();
  await ecrireManifest(manifest, sha, `Actualite retiree : ${retiree.title.slice(0, 60)}`);
  return retiree;
}

/** Liste les actualites actuellement affichees dans le launcher. */
async function lister() {
  const { manifest } = await lireManifest();
  return manifest.news || [];
}

module.exports = {
  publier,
  publierDepuisMessage,
  retirerDerniere,
  lister,
  nettoyer,
  decouper,
  MAX_ACTUALITES,
};
