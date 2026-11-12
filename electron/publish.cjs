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
};

const OAUTH_PORT = 53682;
/** The exact address the owner registers as "redirect URL" in each developer console. */
const REDIRECTS = {
  google: `http://127.0.0.1:${OAUTH_PORT}/oauth`,
  meta: `http://localhost:${OAUTH_PORT}/oauth`,
  linkedin: `http://localhost:${OAUTH_PORT}/oauth`,
  x: `http://127.0.0.1:${OAUTH_PORT}/oauth`,
};
const SCOPES = {
  google: 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly',
  meta: 'pages_show_list,pages_read_engagement,pages_manage_posts,instagram_basic,instagram_content_publish,business_management',
  linkedin: 'openid profile w_member_social',
  x: 'tweet.read tweet.write users.read media.write offline.access',
};

const ALLOWED_HOSTS = /(^|\.)(googleapis\.com|google\.com|facebook\.com|linkedin\.com|licdn\.com|x\.com|twitter\.com)$/i;
const productionHost = (url) => {
  const u = new URL(url);
  return u.protocol === 'https:' && ALLOWED_HOSTS.test(u.hostname);
};

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
  const p = { client_id: creds.clientId, redirect_uri: REDIRECTS[provider], response_type: 'code', state };
  if (provider === 'google') Object.assign(p, { scope: SCOPES.google, access_type: 'offline', prompt: 'consent', code_challenge: challenge, code_challenge_method: 'S256' });
  if (provider === 'meta') Object.assign(p, { scope: SCOPES.meta });
  if (provider === 'linkedin') Object.assign(p, { scope: SCOPES.linkedin + (creds.organizationId ? ' w_organization_social' : '') });
  if (provider === 'x') Object.assign(p, { scope: SCOPES.x, code_challenge: challenge, code_challenge_method: 'S256' });
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
    const t = (await call(e.token, { method: 'POST', body: form({ grant_type: 'authorization_code', code, redirect_uri: REDIRECTS.google, client_id: creds.clientId, client_secret: creds.clientSecret, code_verifier: verifier }) }, 'Google sign-in')).json;
    if (!t.refresh_token) throw new PublishError('Google did not grant long-term access. Remove the app under myaccount.google.com → Security → Third-party access and connect again.');
    const ch = (await call(`${e.api}/channels?part=snippet&mine=true`, { headers: bearer(t.access_token) }, 'Reading your YouTube channel')).json;
    const channel = ch.items?.[0];
    if (!channel) throw new PublishError('This Google account has no YouTube channel yet. Create the channel first.');
    return { accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: now + (t.expires_in ?? 3600) * 1000, name: channel.snippet?.title ?? 'YouTube channel', extra: { channelId: channel.id } };
  }
  if (provider === 'meta') {
    const short = (await call(`${e.graph}/oauth/access_token?${form({ client_id: creds.clientId, client_secret: creds.clientSecret, redirect_uri: REDIRECTS.meta, code })}`, {}, 'Facebook sign-in')).json;
    const long = (await call(`${e.graph}/oauth/access_token?${form({ grant_type: 'fb_exchange_token', client_id: creds.clientId, client_secret: creds.clientSecret, fb_exchange_token: short.access_token })}`, {}, 'Facebook long-term access')).json;
    const pages = (await call(`${e.graph}/me/accounts?${form({ fields: 'id,name,access_token,instagram_business_account{id,username}', limit: 100, access_token: long.access_token })}`, {}, 'Reading your Facebook Pages')).json;
    const list = (pages.data ?? []).map((p) => ({ pageId: p.id, pageName: p.name, pageToken: p.access_token, igUserId: p.instagram_business_account?.id ?? '', igName: p.instagram_business_account?.username ?? '' }));
    if (!list.length) throw new PublishError('No Facebook Page was shared. Sign in again and select the Page (and its Instagram account) you want to post to.');
    return { accessToken: long.access_token, refreshToken: '', expiresAt: 0, name: list[0].pageName, extra: { pages: list, ...list[0] } };
  }
  if (provider === 'linkedin') {
    const t = (await call(e.token, { method: 'POST', body: form({ grant_type: 'authorization_code', code, redirect_uri: REDIRECTS.linkedin, client_id: creds.clientId, client_secret: creds.clientSecret }) }, 'LinkedIn sign-in')).json;
    const me = (await call(`${e.api}/v2/userinfo`, { headers: bearer(t.access_token) }, 'Reading your LinkedIn profile')).json;
    const author = creds.organizationId ? `urn:li:organization:${String(creds.organizationId).replace(/\D/g, '')}` : `urn:li:person:${me.sub}`;
    return { accessToken: t.access_token, refreshToken: t.refresh_token ?? '', expiresAt: now + (t.expires_in ?? 5184000) * 1000, name: creds.organizationId ? `Company page ${creds.organizationId}` : me.name ?? 'LinkedIn member', extra: { author } };
  }
  if (provider === 'x') {
    const headers = creds.clientSecret ? { Authorization: 'Basic ' + Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64') } : {};
    const t = (await call(e.token, { method: 'POST', headers, body: form({ grant_type: 'authorization_code', code, redirect_uri: REDIRECTS.x, code_verifier: verifier, client_id: creds.clientId }) }, 'X sign-in')).json;
    const me = (await call(`${e.api}/2/users/me`, { headers: bearer(t.access_token) }, 'Reading your X profile')).json;
    return { accessToken: t.access_token, refreshToken: t.refresh_token ?? '', expiresAt: now + (t.expires_in ?? 7200) * 1000, name: '@' + (me.data?.username ?? 'account'), extra: { userId: me.data?.id ?? '' } };
  }
  throw new PublishError('Unknown platform.');
}

/** Full sign-in: open the platform's own sign-in page in the owner's browser and wait for the result. */
async function connect(provider, creds, openBrowser, deps = {}) {
  if (!REDIRECTS[provider]) throw new PublishError('Unknown platform.');
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
    headers: { ...bearer(acc.accessToken), 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': 'video/mp4', 'X-Upload-Content-Length': String(job.video.length) },
    body: JSON.stringify(body),
  }, 'Starting the YouTube upload');
  const location = start.headers.get('location');
  if (!location) throw new PublishError('YouTube did not provide an upload address.');
  const done = await call(location, { method: 'PUT', headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(job.video.length) }, body: job.video, timeoutMs: 1_800_000 }, 'Uploading to YouTube');
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
  fd.set('source', new Blob([job.video], { type: 'video/mp4' }), 'video.mp4');
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
  const init = (await call(`${e.api}/2/media/upload/initialize`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ media_type: 'video/mp4', total_bytes: job.video.length, media_category: 'tweet_video' }) }, 'Preparing the X upload')).json;
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

const TARGETS = { youtube: ['google', youtube], instagram: ['meta', instagram], facebook: ['meta', facebook], linkedin: ['linkedin', linkedin], x: ['x', x] };

/**
 * Publishes one approved video to one platform.
 * Returns { ok, url, id, tokens? } or { ok: false, error, retryable }.
 */
async function publish(target, account, job, deps = {}) {
  try {
    const entry = TARGETS[target];
    if (!entry) throw new PublishError('Unknown platform.');
    if (!account?.accessToken) throw new PublishError('This account is not connected.');
    // The page hands the file over as an ArrayBuffer; tests pass a Buffer.
    const raw = job?.video;
    const video = Buffer.isBuffer(raw) ? raw : raw instanceof ArrayBuffer ? Buffer.from(raw) : ArrayBuffer.isView(raw) ? Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength) : null;
    if (!video || !video.length) throw new PublishError('The video file is empty.');
    const tokens = await refreshIfNeeded(entry[0], account, deps);
    const acc = tokens ? { ...account, ...tokens } : account;
    const out = await entry[1](acc, { title: String(job.title ?? ''), text: String(job.text ?? ''), tags: Array.isArray(job.tags) ? job.tags.map(String) : [], format: job.format, video }, deps);
    return { ok: true, ...out, tokens: tokens ?? undefined };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 500), retryable: e?.retryable === true };
  }
}

module.exports = { publish, connect, exchangeCode, authUrl, waitForCode, refreshIfNeeded, productionHost, ENDPOINTS, REDIRECTS, OAUTH_PORT };
