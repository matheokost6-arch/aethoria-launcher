'use strict';

const crypto = require('crypto');
const { BrowserWindow } = require('electron');
const config = require('../../shared/config');

const AUTHORITY = 'https://login.microsoftonline.com/consumers/oauth2/v2.0';
const REDIRECT_URI = 'https://login.microsoftonline.com/common/oauth2/nativeclient';
const SCOPE = 'XboxLive.signin offline_access';

/**
 * Chaine d'authentification Microsoft -> Minecraft :
 *
 *   1. OAuth2 (code + PKCE) chez Microsoft      -> jeton MSA
 *   2. Xbox Live user authenticate               -> jeton XBL + user hash
 *   3. XSTS authorize (relying party Minecraft)  -> jeton XSTS
 *   4. login_with_xbox                           -> jeton Minecraft
 *   5. /minecraft/profile                        -> UUID, pseudo, skin
 *
 * PKCE est obligatoire : le launcher est un client public, il ne peut pas
 * garder un secret, donc le code d'autorisation est lie a un verifier genere
 * a chaque connexion.
 */

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function createPkce() {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

async function postForm(url, form) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error_description || data.error || `Microsoft a repondu HTTP ${res.status}`);
  }
  return data;
}

async function postJson(url, body, token) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

/** Ouvre la fenetre de connexion Microsoft et recupere le code d'autorisation. */
function requestAuthCode(parentWindow) {
  const { verifier, challenge } = createPkce();
  const state = base64url(crypto.randomBytes(16));

  const authUrl = `${AUTHORITY}/authorize?${new URLSearchParams({
    client_id: config.msalClientId,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
    response_mode: 'query',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    prompt: 'select_account',
  })}`;

  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({
      width: 520,
      height: 720,
      parent: parentWindow || undefined,
      modal: Boolean(parentWindow),
      autoHideMenuBar: true,
      title: 'Connexion Microsoft',
      backgroundColor: '#0f1117',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        // Session isolee : aucun cookie ne survit d'une connexion a l'autre,
        // sinon le "changer de compte" reconnecterait toujours le meme joueur.
        partition: `auth-${Date.now()}`,
      },
    });

    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      // destroy() plutot que close() : close() declencherait l'evenement
      // 'closed' et donc un rejet parasite apres un succes.
      if (!win.isDestroyed()) win.destroy();
      fn(value);
    };

    const inspect = (rawUrl) => {
      if (!rawUrl || !rawUrl.startsWith(REDIRECT_URI)) return;
      const params = new URL(rawUrl).searchParams;
      const error = params.get('error');
      if (error) {
        const desc = params.get('error_description') || '';
        if (error === 'access_denied') {
          finish(reject, new Error('Connexion annulee : acces refuse dans la fenetre Microsoft.'));
        } else {
          finish(reject, new Error(`${error} : ${desc}`));
        }
        return;
      }
      const code = params.get('code');
      if (!code) return;
      if (params.get('state') !== state) {
        finish(reject, new Error('Reponse Microsoft invalide (parametre state incoherent).'));
        return;
      }
      finish(resolve, { code, verifier });
    };

    win.webContents.on('will-redirect', (_e, url) => inspect(url));
    win.webContents.on('will-navigate', (_e, url) => inspect(url));
    win.webContents.on('did-fail-load', (_e, code, desc, url) => {
      // -3 = ERR_ABORTED : provoque par nos propres interruptions de navigation.
      if (code === -3 || (url && url.startsWith(REDIRECT_URI))) return;
      finish(reject, new Error(`Page de connexion inaccessible (${desc}). Verifie ta connexion Internet.`));
    });
    win.on('closed', () => {
      if (!settled) {
        settled = true;
        reject(new Error('Fenetre de connexion fermee avant la fin.'));
      }
    });

    win.loadURL(authUrl);
  });
}

async function exchangeCode(code, verifier) {
  return postForm(`${AUTHORITY}/token`, {
    client_id: config.msalClientId,
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
    scope: SCOPE,
  });
}

async function refreshMsaToken(refreshToken) {
  return postForm(`${AUTHORITY}/token`, {
    client_id: config.msalClientId,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope: SCOPE,
  });
}

async function authenticateXboxLive(msaAccessToken) {
  const { ok, data, status } = await postJson(config.endpoints.xblAuth, {
    Properties: {
      AuthMethod: 'RPS',
      SiteName: 'user.auth.xboxlive.com',
      RpsTicket: `d=${msaAccessToken}`,
    },
    RelyingParty: 'http://auth.xboxlive.com',
    TokenType: 'JWT',
  });
  if (!ok) throw new Error(`Authentification Xbox Live refusee (HTTP ${status}).`);
  return { token: data.Token, uhs: data.DisplayClaims.xui[0].uhs };
}

const XSTS_ERRORS = {
  2148916233: "Ce compte Microsoft n'a pas de profil Xbox. Connecte-toi une fois sur minecraft.net ou xbox.com pour en creer un, puis reessaie.",
  2148916235: 'Le Xbox Live n’est pas disponible dans le pays associe a ce compte Microsoft.',
  2148916236: 'Ce compte necessite une verification supplementaire (authentification adulte).',
  2148916237: 'Ce compte necessite une verification supplementaire (authentification adulte).',
  2148916238: 'Ce compte est un compte enfant : il doit etre rattache a une famille Microsoft pour utiliser le Xbox Live.',
};

async function authorizeXsts(xblToken) {
  const { ok, data, status } = await postJson(config.endpoints.xstsAuth, {
    Properties: { SandboxId: 'RETAIL', UserTokens: [xblToken] },
    RelyingParty: 'rp://api.minecraftservices.com/',
    TokenType: 'JWT',
  });
  if (!ok) {
    const known = XSTS_ERRORS[Number(data.XErr)];
    throw new Error(known || `Autorisation Xbox (XSTS) refusee (HTTP ${status}, XErr ${data.XErr || 'inconnu'}).`);
  }
  return { token: data.Token, uhs: data.DisplayClaims.xui[0].uhs };
}

async function loginMinecraft(uhs, xstsToken) {
  const { ok, data, status } = await postJson(config.endpoints.mcLogin, {
    identityToken: `XBL3.0 x=${uhs};${xstsToken}`,
  });
  if (!ok) throw new Error(`Connexion aux services Minecraft refusee (HTTP ${status}).`);
  return { accessToken: data.access_token, expiresIn: data.expires_in };
}

async function fetchProfile(mcAccessToken) {
  const res = await fetch(config.endpoints.mcProfile, {
    headers: { Authorization: `Bearer ${mcAccessToken}` },
  });
  if (res.status === 404) {
    throw new Error("Ce compte Microsoft ne possede pas Minecraft: Java Edition. Utilise la connexion hors-ligne si tu n'as pas achete le jeu.");
  }
  if (!res.ok) throw new Error(`Profil Minecraft illisible (HTTP ${res.status}).`);
  const data = await res.json();
  return {
    uuid: data.id,
    name: data.name,
    skins: data.skins || [],
    capes: data.capes || [],
  };
}

/** Formate un UUID sans tirets (format API Mojang) en UUID canonique. */
function dashUuid(id) {
  if (!id || id.includes('-')) return id;
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

/** Assemble les etapes 2 a 5 a partir d'un jeu de jetons MSA. */
async function completeMinecraftChain(msaTokens) {
  const xbl = await authenticateXboxLive(msaTokens.access_token);
  const xsts = await authorizeXsts(xbl.token);
  const mc = await loginMinecraft(xsts.uhs, xsts.token);
  const profile = await fetchProfile(mc.accessToken);

  return {
    id: `msa:${profile.uuid}`,
    type: 'microsoft',
    name: profile.name,
    uuid: dashUuid(profile.uuid),
    accessToken: mc.accessToken,
    refreshToken: msaTokens.refresh_token || null,
    expiresAt: Date.now() + (mc.expiresIn || 86400) * 1000,
    skinUrl: profile.skins.find((s) => s.state === 'ACTIVE')?.url || null,
    addedAt: Date.now(),
  };
}

function assertConfigured() {
  if (!config.msalClientId || config.msalClientId.startsWith('00000000')) {
    throw new Error(
      "Aucun Client ID Azure n'est configure dans le launcher. "
      + 'Renseigne msalClientId dans src/shared/config.js '
      + '(voir la section "Authentification Microsoft" du README).',
    );
  }
}

/** Connexion interactive complete (ouvre la fenetre Microsoft). */
async function login(parentWindow) {
  assertConfigured();
  const { code, verifier } = await requestAuthCode(parentWindow);
  const msaTokens = await exchangeCode(code, verifier);
  return completeMinecraftChain(msaTokens);
}

/** Renouvellement silencieux a partir du refresh token stocke. */
async function refresh(refreshToken) {
  assertConfigured();
  const msaTokens = await refreshMsaToken(refreshToken);
  return completeMinecraftChain(msaTokens);
}

module.exports = { login, refresh };
