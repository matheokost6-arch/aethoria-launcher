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
  knownNews: null,          // actualités déjà vues pendant cette session
  friendsOnline: null,      // amis en ligne au dernier contrôle
  newsTimer: null,
  stats: null,              // dernières statistiques lues, pour les succès
  breakTimer: null,
};

/* ------------------------------------------------------------------ *
 *  Sons discrets, générés à la volée (aucun fichier audio)
 * ------------------------------------------------------------------ */

const SOUNDS = {
  play: [[660, 0, 0.09]],
  ready: [[523, 0, 0.12], [784, 0.12, 0.22]],
  notify: [[880, 0, 0.1], [660, 0.1, 0.16]],
};
let audioContext = null;

function sound(name) {
  if (!state.settings?.sounds) return;
  try {
    audioContext ||= new AudioContext();
    for (const [frequency, start, duration] of SOUNDS[name]) {
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      const t = audioContext.currentTime + start;
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.07, t + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
      oscillator.connect(gain).connect(audioContext.destination);
      oscillator.start(t);
      oscillator.stop(t + duration + 0.02);
    }
  } catch {
    // le son est un agrément
  }
}

/** Notification Windows, sauf pendant la partie si le joueur a demandé le calme. */
function notifyPlayer(title, body) {
  if (state.game === 'running' && state.settings?.quietWhilePlaying) return;
  api.app.notify(title, body).catch(() => {});
  sound('notify');
}

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
  api.window.setZoom(state.settings.uiScale);

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
  // Nouvelles actualités vérifiées régulièrement, même launcher rangé près de l'horloge.
  clearInterval(state.newsTimer);
  state.newsTimer = setInterval(() => loadModpackInfo({ silent: true }), 10 * 60 * 1000);
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
    // Nouveau joueur : on lui présente le launcher.
    if (!state.settings.tourDone) setTimeout(startTour, 500);
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
    state.stats = stats;
    checkAchievements();
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

  // Actualité publiée pendant que le launcher est ouvert : on prévient le joueur.
  if (state.knownNews) {
    const fresh = shown.find((item) => !state.knownNews.has(item.key));
    if (fresh) notifyPlayer('Nouvelle actualité Aethoria', fresh.title || '');
  }
  state.knownNews = new Set(shown.map((item) => item.key));
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

// L'adresse du serveur n'est jamais affichee : le launcher et le menu du jeu
// s'y connectent seuls, le joueur n'a pas besoin de la connaitre.
function showIdleLine() {
  if (state.settings?.autoJoinServer) {
    setLaunchLine('Connexion directe au <strong>serveur Aethoria</strong>');
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

async function loadModpackInfo({ silent = false } = {}) {
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
    renderNews(info.news);
    renderLinks(info.links);
    renderAuthNotice(info.authNotice);
    if (state.game === 'idle') showIdleLine();

    if (info.offline && !silent) {
      toast('Modpack injoignable : le launcher utilise sa dernière copie locale.', 'error', 8000);
    }
  } catch (err) {
    if (!silent) {
      renderNews([]);
      toast(`Informations du modpack indisponibles : ${err.message}`, 'error', 8000);
    }
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
  checkFriendsOnline();

  if (state.server?.online && state.watchServer) {
    state.watchServer = false;
    notifyPlayer('Le serveur Aethoria est en ligne', 'Tu peux rejoindre la partie.');
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

const isFriend = (name) => (state.settings.friends || []).some((f) => f.toLowerCase() === name.toLowerCase());

function renderPlayers() {
  const { online, sample = [] } = state.server.players;
  $('players-title').textContent = `${plural(online, 'joueur')} en ligne`;

  let html;
  if (!online) {
    html = '<li class="help">Personne pour le moment. Sois le premier !</li>';
  } else if (!sample.length) {
    html = '<li class="help">Le serveur ne partage pas la liste des pseudos.</li>';
  } else {
    // Les amis d'abord.
    const players = [...sample].sort((a, b) => Number(isFriend(b.name)) - Number(isFriend(a.name)));
    html = players.map((player) => {
      const friend = isFriend(player.name);
      // Pas d'étoile sur son propre pseudo : on ne s'ajoute pas soi-même en ami.
      const self = player.name.toLowerCase() === state.account?.name.toLowerCase();
      return `
      <li class="player">
        <img src="https://crafatar.com/avatars/${encodeURIComponent(player.id)}?size=32&overlay&default=MHF_Steve" alt="" width="24" height="24">
        <span class="player__name">${escapeHtml(player.name)}${self ? ' <span class="help">(toi)</span>' : ''}</span>
        ${self ? '' : `<button class="player__star${friend ? ' is-friend' : ''}" data-name="${escapeHtml(player.name)}"
                title="${friend ? 'Retirer des amis' : 'Ajouter aux amis'}" aria-pressed="${friend}">★</button>`}
      </li>`;
    }).join('');
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

/* ------------------------------------------------------------------ *
 *  Amis
 * ------------------------------------------------------------------ */

/**
 * Prévient le joueur quand un ami se connecte. Le premier contrôle sert de
 * référence : les amis déjà en ligne à l'ouverture ne déclenchent rien.
 * Le serveur ne partage qu'une douzaine de pseudos : sur un serveur plein,
 * un ami peut ne pas apparaître.
 */
function checkFriendsOnline() {
  if (!state.server) return;
  const names = new Set((state.server.online ? state.server.players.sample || [] : []).map((p) => p.name.toLowerCase()));
  const online = (state.settings.friends || []).filter((f) => names.has(f.toLowerCase()));

  if (state.friendsOnline) {
    for (const friend of online.filter((f) => !state.friendsOnline.has(f))) {
      notifyPlayer(`${friend} est en ligne`, 'Ton ami vient de se connecter sur Aethoria.');
      toast(`${friend} vient de se connecter.`, 'success', 6000);
    }
  }
  state.friendsOnline = new Set(online);
  if (!$('drawer-profile').hidden) renderFriends();
}

function renderFriends() {
  const friends = state.settings.friends || [];
  const list = $('friends-list');
  if (!friends.length) {
    list.innerHTML = '<li class="help">Aucun ami pour le moment. Ajoute un pseudo, ou clique sur l’étoile dans la liste des joueurs connectés.</li>';
    return;
  }
  list.innerHTML = friends.map((friend) => {
    const online = state.friendsOnline?.has(friend);
    return `
      <li class="friend">
        <span class="dot${online ? ' is-online' : ''}"></span>
        <span class="friend__name">${escapeHtml(friend)}</span>
        <span class="help">${online ? 'En ligne' : 'Pas en ligne'}</span>
        <button class="icon-btn" data-remove="${escapeHtml(friend)}" aria-label="Retirer ${escapeHtml(friend)}">
          <svg viewBox="0 0 12 12"><path d="m2.5 2.5 7 7m0-7-7 7"/></svg>
        </button>
      </li>`;
  }).join('');
}

async function setFriend(name, add) {
  const friends = (state.settings.friends || []).filter((f) => f.toLowerCase() !== name.toLowerCase());
  if (add) friends.push(name);
  try {
    await saveSettings({ friends });
  } catch {
    return;
  }
  checkFriendsOnline();
  if (state.server?.online) renderPlayers();
  renderFriends();
  checkAchievements();
}

/** Message d'invitation prêt à coller : lien du launcher et Discord, jamais l'adresse du serveur. */
async function inviteFriend() {
  const { downloadUrl, links } = state.info;
  const message = [
    'Viens jouer avec moi sur Aethoria, un serveur Minecraft médiéval !',
    `Télécharge le launcher : ${downloadUrl}`,
    links?.discord ? `Rejoins le Discord : ${links.discord}` : null,
    `Mon pseudo en jeu : ${state.account.name}`,
  ].filter(Boolean).join('\n');
  try {
    await api.app.copyText(message);
    toast('Invitation copiée : colle-la à ton ami sur Discord ou par message.', 'success', 6000);
  } catch {
    toast('Copie impossible.', 'error');
  }
}

async function addFriend(event) {
  event.preventDefault();
  const input = $('input-friend');
  const name = input.value.trim();
  if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) {
    toast('Pseudo invalide : 3 à 16 caractères, lettres, chiffres et _.', 'error', 4000);
    return;
  }
  if (name.toLowerCase() === state.account.name.toLowerCase()) {
    toast('C’est ton propre pseudo !', 'info', 3000);
    return;
  }
  input.value = '';
  await setFriend(name, true);
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
  // Pendant la partie, le bouton ramène la fenêtre du jeu au premier plan.
  $('btn-play').disabled = game === 'launching';
  $('btn-play-label').textContent = label || { idle: 'Jouer', launching: 'Lancement', running: 'Afficher le jeu' }[game];
  $('btn-play').classList.toggle('play--secondary', game === 'running');
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
  if (state.game === 'running') {
    api.game.focus().catch(() => {});
    return;
  }
  if (state.game !== 'idle' || !state.account) return;
  sound('play');
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
  sound('ready');
  startBreakReminder();

  // Rappel au moment où il sert : le joueur arrive sur le serveur.
  const notice = state.info.authNotice;
  if (notice?.body) toast(`${notice.title}\n\n${notice.body}`, 'info', 20000);

  if (state.settings.launcherBehavior === 'minimize') api.window.hide();
  if (state.settings.launcherBehavior === 'close') setTimeout(() => api.window.close(), 1000);
}

/** Rappel de pause toutes les N minutes de jeu, si le joueur l'a activé. */
function startBreakReminder() {
  clearInterval(state.breakTimer);
  const every = state.settings.breakReminder;
  if (!every) return;
  const startedAt = Date.now();
  let reminders = 0;
  state.breakTimer = setInterval(() => {
    const minutes = Math.floor((Date.now() - startedAt) / 60000);
    if (Math.floor(minutes / every) <= reminders) return;
    reminders = Math.floor(minutes / every);
    // Toujours envoyé, même en mode "ne pas déranger" : c'est le joueur qui l'a demandé.
    api.app.notify('Petite pause ?', `Tu joues depuis ${formatPlaytime(minutes * 60)}. Pense à t’étirer et à boire un verre d’eau.`).catch(() => {});
  }, 30000);
}

function onGameExit(result) {
  clearInterval(state.breakTimer);
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
    await api.app.copyText(report);
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
    // Pendant la visite guidée, seul Échap agit : il la termine.
    if (!$('tour').hidden) {
      if (e.key === 'Escape') endTour();
      return;
    }
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

function filterOptions() {
  const query = $('options-search').value.trim().toLowerCase();
  for (const option of document.querySelectorAll('#options-list .option')) {
    option.hidden = Boolean(query) && !option.textContent.toLowerCase().includes(query);
  }
}

/** Coche ou décoche les mods affichés (ceux que la recherche laisse visibles). */
function setAllOptions(checked) {
  for (const input of document.querySelectorAll('#options-list .option:not([hidden]) input')) input.checked = checked;
  refreshOptionsCount();
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
  $('options-search').value = '';
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
 *  Profil : statistiques, activité de la semaine, dernières parties
 * ------------------------------------------------------------------ */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Jours de jeu consécutifs : la série en cours (aujourd'hui ou hier) et le record. */
function dayStreaks(history) {
  const days = [...new Set(history.map((s) => new Date(s.endedAt).setHours(0, 0, 0, 0)))].sort((a, b) => a - b);
  let best = 0;
  let run = 0;
  let previous = null;
  for (const day of days) {
    // Arrondi : un jour de changement d'heure dure 23 ou 25 heures.
    run = previous !== null && Math.round((day - previous) / DAY_MS) === 1 ? run + 1 : 1;
    best = Math.max(best, run);
    previous = day;
  }
  const today = new Date().setHours(0, 0, 0, 0);
  const current = previous !== null && Math.round((today - previous) / DAY_MS) <= 1 ? run : 0;
  return { current, best };
}

const plainDays = (n) => plural(n, 'jour');

function renderStatTiles(stats) {
  const average = stats.sessions ? Math.round(stats.totalSeconds / stats.sessions) : 0;
  const streak = dayStreaks(stats.history);
  const tiles = [
    ['Temps de jeu', formatPlaytime(stats.totalSeconds)],
    ['Parties', String(stats.sessions)],
    ['Plus longue partie', formatPlaytime(stats.longestSeconds)],
    ['Durée moyenne', formatPlaytime(average)],
    ['Série en cours', plainDays(streak.current), `Record : ${plainDays(streak.best)}`],
  ];
  $('profile-stats').innerHTML = tiles.map(([label, value, detail]) => `
    <div class="stat">
      <span class="stat__label">${label}</span>
      <span class="stat__value">${escapeHtml(value)}</span>
      ${detail ? `<span class="stat__detail">${escapeHtml(detail)}</span>` : ''}
    </div>`).join('');
}

/* Succès : calculés à partir des statistiques, annoncés une seule fois. */
const ACHIEVEMENTS = [
  { id: 'first', title: 'Premiers pas', text: 'Jouer une première partie', progress: (s) => [s.sessions, 1] },
  { id: 'regular', title: 'Habitué', text: 'Jouer 10 parties', progress: (s) => [s.sessions, 10] },
  { id: 'veteran', title: 'Vétéran', text: 'Jouer 50 parties', progress: (s) => [s.sessions, 50] },
  { id: 'hours10', title: 'Aventurier', text: 'Cumuler 10 heures de jeu', progress: (s) => [Math.floor(s.totalSeconds / 3600), 10] },
  { id: 'hours100', title: 'Légende d’Aethoria', text: 'Cumuler 100 heures de jeu', progress: (s) => [Math.floor(s.totalSeconds / 3600), 100] },
  { id: 'marathon', title: 'Nuit blanche', text: 'Jouer 3 heures d’affilée', progress: (s) => [Math.floor(s.longestSeconds / 3600), 3] },
  { id: 'loyal', title: 'Fidèle', text: 'Jouer 7 jours de suite', progress: (s) => [dayStreaks(s.history).best, 7] },
  { id: 'social', title: 'Sociable', text: 'Ajouter 3 amis', progress: () => [(state.settings.friends || []).length, 3] },
];

const isUnlocked = (achievement, stats) => {
  const [value, goal] = achievement.progress(stats);
  return value >= goal;
};

function checkAchievements() {
  if (!state.stats) return;
  const unlocked = ACHIEVEMENTS.filter((a) => isUnlocked(a, state.stats)).map((a) => a.id);
  const known = state.settings.unlockedAchievements;

  // Premier calcul (mise à jour du launcher) : on enregistre sans annoncer
  // d'un coup tout ce qui était déjà acquis.
  if (known) {
    for (const achievement of ACHIEVEMENTS.filter((a) => unlocked.includes(a.id) && !known.includes(a.id))) {
      toast(`Succès débloqué : ${achievement.title}\n${achievement.text}`, 'success', 8000);
      sound('ready');
    }
  }
  if (!known || unlocked.some((id) => !known.includes(id))) {
    saveSettings({ unlockedAchievements: unlocked }).catch(() => {});
  }
}

function renderAchievements(stats) {
  const done = ACHIEVEMENTS.filter((a) => isUnlocked(a, stats)).length;
  $('achievements-count').textContent = `${done} sur ${ACHIEVEMENTS.length}`;
  $('achievements').innerHTML = ACHIEVEMENTS.map((achievement) => {
    const [value, goal] = achievement.progress(stats);
    const unlocked = value >= goal;
    return `
      <div class="achievement${unlocked ? ' is-unlocked' : ''}">
        <svg class="achievement__icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="9" r="6"/><path d="m8.5 14-1.5 7 5-3 5 3-1.5-7"/></svg>
        <span class="achievement__text">
          <strong>${escapeHtml(achievement.title)}</strong>
          <span>${escapeHtml(achievement.text)}</span>
          ${unlocked ? '' : `<span class="achievement__progress"><span style="width: ${Math.min(100, (value / goal) * 100)}%"></span></span>`}
        </span>
        <span class="achievement__state">${unlocked ? 'Débloqué' : `${Math.min(value, goal)}/${goal}`}</span>
      </div>`;
  }).join('');
}

/** Minutes jouées par jour sur les 7 derniers jours, aujourd'hui compris. */
function weekActivity(history) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Array.from({ length: 7 }, (_, i) => {
    const start = today.getTime() - (6 - i) * DAY_MS;
    const seconds = history
      .filter((s) => s.endedAt >= start && s.endedAt < start + DAY_MS)
      .reduce((total, s) => total + s.seconds, 0);
    const date = new Date(start);
    return {
      label: i === 6 ? 'Auj.' : date.toLocaleDateString('fr-FR', { weekday: 'short' }).replace('.', ''),
      fullLabel: date.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }),
      minutes: Math.round(seconds / 60),
    };
  });
}

/** Colonnes : une seule série, donc une seule couleur et pas de légende. */
function renderWeekChart(history) {
  const days = weekActivity(history);
  const plot = $('week-chart');
  const max = Math.max(...days.map((d) => d.minutes));
  const duration = (minutes) => (minutes ? formatPlaytime(minutes * 60) : 'Pas joué');

  $('week-table').innerHTML = `<caption>Temps de jeu des 7 derniers jours</caption>${
    days.map((d) => `<tr><th scope="row">${d.fullLabel}</th><td>${duration(d.minutes)}</td></tr>`).join('')}`;

  if (!max) {
    plot.innerHTML = '<p class="help chart__empty">Pas encore de partie ces 7 derniers jours.</p>';
    return;
  }

  // Échelle arrondie à l'heure (ou 15 min sous une heure) : un repère lisible.
  const step = max < 60 ? 15 : 60;
  const top = Math.ceil(max / step) * step;
  const peak = days.findIndex((d) => d.minutes === max);

  plot.innerHTML = `
    <div class="chart__grid">
      <span class="chart__tick" style="bottom: 100%">${formatPlaytime(top * 60)}</span>
      <span class="chart__tick" style="bottom: 0">0</span>
    </div>
    <div class="chart__cols">
      ${days.map((d, i) => `
        <button class="chart__col" data-index="${i}" aria-label="${d.fullLabel} : ${duration(d.minutes)}">
          <span class="chart__bar-area">
            ${i === peak ? `<span class="chart__value" style="bottom: ${(d.minutes / top) * 100}%">${formatPlaytime(d.minutes * 60)}</span>` : ''}
            <span class="chart__bar" style="height: ${(d.minutes / top) * 100}%"></span>
          </span>
          <span class="chart__day">${d.label}</span>
        </button>`).join('')}
    </div>`;

  const tooltip = $('week-tooltip');
  const show = (col) => {
    const day = days[Number(col.dataset.index)];
    tooltip.replaceChildren();
    const value = document.createElement('strong');
    value.textContent = duration(day.minutes);
    const label = document.createElement('span');
    label.textContent = day.fullLabel;
    tooltip.append(value, label);
    tooltip.hidden = false;
    // Au-dessus de la barre survolée, centrée sur sa colonne.
    const chart = tooltip.parentElement.getBoundingClientRect();
    const box = col.getBoundingClientRect();
    const bar = col.querySelector('.chart__bar').getBoundingClientRect();
    tooltip.style.left = `${box.left - chart.left + box.width / 2}px`;
    tooltip.style.top = `${bar.top - chart.top}px`;
  };
  for (const col of plot.querySelectorAll('.chart__col')) {
    col.addEventListener('pointerenter', () => show(col));
    col.addEventListener('focus', () => show(col));
    col.addEventListener('pointerleave', () => { tooltip.hidden = true; });
    col.addEventListener('blur', () => { tooltip.hidden = true; });
  }
}

function renderSessions(history) {
  const recent = history.slice(-8).reverse();
  $('profile-sessions').innerHTML = recent.length
    ? recent.map((s) => `
      <li class="session">
        <span>${escapeHtml(new Date(s.endedAt).toLocaleString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))}</span>
        <strong>${formatPlaytime(s.seconds)}</strong>
      </li>`).join('')
    : '<li class="help">Tes parties apparaîtront ici.</li>';
}

async function openProfile() {
  $('profile-name').textContent = state.account.name;
  $('profile-avatar').src = state.account.avatarUrl || 'assets/icon.png';
  renderFriends();
  openDrawer('drawer-profile');

  try {
    const stats = await api.stats.get();
    $('profile-since').textContent = stats.firstPlayedAt
      ? `Joue sur Aethoria depuis le ${new Date(stats.firstPlayedAt).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })}`
      : 'Lance ta première partie pour commencer tes statistiques.';
    state.stats = stats;
    renderStatTiles(stats);
    renderWeekChart(stats.history);
    renderAchievements(stats);
    renderSessions(stats.history);
  } catch (err) {
    $('profile-stats').innerHTML = `<p class="help">Statistiques indisponibles : ${escapeHtml(err.message)}</p>`;
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
      <div class="shot">
        <button class="shot__open" data-open="${escapeHtml(shot.name)}" title="${escapeHtml(new Date(shot.date).toLocaleString('fr-FR'))}">
          <img src="${shot.thumb}" alt="">
        </button>
        <span class="shot__actions">
          <button class="shot__action" data-copy="${escapeHtml(shot.name)}" title="Copier l’image">
            <svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg>
          </button>
          <button class="shot__action" data-trash="${escapeHtml(shot.name)}" title="Mettre à la corbeille">
            <svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>
          </button>
        </span>
      </div>`).join('');
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
  const { launcherBehavior, background, graphicsPreset, uiScale } = state.settings;
  for (const input of document.querySelectorAll('input[name="behavior"]')) input.checked = input.value === launcherBehavior;
  for (const input of document.querySelectorAll('input[name="background"]')) input.checked = input.value === background;
  for (const input of document.querySelectorAll('input[name="graphics"]')) input.checked = input.value === graphicsPreset;
  for (const input of document.querySelectorAll('input[name="uiscale"]')) input.checked = Number(input.value) === uiScale;
  $('behavior-help').textContent = BEHAVIOR_HELP[launcherBehavior];
}

async function refreshBackups() {
  const backups = await api.options.backups().catch(() => []);
  $('restore-row').hidden = !backups.length;
  $('select-backup').innerHTML = backups.map((backup) => `
    <option value="${escapeHtml(backup.name)}">Sauvegarde du ${escapeHtml(new Date(backup.date).toLocaleString('fr-FR', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }))}</option>`).join('');
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
  $('check-sounds').checked = s.sounds;
  $('check-quiet').checked = s.quietWhilePlaying;
  $('select-break').value = String(s.breakReminder);
  refreshBackups();
  $('update-check-text').textContent = `Version ${state.info.version} installée.`;
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

  $('check-sounds').addEventListener('change', async (e) => {
    await saveSettings({ sounds: e.target.checked }).catch(() => {});
    sound('notify');
  });

  $('ui-scale').addEventListener('change', async (e) => {
    await saveSettings({ uiScale: Number(e.target.value) }).catch(() => {});
    applyAppearance();
  });

  const GRAPHICS_LABELS = { performance: 'Performance', balanced: 'Équilibré', quality: 'Qualité' };
  $('graphics-preset').addEventListener('change', async (e) => {
    try {
      await api.options.preset(e.target.value);
      await saveSettings({ graphicsPreset: e.target.value });
      toast(`Graphismes « ${GRAPHICS_LABELS[e.target.value]} » appliqués pour ta prochaine partie.`, 'success');
      refreshBackups();
    } catch (err) {
      toast(err.message, 'error', 6000);
    }
    renderChoices();
  });

  $('btn-reset-options').addEventListener('click', async () => {
    try {
      if (await api.options.reset()) {
        await saveSettings({ graphicsPreset: null });
        renderChoices();
        refreshBackups();
        toast('Options de Minecraft réinitialisées. Elles repartent de zéro à la prochaine partie.', 'success');
      }
    } catch (err) {
      toast(err.message, 'error', 6000);
    }
  });

  $('btn-check-update').addEventListener('click', async () => {
    const button = $('btn-check-update');
    const text = $('update-check-text');
    button.disabled = true;
    text.textContent = 'Recherche en cours…';
    try {
      const result = await api.updater.check();
      text.textContent = result.available
        ? `Version ${result.latest} disponible : téléchargement en cours.`
        : `Tu as la dernière version (${result.current}).`;
    } catch (err) {
      text.textContent = err.message;
    } finally {
      button.disabled = false;
    }
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

  $('check-quiet').addEventListener('change', (e) => {
    saveSettings({ quietWhilePlaying: e.target.checked }).catch(() => {});
  });

  $('select-break').addEventListener('change', (e) => {
    saveSettings({ breakReminder: Number(e.target.value) }).catch(() => {});
  });

  $('btn-shortcut').addEventListener('click', async () => {
    try {
      await api.app.createPlayShortcut();
      toast('Raccourci « Jouer à Aethoria » créé sur le bureau.', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $('btn-tour').addEventListener('click', async () => {
    await closeDrawer('drawer-settings');
    startTour();
  });

  $('btn-options-backup').addEventListener('click', async () => {
    try {
      await api.options.backup();
      toast('Réglages de Minecraft sauvegardés.', 'success', 4000);
      refreshBackups();
    } catch (err) {
      toast(err.message, 'error', 6000);
    }
  });

  $('btn-options-restore').addEventListener('click', async () => {
    const name = $('select-backup').value;
    if (!name) return;
    try {
      await api.options.restore(name);
      toast('Réglages restaurés pour ta prochaine partie. Les précédents ont été sauvegardés.', 'success', 6000);
      refreshBackups();
    } catch (err) {
      toast(err.message, 'error', 6000);
    }
  });
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

/** Compare deux versions "1.4.0" : négatif, nul ou positif. */
function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

/** Versions publiées depuis `since` jusqu'à la version installée, de la plus récente à la plus ancienne. */
function changelogSince(since) {
  return Object.keys(CHANGELOG)
    .filter((v) => compareVersions(v, state.info.version) <= 0 && (!since || compareVersions(v, since) > 0))
    .sort((a, b) => compareVersions(b, a));
}

/**
 * Affiche les nouveautés. Un joueur qui a sauté des versions voit tout ce qu'il
 * a manqué, pas seulement la dernière.
 */
function showWhatsNew(versions = []) {
  const shown = versions.length ? versions : changelogSince(null).slice(0, 1);
  if (!shown.length) {
    toast(`Launcher Aethoria ${state.info.version}`, 'info', 3000);
    return;
  }
  const items = shown.flatMap((v) => CHANGELOG[v].items);
  $('whatsnew-version').textContent = shown.length > 1
    ? `Versions ${shown[shown.length - 1]} à ${shown[0]} · ${items.length} nouveautés`
    : `Version ${shown[0]} · ${items.length} nouveautés`;
  $('whatsnew-title').textContent = CHANGELOG[shown[0]].title;
  $('whatsnew-list').innerHTML = items.map(([title, text]) => `
    <li><strong>${escapeHtml(title)}</strong><span>${escapeHtml(text)}</span></li>`).join('');
  openDrawer('modal-whatsnew');
}

/** Une fois par version, et seulement pour un joueur qui avait déjà le launcher. */
function showWhatsNewOnce(hadAccount) {
  const { lastSeenVersion } = state.settings;
  if (lastSeenVersion === state.info.version) return;
  const missed = changelogSince(lastSeenVersion);
  if (hadAccount && missed.length) showWhatsNew(missed);
  saveSettings({ lastSeenVersion: state.info.version }).catch(() => {});
}

/* ------------------------------------------------------------------ *
 *  Visite guidée
 * ------------------------------------------------------------------ */

const TOUR = [
  { target: 'btn-play', title: 'Jouer', text: 'Un clic et Minecraft s’ouvre sur le menu Aethoria. Le launcher installe et met tout à jour lui-même.' },
  { target: 'btn-players', title: 'Le serveur', text: 'Vois s’il est en ligne et qui joue. L’étoile à côté d’un pseudo l’ajoute à tes amis.' },
  { target: 'btn-options', title: 'Mods optionnels', text: 'Minimap, zoom, luminosité… des conforts rien que pour toi, sans rien changer pour les autres.' },
  { target: 'btn-profile', title: 'Ton profil', text: 'Temps de jeu, succès, activité de la semaine et liste d’amis.' },
  { target: 'btn-settings', title: 'Réglages', text: 'Mémoire, graphismes, fond d’écran… et tout le dépannage si le jeu pose problème.' },
];
let tourIndex = 0;

function startTour() {
  if ($('view-main').hidden) return;
  tourIndex = 0;
  $('tour').hidden = false;
  showTourStep();
}

function showTourStep() {
  const step = TOUR[tourIndex];
  const target = $(step.target).getBoundingClientRect();
  const pad = 6;
  Object.assign($('tour-highlight').style, {
    left: `${target.left - pad}px`,
    top: `${target.top - pad}px`,
    width: `${target.width + pad * 2}px`,
    height: `${target.height + pad * 2}px`,
  });

  $('tour-step').textContent = `Étape ${tourIndex + 1} sur ${TOUR.length}`;
  $('tour-title').textContent = step.title;
  $('tour-text').textContent = step.text;
  $('btn-tour-next').textContent = tourIndex === TOUR.length - 1 ? 'Terminer' : 'Suivant';

  // À droite des onglets de gauche, sinon au-dessus (ou en dessous) de la cible.
  const card = $('tour-card');
  const { offsetWidth: width, offsetHeight: height } = card;
  let left;
  let top;
  if (target.left < window.innerWidth / 3 && target.right + 16 + width < window.innerWidth) {
    left = target.right + 16;
    top = target.top + target.height / 2 - height / 2;
  } else {
    left = target.left + target.width / 2 - width / 2;
    top = target.top - height - 16;
    if (top < 48) top = target.bottom + 16;
  }
  card.style.left = `${Math.max(16, Math.min(left, window.innerWidth - width - 16))}px`;
  card.style.top = `${Math.max(48, Math.min(top, window.innerHeight - height - 16))}px`;
  $('btn-tour-next').focus();
}

function nextTourStep() {
  tourIndex += 1;
  if (tourIndex >= TOUR.length) endTour();
  else showTourStep();
}

function endTour() {
  $('tour').hidden = true;
  saveSettings({ tourDone: true }).catch(() => {});
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
  $('btn-version').addEventListener('click', () => showWhatsNew());
  $('form-pseudo').addEventListener('submit', submitPseudo);
  $('btn-confirm').addEventListener('click', confirmPseudo);
  $('btn-confirm-back').addEventListener('click', () => showConfirm(null));
  $('btn-play').addEventListener('click', play);
  $('btn-stop').addEventListener('click', stopGame);
  $('btn-players').addEventListener('click', togglePlayers);
  $('btn-watch-server').addEventListener('click', toggleWatchServer);
  $('btn-profile').addEventListener('click', openProfile);
  $('btn-account').addEventListener('click', openProfile);
  $('form-friend').addEventListener('submit', addFriend);
  $('friends-list').addEventListener('click', (e) => {
    const button = e.target.closest('[data-remove]');
    if (button) setFriend(button.dataset.remove, false);
  });
  $('players-list').addEventListener('click', (e) => {
    const star = e.target.closest('.player__star');
    if (!star) return;
    e.stopPropagation();
    setFriend(star.dataset.name, !isFriend(star.dataset.name));
  });
  $('btn-trailer').addEventListener('click', () => openLink(state.info.links.trailer, 'la bande-annonce'));
  $('btn-discord').addEventListener('click', () => openLink(state.info.links.discord, 'le Discord'));
  $('btn-crash-discord').addEventListener('click', () => openLink(state.info.links.discord, 'le Discord'));
  $('btn-copy-report').addEventListener('click', copyReport);
  $('btn-options').addEventListener('click', openOptions);
  $('btn-options-save').addEventListener('click', saveOptions);
  $('options-list').addEventListener('change', refreshOptionsCount);
  $('btn-shots').addEventListener('click', openScreenshots);
  $('btn-shots-folder').addEventListener('click', () => api.screenshots.folder());
  $('shots-grid').addEventListener('click', async (e) => {
    const button = e.target.closest('[data-open], [data-copy], [data-trash]');
    if (!button) return;
    const { open, copy, trash } = button.dataset;
    try {
      if (open) await api.screenshots.open(open);
      if (copy) {
        await api.screenshots.copy(copy);
        toast('Image copiée : colle-la sur Discord avec Ctrl+V.', 'success', 4000);
      }
      if (trash) {
        await api.screenshots.trash(trash);
        button.closest('.shot').remove();
        toast('Capture mise à la corbeille.', 'info', 4000);
      }
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  $('options-search').addEventListener('input', filterOptions);
  $('btn-options-all').addEventListener('click', () => setAllOptions(true));
  $('btn-options-none').addEventListener('click', () => setAllOptions(false));
  $('btn-invite').addEventListener('click', inviteFriend);
  $('btn-tour-next').addEventListener('click', nextTourStep);
  $('btn-tour-skip').addEventListener('click', endTour);
  window.addEventListener('resize', () => { if (!$('tour').hidden) showTourStep(); });
  api.app.onShortcutPlay(play);
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
    renderLinks(state.info.links);
    renderAuthNotice(state.info.authNotice);
    showIdleLine();
    const account = await api.account.get();
    applyAccount(account);
    showWhatsNewOnce(Boolean(account));
    // Ouvert par le raccourci "Jouer à Aethoria" : la partie démarre tout de suite.
    if (state.info.autoPlay && account) play();
  } catch (err) {
    showView('login');
    showLoginError(`Le launcher n’a pas pu démarrer : ${err.message}`);
  }
}

document.addEventListener('DOMContentLoaded', init);
