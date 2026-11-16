/**
 * Phone link and automation API (runs in the desktop app's main process).
 *
 * A small web server on this PC, reachable only from the same local network and only with
 * the pairing code. It serves a phone page for approving videos and a few JSON endpoints
 * for automation tools such as n8n. It holds no data itself: every request is answered by
 * the unlocked app, so when the app is locked the link answers "locked".
 */
const http = require('http');
const crypto = require('crypto');
const os = require('os');

const DEFAULT_PORT = 53683;

/** Loopback, private IPv4 ranges and local IPv6: the PC itself or a device on the same network. */
function isPrivateAddress(ip) {
  const a = String(ip || '').replace(/^::ffff:/i, '').toLowerCase();
  if (a === '::1' || a.startsWith('127.')) return true;
  if (a.startsWith('10.') || a.startsWith('192.168.') || a.startsWith('169.254.')) return true;
  const m = /^172\.(\d+)\./.exec(a);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  return /^f[cd][0-9a-f]{2}:/.test(a) || a.startsWith('fe80:');
}

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const n of list || []) if (n.family === 'IPv4' && !n.internal && isPrivateAddress(n.address)) out.push(n.address);
  }
  return out;
}

const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();
const sameCode = (a, b) => crypto.timingSafeEqual(digest(a), digest(b));
const normalizeCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

const PHONE_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="referrer" content="no-referrer"><meta name="robots" content="noindex">
<title>Marketing Studio approvals</title>
<style>
:root{font-family:system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:#e8ebf4;background:#0b1020}
body{margin:0;padding:16px 14px 40px;max-width:560px;margin:auto}
h1{font-size:1.25rem;margin:4px 0 2px}p{color:#9aa3b8;margin:0 0 14px}
.card{background:#151b2e;border:1px solid #263049;border-radius:14px;padding:14px;margin-bottom:14px}
video{width:100%;max-height:62vh;border-radius:10px;background:#000}
button,input{font:inherit;border-radius:10px;border:1px solid #263049;padding:12px 14px;min-height:48px}
input{width:100%;box-sizing:border-box;background:#0b1020;color:#e8ebf4;letter-spacing:.06em;text-transform:uppercase}
button{background:#151b2e;color:#e8ebf4;font-weight:700;flex:1}
.ok{background:#059669;border-color:#059669;color:#fff}.no{color:#f87171}
.row{display:flex;gap:10px;margin-top:10px}.cap{white-space:pre-wrap;font-size:.9rem;color:#cbd5e1;margin-top:10px;max-height:9em;overflow:auto}
.note{padding:10px 12px;border-radius:10px;background:#172a52;color:#93c5fd;font-size:.9rem;margin-bottom:12px}.bad{background:#451a1a;color:#f87171}
small{color:#9aa3b8}
</style></head><body>
<h1>Marketing Studio</h1><p id="sub">Approve videos from your phone. Your PC does the posting.</p>
<div id="msg"></div><div id="app"></div>
<script>
(function(){
  var KEY='ms-link-code', app=document.getElementById('app'), msg=document.getElementById('msg'), timer=null;
  function code(){try{return localStorage.getItem(KEY)||''}catch(e){return window.__code||''}}
  function setCode(c){window.__code=c;try{c?localStorage.setItem(KEY,c):localStorage.removeItem(KEY)}catch(e){}}
  function say(t,bad){msg.innerHTML='';if(!t)return;var d=document.createElement('div');d.className='note'+(bad?' bad':'');d.textContent=t;msg.appendChild(d)}
  function api(path,method){return fetch('/api/'+path,{method:method||'GET',headers:{Authorization:'Bearer '+code()}}).then(function(r){return r.json().then(function(j){if(!r.ok){var e=new Error(j.error||'Request failed');e.status=r.status;throw e}return j})})}
  function el(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e}
  function login(note){
    clearInterval(timer);app.innerHTML='';
    var c=el('div','card');c.appendChild(el('p',null,'Enter the pairing code shown in Marketing Studio on your PC (Phone & automation page).'));
    var i=el('input');i.placeholder='XXXXX-XXXXX-XXXXX-XXXXX';i.autocapitalize='characters';i.autocomplete='off';c.appendChild(i);
    var r=el('div','row'),b=el('button','ok','Connect');r.appendChild(b);c.appendChild(r);app.appendChild(c);
    b.onclick=function(){setCode(i.value.trim());load()};if(note)say(note,true)
  }
  function decide(id,what,card){
    api('videos/'+id+'/'+what,'POST').then(function(){card.remove();say(what==='approve'?'Approved. Your PC is posting it now.':'Rejected.');setTimeout(load,1500)}).catch(function(e){say(e.message,true)})
  }
  function load(){
    if(!code())return login();
    api('approvals').then(function(d){
      say('');document.getElementById('sub').textContent=(d.business?d.business+' · ':'')+d.videos.length+' video(s) waiting';
      app.innerHTML='';
      if(!d.videos.length){var c=el('div','card');c.appendChild(el('b',null,'All caught up'));c.appendChild(el('p',null,'Nothing is waiting for you right now.'));app.appendChild(c)}
      d.videos.forEach(function(v){
        var c=el('div','card'),k=encodeURIComponent(code());
        c.appendChild(el('b',null,v.product));c.appendChild(el('div',null,'')).appendChild(el('small',null,v.shape+(v.seconds?' · '+v.seconds+'s':'')+(v.uploaded?' · your recording':'')));
        var vid=el('video');vid.controls=true;vid.playsInline=true;vid.preload='none';vid.poster='/api/videos/'+v.id+'/thumb?k='+k;vid.src='/api/videos/'+v.id+'/file?k='+k;c.appendChild(vid);
        c.appendChild(el('div','cap',v.caption));
        var r=el('div','row'),no=el('button','no','Reject'),ok=el('button','ok','Approve');
        no.onclick=function(){decide(v.id,'reject',c)};ok.onclick=function(){decide(v.id,'approve',c)};r.appendChild(no);r.appendChild(ok);c.appendChild(r);app.appendChild(c)
      });
      if(d.posts&&d.posts.length){var p=el('div','card');p.appendChild(el('b',null,'Recently posted'));d.posts.forEach(function(x){p.appendChild(el('div',null,x.product+' → '+x.platform+': '+x.status))});app.appendChild(p)}
      var out=el('button',null,'Disconnect this phone');out.style.width='100%';out.onclick=function(){setCode('');login()};app.appendChild(out);
      clearInterval(timer);timer=setInterval(function(){if([].every.call(document.querySelectorAll('video'),function(x){return x.paused}))load()},30000)
    }).catch(function(e){
      if(e.status===401){setCode('');login('That code is not correct.')}
      else if(e.status===429)login(e.message)
      else say(e.message||'Cannot reach your PC. Is Marketing Studio open and on the same Wi-Fi?',true)
    })
  }
  load()
})();
</script></body></html>`;

/**
 * @param opts.code    pairing code (checked on every /api request)
 * @param opts.handle  async ({method, path, body}) => {status, json} | {status, type, buffer}
 */
function createLinkServer(opts) {
  const fails = new Map(); // ip -> { n, until }
  const cache = { key: '', at: 0, type: '', buffer: null }; // last decrypted file, so phone seek requests are cheap
  const now = opts.now || Date.now;

  const send = (res, status, obj) => {
    const body = Buffer.from(JSON.stringify(obj));
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
    res.end(body);
  };

  const server = http.createServer(async (req, res) => {
    try {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');
      const ip = req.socket.remoteAddress || '';
      if (!(opts.isAllowed || isPrivateAddress)(ip)) return send(res, 403, { error: 'This link only works on the same local network as the PC.' });
      const url = new URL(req.url, 'http://link');
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY',
          'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self'; media-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'" });
        return res.end(PHONE_PAGE);
      }
      if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'Not found.' });

      const f = fails.get(ip);
      if (f && f.until > now()) return send(res, 429, { error: `Too many wrong codes. Try again in ${Math.ceil((f.until - now()) / 1000)} seconds.` });
      const given = normalizeCode((/^Bearer\s+(.+)$/i.exec(req.headers.authorization || '') || [])[1] || url.searchParams.get('k'));
      if (!given || !sameCode(given, normalizeCode(opts.code))) {
        const n = (f ? f.n : 0) + 1;
        fails.set(ip, { n, until: n >= 5 ? now() + Math.min(60_000 * 2 ** (n - 5), 15 * 60_000) : 0 });
        return send(res, 401, { error: 'Wrong or missing pairing code.' });
      }
      fails.delete(ip);

      let body = null;
      if (req.method === 'POST') {
        const chunks = [];
        let size = 0;
        for await (const c of req) { size += c.length; if (size > 64 * 1024) return send(res, 413, { error: 'Request too large.' }); chunks.push(c); }
        if (size) { try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send(res, 400, { error: 'The request body is not valid JSON.' }); } }
      } else if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed.' });

      const isFile = req.method === 'GET' && /\/file$/.test(url.pathname);
      let out;
      if (isFile && cache.key === url.pathname && now() - cache.at < 120_000) out = { status: 200, type: cache.type, buffer: cache.buffer };
      else out = await opts.handle({ method: req.method, path: url.pathname, body });
      if (!out) return send(res, 500, { error: 'No answer from the app.' });
      if (!out.buffer) return send(res, out.status || 200, out.json ?? {});

      const buf = Buffer.isBuffer(out.buffer) ? out.buffer : Buffer.from(out.buffer);
      if (isFile && out.status === 200) Object.assign(cache, { key: url.pathname, at: now(), type: out.type, buffer: buf });
      const headers = { 'Content-Type': out.type || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-store' };
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
      if (range && (range[1] || range[2])) {
        const start = range[1] ? Number(range[1]) : Math.max(0, buf.length - Number(range[2]));
        const end = range[1] && range[2] ? Math.min(Number(range[2]), buf.length - 1) : buf.length - 1;
        if (start >= buf.length || start > end) { res.writeHead(416, { 'Content-Range': `bytes */${buf.length}` }); return res.end(); }
        res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${buf.length}`, 'Content-Length': end - start + 1 });
        return res.end(buf.subarray(start, end + 1));
      }
      res.writeHead(out.status || 200, { ...headers, 'Content-Length': buf.length });
      res.end(buf);
    } catch (e) {
      try { send(res, 500, { error: 'The PC could not answer this request.' }); } catch { /* connection gone */ }
    }
  });
  server.requestTimeout = 60_000;
  return {
    listen: (port = DEFAULT_PORT, host = '0.0.0.0') => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => resolve(server.address().port)); }),
    close: () => new Promise((resolve) => { server.close(() => resolve()); if (server.closeAllConnections) server.closeAllConnections(); }),
  };
}

/** Sends one event to the owner's automation tool (for example an n8n Webhook node). Signed so the receiver can verify it. */
async function notify(url, signingKey, event, data, doFetch = fetch) {
  let u;
  try { u = new URL(String(url)); } catch { return { ok: false, error: 'The webhook address is not a valid web address.' }; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, error: 'The webhook address must start with http:// or https://.' };
  const body = JSON.stringify({ event, at: new Date().toISOString(), data });
  const signature = 'sha256=' + crypto.createHmac('sha256', String(signingKey)).update(body).digest('hex');
  try {
    const res = await doFetch(u.toString(), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Marketing-Studio-Event': event, 'X-Marketing-Studio-Signature': signature }, body, redirect: 'error', signal: AbortSignal.timeout(10_000) });
    return res.ok ? { ok: true } : { ok: false, error: `The automation tool answered with an error (${res.status}).` };
  } catch {
    return { ok: false, error: 'Could not reach the automation tool at that address.' };
  }
}

module.exports = { createLinkServer, notify, isPrivateAddress, lanAddresses, normalizeCode, DEFAULT_PORT, PHONE_PAGE };
