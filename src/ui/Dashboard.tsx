import { useState } from 'react';
import { pendingCounts, runAutopilot } from '../core/actions';
import { saveSettings, useStore } from '../core/store';
import { buildReport, weekStart } from '../core/report';
import type { LeadStage } from '../core/types';
import type { Page } from './App';
import { fmtDateTime, Icon, toast } from './common';

const STAGES: LeadStage[] = ['new', 'contacted', 'qualified', 'won', 'lost'];
const WEEK = 7 * 86_400_000;

export function Dashboard({ go }: { go: (p: Page) => void }) {
  const { data, settings } = useStore();
  const [busy, setBusy] = useState(false);
  const counts = pendingCounts();
  const now = Date.now();
  const newLeads = data.leads.filter((l) => now - l.createdAt < WEEK).length;
  const won = data.leads.filter((l) => l.stage === 'won');
  const closed = won.length + data.leads.filter((l) => l.stage === 'lost').length;
  const upcoming = data.posts.filter((p) => p.scheduledFor > now && p.status !== 'rejected').sort((a, b) => a.scheduledFor - b.scheduledFor).slice(0, 5);
  const maxStage = Math.max(1, ...STAGES.map((s) => data.leads.filter((l) => l.stage === s).length));
  const productName = (id: string) => data.products.find((p) => p.id === id)?.name ?? 'Product';
  const trend = buildReport(data, weekStart(now) - 7 * WEEK, now + 1);
  const trendMax = Math.max(1, ...trend.weekly.map((w) => w.leads));

  async function run() {
    setBusy(true);
    const made = await runAutopilot();
    setBusy(false);
    toast(made.videos + made.posts + made.messages ? `Prepared ${made.videos} video(s), ${made.posts} post(s), ${made.messages} message(s)` : 'Everything is up to date');
  }

  return (
    <>
      <div className="head">
        <div className="grow">
          <h1>{settings.business.name ? `Hello, ${settings.business.name}` : 'Dashboard'}</h1>
          <p>Autopilot prepares the work in the background. Videos, images and posts wait for your approval; {settings.approvals === 'all' ? 'lead messages too.' : 'lead follow-ups go out automatically.'}</p>
        </div>
        <label className="check">
          <input type="checkbox" checked={settings.autopilot.enabled} onChange={(e) => saveSettings({ ...settings, autopilot: { ...settings.autopilot, enabled: e.target.checked } })} />
          Autopilot
        </label>
        <button className="btn" onClick={run} disabled={busy}><Icon name="bolt" /> Run now</button>
      </div>

      {data.products.length === 0 && (
        <div className="card stack" style={{ marginBottom: 14 }}>
          <h2>Start in three steps</h2>
          <p>1. Add a product with a few real photos. &nbsp; 2. Autopilot creates videos, posts and follow-ups. &nbsp; 3. You review and approve.</p>
          <div><button className="btn primary" onClick={() => go('products')}><Icon name="plus" /> Add your first product</button></div>
        </div>
      )}

      <div className="grid g4" style={{ marginBottom: 14 }}>
        <button className="card kpi btn" style={{ display: 'block', textAlign: 'left', borderColor: counts.total ? 'var(--warn)' : undefined }} onClick={() => go('approvals')}>
          <b>{counts.total}</b><span>waiting for your approval</span>
        </button>
        <div className="card kpi"><b>{data.products.filter((p) => p.active).length}</b><span>active products</span></div>
        <div className="card kpi"><b>{data.videos.filter((v) => v.status === 'approved').length}</b><span>approved videos</span></div>
        <div className="card kpi"><b>{newLeads}</b><span>new leads this week</span></div>
        <div className="card kpi"><b>{closed ? Math.round((won.length / closed) * 100) + '%' : '—'}</b><span>lead win rate</span></div>
        <div className="card kpi"><b>{settings.currency}{won.reduce((a, l) => a + (l.value || 0), 0).toLocaleString()}</b><span>won deal value</span></div>
      </div>

      <div className="grid g2">
        <div className="card funnel">
          <h2>Lead pipeline</h2>
          {STAGES.map((s) => {
            const n = data.leads.filter((l) => l.stage === s).length;
            return (
              <div className="frow" key={s}>
                <span style={{ textTransform: 'capitalize' }}>{s}</span>
                <div className="bar"><i style={{ width: `${(n / maxStage) * 100}%`, background: s === 'won' ? 'var(--ok)' : s === 'lost' ? 'var(--bad)' : undefined }} /></div>
                <b>{n}</b>
              </div>
            );
          })}
          <button className="btn small" onClick={() => go('leads')}>Open leads</button>
        </div>
        <div className="card">
          <h2>Coming up</h2>
          {upcoming.length === 0 && <p className="muted">No posts scheduled yet.</p>}
          <div className="stack">
            {upcoming.map((p) => (
              <div className="row between" key={p.id}>
                <span><b style={{ textTransform: 'capitalize' }}>{p.platform}</b> · {productName(p.productId)}<br /><small>{fmtDateTime(p.scheduledFor)}</small></span>
                <span className={'chip ' + p.status}>{p.status === 'pending' ? 'needs approval' : p.status}</span>
              </div>
            ))}
          </div>
          <button className="btn small" style={{ marginTop: 10 }} onClick={() => go('content')}>Open calendar</button>
        </div>
        <div className="card">
          <h2>Leads, last 8 weeks</h2>
          <div className="row" style={{ alignItems: 'flex-end', height: 110, gap: 6 }} role="img" aria-label="Leads per week">
            {trend.weekly.slice(-8).map((w) => (
              <div key={w.week} title={`${new Date(w.week).toLocaleDateString()}: ${w.leads}`} style={{ flex: 1, height: '100%', display: 'flex', alignItems: 'flex-end' }}>
                <div style={{ width: '100%', height: `${(w.leads / trendMax) * 100}%`, minHeight: 2, background: 'var(--brand, #6d28d9)', borderRadius: '4px 4px 0 0' }} />
              </div>
            ))}
          </div>
          <small>Top sources: {trend.bySource.slice(0, 3).map((s) => `${s.source} (${s.leads})`).join(', ') || 'none yet'}</small>
          <div style={{ marginTop: 10 }}><button className="btn small" onClick={() => go('reports')}>Open reports</button></div>
        </div>
        <div className="card stack">
          <h2>Grow</h2>
          <button className="btn" onClick={() => go('images')}><Icon name="image" /> Images for posts and ads ({data.images.filter((c) => c.status === 'approved').length} ready)</button>
          <button className="btn" onClick={() => go('capture')}><Icon name="magnet" /> Collect phone numbers and emails</button>
          <button className="btn" onClick={() => go('seo')}><Icon name="search" /> Get found on Google</button>
        </div>
        <div className="card" style={{ gridColumn: '1 / -1' }}>
          <h2>Recent activity</h2>
          {data.activity.length === 0 && <p className="muted">Nothing yet.</p>}
          <div className="stack">
            {data.activity.slice(0, 8).map((a) => (
              <div className="row" key={a.id}><span className="chip">{a.kind}</span><span style={{ flex: 1 }}>{a.text}</span><small>{fmtDateTime(a.at)}</small></div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
