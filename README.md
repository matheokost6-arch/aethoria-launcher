# Launcher Aethoria

Launcher Minecraft du serveur **Aethoria** : modpack Forge 1.20.1 (71 mods),
connexion **compte Microsoft** ou **hors-ligne**, mise à jour automatique du
modpack et du launcher, distribué en `.exe` pour Windows.

---

## Sommaire

1. [Ce que fait le launcher](#ce-que-fait-le-launcher)
2. [Démarrage rapide](#démarrage-rapide)
3. [Configuration obligatoire](#configuration-obligatoire)
   - [Dépôt GitHub](#1-dépôt-github)
   - [Adresse du serveur](#2-adresse-du-serveur)
   - [Authentification Microsoft](#3-authentification-microsoft)
4. [Publier le modpack](#publier-le-modpack)
5. [Construire le .exe](#construire-le-exe)
6. [Mettre à jour le launcher chez les joueurs](#mettre-à-jour-le-launcher-chez-les-joueurs)
7. [Structure du projet](#structure-du-projet)
8. [Format du manifest](#format-du-manifest)
9. [Dépannage](#dépannage)

---

## Ce que fait le launcher

À chaque clic sur **JOUER**, le launcher exécute la chaîne suivante :

1. **Compte** — vérifie le compte sélectionné et renouvelle le jeton Microsoft si besoin.
2. **Manifest** — récupère `manifest.json` sur GitHub (versions du jeu et liste des mods).
3. **Java** — télécharge le runtime Java officiel de Mojang correspondant à la version.
   Le joueur n'a **rien à installer**.
4. **Forge** — installe Forge via l'installateur officiel, en mode silencieux.
5. **Jeu** — télécharge le client, les bibliothèques, les natives et les ressources,
   en vérifiant le SHA1 de chaque fichier.
6. **Modpack** — synchronise les mods : ajoute les nouveaux, remplace les modifiés,
   supprime ceux qui ont été retirés du pack.
7. **Lancement** — construit la ligne de commande Java et démarre Minecraft.

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

Trois réglages sont à faire **avant** de distribuer le launcher.

### 1. Dépôt GitHub

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
  host: 'play.aethoria.fr',   // ← l'IP ou le domaine de ton serveur
  port: 25565,
},
```

Cette adresse est affichée sur l'écran principal et sert au réglage
« rejoindre directement le serveur au lancement ».

### 3. Authentification Microsoft

La connexion Microsoft demande un **Client ID Azure**. Sans lui, seule la
connexion hors-ligne fonctionne (le launcher affiche un message explicite).

**Étape A — créer l'application Azure**

1. Va sur [portal.azure.com](https://portal.azure.com) → *Microsoft Entra ID* →
   *Inscriptions d'applications* → **Nouvelle inscription**.
2. Nom : `Aethoria Launcher`.
3. Types de comptes pris en charge :
   **« Comptes Microsoft personnels uniquement »**.
4. Ne mets pas d'URI de redirection à cette étape, puis **Inscrire**.
5. Dans *Authentification* → **Ajouter une plateforme** →
   *Applications mobiles et de bureau* → coche l'URI :
   ```
   https://login.microsoftonline.com/common/oauth2/nativeclient
   ```
6. Toujours dans *Authentification*, vérifie que
   **« Autoriser les flux de clients publics »** est sur **Oui**.
7. Copie l'**ID d'application (client)** depuis la page *Vue d'ensemble*.

**Étape B — demander l'accès à l'API Minecraft**

Microsoft restreint l'accès à l'API d'authentification Minecraft. Une
application non approuvée reçoit une erreur au moment du
`login_with_xbox`. Remplis le formulaire officiel :

<https://help.minecraft.net/hc/en-us/articles/16254801392141>

Indique qu'il s'agit d'un launcher pour un serveur communautaire et donne ton
Client ID. La réponse arrive généralement sous quelques jours.

**Étape C — renseigner le Client ID**

```js
// src/shared/config.js
msalClientId: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
```

> **Sécurité** : ce Client ID n'est pas un secret. Le launcher est un « client
> public » et utilise PKCE ; aucun mot de passe Microsoft ne transite par le
> launcher, la saisie se fait dans une fenêtre Microsoft officielle.

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
node tools/build-manifest.js --tag pack-1.1.0 --mc 1.20.1 --forge 47.3.0

# 3. Publier le manifest : les joueurs reçoivent la mise à jour au prochain lancement
git add manifest.json && git commit -m "Modpack 1.1.0" && git push
```

Pour une mise à jour ultérieure, garde le même tag et ajoute `--clobber` à
l'étape 1, ou crée un nouveau tag (`pack-1.2.0`) et régénère le manifest avec.

### Mods ajoutés par les joueurs

Par défaut, le launcher **ne supprime que les mods qu'il a lui-même installés**
et qui ont disparu du pack. Un joueur peut donc ajouter ses propres mods
clients (minimap, shaders) sans les perdre à chaque mise à jour.

Si tu veux au contraire un dossier `mods` strictement identique pour tout le
monde, le joueur décoche « Conserver les mods que j'ajoute moi-même » — ou tu
imposes le comportement en modifiant `keepExtraMods` dans
`src/main/store.js`.

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
# 1. Incrémenter la version
npm version patch          # 1.0.0 → 1.0.1

# 2. Construire et publier
set GH_TOKEN=ton_token_github   # (Windows ; export GH_TOKEN=... ailleurs)
npm run publish
```

`npm run publish` crée une release brouillon avec l'installateur et le fichier
`latest.yml`. **Publie la release** depuis GitHub : au prochain démarrage, les
joueurs voient un bandeau « Version X prête à être installée ».

Le token GitHub se crée sur
<https://github.com/settings/tokens> avec la portée `repo`.

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
  "forgeVersion": "47.3.0",

  "server": { "host": "play.aethoria.fr", "port": 25565 },

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
| `forgeFullVersion` | Facultatif. Pour les branches Forge au nom irrégulier (1.7.10, 1.8.9). |
| `server` | Adresse affichée et utilisée pour la connexion directe. |
| `news` | Actualités de l'écran principal. |
| `deleteExtraIn` | Dossiers nettoyés quand le joueur désactive « conserver mes mods ». |
| `files[].path` | Destination, relative au dossier de jeu. |
| `files[].sha1` | Empreinte vérifiée à chaque lancement. |
| `files[].optional` | `true` : téléchargé uniquement si le joueur l'active. |

Changer une version dans le manifest suffit : **aucun nouveau `.exe` à
distribuer** pour une mise à jour de modpack.

---

## Dépannage

| Symptôme | Cause et solution |
|---|---|
| « Aucun Client ID Azure n'est configuré » | Voir [Authentification Microsoft](#3-authentification-microsoft). |
| « Ce compte Microsoft n'a pas de profil Xbox » | Le joueur doit se connecter une fois sur minecraft.net, puis réessayer. |
| « Ce compte ne possède pas Minecraft: Java Edition » | Compte Microsoft sans le jeu : utiliser la connexion hors-ligne. |
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

- **Mode hors-ligne** : l'UUID est calculé comme le fait un serveur en
  `online-mode=false` (UUID v3 sur `OfflinePlayer:<pseudo>`). L'inventaire et
  la progression d'un joueur sont donc conservés d'une session à l'autre. Le
  serveur doit être configuré avec `online-mode=false` pour accepter ces
  connexions ; pense à protéger les pseudos du staff avec un plugin
  d'authentification.
- **Sécurité de l'interface** : le renderer n'a aucun accès à Node
  (`contextIsolation`, pas de `nodeIntegration`) et ne peut appeler que les
  canaux listés dans `preload.js`.
- **Jetons** : les jetons d'accès Minecraft ne sont jamais écrits sur le
  disque ; le jeton de renouvellement Microsoft est chiffré (AES-256-GCM) avec
  une clé dérivée de la machine.
