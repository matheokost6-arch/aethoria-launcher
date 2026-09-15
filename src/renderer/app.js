'use strict';

/* ------------------------------------------------------------------ *
 *  Aethoria Launcher — interface
 *  Aucun accès à Node ici : tout passe par le pont window.aethoria.
 * ------------------------------------------------------------------ */

const api = window.aethoria;
const $ = (id) => document.getElementById(id);

// Dernières lignes du jeu conservées pour le rapport de plantage.
const MAX_LOG_LINES = 200;

const state = {
  info: null,         // app:info, complété par modpack:info
  settings: null,
  account: null,
  system: null,       // machine du joueur, pour le rapport de plantage
  game: 'idle',       // idle | launching | running
  lastExit: null,
  logs: [],
  server: null,       // dernier état connu du serveur
  watchServer: false, // prévenir le joueur quand le serveur revient
  serverTimer: null,
  backdropTimer: null,
};

/* ------------------------------------------------------------------ *
 *  Utilitaires
 * ------------------------------------------------------------------ */

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function formatBytes(bytes) {
  if (!bytes) return '0 o';
  const units = ['o', 'Ko', 'Mo', 'Go'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(value < 10 && unit > 0 ? 1 : 0).replace('.', ',')} ${units[unit]}`;
}

function formatDuration(seconds) {
  if (seconds < 60) return `${seconds} s`;
  const min = Math.floor(seconds / 60);
  if (min < 60) return seconds % 60 ? `${min} min ${seconds % 60} s` : `${min} min`;
  return `${Math.floor(min / 60)} h ${min % 60} min`;
}

/** Temps de jeu : "45 min", "12 h 05". */
function formatPlaytime(seconds) {
  const min = Math.floor(seconds / 60);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')}`;
}

const formatRam = (mb) => `${(mb / 1024).toFixed(1).replace('.0', '').replace('.', ',')} Go`;
const plural = (n, word) => `${n} ${word}${n > 1 ? 's' : ''}`;
const dialogs = () => [...document.querySelectorAll('.drawer, .modal')];

function toast(message, kind = 'info', duration = 6000) {
  const el = document.createElement('div');
  el.className = `toast toast--${kind}`;
  el.textContent = message;
  $('toasts').appendChild(el);
  setTimeout(() => {
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), 200);
  }, duration);
}

async function openLink(url, label) {
  if (!url) return;
  try {
    await api.folders.external(url);
  } catch (err) {
    toast(`Impossible d’ouvrir ${label} : ${err.message}`, 'error');
  }
}

/** Identifiant d'une vidéo YouTube, ou null si le lien n'y mène pas. */
function youtubeId(url) {
  const match = String(url || '').match(
    /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/,
  );
  return match ? match[1] : null;
}

async function saveSettings(patch) {
  try {
    state.settings = { ...state.settings, ...(await api.settings.save(patch)) };
  } catch (err) {
    toast(`Réglage non enregistré : ${err.message}`, 'error', 8000);
    throw err;
  }
}

/* ------------------------------------------------------------------ *
 *  Apparence : fond d'écran et mode léger
 * ------------------------------------------------------------------ */

function applyAppearance() {
  const { background, lightMode } = state.settings;
  document.body.classList.toggle('light-mode', lightMode);

  const layers = [...document.querySelectorAll('.backdrop__layer')];
  clearInterval(state.backdropTimer);
  const fixed = layers.find((layer) => layer.dataset.bg === background);
  layers.forEach((layer, i) => layer.classList.toggle('is-visible', fixed ? layer === fixed : i === 0));

  // Le défilement est coupé en mode léger : sans fondu, il deviendrait saccadé.
  if (fixed || lightMode) return;
  let index = 0;
  state.backdropTimer = setInterval(() => {
    layers[index].classList.remove('is-visible');
    index = (index + 1) % layers.length;
    layers[index].classList.add('is-visible');
  }, 12000);
}

/* ------------------------------------------------------------------ *
 *  Pseudo
 * ------------------------------------------------------------------ */

function showView(name) {
  $('view-login').hidden = name !== 'login';
  $('view-main').hidden = name !== 'main';
}

function showLoginError(message) {
  $('login-error').textContent = message || '';
  $('login-error').hidden = !message;
}

function applyAccount(account) {
  state.account = account;
  if (!account) {
    showView('login');
    $('input-pseudo').focus();
    return;
  }
  $('account-name').textContent = account.name;
  $('account-avatar').src = account.avatarUrl || 'assets/icon.png';
  showView('main');
  loadModpackInfo();
  refreshPlaytime();
}

/** Le pseudo est définitif : on le fait confirmer avant de l'enregistrer. */
function showConfirm(pseudo) {
  $('form-pseudo').hidden = Boolean(pseudo);
  $('login-confirm').hidden = !pseudo;
  $('confirm-pseudo').textContent = pseudo || '';
  if (!pseudo) $('input-pseudo').focus();
}

async function submitPseudo(event) {
  event.preventDefault();
  const button = $('btn-login');
  showLoginError('');
  button.disabled = true;
  try {
    showConfirm(await api.account.valider($('input-pseudo').value));
  } catch (err) {
    showLoginError(err.message);
  } finally {
    button.disabled = false;
  }
}

async function confirmPseudo() {
  const button = $('btn-confirm');
  button.disabled = true;
  try {
    applyAccount(await api.account.connecter($('confirm-pseudo').textContent));
  } catch (err) {
    showConfirm(null);
    showLoginError(err.message);
  } finally {
    button.disabled = false;
  }
}

/** Consigne AuthMe : les lignes commençant par "/" sont des commandes à recopier. */
function renderAuthNotice(notice) {
  $('auth-notice').hidden = !notice?.body;
  if (!notice?.body) return;
  $('auth-notice-title').textContent = notice.title || '';
  $('auth-notice-text').innerHTML = String(notice.body)
    .split('\n')
    .map((line) => (line.trim().startsWith('/')
      ? `<code class="notice__cmd">${escapeHtml(line.trim())}</code>`
      : escapeHtml(line)))
    .join('\n');
}

async function refreshPlaytime() {
  try {
    const stats = await api.stats.get();
    const label = $('account-playtime');
    label.textContent = stats.totalSeconds >= 60 ? `${formatPlaytime(stats.totalSeconds)} de jeu` : 'Ton pseudo';
    label.title = stats.lastSession
      ? `Dernière session : ${formatPlaytime(stats.lastSession.seconds)}, le ${new Date(stats.lastSession.endedAt).toLocaleDateString('fr-FR')}`
      : '';
  } catch {
    // information d'agrément
  }
}

/* ------------------------------------------------------------------ *
 *  Accueil
 * ------------------------------------------------------------------ */

/** Actualités, avec un badge sur celles que le joueur n'a jamais vues. */
function renderNews(items) {
  const list = $('news-list');
  if (!items.length) {
    list.innerHTML = '<li class="news__empty">Aucune actualité pour le moment.</li>';
    return;
  }
  const seen = state.settings.seenNews || [];
  const shown = items.slice(0, 12).map((item) => ({ ...item, key: `${item.title}|${item.date || ''}` }));

  list.innerHTML = shown.map((item) => `
    <li class="news__item">
      <h3>${escapeHtml(item.title || 'Sans titre')}${seen.includes(item.key) ? '' : '<span class="badge">Nouveau</span>'}</h3>
      <p>${escapeHtml(item.body || '')}</p>
      ${item.date ? `<time>${escapeHtml(item.date)}</time>` : ''}
    </li>`).join('');

  const unseen = shown.map((item) => item.key).filter((key) => !seen.includes(key));
  if (unseen.length) saveSettings({ seenNews: [...seen, ...unseen] }).catch(() => {});
}

function renderLinks(links = {}) {
  $('btn-discord').hidden = !links.discord;
  $('btn-crash-discord').hidden = !links.discord;
  $('btn-trailer').hidden = !youtubeId(links.trailer);
}

function setLaunchLine(html, kind = '') {
  const line = $('launch-line');
  line.innerHTML = html;
  line.className = `launch__line${kind ? ` is-${kind}` : ''}`;
}

function showIdleLine() {
  const host = state.info?.server?.host;
  if (state.settings?.autoJoinServer && host) {
    setLaunchLine(`Connexion directe à <strong>${escapeHtml(host)}</strong>`);
  } else {
    setLaunchLine('Le jeu s’ouvre sur le <strong>menu Aethoria</strong>');
  }
}

/** Ce que le prochain lancement devra télécharger. */
async function refreshPending() {
  const sub = $('launch-sub');
  let pending = null;
  try {
    pending = await api.modpack.pending();
  } catch {
    // estimation facultative
  }
  if (!pending || state.game !== 'idle') {
    sub.hidden = true;
    return;
  }
  sub.hidden = false;
  if (pending.firstInstall) {
    sub.textContent = 'Première partie : Minecraft et les mods seront téléchargés (environ 1,3 Go).';
  } else if (pending.count) {
    sub.textContent = `Mise à jour du modpack : ${plural(pending.count, 'fichier')} (${formatBytes(pending.bytes)}) à télécharger.`;
  } else {
    sub.textContent = 'Tout est à jour, prêt à jouer.';
  }
}

function serverAddress() {
  const { host, port } = state.info.server;
  return port === 25565 ? host : `${host}:${port}`;
}

async function copyServerAddress() {
  try {
    await navigator.clipboard.writeText(serverAddress());
    toast(`Adresse copiée : ${serverAddress()}`, 'success', 3000);
  } catch {
    toast('Copie impossible.', 'error', 3000);
  }
}

async function loadModpackInfo() {
  try {
    const info = await api.modpack.info();
    Object.assign(state.info, {
      server: info.server,
      links: info.links,
      authNotice: info.authNotice,
      modpackVersion: info.modpackVersion,
      forgeVersion: info.forgeVersion,
    });

    $('pack-version').textContent = info.modpackVersion
      ? `Modpack ${info.modpackVersion} · Minecraft ${info.minecraftVersion} · Forge ${info.forgeVersion}`
      : `Minecraft ${info.minecraftVersion} · Forge ${info.forgeVersion}`;
    $('server-address').textContent = serverAddress();
    renderNews(info.news);
    renderLinks(info.links);
    renderAuthNotice(info.authNotice);
    if (state.game === 'idle') showIdleLine();

    if (info.offline) {
      toast('Modpack injoignable : le launcher utilise sa dernière copie locale.', 'error', 8000);
    }
  } catch (err) {
    renderNews([]);
    toast(`Informations du modpack indisponibles : ${err.message}`, 'error', 8000);
  }
  refreshServerStatus();
  refreshPending();
}

/* ------------------------------------------------------------------ *
 *  Serveur : état, latence, joueurs, alerte de retour
 * ------------------------------------------------------------------ */

async function refreshServerStatus() {
  try {
    state.server = await api.server.status(state.info.server);
  } catch {
    state.server = null;
  }
  renderServerStatus();

  if (state.server?.online && state.watchServer) {
    state.watchServer = false;
    api.app.notify('Le serveur Aethoria est en ligne', 'Tu peux rejoindre la partie.').catch(() => {});
    toast('Le serveur est de retour en ligne !', 'success', 8000);
    renderServerStatus();
  }

  // Un seul minuteur, même si plusieurs vérifications se chevauchent.
  // Il est plus rapide quand le joueur attend le retour du serveur.
  clearTimeout(state.serverTimer);
  state.serverTimer = setTimeout(refreshServerStatus, state.watchServer ? 20000 : 60000);
}

function renderServerStatus() {
  const server = state.server;
  const latency = $('status-latency');

  if (!server) {
    $('status-dot').className = 'dot';
    $('status-text').textContent = 'État inconnu';
    latency.hidden = true;
    $('btn-watch-server').hidden = true;
    return;
  }

  $('btn-watch-server').hidden = server.online;
  $('btn-watch-server').classList.toggle('is-active', state.watchServer);
  $('watch-label').textContent = state.watchServer ? 'Alerte activée' : 'Me prévenir';

  if (!server.online) {
    $('status-dot').className = 'dot is-offline';
    $('status-text').textContent = 'Hors ligne';
    latency.hidden = true;
    $('players-panel').hidden = true;
    return;
  }

  const { online } = server.players;
  $('status-dot').className = 'dot is-online';
  $('status-text').textContent = online ? `En ligne · ${plural(online, 'joueur')}` : 'En ligne';
  latency.hidden = server.latency == null;
  latency.textContent = `${server.latency} ms`;
  latency.className = `latency${server.latency < 80 ? ' is-good' : server.latency > 180 ? ' is-bad' : ''}`;
  renderPlayers();
}

function renderPlayers() {
  const { online, sample = [] } = state.server.players;
  $('players-title').textContent = `${plural(online, 'joueur')} en ligne`;

  let html;
  if (!online) {
    html = '<li class="help">Personne pour le moment. Sois le premier !</li>';
  } else if (!sample.length) {
    html = '<li class="help">Le serveur ne partage pas la liste des pseudos.</li>';
  } else {
    html = sample.map((player) => `
      <li class="player">
        <img src="https://crafatar.com/avatars/${encodeURIComponent(player.id)}?size=32&overlay&default=MHF_Steve" alt="" width="24" height="24">
        <span>${escapeHtml(player.name)}</span>
      </li>`).join('');
    if (online > sample.length) html += `<li class="help">et ${plural(online - sample.length, 'autre')}</li>`;
  }
  $('players-list').innerHTML = html;
}

function togglePlayers(event) {
  event.stopPropagation();
  const panel = $('players-panel');
  if (!state.server?.online) {
    refreshServerStatus();
    return;
  }
  panel.hidden = !panel.hidden;
  $('btn-players').setAttribute('aria-expanded', String(!panel.hidden));
}

function toggleWatchServer() {
  state.watchServer = !state.watchServer;
  renderServerStatus();
  if (state.watchServer) {
    toast('Tu seras prévenu dès que le serveur revient en ligne.', 'info', 5000);
    refreshServerStatus();
  }
}

/* ------------------------------------------------------------------ *
 *  Lancement et vérification des fichiers
 * ------------------------------------------------------------------ */

function setGameState(game, label) {
  state.game = game;
  $('btn-play').disabled = game !== 'idle';
  $('btn-play-label').textContent = label || { idle: 'Jouer', launching: 'Lancement', running: 'En jeu' }[game];
  $('progress').hidden = game !== 'launching';
  $('btn-stop').hidden = game !== 'running';
  resetStopButton();
  if (game !== 'idle') $('launch-sub').hidden = true;
  if (game === 'launching') {
    $('progress-fill').style.width = '0%';
    $('progress-detail').textContent = '';
    $('crash-actions').hidden = true;
  }
}

async function play() {
  if (state.game !== 'idle' || !state.account) return;
  state.logs = [];
  state.lastExit = null;
  setGameState('launching');
  setLaunchLine('Préparation…');

  try {
    await api.game.launch();
    // Le jeu peut déjà être prêt, ou déjà arrêté : les événements ont alors repris la main.
    if (state.game !== 'launching') return;
    setGameState('running');
    setLaunchLine('Minecraft démarre…');
  } catch (err) {
    if (state.game !== 'launching') return;
    setGameState('idle');
    setLaunchLine(escapeHtml(err.message), 'error');
  }
}

/** Contrôle et retélécharge ce qui manque, sans lancer le jeu. */
async function verifyFiles() {
  if (state.game !== 'idle') {
    toast('Attends la fin de la partie pour vérifier les fichiers.', 'error');
    return;
  }
  await closeDrawer('drawer-settings');
  setGameState('launching', 'Vérification');
  setLaunchLine('Vérification des fichiers…');
  try {
    await api.game.prepare();
    setGameState('idle');
    setLaunchLine('Tous les fichiers du jeu sont à jour.', 'success');
  } catch (err) {
    setGameState('idle');
    setLaunchLine(escapeHtml(err.message), 'error');
  }
  refreshPending();
}

let stopTimer = null;

function resetStopButton() {
  clearTimeout(stopTimer);
  $('btn-stop').classList.remove('is-confirming');
  $('btn-stop-label').textContent = 'Forcer l’arrêt';
}

/** Deux clics : une fermeture forcée fait perdre ce qui n'est pas sauvegardé. */
async function stopGame() {
  const button = $('btn-stop');
  if (!button.classList.contains('is-confirming')) {
    button.classList.add('is-confirming');
    $('btn-stop-label').textContent = 'Confirmer ?';
    stopTimer = setTimeout(resetStopButton, 4000);
    return;
  }
  resetStopButton();
  try {
    await api.game.stop();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function onGameReady() {
  if (state.game === 'launching') setGameState('running');
  setLaunchLine('Minecraft est lancé. Bon jeu !', 'success');

  // Rappel au moment où il sert : le joueur arrive sur le serveur.
  const notice = state.info.authNotice;
  if (notice?.body) toast(`${notice.title}\n\n${notice.body}`, 'info', 20000);

  if (state.settings.launcherBehavior === 'minimize') api.window.hide();
  if (state.settings.launcherBehavior === 'close') setTimeout(() => api.window.close(), 1000);
}

function onGameExit(result) {
  setGameState('idle');
  state.lastExit = result;
  refreshPlaytime();
  refreshPending();
  if (state.settings.launcherBehavior === 'minimize') api.window.restore();

  if (!result.error) {
    setLaunchLine(result.durationSeconds >= 60
      ? `Partie terminée : ${formatPlaytime(result.durationSeconds)} de jeu.`
      : 'Minecraft a été fermé.');
    return;
  }

  $('crash-actions').hidden = false;
  const { diagnostic } = result;
  if (diagnostic) {
    setLaunchLine(escapeHtml(diagnostic.titre), 'error');
    const extrait = diagnostic.extrait ? `\n\n(${diagnostic.extrait})` : '';
    toast(`${diagnostic.titre}\n\n${diagnostic.cause}\n\n${diagnostic.solution}${extrait}`, 'error', 30000);
  } else {
    setLaunchLine(escapeHtml(result.error), 'error');
    toast(`${result.error}\n\nCopie le rapport et envoie-le au staff sur Discord.`, 'error', 15000);
  }
}

function wireGameEvents() {
  api.game.onStatus(({ message }) => {
    if (state.game === 'launching') setLaunchLine(escapeHtml(message));
  });

  api.game.onProgress((p) => {
    const percent = Math.max(0, Math.min(100, p.percent || 0));
    $('progress-fill').style.width = `${percent}%`;

    const parts = [`${Math.round(percent)} %`];
    if (p.totalBytes) parts.push(`${formatBytes(p.bytes)} / ${formatBytes(p.totalBytes)}`);
    if (p.bytesPerSecond > 0) parts.push(`${formatBytes(p.bytesPerSecond)}/s`);
    if (p.etaSeconds > 2) parts.push(`${formatDuration(p.etaSeconds)} restantes`);
    $('progress-detail').textContent = parts.join('  ·  ');
  });

  api.game.onFirstRun(() => {
    toast(
      'Première installation\n\n'
      + 'Le launcher télécharge Minecraft, Forge et les mods du serveur (environ 1,3 Go). '
      + 'Compte 2 à 5 minutes. Les prochains lancements seront immédiats.',
      'info',
      30000,
    );
  });

  api.game.onLog(({ line }) => {
    state.logs.push(line);
    if (state.logs.length > MAX_LOG_LINES) state.logs.shift();
  });
  api.game.onReady(onGameReady);
  api.game.onExit(onGameExit);
}

async function copyReport() {
  if (!state.system) state.system = await api.app.system().catch(() => ({}));
  const { system, settings, lastExit } = state;
  const report = [
    'Rapport Aethoria',
    `Pseudo : ${state.account?.name}`,
    `Launcher ${state.info.version} · Modpack ${state.info.modpackVersion || '?'} · Forge ${state.info.forgeVersion || '?'}`,
    `Système : ${system.os || '?'} · ${system.cpu || '?'} · ${system.ramMb ? formatRam(system.ramMb) : '?'} de RAM`,
    `Carte graphique : ${system.gpu || 'inconnue'}`,
    `Mémoire allouée : ${formatRam(settings.maxRamMb)} · Mods optionnels : ${settings.optionalMods.join(', ') || 'aucun'}`,
    `Erreur : ${lastExit?.error || 'aucune'}`,
    lastExit?.diagnostic ? `Cause probable : ${lastExit.diagnostic.titre}` : null,
    '',
    '```',
    ...(state.logs.length ? state.logs.slice(-80) : ['(journal vide)']),
    '```',
  ].filter((line) => line !== null).join('\n');

  try {
    await navigator.clipboard.writeText(report);
    toast('Rapport copié. Colle-le sur le Discord, dans le salon d’aide.', 'success', 6000);
  } catch {
    toast('Copie impossible.', 'error');
  }
}

/* ------------------------------------------------------------------ *
 *  Panneaux, fenêtres et raccourcis
 * ------------------------------------------------------------------ */

const closeHooks = {};

function openDrawer(id) {
  $(id).hidden = false;
}

async function closeDrawer(id) {
  try {
    await closeHooks[id]?.();
  } finally {
    $(id).hidden = true;
  }
}

function wireDialogs() {
  for (const dialog of dialogs()) {
    for (const el of dialog.querySelectorAll('[data-close]')) {
      el.addEventListener('click', () => closeDrawer(dialog.id));
    }
  }
  document.addEventListener('click', (e) => {
    if (!$('players-panel').contains(e.target)) $('players-panel').hidden = true;
  });
}

/** Entrée : jouer. F5 : actualiser le serveur et les actualités. Échap : fermer. */
function wireShortcuts() {
  document.addEventListener('keydown', (e) => {
    const open = dialogs().find((d) => !d.hidden);
    if (e.key === 'Escape') {
      if (open) closeDrawer(open.id);
      else $('players-panel').hidden = true;
      return;
    }
    if (open || $('view-main').hidden) return;
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;

    if (e.key === 'Enter') {
      e.preventDefault();
      play();
    } else if (e.key === 'F5') {
      e.preventDefault();
      loadModpackInfo();
      toast('Actualisation…', 'info', 1500);
    }
  });
}

/* ------------------------------------------------------------------ *
 *  Mods optionnels
 * ------------------------------------------------------------------ */

function refreshOptionsCount() {
  const checked = [...document.querySelectorAll('#options-list input:checked')];
  const bytes = checked.reduce((total, el) => total + Number(el.dataset.size), 0);
  $('options-count').textContent = checked.length
    ? `${plural(checked.length, 'mod')} · ${formatBytes(bytes)}`
    : 'Aucun mod sélectionné';
}

function renderOptionalMods(mods) {
  const list = $('options-list');
  if (!mods.length) {
    list.innerHTML = '<p class="help">Aucun mod optionnel proposé pour le moment.</p>';
    return;
  }
  list.innerHTML = mods.map((mod) => `
    <label class="option">
      <span class="switch__text">
        <strong>${escapeHtml(mod.name)}<small>${formatBytes(mod.size)}</small></strong>
        <span>${escapeHtml(mod.description || '')}</span>
      </span>
      <span class="switch">
        <input type="checkbox" value="${escapeHtml(mod.id)}" data-size="${Number(mod.size) || 0}" ${mod.enabled ? 'checked' : ''}>
        <span class="switch__track"></span>
      </span>
    </label>`).join('');
  refreshOptionsCount();
}

async function openOptions() {
  $('options-list').innerHTML = '<p class="help">Chargement…</p>';
  $('options-count').textContent = '';
  openDrawer('drawer-options');
  try {
    renderOptionalMods(await api.modpack.optionalMods());
  } catch (err) {
    $('options-list').innerHTML = `<p class="help">Liste indisponible : ${escapeHtml(err.message)}</p>`;
  }
}

async function saveOptions() {
  const ids = [...document.querySelectorAll('#options-list input:checked')].map((el) => el.value);
  const button = $('btn-options-save');
  button.disabled = true;
  try {
    await api.modpack.setOptionalMods(ids);
    state.settings.optionalMods = ids;
    await closeDrawer('drawer-options');
    toast(
      ids.length
        ? `${plural(ids.length, 'mod')} installé${ids.length > 1 ? 's' : ''} au prochain lancement.`
        : 'Les mods optionnels seront retirés au prochain lancement.',
      'success',
    );
    refreshPending();
  } catch (err) {
    toast(`Enregistrement impossible : ${err.message}`, 'error');
  } finally {
    button.disabled = false;
  }
}

/* ------------------------------------------------------------------ *
 *  Captures d'écran
 * ------------------------------------------------------------------ */

async function openScreenshots() {
  const grid = $('shots-grid');
  grid.innerHTML = '<p class="help">Chargement…</p>';
  $('shots-count').textContent = '';
  openDrawer('drawer-shots');
  try {
    const shots = await api.screenshots.list();
    if (!shots.length) {
      grid.innerHTML = '<p class="help">Aucune capture pour le moment. En jeu, appuie sur F2 pour en prendre une.</p>';
      return;
    }
    $('shots-count').textContent = `${plural(shots.length, 'capture')} · clique pour ouvrir`;
    grid.innerHTML = shots.map((shot) => `
      <button class="shot" data-name="${escapeHtml(shot.name)}" title="${escapeHtml(new Date(shot.date).toLocaleString('fr-FR'))}">
        <img src="${shot.thumb}" alt="">
      </button>`).join('');
  } catch (err) {
    grid.innerHTML = `<p class="help">Captures indisponibles : ${escapeHtml(err.message)}</p>`;
  }
}

/* ------------------------------------------------------------------ *
 *  Réglages
 * ------------------------------------------------------------------ */

const BEHAVIOR_HELP = {
  keep: 'Le launcher reste affiché derrière le jeu.',
  minimize: 'Le launcher se range près de l’horloge quand le jeu est prêt, et revient quand tu quittes.',
  close: 'Le launcher se ferme quand le jeu est prêt. Le temps de jeu n’est alors pas compté.',
};

function renderChoices() {
  const { launcherBehavior, background } = state.settings;
  for (const input of document.querySelectorAll('input[name="behavior"]')) input.checked = input.value === launcherBehavior;
  for (const input of document.querySelectorAll('input[name="background"]')) input.checked = input.value === background;
  $('behavior-help').textContent = BEHAVIOR_HELP[launcherBehavior];
}

async function refreshStorage() {
  $('storage-text').textContent = 'Calcul en cours…';
  $('btn-clean').disabled = true;
  try {
    const { total, cleanable } = await api.storage.info();
    $('storage-text').textContent = cleanable
      ? `${formatBytes(total)} utilisés, dont ${formatBytes(cleanable)} de journaux inutiles.`
      : `${formatBytes(total)} utilisés. Rien à nettoyer.`;
    $('btn-clean').disabled = !cleanable;
  } catch {
    $('storage-text').textContent = 'Espace utilisé indisponible.';
  }
}

async function runCheckup() {
  const button = $('btn-checkup');
  const list = $('checkup-list');
  button.disabled = true;
  list.hidden = false;
  list.innerHTML = '<li class="help">Test en cours…</li>';
  try {
    const results = await api.app.checkup();
    list.innerHTML = results.map((r) => `
      <li class="check is-${r.status}">
        <span class="check__dot"></span>
        <span class="check__text"><strong>${escapeHtml(r.label)}</strong><span>${escapeHtml(r.detail || '')}</span></span>
      </li>`).join('');
  } catch (err) {
    list.innerHTML = `<li class="help">Test impossible : ${escapeHtml(err.message)}</li>`;
  } finally {
    button.disabled = false;
  }
}

async function openSettings() {
  state.settings = await api.settings.get();
  const s = state.settings;

  $('input-ram').max = Math.min(16384, s.systemRamMb);
  $('input-ram').value = s.maxRamMb;
  $('output-ram').textContent = formatRam(s.maxRamMb);
  $('ram-help').textContent = `Ta machine a ${formatRam(s.systemRamMb)}. Conseillé : ${formatRam(s.recommendedRamMb)}.`;
  $('select-resolution').value = s.gameResolution;
  $('check-join-server').checked = s.autoJoinServer;
  $('check-light-mode').checked = s.lightMode;
  $('check-open-at-login').checked = s.openAtLogin;
  $('input-game-root').value = s.gameRoot || state.info.defaultRoot;
  $('input-java-path').value = s.javaPath || '';
  $('input-jvm-args').value = s.jvmArgs || '';
  $('checkup-list').hidden = true;
  renderChoices();

  openDrawer('drawer-settings');
  refreshStorage();
}

function wireSettings() {
  const ram = $('input-ram');
  ram.addEventListener('input', () => { $('output-ram').textContent = formatRam(ram.value); });
  ram.addEventListener('change', () => {
    const maxRamMb = Number(ram.value);
    saveSettings({ maxRamMb, minRamMb: Math.max(1024, Math.floor(maxRamMb / 2)) }).catch(() => {});
  });

  $('select-resolution').addEventListener('change', (e) => {
    saveSettings({ gameResolution: e.target.value }).catch(() => {});
  });

  $('behavior').addEventListener('change', async (e) => {
    await saveSettings({ launcherBehavior: e.target.value }).catch(() => {});
    renderChoices();
  });

  $('backgrounds').addEventListener('change', async (e) => {
    await saveSettings({ background: e.target.value }).catch(() => {});
    applyAppearance();
  });

  $('check-light-mode').addEventListener('change', async (e) => {
    await saveSettings({ lightMode: e.target.checked }).catch(() => {});
    applyAppearance();
  });

  $('check-open-at-login').addEventListener('change', (e) => {
    saveSettings({ openAtLogin: e.target.checked }).catch(() => {});
  });

  $('check-join-server').addEventListener('change', async (e) => {
    await saveSettings({ autoJoinServer: e.target.checked }).catch(() => {});
    if (state.game === 'idle') showIdleLine();
  });

  $('btn-pick-folder').addEventListener('click', async () => {
    const folder = await api.settings.pickFolder();
    if (!folder) return;
    await saveSettings({ gameRoot: folder });
    $('input-game-root').value = folder;
    refreshStorage();
    refreshPending();
    toast('Dossier modifié : le jeu y sera téléchargé au prochain lancement.', 'info');
  });

  $('btn-checkup').addEventListener('click', runCheckup);
  $('btn-verify').addEventListener('click', verifyFiles);

  $('btn-clean').addEventListener('click', async () => {
    $('btn-clean').disabled = true;
    try {
      const { freed, count } = await api.storage.clean();
      toast(`${plural(count, 'fichier')} supprimé${count > 1 ? 's' : ''}, ${formatBytes(freed)} libérés.`, 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
    refreshStorage();
  });

  $('btn-pick-java').addEventListener('click', async () => {
    const file = await api.settings.pickJava();
    if (!file) return;
    await saveSettings({ javaPath: file });
    $('input-java-path').value = file;
  });

  $('btn-reset-java').addEventListener('click', async () => {
    await saveSettings({ javaPath: null });
    $('input-java-path').value = '';
  });

  // Enregistré pendant la frappe : fermer le panneau ne doit rien perdre.
  const jvm = $('input-jvm-args');
  let jvmTimer = null;
  const saveJvm = () => {
    clearTimeout(jvmTimer);
    jvmTimer = null;
    return saveSettings({ jvmArgs: jvm.value });
  };
  jvm.addEventListener('input', () => {
    clearTimeout(jvmTimer);
    jvmTimer = setTimeout(() => saveJvm().catch(() => {}), 600);
  });
  closeHooks['drawer-settings'] = () => (jvmTimer ? saveJvm().catch(() => {}) : null);

  $('btn-open-game-folder').addEventListener('click', () => api.folders.game());
  $('btn-open-logs').addEventListener('click', () => api.folders.logs());

  $('btn-repair').addEventListener('click', async () => {
    try {
      if (await api.game.repair()) {
        await closeDrawer('drawer-settings');
        toast('Installation réinitialisée. Tout sera retéléchargé au prochain lancement.', 'success');
        refreshPending();
      }
    } catch (err) {
      toast(err.message, 'error', 9000);
    }
  });
}

/* ------------------------------------------------------------------ *
 *  Nouveautés et mise à jour du launcher
 * ------------------------------------------------------------------ */

function showWhatsNew() {
  const version = state.info.version;
  const entry = CHANGELOG[version];
  if (!entry) {
    toast(`Launcher Aethoria ${version}`, 'info', 3000);
    return;
  }
  $('whatsnew-version').textContent = `Version ${version} · ${entry.items.length} nouveautés`;
  $('whatsnew-title').textContent = entry.title;
  $('whatsnew-list').innerHTML = entry.items.map(([title, text]) => `
    <li><strong>${escapeHtml(title)}</strong><span>${escapeHtml(text)}</span></li>`).join('');
  openDrawer('modal-whatsnew');
}

/** Une fois par version, et seulement pour un joueur qui avait déjà le launcher. */
function showWhatsNewOnce(hadAccount) {
  if (state.settings.lastSeenVersion === state.info.version) return;
  if (hadAccount && CHANGELOG[state.info.version]) showWhatsNew();
  saveSettings({ lastSeenVersion: state.info.version }).catch(() => {});
}

function wireUpdater() {
  const show = (title, detail, { install = false, manual = false } = {}) => {
    $('update').hidden = false;
    $('update-title').textContent = title;
    $('update-detail').textContent = detail;
    $('btn-update-install').hidden = !install;
    $('btn-update-manual').hidden = !manual;
  };

  api.updater.onStatus((status) => {
    switch (status.state) {
      case 'available':
        show(`Mise à jour ${status.version}`, 'Téléchargement…');
        break;
      case 'downloading':
        show('Mise à jour', `Téléchargement : ${Math.round(status.percent)} %`);
        break;
      case 'ready':
        show(`Version ${status.version} prête`, 'Redémarre pour l’installer.', { install: true });
        break;
      default:
        // Passé sous silence, un échec laisserait le joueur sur une version
        // périmée sans qu'il le sache.
        show('Mise à jour impossible', 'Télécharge la dernière version.', { manual: true });
        console.warn('Mise à jour impossible :', status.message);
    }
  });

  $('btn-update-install').addEventListener('click', () => api.updater.install());
  $('btn-update-manual').addEventListener('click', () => openLink(state.info.downloadUrl, 'le lien'));
}

/* ------------------------------------------------------------------ *
 *  Démarrage
 * ------------------------------------------------------------------ */

async function init() {
  $('btn-minimize').addEventListener('click', () => api.window.minimize());
  $('btn-close').addEventListener('click', () => api.window.close());
  $('btn-version').addEventListener('click', showWhatsNew);
  $('form-pseudo').addEventListener('submit', submitPseudo);
  $('btn-confirm').addEventListener('click', confirmPseudo);
  $('btn-confirm-back').addEventListener('click', () => showConfirm(null));
  $('btn-play').addEventListener('click', play);
  $('btn-stop').addEventListener('click', stopGame);
  $('btn-players').addEventListener('click', togglePlayers);
  $('btn-watch-server').addEventListener('click', toggleWatchServer);
  $('btn-copy-ip').addEventListener('click', copyServerAddress);
  $('btn-trailer').addEventListener('click', () => openLink(state.info.links.trailer, 'la bande-annonce'));
  $('btn-discord').addEventListener('click', () => openLink(state.info.links.discord, 'le Discord'));
  $('btn-crash-discord').addEventListener('click', () => openLink(state.info.links.discord, 'le Discord'));
  $('btn-copy-report').addEventListener('click', copyReport);
  $('btn-options').addEventListener('click', openOptions);
  $('btn-options-save').addEventListener('click', saveOptions);
  $('options-list').addEventListener('change', refreshOptionsCount);
  $('btn-shots').addEventListener('click', openScreenshots);
  $('btn-shots-folder').addEventListener('click', () => api.screenshots.folder());
  $('shots-grid').addEventListener('click', (e) => {
    const shot = e.target.closest('.shot');
    if (shot) api.screenshots.open(shot.dataset.name).catch((err) => toast(err.message, 'error'));
  });
  $('btn-settings').addEventListener('click', () => openSettings().catch((err) => toast(err.message, 'error')));
  api.app.onTrayPlay(play);

  // Hors ligne, Crafatar ne répond pas : l'icône du serveur remplace les têtes.
  const fallbackAvatar = (e) => {
    if (e.target.tagName === 'IMG' && !e.target.src.endsWith('assets/icon.png')) e.target.src = 'assets/icon.png';
  };
  $('account-avatar').addEventListener('error', fallbackAvatar);
  $('players-list').addEventListener('error', fallbackAvatar, true);

  wireDialogs();
  wireShortcuts();
  wireSettings();
  wireGameEvents();
  wireUpdater();

  try {
    state.info = await api.app.info();
    state.settings = await api.settings.get();
    applyAppearance();
    $('btn-version').textContent = `v${state.info.version}`;
    $('server-address').textContent = serverAddress();
    renderLinks(state.info.links);
    renderAuthNotice(state.info.authNotice);
    showIdleLine();
    const account = await api.account.get();
    applyAccount(account);
    showWhatsNewOnce(Boolean(account));
  } catch (err) {
    showView('login');
    showLoginError(`Le launcher n’a pas pu démarrer : ${err.message}`);
  }
}

document.addEventListener('DOMContentLoaded', init);
