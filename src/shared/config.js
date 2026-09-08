'use strict';

/**
 * Configuration statique du launcher Aethoria.
 *
 * Tout ce qui est susceptible de changer souvent (version de Minecraft, version
 * de Forge, liste des mods) vit dans le manifest distant hebergé sur GitHub :
 * on peut ainsi mettre a jour le modpack sans recompiler ni redistribuer l'exe.
 * Les valeurs ci-dessous ne servent que de repli si le manifest est injoignable.
 */
module.exports = {
  // Identite du launcher
  appName: 'Aethoria',
  launcherName: 'AethoriaLauncher',

  // Depot GitHub servant a la fois le manifest du modpack et les mises a jour
  // du launcher (via GitHub Releases / electron-updater).
  github: {
    owner: 'AETHORIA_OWNER',   // <-- a remplacer par ton compte/organisation GitHub
    repo: 'aethoria-launcher', // <-- a remplacer par le nom de ton depot
    branch: 'main',
  },

  // URL du manifest du modpack. Sert de source de verite pour la version du
  // jeu, la version de Forge et la liste des mods.
  get manifestUrl() {
    return `https://raw.githubusercontent.com/${this.github.owner}/${this.github.repo}/${this.github.branch}/manifest.json`;
  },

  // Serveur de jeu : affiche dans l'UI et utilise pour le bouton "rejoindre
  // directement le serveur" au lancement.
  server: {
    host: 'play.aethoria.fr', // <-- a remplacer par l'IP/domaine de ton serveur
    port: 25565,
  },

  // Client ID Azure pour l'authentification Microsoft.
  // Voir README.md, section "Authentification Microsoft" : il faut enregistrer
  // une application Azure AD puis demander l'acces a l'API Minecraft.
  msalClientId: '00000000-0000-0000-0000-000000000000',

  // Repli utilise seulement si le manifest distant est injoignable.
  fallback: {
    minecraftVersion: '1.20.1',
    forgeVersion: '47.4.10',
    mods: [],
  },

  // Parametres par defaut du jeu
  defaults: {
    minRamMb: 2048,
    maxRamMb: 4096,
    jvmArgs: [
      '-XX:+UnlockExperimentalVMOptions',
      '-XX:+UseG1GC',
      '-XX:G1NewSizePercent=20',
      '-XX:G1ReservePercent=20',
      '-XX:MaxGCPauseMillis=50',
      '-XX:G1HeapRegionSize=32M',
    ],
    closeOnLaunch: false,
  },

  // Endpoints officiels Mojang / Microsoft
  endpoints: {
    versionManifest: 'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json',
    assets: 'https://resources.download.minecraft.net',
    javaRuntime: 'https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json',
    forgeMaven: 'https://maven.minecraftforge.net',
    xblAuth: 'https://user.auth.xboxlive.com/user/authenticate',
    xstsAuth: 'https://xsts.auth.xboxlive.com/xsts/authorize',
    mcLogin: 'https://api.minecraftservices.com/authentication/login_with_xbox',
    mcProfile: 'https://api.minecraftservices.com/minecraft/profile',
    mcEntitlements: 'https://api.minecraftservices.com/entitlements/mcstore',
  },
};
