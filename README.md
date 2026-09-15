# Launcher Aethoria

Launcher Minecraft du serveur **Aethoria** : modpack Forge 1.20.1, connexion
par pseudo, connexion directe au serveur, mises à jour automatiques du modpack
et du launcher. Distribué en `.exe` pour Windows.

Lien de téléchargement pour les joueurs :
<https://github.com/matheokost6-arch/aethoria/releases/latest/download/Aethoria-Setup.exe>

---

## Ce que fait le bouton JOUER

1. **Manifest** : lit `manifest.json` sur le dépôt public (versions, mods, actualités).
2. **Java** : télécharge le runtime officiel de Mojang. Le joueur n'installe rien.
3. **Forge** : installe Forge en mode silencieux.
4. **Jeu** : client, bibliothèques, natives et ressources, vérifiés par SHA1.
5. **Mods** : impose la liste officielle, plus les mods optionnels cochés.
6. **Lancement** : démarre Minecraft et rejoint directement le serveur.

Le jeu s'installe dans `%APPDATA%\.aethoria`, séparé du `.minecraft` du joueur.

---

## Développement

```bash
npm install
npm start          # lancer le launcher
npm run dev        # idem, avec les outils de développement
```

Node.js 20 ou plus.

---

## Publier

```bash
npm version patch          # 1.1.4 → 1.1.5
npm run deploy             # modpack + launcher, tout est automatique
npm run deploy:launcher    # launcher seul, sans toucher aux mods
npm run deploy:rapide      # republie dist/ tel quel
```

`npm run deploy` vérifie que `gh` est connecté et que le dépôt de distribution
est public, régénère le manifest depuis `pack/`, envoie les mods manquants,
publie le manifest, construit et publie l'installateur, pousse le code, puis
contrôle qu'un joueur sans compte GitHub peut tout télécharger.

Les launchers installés se mettent à jour d'eux-mêmes : la nouvelle version
est téléchargée en arrière-plan et installée à la fermeture.

### Les deux dépôts

| Dépôt | Visibilité | Contenu |
|---|---|---|
| `aethoria-launcher` | privé | code source |
| `aethoria` | **public, obligatoire** | manifest, mods, installateur |

Le launcher d'un joueur n'a pas accès à un dépôt privé : si `aethoria` devient
privé, plus rien ne se télécharge.

### Modifier le modpack

Les mods vivent dans `pack/mods/` (exclu de Git). Ajoute ou retire des fichiers,
puis `npm run deploy`. Le launcher supprime chez les joueurs tout mod absent du
manifest et retélécharge ceux qui manquent.

### Mods optionnels

Liste de mods clients proposés dans le panneau **Mods** du launcher, récupérés
depuis Modrinth avec leurs dépendances :

```bash
node tools/build-optional-mods.js               # reconstruit la liste par défaut
node tools/build-optional-mods.js --add jade    # ajoute un mod
```

La liste par défaut se modifie dans `tools/build-optional-mods.js`. Les mods
exigeant une installation serveur sont refusés.

---

## Réglages sans nouvelle version

Tout ce qui suit se modifie dans `manifest.json` du dépôt public, et les
joueurs le voient au prochain démarrage :

| Champ | Rôle |
|---|---|
| `minecraftVersion`, `forgeVersion` | Versions installées (le pack exige Forge ≥ 47.4.10) |
| `server` | Adresse affichée et utilisée pour la connexion directe |
| `news` | Actualités de l'accueil : `{ "title", "body", "date" }` |
| `links.discord` | Invitation du bouton Discord (utilise une invitation permanente) |
| `links.trailer` | Lien YouTube de la bande-annonce |
| `authNotice` | Consigne AuthMe affichée au choix du pseudo |
| `files`, `optionalMods` | Générés par les outils, ne pas éditer à la main |

Les valeurs de repli, utilisées si le manifest est injoignable, sont dans
`src/shared/config.js`. Si tu changes de bande-annonce, remplace aussi
`src/renderer/assets/trailer.jpg`.

---

## Pseudo et sécurité

Le launcher gère un seul pseudo, sans mot de passe. L'UUID est calculé comme
le fait un serveur en `online-mode=false`, donc l'inventaire suit le joueur
tant qu'il garde le même pseudo. C'est **AuthMe**, sur le serveur, qui protège
les pseudos (`/register`, `/login`).

Le verrou des mods évite les plantages et les rejets à la connexion, mais ce
n'est pas un anti-triche : un joueur peut toujours lancer le jeu autrement. La
vraie protection reste côté serveur.

---

## Structure

```
src/
├── shared/config.js        Dépôts, serveur, liens, valeurs de repli
├── main/                   Processus principal
│   ├── main.js             Fenêtre, canaux IPC, mises à jour
│   ├── preload.js          Pont vers l'interface
│   ├── store.js            Réglages et pseudo
│   ├── auth/               Pseudo et UUID hors ligne
│   └── game/               Téléchargements, Java, Forge, mods, lancement, diagnostic
└── renderer/               Interface (index.html, styles.css, app.js, assets/)

tools/
├── deploy.js               Publication complète
├── build-manifest.js       Génère le manifest depuis pack/
└── build-optional-mods.js  Liste des mods optionnels
```

---

## Dépannage

| Symptôme | Solution |
|---|---|
| « Mise à jour impossible » dans le launcher | Le dépôt `aethoria` n'est plus public, ou la release n'a pas de `latest.yml`. Relance `npm run deploy:rapide`. |
| Un ami ne reçoit pas les mises à jour | Il a une ancienne version installée depuis l'ancien dépôt : il réinstalle une fois depuis le lien ci-dessus. |
| Le jeu se ferme au démarrage | Le launcher affiche la cause probable. Sinon, *Réglages → Journaux*. |
| `OutOfMemoryError` | Augmenter la mémoire dans les réglages. |
| Forge ne s'installe pas | *Réglages → Réparer*, puis relancer. |
| Rejet pour mods manquants | Le manifest n'a pas été republié après un changement de mods. |
| Écran SmartScreen à l'installation | *Informations complémentaires → Exécuter quand même* (exe non signé). |
