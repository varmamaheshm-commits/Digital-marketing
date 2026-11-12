import { useState } from 'react';
import { desktopSocial, runPublisher } from '../core/publisher';
import { log, patch, put, remove, useStore } from '../core/store';
import { FORMAT_INFO, TARGET_INFO, type SocialAccount, type SocialProvider, type SocialTarget, type VideoFormat } from '../core/types';
import { Chip, Field, fmtDateTime, Icon, toast } from './common';

const PORT = 53682;
const PROVIDERS: { id: SocialProvider; name: string; targets: SocialTarget[]; redirect: string; idLabel: string; secretLabel: string; steps: string[]; warn: string }[] = [
  {
    id: 'google', name: 'YouTube (Google)', targets: ['youtube'], redirect: `http://127.0.0.1:${PORT}/oauth`, idLabel: 'Client ID', secretLabel: 'Client secret',
    steps: ['In Google Cloud Console create a project and enable “YouTube Data API v3”.', 'Set up the OAuth consent screen and add your own Google account as a test user (or publish the app).', 'Create credentials → OAuth client ID → type “Desktop app”. Paste the client ID and secret here.'],
    warn: 'Until Google has audited your project, videos uploaded through it are locked as private on YouTube. Request the audit from the API console.',
  },
  {
    id: 'meta', name: 'Instagram + Facebook (Meta)', targets: ['instagram', 'facebook'], redirect: `http://localhost:${PORT}/oauth`, idLabel: 'App ID', secretLabel: 'App secret',
    steps: ['At developers.facebook.com create a Business app and add “Facebook Login for Business”.', 'Add the redirect address below under Valid OAuth Redirect URIs.', 'Your Instagram account must be a professional account linked to your Facebook Page.', 'Request advanced access to pages_manage_posts and instagram_content_publish (App Review + business verification), then switch the app to Live.'],
    warn: 'While the Meta app is in development mode, posts it makes are visible only to people with a role on the app.',
  },
  {
    id: 'linkedin', name: 'LinkedIn', targets: ['linkedin'], redirect: `http://localhost:${PORT}/oauth`, idLabel: 'Client ID', secretLabel: 'Client secret',
    steps: ['At linkedin.com/developers create an app (it must be attached to a company page).', 'Add the products “Share on LinkedIn” and “Sign In with LinkedIn using OpenID Connect”.', 'Add the redirect address below on the Auth tab.', 'To post as your company page instead of yourself, also get “Community Management API” approved and enter the page’s organization ID.'],
    warn: 'LinkedIn access lasts about 60 days; the app will ask you to connect again when it expires.',
  },
  {
    id: 'x', name: 'X', targets: ['x'], redirect: `http://127.0.0.1:${PORT}/oauth`, idLabel: 'Client ID', secretLabel: 'Client secret (leave empty for a “Native app”)',
    steps: ['At developer.x.com create a project and app.', 'Under User authentication settings choose OAuth 2.0 with read and write permission, and add the redirect address below.', 'Paste the OAuth 2.0 client ID here.'],
    warn: 'X charges for posting through its API; check your plan allows posts with video.',
  },
];

function ProviderCard({ p, acc, canConnect }: { p: (typeof PROVIDERS)[number]; acc?: SocialAccount; canConnect: boolean }) {
  const [clientId, setClientId] = useState(acc?.clientId ?? '');
  const [clientSecret, setClientSecret] = useState(acc?.clientSecret ?? '');
  const [org, setOrg] = useState(acc?.organizationId ?? '');
  const [busy, setBusy] = useState(false);
  const [help, setHelp] = useState(false);
  const connected = !!acc?.accessToken;
  const expired = connected && p.id === 'linkedin' && acc!.expiresAt < Date.now();

  async function connect() {
    const bridge = desktopSocial();
    if (!bridge) return;
    setBusy(true);
    toast('Your browser will open — sign in and allow access');
    const res = await bridge.connect(p.id, { clientId: clientId.trim(), clientSecret: clientSecret.trim(), organizationId: org.trim() }).catch((e) => ({ ok: false, error: String(e?.message ?? e), account: undefined }));
    setBusy(false);
    if (!res.ok || !res.account) return toast(res.error ?? 'Could not connect');
    const now = Date.now();
    const targets: SocialAccount['targets'] = {};
    for (const t of p.targets) targets[t] = acc?.targets[t] ?? { auto: false, formats: TARGET_INFO[t].formats, since: now };
    await put('accounts', {
      id: p.id, clientId: clientId.trim(), clientSecret: clientSecret.trim(), organizationId: org.trim() || undefined,
      accessToken: '', refreshToken: '', expiresAt: 0, name: '', extra: {}, ...res.account, connectedAt: now, targets,
    } as SocialAccount);
    await log('security', `Connected ${p.name} (${res.account.name ?? ''}).`);
    toast(`Connected: ${res.account.name ?? p.name}`);
  }
  async function disconnect() {
    if (!confirm(`Disconnect ${p.name}? Automatic posting to it stops.`)) return;
    await remove('accounts', p.id);
    await log('security', `Disconnected ${p.name}.`);
  }
  const setTarget = (t: SocialTarget, change: Partial<{ auto: boolean; formats: VideoFormat[] }>) => {
    const cur = acc!.targets[t] ?? { auto: false, formats: TARGET_INFO[t].formats, since: Date.now() };
    // Switching auto-post on starts from now: videos approved earlier are not posted retroactively.
    const next = { ...cur, ...change, since: change.auto === true && !cur.auto ? Date.now() : cur.since };
    void patch('accounts', p.id, { targets: { ...acc!.targets, [t]: next } }).then(() => runPublisher());
  };

  return (
    <div className="card stack" data-testid={'provider-' + p.id}>
      <div className="row between"><h2 style={{ margin: 0 }}>{p.name}</h2><span className={'chip ' + (expired ? 'failed' : connected ? 'active' : '')}>{expired ? 'expired' : connected ? 'connected' : 'not connected'}</span></div>
      {connected && <small>Signed in as <b>{acc!.name}</b> · since {fmtDateTime(acc!.connectedAt)}</small>}

      {connected && p.id === 'meta' && (acc!.extra.pages?.length ?? 0) > 1 && (
        <Field label="Facebook Page to post to">
          <select value={acc!.extra.pageId} onChange={(e) => { const pg = acc!.extra.pages.find((x: any) => x.pageId === e.target.value); if (pg) void patch('accounts', 'meta', { name: pg.pageName, extra: { ...acc!.extra, ...pg } }); }}>
            {acc!.extra.pages.map((pg: any) => <option key={pg.pageId} value={pg.pageId}>{pg.pageName}{pg.igName ? ` (Instagram @${pg.igName})` : ' (no Instagram linked)'}</option>)}
          </select>
        </Field>
      )}
      {connected && p.id === 'google' && (
        <Field label="Publish YouTube videos as">
          <select value={acc!.extra.privacy ?? 'public'} onChange={(e) => patch('accounts', 'google', { extra: { ...acc!.extra, privacy: e.target.value } })}>
            <option value="public">Public</option><option value="unlisted">Unlisted</option><option value="private">Private</option>
          </select>
        </Field>
      )}

      {connected && p.targets.map((t) => {
        const cfg = acc!.targets[t] ?? { auto: false, formats: TARGET_INFO[t].formats, since: 0 };
        const unavailable = t === 'instagram' && !acc!.extra.igUserId;
        return (
          <div className="stack" key={t} style={{ borderTop: '1px solid var(--line)', paddingTop: 10 }}>
            <label className="check">
              <input data-testid={'auto-' + t} type="checkbox" disabled={unavailable} checked={cfg.auto && !unavailable} onChange={(e) => setTarget(t, { auto: e.target.checked })} />
              <b>Post approved videos to {TARGET_INFO[t].label} automatically</b>
            </label>
            {unavailable && <small className="muted">This Page has no Instagram professional account linked.</small>}
            {cfg.auto && !unavailable && (
              <div className="row">
                {(Object.keys(FORMAT_INFO) as VideoFormat[]).filter((f) => t !== 'instagram' || f !== 'wide').map((f) => (
                  <label className="check" key={f}><input type="checkbox" checked={cfg.formats.includes(f)} onChange={(e) => setTarget(t, { formats: e.target.checked ? [...cfg.formats, f] : cfg.formats.filter((x) => x !== f) })} /> {FORMAT_INFO[f].label}</label>
                ))}
              </div>
            )}
          </div>
        );
      })}

      {(!connected || expired) && (
        <>
          <button className="btn ghost small" style={{ alignSelf: 'flex-start' }} onClick={() => setHelp(!help)}>{help ? 'Hide' : 'Show'} one-time setup steps</button>
          {help && (
            <div className="notice">
              <ol style={{ margin: 0, paddingLeft: 18 }}>{p.steps.map((s) => <li key={s}>{s}</li>)}</ol>
              <div style={{ marginTop: 8 }}>Redirect address to register: <code style={{ userSelect: 'all' }}>{p.redirect}</code></div>
            </div>
          )}
          <div className="form">
            <Field label={p.idLabel}><input data-testid={'cid-' + p.id} value={clientId} onChange={(e) => setClientId(e.target.value)} autoComplete="off" /></Field>
            <Field label={p.secretLabel}><input type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} autoComplete="off" /></Field>
            {p.id === 'linkedin' && <Field label="Organization ID (only to post as a company page)"><input value={org} onChange={(e) => setOrg(e.target.value)} inputMode="numeric" /></Field>}
          </div>
        </>
      )}
      <div className="notice warn">{p.warn}</div>
      <div className="row">
        {(!connected || expired) && <button className="btn primary" data-testid={'connect-' + p.id} disabled={!canConnect || busy || !clientId.trim()} onClick={connect}>{busy ? 'Waiting for sign-in…' : 'Connect'}</button>}
        {connected && <button className="btn danger" onClick={disconnect}>Disconnect</button>}
      </div>
    </div>
  );
}

export function Social() {
  const { data } = useStore();
  const bridge = !!desktopSocial();
  const productName = (videoId: string) => { const v = data.videos.find((x) => x.id === videoId); return data.products.find((p) => p.id === v?.productId)?.name ?? 'Video'; };
  const pubs = [...data.publications].sort((a, b) => (b.triedAt ?? b.createdAt) - (a.triedAt ?? a.createdAt));
  return (
    <>
      <div className="head"><div className="grow"><h1>Auto-post</h1><p>Once you approve a video, the Publisher agent posts it to every platform switched on here.</p></div></div>
      {!bridge && <div className="notice warn" style={{ marginBottom: 14 }}>Automatic posting runs in the desktop app on your always-on PC. On this device you can still save or share approved videos by hand.</div>}
      <div className="notice" style={{ marginBottom: 14 }}>
        Posting uses each platform’s official connection with developer access registered in your own business name. Access keys are stored only in your encrypted vault.
        When connected, this PC contacts those platforms directly — and nothing else.
      </div>
      <div className="grid g2">
        {PROVIDERS.map((p) => <ProviderCard key={p.id + (data.accounts.find((a) => a.id === p.id)?.connectedAt ?? 0)} p={p} acc={data.accounts.find((a) => a.id === p.id)} canConnect={bridge} />)}
      </div>
      <div className="card stack" style={{ marginTop: 14 }}>
        <h2>Posting history</h2>
        {pubs.length === 0 && <small className="muted">Nothing has been posted yet.</small>}
        {pubs.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Video</th><th>Platform</th><th>Status</th><th>When</th><th></th></tr></thead>
              <tbody>
                {pubs.slice(0, 80).map((p) => (
                  <tr key={p.id} data-testid="pub-row">
                    <td><b>{productName(p.videoId)}</b></td>
                    <td>{TARGET_INFO[p.target].label}</td>
                    <td><Chip status={p.status === 'posted' ? 'published' : p.status === 'posting' ? 'rendering' : p.status} />{p.error && <div><small>{p.error}</small></div>}</td>
                    <td>{fmtDateTime(p.postedAt ?? p.triedAt ?? p.createdAt)}</td>
                    <td>
                      {p.url && <a className="btn small" href={p.url} target="_blank" rel="noreferrer noopener">Open</a>}
                      {p.status === 'failed' && <button className="btn small" onClick={() => patch('publications', p.id, { status: 'queued', attempts: 0, error: undefined }).then(() => runPublisher())}><Icon name="refresh" size={15} /> Try again</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
