// Database layer of the app builder: user-defined tables (metadata) and their records.
import { all, db, get, getResource, listResources, now, parse, run, uid, type Resource } from './db.ts';

export interface Column { name: string; label?: string; type: 'text' | 'number' | 'boolean' | 'date' | 'choice' | 'relation' | 'longtext'; required?: boolean; unique?: boolean; indexed?: boolean; options?: string[]; relationTableId?: string }
const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,40}$/;

export function validateTable(data: any) {
  const cols: Column[] = Array.isArray(data?.columns) ? data.columns : [];
  const seen = new Set<string>();
  for (const c of cols) {
    if (!IDENT.test(c.name)) throw new Error(`Column name "${c.name}" must start with a letter and use only letters, digits and _`);
    if (seen.has(c.name)) throw new Error(`Duplicate column "${c.name}"`);
    seen.add(c.name);
  }
}
/** Real SQLite expression indexes for columns flagged "indexed". */
export function syncIndexes(table: Resource) {
  const safeId = table.id.replace(/[^A-Za-z0-9_]/g, '_');
  const want = new Set<string>();
  for (const c of (table.data.columns ?? []) as Column[]) {
    if (!(c.indexed || c.unique) || !IDENT.test(c.name)) continue;
    const name = `ix_${safeId}_${c.name}`;
    want.add(name);
    db.exec(`CREATE INDEX IF NOT EXISTS "${name}" ON records(json_extract(data, '$.${c.name}')) WHERE table_id = '${table.id.replace(/'/g, '')}'`);
  }
  for (const r of all("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE ?", `ix_${safeId}_%`)) if (!want.has(r.name)) db.exec(`DROP INDEX IF EXISTS "${r.name}"`);
}

function coerce(orgId: string, table: Resource, input: any, selfId?: string): Record<string, any> {
  const out: Record<string, any> = {};
  for (const c of (table.data.columns ?? []) as Column[]) {
    let v = input?.[c.name];
    if (v === undefined || v === null || v === '') {
      if (c.required) throw new Error(`"${c.label || c.name}" is required`);
      continue;
    }
    if (c.type === 'number') { v = Number(v); if (!Number.isFinite(v)) throw new Error(`"${c.label || c.name}" must be a number`); }
    else if (c.type === 'boolean') v = v === true || v === 'true' || v === 1 || v === '1' || v === 'on';
    else if (c.type === 'date') { if (Number.isNaN(Date.parse(v))) throw new Error(`"${c.label || c.name}" must be a date`); v = String(v); }
    else if (c.type === 'choice') { v = String(v); if (c.options?.length && !c.options.includes(v)) throw new Error(`"${c.label || c.name}" must be one of: ${c.options.join(', ')}`); }
    else if (c.type === 'relation') { v = String(v); if (!c.relationTableId || !get('SELECT 1 FROM records WHERE id = ? AND table_id = ? AND org_id = ?', v, c.relationTableId, orgId)) throw new Error(`"${c.label || c.name}" refers to a record that does not exist`); }
    else v = String(v).slice(0, 20000);
    if (c.unique) {
      const dup = get(`SELECT id FROM records WHERE table_id = ? AND json_extract(data, '$.${c.name}') = ?`, table.id, v);
      if (dup && dup.id !== selfId) throw new Error(`"${c.label || c.name}" must be unique`);
    }
    out[c.name] = v;
  }
  return out;
}

export const recordListeners: ((orgId: string, table: Resource, record: Record<string, any>) => void)[] = [];

export function findTable(orgId: string, idOrName: string): Resource | undefined {
  return getResource(orgId, idOrName, 'table') ?? listResources(orgId, 'table').find((t) => t.name.toLowerCase() === String(idOrName).toLowerCase());
}
export function insertRecord(orgId: string, tableId: string, input: any) {
  const table = findTable(orgId, tableId);
  if (!table) throw new Error('Table not found');
  const data = coerce(orgId, table, input);
  const id = uid('rec_');
  const t = now();
  run('INSERT INTO records (id, org_id, table_id, data, created_at, updated_at) VALUES (?,?,?,?,?,?)', id, orgId, table.id, JSON.stringify(data), t, t);
  const rec = { id, ...data, created_at: t };
  for (const l of recordListeners) { try { l(orgId, table, rec); } catch { /* a failing trigger must not fail the insert */ } }
  return rec;
}
export function updateRecord(orgId: string, tableId: string, id: string, input: any) {
  const table = findTable(orgId, tableId);
  const cur = table && get('SELECT * FROM records WHERE id = ? AND table_id = ? AND org_id = ?', id, table.id, orgId);
  if (!table || !cur) throw new Error('Record not found');
  const data = coerce(orgId, table, { ...parse(cur.data, {}), ...input }, id);
  run('UPDATE records SET data = ?, updated_at = ? WHERE id = ?', JSON.stringify(data), now(), id);
  return { id, ...data };
}
export function queryRecords(orgId: string, tableId: string, opts: { field?: string; value?: any; limit?: number } = {}) {
  const table = findTable(orgId, tableId);
  if (!table) throw new Error('Table not found');
  let rows = all('SELECT * FROM records WHERE table_id = ? AND org_id = ? ORDER BY created_at DESC LIMIT 2000', table.id, orgId)
    .map((r) => ({ id: r.id, ...parse(r.data, {}), created_at: r.created_at }));
  if (opts.field) rows = rows.filter((r: any) => String(r[opts.field!] ?? '').toLowerCase() === String(opts.value ?? '').toLowerCase());
  return rows.slice(0, opts.limit ?? 500);
}
