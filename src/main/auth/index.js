'use strict';

const microsoft = require('./microsoft');
const offline = require('./offline');
const store = require('../store');

// Marge avant expiration : on renouvelle 5 minutes avant l'echeance reelle
// pour ne pas lancer le jeu avec un jeton qui expire pendant le demarrage.
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

async function loginMicrosoft(parentWindow) {
  const account = await microsoft.login(parentWindow);
  store.upsertAccount(account);
  return account;
}

function loginOffline(name) {
  const account = offline.login(name);
  store.upsertAccount(account);
  return account;
}

/**
 * Renvoie un compte pret a lancer le jeu, en renouvelant le jeton Microsoft si
 * necessaire. Le jeton d'acces n'etant pas persiste, un compte Microsoft passe
 * toujours par un refresh au premier lancement de la session.
 */
async function resolveForLaunch(accountId) {
  const { accounts } = store.getAccounts();
  const account = accounts.find((a) => a.id === accountId);
  if (!account) throw new Error('Compte introuvable. Reconnecte-toi.');

  if (account.type === 'offline') return account;

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
    // les UUID hors-ligne (qui n'ont pas de skin -> Steve/Alex par defaut).
    avatarUrl: `https://crafatar.com/avatars/${account.uuid}?size=64&overlay&default=MHF_Steve`,
  };
}

function listAccounts() {
  const { accounts, selectedId } = store.getAccounts();
  return { accounts: accounts.map(toPublic), selectedId };
}

module.exports = {
  loginMicrosoft,
  loginOffline,
  resolveForLaunch,
  listAccounts,
  toPublic,
  removeAccount: (id) => { store.removeAccount(id); return listAccounts(); },
  selectAccount: (id) => { store.selectAccount(id); return listAccounts(); },
};
