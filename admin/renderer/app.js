'use strict';

/* Aethoria Admin — interface. Aucun accès à Node : tout passe par window.admin. */

const api = window.admin;
const $ = (id) => document.getElementById(id);

const ACTION_LABELS = {
  kick: 'Expulsion',
  mute: 'Mute',
  unmute: 'Parole rendue',
  ban: 'Bannissement',
  unban: 'Débannissement',
  message: 'Message privé',
  broadcast: 'Annonce',
  server: 'Serveur',
  'whitelist-add': 'Liste blanche +',
  'whitelist-remove': 'Liste blanche −',
  console: 'Console',
};

const state = {
  durations: {},
  player: null,         // pseudo de la fiche ouverte
  online: new Set(),    // pseudos connectés au dernier rafraîchissement
  refreshTimer: null,
  history: [],          // commandes de la console
  historyIndex: 0,
  confirm: null,        // résolution de la confirmation en cours
  journal: [],          // entrées du journal, filtrées à l'affichage
};

/* ------------------------------------------------------------------ *
 *  Utilitaires
 * ------------------------------------------------------------------ */

function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

const plural = (n, word) => `${n} ${word}${n > 1 ? 's' : ''}`;

function toast(message, kind = 'info', duration = 5000) {
  const el = document.createElement('div');
  el.className = `toast toast--${kind}`;
  el.textContent = message;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), duration);
}

const avatar = (uuid) => `https://crafatar.com/avatars/${encodeURIComponent(uuid)}?size=64&overlay&default=MHF_Steve`;

/** Demande de confirmation : se résout à true (Confirmer) ou false (Annuler, Échap). */
function confirmAction(title, text) {
  $('confirm-title').textContent = title;
  $('confirm-text').textContent = text;
  $('modal-confirm').hidden = false;
  $('btn-confirm-cancel').focus();
  return new Promise((resolve) => { state.confirm = resolve; });
}

function settleConfirm(value) {
  $('modal-confirm').hidden = true;
  state.confirm?.(value);
  state.confirm = null;
}

/* ------------------------------------------------------------------ *
 *  Connexion
 * ------------------------------------------------------------------ */

async function loadSavedConnection() {
  const saved = await api.connection.saved();
  $('input-host').value = saved.host;
  $('input-port').value = saved.port;
  $('check-remember').checked = saved.remembered;
  $('password-help').hidden = !saved.remembered;
  $('btn-forget').hidden = !saved.remembered;
}

async function connect(event) {
  event?.preventDefault();
  const button = $('btn-connect');
  $('connect-error').hidden = true;
  button.disabled = true;
  button.textContent = 'Connexion…';
  try {
    const target = await api.connection.connect({
      host: $('input-host').value,
      port: $('input-port').value,
      password: $('input-password').value,
      remember: $('check-remember').checked,
    });
    $('input-password').value = '';
    $('server-label').textContent = `${target.host}:${target.port}`;
    $('connection-status').textContent = '● Connecté';
    $('connection-status').className = 'titlebar__status is-online';
    $('view-connect').hidden = true;
    $('view-app').hidden = false;
    showView('players');
  } catch (err) {
    $('connect-error').textContent = err.message;
    $('connect-error').hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = 'Se connecter';
  }
}

function backToConnect(message) {
  clearInterval(state.refreshTimer);
  settleConfirm(false);
  $('drawer-player').hidden = true;
  $('view-app').hidden = true;
  $('view-connect').hidden = false;
  $('connection-status').textContent = '';
  loadSavedConnection().catch(() => {});
  $('connect-error').textContent = message || '';
  $('connect-error').hidden = !message;
}

/* ------------------------------------------------------------------ *
 *  Navigation
 * ------------------------------------------------------------------ */

function showView(name) {
  for (const nav of document.querySelectorAll('.nav')) nav.classList.toggle('is-active', nav.dataset.view === name);
  for (const view of ['players', 'server', 'console', 'journal']) $(`view-${view}`).hidden = view !== name;

  clearInterval(state.refreshTimer);
  if (name === 'players') {
    refreshPlayers();
    state.refreshTimer = setInterval(refreshPlayers, 15000);
  }
  if (name === 'journal') loadJournal();
  if (name === 'server') {
    loadWhitelist();
    loadBans();
  }
  if (name === 'console') $('input-console').focus();
}

/* ------------------------------------------------------------------ *
 *  Joueurs en ligne
 * ------------------------------------------------------------------ */

async function refreshPlayers() {
  try {
    const { online, max, players } = await api.players.online();
    state.online = new Set(players.map((p) => p.name.toLowerCase()));
    $('players-count').textContent = `${plural(online, 'joueur')} en ligne${max ? ` sur ${max}` : ''}`;
    $('players-list').innerHTML = players.length
      ? players.map((player) => `
        <div class="player-row">
          <img class="player-head" src="${avatar(player.uuid)}" alt="" width="36" height="36">
          <strong class="player-row__name">${escapeHtml(player.name)}</strong>
          <span class="player-row__actions">
            <button class="btn btn--small btn--ghost" data-open="${escapeHtml(player.name)}" data-tab="info">Infos</button>
            <button class="btn btn--small btn--ghost" data-open="${escapeHtml(player.name)}" data-tab="inventory">Inventaire</button>
            <button class="btn btn--small btn--primary" data-open="${escapeHtml(player.name)}" data-tab="sanctions">Sanctions</button>
          </span>
        </div>`).join('')
      : '<p class="empty">Aucun joueur connecté pour le moment.</p>';
  } catch (err) {
    $('players-count').textContent = `Liste indisponible : ${err.message}`;
  }
}

/* ------------------------------------------------------------------ *
 *  Fiche joueur
 * ------------------------------------------------------------------ */

function renderDurations() {
  for (const group of document.querySelectorAll('.durations[data-for]')) {
    const name = `${group.dataset.for}-duration`;
    group.innerHTML = Object.entries(state.durations).map(([value, label], i) => `
      <label><input type="radio" name="${name}" value="${value}" ${i === 1 ? 'checked' : ''}><span>${escapeHtml(label)}</span></label>`).join('');
  }
}

async function openPlayer(pseudo, tab = 'sanctions') {
  const name = String(pseudo).trim();
  if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) {
    toast('Pseudo invalide : 3 à 16 caractères, lettres, chiffres et _.', 'error');
    return;
  }
  state.player = name;
  $('player-name').textContent = name;
  const online = state.online.has(name.toLowerCase());
  $('player-status').textContent = online ? '● En ligne' : 'Hors ligne';
  $('player-status').className = `help${online ? ' is-online' : ''}`;
  $('player-avatar').src = avatar(await api.players.avatar(name));
  for (const id of ['kick-reason', 'mute-reason', 'ban-reason', 'message-text']) $(id).value = '';
  $('action-result').hidden = true;
  $('drawer-player').hidden = false;
  showTab(tab);
}

function showTab(tab) {
  for (const button of document.querySelectorAll('.tab')) button.classList.toggle('is-active', button.dataset.tab === tab);
  for (const name of ['sanctions', 'inventory', 'info']) $(`tab-${name}`).hidden = name !== tab;
  if (tab === 'inventory') loadInventory();
  if (tab === 'info') loadInfo();
}

function showResult(text, kind) {
  const result = $('action-result');
  result.textContent = text;
  result.className = `result is-${kind}`;
  result.hidden = false;
}

async function act(action) {
  const pseudo = state.player;
  const duration = document.querySelector(`input[name="${action}-duration"]:checked`)?.value;
  const reason = $(`${action}-reason`)?.value || '';

  if (action === 'ban') {
    const ok = await confirmAction(
      `Bannir ${pseudo} ?`,
      `${duration === 'perm' ? 'Bannissement définitif' : `Bannissement de ${state.durations[duration]}`}. `
        + `Raison : ${reason.trim() || 'aucune raison précisée'}.`,
    );
    if (!ok) return;
  }

  const buttons = document.querySelectorAll('#tab-sanctions [data-act]');
  buttons.forEach((b) => { b.disabled = true; });
  try {
    const { output, skipped } = await api.players.act({ action, pseudo, duration, reason });
    showResult(output, skipped ? 'info' : 'success');
    if (!skipped) toast(`${ACTION_LABELS[action]} : ${pseudo}`, 'success');
    if (action === 'kick') setTimeout(refreshPlayers, 800);
  } catch (err) {
    showResult(err.message, 'error');
  } finally {
    buttons.forEach((b) => { b.disabled = false; });
  }
}

async function sendMessage(event) {
  event.preventDefault();
  const input = $('message-text');
  if (!input.value.trim()) return;
  try {
    showResult(await api.players.message(state.player, input.value), 'success');
    input.value = '';
  } catch (err) {
    showResult(err.message, 'error');
  }
}

/* Emplacements Minecraft : 0-8 barre d'action, 9-35 sac, 100-103 armure, -106 main secondaire. */
const EQUIPMENT = [[103, 'Casque'], [102, 'Plastron'], [101, 'Jambières'], [100, 'Bottes'], [-106, 'Main gauche']];

function slotHtml(item, hint = '') {
  if (!item) return `<div class="slot is-empty">${hint ? `<span class="slot__hint">${hint}</span>` : ''}</div>`;
  const title = `${item.label}${item.mod ? ` (${item.mod})` : ''} · ${item.id}${item.enchanted ? ' · enchanté' : ''}`;
  return `
    <div class="slot${item.enchanted ? ' is-enchanted' : ''}" title="${escapeHtml(title)}">
      <span class="slot__label">${escapeHtml(item.label)}</span>
      ${item.mod ? `<span class="slot__mod">${escapeHtml(item.mod)}</span>` : ''}
      ${item.count > 1 ? `<span class="slot__count">${item.count}</span>` : ''}
    </div>`;
}

async function loadInventory() {
  const view = $('inventory-view');
  const container = document.querySelector('input[name="container"]:checked').value;
  view.innerHTML = '<p class="help">Chargement…</p>';
  try {
    const result = await api.players.inventory(state.player, container);
    if (!result.online) {
      view.innerHTML = '<p class="empty">Le joueur doit être connecté pour voir son inventaire.</p>';
      return;
    }
    const bySlot = new Map(result.items.map((item) => [item.slot, item]));
    const slots = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => slotHtml(bySlot.get(from + i))).join('');

    view.innerHTML = container === 'EnderItems'
      ? `<p class="subtitle">Coffre de l’Ender · ${plural(result.items.length, 'objet')}</p>
         <div class="grid">${slots(0, 26)}</div>`
      : `<p class="subtitle">Équipement</p>
         <div class="grid grid--equipment">${EQUIPMENT.map(([slot, hint]) => slotHtml(bySlot.get(slot), hint)).join('')}</div>
         <p class="subtitle">Sac</p>
         <div class="grid">${slots(9, 35)}</div>
         <p class="subtitle">Barre d’action</p>
         <div class="grid">${slots(0, 8)}</div>`;
  } catch (err) {
    view.innerHTML = `<p class="empty">Inventaire indisponible : ${escapeHtml(err.message)}</p>`;
  }
}

async function loadInfo() {
  $('info-whois').textContent = 'Chargement…';
  $('info-seen').textContent = 'Chargement…';
  try {
    const { whois, seen } = await api.players.info(state.player);
    $('info-whois').textContent = whois || '(aucune réponse)';
    $('info-seen').textContent = seen || '(aucune réponse)';
  } catch (err) {
    $('info-whois').textContent = err.message;
    $('info-seen').textContent = '';
  }
}

/* ------------------------------------------------------------------ *
 *  Serveur : annonces, monde, liste blanche, bannis
 * ------------------------------------------------------------------ */

function serverResult(text, kind) {
  const result = $('server-result');
  result.textContent = text;
  result.className = `result is-${kind}`;
  result.hidden = false;
}

async function broadcast(event) {
  event.preventDefault();
  const input = $('input-broadcast');
  const text = input.value.trim();
  if (!text) return;
  if (!await confirmAction('Envoyer cette annonce ?', `Tous les joueurs connectés verront : « ${text} »`)) return;
  try {
    serverResult(await api.server.broadcast(text), 'success');
    toast('Annonce envoyée.', 'success');
    input.value = '';
  } catch (err) {
    serverResult(err.message, 'error');
  }
}

const WORLD_CONFIRM = {
  'whitelist-on': ['Activer la liste blanche ?', 'Seuls les joueurs de la liste pourront rejoindre le serveur.'],
  'whitelist-off': ['Désactiver la liste blanche ?', 'Tout le monde pourra de nouveau rejoindre le serveur.'],
};

async function worldAction(button) {
  const action = button.dataset.world;
  if (WORLD_CONFIRM[action] && !await confirmAction(...WORLD_CONFIRM[action])) return;
  button.disabled = true;
  try {
    serverResult(await api.server.world(action), 'success');
  } catch (err) {
    serverResult(err.message, 'error');
  } finally {
    button.disabled = false;
  }
}

function namesHtml(entries, emptyText) {
  return entries.length ? entries.join('') : `<li class="help">${emptyText}</li>`;
}

async function loadWhitelist() {
  try {
    const names = await api.server.whitelist();
    $('whitelist-list').innerHTML = namesHtml(names.map((name) => `
      <li><span>${escapeHtml(name)}</span>
        <button class="btn btn--small btn--ghost" data-whitelist-remove="${escapeHtml(name)}">Retirer</button></li>`),
    'Personne dans la liste blanche.');
  } catch (err) {
    $('whitelist-list').innerHTML = `<li class="help">Liste indisponible : ${escapeHtml(err.message)}</li>`;
  }
}

async function editWhitelist(pseudo, add) {
  try {
    serverResult(await api.server.whitelistEdit(pseudo, add), 'success');
    loadWhitelist();
  } catch (err) {
    serverResult(err.message, 'error');
  }
}

async function loadBans() {
  try {
    const bans = await api.server.bans();
    $('bans-list').innerHTML = namesHtml(bans.map((ban) => `
      <li><span><strong>${escapeHtml(ban.name)}</strong>
        <span class="help" title="${escapeHtml(ban.reason)}">${escapeHtml(ban.reason || 'Sans raison')} · par ${escapeHtml(ban.by)}</span></span>
        <button class="btn btn--small btn--ghost" data-unban="${escapeHtml(ban.name)}">Débannir</button></li>`),
    'Aucun joueur banni.');
  } catch (err) {
    $('bans-list').innerHTML = `<li class="help">Liste indisponible : ${escapeHtml(err.message)}</li>`;
  }
}

async function unbanFromList(pseudo) {
  if (!await confirmAction(`Débannir ${pseudo} ?`, 'Le joueur pourra de nouveau rejoindre le serveur.')) return;
  try {
    const { output } = await api.players.act({ action: 'unban', pseudo });
    serverResult(output, 'success');
    toast(`Débannissement : ${pseudo}`, 'success');
    loadBans();
  } catch (err) {
    serverResult(err.message, 'error');
  }
}

/* ------------------------------------------------------------------ *
 *  Console et journal
 * ------------------------------------------------------------------ */

function consoleLine(text, kind) {
  const line = document.createElement('div');
  line.className = `console__line console__line--${kind}`;
  line.textContent = text;
  $('console-output').appendChild(line);
  $('console-output').scrollTop = $('console-output').scrollHeight;
}

async function runConsole(event) {
  event?.preventDefault();
  const input = $('input-console');
  const command = input.value.trim();
  if (!command) return;
  state.history.push(command);
  state.historyIndex = state.history.length;
  input.value = '';
  consoleLine(`> ${command}`, 'command');
  try {
    consoleLine(await api.console.run(command) || '(aucune réponse)', 'output');
  } catch (err) {
    consoleLine(err.message, 'error');
  }
}

function browseHistory(event) {
  if (!['ArrowUp', 'ArrowDown'].includes(event.key) || !state.history.length) return;
  event.preventDefault();
  state.historyIndex += event.key === 'ArrowUp' ? -1 : 1;
  state.historyIndex = Math.max(0, Math.min(state.history.length, state.historyIndex));
  $('input-console').value = state.history[state.historyIndex] || '';
}

async function loadJournal() {
  state.journal = await api.journal.list().catch(() => []);
  renderJournal();
}

function renderJournal() {
  const query = $('journal-search').value.trim().toLowerCase();
  const type = $('journal-filter').value;
  const entries = state.journal.filter((entry) => (!type || entry.action === type || (type === 'server' && entry.action.startsWith('whitelist')))
    && (!query || [entry.pseudo, entry.reason, entry.command, entry.output].some((field) => String(field || '').toLowerCase().includes(query))));
  $('journal-list').innerHTML = entries.length
    ? entries.map((entry) => `
      <div class="journal__row">
        <span class="journal__date">${escapeHtml(new Date(entry.date).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))}</span>
        <span class="tag tag--${escapeHtml(entry.action)}">${escapeHtml(ACTION_LABELS[entry.action] || entry.action)}</span>
        <span class="journal__main">
          <strong>${escapeHtml(entry.pseudo || entry.command)}</strong>
          ${entry.duration ? `<span>${escapeHtml(state.durations[entry.duration] || entry.duration)}</span>` : ''}
          ${entry.reason ? `<span>« ${escapeHtml(entry.reason)} »</span>` : ''}
        </span>
        <span class="journal__output" title="${escapeHtml(entry.output)}">${escapeHtml(entry.output)}</span>
      </div>`).join('')
    : `<p class="empty">${state.journal.length ? 'Aucune action ne correspond.' : 'Aucune action pour le moment.'}</p>`;
}

/* ------------------------------------------------------------------ *
 *  Démarrage
 * ------------------------------------------------------------------ */

async function init() {
  $('btn-minimize').addEventListener('click', () => api.window.minimize());
  $('btn-close').addEventListener('click', () => api.window.close());
  $('form-connect').addEventListener('submit', connect);
  $('btn-forget').addEventListener('click', async () => {
    await api.connection.forget();
    toast('Mot de passe oublié sur ce PC.', 'info');
    loadSavedConnection();
  });
  $('btn-disconnect').addEventListener('click', async () => {
    await api.connection.disconnect();
    backToConnect();
  });
  api.connection.onLost(() => backToConnect('Connexion au serveur perdue. Reconnecte-toi.'));

  for (const nav of document.querySelectorAll('.nav')) nav.addEventListener('click', () => showView(nav.dataset.view));
  $('btn-refresh').addEventListener('click', refreshPlayers);
  $('form-find').addEventListener('submit', (e) => {
    e.preventDefault();
    openPlayer($('input-find').value);
  });
  $('players-list').addEventListener('click', (e) => {
    const button = e.target.closest('[data-open]');
    if (button) openPlayer(button.dataset.open, button.dataset.tab);
  });

  for (const tab of document.querySelectorAll('.tab')) tab.addEventListener('click', () => showTab(tab.dataset.tab));
  for (const button of document.querySelectorAll('[data-act]')) button.addEventListener('click', () => act(button.dataset.act));
  $('container-choice').addEventListener('change', loadInventory);
  for (const el of document.querySelectorAll('#drawer-player [data-close]')) {
    el.addEventListener('click', () => { $('drawer-player').hidden = true; });
  }

  $('btn-confirm-ok').addEventListener('click', () => settleConfirm(true));
  $('btn-confirm-cancel').addEventListener('click', () => settleConfirm(false));
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('modal-confirm').hidden) settleConfirm(false);
    else $('drawer-player').hidden = true;
  });

  $('form-message').addEventListener('submit', sendMessage);
  $('form-broadcast').addEventListener('submit', broadcast);
  for (const button of document.querySelectorAll('[data-world]')) button.addEventListener('click', () => worldAction(button));
  $('form-whitelist').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('input-whitelist');
    if (!input.value.trim()) return;
    editWhitelist(input.value.trim(), true);
    input.value = '';
  });
  $('whitelist-list').addEventListener('click', (e) => {
    const button = e.target.closest('[data-whitelist-remove]');
    if (button) editWhitelist(button.dataset.whitelistRemove, false);
  });
  $('bans-list').addEventListener('click', (e) => {
    const button = e.target.closest('[data-unban]');
    if (button) unbanFromList(button.dataset.unban);
  });
  $('btn-bans-refresh').addEventListener('click', loadBans);
  $('journal-search').addEventListener('input', renderJournal);
  $('journal-filter').addEventListener('change', renderJournal);

  $('form-console').addEventListener('submit', runConsole);
  $('input-console').addEventListener('keydown', browseHistory);

  state.durations = await api.durations();
  renderDurations();
  await loadSavedConnection();
  $('input-password').focus();
}

document.addEventListener('DOMContentLoaded', init);

// Un fichier glisse sur la fenetre ne doit jamais etre ouvert a la place de l'interface.
for (const type of ['dragover', 'drop']) document.addEventListener(type, (event) => event.preventDefault());
