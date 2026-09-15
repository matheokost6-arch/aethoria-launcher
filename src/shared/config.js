'use strict';

/**
 * Configuration statique du launcher Aethoria.
 *
 * Tout ce qui change souvent (versions de Minecraft et de Forge, liste des
 * mods, liens, actualites) vit dans le manifest distant : le modpack se met a
 * jour sans redistribuer l'exe. Les valeurs ci-dessous ne servent que de repli.
 */
module.exports = {
  appName: 'Aethoria',
  launcherName: 'AethoriaLauncher',

  github: {
    owner: 'matheokost6-arch',
    // Depot du code source, prive : le launcher n'y accede jamais.
    repo: 'aethoria-launcher',
    // Depot de distribution, public : manifest, mods et installateur.
    dist: 'aethoria',
    branch: 'main',
  },

  // Propose au joueur quand la mise a jour automatique echoue.
  get downloadUrl() {
    return `https://github.com/${this.github.owner}/${this.github.dist}/releases/latest/download/Aethoria-Setup.exe`;
  },

  get manifestUrl() {
    return `https://raw.githubusercontent.com/${this.github.owner}/${this.github.dist}/${this.github.branch}/manifest.json`;
  },

  server: {
    host: 'aethoria.omgcraft.fr',
    port: 25565,
  },

  // Un lien vide masque son bouton.
  links: {
    discord: 'https://discord.gg/Z6du2srwW',
    trailer: 'https://www.youtube.com/watch?v=WW6Dqu7jxkQ',
  },

  // Consigne affichee au choix du pseudo. Le launcher ne gere aucun mot de
  // passe : c'est AuthMe, sur le serveur, qui protege les pseudos.
  authNotice: {
    title: 'Protège ton pseudo',
    body: 'À ta toute première connexion sur le serveur, tape dans le chat :\n'
      + '/register motdepasse motdepasse\n'
      + 'Puis à chaque fois que tu reviens :\n'
      + '/login motdepasse\n'
      + 'Sans cela, n’importe qui peut jouer sous ton pseudo.',
  },

  // Utilise seulement si le manifest distant est injoignable.
  fallback: {
    minecraftVersion: '1.20.1',
    forgeVersion: '47.4.10',
  },

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
    // Le jeu s'ouvre sur le menu Aethoria (mod aethoriamenu) ; la connexion
    // directe reste proposee en option.
    autoJoinServer: false,
    launcherBehavior: 'keep',     // pendant la partie : keep, minimize ou close
    gameResolution: 'default',    // default, 1280x720, 1600x900, 1920x1080, fullscreen
  },

  endpoints: {
    versionManifest: 'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json',
    assets: 'https://resources.download.minecraft.net',
    javaRuntime: 'https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json',
    forgeMaven: 'https://maven.minecraftforge.net',
  },
};
