/**
 * A simulated YouTube / Meta / LinkedIn / X, used to exercise the publishing connectors
 * without real accounts. It mimics the documented request sequence of each platform
 * and records every request it receives.
 */
const http = require('http');

function startMockPlatforms() {
  const log = [];
  const state = { igPolls: 0, liPosts: 0, xPolls: 0 };
  let base = '';
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const u = new URL(req.url, base);
      const q = u.searchParams;
      const entry = { method: req.method, path: u.pathname, query: Object.fromEntries(q), headers: req.headers, size: body.length, text: body.length < 20000 ? body.toString() : '' };
      log.push(entry);
      const formBody = () => new URLSearchParams(entry.text);
      const json = (obj, status = 200, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };
      const p = u.pathname;

      // ---- sign-in pages: immediately "approve" and send the browser back to the app
      if (p.endsWith('/auth')) { res.writeHead(302, { Location: `${q.get('redirect_uri')}?code=CODE-${p.split('/')[1]}&state=${q.get('state')}` }); return res.end(); }

      // ---- Google / YouTube
      if (p === '/g/token') { const f = formBody(); return json(f.get('grant_type') === 'refresh_token' ? { access_token: 'g-access-2', expires_in: 3600 } : { access_token: 'g-access', refresh_token: 'g-refresh', expires_in: 3600 }); }
      if (p === '/g/api/channels') return json({ items: [{ id: 'UC1', snippet: { title: 'Glow Naturals Channel' } }] });
      if (p === '/g/upload' && req.method === 'POST') return json({}, 200, { Location: `${base}/g/session/abc` });
      if (p === '/g/session/abc' && req.method === 'PUT') return json({ id: 'yt123' });

      // ---- Meta (Facebook + Instagram)
      if (p === '/m/graph/oauth/access_token') return json({ access_token: q.get('grant_type') === 'fb_exchange_token' ? 'm-long' : 'm-short' });
      if (p === '/m/graph/me/accounts') return json({ data: [{ id: 'PG1', name: 'Glow Naturals Page', access_token: 'page-token', instagram_business_account: { id: 'IG1', username: 'glownaturals' } }, { id: 'PG2', name: 'Second Page', access_token: 'page-token-2' }] });
      if (p === '/m/graph/IG1/media') return json({ id: 'c1', uri: `${base}/m/rupload/ig/c1` });
      if (p === '/m/rupload/ig/c1' || p === '/m/rupload/fb/v1') return json({ success: true });
      if (p === '/m/graph/c1') return json({ status_code: ++state.igPolls < 2 ? 'IN_PROGRESS' : 'FINISHED' });
      if (p === '/m/graph/IG1/media_publish') return json({ id: 'igm1' });
      if (p === '/m/graph/igm1') return json({ permalink: 'https://www.instagram.com/reel/ABC/' });
      if (p === '/m/graph/PG1/video_reels') { const f = formBody(); return json(f.get('upload_phase') === 'start' ? { video_id: 'v1', upload_url: `${base}/m/rupload/fb/v1` } : { success: true }); }
      if (p === '/m/gv/PG1/videos') return json({ id: 'fbv9' });

      // ---- LinkedIn
      if (p === '/l/token') return json({ access_token: 'l-access', expires_in: 5184000 });
      if (p === '/l/api/v2/userinfo') return json({ sub: 'abc123', name: 'Asha Owner' });
      if (p === '/l/api/rest/videos' && q.get('action') === 'initializeUpload') {
        const size = JSON.parse(entry.text).initializeUploadRequest.fileSizeBytes;
        const half = Math.floor(size / 2);
        return json({ value: { video: 'urn:li:video:V1', uploadToken: 'tok', uploadInstructions: [{ uploadUrl: `${base}/l/up/0`, firstByte: 0, lastByte: half - 1 }, { uploadUrl: `${base}/l/up/1`, firstByte: half, lastByte: size - 1 }] } });
      }
      if (p.startsWith('/l/up/')) { res.writeHead(200, { ETag: `"etag-${p.slice(-1)}"` }); return res.end(); }
      if (p === '/l/api/rest/videos' && q.get('action') === 'finalizeUpload') return json({});
      if (p === '/l/api/rest/posts') return ++state.liPosts < 2 ? json({ message: 'Video is not ready' }, 422) : json({}, 201, { 'x-restli-id': 'urn:li:share:777' });

      // ---- X
      if (p === '/x/token') { const f = formBody(); return json(f.get('grant_type') === 'refresh_token' ? { access_token: 'x-access-2', refresh_token: 'x-refresh-2', expires_in: 7200 } : { access_token: 'x-access', refresh_token: 'x-refresh', expires_in: 7200 }); }
      if (p === '/x/api/2/users/me') return json({ data: { id: '42', username: 'glownaturals' } });
      if (p === '/x/api/2/media/upload/initialize') return json({ data: { id: 'M1' } });
      if (p === '/x/api/2/media/upload/M1/append') return json({});
      if (p === '/x/api/2/media/upload/M1/finalize') return json({ data: { id: 'M1', processing_info: { state: 'pending', check_after_secs: 1 } } });
      if (p === '/x/api/2/media/upload') return json({ data: { processing_info: { state: ++state.xPolls < 2 ? 'in_progress' : 'succeeded', check_after_secs: 1 } } });
      if (p === '/x/api/2/tweets') return json({ data: { id: '999' } }, 201);

      // ---- deliberate failures
      if (p === '/fail/api/2/media/upload/initialize') return json({ detail: 'Your plan does not include this endpoint' }, 403);
      if (p === '/busy/upload') return json({ error: { message: 'Backend Error' } }, 503);
      json({ error: 'unexpected request ' + req.method + ' ' + p }, 404);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${server.address().port}`;
      const endpoints = {
        google: { auth: `${base}/g/auth`, token: `${base}/g/token`, upload: `${base}/g/upload`, api: `${base}/g/api` },
        meta: { auth: `${base}/m/auth`, graph: `${base}/m/graph`, graphVideo: `${base}/m/gv` },
        linkedin: { auth: `${base}/l/auth`, token: `${base}/l/token`, api: `${base}/l/api`, version: '202606' },
        x: { auth: `${base}/x/auth`, token: `${base}/x/token`, api: `${base}/x/api` },
      };
      resolve({ base, endpoints, log, state, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

module.exports = { startMockPlatforms };
