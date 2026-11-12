import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { GET, POST, type Me } from './api.ts';
import { AppCtx, useApp, useLoad } from './ui.tsx';
import { Dashboard } from './pages/Dashboard.tsx';
import { Apps, AppRuntime } from './pages/Apps.tsx';
import { Data } from './pages/Data.tsx';
import { Agents, Crews, Prompts } from './pages/Agents.tsx';
import { Workflows, Bots, Connectors } from './pages/Automation.tsx';
import { Knowledge } from './pages/Knowledge.tsx';
import { Models } from './pages/Models.tsx';
import { Testing } from './pages/Testing.tsx';
import { Approvals, Deployments, FinOps, Monitoring, Notifications } from './pages/Operate.tsx';
import { Marketplace } from './pages/Marketplace.tsx';
import { Security } from './pages/Security.tsx';
import { Admin } from './pages/Admin.tsx';

const NAV: [string, [string, string][]][] = [
  ['', [['/', 'Dashboard']]],
  ['Build', [['/apps', 'Apps'], ['/data', 'Data tables'], ['/workflows', 'Workflows'], ['/bots', 'RPA bots']]],
  ['AI', [['/agents', 'Agents'], ['/crews', 'Agent crews'], ['/knowledge', 'Knowledge'], ['/prompts', 'Prompts'], ['/models', 'Models']]],
  ['Quality', [['/testing', 'Testing']]],
  ['Operate', [['/deployments', 'Releases'], ['/approvals', 'Approvals'], ['/monitoring', 'Monitoring'], ['/finops', 'Cost and usage'], ['/notifications', 'Notifications']]],
  ['Platform', [['/marketplace', 'Marketplace'], ['/connectors', 'Connectors'], ['/security', 'Security'], ['/admin', 'Administration']]],
];

function useHash() {
  const [hash, setHash] = useState(location.hash.slice(1) || '/');
  useEffect(() => { const h = () => setHash(location.hash.slice(1) || '/'); window.addEventListener('hashchange', h); return () => window.removeEventListener('hashchange', h); }, []);
  return hash;
}

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [toasts, setToasts] = useState<{ id: number; msg: string; err?: boolean }[]>([]);
  const [projectId, setProjectId] = useState(localStorage.getItem('aacs.project') ?? '');
  const reloadMe = useCallback(() => { GET<Me>('/me').then(setMe, () => setMe(null)); }, []);
  useEffect(() => { reloadMe(); const h = () => setMe(null); window.addEventListener('aacs:signed-out', h); return () => window.removeEventListener('aacs:signed-out', h); }, [reloadMe]);
  const toast = useCallback((msg: string, err?: boolean) => { const id = Date.now() + Math.random(); setToasts((t) => [...t.slice(-2), { id, msg, err }]); setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), err ? 7000 : 3500); }, []);
  const hash = useHash();
  if (me === undefined) return null;
  const toastLayer = <div className="toasts" role="status" aria-live="polite">{toasts.map((t) => <div key={t.id} className={`toast ${t.err ? 'err' : ''}`}>{t.msg}</div>)}</div>;
  if (me === null) return <><Auth onDone={reloadMe} />{toastLayer}</>;
  const pid = me.projects.some((p) => p.id === projectId) ? projectId : me.projects[0]?.id ?? '';
  return (
    <AppCtx.Provider value={{ me, reloadMe, toast, projectId: pid }}>
      <Shell hash={hash} projectId={pid} setProjectId={(p) => { localStorage.setItem('aacs.project', p); setProjectId(p); }} />
      {toastLayer}
    </AppCtx.Provider>
  );
}

function Shell({ hash, projectId, setProjectId }: { hash: string; projectId: string; setProjectId: (p: string) => void }) {
  const [open, setOpen] = useState(false);
  const { me } = useApp();
  const [, section = '', id, sub] = hash.split('/');
  const { data: dash } = useLoad(() => GET('/dashboard'), [hash]);
  useEffect(() => setOpen(false), [hash]);
  if (section === 'run') return <AppRuntime id={id} env={sub} />;
  const pages: Record<string, ReactNode> = {
    '': <Dashboard />, apps: <Apps id={id} />, data: <Data id={id} />, workflows: <Workflows id={id} />, bots: <Bots id={id} />, agents: <Agents id={id} />, crews: <Crews id={id} />,
    knowledge: <Knowledge id={id} />, prompts: <Prompts id={id} />, models: <Models id={id} />, testing: <Testing id={id} />, deployments: <Deployments />, approvals: <Approvals />, monitoring: <Monitoring />,
    finops: <FinOps />, notifications: <Notifications />, marketplace: <Marketplace />, connectors: <Connectors id={id} />, security: <Security />, admin: <Admin />,
  };
  const counts: Record<string, number> = { '/approvals': dash?.pendingApprovals ?? 0, '/notifications': dash?.unread ?? 0 };
  return (
    <div className="shell">
      <aside className={`side ${open ? 'open' : ''}`}>
        <div className="brand">AI Agent Creator Suite<span>{me.org.name}</span></div>
        <nav className="nav" aria-label="Main">
          {NAV.map(([group, links]) => (
            <div key={group}>
              {group && <h4>{group}</h4>}
              {links.map(([path, label]) => <a key={path} href={`#${path}`} className={`/${section}` === path ? 'on' : ''} aria-current={`/${section}` === path ? 'page' : undefined}>{label}{counts[path] > 0 && <span className="pill">{counts[path]}</span>}</a>)}
            </div>
          ))}
        </nav>
      </aside>
      <div className="main">
        <TopBar projectId={projectId} setProjectId={setProjectId} toggle={() => setOpen((o) => !o)} />
        <main className="page" onClick={() => open && setOpen(false)}>{pages[section] ?? <div className="notice">Page not found. <a href="#/">Go to the dashboard</a></div>}</main>
      </div>
    </div>
  );
}

function TopBar({ projectId, setProjectId, toggle }: { projectId: string; setProjectId: (p: string) => void; toggle: () => void }) {
  const { me, reloadMe } = useApp();
  return (
    <header className="top">
      <button className="btn sm menu-btn" onClick={toggle} aria-label="Open navigation">Menu</button>
      <label className="row small muted" style={{ gap: 6 }}>Project
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)} style={{ width: 'auto' }}>{me.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
      </label>
      <div className="grow" />
      <span className="small muted hide-sm">{me.user.name} · {me.user.role.replace('_', ' ')}</span>
      <button className="btn sm" onClick={() => POST('/auth/logout').then(reloadMe)}>Sign out</button>
    </header>
  );
}

function Auth({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [f, setF] = useState({ orgName: '', name: '', email: '', password: '', code: '' });
  const [mfa, setMfa] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const on = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setError('');
    try {
      const r = await POST(mode === 'login' ? '/auth/login' : '/auth/register', mode === 'login' ? { email: f.email, password: f.password, code: mfa ? f.code : undefined } : f);
      if (r.mfaRequired) setMfa(true); else onDone();
    } catch (err: any) { setError(err.message); } finally { setBusy(false); }
  };
  return (
    <div className="auth">
      <form className="card col" onSubmit={submit}>
        <div><h1>AI Agent Creator Suite</h1><p className="muted">{mode === 'login' ? 'Sign in to your organisation' : 'Create an organisation. You become its administrator.'}</p></div>
        {mode === 'register' && <>
          <label className="field">Organisation<input value={f.orgName} onChange={on('orgName')} required /></label>
          <label className="field">Your name<input value={f.name} onChange={on('name')} required autoComplete="name" /></label>
        </>}
        <label className="field">Work email<input type="email" value={f.email} onChange={on('email')} required autoComplete="username" /></label>
        <label className="field">Password<input type="password" value={f.password} onChange={on('password')} required autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />{mode === 'register' && <small>At least 10 characters with a letter and a digit.</small>}</label>
        {mfa && <label className="field">Verification code<input value={f.code} onChange={on('code')} inputMode="numeric" autoFocus autoComplete="one-time-code" required /><small>From your authenticator app.</small></label>}
        {error && <div className="notice bad" role="alert">{error}</div>}
        <button className="btn primary" disabled={busy}>{mode === 'login' ? 'Sign in' : 'Create organisation'}</button>
        <button type="button" className="btn ghost" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(''); setMfa(false); }}>{mode === 'login' ? 'New here? Create an organisation' : 'Have an account? Sign in'}</button>
      </form>
    </div>
  );
}
