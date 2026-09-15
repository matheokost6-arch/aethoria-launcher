'use strict';

const offline = require('./offline');
const store = require('../store');

/**
 * Le pseudo est definitif : une fois choisi, il ne peut plus etre change,
 * meme en reinstallant le launcher. C'est AuthMe, sur le serveur, qui protege
 * ensuite le compte par mot de passe.
 *
 * L'UUID est derive du pseudo exactement comme le fait un serveur en
 * online-mode=false : l'inventaire et la progression suivent le joueur.
 */

/**
 * Compte enregistre sur la machine. Le registre fait foi : il survit a la
 * desinstallation et a la suppression du dossier de donnees, et un
 * accounts.json modifie a la main ne permet pas de changer de pseudo.
 */
function compteEnregistre() {
  const account = store.getAccount();
  const pseudoRegistre = store.getRegistryPseudo();

  if (pseudoRegistre) {
    if (account?.name === pseudoRegistre) return account;
    const restaure = offline.login(pseudoRegistre);
    store.saveAccount(restaure);
    return restaure;
  }

  // Joueur d'une version precedente : son pseudo est verrouille a son tour.
  if (account) store.saveRegistryPseudo(account.name);
  return account;
}

/** Verifie un pseudo avant la confirmation, sans rien enregistrer. */
function validerPseudo(pseudo) {
  if (compteEnregistre()) throw new Error('Ton pseudo est définitif et ne peut plus être changé.');
  return offline.validateName(pseudo);
}

function connecterAvecPseudo(pseudo) {
  validerPseudo(pseudo);
  store.saveAccount(offline.login(pseudo));
  return getAccount();
}

/** Compte complet, jeton compris, pour construire la commande de lancement. */
function resolveForLaunch() {
  const account = compteEnregistre();
  if (!account) throw new Error('Aucun pseudo enregistré. Choisis ton pseudo.');
  return account;
}

/** Version publique du compte, sans jeton, pour l'interface. */
function getAccount() {
  const account = compteEnregistre();
  if (!account) return null;
  return {
    name: account.name,
    uuid: account.uuid,
    // Rendu de tete Crafatar : un UUID hors ligne n'a pas de skin, Steve
    // s'affiche alors par defaut.
    avatarUrl: `https://crafatar.com/avatars/${account.uuid}?size=64&overlay&default=MHF_Steve`,
  };
}

module.exports = { validerPseudo, connecterAvecPseudo, resolveForLaunch, getAccount };
