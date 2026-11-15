import { useState } from 'react';
import { desktopSocial, runPublisher } from '../core/publisher';
import { log, patch, put, remove, useStore } from '../core/store';
import { FORMAT_INFO, TARGET_INFO, type SocialAccount, type SocialProvider, type SocialTarget, type VideoFormat } from '../core/types';
import { copyText } from '../core/files';
import { Chip, Field, fmtDateTime, Icon, Modal, toast } from './common';

const PORT = 53682;
interface GuideStep { title: string; text: string; link?: string; linkLabel?: string; copyRedirect?: boolean }
interface ProviderInfo { id: SocialProvider; name: string; short: string; targets: SocialTarget[]; redirect: string; idLabel: string; secretLabel: string; secretOptional?: boolean; guide: GuideStep[]; warn: string }
const PROVIDERS: ProviderInfo[] = [
  {
    id: 'google', name: 'YouTube', short: 'Post videos and Shorts to your YouTube channel.', targets: ['youtube'], redirect: `http://127.0.0.1:${PORT}/oauth`, idLabel: 'Client ID', secretLabel: 'Client secret',
    guide: [
      { title: 'Create a Google Cloud project', text: 'Sign in with the Google account that owns your YouTube channel, give the project any name and press Create.', link: 'https://console.cloud.google.com/projectcreate', linkLabel: 'Open Google Cloud' },
      { title: 'Switch on the YouTube connection', text: 'With your new project selected, press Enable on “YouTube Data API v3”.', link: 'https://console.cloud.google.com/apis/library/youtube.googleapis.com', linkLabel: 'Open YouTube Data API' },
      { title: 'Fill in the consent screen', text: 'Press Get started, enter an app name and your email, choose External. Then under Audience → Test users add your own Google address.', link: 'https://console.cloud.google.com/auth/overview', linkLabel: 'Open consent screen' },
      { title: 'Create the sign-in key', text: 'Press Create client, choose application type “Desktop app”, press Create. Copy the Client ID and Client secret it shows.', link: 'https://console.cloud.google.com/auth/clients', linkLabel: 'Open sign-in clients' },
    ],
    warn: 'Until Google has audited your project, videos uploaded through it are locked as private on YouTube.',
  },
  {
    id: 'meta', name: 'Instagram + Facebook', short: 'Post reels to Instagram and videos to your Facebook Page.', targets: ['instagram', 'facebook'], redirect: `http://localhost:${PORT}/oauth`, idLabel: 'App ID', secretLabel: 'App secret',
    guide: [
      { title: 'Check your accounts', text: 'You need a Facebook Page, and your Instagram must be a Business or Creator account linked to that Page (Instagram app → Settings → Account type and tools).' },
      { title: 'Create a Meta app', text: 'Press Create app, give it a name, and choose the Business type when asked.', link: 'https://developers.facebook.com/apps/', linkLabel: 'Open Meta for Developers' },
      { title: 'Add Facebook Login for Business', text: 'In your app, add the product “Facebook Login for Business”. Open its Settings and paste the address below into “Valid OAuth Redirect URIs”, then Save.', copyRedirect: true },
      { title: 'Copy the App ID and secret', text: 'Open App settings → Basic. Copy the App ID, press Show next to App secret and copy that too.' },
    ],
    warn: 'While the Meta app is in development mode, its posts are visible only to people with a role on the app. To go Live, Meta requires business verification and App Review.',
  },
  {
    id: 'linkedin', name: 'LinkedIn', short: 'Post videos to your LinkedIn profile or company page.', targets: ['linkedin'], redirect: `http://localhost:${PORT}/oauth`, idLabel: 'Client ID', secretLabel: 'Client secret',
    guide: [
      { title: 'Create a LinkedIn app', text: 'Enter an app name and choose your LinkedIn company page (an app must belong to one), then Create app.', link: 'https://www.linkedin.com/developers/apps/new', linkLabel: 'Open LinkedIn Developers' },
      { title: 'Request the two products', text: 'On the Products tab, request “Share on LinkedIn” and “Sign In with LinkedIn using OpenID Connect”.' },
      { title: 'Add the redirect address', text: 'On the Auth tab, under “Authorized redirect URLs”, add the address below and press Update.', copyRedirect: true },
      { title: 'Copy the Client ID and secret', text: 'They are on the same Auth tab, under Application credentials.' },
    ],
    warn: 'LinkedIn access lasts about 60 days; the app will ask you to connect again when it expires.',
  },
  {
    id: 'x', name: 'X', short: 'Post videos to your X account.', targets: ['x'], redirect: `http://127.0.0.1:${PORT}/oauth`, idLabel: 'Client ID', secretLabel: 'Client secret', secretOptional: true,
    guide: [
      { title: 'Open the X developer portal', text: 'Sign in with your X account and create a project and an app inside it.', link: 'https://developer.x.com/en/portal/dashboard', linkLabel: 'Open X Developer Portal' },
      { title: 'Set up user authentication', text: 'In the app, open “User authentication settings” → Set up. Choose permissions “Read and write” and app type “Native App”. Paste the address below as the Callback URI; for Website URL enter your business website or relay site.', copyRedirect: true },
      { title: 'Copy the Client ID', text: 'After saving, X shows the OAuth 2.0 Client ID. Copy it. (A Native App has no client secret — leave that box empty.)' },
    ],
    warn: 'X charges for posting through its connection; check that your plan allows posts with video.',
  },
];

/** Turns a platform's technical refusal into advice the owner can act on. */
function explain(error: string, p: ProviderInfo): string {
  const e = error.toLowerCase();
  if (/redirect|callback/.test(e)) return `${p.name} says the redirect address does not match. Copy the address from the step above again and paste it into ${p.name}'s settings exactly, with nothing added.`;
  if (/invalid_client|unauthorized_client|client secret|app secret|validating application/.test(e)) return `${p.name} did not recognise the ${p.idLabel} or secret. Copy both again — a missing character or extra space is the usual cause.`;
  if (/access_denied|cancel|did not match/.test(e)) return 'The sign-in was cancelled or not allowed. Press Connect again and choose Allow in the browser.';
  if (/5 minutes/.test(e)) return 'No sign-in arrived within 5 minutes. Press Connect and finish signing in in the browser window that opens.';
  if (/port 53682/.test(e)) return error;
  return error;
}

function CopyBox({ value }: { value: string }) {
  return (
    <div className="row" style={{ marginTop: 6 }}>
      <code style={{ userSelect: 'all', background: 'var(--panel)', padding: '6px 10px', borderRadius: 8, wordBreak: 'break-all', flex: 1 }}>{value}</code>
      <button type="button" className="btn small" onClick={async () => { await copyText(value); toast('Address copied'); }}><Icon name="copy" size={15} /> Copy</button>
    </div>
  );
}

function SetupWizard({ p, acc, onClose }: { p: ProviderInfo; acc?: SocialAccount; onClose: () => void }) {
  const { data } = useStore();
  const remembered = data.accounts.find((a) => a.redirectUri)?.redirectUri ?? '';
  const [clientId, setClientId] = useState(acc?.clientId ?? '');
  const [clientSecret, setClientSecret] = useState(acc?.clientSecret ?? '');
  const [org, setOrg] = useState(acc?.organizationId ?? '');
  const [redirect, setRedirect] = useState(acc?.redirectUri ?? (p.id === 'meta' ? remembered : ''));
  const [useRelay, setUseRelay] = useState(!!(acc?.redirectUri ?? (p.id === 'meta' && remembered)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const bridge = desktopSocial();
  const address = useRelay && redirect.trim() ? redirect.trim() : p.redirect;
  const relayBad = useRelay && !/^https:\/\/[^?#\s]+$/.test(redirect.trim());
  const ready = !!clientId.trim() && (p.secretOptional || !!clientSecret.trim()) && !relayBad;

  async function connect() {
    if (!bridge) return;
    setBusy(true); setError('');
    const res = await bridge.connect(p.id, { clientId: clientId.trim(), clientSecret: clientSecret.trim(), organizationId: org.trim(), redirectUri: useRelay ? redirect.trim() : '' }).catch((e) => ({ ok: false, error: String(e?.message ?? e), account: undefined }));
    setBusy(false);
    if (!res.ok || !res.account) return setError(explain(res.error ?? 'Could not connect.', p));
    const now = Date.now();
    const targets: SocialAccount['targets'] = {};
    for (const t of p.targets) targets[t] = acc?.targets[t] ?? { auto: true, formats: TARGET_INFO[t].formats, since: now };
    await put('accounts', {
      id: p.id, clientId: clientId.trim(), clientSecret: clientSecret.trim(), organizationId: org.trim() || undefined, redirectUri: useRelay ? redirect.trim() : undefined,
      accessToken: '', refreshToken: '', expiresAt: 0, name: '', extra: {}, ...res.account, connectedAt: now, targets,
    } as SocialAccount);
    await log('security', `Connected ${p.name} (${res.account.name ?? ''}).`);
    toast(`Connected: ${res.account.name ?? p.name}`);
    onClose();
  }

  const last = p.guide.length + 1;
  return (
    <Modal wide title={`Connect ${p.name}`} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Close</button><button className="btn primary" data-testid={'connect-' + p.id} disabled={!bridge || busy || !ready} onClick={connect}>{busy ? 'Waiting for you to sign in in the browser…' : `Connect ${p.name}`}</button></>}>
      <div className="stack">
        <p className="muted">You do this once. It registers the connection in your own name, so nobody else stands between you and {p.name}. The pages may look slightly different from the descriptions as {p.name} updates them.</p>
        {p.guide.map((g, i) => (
          <div className="card stack" key={g.title} style={{ boxShadow: 'none' }}>
            <div className="row"><span className="chip new">Step {i + 1} of {last}</span><b>{g.title}</b></div>
            <div>{g.text}</div>
            {g.copyRedirect && <CopyBox value={address} />}
            {g.link && <div><a className="btn small" href={g.link} target="_blank" rel="noreferrer noopener"><Icon name="share" size={15} /> {g.linkLabel}</a></div>}
          </div>
        ))}
        <div className="card stack" style={{ boxShadow: 'none', borderColor: 'var(--brand)' }}>
          <div className="row"><span className="chip new">Step {last} of {last}</span><b>Paste them here and connect</b></div>
          <div className="form">
            <Field label={p.idLabel}><input data-testid={'cid-' + p.id} value={clientId} onChange={(e) => setClientId(e.target.value)} autoComplete="off" spellCheck={false} /></Field>
            <Field label={p.secretLabel + (p.secretOptional ? ' (leave empty for a Native App)' : '')}><input type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} autoComplete="off" /></Field>
            {p.id === 'linkedin' && <Field label="Organization ID (only to post as your company page)" hint="Needs LinkedIn’s “Community Management API” approval. Leave empty to post as yourself."><input value={org} onChange={(e) => setOrg(e.target.value)} inputMode="numeric" /></Field>}
          </div>
          {p.id !== 'google' && (
            <>
              <label className="check"><input data-testid={'relay-' + p.id} type="checkbox" checked={useRelay} onChange={(e) => setUseRelay(e.target.checked)} /> {p.name} asks for an address starting with https:// — use my relay page</label>
              {useRelay && (
                <Field label="My relay page address" hint="The address of your GitHub Pages site ending in /oauth/ (see “Relay page” in the README). The steps above now show this address to copy.">
                  <input data-testid={'redirect-' + p.id} value={redirect} onChange={(e) => setRedirect(e.target.value)} placeholder="https://your-name.github.io/your-repository/oauth/" autoComplete="off" inputMode="url" spellCheck={false} />
                </Field>
              )}
              {relayBad && redirect.trim() !== '' && <div className="notice bad">The relay address must start with https:// and contain no “?” or “#”.</div>}
            </>
          )}
          <small className="muted">When you press Connect, your browser opens {p.name}’s own sign-in page. Sign in, press Allow, and come back here. Your keys are stored only in your encrypted vault.</small>
          {error && <div className="notice bad" role="alert" data-testid="connect-error">{error}</div>}
          {!bridge && <div className="notice warn">Connecting works in the desktop app on your PC.</div>}
        </div>
        <div className="notice warn">{p.warn}</div>
      </div>
    </Modal>
  );
}

function ProviderCard({ p, acc }: { p: ProviderInfo; acc?: SocialAccount }) {
  const [setup, setSetup] = useState(false);
  const connected = !!acc?.accessToken;
  const expired = connected && p.id === 'linkedin' && acc!.expiresAt < Date.now();

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
      <div className="row between"><h2 style={{ margin: 0 }}>{p.name}</h2><span className={'chip ' + (expired ? 'failed' : connected ? 'active' : '')}>{expired ? 'expired — connect again' : connected ? 'connected' : 'not connected'}</span></div>
      {!connected && <p className="muted" style={{ margin: 0 }}>{p.short}</p>}
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

      <div className="row">
        {(!connected || expired) && <button className="btn primary" data-testid={'setup-' + p.id} onClick={() => setSetup(true)}><Icon name="plus" /> {expired ? 'Connect again' : acc?.clientId ? 'Continue setup' : `Connect ${p.name}`}</button>}
        {connected && <button className="btn danger" onClick={disconnect}>Disconnect</button>}
      </div>
      {setup && <SetupWizard p={p} acc={acc} onClose={() => setSetup(false)} />}
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
        Press <b>Connect</b> on a platform and follow the steps — about 10 minutes each, once. Newly connected platforms post every video you approve from then on; you can switch that off per platform.
      </div>
      <div className="grid g2">
        {PROVIDERS.map((p) => <ProviderCard key={p.id} p={p} acc={data.accounts.find((a) => a.id === p.id)} />)}
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
