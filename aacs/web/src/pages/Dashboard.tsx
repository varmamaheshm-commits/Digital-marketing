import { fmtCost, fmtDate, fmtNum, GET } from '../api.ts';
import { Badge, BarChart, Empty, PageHead, useApp, useLoad } from '../ui.tsx';

const S1 = 'var(--series-1)', S2 = 'var(--series-2)';
const BUILD: [string, string, string][] = [['app', 'Apps', '/apps'], ['table', 'Tables', '/data'], ['agent', 'Agents', '/agents'], ['crew', 'Crews', '/crews'], ['workflow', 'Workflows', '/workflows'], ['bot', 'Bots', '/bots'], ['kb', 'Knowledge bases', '/knowledge'], ['testsuite', 'Test suites', '/testing']];

export function Dashboard() {
  const { me } = useApp();
  const { data: d } = useLoad(() => GET('/dashboard'), []);
  if (!d) return <p className="muted">Loading</p>;
  const total = Object.values(d.counts as Record<string, number>).reduce((a, b) => a + b, 0);
  const rate = d.runs.total ? Math.round((d.runs.succeeded / d.runs.total) * 100) : null;
  return (
    <div className="col gap-lg">
      <PageHead title={`Welcome, ${me.user.name.split(' ')[0]}`} blurb="Activity across your organisation over the last 14 days." />
      {total === 0 && (
        <Empty action={<div className="row wrap" style={{ justifyContent: 'center' }}><a className="btn primary" href="#/marketplace">Install a template</a><a className="btn" href="#/agents">Create an agent</a><a className="btn" href="#/apps">Build an app</a></div>}>
          Nothing has been built yet. The quickest start is a marketplace template: it installs a working agent, workflow or app that you can run and then change.
        </Empty>
      )}
      <div className="grid g4">
        <div className="card stat"><b>{fmtNum(d.runs.total)}</b><span>Runs (agents, workflows, bots, tests)</span></div>
        <div className="card stat"><b>{rate === null ? 'n/a' : `${rate}%`}</b><span>Completed successfully</span></div>
        <div className="card stat"><b>{fmtCost(d.cost.c)}</b><span>Model spend · {fmtNum(d.cost.t)} tokens</span></div>
        <a className="card stat click" href="#/approvals" style={{ color: 'inherit', textDecoration: 'none' }}><b>{d.pendingApprovals}</b><span>Approvals waiting for a person</span></a>
      </div>
      <div className="grid split" style={{ gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)' }}>
        <div className="card col">
          <h3>Runs per day</h3>
          <BarChart data={d.runsDaily.map((r: any) => ({ label: r.day.slice(5), values: [r.succeeded, r.other] }))} series={[{ name: 'Succeeded', color: S1 }, { name: 'Failed, blocked or waiting', color: S2 }]} />
        </div>
        <div className="card col">
          <h3>What has been built</h3>
          <table><tbody>{BUILD.map(([k, label, href]) => <tr key={k}><td><a href={`#${href}`}>{label}</a></td><td className="num">{d.counts[k] ?? 0}</td></tr>)}</tbody></table>
        </div>
      </div>
      <div className="card col">
        <div className="row spread"><h3>Recent runs</h3><a href="#/monitoring" className="small">All runs</a></div>
        {d.recent.length ? (
          <div className="table-wrap"><table><thead><tr><th>Name</th><th>Type</th><th>Status</th><th>Started</th><th className="num">Duration</th><th className="num">Cost</th></tr></thead><tbody>
            {d.recent.map((r: any) => <tr key={r.id}><td>{r.name}</td><td>{r.kind}</td><td><Badge status={r.status} /></td><td>{fmtDate(r.startedAt)}</td><td className="num">{r.latencyMs} ms</td><td className="num">{fmtCost(r.cost)}</td></tr>)}
          </tbody></table></div>
        ) : <p className="muted small">Runs appear here once an agent, workflow, bot or test suite has been started.</p>}
      </div>
    </div>
  );
}
