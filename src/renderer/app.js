'use strict';

/* ------------------------------------------------------------------ *
 *  Aethoria Launcher — interface
 *  Aucun accès à Node ici : tout passe par le pont window.aethoria.
 * ------------------------------------------------------------------ */

const api = window.aethoria;
const $ = (id) => document.getElementById(id);

const state = {
  info: null,       // app:info, complété par modpack:info
  settings: null,
  account: null,
  launching: false,
  statusTimer: null,
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
  return `${value.toFixed(value < 10 && unit > 0 ? 1 : 0)} ${units[unit]}`;
}

function formatDuration(seconds) {
  if (seconds < 60) return `${seconds} s`;
  const min = Math.floor(seconds / 60);
  if (min < 60) return seconds % 60 ? `${min} min ${seconds % 60} s` : `${min} min`;
  return `${Math.floor(min / 60)} h ${min % 60} min`;
}

const plural = (n, word) => `${n} ${word}${n > 1 ? 's' : ''}`;

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

function openLogin() {
  showLoginError('');
  $('btn-login-back').hidden = !state.account;
  $('input-pseudo').value = state.account?.name || '';
  showView('login');
  $('input-pseudo').focus();
  $('input-pseudo').select();
}

function applyAccount(account) {
  const firstTime = !state.account;
  state.account = account;
  if (!account) {
    openLogin();
    return;
  }
  $('account-name').textContent = account.name;
  $('account-avatar').src = account.avatarUrl || 'assets/icon.png';
  showView('main');
  if (firstTime) loadModpackInfo();
}

async function submitPseudo(event) {
  event.preventDefault();
  const button = $('btn-login');
  showLoginError('');
  button.disabled = true;
  try {
    applyAccount(await api.account.connecter($('input-pseudo').value.trim()));
  } catch (err) {
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

/* ------------------------------------------------------------------ *
 *  Accueil
 * ------------------------------------------------------------------ */

function renderNews(items) {
  const list = $('news-list');
  if (!items.length) {
    list.innerHTML = '<li class="news__empty">Aucune actualité pour le moment.</li>';
    return;
  }
  list.innerHTML = items.slice(0, 12).map((item) => `
    <li class="news__item">
      <h3>${escapeHtml(item.title || 'Sans titre')}</h3>
      <p>${escapeHtml(item.body || '')}</p>
      ${item.date ? `<time>${escapeHtml(item.date)}</time>` : ''}
    </li>`).join('');
}

function renderLinks(links = {}) {
  $('btn-discord').hidden = !links.discord;
  $('btn-trailer').hidden = !youtubeId(links.trailer);
}

/** Ligne sous le pseudo, quand rien n'est en cours. */
function setLaunchLine(html, kind = '') {
  const line = $('launch-line');
  line.innerHTML = html;
  line.className = `launch__line${kind ? ` is-${kind}` : ''}`;
}

function showIdleLine() {
  const host = state.info?.server?.host;
  if (state.settings?.joinServerOnLaunch !== false && host) {
    setLaunchLine(`Connexion directe à <strong>${escapeHtml(host)}</strong>`);
  } else {
    setLaunchLine('Le jeu s’ouvrira sur le menu principal');
  }
}

async function refreshServerStatus() {
  const { host, port } = state.info.server;
  const dot = $('status-dot');
  const text = $('status-text');
  dot.className = 'dot is-checking';

  try {
    const status = await api.server.status({ host, port });
    if (status.online) {
      dot.className = 'dot is-online';
      const { online } = status.players;
      text.textContent = online ? `En ligne · ${plural(online, 'joueur')}` : 'En ligne';
    } else {
      dot.className = 'dot is-offline';
      text.textContent = 'Hors ligne';
    }
  } catch {
    dot.className = 'dot';
    text.textContent = 'État inconnu';
  }
}

async function loadModpackInfo() {
  try {
    const info = await api.modpack.info();
    Object.assign(state.info, {
      server: info.server,
      links: info.links,
      authNotice: info.authNotice,
    });

    $('pack-version').textContent = info.modpackVersion
      ? `Modpack ${info.modpackVersion} · Minecraft ${info.minecraftVersion} · Forge ${info.forgeVersion}`
      : `Minecraft ${info.minecraftVersion} · Forge ${info.forgeVersion}`;
    $('server-address').textContent = serverAddress();
    renderNews(info.news);
    renderLinks(info.links);
    renderAuthNotice(info.authNotice);
    if (!state.launching) showIdleLine();

    if (info.offline) {
      toast('Modpack injoignable : le launcher utilise sa dernière copie locale.', 'error', 8000);
    }
  } catch (err) {
    renderNews([]);
    toast(`Informations du modpack indisponibles : ${err.message}`, 'error', 8000);
  }

  refreshServerStatus();
  clearInterval(state.statusTimer);
  state.statusTimer = setInterval(refreshServerStatus, 60000);
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

function startBackdropRotation() {
  const layers = [...document.querySelectorAll('.backdrop__layer')];
  let index = 0;
  setInterval(() => {
    layers[index].classList.remove('is-visible');
    index = (index + 1) % layers.length;
    layers[index].classList.add('is-visible');
  }, 12000);
}

/* ------------------------------------------------------------------ *
 *  Lancement
 * ------------------------------------------------------------------ */

function setLaunching(active) {
  state.launching = active;
  $('btn-play').disabled = active;
  $('btn-play-label').textContent = active ? 'Lancement' : 'Jouer';
  $('btn-account').disabled = active;
  $('progress').hidden = !active;
  $('progress-fill').style.width = '0%';
  $('progress-detail').textContent = '';
}

async function play() {
  if (state.launching) return;
  setLaunching(true);
  setLaunchLine('Préparation…');

  try {
    await api.game.launch();
    $('progress').hidden = true;
    $('btn-play-label').textContent = 'En jeu';
    setLaunchLine('Minecraft est lancé. Bon jeu !', 'success');

    // Rappel au moment où il sert : le joueur arrive sur le serveur.
    const notice = state.info.authNotice;
    if (notice?.body) toast(`${notice.title}\n\n${notice.body}`, 'info', 20000);

    if (state.settings.closeOnLaunch) setTimeout(() => api.window.close(), 1200);
  } catch (err) {
    setLaunching(false);
    setLaunchLine(escapeHtml(err.message), 'error');
  }
}

function wireGameEvents() {
  api.game.onStatus(({ message }) => {
    if (state.launching) setLaunchLine(escapeHtml(message));
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

  api.game.onExit(({ error, log, diagnostic }) => {
    setLaunching(false);
    if (!error) {
      showIdleLine();
      return;
    }
    if (diagnostic) {
      setLaunchLine(escapeHtml(diagnostic.titre), 'error');
      const extrait = diagnostic.extrait ? `\n\n(${diagnostic.extrait})` : '';
      toast(`${diagnostic.titre}\n\n${diagnostic.cause}\n\n${diagnostic.solution}${extrait}`, 'error', 30000);
    } else {
      setLaunchLine(escapeHtml(error), 'error');
      toast(`${error}\n\nRéglages → Journaux : envoie le dernier fichier au staff.`, 'error', 15000);
    }
    console.error('Sortie du jeu', log);
  });

  api.game.onLog(({ line }) => console.log('[minecraft]', line));
}

/* ------------------------------------------------------------------ *
 *  Panneaux latéraux
 * ------------------------------------------------------------------ */

const drawerCloseHooks = {};

function openDrawer(id) {
  $(id).hidden = false;
}

async function closeDrawer(id) {
  try {
    await drawerCloseHooks[id]?.();
  } finally {
    $(id).hidden = true;
  }
}

function wireDrawers() {
  for (const drawer of document.querySelectorAll('.drawer')) {
    for (const el of drawer.querySelectorAll('[data-close]')) {
      el.addEventListener('click', () => closeDrawer(drawer.id));
    }
  }
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const open = [...document.querySelectorAll('.drawer')].find((d) => !d.hidden);
    if (open) closeDrawer(open.id);
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
    await closeDrawer('drawer-options');
    toast(
      ids.length
        ? `${plural(ids.length, 'mod')} installé${ids.length > 1 ? 's' : ''} au prochain lancement.`
        : 'Les mods optionnels seront retirés au prochain lancement.',
      'success',
    );
  } catch (err) {
    toast(`Enregistrement impossible : ${err.message}`, 'error');
  } finally {
    button.disabled = false;
  }
}

/* ------------------------------------------------------------------ *
 *  Réglages
 * ------------------------------------------------------------------ */

async function saveSettings(patch) {
  try {
    state.settings = { ...state.settings, ...(await api.settings.save(patch)) };
  } catch (err) {
    toast(`Réglage non enregistré : ${err.message}`, 'error', 8000);
    throw err;
  }
}

const formatRam = (mb) => `${(mb / 1024).toFixed(1).replace('.0', '')} Go`;

async function openSettings() {
  state.settings = await api.settings.get();
  const s = state.settings;

  $('input-ram').max = Math.min(16384, s.systemRamMb);
  $('input-ram').value = s.maxRamMb;
  $('output-ram').textContent = formatRam(s.maxRamMb);
  $('ram-help').textContent = `Ta machine a ${formatRam(s.systemRamMb)}. Conseillé : ${formatRam(s.recommendedRamMb)}.`;
  $('check-join-server').checked = s.joinServerOnLaunch;
  $('check-close-launcher').checked = s.closeOnLaunch;
  $('input-game-root').value = s.gameRoot || state.info.defaultRoot;
  $('input-java-path').value = s.javaPath || '';
  $('input-jvm-args').value = s.jvmArgs || '';

  openDrawer('drawer-settings');
}

function wireSettings() {
  const ram = $('input-ram');
  ram.addEventListener('input', () => { $('output-ram').textContent = formatRam(ram.value); });
  ram.addEventListener('change', () => {
    const maxRamMb = Number(ram.value);
    saveSettings({ maxRamMb, minRamMb: Math.max(1024, Math.floor(maxRamMb / 2)) }).catch(() => {});
  });

  $('check-join-server').addEventListener('change', async (e) => {
    await saveSettings({ joinServerOnLaunch: e.target.checked }).catch(() => {});
    if (!state.launching) showIdleLine();
  });
  $('check-close-launcher').addEventListener('change', (e) => {
    saveSettings({ closeOnLaunch: e.target.checked }).catch(() => {});
  });

  $('btn-pick-folder').addEventListener('click', async () => {
    const folder = await api.settings.pickFolder();
    if (!folder) return;
    await saveSettings({ gameRoot: folder });
    $('input-game-root').value = folder;
    toast('Dossier modifié : le jeu y sera téléchargé au prochain lancement.', 'info');
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
  drawerCloseHooks['drawer-settings'] = () => (jvmTimer ? saveJvm().catch(() => {}) : null);

  $('btn-open-game-folder').addEventListener('click', () => api.folders.game());
  $('btn-open-logs').addEventListener('click', () => api.folders.logs());

  $('btn-repair').addEventListener('click', async () => {
    try {
      if (await api.game.repair()) {
        await closeDrawer('drawer-settings');
        toast('Installation réinitialisée. Tout sera retéléchargé au prochain lancement.', 'success');
      }
    } catch (err) {
      toast(err.message, 'error', 9000);
    }
  });
}

/* ------------------------------------------------------------------ *
 *  Mise à jour du launcher
 * ------------------------------------------------------------------ */

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
  $('form-pseudo').addEventListener('submit', submitPseudo);
  $('btn-login-back').addEventListener('click', () => showView('main'));
  $('btn-account').addEventListener('click', openLogin);
  $('btn-play').addEventListener('click', play);
  // Hors ligne, Crafatar ne répond pas : l'icône du serveur remplace l'avatar.
  $('account-avatar').addEventListener('error', (e) => { e.target.src = 'assets/icon.png'; }, { once: true });
  $('btn-copy-ip').addEventListener('click', copyServerAddress);
  $('btn-trailer').addEventListener('click', () => openLink(state.info.links.trailer, 'la bande-annonce'));
  $('btn-discord').addEventListener('click', () => openLink(state.info.links.discord, 'le Discord'));
  $('btn-options').addEventListener('click', openOptions);
  $('btn-options-save').addEventListener('click', saveOptions);
  $('btn-settings').addEventListener('click', () => openSettings().catch((err) => toast(err.message, 'error')));
  $('options-list').addEventListener('change', refreshOptionsCount);

  wireDrawers();
  wireSettings();
  wireGameEvents();
  wireUpdater();
  startBackdropRotation();

  try {
    state.info = await api.app.info();
    state.settings = await api.settings.get();
    $('launcher-version').textContent = `v${state.info.version}`;
    $('server-address').textContent = serverAddress();
    renderLinks(state.info.links);
    renderAuthNotice(state.info.authNotice);
    showIdleLine();
    applyAccount(await api.account.get());
  } catch (err) {
    showView('login');
    showLoginError(`Le launcher n’a pas pu démarrer : ${err.message}`);
  }
}

document.addEventListener('DOMContentLoaded', init);
