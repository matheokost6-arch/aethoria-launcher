# Launcher Aethoria

Launcher Minecraft du serveur **Aethoria** : modpack Forge 1.20.1, connexion
par pseudo, connexion directe au serveur, mises à jour automatiques du modpack
et du launcher. Windows, macOS et Linux.

Lien à donner aux joueurs, tous systèmes confondus :
<https://github.com/aethoria-mc/aethoria/releases/latest>

| Système | Fichier | Remarque |
| --- | --- | --- |
| Windows 10 / 11 | `Aethoria-Setup.exe` | installateur, mise à jour automatique |
| macOS 11+, Apple Silicon | `Aethoria-mac-arm64.dmg` | non signée, voir ci-dessous |
| macOS 11+, Intel | `Aethoria-mac-x64.dmg` | idem |
| Debian, Ubuntu, Mint, Pop!_OS | `Aethoria-linux-amd64.deb` | `sudo apt install ./Aethoria-linux-amd64.deb` |
| Fedora, RHEL, openSUSE | `Aethoria-linux-x86_64.rpm` | `sudo dnf install ./Aethoria-linux-x86_64.rpm` |
| Toute autre distribution | `Aethoria-linux-x86_64.AppImage` | `chmod +x`, puis double-clic. Demande `libfuse2` |
| Sans installation | `Aethoria-linux-x64.tar.gz` | à décompresser, puis lancer `aethoria` |
| Linux sur ARM | fichiers `arm64` / `arm_aarch64` | Java doit être installé : `sudo apt install openjdk-17-jre` |

Les mises à jour automatiques fonctionnent sous Windows, macOS et avec
l'AppImage. Avec un `.deb`, un `.rpm` ou le `.tar.gz`, il faut retélécharger.

**macOS** : l'application n'est pas signée (certificat Apple payant). Au premier
lancement, macOS la bloque : ouvrir **Réglages Système → Confidentialité et
sécurité**, puis cliquer sur **« Ouvrir quand même »** en bas de la page.

**Ce qu'il faut sur la machine** : un système 64 bits, Windows 10 ou plus,
macOS 11 (Big Sur) ou plus, ou un Linux avec glibc 2.28 ou plus (Debian 10,
Ubuntu 18.04, Fedora 29 et au-delà). Java est téléchargé par le launcher, sauf
sur Linux ARM où il doit être installé par la distribution.

Le dossier de jeu suit le système : `%APPDATA%\.aethoria` sous Windows,
`~/Library/Application Support/aethoria-jeu` sous macOS, `~/.aethoria` sous Linux.

---

## Ce que fait le bouton JOUER

1. **Manifest** : lit `manifest.json` sur le dépôt public (versions, mods, actualités).
2. **Java** : télécharge le runtime officiel de Mojang. Le joueur n'installe rien.
3. **Forge** : installe Forge en mode silencieux.
4. **Jeu** : client, bibliothèques, natives et ressources, vérifiés par SHA1.
5. **Mods** : impose la liste officielle, plus les mods optionnels cochés.
6. **Lancement** : démarre Minecraft et rejoint directement le serveur.

Le jeu s'installe dans `%APPDATA%\.aethoria`, séparé du `.minecraft` du joueur.

## Fonctions pour le joueur

- **Serveur** : état, latence, liste des joueurs connectés (clic sur l'état),
  alerte Windows quand le serveur revient en ligne.
- **Partie** : temps de jeu cumulé, notification quand le jeu est prêt,
  progression dans la barre des tâches, arrêt forcé en deux clics.
- **Plantage** : cause probable en clair, rapport complet (machine, versions,
  dernières lignes du jeu) copié en un clic pour le staff.
- **Réglages** : mémoire, taille de la fenêtre ou plein écran, comportement du
  launcher pendant la partie (rester ouvert, se ranger près de l'horloge, se
  fermer), démarrage avec Windows, fond d'écran, mode léger.
- **Dépannage** : test de connexion (GitHub, Mojang, serveur, disque, mémoire,
  Java), vérification des fichiers sans tout retélécharger, nettoyage des
  anciens journaux, réinstallation complète.
- **Divers** : taille de la prochaine mise à jour du modpack sur l'accueil,
  badge « Nouveau » sur les actualités, galerie des captures d'écran, mods
  optionnels, Aethoria ajouté à la liste multijoueur, Minecraft en français à
  la première partie, raccourcis (Entrée pour jouer, F5, Échap).

Le jeu est lancé détaché du launcher : fermer le launcher, ou le voir planter,
ne ferme jamais Minecraft.

Les nouveautés affichées après une mise à jour se rédigent dans
`src/renderer/changelog.js`, une entrée par version.

---

## Développement

```bash
npm install
npm start          # lancer le launcher
npm run dev        # idem, avec les outils de développement
```

Node.js 20 ou plus.

Construire à la main :

```bash
npm run build          # Windows (depuis Windows)
npm run build:mac      # macOS (depuis un Mac)
npm run build:linux    # Linux (depuis Linux)
```

Un système ne construit que pour lui-même : les versions macOS et Linux sont
donc construites par GitHub (voir plus bas).

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

### Versions macOS et Linux

Elles ne peuvent pas être construites depuis Windows. `npm run deploy` demande
donc à GitHub de les construire sur de vraies machines macOS et Linux
(`.github/workflows/mac-linux.yml`), attend la fin (10 à 15 minutes), récupère
les fichiers et les ajoute lui-même à la release publique, à côté de
l'installateur Windows.

Rien à configurer : la publication se fait avec le compte `gh` déjà connecté,
celui qui publie déjà Windows. Aucun jeton, aucun secret.

```bash
npm run deploy                          # tout, les trois systèmes
npm run deploy -- --skip-mac-linux      # Windows seulement, sans attendre
npm run deploy:mac-linux                # ajoute macOS et Linux à la version déjà publiée
```

Si la construction échoue, elle est visible sur
<https://github.com/matheokost6-arch/aethoria-launcher/actions>, et
`npm run deploy:mac-linux` la relance.

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

### Menu Aethoria (mod maison)

`mod/` contient le code d'un petit mod client, `aethoriamenu`, qui remplace
l'écran titre de Minecraft par le menu Aethoria : **Rejoindre Aethoria**,
**Options**, **Quitter le jeu**. Pas de solo ni de Realms, et le joueur y
revient après chaque déconnexion. L'adresse du serveur est transmise par le
launcher (`-Daethoria.server`), donc un changement dans le manifest suffit.

Le mod est distribué comme les autres, depuis `pack/mods`. Pour le modifier :

```bash
cd mod
JAVA_HOME="C:/Program Files/Java/jdk-17" ./gradlew build
cp build/libs/aethoriamenu-*.jar ../pack/mods/
cd .. && npm run deploy
```

Ce verrou est côté client : un joueur qui lance Minecraft sans le launcher
retrouve le menu normal. Le serveur reste la vraie protection.

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

## Launcher admin (staff)

Application séparée, dans `admin/`, **jamais publiée** avec le launcher joueur.
Elle pilote le serveur par RCON :

- joueurs en ligne, et fiche de n'importe quel pseudo (même hors ligne) ;
- expulser, rendre muet (10 min à définitif), rendre la parole, bannir
  (temporaire ou définitif, avec confirmation), débannir — via EssentialsX ;
- inventaire et coffre de l'Ender d'un joueur connecté ;
- infos `whois` / `seen`, console libre, journal des 500 dernières actions.

```bash
npm run admin          # lancer en développement
npm run build:admin    # produit admin/dist/Aethoria-Admin.exe (portable)
```

**Activer RCON** dans `server.properties` : `enable-rcon=true`, `rcon.port`
(souvent 25575) et un long `rcon.password`, puis redémarrer. L'hébergeur doit
laisser ce port accessible.

Le mot de passe RCON n'est dans aucun fichier du projet : chaque admin le saisit,
et peut le mémoriser chiffré par Windows sur son PC. RCON n'est pas chiffré sur
le réseau : ne jamais administrer depuis un Wi-Fi public. « Rendre la parole »
vérifie d'abord l'état du joueur, car la commande `mute` d'EssentialsX bascule.

---

## Pseudo et sécurité

Le pseudo est **définitif** : le joueur le confirme une fois, puis il ne peut
plus le changer. Il est enregistré dans les données du launcher (conservées à
la désinstallation) et copié dans le registre (`HKCU\Software\Aethoria`, valeur
`Pseudo`), qui fait foi. Réinstaller le launcher ou supprimer son dossier ne
suffit donc pas. Pour débloquer un joueur, supprime les deux copies sur son PC :
`reg delete HKCU\Software\Aethoria /v Pseudo /f`, puis le fichier
`%APPDATA%\aethoria-launcher\accounts.json`. Ce verrou est local : un
joueur averti peut toujours l'effacer, et c'est AuthMe qui protège les comptes.

Pas de mot de passe dans le launcher. L'UUID est calculé comme
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
