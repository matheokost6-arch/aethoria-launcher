'use strict';

const microsoft = require('./microsoft');
const offline = require('./offline');
const compte = require('./compte');
const store = require('../store');

// Marge avant expiration : on renouvelle 5 minutes avant l'echeance reelle
// pour ne pas lancer le jeu avec un jeton qui expire pendant le demarrage.
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/* ------------------------------------------------------------------ *
 *  Comptes Aethoria (pseudo + mot de passe)
 * ------------------------------------------------------------------ */

async function inscrire(pseudo, motDePasse) {
  const account = await compte.inscrire(pseudo, motDePasse);
  store.upsertAccount(account);
  return listAccounts();
}

async function connecter(pseudo, motDePasse) {
  const account = await compte.connecter(pseudo, motDePasse);
  store.upsertAccount(account);
  return listAccounts();
}

async function changerMotDePasse(nouveauMotDePasse) {
  const { accounts } = store.getAccounts();
  const actuel = accounts[0];
  if (!actuel) throw new Error('Aucun compte connecte.');
  if (actuel.type !== 'aethoria') {
    throw new Error('Ce compte n’a pas de mot de passe.');
  }
  const account = await compte.changerMotDePasse(actuel, nouveauMotDePasse);
  store.upsertAccount(account);
  return listAccounts();
}

/**
 * Connexion sans mot de passe, utilisee tant que le service de comptes n'est
 * pas configure. Elle evite que le launcher soit inutilisable pendant la mise
 * en place, mais ne protege aucun pseudo : l'interface le dit clairement.
 */
function connecterSansCompte(pseudo) {
  const account = offline.login(pseudo);
  store.upsertAccount(account);
  return listAccounts();
}

/* ------------------------------------------------------------------ *
 *  Microsoft (conserve, non branche dans l'interface)
 * ------------------------------------------------------------------ */

async function loginMicrosoft(parentWindow) {
  const account = await microsoft.login(parentWindow);
  store.upsertAccount(account);
  return account;
}

/* ------------------------------------------------------------------ *
 *  Preparation au lancement
 * ------------------------------------------------------------------ */

/**
 * Renvoie un compte pret a lancer le jeu.
 *
 * Un compte Aethoria voit sa session rouverte a partir du jeton conserve : le
 * joueur ne ressaisit jamais son mot de passe sur une machine ou il s'est deja
 * connecte. Si la session ne peut pas etre rouverte (jeton revoque, mot de
 * passe change ailleurs), le jeu se lance quand meme : le serveur reste seul
 * juge de qui entre, et bloquer le lancement priverait le joueur pour une
 * raison qui ne le concerne pas.
 */
async function resolveForLaunch(accountId) {
  const { accounts } = store.getAccounts();
  const account = accounts.find((a) => a.id === accountId) || accounts[0];
  if (!account) throw new Error('Aucun compte enregistre. Connecte-toi.');

  if (account.type === 'aethoria') {
    const encoreValide = account.sessionExpiresAt
      && account.sessionExpiresAt - REFRESH_MARGIN_MS > Date.now();
    if (encoreValide) return account;

    try {
      const rafraichi = await compte.rouvrirSession(account);
      store.upsertAccount(rafraichi);
      return rafraichi;
    } catch {
      return account;
    }
  }

  if (account.type === 'offline') return account;

  // Compte Microsoft : le jeton d'acces n'est pas persiste, il faut le
  // renouveler avant chaque session.
  const stillValid = account.accessToken
    && account.expiresAt
    && account.expiresAt - REFRESH_MARGIN_MS > Date.now();
  if (stillValid) return account;

  if (!account.refreshToken) {
    throw new Error(`La session Microsoft de ${account.name} a expire. Reconnecte ce compte.`);
  }

  try {
    const refreshed = await microsoft.refresh(account.refreshToken);
    store.upsertAccount(refreshed);
    return refreshed;
  } catch (err) {
    throw new Error(
      `Impossible de renouveler la session de ${account.name} (${err.message}). Reconnecte ce compte.`,
    );
  }
}

/** Version publique d'un compte : sans jeton, pour l'interface. */
function toPublic(account) {
  if (!account) return null;
  return {
    id: account.id,
    type: account.type,
    name: account.name,
    uuid: account.uuid,
    skinUrl: account.skinUrl,
    // Avatar de secours : le rendu de tete Crafatar suit l'UUID, y compris pour
    // les UUID hors-ligne (qui n'ont pas de skin -> Steve par defaut).
    avatarUrl: `https://crafatar.com/avatars/${account.uuid}?size=64&overlay&default=MHF_Steve`,
  };
}

function listAccounts() {
  const { accounts, selectedId } = store.getAccounts();
  return {
    accounts: accounts.map(toPublic),
    selectedId,
    // L'interface adapte son ecran de connexion selon que le service est
    // configure ou non.
    comptesActifs: compte.estConfigure(),
  };
}

module.exports = {
  inscrire,
  connecter,
  changerMotDePasse,
  connecterSansCompte,
  loginMicrosoft,
  resolveForLaunch,
  listAccounts,
  toPublic,
  removeAccount: (id) => { store.removeAccount(id); return listAccounts(); },
  selectAccount: (id) => { store.selectAccount(id); return listAccounts(); },
};
