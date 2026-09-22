'use strict';

/**
 * Parcours complet d'un joueur, sur la machine ou il tourne :
 *   1. le launcher s'ouvre sans erreur ;
 *   2. le joueur choisit son pseudo, qui est enregistre de facon definitive ;
 *   3. il clique sur JOUER : Java, Forge, Minecraft et le modpack s'installent ;
 *   4. Minecraft demarre jusqu'au menu.
 *
 * Lance par .github/workflows/verification.yml sur Windows, Linux et macOS :
 *   npx electron tests/verification.js [--no-sandbox]
 * Resultats dans verification/ : resume, journaux et captures d'ecran.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow, desktopCapturer, screen } = require('electron');

const PSEUDO = process.env.AETHORIA_PSEUDO || 'major316';
const SORTIE = path.join(__dirname, '..', 'verification');
const DELAI_JEU_MS = 25 * 60 * 1000;

fs.mkdirSync(SORTIE, { recursive: true });
const resume = [];
let echecs = 0;
const debut = Date.now();
const t = () => `${String(Math.round((Date.now() - debut) / 1000)).padStart(4)} s`;
const noter = (texte) => {
  console.log(`[${t()}] ${texte}`);
  resume.push(`[${t()}] ${texte}`);
};
const verifier = (nom, condition, detail = '') => {
  noter(`${condition ? 'OK   ' : 'ECHEC'} ${nom}${detail ? ` : ${detail}` : ''}`);
  if (!condition) echecs += 1;
  return condition;
};
const attendre = (ms) => new Promise((r) => setTimeout(r, ms));

async function attendreQue(test, delai, pas = 1000) {
  const fin = Date.now() + delai;
  while (Date.now() < fin) {
    if (await test()) return true;
    await attendre(pas);
  }
  return false;
}

/** Capture de tout l'ecran (fenetre du jeu comprise). */
async function captureEcran(nom) {
  try {
    const { width, height } = screen.getPrimaryDisplay().size;
    const [source] = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height } });
    if (source && !source.thumbnail.isEmpty()) fs.writeFileSync(path.join(SORTIE, `${nom}.png`), source.thumbnail.toPNG());
  } catch (err) {
    noter(`(capture d'ecran impossible : ${err.message})`);
  }
}

const erreursInterface = [];
app.on('web-contents-created', (_e, contents) => {
  contents.on('console-message', (event) => {
    if (event.level === 'error' || event.level === 3) erreursInterface.push(event.message);
  });
});

noter(`Systeme : ${os.type()} ${os.release()} ${process.arch}, ${Math.round(os.totalmem() / 2 ** 30)} Go de RAM`);
require(path.join(__dirname, '..', 'src', 'main', 'main.js'));
const launcher = require(path.join(__dirname, '..', 'src', 'main', 'game', 'launcher'));
const paths = require(path.join(__dirname, '..', 'src', 'main', 'game', 'paths'));
const store = require(path.join(__dirname, '..', 'src', 'main', 'store'));

app.whenReady().then(async () => {
  let win;
  try {
    await attendreQue(() => (win = BrowserWindow.getAllWindows()[0]), 30000, 200);
    await new Promise((r) => (win.webContents.isLoading() ? win.webContents.once('did-finish-load', r) : r()));
    await attendre(4000);
    const js = (code) => win.webContents.executeJavaScript(code);
    // La capture echoue sur une machine sans carte graphique : elle ne doit
    // pas faire echouer le test lui-meme.
    const capture = async (nom) => {
      try {
        fs.writeFileSync(path.join(SORTIE, `${nom}.png`), (await win.webContents.capturePage()).toPNG());
      } catch (err) {
        noter(`(capture "${nom}" impossible : ${err.message})`);
      }
    };

    // 1. Ouverture
    const vue = await js(`!document.getElementById('view-main').hidden ? 'accueil'
      : !document.getElementById('view-login').hidden ? 'pseudo' : 'aucune'`);
    verifier('le launcher s affiche', vue !== 'aucune', `ecran ${vue}`);
    await capture('1-ouverture');

    // 2. Pseudo
    if (vue === 'pseudo') {
      await js(`document.getElementById('input-pseudo').value = ${JSON.stringify(PSEUDO)};
        document.getElementById('form-pseudo').requestSubmit(); 1`);
      await attendreQue(() => js("!document.getElementById('login-confirm').hidden"), 10000, 300);
      await js("document.getElementById('btn-confirm').click(); 1");
      await attendreQue(() => js("!document.getElementById('view-main').hidden"), 15000, 300);
    }
    verifier('pseudo enregistre et accueil affiche', await js(`document.getElementById('account-name').textContent`) === PSEUDO);
    verifier('pseudo definitif (hors du dossier du launcher)', store.getAccount()?.name === PSEUDO);
    await capture('2-accueil');

    // 3 et 4. JOUER : installation complete puis demarrage du jeu
    noter('clic sur JOUER');
    const clic = Date.now();
    await js("document.getElementById('btn-play').click(); 1");
    let dernierMessage = '';
    const suivi = setInterval(async () => {
      const ligne = await js("document.getElementById('launch-line').textContent + ' ' + (document.getElementById('progress-detail')?.textContent || '')").catch(() => '');
      if (ligne && ligne !== dernierMessage) {
        dernierMessage = ligne;
        noter(`  ${ligne.trim().slice(0, 140)}`);
      }
    }, 5000);

    // Seul le journal de CETTE partie compte : celui d'une partie precedente
    // contient deja les marques d'un menu atteint.
    const journal = () => {
      try {
        const fichier = path.join(paths.root, 'logs', 'latest.log');
        return fs.statSync(fichier).mtimeMs >= clic ? fs.readFileSync(fichier, 'utf8') : '';
      } catch {
        return '';
      }
    };
    let etat = 'attente';
    await attendreQue(async () => {
      // Le son ne demarre pas sur une machine sans carte son : la fin du
      // chargement des textures du menu fait aussi foi.
      if (/Sound engine started|Created: \d+x\d+x\d+ minecraft:textures\/atlas\/gui\.png-atlas/.test(journal())) {
        etat = 'menu';
        return true;
      }
      const ligne = await js("document.getElementById('launch-line').className").catch(() => '');
      if (/is-error/.test(ligne)) { etat = 'erreur'; return true; }
      return false;
    }, DELAI_JEU_MS, 3000);
    clearInterval(suivi);

    if (etat === 'menu') await attendre(20000); // laisse le menu s'afficher pour la capture
    await captureEcran('3-jeu');
    await capture('3-launcher-pendant-le-jeu');
    const erreurLauncher = etat === 'erreur' ? await js("document.getElementById('launch-line').textContent") : '';
    verifier('Minecraft demarre jusqu au menu', etat === 'menu', etat === 'menu' ? '' : (erreurLauncher || 'delai depasse'));

    const log = journal();
    fs.writeFileSync(path.join(SORTIE, 'minecraft-latest.log'), log);
    const dossierMods = path.join(paths.root, 'mods');
    if (fs.existsSync(dossierMods)) noter(`  ${fs.readdirSync(dossierMods).filter((m) => m.endsWith('.jar')).length} mods installes`);
    // Plantages survenus pendant ce test uniquement.
    const dossierCrash = path.join(paths.root, 'crash-reports');
    const crash = fs.existsSync(dossierCrash)
      ? fs.readdirSync(dossierCrash).filter((nom) => fs.statSync(path.join(dossierCrash, nom)).mtimeMs >= clic) : [];
    verifier('aucun rapport de plantage', crash.length === 0, crash.join(', '));
    for (const nom of crash) fs.copyFileSync(path.join(paths.root, 'crash-reports', nom), path.join(SORTIE, nom));

    verifier('aucune erreur dans l interface', erreursInterface.length === 0, erreursInterface.slice(0, 3).join(' | '));
  } catch (err) {
    verifier('deroulement du test', false, err.stack);
  }

  launcher.stop();
  noter(echecs ? `=== ${echecs} ECHEC(S) ===` : '=== TOUT EST OK ===');
  fs.writeFileSync(path.join(SORTIE, 'resume.txt'), `${resume.join('\n')}\n`);
  setTimeout(() => app.exit(echecs ? 1 : 0), 3000);
});
