# Launcher Aethoria

Launcher Minecraft du serveur **Aethoria** : modpack Forge 1.20.1 (71 mods),
connexion par **pseudo**, **connexion automatique au serveur**, mise à jour
automatique du modpack et du launcher, distribué en `.exe` pour Windows.

---

## Sommaire

1. [Ce que fait le launcher](#ce-que-fait-le-launcher)
2. [Démarrage rapide](#démarrage-rapide)
3. [Configuration obligatoire](#configuration-obligatoire)
   - [Dépôt GitHub](#1-dépôt-github)
   - [Adresse du serveur](#2-adresse-du-serveur)
   - [Connexion des joueurs](#3-connexion-des-joueurs)
4. [Publier le modpack](#publier-le-modpack)
5. [Construire le .exe](#construire-le-exe)
6. [Mettre à jour le launcher chez les joueurs](#mettre-à-jour-le-launcher-chez-les-joueurs)
7. [Structure du projet](#structure-du-projet)
8. [Format du manifest](#format-du-manifest)
9. [Confort du joueur](#confort-du-joueur)
10. [La bande-annonce](#la-bande-annonce)
11. [Le lien Discord](#le-lien-discord)
12. [Dépannage](#dépannage)

---

## Ce que fait le launcher

À chaque clic sur **JOUER**, le launcher exécute la chaîne suivante :

1. **Compte** — récupère le pseudo choisi par le joueur.
2. **Manifest** — récupère `manifest.json` sur GitHub (versions du jeu et liste des mods).
3. **Java** — télécharge le runtime Java officiel de Mojang correspondant à la version.
   Le joueur n'a **rien à installer**.
4. **Forge** — installe Forge via l'installateur officiel, en mode silencieux.
5. **Jeu** — télécharge le client, les bibliothèques, les natives et les ressources,
   en vérifiant le SHA1 de chaque fichier.
6. **Modpack** — synchronise les mods : ajoute les nouveaux, remplace les modifiés,
   supprime ceux qui ont été retirés du pack.
7. **Lancement** — construit la ligne de commande Java, démarre Minecraft et
   **connecte directement le joueur au serveur** (`--quickPlayMultiplayer`).

Le jeu s'installe dans `%APPDATA%\.aethoria`, séparé du `.minecraft` officiel du
joueur : ses mondes solo et ses autres installations ne sont jamais touchés.

---

## Démarrage rapide

```bash
npm install       # dépendances
npm start         # lancer le launcher en développement
npm run dev       # idem, avec les outils de développement ouverts
npm run build     # produire le .exe dans dist/
```

Node.js 20 ou supérieur est requis pour le développement (le joueur final, lui,
n'a besoin de rien).

---

## Configuration obligatoire

Deux réglages sont à faire **avant** de distribuer le launcher.

### 1. Les deux dépôts

Le projet vit sur **deux dépôts**, et cette séparation n'est pas cosmétique :

| Dépôt | Visibilité | Contenu |
|---|---|---|
| `aethoria-launcher` | **privé au choix** | Le code source du launcher |
| `aethoria` | **public, obligatoire** | Le manifest, les mods, l'installateur |

Le launcher installé chez un joueur n'a aucun moyen de lire un dépôt privé : il
n'a pas ton compte GitHub. Si le dépôt de distribution passe en privé, tout
répond `404`, et le launcher se rabat **en silence** sur sa dernière copie
locale — il affiche alors « Manifest du modpack injoignable » et plus aucune
mise à jour n'arrive.

Rien de sensible ne se trouve dans le dépôt public : les mods sont déjà publics
chez leurs auteurs, le manifest ne contient qu'une liste de fichiers et
l'adresse du serveur, et l'installateur est de toute façon distribué à tous les
joueurs. **Les mots de passe, eux, sont chez Supabase** et ne transitent jamais
par GitHub.

`npm run deploy` refuse de publier si le dépôt de distribution n'est pas public.

### 1 bis. Configuration des dépôts

Le dépôt sert à la fois à héberger les mods (via les *Releases*), le manifest et
les mises à jour du launcher.

Dans **`src/shared/config.js`** :

```js
github: {
  owner: 'ton-compte-github',   // ← à remplacer
  repo: 'aethoria-launcher',    // ← à remplacer
  branch: 'main',
},
```

Et dans **`electron-builder.yml`**, les mêmes valeurs :

```yaml
publish:
  provider: github
  owner: ton-compte-github      # ← à remplacer
  repo: aethoria-launcher       # ← à remplacer
```

> Le dépôt doit être **public**, sinon les joueurs ne pourront pas télécharger
> les mods ni les mises à jour.

### 2. Adresse du serveur

Toujours dans `src/shared/config.js` :

```js
server: {
  host: 'aethoria.omgcraft.fr',   // ← l'IP ou le domaine de ton serveur
  port: 25565,
},
```

Cette adresse est affichée sur l'écran principal et sert au réglage
« rejoindre directement le serveur au lancement ».

### 3. Connexion des joueurs

Le launcher utilise **uniquement la connexion par pseudo**. Le joueur saisit un
pseudo de 3 à 16 caractères et entre en jeu : ni compte Minecraft, ni mot de
passe, ni fenêtre Microsoft.

Le launcher ne gère **qu'un seul pseudo**. Le bouton en bas à gauche permet de
le changer, ce qui remplace le précédent — il n'y a pas de liste de comptes.
Un fichier hérité d'une version antérieure est ramené au pseudo qui était
sélectionné.

L'UUID est calculé **exactement comme le fait un serveur en
`online-mode=false`** : un UUID de version 3 sur la chaîne
`OfflinePlayer:<pseudo>`. C'est essentiel — le serveur recalcule ce même UUID de
son côté, donc l'inventaire, la position et les permissions d'un joueur sont
conservés d'une session à l'autre, tant qu'il garde le même pseudo.

> ⚠️ **Le serveur doit tourner en `online-mode=false`.** C'est le cas
> d'Aethoria, vérifié en jeu : un client connecté sous le pseudo « Baron »
> apparaît bien dans la liste des joueurs.

> ⚠️ **Rien n'empêche un joueur de prendre le pseudo d'un autre.** En
> `online-mode=false`, seul le pseudo fait foi. Protège au minimum les comptes
> du staff avec un plugin d'authentification (AuthMe, nLogin…) — sinon
> n'importe qui peut se connecter sous ton pseudo d'administrateur.

#### Connexion automatique au serveur

Le launcher ajoute `--quickPlayMultiplayer <serveur>` à la commande de
lancement : le joueur passe du bouton **JOUER** au serveur sans voir le menu
multijoueur. L'écran principal l'en informe (« Tu rejoindras directement
… au lancement »).

C'est activé par défaut via `defaults.joinServerOnLaunch` dans
`src/shared/config.js`. Un joueur peut le décocher dans les paramètres s'il veut
accéder au menu principal — le message d'accueil s'adapte alors.

#### Réactiver la connexion Microsoft

Le code de l'authentification Microsoft (OAuth2 + PKCE → Xbox Live → XSTS →
services Minecraft) est conservé dans `src/main/auth/microsoft.js` et reste
branché sur le canal IPC `accounts:loginMicrosoft`. Pour la remettre en service,
il faut renseigner `msalClientId` dans `src/shared/config.js`, puis rétablir
l'onglet correspondant dans `src/renderer/index.html`.

Elle exige une application Azure **approuvée manuellement par Mojang**
(formulaire : <https://aka.ms/mce-reviewappid>), avec un délai d'approbation
qui va de quelques semaines à plusieurs mois. C'est la raison pour laquelle le
launcher ne s'appuie pas dessus.

---

## Publier le modpack

Les mods vivent dans `pack/`, qui reproduit l'arborescence du dossier de jeu :

```
pack/
├── mods/            → sera installé dans %APPDATA%\.aethoria\mods
├── config/          → configuration des mods, si tu veux l'imposer
└── resourcepacks/   → packs de ressources, facultatif
```

`pack/` est volontairement exclu de Git (`.gitignore`) : 456 Mo de mods n'ont
rien à faire dans un dépôt. Les fichiers passent par les *Releases*.

**Publication en trois commandes :**

```bash
# 1. Envoyer les fichiers sur une release GitHub (nécessite gh : https://cli.github.com)
node tools/publish-pack.js --tag pack-1.1.0

# 2. Générer le manifest (SHA1 + taille + URL de chaque fichier)
node tools/build-manifest.js --tag pack-1.1.0 --mc 1.20.1 --forge 47.4.10

# 3. Publier le manifest : les joueurs reçoivent la mise à jour au prochain lancement
git add manifest.json && git commit -m "Modpack 1.1.0" && git push
```

Pour une mise à jour ultérieure, garde le même tag et ajoute `--clobber` à
l'étape 1, ou crée un nouveau tag (`pack-1.2.0`) et régénère le manifest avec.

### Dossier `mods` verrouillé

Le launcher impose la liste officielle des mods. À **chaque lancement** :

- tout fichier du dossier `mods` absent du manifest est **supprimé** ;
- tout mod officiel manquant ou modifié est **retéléchargé** (contrôle SHA1).

Le joueur n'a aucun moyen de changer ce comportement : il n'y a ni bouton
« Mods » dans l'interface, ni case à cocher, et `keepExtraMods` fait partie des
`FORCED_SETTINGS` de `src/main/store.js` — appliqués **après** le fichier de
réglages, si bien qu'éditer `settings.json` à la main ne change rien.

Vérifié : un `xray-cheat.jar` déposé dans le dossier disparaît à la
synchronisation, et un mod officiel supprimé revient.

### Mods optionnels côté client

Le verrou n'interdit pas tout : le launcher propose une **liste blanche** de
mods de confort, que tu contrôles. Le joueur les coche dans **Options de jeu**,
et le launcher les installe au lancement suivant.

Ces mods sont **uniquement clients** : rien à installer sur le serveur, et un
joueur qui n'en prend aucun joue exactement la même partie. Aucun ne touche au
gameplay — minimap, zoom, infobulles, acoustique, affichage.

Pour reconstruire ou mettre à jour la liste :

```bash
# Reconstruit la liste par défaut, en récupérant les dernières versions
node tools/build-optional-mods.js

# Ajoute un mod précis (identifiant Modrinth, visible dans l'URL de sa page)
node tools/build-optional-mods.js --add sodium-extra

git add manifest.json && git commit -m "Mods optionnels" && git push
```

L'outil interroge Modrinth, vérifie qu'une version existe pour ton couple
Minecraft/Forge, **refuse tout mod exigeant une installation serveur**
(`server_side: required`) et ignore ceux déjà présents dans le pack.

> **Luminosité maximale** (touche G) fait partie de la liste. C'est le seul mod
> proposé qui donne un avantage réel : voir dans le noir aide en exploration
> comme en combat nocturne. Pour le retirer, supprime sa ligne dans
> `tools/build-optional-mods.js` et relance le script.

Le manifest ne rediffuse aucun fichier : il pointe vers le CDN officiel de
Modrinth, avec l'empreinte SHA1 fournie par l'API. Les joueurs voient la
nouvelle liste dès que tu pousses le manifest — **sans nouvelle version du
launcher**.

### Pourquoi le launcher ne demande aucun mot de passe

C'est **AuthMe**, sur le serveur, qui protège les pseudos. Le launcher n'en
gère volontairement aucun.

La raison est technique : pour vérifier un mot de passe **depuis n'importe
quelle machine**, il faut le comparer à une référence stockée de façon
centrale. Le launcher n'a que trois endroits à sa disposition, et aucun ne
convient :

| Où stocker | Pourquoi c'est impossible |
|---|---|
| Le dépôt GitHub | Il est public : tous les mots de passe seraient lisibles |
| Le launcher lui-même | Le joueur a le fichier, donc la clé — le `.exe` s'extrait en une commande |
| La machine du joueur | Alors ça ne marche plus depuis une autre machine |

Un mot de passe côté launcher serait donc soit inutile, soit dangereux : il
donnerait à tes joueurs l'impression d'être protégés sans l'être. Et ils en
auraient **deux différents** pour la même chose.

À la place, le launcher **explique** la procédure : un encadré sur l'écran de
saisie du pseudo, et un rappel au moment du lancement. Le texte se règle dans
`authNotice` — côté manifest en priorité, donc modifiable sans republier le
launcher. Les lignes qui commencent par `/` sont affichées comme des commandes
à recopier.

```json
"authNotice": {
  "title": "Protege ton pseudo",
  "body": "A ta toute premiere connexion sur le serveur, tape dans le chat :
/register motdepasse motdepasse
Puis a chaque fois que tu reviens :
/login motdepasse"
}
```

> Si tu veux un jour de vrais comptes gérés par le launcher (identifiant, mot
> de passe, skins personnalisés, multi-machines), la solution est un **serveur
> d'authentification** : Drasl ou Blessing Skin côté web, `authlib-injector`
> côté serveur Minecraft. C'est un service à héberger, pas une option à cocher.

---

> ### ⚠️ Ce que ce verrou ne fait pas
>
> **Ce n'est pas une protection anti-triche.** Le launcher remet le dossier en
> ordre *avant* de lancer le jeu ; il ne surveille rien ensuite. Un joueur
> déterminé peut :
>
> - déposer un mod dans `mods` **pendant** que le jeu tourne, pour le prochain
>   démarrage — non, le launcher le retirera ; mais il peut surtout
> - **lancer Minecraft sans passer par le launcher** (le dossier
>   `%APPDATA%\.aethoria` reste accessible, et n'importe quel autre launcher
>   sait s'en servir) ;
> - utiliser un client tiers déjà équipé de triches.
>
> **La seule protection réelle est côté serveur** :
>
> - un plugin anti-triche (Matrix, Grim, Vulcan, Spartan…) ;
> - la vérification de la liste de mods par Forge à la connexion, qui rejette
>   un client dont les mods ne correspondent pas à ceux du serveur ;
> - un plugin d'authentification pour empêcher l'usurpation de pseudo.
>
> Ce que le verrou apporte réellement, et ce n'est pas rien : plus aucun
> plantage dû à un mod incompatible ajouté par un joueur, plus de rejet à la
> connexion après une mise à jour du pack, et un support beaucoup plus simple —
> tout le monde a rigoureusement la même installation.

---

## Construire le .exe

```bash
npm run build
```

Produit dans `dist/` :

| Fichier | Usage |
|---|---|
| `Aethoria-Setup-1.0.0.exe` | **L'installateur à distribuer.** Crée les raccourcis, gère la désinstallation, permet les mises à jour automatiques. |
| `Aethoria-Portable-1.0.0.exe` | Version sans installation, pratique pour dépanner un joueur. |

L'installateur s'installe pour l'utilisateur courant : **aucune demande de
droits administrateur**, ce qui évite bien des blocages.

### Avertissement SmartScreen

Un `.exe` non signé déclenche l'écran bleu « Windows a protégé votre
ordinateur ». Le joueur doit cliquer sur *Informations complémentaires* →
*Exécuter quand même*.

Pour l'éviter, il faut un **certificat de signature de code** (environ 200 à
400 € par an chez un fournisseur comme Certum, DigiCert ou Sectigo). Une fois
le certificat obtenu :

```yaml
# electron-builder.yml
win:
  certificateFile: build/certificat.pfx
  certificatePassword: ${env.CERT_PASSWORD}
```

Pour un serveur communautaire, la plupart des projets s'en passent et
expliquent simplement la manipulation aux joueurs.

---

## Mettre à jour le launcher chez les joueurs

Le launcher se met à jour tout seul via les *Releases* GitHub.

```bash
npm version patch     # 1.0.9 → 1.0.10
npm run deploy        # et c'est tout
```

`npm run deploy` enchaîne les sept étapes, dans l'ordre :

1. vérifie que `gh` est connecté et que le dépôt de distribution est **public**
2. régénère le manifest depuis `pack/`
3. envoie sur la release du modpack **les seuls mods qui manquent en ligne**
   (comparaison par taille — inutile de réexpédier 456 Mo à chaque fois)
4. publie le manifest sur le dépôt public, via l'API, sans second clone
5. construit et publie l'installateur, en vérifiant que `latest.yml` correspond
6. enregistre et pousse le code sur le dépôt privé
7. **contrôle qu'un joueur sans compte GitHub peut tout télécharger**

La dernière étape est la plus importante : une publication à moitié faite ne se
voit pas autrement, et le launcher se figerait en silence sur sa copie locale.

Variantes :

```bash
npm run deploy:launcher   # ne touche pas aux mods
npm run deploy:rapide     # ni aux mods, ni à la construction (dist/ tel quel)
```

`npm run publish` appelle `tools/publish-launcher.js`, qui crée le tag,
construit l'exe, envoie les fichiers et **vérifie ensuite qu'ils sont bien
tous en ligne**.

> **Pourquoi un script maison plutôt que `electron-builder --publish always` ?**
> electron-builder publie ses cibles (*nsis* et *portable*) en parallèle, et
> chacune tente de créer la release. Résultat observé lors de la première
> publication : **deux releases portant le même tag `v1.0.0`**, les fichiers
> répartis entre les deux, et `latest.yml` manquant — sans la moindre erreur
> affichée. Or sans `latest.yml`, la mise à jour automatique ne fonctionne plus,
> en silence. Le script crée la release une seule fois, puis contrôle le
> résultat.

Le script refuse aussi de publier si `latest.yml` ne correspond pas à
l'installateur présent dans `dist/` — le symptôme d'un `dist/` mélangeant deux
constructions.

Au prochain démarrage, les joueurs voient un bandeau
« Version X prête à être installée ».

---

## Structure du projet

```
src/
├── shared/
│   └── config.js           Configuration : dépôt, serveur, Client ID, endpoints
├── main/                   Processus principal (Node) — aucun accès depuis l'UI
│   ├── main.js             Fenêtre, canaux IPC, mises à jour automatiques
│   ├── preload.js          Pont sécurisé vers l'interface
│   ├── store.js            Préférences et comptes (jetons chiffrés)
│   ├── auth/
│   │   ├── microsoft.js    OAuth2 + PKCE → Xbox Live → XSTS → Minecraft
│   │   ├── offline.js      Comptes hors-ligne (UUID identique au serveur)
│   │   └── index.js        Sélection de compte, renouvellement des jetons
│   └── game/
│       ├── paths.js        Emplacements des dossiers
│       ├── downloader.js   Téléchargement parallèle, SHA1, reprise
│       ├── vanilla.js      Manifest Mojang, bibliothèques, natives, ressources
│       ├── java.js         Runtime Java officiel, détection d'un Java système
│       ├── forge.js        Installation de Forge
│       ├── modpack.js      Synchronisation des mods
│       └── launcher.js     Ligne de commande Java et lancement
└── renderer/               Interface (aucun accès à Node)
    ├── index.html
    ├── styles.css
    ├── app.js
    └── assets/             Logo et décors

tools/
├── build-manifest.js       Génère manifest.json depuis pack/
└── publish-pack.js         Envoie pack/ sur une release GitHub
```

---

## Format du manifest

`manifest.json`, à la racine du dépôt, pilote tout le contenu :

```json
{
  "modpackVersion": "1.1.0",
  "minecraftVersion": "1.20.1",
  "forgeVersion": "47.4.10",

  "server": { "host": "aethoria.omgcraft.fr", "port": 25565 },

  "news": [
    { "title": "Titre", "body": "Texte affiché.", "date": "8 septembre 2026" }
  ],

  "deleteExtraIn": ["mods"],

  "files": [
    {
      "path": "mods/jei-1.20.1.jar",
      "url": "https://github.com/.../releases/download/pack-1.1.0/mods_jei-1.20.1.jar",
      "sha1": "abc123...",
      "size": 1234567,
      "optional": false
    }
  ]
}
```

| Champ | Rôle |
|---|---|
| `minecraftVersion` / `forgeVersion` | Versions installées. Les changer met à jour tous les joueurs. |
| | ⚠️ Le pack actuel exige **Forge ≥ 47.4.10** : les mods `easy_npc` refusent de se charger en dessous. |
| `forgeFullVersion` | Facultatif. Pour les branches Forge au nom irrégulier (1.7.10, 1.8.9). |
| `server` | Adresse affichée et utilisée pour la connexion directe. |
| `links.trailer` | Lien YouTube de la bande-annonce. Vide ou non-YouTube : la vignette est masquée. |
| `links.discord` | Invitation Discord du bouton de la barre du bas. Laissé vide, le bouton est masqué. Le manifest **prime sur l'exe** : un lien expiré se remplace ici, sans redistribuer le launcher. |
| `news` | Actualités de l'écran principal. |
| `deleteExtraIn` | Dossiers nettoyés quand le joueur désactive « conserver mes mods ». |
| `files[].path` | Destination, relative au dossier de jeu. |
| `files[].sha1` | Empreinte vérifiée à chaque lancement. |
| `files[].optional` | `true` : téléchargé uniquement si le joueur l'active. |
| `optionalMods[]` | Liste blanche des mods clients proposés dans « Options de jeu ». Générée par `tools/build-optional-mods.js`. |

Changer une version dans le manifest suffit : **aucun nouveau `.exe` à
distribuer** pour une mise à jour de modpack.

---

## La bande-annonce

L'écran principal affiche une vignette **Voir la bande-annonce**. Le clic ouvre
la vidéo dans le **navigateur du joueur**, pas dans le launcher.

Le lien se règle dans `links.trailer` — au choix dans `manifest.json` (qui
prime) ou dans `src/shared/config.js`. Tous les formats YouTube sont acceptés
(`youtube.com/watch?v=…`, `youtu.be/…`, `/embed/…`). Un lien qui ne pointe pas
vers YouTube est refusé et la vignette reste masquée.

La miniature est embarquée en local (`src/renderer/assets/trailer.jpg`) : elle
s'affiche instantanément et même sans connexion. **Si tu changes de vidéo,
remplace aussi cette image**, sinon la vignette montrera l'ancienne :

```bash
curl -o src/renderer/assets/trailer.jpg   https://i.ytimg.com/vi/IDENTIFIANT_VIDEO/maxresdefault.jpg
```

> **Pourquoi la vidéo ne se lit pas dans le launcher ?** Trois approches ont été
> essayées :
>
> | Approche | Résultat |
> |---|---|
> | `<iframe>` YouTube dans la page | **Erreur 153** — la page est chargée en `file://`, donc sans origine valide |
> | Fenêtre Electron sur `/embed/` | **Erreur 153** également, et `youtube-nocookie` refuse la requête |
> | Fenêtre Electron sur la page `watch` | Fonctionne, mais la bannière de consentement Google masque la vidéo |
>
> Le navigateur du joueur, lui, a déjà ses préférences YouTube : lecture
> immédiate, pleine qualité, plein écran. C'est la solution la plus fiable.

---

## Le lien Discord

Le bouton *Discord* de la barre du bas ouvre `links.discord` dans le navigateur
du joueur. Le lien est lu **en priorité dans le manifest**, et seulement à
défaut dans `src/shared/config.js` : tu peux donc le corriger à tout moment en
modifiant `manifest.json` sur GitHub, sans reconstruire ni rediffuser l'`.exe`.

> ⚠️ **Utilise une invitation permanente.** Par défaut, Discord crée des
> invitations qui expirent au bout de 7 ou 30 jours — un lien mort dans un
> launcher déjà distribué à tes joueurs. Dans Discord :
> clic droit sur le salon → *Inviter des amis* → *Modifier le lien d'invitation*
> → **Expire après : Jamais** et **Nombre max d'utilisations : Illimité**.

Pour vérifier une invitation avant de la diffuser :

```bash
node -e "fetch('https://discord.com/api/v10/invites/TON_CODE').then(r=>r.json()).then(d=>console.log(d.guild?.name, '| expire:', d.expires_at ?? 'jamais'))"
```

---

## Confort du joueur

Quelques automatismes évitent les problèmes les plus courants sur un modpack :

| | |
|---|---|
| **Mémoire adaptée** | Au premier lancement, la mémoire allouée est calculée depuis la machine : la moitié de la RAM physique, plafonnée à 8 Go et plancher à 2 Go. Une machine de 8 Go reçoit 4 Go, une de 16 Go en reçoit 8. Les réglages affichent la RAM détectée et la valeur conseillée. |
| **Espace disque** | Avant de lancer plus d'un gigaoctet de téléchargement, le launcher vérifie qu'il reste ~3 Go. Sans ce contrôle, l'échec survient après plusieurs minutes sur un message incompréhensible. |
| **Débit et temps restant** | La progression affiche le volume, la vitesse et le temps restant, mesurés sur une fenêtre glissante de 4 secondes. |
| **Adresse copiable** | Un clic sur l'adresse du serveur la copie dans le presse-papiers. |
| **Habillage** | Thème médiéval : parchemin pour tout ce qui se lit, pierre et bois pour ce qui encadre, or pour les ornements. Les textures sont procédurales (turbulence SVG en URI de données) : aucune image à charger. Les titres sont en Cinzel, le texte en Spectral, toutes deux embarquées sous licence SIL OFL (94 Ko). |

Le plafond de 8 Go n'est pas une économie : au-delà, les pauses du ramasse-miettes
de Java s'allongent et le jeu devient moins fluide, pas plus.

---

## Dépannage

| Symptôme | Cause et solution |
|---|---|
| « Le pseudo ne peut contenir que… » | 3 à 16 caractères, lettres, chiffres et underscores uniquement — la règle de Mojang. |
| Le joueur arrive au menu principal au lieu du serveur | L'option « Rejoindre directement le serveur » est décochée dans les paramètres. |
| Le joueur est éjecté à la connexion | Le serveur n'est pas en `online-mode=false`, ou un plugin d'authentification exige un mot de passe. |
| Un joueur dit avoir perdu un mod qu'il avait ajouté | Comportement voulu : le dossier `mods` est verrouillé sur la liste officielle. |
| Le jeu se ferme aussitôt (code 1) | Presque toujours un conflit de mods. *Paramètres → Journaux* donne la cause exacte. |
| `OutOfMemoryError` | Augmenter la mémoire dans les paramètres (6 Go pour ce modpack). |
| L'installation de Forge échoue | *Paramètres → Réparer l'installation*, puis relancer. |
| Le joueur est rejeté à la connexion pour mods manquants | Le manifest n'a pas été régénéré après l'ajout d'un mod. |
| Les téléchargements échouent | Vérifier que le dépôt GitHub est **public** et que les URLs du manifest répondent. |

Les journaux de lancement se trouvent dans
`%APPDATA%\.aethoria\launcher-logs` (bouton *Journaux* dans les paramètres).
Le jeton d'accès y est masqué : un joueur peut envoyer ce fichier sans risque.

---

## Notes

- **Sécurité de l'interface** : le renderer n'a aucun accès à Node
  (`contextIsolation`, pas de `nodeIntegration`) et ne peut appeler que les
  canaux listés dans `preload.js`.
- **Jetons** : les jetons d'accès Minecraft ne sont jamais écrits sur le
  disque ; le jeton de renouvellement Microsoft est chiffré (AES-256-GCM) avec
  une clé dérivée de la machine.
