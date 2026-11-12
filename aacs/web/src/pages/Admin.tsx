// Administration: users and roles, organisation (tenant) settings, projects, and the signed-in user's own account.
import { useState } from 'react';
import { api, DEL, fmtDate, GET, POST } from '../api.ts';
import { Badge, Fields, Modal, PageHead, Tabs, useAction, useApp, useLoad } from '../ui.tsx';

const ROLE_HELP: Record<string, string> = {
  admin: 'Everything, including users, models, secrets and policy', developer: 'Builds and releases every kind of resource', business_user: 'Citizen developer: apps, tables, workflows and prompts',
  tester: 'Creates and runs test suites', agent_owner: 'Owns agents, crews and knowledge; approves requests',
};
const REGIONS = [['in', 'India'], ['eu', 'European Union'], ['us', 'United States'], ['uk', 'United Kingdom'], ['sg', 'Singapore'], ['au', 'Australia']];

export function Admin() {
  const { me } = useApp();
  const admin = me.user.role === 'admin';
  const [tab, setTab] = useState('My account');
  return (
    <div className="col gap-lg">
      <PageHead title="Administration" blurb={`${me.org.name} · you are signed in as ${me.user.email}`} />
      <Tabs tabs={['My account', 'Users and roles', 'Organisation', 'Projects']} value={tab} onChange={setTab} />
      {tab === 'My account' && <Account />}
      {tab === 'Users and roles' && <Users admin={admin} />}
      {tab === 'Organisation' && <Org admin={admin} />}
      {tab === 'Projects' && <Projects />}
    </div>
  );
}

function Account() {
  const { me, reloadMe } = useApp();
  const [setup, setSetup] = useState<any>(null);
  const [code, setCode] = useState('');
  const [pw, setPw] = useState({ current: '', next: '' });
  const { busy, act } = useAction();
  return (
    <div className="grid g2">
      <div className="card col">
        <div className="row spread"><h3>Two-step verification (MFA)</h3><Badge status={me.user.mfaEnabled ? 'active' : 'warn'}>{me.user.mfaEnabled ? 'On' : 'Off'}</Badge></div>
        {me.user.mfaEnabled ? (
          <form className="col" onSubmit={(e) => { e.preventDefault(); void act(async () => { await POST('/auth/mfa/disable', { password: pw.current }); reloadMe(); }, 'Two-step verification turned off'); }}>
            <p className="muted small">A code from your authenticator app is required at every sign-in.</p>
            <label className="field">Password, to turn it off<input type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} /></label>
            <div><button className="btn danger" disabled={busy || !pw.current}>Turn off</button></div>
          </form>
        ) : setup ? (
          <form className="col" onSubmit={(e) => { e.preventDefault(); void act(async () => { await POST('/auth/mfa/enable', { code }); setSetup(null); setCode(''); reloadMe(); }, 'Two-step verification is on'); }}>
            <p className="small">Add a new account in your authenticator app (Microsoft Authenticator, Google Authenticator, Authy) using "enter a setup key":</p>
            <div className="notice mono" style={{ wordBreak: 'break-all' }}>{setup.secret}</div>
            <label className="field">Then enter the 6-digit code it shows<input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} /></label>
            <div><button className="btn primary" disabled={busy || code.length < 6}>Confirm and turn on</button></div>
          </form>
        ) : <><p className="muted small">Protects your account with a time-based code in addition to the password.</p><div><button className="btn primary" disabled={busy} onClick={() => act(async () => setSetup(await POST('/auth/mfa/setup')))}>Set up</button></div></>}
      </div>
      <form className="card col" onSubmit={(e) => { e.preventDefault(); void act(async () => { await POST('/auth/password', pw); setPw({ current: '', next: '' }); }, 'Password changed. Other sessions were signed out.'); }}>
        <h3>Change password</h3>
        <label className="field">Current password<input type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} /></label>
        <label className="field">New password<input type="password" autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} /><small>At least 10 characters with a letter and a digit.</small></label>
        <div><button className="btn" disabled={busy || !pw.current || !pw.next}>Change password</button></div>
      </form>
    </div>
  );
}

function Users({ admin }: { admin: boolean }) {
  const { me } = useApp();
  const { data, reload } = useLoad(() => GET<any[]>('/users'), []);
  const [edit, setEdit] = useState<any>(null);
  const { busy, act } = useAction();
  const roleOpts = me.roles.map((r) => ({ value: r, label: r.replace('_', ' ') }));
  const save = () => act(async () => { if (edit.id) await api('PATCH', `/users/${edit.id}`, edit); else await POST('/users', edit); setEdit(null); reload(); }, 'User saved');
  return (
    <div className="col">
      <div className="row spread"><span className="muted small">{data?.length ?? 0} user(s)</span>{admin && <button className="btn primary" onClick={() => setEdit({ role: 'business_user' })}>Add user</button>}</div>
      <div className="table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Team</th><th>Department</th><th>MFA</th><th>Status</th><th /></tr></thead><tbody>
        {data?.map((u) => <tr key={u.id}><td>{u.name}</td><td>{u.email}</td><td>{u.role.replace('_', ' ')}</td><td>{u.team}</td><td>{u.department}</td><td><Badge status={u.mfaEnabled ? 'active' : 'warn'}>{u.mfaEnabled ? 'On' : 'Off'}</Badge></td><td><Badge status={u.status} /></td><td>{admin && <button className="btn sm" onClick={() => setEdit(u)}>Edit</button>}</td></tr>)}
      </tbody></table></div>
      <div className="table-wrap"><table><thead><tr><th>Role</th><th>What it can do</th></tr></thead><tbody>{me.roles.map((r) => <tr key={r}><td><b>{r.replace('_', ' ')}</b></td><td>{ROLE_HELP[r]}. Everyone can view and run resources.</td></tr>)}</tbody></table></div>
      {edit && (
        <Modal title={edit.id ? `Edit ${edit.email}` : 'Add user'} onClose={() => setEdit(null)}>
          <Fields value={edit} onChange={setEdit} columns={2} defs={[
            { key: 'name', label: 'Name' }, ...(edit.id ? [] : [{ key: 'email', label: 'Email' }, { key: 'password', label: 'Initial password', kind: 'password' as const, hint: 'Share it securely; the user should change it at first sign-in.' }]),
            { key: 'role', label: 'Role', kind: 'select', options: roleOpts }, { key: 'team', label: 'Team' }, { key: 'department', label: 'Department' },
            ...(edit.id ? [{ key: 'status', label: 'Status', kind: 'select' as const, options: [{ value: 'active', label: 'Active' }, { value: 'disabled', label: 'Disabled (cannot sign in)' }] }] : []),
          ]} />
          <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn primary" disabled={busy} onClick={() => void save()}>Save</button></div>
        </Modal>
      )}
    </div>
  );
}

function Org({ admin }: { admin: boolean }) {
  const { me, reloadMe, toast } = useApp();
  const [f, setF] = useState({ name: me.org.name, region: me.org.region });
  return (
    <div className="card col" style={{ maxWidth: 560 }}>
      <fieldset disabled={!admin} style={{ border: 0, padding: 0, margin: 0 }}>
        <Fields value={f} onChange={setF} defs={[{ key: 'name', label: 'Organisation (tenant) name' }, { key: 'region', label: 'Data residency region', kind: 'select', options: REGIONS.map(([value, label]) => ({ value, label })), hint: 'Recorded for compliance. Where data is physically stored is decided by where this server and its database are deployed.' }]} />
      </fieldset>
      {admin && <div><button className="btn primary" onClick={() => api('PATCH', '/org', f).then(() => { reloadMe(); toast('Organisation saved'); }, (e) => toast(e.message, true))}>Save</button></div>}
      <p className="muted small">Each organisation is an isolated tenant: its users, resources, records, knowledge, secrets and logs are never visible to another organisation.</p>
    </div>
  );
}

function Projects() {
  const { me, reloadMe } = useApp();
  const [f, setF] = useState({ name: '', description: '' });
  const { busy, act } = useAction();
  const canAdd = ['admin', 'developer'].includes(me.user.role);
  return (
    <div className="col">
      <p className="muted small">Projects are workspaces that group resources. Switch project in the top bar. Each resource moves through the DEV, TEST, UAT and PROD environments under Releases.</p>
      {canAdd && (
        <form className="card row wrap" onSubmit={(e) => { e.preventDefault(); void act(async () => { await POST('/projects', f); setF({ name: '', description: '' }); reloadMe(); }, 'Project created'); }}>
          <input aria-label="Project name" placeholder="Project name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} style={{ maxWidth: 240 }} />
          <input aria-label="Description" placeholder="Description" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} style={{ maxWidth: 360 }} />
          <button className="btn primary" disabled={busy || !f.name.trim()}>Add project</button>
        </form>
      )}
      <div className="table-wrap"><table><thead><tr><th>Project</th><th>Description</th><th>Created</th><th /></tr></thead><tbody>
        {me.projects.map((p: any) => <tr key={p.id}><td><b>{p.name}</b></td><td>{p.description}</td><td>{fmtDate(p.created_at)}</td><td>{me.user.role === 'admin' && me.projects.length > 1 && <button className="btn sm ghost danger" onClick={() => confirm(`Delete project "${p.name}"?`) && act(async () => { await DEL(`/projects/${p.id}`); reloadMe(); })}>Delete</button>}</td></tr>)}
      </tbody></table></div>
    </div>
  );
}
