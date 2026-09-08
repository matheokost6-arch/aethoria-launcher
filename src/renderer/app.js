'use strict';

/* ------------------------------------------------------------------ *
 *  Aethoria Launcher — interface
 *  Aucun acces a Node ici : tout passe par le pont window.aethoria.
 * ------------------------------------------------------------------ */

const api = window.aethoria;
const $ = (id) => document.getElementById(id);

const state = {
  accounts: [],
  selectedId: null,
  settings: null,
  launching: false,
  modpackLoaded: false,
  statusTimer: null,
};

/* ------------------------------------------------------------------ *
 *  Utilitaires d'affichage
 * ------------------------------------------------------------------ */

function toast(message, kind = 'info', duration = 6000) {
  const el = document.createElement('div');
  el.className = `toast toast--${kind}`;
  el.textContent = message;
  $('toasts').appendChild(el);
  setTimeout(() => {
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), 220);
  }, duration);
}

function setHint(message, kind = '') {
  const hint = $('game-hint');
  hint.textContent = message || '';
  hint.className = `dock__hint${kind ? ` is-${kind}` : ''}`;
  hint.hidden = !message;
}

function showLoginError(message) {
  const el = $('login-error');
  el.textContent = message || '';
  el.hidden = !message;
}

function formatBytes(bytes) {
  if (!bytes) return '';
  const units = ['o', 'Ko', 'Mo', 'Go'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(value < 10 && unit > 0 ? 1 : 0)} ${units[unit]}`;
}

/* ------------------------------------------------------------------ *
 *  Navigation entre les vues
 * ------------------------------------------------------------------ */

function showView(name) {
  $('view-login').hidden = name !== 'login';
  $('view-main').hidden = name !== 'main';
}

/* ------------------------------------------------------------------ *
 *  Comptes
 * ------------------------------------------------------------------ */

function accountTypeLabel(account) {
  return account.type === 'microsoft' ? 'Compte Microsoft' : 'Compte hors-ligne';
}

function renderAccounts() {
  const selected = state.accounts.find((a) => a.id === state.selectedId) || state.accounts[0] || null;
  state.selectedId = selected?.id || null;

  if (!selected) {
    showView('login');
    $('login-back').hidden = true;
    return;
  }

  showView('main');
  // Les informations du modpack ne dependent pas du compte : un seul chargement
  // suffit, declenche des qu'un compte existe.
  if (!state.modpackLoaded) {
    state.modpackLoaded = true;
    loadModpackInfo();
  }
  $('account-name').textContent = selected.name;
  $('account-type').textContent = accountTypeLabel(selected);
  $('account-avatar').src = selected.avatarUrl;
  $('account-avatar').alt = `Avatar de ${selected.name}`;

  const list = $('account-list');
  list.innerHTML = '';
  for (const account of state.accounts) {
    const item = document.createElement('button');
    item.className = `menu__item${account.id === state.selectedId ? ' is-selected' : ''}`;
    item.innerHTML = `
      <img src="${account.avatarUrl}" alt="">
      <span>${escapeHtml(account.name)}</span>
      <small>${account.type === 'microsoft' ? 'Microsoft' : 'Hors-ligne'}</small>`;
    item.addEventListener('click', async () => {
      const result = await api.accounts.select(account.id);
      applyAccounts(result);
      closeAccountMenu();
    });
    list.appendChild(item);
  }

  $('btn-remove-account').textContent = `Retirer ${selected.name}`;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function applyAccounts(result) {
  state.accounts = result.accounts;
  state.selectedId = result.selectedId;
  renderAccounts();
}

function closeAccountMenu() {
  $('account-menu').hidden = true;
  $('btn-account').setAttribute('aria-expanded', 'false');
}

/* ------------------------------------------------------------------ *
 *  Connexion
 * ------------------------------------------------------------------ */

async function loginMicrosoft(button) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = 'Connexion en cours...';
  showLoginError('');
  try {
    applyAccounts(await api.accounts.loginMicrosoft());
    toast('Compte Microsoft connecte.', 'success', 4000);
  } catch (err) {
    // Une fermeture de fenetre n'est pas une erreur a signaler bruyamment.
    if (!/fermee avant la fin|annulee/i.test(err.message)) {
      showLoginError(err.message);
      toast(err.message, 'error', 9000);
    }
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

async function loginOffline(name) {
  showLoginError('');
  try {
    applyAccounts(await api.accounts.loginOffline(name));
  } catch (err) {
    showLoginError(err.message);
  }
}

/* ------------------------------------------------------------------ *
 *  Lancement du jeu
 * ------------------------------------------------------------------ */

function setLaunching(active) {
  state.launching = active;
  $('btn-play').disabled = active;
  $('btn-play').textContent = active ? 'LANCEMENT...' : 'JOUER';
  $('progress').hidden = !active;
  if (!active) {
    $('progress-fill').style.width = '0%';
    $('progress-percent').textContent = '';
  }
}

async function play() {
  if (state.launching || !state.selectedId) return;
  setLaunching(true);
  setHint('');
  $('progress-status').textContent = 'Preparation...';

  try {
    await api.game.launch(state.selectedId);
    setHint('Minecraft est lance. Bon jeu !', 'success');
    $('progress').hidden = true;
    $('btn-play').textContent = 'EN JEU';

    if (state.settings?.closeOnLaunch) {
      setTimeout(() => api.window.close(), 1200);
    }
  } catch (err) {
    setLaunching(false);
    setHint(err.message, 'error');
    toast(err.message, 'error', 12000);
  }
}

/* ------------------------------------------------------------------ *
 *  Parametres
 * ------------------------------------------------------------------ */

function openSettings() {
  const s = state.settings;
  $('input-max-ram').value = s.maxRamMb;
  $('output-max-ram').textContent = `${(s.maxRamMb / 1024).toFixed(1)} Go`;
  $('input-game-root').value = s.gameRoot || state.info.defaultRoot;
  $('input-java-path').value = s.javaPath || '';
  $('input-jvm-args').value = s.jvmArgs || '';
  $('check-join-server').checked = Boolean(s.joinServerOnLaunch);
  $('check-close-launcher').checked = Boolean(s.closeOnLaunch);
  $('check-keep-mods').checked = s.keepExtraMods !== false;
  $('modal-settings').hidden = false;
}

async function saveSettings(patch) {
  state.settings = await api.settings.save(patch);
  return state.settings;
}

/* ------------------------------------------------------------------ *
 *  Modpack et actualites
 * ------------------------------------------------------------------ */

function renderNews(items) {
  const list = $('news-list');
  if (!items.length) {
    list.innerHTML = '<li class="news__empty">Aucune actualite pour le moment.</li>';
    return;
  }
  list.innerHTML = '';
  for (const item of items.slice(0, 12)) {
    const li = document.createElement('li');
    li.className = 'news__item';
    li.innerHTML = `
      <h3>${escapeHtml(item.title || 'Sans titre')}</h3>
      <p>${escapeHtml(item.body || item.text || '')}</p>
      ${item.date ? `<time>${escapeHtml(item.date)}</time>` : ''}`;
    list.appendChild(li);
  }
}

/**
 * Interroge le serveur et met a jour la pastille d'etat.
 * Le serveur du manifest prime : il peut changer sans nouveau launcher.
 */
async function refreshServerStatus(target) {
  const dot = $('status-dot');
  const text = $('status-text');
  dot.className = 'status__dot is-checking';
  text.textContent = 'Verification du serveur...';

  try {
    const status = await api.server.status(target);
    if (status.online) {
      dot.className = 'status__dot is-online';
      const { online, max } = status.players;
      const joueurs = online === 0
        ? 'aucun joueur connecte'
        : `${online} joueur${online > 1 ? 's' : ''} en ligne`;
      text.textContent = `En ligne — ${joueurs}${max ? ` (max ${max})` : ''}`;
      text.title = status.motd || '';
    } else {
      dot.className = 'status__dot is-offline';
      text.textContent = 'Serveur hors ligne';
      text.title = '';
    }
  } catch {
    // L'etat du serveur est purement informatif : en cas d'echec on reste muet
    // plutot que d'alarmer le joueur, qui peut tres bien vouloir jouer quand meme.
    dot.className = 'status__dot';
    text.textContent = '';
  }
}

async function loadModpackInfo() {
  try {
    const info = await api.modpack.info();
    $('pack-version').textContent = info.modpackVersion
      ? `Modpack ${info.modpackVersion} — Minecraft ${info.minecraftVersion} / Forge ${info.forgeVersion}`
      : `Minecraft ${info.minecraftVersion} — Forge ${info.forgeVersion}`;
    $('server-address').innerHTML = `Serveur : <strong>${escapeHtml(info.server.host)}${info.server.port === 25565 ? '' : `:${info.server.port}`}</strong>`;
    renderNews(info.news || []);

    refreshServerStatus(info.server);
    // Rafraichissement periodique : le joueur laisse souvent le launcher ouvert.
    clearInterval(state.statusTimer);
    state.statusTimer = setInterval(() => refreshServerStatus(info.server), 60000);
    if (info.offline) {
      toast('Manifest du modpack injoignable : le launcher utilise sa derniere copie locale.', 'error', 8000);
    }
  } catch (err) {
    $('pack-version').textContent = 'Modpack Aethoria';
    toast(`Informations du modpack indisponibles : ${err.message}`, 'error', 8000);
  }
}

/* ------------------------------------------------------------------ *
 *  Decor
 * ------------------------------------------------------------------ */

/** Fait defiler les captures du serveur en arriere-plan. */
function startBackdropRotation() {
  const layers = [...document.querySelectorAll('.backdrop__layer')];
  if (layers.length < 2) return;
  let index = 0;
  setInterval(() => {
    layers[index].classList.remove('is-visible');
    index = (index + 1) % layers.length;
    layers[index].classList.add('is-visible');
  }, 14000);
}

/* ------------------------------------------------------------------ *
 *  Cablage des evenements
 * ------------------------------------------------------------------ */

function wireTitlebar() {
  $('btn-minimize').addEventListener('click', () => api.window.minimize());
  $('btn-close').addEventListener('click', () => api.window.close());
}

function wireLogin() {
  const tabs = [
    { tab: $('tab-microsoft'), panel: $('panel-microsoft') },
    { tab: $('tab-offline'), panel: $('panel-offline') },
  ];
  for (const { tab, panel } of tabs) {
    tab.addEventListener('click', () => {
      showLoginError('');
      for (const other of tabs) {
        const active = other.tab === tab;
        other.tab.classList.toggle('is-active', active);
        other.tab.setAttribute('aria-selected', String(active));
        other.panel.classList.toggle('is-active', active);
      }
      if (panel === $('panel-offline')) $('input-offline-name').focus();
    });
  }

  $('btn-login-microsoft').addEventListener('click', (e) => loginMicrosoft(e.currentTarget));
  $('login-back').addEventListener('click', () => {
    showLoginError('');
    showView('main');
  });
  $('form-offline').addEventListener('submit', (e) => {
    e.preventDefault();
    loginOffline($('input-offline-name').value);
  });
}

function wireAccountMenu() {
  const menu = $('account-menu');
  const button = $('btn-account');

  button.addEventListener('click', (e) => {
    e.stopPropagation();
    const willOpen = menu.hidden;
    menu.hidden = !willOpen;
    button.setAttribute('aria-expanded', String(willOpen));
  });

  document.addEventListener('click', (e) => {
    if (!menu.hidden && !$('account-switcher').contains(e.target)) closeAccountMenu();
  });

  $('btn-add-microsoft').addEventListener('click', async (e) => {
    closeAccountMenu();
    await loginMicrosoft(e.currentTarget);
  });

  $('btn-add-offline').addEventListener('click', () => {
    closeAccountMenu();
    showView('login');
    $('login-back').hidden = false; // il y a deja un compte : on doit pouvoir revenir
    $('tab-offline').click();
    $('input-offline-name').value = '';
  });

  $('btn-remove-account').addEventListener('click', async () => {
    if (!state.selectedId) return;
    closeAccountMenu();
    applyAccounts(await api.accounts.remove(state.selectedId));
  });
}

function wireDock() {
  $('btn-play').addEventListener('click', play);
  $('btn-mods').addEventListener('click', async () => {
    const dir = await api.folders.mods();
    toast(`Dossier des mods ouvert :\n${dir}`, 'info', 5000);
  });
  $('btn-settings').addEventListener('click', openSettings);
}

function wireSettings() {
  const modal = $('modal-settings');
  for (const el of modal.querySelectorAll('[data-close-modal]')) {
    el.addEventListener('click', () => { modal.hidden = true; });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hidden) modal.hidden = true;
  });

  const ram = $('input-max-ram');
  ram.addEventListener('input', () => {
    $('output-max-ram').textContent = `${(ram.value / 1024).toFixed(1)} Go`;
  });
  ram.addEventListener('change', async () => {
    const maxRamMb = Number(ram.value);
    // On garde -Xms a la moitie de -Xmx : la JVM demarre plus vite sans
    // reserver inutilement toute la memoire des le lancement.
    await saveSettings({ maxRamMb, minRamMb: Math.max(1024, Math.floor(maxRamMb / 2)) });
    $('output-max-ram').textContent = `${(state.settings.maxRamMb / 1024).toFixed(1)} Go`;
  });

  $('btn-pick-folder').addEventListener('click', async () => {
    const folder = await api.settings.pickFolder();
    if (!folder) return;
    await saveSettings({ gameRoot: folder });
    $('input-game-root').value = folder;
    toast('Dossier du jeu modifie. Les fichiers seront retelecharges au prochain lancement.', 'info', 8000);
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
    toast('Java repasse en mode automatique.', 'success', 4000);
  });

  $('input-jvm-args').addEventListener('change', (e) => saveSettings({ jvmArgs: e.target.value }));
  $('check-join-server').addEventListener('change', (e) => saveSettings({ joinServerOnLaunch: e.target.checked }));
  $('check-close-launcher').addEventListener('change', (e) => saveSettings({ closeOnLaunch: e.target.checked }));
  $('check-keep-mods').addEventListener('change', (e) => saveSettings({ keepExtraMods: e.target.checked }));

  $('btn-open-game-folder').addEventListener('click', () => api.folders.game());
  $('btn-open-logs').addEventListener('click', () => api.folders.logs());

  $('btn-repair').addEventListener('click', async () => {
    try {
      const done = await api.game.repair();
      if (done) {
        modal.hidden = true;
        toast('Installation reinitialisee.', 'success', 6000);
      }
    } catch (err) {
      toast(err.message, 'error', 9000);
    }
  });
}

function wireGameEvents() {
  api.game.onStatus(({ message }) => {
    $('progress-status').textContent = message;
  });

  api.game.onProgress((p) => {
    const percent = Math.max(0, Math.min(100, p.percent || 0));
    $('progress-fill').style.width = `${percent}%`;
    $('progress-percent').textContent = p.totalBytes
      ? `${formatBytes(p.bytes)} / ${formatBytes(p.totalBytes)}`
      : `${Math.round(percent)} %`;
  });

  api.game.onExit(({ code, error, log }) => {
    setLaunching(false);
    if (!error) {
      setHint('Minecraft a ete ferme.');
      return;
    }
    setHint(error, 'error');
    // Le code 1 juste apres un lancement est presque toujours un crash de mod :
    // on oriente le joueur vers les journaux plutot que vers un code brut.
    const detail = log ? `\n\nDernieres lignes :\n${log.split('\n').slice(-6).join('\n')}` : '';
    toast(`${error}${detail}`, 'error', 15000);
    console.error('Sortie du jeu', { code, log });
  });

  api.game.onLog(({ line }) => console.log('[minecraft]', line));
}

function wireUpdater() {
  const bar = $('updatebar');
  const text = $('updatebar-text');
  const install = $('btn-update-install');

  api.updater.onStatus((status) => {
    switch (status.state) {
      case 'available':
        bar.hidden = false;
        text.textContent = `Mise a jour ${status.version} en telechargement...`;
        break;
      case 'downloading':
        bar.hidden = false;
        text.textContent = `Telechargement de la mise a jour : ${Math.round(status.percent)} %`;
        break;
      case 'ready':
        bar.hidden = false;
        text.textContent = `Version ${status.version} prete a etre installee.`;
        install.hidden = false;
        break;
      default:
        // Une erreur de mise a jour ne doit pas empecher de jouer : on reste discret.
        bar.hidden = true;
    }
  });

  install.addEventListener('click', () => api.updater.install());
}

/* ------------------------------------------------------------------ *
 *  Demarrage
 * ------------------------------------------------------------------ */

async function init() {
  wireTitlebar();
  wireLogin();
  wireAccountMenu();
  wireDock();
  wireSettings();
  wireGameEvents();
  wireUpdater();
  startBackdropRotation();

  try {
    state.info = await api.app.info();
    $('launcher-version').textContent = `v${state.info.version}`;
    state.settings = await api.settings.get();
    applyAccounts(await api.accounts.list());
  } catch (err) {
    toast(`Le launcher n'a pas pu demarrer correctement : ${err.message}`, 'error', 15000);
    return;
  }

}

document.addEventListener('DOMContentLoaded', init);
