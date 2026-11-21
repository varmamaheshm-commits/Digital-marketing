/**
 * Social publishing connectors (runs in the desktop app's main process, never in the page).
 *
 * Each platform is reached only through its official API, with developer access the
 * owner registered in their own name. Tokens are handed in per call from the encrypted
 * vault and are never written to disk here. Outbound requests are limited to the
 * platforms' own hosts.
 *
 * Flows follow the public documentation as of late 2026:
 *   YouTube   – Data API v3 resumable upload
 *   Instagram – Graph API resumable Reels upload (container → rupload → publish)
 *   Facebook  – Page Reels API (start → rupload → finish) or Page /videos
 *   LinkedIn  – Videos API (initializeUpload → parts → finalizeUpload) + Posts API
 *   X         – API v2 chunked media upload (initialize → append → finalize) + create post
 */
const http = require('http');
const crypto = require('crypto');

const ENDPOINTS = {
  google: {
    auth: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    upload: 'https://www.googleapis.com/upload/youtube/v3/videos',
    api: 'https://www.googleapis.com/youtube/v3',
  },
  meta: {
    auth: 'https://www.facebook.com/v25.0/dialog/oauth',
    graph: 'https://graph.facebook.com/v25.0',
    graphVideo: 'https://graph-video.facebook.com/v25.0',
  },
  linkedin: {
    auth: 'https://www.linkedin.com/oauth/v2/authorization',
    token: 'https://www.linkedin.com/oauth/v2/accessToken',
    api: 'https://api.linkedin.com',
    version: '202606',
  },
  x: {
    auth: 'https://x.com/i/oauth2/authorize',
    token: 'https://api.x.com/2/oauth2/token',
    api: 'https://api.x.com',
  },
  pinterest: {
    auth: 'https://www.pinterest.com/oauth/',
    token: 'https://api.pinterest.com/v5/oauth/token',
    api: 'https://api.pinterest.com/v5',
  },
  tiktok: {
    auth: 'https://www.tiktok.com/v2/auth/authorize/',
    token: 'https://open.tiktokapis.com/v2/oauth/token/',
    api: 'https://open.tiktokapis.com/v2',
  },
  threads: {
    auth: 'https://threads.net/oauth/authorize',
    graph: 'https://graph.threads.net',
  },
  telegram: {
    api: 'https://api.telegram.org',
  },
};

const OAUTH_PORT = 53682;
/** The exact address the owner registers as "redirect URL" in each developer console. */
const REDIRECTS = {
  google: `http://127.0.0.1:${OAUTH_PORT}/oauth`,
  meta: `http://localhost:${OAUTH_PORT}/oauth`,
  linkedin: `http://localhost:${OAUTH_PORT}/oauth`,
  x: `http://127.0.0.1:${OAUTH_PORT}/oauth`,
  pinterest: `http://localhost:${OAUTH_PORT}/oauth`,
  // TikTok and Threads only accept https:// addresses: the owner's relay page (Setting "redirect address") forwards here.
  tiktok: `http://localhost:${OAUTH_PORT}/oauth`,
  threads: `http://localhost:${OAUTH_PORT}/oauth`,
  // Telegram has no browser sign-in: a bot token from @BotFather is entered instead.
  telegram: 'none',
};
const SCOPES = {
  google: 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly',
  meta: 'pages_show_list,pages_read_engagement,pages_manage_posts,instagram_basic,instagram_content_publish,business_management',
  linkedin: 'openid profile w_member_social',
  x: 'tweet.read tweet.write users.read media.write offline.access',
  pinterest: 'boards:read,pins:read,pins:write,user_accounts:read',
  tiktok: 'user.info.basic,video.publish',
  threads: 'threads_basic,threads_content_publish',
};

const ALLOWED_HOSTS = /(^|\.)(googleapis\.com|google\.com|facebook\.com|linkedin\.com|licdn\.com|x\.com|twitter\.com|pinterest\.com|tiktokapis\.com|threads\.net|api\.telegram\.org)$/i;

/** What each destination can receive. */
const SUPPORTS = {
  youtube: ['video'], instagram: ['video', 'image'], facebook: ['video', 'image', 'text'], linkedin: ['video', 'image', 'text'],
  x: ['video', 'image', 'text'], pinterest: ['image'], tiktok: ['video'], threads: ['text'], telegram: ['video', 'image', 'text'],
};
const productionHost = (url) => {
  const u = new URL(url);
  return u.protocol === 'https:' && ALLOWED_HOSTS.test(u.hostname);
};

/**
 * The address the platform sends the browser back to. Normally this computer itself; platforms that
 * demand https:// (Meta, once its app is Live) get the owner's relay page, which forwards here.
 */
function redirectFor(provider, creds) {
  const custom = String(creds?.redirectUri ?? '').trim();
  if (!custom) return REDIRECTS[provider];
  let u;
  try { u = new URL(custom); } catch { throw new PublishError('The redirect address is not a valid web address.'); }
  if (u.protocol !== 'https:' || u.search || u.hash) throw new PublishError('The redirect address must start with https:// and contain no "?" or "#".');
  return u.toString();
}

class PublishError extends Error {
  constructor(message, retryable = false) {
    super(message);
    this.retryable = retryable;
  }
}

/** Builds the request helper: host allow-list, timeouts, and readable errors without secrets. */
function client(deps = {}) {
  const doFetch = deps.fetch ?? fetch;
  const allow = deps.allowHost ?? productionHost;
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  async function call(url, init = {}, what = 'request') {
    if (!allow(url)) throw new PublishError(`Blocked a connection to an address that is not a known platform host (${new URL(url).hostname}).`);
    let res;
    try {
      res = await doFetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(init.timeoutMs ?? 300_000) });
    } catch (e) {
      throw new PublishError(`Could not reach the platform (${what}): ${e && e.name === 'TimeoutError' ? 'timed out' : 'network problem'}.`, true);
    }
    const raw = await res.text();
    let json = null;
    try { json = raw ? JSON.parse(raw) : null; } catch { /* not JSON */ }
    if (!res.ok) {
      const detail = json?.error?.message ?? json?.error_description ?? json?.message ?? json?.detail ?? json?.title ?? (typeof json?.error === 'string' ? json.error : '') ?? '';
      const retry = res.status >= 500 || res.status === 429;
      throw new PublishError(`${what} was refused (${res.status})${detail ? ': ' + String(detail).slice(0, 300) : ''}.`, retry);
    }
    return { json, headers: res.headers, status: res.status };
  }
  return { call, sleep };
}

const form = (obj) => new URLSearchParams(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== ''));
const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const clip = (s, n) => { s = String(s ?? ''); return s.length <= n ? s : s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…'; };

// ---------------------------------------------------------------- OAuth

function pkce() {
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function authUrl(provider, creds, state, challenge, endpoints = ENDPOINTS) {
  const e = endpoints[provider];
  const p = { client_id: creds.clientId, redirect_uri: redirectFor(provider, creds), response_type: 'code', state };
  if (provider === 'google') Object.assign(p, { scope: SCOPES.google, access_type: 'offline', prompt: 'consent', code_challenge: challenge, code_challenge_method: 'S256' });
  // Facebook Login for Business: a saved "configuration" in the Meta app lists the permissions, replacing the scope list.
  if (provider === 'meta') Object.assign(p, /^\d{5,25}$/.test(String(creds.configId ?? '')) ? { config_id: String(creds.configId) } : { scope: SCOPES.meta });
  if (provider === 'linkedin') Object.assign(p, { scope: SCOPES.linkedin + (creds.organizationId ? ' w_organization_social' : '') });
  if (provider === 'x') Object.assign(p, { scope: SCOPES.x, code_challenge: challenge, code_challenge_method: 'S256' });
  if (provider === 'pinterest') Object.assign(p, { scope: SCOPES.pinterest });
  if (provider === 'threads') Object.assign(p, { scope: SCOPES.threads });
  // TikTok names the app ID "client_key".
  if (provider === 'tiktok') { delete p.client_id; Object.assign(p, { client_key: creds.clientId, scope: SCOPES.tiktok }); }
  return `${e.auth}?${form(p)}`;
}

/** One-shot listener on this computer that receives the sign-in result from the browser. */
function waitForCode(state, timeoutMs = 300_000, port = OAUTH_PORT) {
  return new Promise((resolve, reject) => {
    const servers = [];
    const done = (err, code) => {
      clearTimeout(timer);
      // Drop lingering browser connections too, so a later sign-in can never be answered by this listener.
      servers.forEach((s) => { s.close(); s.closeAllConnections?.(); });
      err ? reject(err) : resolve(code);
    };
    const handler = (req, res) => {
      const u = new URL(req.url, `http://127.0.0.1:${port}`);
      if (u.pathname !== '/oauth') { res.statusCode = 404; return res.end(); }
      const ok = u.searchParams.get('state') === state && u.searchParams.get('code');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Connection', 'close');
      res.end(`<body style="font-family:sans-serif;padding:40px"><h2>${ok ? 'Connected. You can close this tab and return to Marketing Studio.' : 'Sign-in was not completed. Please return to Marketing Studio and try again.'}</h2></body>`);
      if (ok) done(null, u.searchParams.get('code'));
      else done(new PublishError(u.searchParams.get('error_description') || u.searchParams.get('error') || 'The sign-in was cancelled or did not match this request.'));
    };
    const timer = setTimeout(() => done(new PublishError('Sign-in was not completed within 5 minutes.')), timeoutMs);
    for (const host of ['127.0.0.1', '::1']) {
      const s = http.createServer(handler);
      s.on('error', () => { if (host === '127.0.0.1') done(new PublishError(`Port ${port} on this computer is in use. Close the other program and try again.`)); });
      s.listen(port, host);
      servers.push(s);
    }
  });
}

async function exchangeCode(provider, creds, code, verifier, deps = {}) {
  const e = (deps.endpoints ?? ENDPOINTS)[provider];
  const { call } = client(deps);
  const now = Date.now();
  if (provider === 'google') {
    const t = (await call(e.token, { method: 'POST', body: form({ grant_type: 'authorization_code', code, redirect_uri: redirectFor('google', creds), client_id: creds.clientId, client_secret: creds.clientSecret, code_verifier: verifier }) }, 'Google sign-in')).json;
    if (!t.refresh_token) throw new PublishError('Google did not grant long-term access. Remove the app under myaccount.google.com → Security → Third-party access and connect again.');
    const ch = (await call(`${e.api}/channels?part=snippet&mine=true`, { headers: bearer(t.access_token) }, 'Reading your YouTube channel')).json;
    const channel = ch.items?.[0];
    if (!channel) throw new PublishError('This Google account has no YouTube channel yet. Create the channel first.');
    return { accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: now + (t.expires_in ?? 3600) * 1000, name: channel.snippet?.title ?? 'YouTube channel', extra: { channelId: channel.id } };
  }
  if (provider === 'meta') {
    const short = (await call(`${e.graph}/oauth/access_token?${form({ client_id: creds.clientId, client_secret: creds.clientSecret, redirect_uri: redirectFor('meta', creds), code })}`, {}, 'Facebook sign-in')).json;
    const long = (await call(`${e.graph}/oauth/access_token?${form({ grant_type: 'fb_exchange_token', client_id: creds.clientId, client_secret: creds.clientSecret, fb_exchange_token: short.access_token })}`, {}, 'Facebook long-term access')).json;
    const pages = (await call(`${e.graph}/me/accounts?${form({ fields: 'id,name,access_token,instagram_business_account{id,username}', limit: 100, access_token: long.access_token })}`, {}, 'Reading your Facebook Pages')).json;
    const list = (pages.data ?? []).map((p) => ({ pageId: p.id, pageName: p.name, pageToken: p.access_token, igUserId: p.instagram_business_account?.id ?? '', igName: p.instagram_business_account?.username ?? '' }));
    if (!list.length) throw new PublishError('No Facebook Page was shared. Sign in again and select the Page (and its Instagram account) you want to post to.');
    return { accessToken: long.access_token, refreshToken: '', expiresAt: 0, name: list[0].pageName, extra: { pages: list, ...list[0] } };
  }
  if (provider === 'linkedin') {
    const t = (await call(e.token, { method: 'POST', body: form({ grant_type: 'authorization_code', code, redirect_uri: redirectFor('linkedin', creds), client_id: creds.clientId, client_secret: creds.clientSecret }) }, 'LinkedIn sign-in')).json;
    const me = (await call(`${e.api}/v2/userinfo`, { headers: bearer(t.access_token) }, 'Reading your LinkedIn profile')).json;
    const author = creds.organizationId ? `urn:li:organization:${String(creds.organizationId).replace(/\D/g, '')}` : `urn:li:person:${me.sub}`;
    return { accessToken: t.access_token, refreshToken: t.refresh_token ?? '', expiresAt: now + (t.expires_in ?? 5184000) * 1000, name: creds.organizationId ? `Company page ${creds.organizationId}` : me.name ?? 'LinkedIn member', extra: { author } };
  }
  if (provider === 'x') {
    const headers = creds.clientSecret ? { Authorization: 'Basic ' + Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64') } : {};
    const t = (await call(e.token, { method: 'POST', headers, body: form({ grant_type: 'authorization_code', code, redirect_uri: redirectFor('x', creds), code_verifier: verifier, client_id: creds.clientId }) }, 'X sign-in')).json;
    const me = (await call(`${e.api}/2/users/me`, { headers: bearer(t.access_token) }, 'Reading your X profile')).json;
    return { accessToken: t.access_token, refreshToken: t.refresh_token ?? '', expiresAt: now + (t.expires_in ?? 7200) * 1000, name: '@' + (me.data?.username ?? 'account'), extra: { userId: me.data?.id ?? '' } };
  }
  if (provider === 'pinterest') {
    const t = (await call(e.token, { method: 'POST', headers: basic(creds), body: form({ grant_type: 'authorization_code', code, redirect_uri: redirectFor('pinterest', creds) }) }, 'Pinterest sign-in')).json;
    const me = (await call(`${e.api}/user_account`, { headers: bearer(t.access_token) }, 'Reading your Pinterest account')).json;
    const boards = ((await call(`${e.api}/boards?page_size=100`, { headers: bearer(t.access_token) }, 'Reading your Pinterest boards')).json?.items ?? []).map((b) => ({ boardId: b.id, boardName: b.name }));
    if (!boards.length) throw new PublishError('Your Pinterest account has no board yet. Create a board on Pinterest first, then connect again.');
    return { accessToken: t.access_token, refreshToken: t.refresh_token ?? '', expiresAt: now + (t.expires_in ?? 2592000) * 1000, name: me.username ?? 'Pinterest', extra: { boards, ...boards[0] } };
  }
  if (provider === 'tiktok') {
    const t = (await call(e.token, { method: 'POST', body: form({ client_key: creds.clientId, client_secret: creds.clientSecret, code, grant_type: 'authorization_code', redirect_uri: redirectFor('tiktok', creds) }) }, 'TikTok sign-in')).json;
    if (!t?.access_token) throw new PublishError(`TikTok sign-in failed${t?.error_description ? ': ' + t.error_description : '.'}`);
    let name = 'TikTok account';
    try { name = (await call(`${e.api}/user/info/?fields=display_name`, { headers: bearer(t.access_token) }, 'Reading your TikTok profile')).json?.data?.user?.display_name || name; } catch { /* name is optional */ }
    return { accessToken: t.access_token, refreshToken: t.refresh_token ?? '', expiresAt: now + (t.expires_in ?? 86400) * 1000, name, extra: { openId: t.open_id ?? '' } };
  }
  if (provider === 'threads') {
    const short = (await call(`${e.graph}/oauth/access_token`, { method: 'POST', body: form({ client_id: creds.clientId, client_secret: creds.clientSecret, grant_type: 'authorization_code', redirect_uri: redirectFor('threads', creds), code }) }, 'Threads sign-in')).json;
    const long = (await call(`${e.graph}/access_token?${form({ grant_type: 'th_exchange_token', client_secret: creds.clientSecret, access_token: short.access_token })}`, {}, 'Threads long-term access')).json;
    const me = (await call(`${e.graph}/v1.0/me?${form({ fields: 'id,username', access_token: long.access_token })}`, {}, 'Reading your Threads profile')).json;
    return { accessToken: long.access_token, refreshToken: '', expiresAt: now + (long.expires_in ?? 5184000) * 1000, name: '@' + (me.username ?? 'threads'), extra: { userId: me.id ?? short.user_id ?? '' } };
  }
  throw new PublishError('Unknown platform.');
}

const basic = (c) => ({ Authorization: 'Basic ' + Buffer.from(`${c.clientId}:${c.clientSecret}`).toString('base64') });

/** Telegram: no browser sign-in. The bot token from @BotFather, and the channel the bot is an admin of. */
async function connectTelegram(creds, deps = {}) {
  const e = (deps.endpoints ?? ENDPOINTS).telegram;
  const { call } = client(deps);
  const token = String(creds.clientSecret ?? '').trim();
  if (!/^\d{5,15}:[A-Za-z0-9_-]{30,60}$/.test(token)) throw new PublishError('That does not look like a bot token from @BotFather (it looks like 123456789:ABC…).');
  let chat = String(creds.organizationId ?? '').trim();
  if (/^t\.me\//i.test(chat) || /^https:\/\/t\.me\//i.test(chat)) chat = '@' + chat.replace(/^(https:\/\/)?t\.me\//i, '');
  if (!/^(@[A-Za-z0-9_]{4,64}|-?\d{5,20})$/.test(chat)) throw new PublishError('Enter the channel as @channelname (or its numeric ID).');
  const bot = (await call(`${e.api}/bot${token}/getMe`, {}, 'Checking the bot')).json?.result;
  const info = (await call(`${e.api}/bot${token}/getChat?${form({ chat_id: chat })}`, {}, 'Finding the channel (add the bot to the channel as an admin first)')).json?.result;
  return { accessToken: token, refreshToken: '', expiresAt: 0, name: info?.title ?? chat, extra: { chatId: String(info?.id ?? chat), username: info?.username ?? '', bot: bot?.username ?? '' } };
}

/** Full sign-in: open the platform's own sign-in page in the owner's browser and wait for the result. */
async function connect(provider, creds, openBrowser, deps = {}) {
  if (!REDIRECTS[provider]) throw new PublishError('Unknown platform.');
  if (provider === 'telegram') return connectTelegram(creds, deps);
  if (!creds?.clientId) throw new PublishError('Enter the app / client ID first.');
  const state = crypto.randomBytes(24).toString('base64url');
  const { verifier, challenge } = pkce();
  const waiting = waitForCode(state, deps.timeoutMs);
  waiting.catch(() => {});
  await openBrowser(authUrl(provider, creds, state, challenge, deps.endpoints ?? ENDPOINTS));
  const code = await waiting;
  return exchangeCode(provider, creds, code, verifier, deps);
}

/** Returns fresh tokens when the stored ones are about to expire, otherwise null. */
async function refreshIfNeeded(provider, account, deps = {}) {
  if (!account.expiresAt || account.expiresAt - Date.now() > 120_000) return null;
  const e = (deps.endpoints ?? ENDPOINTS)[provider];
  const { call } = client(deps);
  if (provider === 'google' || provider === 'x') {
    if (!account.refreshToken) throw new PublishError('Access has expired. Please connect this account again.');
    const headers = provider === 'x' && account.clientSecret ? { Authorization: 'Basic ' + Buffer.from(`${account.clientId}:${account.clientSecret}`).toString('base64') } : {};
    const t = (await call(e.token, { method: 'POST', headers, body: form({ grant_type: 'refresh_token', refresh_token: account.refreshToken, client_id: account.clientId, client_secret: provider === 'google' ? account.clientSecret : undefined }) }, 'Renewing access')).json;
    return { accessToken: t.access_token, refreshToken: t.refresh_token ?? account.refreshToken, expiresAt: Date.now() + (t.expires_in ?? 3600) * 1000 };
  }
  if (provider === 'linkedin') throw new PublishError('LinkedIn access lasts about 60 days and has expired. Please connect LinkedIn again.');
  if (provider === 'pinterest') {
    if (!account.refreshToken) throw new PublishError('Pinterest access has expired. Please connect Pinterest again.');
    const t = (await call(e.token, { method: 'POST', headers: basic(account), body: form({ grant_type: 'refresh_token', refresh_token: account.refreshToken }) }, 'Renewing Pinterest access')).json;
    return { accessToken: t.access_token, refreshToken: t.refresh_token ?? account.refreshToken, expiresAt: Date.now() + (t.expires_in ?? 2592000) * 1000 };
  }
  if (provider === 'tiktok') {
    if (!account.refreshToken) throw new PublishError('TikTok access has expired. Please connect TikTok again.');
    const t = (await call(e.token, { method: 'POST', body: form({ client_key: account.clientId, client_secret: account.clientSecret, grant_type: 'refresh_token', refresh_token: account.refreshToken }) }, 'Renewing TikTok access')).json;
    if (!t?.access_token) throw new PublishError('TikTok access has expired. Please connect TikTok again.');
    return { accessToken: t.access_token, refreshToken: t.refresh_token ?? account.refreshToken, expiresAt: Date.now() + (t.expires_in ?? 86400) * 1000 };
  }
  if (provider === 'threads') {
    if (account.expiresAt < Date.now()) throw new PublishError('Threads access has expired. Please connect Threads again.');
    const t = (await call(`${e.graph}/refresh_access_token?${form({ grant_type: 'th_refresh_token', access_token: account.accessToken })}`, {}, 'Renewing Threads access')).json;
    return { accessToken: t.access_token, expiresAt: Date.now() + (t.expires_in ?? 5184000) * 1000 };
  }
  return null;
}

// ---------------------------------------------------------------- publishing

async function youtube(acc, job, deps) {
  const e = (deps.endpoints ?? ENDPOINTS).google;
  const { call } = client(deps);
  const body = {
    snippet: { title: clip(job.title.replace(/[<>]/g, ''), 100), description: clip(job.text.replace(/[<>]/g, ''), 4900), tags: job.tags.slice(0, 15), categoryId: '22' },
    status: { privacyStatus: acc.extra?.privacy ?? 'public', selfDeclaredMadeForKids: false },
  };
  const start = await call(`${e.upload}?uploadType=resumable&part=snippet,status`, {
    method: 'POST',
    headers: { ...bearer(acc.accessToken), 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': job.mime, 'X-Upload-Content-Length': String(job.video.length) },
    body: JSON.stringify(body),
  }, 'Starting the YouTube upload');
  const location = start.headers.get('location');
  if (!location) throw new PublishError('YouTube did not provide an upload address.');
  const done = await call(location, { method: 'PUT', headers: { 'Content-Type': job.mime, 'Content-Length': String(job.video.length) }, body: job.video, timeoutMs: 1_800_000 }, 'Uploading to YouTube');
  const id = done.json?.id;
  if (!id) throw new PublishError('YouTube did not confirm the video.');
  return { id, url: `https://www.youtube.com/watch?v=${id}` };
}

async function metaUpload(url, token, video, call, what) {
  return call(url, { method: 'POST', headers: { Authorization: `OAuth ${token}`, offset: '0', file_size: String(video.length), 'Content-Type': 'application/octet-stream' }, body: video, timeoutMs: 1_800_000 }, what);
}

async function instagram(acc, job, deps) {
  const e = (deps.endpoints ?? ENDPOINTS).meta;
  const { call, sleep } = client(deps);
  const ig = acc.extra?.igUserId, token = acc.extra?.pageToken;
  if (!ig) throw new PublishError('The selected Facebook Page has no Instagram professional account linked to it.');
  const box = (await call(`${e.graph}/${ig}/media`, { method: 'POST', body: form({ media_type: 'REELS', upload_type: 'resumable', caption: clip(job.text, 2200), share_to_feed: 'true', access_token: token }) }, 'Preparing the Instagram reel')).json;
  if (!box?.id || !box.uri) throw new PublishError('Instagram did not provide an upload address.');
  await metaUpload(box.uri, token, job.video, call, 'Uploading to Instagram');
  for (let i = 0; ; i++) {
    const st = (await call(`${e.graph}/${box.id}?${form({ fields: 'status_code,status', access_token: token })}`, {}, 'Checking Instagram processing')).json;
    if (st.status_code === 'FINISHED') break;
    if (st.status_code === 'ERROR' || st.status_code === 'EXPIRED') throw new PublishError(`Instagram could not process the video: ${clip(st.status ?? st.status_code, 200)}`);
    if (i >= 60) throw new PublishError('Instagram is still processing the video after 5 minutes.', true);
    await sleep(5000);
  }
  const pub = (await call(`${e.graph}/${ig}/media_publish`, { method: 'POST', body: form({ creation_id: box.id, access_token: token }) }, 'Publishing on Instagram')).json;
  let url = '';
  try { url = (await call(`${e.graph}/${pub.id}?${form({ fields: 'permalink', access_token: token })}`, {}, 'Reading the Instagram link')).json?.permalink ?? ''; } catch { /* link is optional */ }
  return { id: pub.id, url };
}

async function facebook(acc, job, deps) {
  const e = (deps.endpoints ?? ENDPOINTS).meta;
  const { call } = client(deps);
  const page = acc.extra?.pageId, token = acc.extra?.pageToken;
  if (!page) throw new PublishError('Choose the Facebook Page to post to.');
  if (job.format === 'reel') {
    const start = (await call(`${e.graph}/${page}/video_reels`, { method: 'POST', body: form({ upload_phase: 'start', access_token: token }) }, 'Preparing the Facebook reel')).json;
    if (!start?.video_id || !start.upload_url) throw new PublishError('Facebook did not provide an upload address.');
    await metaUpload(start.upload_url, token, job.video, call, 'Uploading to Facebook');
    await call(`${e.graph}/${page}/video_reels`, { method: 'POST', body: form({ upload_phase: 'finish', video_id: start.video_id, video_state: 'PUBLISHED', description: clip(job.text, 2000), access_token: token }) }, 'Publishing on Facebook');
    return { id: start.video_id, url: `https://www.facebook.com/reel/${start.video_id}` };
  }
  const fd = new FormData();
  fd.set('access_token', token);
  fd.set('title', clip(job.title, 250));
  fd.set('description', clip(job.text, 5000));
  fd.set('source', new Blob([job.video], { type: job.mime }), job.mime === 'video/quicktime' ? 'video.mov' : 'video.mp4');
  const res = (await call(`${e.graphVideo}/${page}/videos`, { method: 'POST', body: fd, timeoutMs: 1_800_000 }, 'Uploading to Facebook')).json;
  if (!res?.id) throw new PublishError('Facebook did not confirm the video.');
  return { id: res.id, url: `https://www.facebook.com/${page}/videos/${res.id}` };
}

async function linkedin(acc, job, deps) {
  const e = (deps.endpoints ?? ENDPOINTS).linkedin;
  const { call, sleep } = client(deps);
  const headers = { ...bearer(acc.accessToken), 'LinkedIn-Version': e.version, 'X-Restli-Protocol-Version': '2.0.0', 'Content-Type': 'application/json' };
  const owner = acc.extra?.author;
  const init = (await call(`${e.api}/rest/videos?action=initializeUpload`, { method: 'POST', headers, body: JSON.stringify({ initializeUploadRequest: { owner, fileSizeBytes: job.video.length, uploadCaptions: false, uploadThumbnail: false } }) }, 'Preparing the LinkedIn upload')).json?.value;
  if (!init?.video || !init.uploadInstructions?.length) throw new PublishError('LinkedIn did not provide an upload address.');
  const parts = [];
  for (const part of init.uploadInstructions) {
    const res = await call(part.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: job.video.subarray(part.firstByte, part.lastByte + 1), timeoutMs: 1_800_000 }, 'Uploading to LinkedIn');
    const etag = res.headers.get('etag');
    if (!etag) throw new PublishError('LinkedIn did not confirm part of the upload.');
    parts.push(etag.replace(/"/g, ''));
  }
  await call(`${e.api}/rest/videos?action=finalizeUpload`, { method: 'POST', headers, body: JSON.stringify({ finalizeUploadRequest: { video: init.video, uploadToken: init.uploadToken ?? '', uploadedPartIds: parts } }) }, 'Finishing the LinkedIn upload');
  const post = {
    author: owner, commentary: clip(job.text, 2900), visibility: 'PUBLIC',
    distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
    content: { media: { title: clip(job.title, 100), id: init.video } },
    lifecycleState: 'PUBLISHED', isReshareDisabledByAuthor: false,
  };
  // The video needs a short time to process before a post may reference it.
  for (let i = 0; ; i++) {
    try {
      const res = await call(`${e.api}/rest/posts`, { method: 'POST', headers, body: JSON.stringify(post) }, 'Publishing on LinkedIn');
      const urn = res.headers.get('x-restli-id') ?? res.json?.id ?? '';
      return { id: urn, url: urn ? `https://www.linkedin.com/feed/update/${urn}` : '' };
    } catch (err) {
      const notReady = /\((400|404|409|422)\)/.test(err.message);
      if (!notReady || i >= 8) throw err;
      await sleep(8000);
    }
  }
}

async function x(acc, job, deps) {
  const e = (deps.endpoints ?? ENDPOINTS).x;
  const { call, sleep } = client(deps);
  const auth = bearer(acc.accessToken);
  const init = (await call(`${e.api}/2/media/upload/initialize`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ media_type: job.mime, total_bytes: job.video.length, media_category: 'tweet_video' }) }, 'Preparing the X upload')).json;
  const id = init?.data?.id;
  if (!id) throw new PublishError('X did not start the upload.');
  const CHUNK = 4 * 1024 * 1024;
  for (let i = 0, seg = 0; i < job.video.length; i += CHUNK, seg++) {
    const fd = new FormData();
    fd.set('segment_index', String(seg));
    fd.set('media', new Blob([job.video.subarray(i, i + CHUNK)], { type: 'application/octet-stream' }), 'chunk');
    await call(`${e.api}/2/media/upload/${id}/append`, { method: 'POST', headers: auth, body: fd }, 'Uploading to X');
  }
  let info = (await call(`${e.api}/2/media/upload/${id}/finalize`, { method: 'POST', headers: auth }, 'Finishing the X upload')).json?.data?.processing_info;
  for (let i = 0; info && info.state !== 'succeeded'; i++) {
    if (info.state === 'failed') throw new PublishError(`X could not process the video: ${clip(info.error?.message ?? 'unknown reason', 200)}`);
    if (i >= 60) throw new PublishError('X is still processing the video after several minutes.', true);
    await sleep(Math.min(10, Math.max(1, info.check_after_secs ?? 3)) * 1000);
    info = (await call(`${e.api}/2/media/upload?${form({ command: 'STATUS', media_id: id })}`, { headers: auth }, 'Checking X processing')).json?.data?.processing_info;
  }
  const post = (await call(`${e.api}/2/tweets`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: clip(job.text, 270), media: { media_ids: [id] } }) }, 'Publishing on X')).json;
  const pid = post?.data?.id;
  if (!pid) throw new PublishError('X did not confirm the post.');
  return { id: pid, url: `https://x.com/i/status/${pid}` };
}

// ---------------------------------------------------------------- images and text posts

async function facebookImage(acc, job, deps) {
  const e = (deps.endpoints ?? ENDPOINTS).meta;
  const { call } = client(deps);
  const page = acc.extra?.pageId, pageKey = acc.extra?.pageToken;
  if (!page) throw new PublishError('Choose the Facebook Page to post to.');
  const fd = new FormData();
  fd.set('access_token', pageKey);
  fd.set('message', clip(job.text, 5000));
  fd.set('source', new Blob([job.media], { type: job.mime }), 'image.png');
  const res = (await call(`${e.graph}/${page}/photos`, { method: 'POST', body: fd, timeoutMs: 600_000 }, 'Posting the image on Facebook')).json;
  if (!res?.id) throw new PublishError('Facebook did not confirm the image.');
  return { id: res.post_id ?? res.id, url: `https://www.facebook.com/${res.post_id ?? res.id}` };
}
async function facebookText(acc, job, deps) {
  const e = (deps.endpoints ?? ENDPOINTS).meta;
  const { call } = client(deps);
  const page = acc.extra?.pageId, pageKey = acc.extra?.pageToken;
  if (!page) throw new PublishError('Choose the Facebook Page to post to.');
  const res = (await call(`${e.graph}/${page}/feed`, { method: 'POST', body: form({ message: clip(job.text, 5000), link: job.link, access_token: pageKey }) }, 'Posting on Facebook')).json;
  if (!res?.id) throw new PublishError('Facebook did not confirm the post.');
  return { id: res.id, url: `https://www.facebook.com/${res.id}` };
}

/** Instagram fetches images from a web address, so the image is first stored (unpublished) on the linked Facebook Page. */
async function instagramImage(acc, job, deps) {
  const e = (deps.endpoints ?? ENDPOINTS).meta;
  const { call } = client(deps);
  const ig = acc.extra?.igUserId, pageKey = acc.extra?.pageToken, page = acc.extra?.pageId;
  if (!ig || !page) throw new PublishError('The selected Facebook Page has no Instagram professional account linked to it.');
  const fd = new FormData();
  fd.set('access_token', pageKey);
  fd.set('published', 'false');
  fd.set('source', new Blob([job.media], { type: job.mime }), 'image.png');
  const photo = (await call(`${e.graph}/${page}/photos`, { method: 'POST', body: fd, timeoutMs: 600_000 }, 'Preparing the image for Instagram')).json;
  const src = (await call(`${e.graph}/${photo?.id}?${form({ fields: 'images', access_token: pageKey })}`, {}, 'Reading the image address')).json?.images?.[0]?.source;
  if (!src) throw new PublishError('Facebook did not return an address Instagram can read the image from.');
  const box = (await call(`${e.graph}/${ig}/media`, { method: 'POST', body: form({ image_url: src, caption: clip(job.text, 2200), access_token: pageKey }) }, 'Preparing the Instagram post')).json;
  if (!box?.id) throw new PublishError('Instagram did not accept the image.');
  const pub = (await call(`${e.graph}/${ig}/media_publish`, { method: 'POST', body: form({ creation_id: box.id, access_token: pageKey }) }, 'Publishing on Instagram')).json;
  let url = '';
  try { url = (await call(`${e.graph}/${pub.id}?${form({ fields: 'permalink', access_token: pageKey })}`, {}, 'Reading the Instagram link')).json?.permalink ?? ''; } catch { /* optional */ }
  return { id: pub.id, url };
}

const liHeaders = (acc, e) => ({ ...bearer(acc.accessToken), 'LinkedIn-Version': e.version, 'X-Restli-Protocol-Version': '2.0.0', 'Content-Type': 'application/json' });
async function linkedinPost(acc, job, deps, content) {
  const e = (deps.endpoints ?? ENDPOINTS).linkedin;
  const { call } = client(deps);
  const post = {
    author: acc.extra?.author, commentary: clip(job.text, 2900), visibility: 'PUBLIC',
    distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
    ...(content ? { content } : {}), lifecycleState: 'PUBLISHED', isReshareDisabledByAuthor: false,
  };
  const res = await call(`${e.api}/rest/posts`, { method: 'POST', headers: liHeaders(acc, e), body: JSON.stringify(post) }, 'Publishing on LinkedIn');
  const urn = res.headers.get('x-restli-id') ?? res.json?.id ?? '';
  return { id: urn, url: urn ? `https://www.linkedin.com/feed/update/${urn}` : '' };
}
async function linkedinImage(acc, job, deps) {
  const e = (deps.endpoints ?? ENDPOINTS).linkedin;
  const { call } = client(deps);
  const init = (await call(`${e.api}/rest/images?action=initializeUpload`, { method: 'POST', headers: liHeaders(acc, e), body: JSON.stringify({ initializeUploadRequest: { owner: acc.extra?.author } }) }, 'Preparing the LinkedIn image')).json?.value;
  if (!init?.uploadUrl || !init.image) throw new PublishError('LinkedIn did not provide an upload address.');
  await call(init.uploadUrl, { method: 'PUT', headers: { ...bearer(acc.accessToken), 'Content-Type': 'application/octet-stream' }, body: job.media, timeoutMs: 600_000 }, 'Uploading the image to LinkedIn');
  return linkedinPost(acc, job, deps, { media: { title: clip(job.title, 100), id: init.image } });
}

async function xMedia(acc, job, deps, category) {
  const e = (deps.endpoints ?? ENDPOINTS).x;
  const { call, sleep } = client(deps);
  const auth = bearer(acc.accessToken);
  const init = (await call(`${e.api}/2/media/upload/initialize`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ media_type: job.mime, total_bytes: job.media.length, media_category: category }) }, 'Preparing the X upload')).json;
  const id = init?.data?.id;
  if (!id) throw new PublishError('X did not start the upload.');
  const CHUNK = 4 * 1024 * 1024;
  for (let i = 0, seg = 0; i < job.media.length; i += CHUNK, seg++) {
    const fd = new FormData();
    fd.set('segment_index', String(seg));
    fd.set('media', new Blob([job.media.subarray(i, i + CHUNK)], { type: 'application/octet-stream' }), 'chunk');
    await call(`${e.api}/2/media/upload/${id}/append`, { method: 'POST', headers: auth, body: fd }, 'Uploading to X');
  }
  let info = (await call(`${e.api}/2/media/upload/${id}/finalize`, { method: 'POST', headers: auth }, 'Finishing the X upload')).json?.data?.processing_info;
  for (let i = 0; info && info.state !== 'succeeded'; i++) {
    if (info.state === 'failed') throw new PublishError(`X could not process the file: ${clip(info.error?.message ?? 'unknown reason', 200)}`);
    if (i >= 60) throw new PublishError('X is still processing the file after several minutes.', true);
    await sleep(Math.min(10, Math.max(1, info.check_after_secs ?? 3)) * 1000);
    info = (await call(`${e.api}/2/media/upload?${form({ command: 'STATUS', media_id: id })}`, { headers: auth }, 'Checking X processing')).json?.data?.processing_info;
  }
  return id;
}
async function xTweet(acc, job, deps, mediaId) {
  const e = (deps.endpoints ?? ENDPOINTS).x;
  const { call } = client(deps);
  const body = { text: clip(job.text, 270), ...(mediaId ? { media: { media_ids: [mediaId] } } : {}) };
  const post = (await call(`${e.api}/2/tweets`, { method: 'POST', headers: { ...bearer(acc.accessToken), 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, 'Publishing on X')).json;
  const pid = post?.data?.id;
  if (!pid) throw new PublishError('X did not confirm the post.');
  return { id: pid, url: `https://x.com/i/status/${pid}` };
}

async function pinterestImage(acc, job, deps) {
  const e = (deps.endpoints ?? ENDPOINTS).pinterest;
  const { call } = client(deps);
  const board = acc.extra?.boardId;
  if (!board) throw new PublishError('Choose the Pinterest board to pin to.');
  const body = {
    board_id: board, title: clip(job.title, 100), description: clip(job.text, 500), alt_text: clip(job.title, 500),
    ...(job.link ? { link: job.link } : {}),
    media_source: { source_type: 'image_base64', content_type: job.mime, data: job.media.toString('base64') },
  };
  const pin = (await call(`${e.api}/pins`, { method: 'POST', headers: { ...bearer(acc.accessToken), 'Content-Type': 'application/json' }, body: JSON.stringify(body), timeoutMs: 600_000 }, 'Creating the Pinterest pin')).json;
  if (!pin?.id) throw new PublishError('Pinterest did not confirm the pin.');
  return { id: pin.id, url: `https://www.pinterest.com/pin/${pin.id}/` };
}

/** TikTok answers 200 with an error object, so every answer is checked. */
function tiktokOk(json, what) {
  const code = json?.error?.code;
  if (code && code !== 'ok') throw new PublishError(`${what} was refused: ${clip(json.error.message || code, 300)}`, code === 'rate_limit_exceeded' || code === 'internal_error');
  return json?.data ?? {};
}
async function tiktokVideo(acc, job, deps) {
  const e = (deps.endpoints ?? ENDPOINTS).tiktok;
  const { call, sleep } = client(deps);
  const headers = { ...bearer(acc.accessToken), 'Content-Type': 'application/json; charset=UTF-8' };
  const creator = tiktokOk((await call(`${e.api}/post/publish/creator_info/query/`, { method: 'POST', headers }, 'Reading your TikTok posting options')).json, 'TikTok');
  const options = creator.privacy_level_options ?? [];
  // Apps not yet audited by TikTok may only post privately; the owner then makes the post public inside TikTok.
  const privacy = options.includes('PUBLIC_TO_EVERYONE') ? 'PUBLIC_TO_EVERYONE' : options[0] ?? 'SELF_ONLY';
  const size = job.media.length;
  const MB = 1024 * 1024;
  const chunk = size <= 64 * MB ? size : 10 * MB;
  const count = Math.max(1, Math.floor(size / chunk));
  const init = tiktokOk((await call(`${e.api}/post/publish/video/init/`, { method: 'POST', headers, body: JSON.stringify({
    post_info: { title: clip(job.text, 2200), privacy_level: privacy, disable_duet: false, disable_comment: false, disable_stitch: false },
    source_info: { source: 'FILE_UPLOAD', video_size: size, chunk_size: chunk, total_chunk_count: count },
  }) }, 'Preparing the TikTok upload')).json, 'TikTok');
  if (!init.upload_url || !init.publish_id) throw new PublishError('TikTok did not provide an upload address.');
  for (let i = 0; i < count; i++) {
    const start = i * chunk, end = i === count - 1 ? size : start + chunk;
    await call(init.upload_url, { method: 'PUT', headers: { 'Content-Type': job.mime, 'Content-Range': `bytes ${start}-${end - 1}/${size}` }, body: job.media.subarray(start, end), timeoutMs: 1_800_000 }, 'Uploading to TikTok');
  }
  for (let i = 0; ; i++) {
    const st = tiktokOk((await call(`${e.api}/post/publish/status/fetch/`, { method: 'POST', headers, body: JSON.stringify({ publish_id: init.publish_id }) }, 'Checking TikTok processing')).json, 'TikTok');
    if (st.status === 'PUBLISH_COMPLETE' || st.status === 'SEND_TO_USER_INBOX') break;
    if (st.status === 'FAILED') throw new PublishError(`TikTok could not publish the video: ${st.fail_reason ?? 'unknown reason'}.`);
    if (i >= 60) throw new PublishError('TikTok is still processing the video after 5 minutes.', true);
    await sleep(5000);
  }
  return { id: init.publish_id, url: '', note: privacy === 'SELF_ONLY' ? 'Posted as private, because TikTok has not audited your app yet. Open TikTok to make it public.' : '' };
}

async function threadsText(acc, job, deps) {
  const e = (deps.endpoints ?? ENDPOINTS).threads;
  const { call } = client(deps);
  const user = acc.extra?.userId || 'me';
  const box = (await call(`${e.graph}/v1.0/${user}/threads`, { method: 'POST', body: form({ media_type: 'TEXT', text: clip(job.text, 490), access_token: acc.accessToken }) }, 'Preparing the Threads post')).json;
  if (!box?.id) throw new PublishError('Threads did not accept the post.');
  const pub = (await call(`${e.graph}/v1.0/${user}/threads_publish`, { method: 'POST', body: form({ creation_id: box.id, access_token: acc.accessToken }) }, 'Publishing on Threads')).json;
  let url = '';
  try { url = (await call(`${e.graph}/v1.0/${pub.id}?${form({ fields: 'permalink', access_token: acc.accessToken })}`, {}, 'Reading the Threads link')).json?.permalink ?? ''; } catch { /* optional */ }
  return { id: pub.id, url };
}

async function telegramSend(acc, job, deps) {
  const e = (deps.endpoints ?? ENDPOINTS).telegram;
  const { call } = client(deps);
  const bot = `${e.api}/bot${acc.accessToken}`;
  const chat = acc.extra?.chatId;
  if (!chat) throw new PublishError('Choose the Telegram channel to post to.');
  let res;
  if (job.kind === 'text') {
    res = (await call(`${bot}/sendMessage`, { method: 'POST', body: form({ chat_id: chat, text: clip(job.text, 4000) }) }, 'Posting on Telegram')).json;
  } else {
    const fd = new FormData();
    fd.set('chat_id', chat);
    fd.set('caption', clip(job.text, 1000));
    if (job.kind === 'image') fd.set('photo', new Blob([job.media], { type: job.mime }), 'image.png');
    else { fd.set('video', new Blob([job.media], { type: job.mime }), 'video.mp4'); fd.set('supports_streaming', 'true'); }
    res = (await call(`${bot}/${job.kind === 'image' ? 'sendPhoto' : 'sendVideo'}`, { method: 'POST', body: fd, timeoutMs: 1_800_000 }, 'Posting on Telegram')).json;
  }
  const id = res?.result?.message_id;
  if (!id) throw new PublishError('Telegram did not confirm the post.');
  return { id: String(id), url: acc.extra?.username ? `https://t.me/${acc.extra.username}/${id}` : '' };
}

/** destination -> [sign-in provider, { video, image, text }] */
const TARGETS = {
  youtube: ['google', { video: youtube }],
  instagram: ['meta', { video: instagram, image: instagramImage }],
  facebook: ['meta', { video: facebook, image: facebookImage, text: facebookText }],
  linkedin: ['linkedin', { video: linkedin, image: linkedinImage, text: (a, j, d) => linkedinPost(a, j, d) }],
  x: ['x', {
    video: async (a, j, d) => xTweet(a, j, d, await xMedia(a, j, d, 'tweet_video')),
    image: async (a, j, d) => xTweet(a, j, d, await xMedia(a, j, d, 'tweet_image')),
    text: (a, j, d) => xTweet(a, j, d),
  }],
  pinterest: ['pinterest', { image: pinterestImage }],
  tiktok: ['tiktok', { video: tiktokVideo }],
  threads: ['threads', { text: threadsText }],
  telegram: ['telegram', { video: telegramSend, image: telegramSend, text: telegramSend }],
};

const toBuffer = (raw) => (Buffer.isBuffer(raw) ? raw : raw instanceof ArrayBuffer ? Buffer.from(raw) : ArrayBuffer.isView(raw) ? Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength) : null);

/**
 * Publishes one approved video, image or text post to one platform.
 * Returns { ok, url, id, note?, tokens? } or { ok: false, error, retryable }.
 */
async function publish(target, account, job, deps = {}) {
  try {
    const entry = TARGETS[target];
    if (!entry) throw new PublishError('Unknown platform.');
    if (!account?.accessToken) throw new PublishError('This account is not connected.');
    const kind = job?.kind === 'image' || job?.kind === 'text' ? job.kind : 'video';
    const run = entry[1][kind];
    if (!run) throw new PublishError(`This platform does not accept ${kind === 'text' ? 'text-only posts' : kind + 's'}.`);
    // The page hands files over as an ArrayBuffer; tests pass a Buffer. Older callers send `video`.
    const media = kind === 'text' ? Buffer.alloc(0) : toBuffer(job.media ?? job.video);
    if (kind !== 'text' && (!media || !media.length)) throw new PublishError(`The ${kind} file is empty.`);
    if (kind === 'text' && !String(job.text ?? '').trim()) throw new PublishError('The post has no text.');
    const fresh = await refreshIfNeeded(entry[0], account, deps);
    const acc = fresh ? { ...account, ...fresh } : account;
    const mime = kind === 'image' ? (job.mime === 'image/jpeg' ? 'image/jpeg' : 'image/png') : job.mime === 'video/quicktime' ? 'video/quicktime' : 'video/mp4';
    const link = typeof job.link === 'string' && /^https:\/\/\S+$/i.test(job.link) ? job.link : undefined;
    const out = await run(acc, { kind, title: String(job.title ?? ''), text: String(job.text ?? ''), tags: Array.isArray(job.tags) ? job.tags.map(String) : [], format: job.format, mime, media, video: media, link }, deps);
    return { ok: true, ...out, tokens: fresh ?? undefined };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 500), retryable: e?.retryable === true };
  }
}

module.exports = { redirectFor, publish, connect, connectTelegram, exchangeCode, authUrl, waitForCode, refreshIfNeeded, productionHost, ENDPOINTS, REDIRECTS, OAUTH_PORT, SUPPORTS };
