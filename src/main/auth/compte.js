'use strict';

const config = require('../../shared/config');
const offline = require('./offline');

/**
 * Comptes Aethoria : un pseudo, un mot de passe, valables depuis n'importe
 * quelle machine.
 *
 * La verification se fait chez Supabase, pas dans le launcher. C'est le point
 * essentiel : un mot de passe ne peut etre verifie que la ou il est stocke, et
 * le launcher tourne sur la machine du joueur. Supabase hache les mots de passe
 * (bcrypt), gere les sessions et expose une cle "anon" faite pour etre
 * embarquee dans une application cliente — elle ne donne acces a rien d'autre
 * qu'aux operations d'authentification.
 *
 * Supabase authentifie par adresse e-mail. Les joueurs n'en fournissent pas :
 * on derive donc une adresse technique du pseudo (baron@joueurs.aethoria.fr).
 * Elle ne sert qu'a identifier le compte, aucun courriel n'est jamais envoye.
 */

/* ------------------------------------------------------------------ *
 *  Regles de mot de passe
 * ------------------------------------------------------------------ */

const LONGUEUR_MIN = 8;

// Mots de passe trop evidents pour un serveur Minecraft francophone.
const TROP_COURANTS = new Set([
  'motdepasse', 'password', 'minecraft', 'aethoria', 'azertyuiop',
  '12345678', '123456789', 'azerty123', 'qwertyui', 'jesuisunnoob',
]);

/**
 * Verifie la solidite d'un mot de passe.
 * On exige de la longueur et de la variete plutot qu'une liste de symboles
 * imposes : "cheval bateau lune 42" resiste mieux que "P@ss1!".
 */
function validerMotDePasse(motDePasse, pseudo) {
  const mdp = String(motDePasse || '');

  if (mdp.length < LONGUEUR_MIN) {
    throw new Error(`Le mot de passe doit faire au moins ${LONGUEUR_MIN} caracteres.`);
  }
  if (mdp.length > 72) {
    // Limite de bcrypt : au-dela, les caracteres sont ignores en silence.
    throw new Error('Le mot de passe ne peut pas depasser 72 caracteres.');
  }
  if (TROP_COURANTS.has(mdp.toLowerCase())) {
    throw new Error('Ce mot de passe est trop courant. Choisis-en un autre.');
  }
  if (pseudo && mdp.toLowerCase().includes(String(pseudo).toLowerCase())) {
    throw new Error('Le mot de passe ne doit pas contenir ton pseudo.');
  }

  const familles = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/]
    .filter((r) => r.test(mdp)).length;
  if (familles < 2) {
    throw new Error(
      'Le mot de passe doit melanger au moins deux types de caracteres '
      + '(minuscules, majuscules, chiffres ou symboles).',
    );
  }

  return mdp;
}

/**
 * Note de 0 a 4, pour la jauge affichee pendant la saisie.
 * Ce n'est qu'une indication visuelle : la validation ci-dessus fait foi.
 */
function forceMotDePasse(motDePasse) {
  const mdp = String(motDePasse || '');
  if (!mdp) return { note: 0, libelle: '' };

  const familles = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/]
    .filter((r) => r.test(mdp)).length;

  let note = 0;
  if (mdp.length >= LONGUEUR_MIN) note += 1;
  if (mdp.length >= 12) note += 1;
  if (familles >= 2) note += 1;
  if (familles >= 3 && mdp.length >= 10) note += 1;
  if (TROP_COURANTS.has(mdp.toLowerCase())) note = 0;

  const libelles = ['Trop faible', 'Faible', 'Correct', 'Bon', 'Excellent'];
  return { note, libelle: libelles[note] };
}

/* ------------------------------------------------------------------ *
 *  Dialogue avec Supabase
 * ------------------------------------------------------------------ */

function estConfigure() {
  const { url, anonKey } = config.supabase || {};
  return Boolean(url && anonKey && !url.includes('TON-PROJET'));
}

function verifierConfiguration() {
  if (!estConfigure()) {
    throw new Error(
      "Le service de comptes n'est pas encore configure. "
      + 'Renseigne supabase.url et supabase.anonKey dans src/shared/config.js '
      + '(voir la section "Comptes des joueurs" du README).',
    );
  }
}

/** Adresse technique derivee du pseudo. Aucun courriel n'est jamais envoye. */
function adressePour(pseudo) {
  return `${String(pseudo).toLowerCase()}@${config.supabase.domaineJoueurs}`;
}

async function appelSupabase(chemin, corps, methode = 'POST') {
  verifierConfiguration();
  const reponse = await fetch(`${config.supabase.url}/auth/v1${chemin}`, {
    method: methode,
    headers: {
      apikey: config.supabase.anonKey,
      Authorization: `Bearer ${config.supabase.anonKey}`,
      'Content-Type': 'application/json',
    },
    body: corps ? JSON.stringify(corps) : undefined,
  });

  const donnees = await reponse.json().catch(() => ({}));
  if (!reponse.ok) {
    throw new Error(traduireErreur(donnees, reponse.status));
  }
  return donnees;
}

/** Traduit les messages de Supabase, qui sont en anglais et peu parlants. */
function traduireErreur(donnees, status) {
  const brut = String(donnees.msg || donnees.error_description || donnees.message || '').toLowerCase();

  if (brut.includes('invalid login credentials')) {
    return 'Pseudo ou mot de passe incorrect.';
  }
  if (brut.includes('already registered') || brut.includes('already been registered')) {
    return 'Ce pseudo est deja pris. Si c’est le tien, saisis ton mot de passe pour te connecter.';
  }
  if (brut.includes('password should be at least')) {
    return `Le mot de passe doit faire au moins ${LONGUEUR_MIN} caracteres.`;
  }
  if (brut.includes('email not confirmed')) {
    return 'Le compte attend une confirmation. Desactive la confirmation par e-mail '
      + 'dans les reglages Supabase (Authentication > Providers > Email).';
  }
  if (brut.includes('rate limit') || status === 429) {
    return 'Trop de tentatives. Patiente une minute avant de reessayer.';
  }
  if (status === 401 || status === 403) {
    return 'Le service de comptes a refuse la requete. Verifie la cle anon dans la configuration.';
  }
  return donnees.msg || donnees.error_description || `Le service de comptes a repondu HTTP ${status}.`;
}

/**
 * Construit le compte utilise par le jeu a partir d'une session Supabase.
 * L'UUID reste celui du mode hors-ligne, calcule depuis le pseudo : c'est lui
 * que le serveur recalcule de son cote, et en changer ferait perdre inventaire
 * et progression a tous les joueurs.
 */
function versCompte(pseudo, session) {
  const base = offline.login(pseudo);
  return {
    ...base,
    id: `aethoria:${base.uuid}`,
    type: 'aethoria',
    // Jeton de rafraichissement : il maintient la session ouverte
    // indefiniment, sans jamais redemander le mot de passe sur cette machine.
    refreshToken: session.refresh_token || null,
    sessionExpiresAt: session.expires_at ? session.expires_at * 1000 : null,
  };
}

/* ------------------------------------------------------------------ *
 *  Operations publiques
 * ------------------------------------------------------------------ */

/** Cree un compte. Le pseudo devient l'identite du joueur sur le serveur. */
async function inscrire(pseudo, motDePasse) {
  const valide = offline.validateName(pseudo);
  validerMotDePasse(motDePasse, valide);

  const donnees = await appelSupabase('/signup', {
    email: adressePour(valide),
    password: motDePasse,
    data: { pseudo: valide },
  });

  // Sans session renvoyee, la confirmation par e-mail est restee active :
  // le compte existe mais reste inutilisable.
  if (!donnees.access_token && !donnees.refresh_token) {
    throw new Error(
      'Compte cree, mais le service attend une confirmation par e-mail. '
      + 'Desactive "Confirm email" dans Supabase (Authentication > Providers > Email), '
      + 'puis reconnecte-toi.',
    );
  }

  return versCompte(valide, donnees);
}

/** Connecte un joueur existant. */
async function connecter(pseudo, motDePasse) {
  const valide = offline.validateName(pseudo);
  if (!motDePasse) throw new Error('Entre ton mot de passe.');

  const donnees = await appelSupabase('/token?grant_type=password', {
    email: adressePour(valide),
    password: motDePasse,
  });

  return versCompte(valide, donnees);
}

/**
 * Rouvre la session a partir du jeton conserve, sans redemander le mot de
 * passe. C'est ce qui rend la session permanente sur la machine du joueur.
 */
async function rouvrirSession(compte) {
  if (!compte?.refreshToken) {
    throw new Error('Session expiree. Ressaisis ton mot de passe.');
  }

  const donnees = await appelSupabase('/token?grant_type=refresh_token', {
    refresh_token: compte.refreshToken,
  });

  return versCompte(compte.name, donnees);
}

/** Change le mot de passe du joueur connecte. */
async function changerMotDePasse(compte, nouveauMotDePasse) {
  validerMotDePasse(nouveauMotDePasse, compte.name);

  // On rouvre d'abord la session : la modification exige un jeton d'acces frais.
  const donnees = await appelSupabase('/token?grant_type=refresh_token', {
    refresh_token: compte.refreshToken,
  });

  verifierConfiguration();
  const reponse = await fetch(`${config.supabase.url}/auth/v1/user`, {
    method: 'PUT',
    headers: {
      apikey: config.supabase.anonKey,
      Authorization: `Bearer ${donnees.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ password: nouveauMotDePasse }),
  });

  if (!reponse.ok) {
    throw new Error(traduireErreur(await reponse.json().catch(() => ({})), reponse.status));
  }
  return versCompte(compte.name, donnees);
}

module.exports = {
  inscrire,
  connecter,
  rouvrirSession,
  changerMotDePasse,
  validerMotDePasse,
  forceMotDePasse,
  estConfigure,
  LONGUEUR_MIN,
};
