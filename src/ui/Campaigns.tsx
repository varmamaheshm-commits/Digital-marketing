import { useState } from 'react';
import { put, remove, useStore } from '../core/store';
import { uid, type Campaign, type Platform } from '../core/types';
import { Chip, Empty, Field, fmtDate, Icon, Modal } from './common';

const PLATFORMS: Platform[] = ['instagram', 'youtube', 'facebook', 'whatsapp', 'email', 'ad'];
const blank = (): Campaign => ({
  id: uid(), name: '', goal: 'Get more enquiries', channels: ['instagram'], budget: 0, start: Date.now(), end: Date.now() + 14 * 86_400_000,
  status: 'draft', metrics: { impressions: 0, clicks: 0, leads: 0, sales: 0, spend: 0, revenue: 0 }, createdAt: Date.now(),
});
const day = (t: number) => new Date(t - new Date(t).getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const pct = (a: number, b: number) => (b > 0 ? ((a / b) * 100).toFixed(1) + '%' : '—');

export function Campaigns() {
  const { data, settings } = useStore();
  const [edit, setEdit] = useState<Campaign | null>(null);
  const list = [...data.campaigns].sort((a, b) => b.createdAt - a.createdAt);
  const money = (n: number) => settings.currency + Math.round(n).toLocaleString();
  const total = list.reduce((a, c) => ({ spend: a.spend + c.metrics.spend, revenue: a.revenue + c.metrics.revenue, leads: a.leads + c.metrics.leads, clicks: a.clicks + c.metrics.clicks, impressions: a.impressions + c.metrics.impressions }), { spend: 0, revenue: 0, leads: 0, clicks: 0, impressions: 0 });
  const maxRev = Math.max(1, ...list.map((c) => Math.max(c.metrics.revenue, c.metrics.spend)));
  return (
    <>
      <div className="head">
        <div className="grow"><h1>Campaigns</h1><p>Plan campaigns, record results and see what pays back.</p></div>
        <button className="btn primary" onClick={() => setEdit(blank())}><Icon name="plus" /> New campaign</button>
      </div>
      {list.length === 0 ? <Empty title="No campaigns yet">Create one to track budget, reach, leads and sales.</Empty> : (
        <>
          <div className="grid g4" style={{ marginBottom: 14 }}>
            <div className="card kpi"><b>{money(total.spend)}</b><span>total spend</span></div>
            <div className="card kpi"><b>{money(total.revenue)}</b><span>revenue</span></div>
            <div className="card kpi"><b>{total.spend > 0 ? (total.revenue / total.spend).toFixed(1) + '×' : '—'}</b><span>return on spend</span></div>
            <div className="card kpi"><b>{pct(total.clicks, total.impressions)}</b><span>click rate</span></div>
            <div className="card kpi"><b>{total.leads > 0 ? money(total.spend / total.leads) : '—'}</b><span>cost per lead</span></div>
          </div>
          <div className="grid g2">
            {list.map((c) => (
              <div className="card stack" key={c.id}>
                <div className="row between"><b>{c.name}</b><Chip status={c.status} /></div>
                <small>{c.goal} · {fmtDate(c.start)} – {fmtDate(c.end)} · {c.channels.join(', ')}</small>
                <div>
                  <small>Spend {money(c.metrics.spend)} of {money(c.budget)}</small>
                  <div className="bar"><i style={{ width: `${Math.min(100, (c.metrics.spend / maxRev) * 100)}%`, background: 'var(--warn)' }} /></div>
                  <small>Revenue {money(c.metrics.revenue)}</small>
                  <div className="bar"><i style={{ width: `${Math.min(100, (c.metrics.revenue / maxRev) * 100)}%`, background: 'var(--ok)' }} /></div>
                </div>
                <small>{c.metrics.impressions.toLocaleString()} views · {c.metrics.clicks.toLocaleString()} clicks ({pct(c.metrics.clicks, c.metrics.impressions)}) · {c.metrics.leads} leads · {c.metrics.sales} sales</small>
                <div><button className="btn small" onClick={() => setEdit(c)}>Edit & record results</button></div>
              </div>
            ))}
          </div>
        </>
      )}
      {edit && <CampaignForm initial={edit} isNew={!data.campaigns.some((c) => c.id === edit.id)} onClose={() => setEdit(null)} />}
    </>
  );
}

function CampaignForm({ initial, isNew, onClose }: { initial: Campaign; isNew: boolean; onClose: () => void }) {
  const { data } = useStore();
  const [c, setC] = useState(initial);
  const set = (k: keyof Campaign, v: any) => setC((x) => ({ ...x, [k]: v }));
  const metric = (k: keyof Campaign['metrics'], label: string) => (
    <Field label={label}><input type="number" min={0} value={c.metrics[k] || ''} onChange={(e) => setC((x) => ({ ...x, metrics: { ...x.metrics, [k]: Number(e.target.value) || 0 } }))} /></Field>
  );
  return (
    <Modal title={isNew ? 'New campaign' : 'Edit campaign'} onClose={onClose}
      footer={
        <>
          {!isNew && <button className="btn danger" onClick={async () => { if (confirm('Delete this campaign?')) { await remove('campaigns', c.id); onClose(); } }}><Icon name="trash" /> Delete</button>}
          <button className="btn primary" onClick={async () => { if (c.name.trim()) { await put('campaigns', c); onClose(); } }}>Save</button>
        </>
      }>
      <div className="form">
        <Field label="Campaign name"><input value={c.name} onChange={(e) => set('name', e.target.value)} autoFocus /></Field>
        <Field label="Goal"><input value={c.goal} onChange={(e) => set('goal', e.target.value)} /></Field>
        <Field label="Product"><select value={c.productId ?? ''} onChange={(e) => set('productId', e.target.value || undefined)}><option value="">All products</option>{data.products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
        <Field label="Status"><select value={c.status} onChange={(e) => set('status', e.target.value)}>{['draft', 'active', 'paused', 'done'].map((s) => <option key={s}>{s}</option>)}</select></Field>
        <Field label="Starts"><input type="date" value={day(c.start)} onChange={(e) => set('start', new Date(e.target.value).getTime() || c.start)} /></Field>
        <Field label="Ends"><input type="date" value={day(c.end)} onChange={(e) => set('end', new Date(e.target.value).getTime() || c.end)} /></Field>
        <Field label="Budget"><input type="number" min={0} value={c.budget || ''} onChange={(e) => set('budget', Number(e.target.value) || 0)} /></Field>
        <div className="full row">
          {PLATFORMS.map((p) => (
            <label className="check" key={p}><input type="checkbox" checked={c.channels.includes(p)} onChange={(e) => set('channels', e.target.checked ? [...c.channels, p] : c.channels.filter((x) => x !== p))} /> {p}</label>
          ))}
        </div>
        <h3 className="full" style={{ marginTop: 6 }}>Results so far</h3>
        {metric('impressions', 'Views')}{metric('clicks', 'Clicks')}{metric('leads', 'Leads')}{metric('sales', 'Sales')}{metric('spend', 'Spend')}{metric('revenue', 'Revenue')}
      </div>
    </Modal>
  );
}
