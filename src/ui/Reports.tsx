import { useMemo, useState } from 'react';
import { saveFile } from '../core/files';
import { buildReport, reportCsv, reportHtml } from '../core/report';
import { useStore } from '../core/store';
import { Icon } from './common';

const DAY = 86_400_000;
const RANGES = [
  { id: '7', label: 'Last 7 days', days: 7 },
  { id: '30', label: 'Last 30 days', days: 30 },
  { id: '90', label: 'Last 90 days', days: 90 },
  { id: '365', label: 'Last 12 months', days: 365 },
  { id: 'month', label: 'This month', days: 0 },
];

export function Reports() {
  const { data, settings } = useStore();
  const [range, setRange] = useState('30');
  const [from, to] = useMemo(() => {
    const end = new Date(); end.setHours(24, 0, 0, 0);
    if (range === 'month') { const s = new Date(); s.setDate(1); s.setHours(0, 0, 0, 0); return [s.getTime(), end.getTime()]; }
    const days = RANGES.find((r) => r.id === range)!.days;
    return [end.getTime() - days * DAY, end.getTime()];
  }, [range]);
  const r = useMemo(() => buildReport(data, from, to), [data, from, to]);
  const money = (n: number) => settings.currency + Math.round(n).toLocaleString();
  const pct = (n: number) => (n * 100).toFixed(1) + '%';
  const max = Math.max(1, ...r.weekly.map((w) => w.leads));
  const day = new Date(from).toISOString().slice(0, 10);

  return (
    <>
      <div className="head">
        <div className="grow"><h1>Reports</h1><p>What your marketing produced and what it brought in. Download it for your records or your accountant.</p></div>
        <select value={range} onChange={(e) => setRange(e.target.value)} aria-label="Period" data-testid="report-range">
          {RANGES.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
        </select>
        <button className="btn" onClick={() => saveFile(new Blob([reportCsv(r, settings)], { type: 'text/csv' }), `marketing-report-${day}.csv`)} data-testid="report-csv"><Icon name="download" /> Spreadsheet</button>
        <button className="btn primary" onClick={() => saveFile(new Blob([reportHtml(r, settings)], { type: 'text/html' }), `marketing-report-${day}.html`)}><Icon name="download" /> Printable report</button>
      </div>
      <div className="grid g4" style={{ marginBottom: 14 }}>
        <div className="card kpi"><b data-testid="report-leads">{r.leads.total}</b><span>new leads</span></div>
        <div className="card kpi"><b>{r.leads.withPhone} / {r.leads.withEmail}</b><span>with phone / email</span></div>
        <div className="card kpi"><b>{r.leads.consented}</b><span>agreed to be contacted</span></div>
        <div className="card kpi"><b>{r.leads.won + r.leads.lost ? pct(r.leads.winRate) : 'n/a'}</b><span>win rate</span></div>
        <div className="card kpi"><b>{money(r.leads.wonValue)}</b><span>won value</span></div>
        <div className="card kpi"><b>{money(r.totals.spend)}</b><span>ad spend</span></div>
        <div className="card kpi"><b>{r.totals.spend ? r.totals.roas.toFixed(1) + '×' : 'n/a'}</b><span>return on spend</span></div>
        <div className="card kpi"><b>{r.content.videosCreated + r.content.imagesCreated}</b><span>videos + images made</span></div>
      </div>
      <div className="grid g2">
        <div className="card" style={{ gridColumn: '1 / -1' }}>
          <h2>Leads per week</h2>
          <div className="row" style={{ alignItems: 'flex-end', height: 150, gap: 4 }} role="img" aria-label="Leads per week chart">
            {r.weekly.slice(-26).map((w) => (
              <div key={w.week} title={`${new Date(w.week).toLocaleDateString()}: ${w.leads} leads, ${w.won} won`} style={{ flex: 1, height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', alignItems: 'center', minWidth: 6 }}>
                <div style={{ width: '70%', height: `${(w.leads / max) * 100}%`, minHeight: 2, background: 'var(--brand, #6d28d9)', borderRadius: '4px 4px 0 0' }} />
              </div>
            ))}
          </div>
        </div>
        <Table title="Where leads came from" head={['Source', 'Leads', 'Won']} rows={r.bySource.map((x) => [x.source, x.leads, x.won])} />
        <Table title="Products" head={['Product', 'Leads', 'Won', 'Value', 'Videos', 'Images']} rows={r.byProduct.map((x) => [x.product, x.leads, x.won, money(x.value), x.videos, x.images])} />
        <Table title="Posted to social media" head={['Platform', 'Posted', 'Failed']} rows={r.posted.map((x) => [x.target, x.posted, x.failed])} />
        <Table title="Lead stages" head={['Stage', 'Leads']} rows={Object.entries(r.byStage).map(([k, v]) => [k, v])} />
        <div style={{ gridColumn: '1 / -1' }}>
          <Table title="Campaigns" head={['Campaign', 'Spend', 'Revenue', 'Click rate', 'Leads', 'Cost per lead', 'Return']} rows={r.campaigns.map((c) => [c.name, money(c.spend), money(c.revenue), pct(c.ctr), c.leads, c.leads ? money(c.cpl) : 'n/a', c.spend ? c.roas.toFixed(1) + '×' : 'n/a'])} />
        </div>
      </div>
    </>
  );
}

function Table({ title, head, rows }: { title: string; head: string[]; rows: (string | number)[][] }) {
  return (
    <div className="card">
      <h2>{title}</h2>
      {rows.length === 0 ? <p className="muted">Nothing in this period.</p> : (
        <div className="table-wrap">
          <table>
            <thead><tr>{head.map((h) => <th key={h}>{h}</th>)}</tr></thead>
            <tbody>{rows.map((row, i) => <tr key={i}>{row.map((c, j) => <td key={j} style={{ textTransform: j === 0 ? 'capitalize' : undefined }}>{typeof c === 'number' ? c.toLocaleString() : c}</td>)}</tr>)}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}
