'use strict';

const offline = require('./offline');
const store = require('../store');

/**
 * Le joueur choisit un pseudo, sans mot de passe : c'est AuthMe, sur le
 * serveur, qui protege les comptes. L'UUID est derive du pseudo exactement
 * comme le fait un serveur en online-mode=false, si bien que l'inventaire et
 * la progression suivent le joueur d'une session a l'autre.
 */
function connecterAvecPseudo(pseudo) {
  store.saveAccount(offline.login(pseudo));
  return getAccount();
}

/** Compte complet, jeton compris, pour construire la commande de lancement. */
function resolveForLaunch() {
  const account = store.getAccount();
  if (!account) throw new Error('Aucun pseudo enregistré. Choisis ton pseudo.');
  return account;
}

/** Version publique du compte, sans jeton, pour l'interface. */
function getAccount() {
  const account = store.getAccount();
  if (!account) return null;
  return {
    name: account.name,
    uuid: account.uuid,
    // Rendu de tete Crafatar : un UUID hors ligne n'a pas de skin, Steve
    // s'affiche alors par defaut.
    avatarUrl: `https://crafatar.com/avatars/${account.uuid}?size=64&overlay&default=MHF_Steve`,
  };
}

module.exports = { connecterAvecPseudo, resolveForLaunch, getAccount };
