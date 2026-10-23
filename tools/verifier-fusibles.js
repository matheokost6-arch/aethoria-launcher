#!/usr/bin/env node
'use strict';

/**
 * Affiche les fusibles Electron d'un executable construit et echoue si l'un
 * d'eux n'a pas la valeur attendue.
 *
 *   node tools/verifier-fusibles.js dist/win-unpacked/Aethoria.exe
 */

const ATTENDU = {
  RunAsNode: false,
  EnableCookieEncryption: true,
  EnableNodeOptionsEnvironmentVariable: false,
  EnableNodeCliInspectArguments: false,
  EnableEmbeddedAsarIntegrityValidation: true,
  OnlyLoadAppFromAsar: true,
  GrantFileProtocolExtraPrivileges: false,
};

async function main() {
  const exe = process.argv[2];
  if (!exe) throw new Error('Indique l’exécutable à contrôler.');
  const { getCurrentFuseWire, FuseV1Options } = await import('@electron/fuses');
  const actuel = await getCurrentFuseWire(exe);
  let erreurs = 0;
  for (const [nom, voulu] of Object.entries(ATTENDU)) {
    const etat = actuel[FuseV1Options[nom]]; // 49 = actif, 48 = coupe
    const ok = etat === (voulu ? 49 : 48);
    if (!ok) erreurs += 1;
    console.log(`${ok ? 'OK   ' : 'ECHEC'} ${nom} = ${etat === 49 ? 'on' : etat === 48 ? 'off' : etat}`);
  }
  if (erreurs) process.exit(1);
}

main().catch((err) => {
  console.error(`Échec : ${err.message}`);
  process.exit(1);
});
