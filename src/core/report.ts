/**
 * Marketing report for a date range: leads, conversions, content produced and posted,
 * campaign results and their return. Built from the vault's own records, so it works offline.
 */
import type { Data } from './store';
import { TARGET_INFO, type LeadStage, type Settings, type SocialTarget } from './types';

export interface Report {
  from: number;
  to: number;
  leads: { total: number; withPhone: number; withEmail: number; consented: number; won: number; lost: number; winRate: number; wonValue: number };
  byStage: Record<LeadStage, number>;
  bySource: { source: string; leads: number; won: number }[];
  byProduct: { product: string; leads: number; won: number; value: number; videos: number; images: number }[];
  content: { videosCreated: number; videosApproved: number; imagesCreated: number; posts: number; messagesSent: number };
  posted: { target: string; posted: number; failed: number }[];
  campaigns: { name: string; spend: number; revenue: number; impressions: number; clicks: number; leads: number; sales: number; ctr: number; cpl: number; roas: number }[];
  totals: { spend: number; revenue: number; roas: number; cpl: number };
  weekly: { week: number; leads: number; won: number }[];
}

const DAY = 86_400_000;
const STAGES: LeadStage[] = ['new', 'contacted', 'qualified', 'won', 'lost'];
const inRange = (t: number | undefined, from: number, to: number) => t !== undefined && t >= from && t < to;
const ratio = (a: number, b: number) => (b > 0 ? a / b : 0);

/** Monday 00:00 of the week containing `t`, in local time. */
export function weekStart(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

export function buildReport(data: Data, from: number, to: number): Report {
  const name = (id?: string) => data.products.find((p) => p.id === id)?.name ?? 'No product';
  const leads = data.leads.filter((l) => inRange(l.createdAt, from, to));
  const won = leads.filter((l) => l.stage === 'won');
  const lost = leads.filter((l) => l.stage === 'lost');

  const byStage = Object.fromEntries(STAGES.map((s) => [s, leads.filter((l) => l.stage === s).length])) as Record<LeadStage, number>;
  const src = new Map<string, { leads: number; won: number }>();
  for (const l of leads) {
    const k = (l.source || 'unknown').trim().toLowerCase() || 'unknown';
    const e = src.get(k) ?? { leads: 0, won: 0 };
    e.leads++; if (l.stage === 'won') e.won++;
    src.set(k, e);
  }
  const bySource = [...src].map(([source, v]) => ({ source, ...v })).sort((a, b) => b.leads - a.leads);

  const videos = data.videos.filter((v) => inRange(v.createdAt, from, to));
  const images = (data.images ?? []).filter((c) => inRange(c.createdAt, from, to));
  const prodIds = new Set([...leads.map((l) => l.productId ?? ''), ...videos.map((v) => v.productId), ...images.map((c) => c.productId)]);
  const byProduct = [...prodIds].map((id) => {
    const mine = leads.filter((l) => (l.productId ?? '') === id);
    const w = mine.filter((l) => l.stage === 'won');
    return { product: id ? name(id) : 'No product', leads: mine.length, won: w.length, value: w.reduce((a, l) => a + (l.value || 0), 0), videos: videos.filter((v) => v.productId === id).length, images: images.filter((c) => c.productId === id).length };
  }).sort((a, b) => b.leads - a.leads || b.videos - a.videos);

  const pubs = data.publications.filter((p) => inRange(p.postedAt ?? p.triedAt ?? p.createdAt, from, to));
  const posted = (Object.keys(TARGET_INFO) as SocialTarget[])
    .map((t) => ({ target: TARGET_INFO[t].label, posted: pubs.filter((p) => p.target === t && p.status === 'posted').length, failed: pubs.filter((p) => p.target === t && p.status === 'failed').length }))
    .filter((r) => r.posted + r.failed > 0);

  // A campaign counts when it ran at any time inside the range.
  const camps = data.campaigns.filter((c) => c.start < to && c.end >= from);
  const campaigns = camps.map((c) => {
    const m = c.metrics;
    return { name: c.name, spend: m.spend, revenue: m.revenue, impressions: m.impressions, clicks: m.clicks, leads: m.leads, sales: m.sales, ctr: ratio(m.clicks, m.impressions), cpl: ratio(m.spend, m.leads), roas: ratio(m.revenue, m.spend) };
  });
  const spend = campaigns.reduce((a, c) => a + c.spend, 0);
  const revenue = campaigns.reduce((a, c) => a + c.revenue, 0);
  const campLeads = campaigns.reduce((a, c) => a + c.leads, 0);

  const weekly: Report['weekly'] = [];
  for (let w = weekStart(from); w < to; w += 7 * DAY) {
    const end = w + 7 * DAY;
    const wk = leads.filter((l) => l.createdAt >= w && l.createdAt < end);
    weekly.push({ week: w, leads: wk.length, won: wk.filter((l) => l.stage === 'won').length });
    if (weekly.length > 60) break;
  }

  return {
    from, to,
    leads: {
      total: leads.length,
      withPhone: leads.filter((l) => l.phone.trim()).length,
      withEmail: leads.filter((l) => l.email.trim()).length,
      consented: leads.filter((l) => l.consent).length,
      won: won.length, lost: lost.length,
      winRate: ratio(won.length, won.length + lost.length),
      wonValue: won.reduce((a, l) => a + (l.value || 0), 0),
    },
    byStage, bySource, byProduct,
    content: {
      videosCreated: videos.length,
      videosApproved: data.videos.filter((v) => v.status === 'approved' && inRange(v.decidedAt ?? v.createdAt, from, to)).length,
      imagesCreated: images.length,
      posts: data.posts.filter((p) => inRange(p.scheduledFor, from, to) && p.status !== 'rejected').length,
      messagesSent: data.messages.filter((m) => m.status === 'sent' && inRange(m.decidedAt ?? m.createdAt, from, to)).length,
    },
    posted, campaigns,
    totals: { spend, revenue, roas: ratio(revenue, spend), cpl: ratio(spend, campLeads) },
    weekly,
  };
}

const csvCell = (v: unknown) => {
  const s = String(v ?? '');
  // Cells starting with = + - @ would run as formulas in spreadsheet apps.
  const safe = /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
const csv = (rows: unknown[][]) => rows.map((r) => r.map(csvCell).join(',')).join('\n');
const day = (t: number) => new Date(t).toISOString().slice(0, 10);

export function reportCsv(r: Report, s: Settings): string {
  const money = (n: number) => Math.round(n);
  return [
    csv([[`Marketing report ${s.business.name}`.trim(), `${day(r.from)} to ${day(r.to - 1)}`]]),
    '',
    csv([['Leads', 'With phone', 'With email', 'Agreed to contact', 'Won', 'Lost', 'Win rate %', `Won value (${s.currency})`], [r.leads.total, r.leads.withPhone, r.leads.withEmail, r.leads.consented, r.leads.won, r.leads.lost, Math.round(r.leads.winRate * 100), money(r.leads.wonValue)]]),
    '',
    csv([['Source', 'Leads', 'Won'], ...r.bySource.map((x) => [x.source, x.leads, x.won])]),
    '',
    csv([['Product', 'Leads', 'Won', 'Won value', 'Videos', 'Images'], ...r.byProduct.map((x) => [x.product, x.leads, x.won, money(x.value), x.videos, x.images])]),
    '',
    csv([['Platform', 'Posted', 'Failed'], ...r.posted.map((x) => [x.target, x.posted, x.failed])]),
    '',
    csv([['Campaign', 'Spend', 'Revenue', 'Views', 'Clicks', 'Click rate %', 'Leads', 'Sales', 'Cost per lead', 'Return on spend'], ...r.campaigns.map((c) => [c.name, money(c.spend), money(c.revenue), c.impressions, c.clicks, (c.ctr * 100).toFixed(1), c.leads, c.sales, money(c.cpl), c.roas.toFixed(2)])]),
    '',
    csv([['Week starting', 'Leads', 'Won'], ...r.weekly.map((w) => [day(w.week), w.leads, w.won])]),
  ].join('\n');
}

const h = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** A printable report page (open it and choose Print → Save as PDF). */
export function reportHtml(r: Report, s: Settings): string {
  const money = (n: number) => h(s.currency) + Math.round(n).toLocaleString();
  const pct = (n: number) => (n * 100).toFixed(1) + '%';
  const table = (head: string[], rows: (string | number)[][]) => rows.length
    ? `<table><tr>${head.map((x) => `<th>${h(x)}</th>`).join('')}</tr>${rows.map((row) => `<tr>${row.map((c) => `<td>${typeof c === 'number' ? c.toLocaleString() : h(c)}</td>`).join('')}</tr>`).join('')}</table>`
    : '<p class="m">No data in this period.</p>';
  const max = Math.max(1, ...r.weekly.map((w) => w.leads));
  const bars = r.weekly.map((w) => `<div class="b" title="${day(w.week)}: ${w.leads}"><i style="height:${(w.leads / max) * 100}%"></i><small>${new Date(w.week).getDate()}/${new Date(w.week).getMonth() + 1}</small></div>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Marketing report ${h(day(r.from))} – ${h(day(r.to - 1))}</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>body{font-family:system-ui,Segoe UI,Arial,sans-serif;color:#111827;max-width:900px;margin:24px auto;padding:0 16px}h1{margin:0}h2{margin:28px 0 8px;font-size:1.1rem}
.m{color:#6b7280}.k{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}.k div{border:1px solid #e5e7eb;border-radius:10px;padding:12px}.k b{display:block;font-size:1.4rem}
table{border-collapse:collapse;width:100%;font-size:.9rem}th,td{border-bottom:1px solid #e5e7eb;padding:6px 8px;text-align:left}th{background:#f3f4f6}
.c{display:flex;gap:4px;align-items:flex-end;height:140px;border-bottom:1px solid #e5e7eb}.b{flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;height:100%}.b i{display:block;width:70%;background:#6d28d9;border-radius:4px 4px 0 0;min-height:1px}.b small{font-size:.65rem;color:#6b7280}
@media print{body{margin:0}}</style></head><body>
<h1>Marketing report${s.business.name ? ' – ' + h(s.business.name) : ''}</h1>
<p class="m">${h(day(r.from))} to ${h(day(r.to - 1))} · created ${h(new Date().toLocaleString())}</p>
<div class="k"><div><b>${r.leads.total}</b>new leads</div><div><b>${r.leads.won}</b>won</div><div><b>${pct(r.leads.winRate)}</b>win rate</div><div><b>${money(r.leads.wonValue)}</b>won value</div>
<div><b>${money(r.totals.spend)}</b>ad spend</div><div><b>${r.totals.roas ? r.totals.roas.toFixed(1) + '×' : '–'}</b>return on spend</div><div><b>${r.content.videosCreated}</b>videos made</div><div><b>${r.content.imagesCreated}</b>images made</div></div>
<h2>Leads per week</h2><div class="c">${bars}</div>
<h2>Where leads came from</h2>${table(['Source', 'Leads', 'Won'], r.bySource.map((x) => [x.source, x.leads, x.won]))}
<h2>Products</h2>${table(['Product', 'Leads', 'Won', 'Won value', 'Videos', 'Images'], r.byProduct.map((x) => [x.product, x.leads, x.won, money(x.value), x.videos, x.images]))}
<h2>Posted to social media</h2>${table(['Platform', 'Posted', 'Failed'], r.posted.map((x) => [x.target, x.posted, x.failed]))}
<h2>Campaigns</h2>${table(['Campaign', 'Spend', 'Revenue', 'Click rate', 'Leads', 'Cost per lead', 'Return'], r.campaigns.map((c) => [c.name, money(c.spend), money(c.revenue), pct(c.ctr), c.leads, c.leads ? money(c.cpl) : '–', c.spend ? c.roas.toFixed(1) + '×' : '–']))}
<h2>Content</h2>${table(['Videos created', 'Videos approved', 'Images created', 'Scheduled posts', 'Messages sent'], [[r.content.videosCreated, r.content.videosApproved, r.content.imagesCreated, r.content.posts, r.content.messagesSent]])}
</body></html>`;
}
