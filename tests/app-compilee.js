'use strict';

/**
 * Ouvre l'application compilee (exe, app macOS, AppImage...) comme un joueur,
 * verifie qu'elle tient 30 secondes sans planter et capture l'ecran.
 *
 *   npx electron tests/app-compilee.js <nom> <executable> [arguments...]
 */

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { app, desktopCapturer, screen } = require('electron');

// Les arguments utiles suivent le nom du script : les options d'Electron
// (--no-sandbox par exemple) le precedent et ne nous concernent pas.
const depart = process.argv.findIndex((a) => a.replace(/\\/g, '/').endsWith('tests/app-compilee.js'));
const [nom, executable, ...args] = process.argv.slice(depart + 1);
const SORTIE = path.join(__dirname, '..', 'verification');
fs.mkdirSync(SORTIE, { recursive: true });

app.whenReady().then(async () => {
  const lignes = [];
  let code = null;
  const enfant = spawn(executable, args, { detached: process.platform !== 'win32' });
  enfant.stdout.on('data', (b) => lignes.push(b.toString()));
  enfant.stderr.on('data', (b) => lignes.push(b.toString()));
  enfant.on('exit', (c, signal) => { code = c ?? signal; });
  enfant.on('error', (err) => { code = err.message; });

  await new Promise((r) => setTimeout(r, 30000));

  try {
    const { width, height } = screen.getPrimaryDisplay().size;
    const [source] = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height } });
    if (source) fs.writeFileSync(path.join(SORTIE, `4-app-${nom}.png`), source.thumbnail.toPNG());
  } catch {
    // capture facultative
  }

  const vivant = code === null;
  const texte = [
    `${vivant ? 'OK   ' : 'ECHEC'} application compilee "${nom}" ${vivant ? 'ouverte et stable apres 30 s' : `fermee (code ${code})`}`,
    ...lignes.join('').split('\n').filter((l) => l.trim()).slice(-25).map((l) => `      ${l}`),
  ].join('\n');
  console.log(texte);
  fs.appendFileSync(path.join(SORTIE, 'resume.txt'), `${texte}\n`);

  if (vivant) {
    if (process.platform === 'win32') spawn('taskkill', ['/PID', String(enfant.pid), '/T', '/F']);
    else try { process.kill(-enfant.pid); } catch { enfant.kill(); }
  }
  setTimeout(() => app.exit(vivant ? 0 : 1), 2000);
});
