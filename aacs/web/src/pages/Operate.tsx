// Operations: releases across environments, approvals, run monitoring, cost and usage, notifications.
import { useState } from 'react';
import { api, fmtCost, fmtDate, fmtNum, GET, POST } from '../api.ts';
import { Badge, BarChart, Empty, Modal, PageHead, RankBars, RunTrace, StageList, Tabs, useAction, useApp, useLoad } from '../ui.tsx';

export function Deployments() {
  const { me } = useApp();
  const { data } = useLoad(() => GET<any[]>('/deployments'), []);
  const [open, setOpen] = useState<any>(null);
  const live = (data ?? []).filter((d) => d.status === 'live');
  const resources = [...new Map(live.map((d) => [d.resource_id, d])).values()];
  return (
    <div className="col gap-lg">
      <PageHead title="Releases" blurb="Each release runs the pipeline: commit, build, scan, promotion gate, validate, release. Versions move through DEV, TEST, UAT and PROD in order; production waits for an approver. Start a release from any app, agent, workflow, bot or crew." />
      {!data?.length ? <Empty>Nothing has been released yet. Open an agent, app or workflow and choose Release.</Empty> : <>
        <div className="col">
          <h3>What is live where</h3>
          <div className="table-wrap"><table>
            <thead><tr><th>Resource</th><th>Type</th>{me.envs.map((e) => <th key={e}>{e.toUpperCase()}</th>)}</tr></thead>
            <tbody>{resources.map((r) => <tr key={r.resource_id}><td>{r.resource_name}</td><td>{r.kind}</td>{me.envs.map((e) => { const d = live.find((x) => x.resource_id === r.resource_id && x.env === e); return <td key={e}>{d ? <span className="row" style={{ gap: 6 }}><Badge status="live">v{d.version}</Badge>{d.kind === 'app' && <a className="small" href={`#/run/${d.resource_id}/${e}`} target="_blank" rel="noreferrer">Open</a>}</span> : <span className="muted">-</span>}</td>; })}</tr>)}</tbody>
          </table></div>
        </div>
        <div className="col">
          <h3>Pipeline runs</h3>
          <div className="table-wrap"><table>
            <thead><tr><th>When</th><th>Resource</th><th>Version</th><th>Environment</th><th>Result</th><th>By</th></tr></thead>
            <tbody>{data.map((d) => <tr key={d.id} className="click" onClick={() => setOpen(d)}><td>{fmtDate(d.created_at)}</td><td>{d.resource_name}</td><td className="num">v{d.version}</td><td>{d.env.toUpperCase()}</td><td><Badge status={d.status} /></td><td>{d.created_by}</td></tr>)}</tbody>
          </table></div>
        </div>
      </>}
      {open && <Modal title={`${open.resource_name} v${open.version} to ${open.env.toUpperCase()}`} onClose={() => setOpen(null)}><StageList stages={open.stages} /></Modal>}
    </div>
  );
}

export function Approvals() {
  const { me } = useApp();
  const { data, reload } = useLoad(() => GET<any[]>('/approvals'), []);
  const [comment, setComment] = useState<Record<string, string>>({});
  const { busy, act } = useAction();
  const canDecide = ['admin', 'agent_owner'].includes(me.user.role);
  const pending = (data ?? []).filter((a) => a.status === 'pending');
  const decide = (a: any, approve: boolean) => act(async () => { await POST(`/approvals/${a.id}/decide`, { approve, comment: comment[a.id] ?? '' }); reload(); }, approve ? 'Approved' : 'Rejected');
  return (
    <div className="col gap-lg">
      <PageHead title="Approvals" blurb="Human-in-the-loop decisions: workflow approval steps, crew results and production releases wait here until a person decides." />
      {!canDecide && <div className="notice">Admins and agent owners can approve. You can see what is waiting.</div>}
      {!pending.length && <Empty>Nothing is waiting for a decision.</Empty>}
      {pending.map((a) => (
        <div key={a.id} className="card col">
          <div className="row spread"><h3>{a.title}</h3><span className="row"><Badge status={a.kind === 'deploy' ? 'info' : ''}>{a.kind === 'deploy' ? 'Production release' : 'Run'}</Badge><span className="muted small">{fmtDate(a.requested_at)}</span></span></div>
          {a.detail && <pre className="small">{a.detail}</pre>}
          {canDecide && <div className="row wrap"><input aria-label="Comment" placeholder="Comment (optional)" value={comment[a.id] ?? ''} onChange={(e) => setComment({ ...comment, [a.id]: e.target.value })} style={{ maxWidth: 360 }} /><button className="btn primary" disabled={busy} onClick={() => void decide(a, true)}>Approve</button><button className="btn danger" disabled={busy} onClick={() => void decide(a, false)}>Reject</button></div>}
        </div>
      ))}
      {(data ?? []).some((a) => a.status !== 'pending') && (
        <div className="col"><h3>Decided</h3>
          <div className="table-wrap"><table><thead><tr><th>Request</th><th>Decision</th><th>By</th><th>When</th><th>Comment</th></tr></thead><tbody>
            {data!.filter((a) => a.status !== 'pending').map((a) => <tr key={a.id}><td>{a.title}</td><td><Badge status={a.status} /></td><td>{a.decided_by}</td><td>{fmtDate(a.decided_at)}</td><td>{a.comment}</td></tr>)}
          </tbody></table></div>
        </div>
      )}
    </div>
  );
}

const KINDS = ['All', 'agent', 'workflow', 'crew', 'bot', 'test'];
export function Monitoring() {
  const [kind, setKind] = useState('All');
  const { data } = useLoad(() => GET<any[]>(`/runs?limit=100${kind === 'All' ? '' : `&kind=${kind}`}`), [kind]);
  const [open, setOpen] = useState<any>(null);
  const ok = data?.filter((r) => r.status === 'succeeded').length ?? 0;
  const avg = data?.length ? Math.round(data.reduce((a, r) => a + r.latencyMs, 0) / data.length) : 0;
  const sorted = [...(data ?? [])].map((r) => r.latencyMs).sort((a, b) => a - b);
  return (
    <div className="col gap-lg">
      <PageHead title="Monitoring" blurb="Every agent conversation, workflow, crew, bot and test run with its steps, duration, tokens and cost." />
      <div className="grid g4">
        <div className="card stat"><b>{data?.length ?? 0}</b><span>Runs shown (latest 100)</span></div>
        <div className="card stat"><b>{data?.length ? `${Math.round((ok / data.length) * 100)}%` : 'n/a'}</b><span>Succeeded</span></div>
        <div className="card stat"><b>{avg} ms</b><span>Average duration</span></div>
        <div className="card stat"><b>{sorted[Math.floor(sorted.length * 0.95)] ?? 0} ms</b><span>95th percentile duration</span></div>
      </div>
      <Tabs tabs={KINDS} value={kind} onChange={setKind} />
      <div className="table-wrap"><table>
        <thead><tr><th>Started</th><th>Name</th><th>Type</th><th>Status</th><th className="num">Duration</th><th className="num">Tokens</th><th className="num">Cost</th></tr></thead>
        <tbody>
          {data?.map((r) => <tr key={r.id} className="click" onClick={() => setOpen(r)}><td>{fmtDate(r.startedAt)}</td><td>{r.name}</td><td>{r.kind}</td><td><Badge status={r.status} /></td><td className="num">{r.latencyMs} ms</td><td className="num">{fmtNum(r.tokensIn + r.tokensOut)}</td><td className="num">{fmtCost(r.cost)}</td></tr>)}
          {data && !data.length && <tr><td colSpan={7} className="muted">No runs yet.</td></tr>}
        </tbody>
      </table></div>
      {open && (
        <Modal wide title={`${open.name} · ${open.kind}`} onClose={() => setOpen(null)}>
          <div className="row wrap"><Badge status={open.status} /><span className="muted small">{fmtDate(open.startedAt)} · {open.latencyMs} ms · {fmtCost(open.cost)}</span></div>
          {open.kind !== 'test' && <><h4>Input</h4><pre className="small">{JSON.stringify(open.input, null, 2)}</pre><h4>Steps</h4><RunTrace steps={open.steps} /></>}
          <h4>Output</h4><pre className="small">{typeof open.output === 'string' ? open.output : JSON.stringify(open.kind === 'test' ? open.output?.scorecard : open.output, null, 2)}</pre>
        </Modal>
      )}
    </div>
  );
}

export function FinOps() {
  const { me, reloadMe, toast } = useApp();
  const { data: u } = useLoad(() => GET('/usage/summary'), []);
  const [budget, setBudget] = useState(String(me.org.settings.monthlyBudget ?? ''));
  if (!u) return <p className="muted">Loading</p>;
  const over = u.budget > 0 && u.monthCost > u.budget;
  return (
    <div className="col gap-lg">
      <PageHead title="Cost and usage" blurb="Model calls, tokens and spend for the last 30 days, from the prices entered on each model." />
      <div className="grid g3">
        <div className="card stat"><b>{fmtCost(u.monthCost)}</b><span>Spend this calendar month</span></div>
        <div className="card stat"><b>{u.budget ? fmtCost(u.budget) : 'Not set'}</b><span>Monthly budget</span></div>
        <div className="card col" style={{ gap: 6 }}>
          <label className="field">Set monthly budget (USD)
            <span className="row"><input type="number" min="0" value={budget} disabled={me.user.role !== 'admin'} onChange={(e) => setBudget(e.target.value)} /><button className="btn" disabled={me.user.role !== 'admin'} onClick={() => api('PATCH', '/org', { settings: { monthlyBudget: +budget || 0 } }).then(() => { reloadMe(); toast('Budget saved'); location.reload(); }, (e) => toast(e.message, true))}>Save</button></span>
          </label>
        </div>
      </div>
      {u.budget > 0 && <div className={`notice ${over ? 'bad' : 'good'}`}>{over ? `This month's spend is ${fmtCost(u.monthCost - u.budget)} over budget.` : `${Math.round((u.monthCost / u.budget) * 100)}% of this month's budget is used.`}</div>}
      <div className="grid g2">
        <div className="card col"><h3>Spend per day (USD)</h3><BarChart data={u.daily.map((d: any) => ({ label: d.day.slice(5), values: [d.cost] }))} series={[{ name: 'Spend', color: 'var(--series-1)' }]} fmt={(n) => (n < 1 ? n.toFixed(3) : n.toFixed(2))} /></div>
        <div className="card col"><h3>Model calls per day</h3><BarChart data={u.daily.map((d: any) => ({ label: d.day.slice(5), values: [d.calls] }))} series={[{ name: 'Calls', color: 'var(--series-1)' }]} fmt={fmtNum} /></div>
      </div>
      <div className="grid g2">
        <div className="card col"><h3>Spend by source</h3><RankBars rows={u.bySource.map((s: any) => ({ label: s.source || 'other', value: s.cost, note: `${s.calls} call(s)` }))} fmt={fmtCost} /></div>
        <div className="col">
          <h3>By model</h3>
          <div className="table-wrap"><table><thead><tr><th>Model</th><th className="num">Calls</th><th className="num">Failed</th><th className="num">Tokens in</th><th className="num">Tokens out</th><th className="num">Avg latency</th><th className="num">Cost</th></tr></thead><tbody>
            {u.byModel.map((m: any) => <tr key={m.model}><td>{m.model}<div className="muted small">{m.provider}</div></td><td className="num">{m.calls}</td><td className="num">{m.errors}</td><td className="num">{fmtNum(m.tokens_in)}</td><td className="num">{fmtNum(m.tokens_out)}</td><td className="num">{m.avg_ms} ms</td><td className="num">{fmtCost(m.cost)}</td></tr>)}
            {!u.byModel.length && <tr><td colSpan={7} className="muted">No model calls yet.</td></tr>}
          </tbody></table></div>
        </div>
      </div>
    </div>
  );
}

export function Notifications() {
  const { data, reload } = useLoad(() => GET<any[]>('/notifications').then(async (d) => { await POST('/notifications/read'); return d; }), []);
  const [tab, setTab] = useState('In-app');
  const [open, setOpen] = useState<any>(null);
  const channel = ({ 'In-app': 'in_app', 'Email outbox': 'email', 'SMS outbox': 'sms', Documents: 'document' } as Record<string, string>)[tab];
  const rows = (data ?? []).filter((n) => n.channel === channel);
  return (
    <div className="col gap-lg">
      <PageHead title="Notifications" blurb="In-app notifications, documents generated by workflows, and the email and SMS outbox."><button className="btn" onClick={reload}>Refresh</button></PageHead>
      <Tabs tabs={['In-app', 'Email outbox', 'SMS outbox', 'Documents']} value={tab} onChange={setTab} />
      {(channel === 'email' || channel === 'sms') && <div className="notice warn small">Messages are queued here. No mail or SMS gateway is connected in this build, so nothing leaves the platform until a delivery provider is added.</div>}
      {!rows.length ? <Empty>Nothing here yet.</Empty> : (
        <div className="table-wrap"><table><thead><tr><th>When</th>{channel !== 'in_app' && channel !== 'document' && <th>To</th>}<th>{channel === 'sms' ? 'Message' : 'Subject'}</th><th>Status</th></tr></thead><tbody>
          {rows.map((n) => <tr key={n.id} className="click" onClick={() => setOpen(n)}><td>{fmtDate(n.created_at)}</td>{channel !== 'in_app' && channel !== 'document' && <td>{n.recipient}</td>}<td>{n.subject || n.body.slice(0, 80)}</td><td><Badge status={n.status} /></td></tr>)}
        </tbody></table></div>
      )}
      {open && <Modal title={open.subject || 'Message'} onClose={() => setOpen(null)}>{open.recipient && <p className="muted small">To {open.recipient}</p>}<pre>{open.body}</pre></Modal>}
    </div>
  );
}
