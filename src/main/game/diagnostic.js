'use strict';

/**
 * Traduit un plantage de Minecraft en explication utilisable.
 *
 * Sans cela, le joueur ne voit que "Minecraft s'est ferme avec le code 1" et
 * ecrit sur Discord. Le journal, lui, contient presque toujours la cause : il
 * suffit de reconnaitre les formes habituelles et de dire quoi faire.
 *
 * Chaque regle donne un titre, une explication et une marche a suivre. L'ordre
 * compte : les causes precises passent avant les generiques, car un journal
 * declenche souvent plusieurs motifs a la fois.
 */

const REGLES = [
  {
    id: 'memoire',
    motif: /OutOfMemoryError|GC overhead limit exceeded|unable to create new native thread/i,
    titre: 'Mémoire insuffisante',
    cause: 'Le jeu a manqué de mémoire pendant le chargement des mods.',
    solution: 'Ouvre les Réglages du launcher et augmente la mémoire allouée, '
      + 'sans dépasser la moitié de celle de ta machine.',
  },
  {
    id: 'pilote-graphique',
    motif: /Failed to create window|GLFW error|Pixel format not accelerated|OpenGL 3\.2|WGL_ARB|EXCEPTION_ACCESS_VIOLATION.*(nvoglv|atio|ig[0-9]|amdvlk)/i,
    titre: 'Problème de carte graphique',
    cause: 'Ta carte graphique a refusé de démarrer le jeu, ou son pilote a planté.',
    solution: 'Mets à jour le pilote de ta carte graphique depuis le site du '
      + 'constructeur (NVIDIA, AMD ou Intel), puis relance.',
  },
  {
    id: 'natives',
    motif: /UnsatisfiedLinkError|Failed to locate library|no lwjgl.* in java\.library\.path/i,
    titre: 'Fichiers du jeu abîmés',
    cause: 'Des bibliothèques système du jeu sont manquantes ou corrompues.',
    solution: 'Ouvre les Réglages et utilise "Réparer l’installation". '
      + 'Tes mondes et tes captures sont conservés.',
  },
  {
    id: 'mod-manquant',
    motif: /Missing or unsupported mandatory dependencies|Mod ID: '[^']+', Requested by/i,
    titre: 'Un mod attend une dépendance',
    cause: 'Un mod du pack réclame un autre mod ou une version de Forge différente.',
    solution: 'Préviens l’équipe du serveur : le modpack doit être corrigé. '
      + 'En attendant, "Réparer l’installation" peut suffire.',
  },
  {
    id: 'mixin',
    motif: /Mixin apply(ing)? failed|MixinApplyError|InvalidMixinException|CrashReportExtender/i,
    titre: 'Conflit entre deux mods',
    cause: 'Deux mods modifient la même partie du jeu et se sont contredits.',
    solution: 'Si tu as activé des mods dans "Options", désactive-les un par un '
      + 'pour trouver le fautif. Sinon, préviens l’équipe du serveur.',
  },
  {
    id: 'fichier-verrouille',
    motif: /being used by another process|AccessDeniedException|FileSystemException.*mods/i,
    titre: 'Un fichier est verrouillé',
    cause: 'Une autre copie du jeu tourne encore, ou ton antivirus bloque un fichier.',
    solution: 'Ferme toutes les fenêtres de Minecraft, puis relance. Si cela '
      + 'persiste, autorise le dossier du jeu dans ton antivirus.',
  },
  {
    id: 'java',
    motif: /UnsupportedClassVersionError|has been compiled by a more recent version of the Java|Unrecognized option/i,
    titre: 'Version de Java incompatible',
    cause: 'Le Java utilisé ne convient pas à cette version du jeu.',
    solution: 'Dans les Réglages, remets Java sur "Auto" : le launcher '
      + 'telechargera la bonne version tout seul.',
  },
  {
    id: 'disque-plein',
    motif: /No space left on device|There is not enough space on the disk/i,
    titre: 'Disque plein',
    cause: 'Il n’y a plus assez de place pour écrire les fichiers du jeu.',
    solution: 'Libère quelques gigaoctets, ou change le dossier du jeu dans les Réglages.',
  },
];

/**
 * Analyse la fin d'un journal de jeu.
 * Renvoie null si rien n'est reconnu : mieux vaut le message brut qu'une
 * explication inventee qui enverrait le joueur sur une fausse piste.
 */
function analyser(journal, codeSortie) {
  const texte = String(journal || '');

  for (const regle of REGLES) {
    if (!regle.motif.test(texte)) continue;
    return {
      id: regle.id,
      titre: regle.titre,
      cause: regle.cause,
      solution: regle.solution,
      // On remonte la ligne reconnue : elle aide l'equipe du serveur quand le
      // joueur transmet une capture.
      extrait: extraireLigne(texte, regle.motif),
    };
  }

  // Le code 1 sans motif reconnu vient presque toujours d'un mod : c'est plus
  // utile a dire que de repeter le code de sortie.
  if (codeSortie === 1 && /Exception|Error/i.test(texte)) {
    return {
      id: 'inconnu',
      titre: 'Le jeu s’est arrêté pendant le chargement',
      cause: 'Un mod a probablement provoqué une erreur.',
      solution: 'Ouvre les Réglages puis "Journaux", et transmets le dernier '
        + 'fichier à l’équipe du serveur.',
      extrait: extraireLigne(texte, /(Caused by|Exception in thread|[A-Za-z.]*(Exception|Error):)/),
    };
  }

  return null;
}

/** Premiere ligne correspondant au motif, raccourcie pour rester lisible. */
function extraireLigne(texte, motif) {
  for (const ligne of texte.split(/\r?\n/)) {
    if (motif.test(ligne)) {
      const propre = ligne.replace(/^\[[^\]]*\]\s*/g, '').trim();
      return propre.length > 160 ? `${propre.slice(0, 157)}...` : propre;
    }
  }
  return null;
}

module.exports = { analyser, REGLES };
