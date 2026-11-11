import type { Lead } from './types';
import { uid } from './types';

const DAY = 86_400_000;

/** 0–100 priority score: how complete, how warm and how recent a lead is. */
export function scoreLead(l: Lead, now = Date.now()): number {
  if (l.stage === 'won') return 100;
  if (l.stage === 'lost') return 0;
  let s = 15;
  if (l.phone.trim()) s += 20;
  if (l.email.trim()) s += 12;
  if (l.productId) s += 10;
  if (l.consent) s += 8;
  if (l.value > 0) s += 8;
  if (/referr|walk|repeat|existing/i.test(l.source)) s += 12;
  if (l.stage === 'contacted') s += 8;
  if (l.stage === 'qualified') s += 22;
  const age = now - (l.lastContactAt ?? l.createdAt);
  if (age < 3 * DAY) s += 10;
  else if (age > 30 * DAY) s -= 15;
  return Math.max(1, Math.min(99, Math.round(s)));
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',' || c === ';' || c === '\t') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}

export function leadsFromCsv(text: string, now = Date.now()): Lead[] {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const col = (re: RegExp) => head.findIndex((h) => re.test(h));
  const iName = col(/name/), iPhone = col(/phone|mobile|whats|contact/), iEmail = col(/mail/);
  const iSource = col(/source|channel/), iNotes = col(/note|comment|remark/), iValue = col(/value|amount|budget/);
  const get = (r: string[], i: number) => (i >= 0 ? (r[i] ?? '').trim() : '');
  return rows
    .slice(1)
    .map((r): Lead => ({
      id: uid(),
      name: get(r, iName),
      phone: get(r, iPhone),
      email: get(r, iEmail),
      source: get(r, iSource) || 'import',
      notes: get(r, iNotes),
      value: Number(get(r, iValue).replace(/[^\d.]/g, '')) || 0,
      stage: 'new',
      score: 0,
      // Imported contacts are not messaged until the owner confirms they agreed to be contacted.
      consent: false,
      createdAt: now,
    }))
    .filter((l) => l.name || l.phone || l.email);
}

/** Cells starting with = + - @ are prefixed so spreadsheets do not run them as formulas. */
const safeCell = (v: unknown) => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function leadsToCsv(leads: Lead[], productName: (id?: string) => string): string {
  const head = ['Name', 'Phone', 'Email', 'Source', 'Product', 'Stage', 'Score', 'Value', 'Consent', 'Created', 'Notes'];
  const lines = leads.map((l) =>
    [l.name, l.phone, l.email, l.source, productName(l.productId), l.stage, l.score, l.value, l.consent ? 'yes' : 'no', new Date(l.createdAt).toISOString().slice(0, 10), l.notes]
      .map(safeCell)
      .join(','),
  );
  return '﻿' + [head.join(','), ...lines].join('\r\n');
}
