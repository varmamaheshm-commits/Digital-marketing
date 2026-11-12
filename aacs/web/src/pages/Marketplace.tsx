import { useState } from 'react';
import { DEL, GET, POST } from '../api.ts';
import { Empty, PageHead, Tabs, go, useAction, useApp, useLoad } from '../ui.tsx';

const TABS: [string, string][] = [['All', ''], ['Agents', 'agent'], ['Workflows', 'workflow'], ['RPA bots', 'bot'], ['Apps', 'app'], ['Prompts', 'prompt'], ['Connectors', 'connector']];
const HOME: Record<string, string> = { agent: '/agents', crew: '/crews', workflow: '/workflows', bot: '/bots', app: '/apps', prompt: '/prompts', connector: '/connectors', table: '/data', kb: '/knowledge', testsuite: '/testing' };

export function Marketplace() {
  const { me, projectId } = useApp();
  const { data, reload } = useLoad(() => GET('/marketplace'), []);
  const [tab, setTab] = useState('All');
  const { busy, act } = useAction();
  const cat = TABS.find(([t]) => t === tab)![1];
  const items = [...(data?.listings ?? []).map((l: any) => ({ ...l, own: true })), ...(data?.templates ?? [])].filter((t: any) => !cat || t.category === cat);
  const install = (t: any) => act(async () => { const created = await POST<any[]>('/marketplace/install', { id: t.id, projectId }); const main = created[created.length - 1]; go(`${HOME[main.kind] ?? '/'}/${main.id}`); }, `Installed ${t.name}`);
  return (
    <div className="col gap-lg">
      <PageHead title="Marketplace" blurb="Ready-made agents, workflows, bots, apps, prompts and connectors. Installing copies everything a template needs into the current project; you can then change it freely. Use Share on any resource to publish it here for your organisation." />
      <Tabs tabs={TABS.map(([t]) => t)} value={tab} onChange={setTab} />
      {data && !items.length && <Empty>No templates in this category yet.</Empty>}
      <div className="grid auto-cards">
        {items.map((t: any) => (
          <div key={t.id} className="card col" style={{ gap: 8 }}>
            <div className="row spread"><h3>{t.name}</h3><span className="badge">{t.category}</span></div>
            <p className="small" style={{ color: 'var(--text-2)' }}>{t.description || 'No description.'}</p>
            <p className="muted small">Installs: {t.contains.join(', ')}</p>
            <div className="row spread" style={{ marginTop: 'auto' }}>
              <span className="muted small">{t.own ? `Shared by ${t.source}` : 'Built in'}</span>
              <span className="row">{t.own && me.user.role === 'admin' && <button className="btn sm ghost danger" onClick={() => confirm('Remove this listing?') && DEL(`/marketplace/${t.id}`).then(reload)}>Remove</button>}<button className="btn sm primary" disabled={busy} onClick={() => void install(t)}>Install</button></span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
