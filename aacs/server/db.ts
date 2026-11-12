// Storage layer: one SQLite file (node:sqlite, no native dependency).
// Every row carries org_id; all queries in the API filter on it (tenant isolation).
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

export const DATA_DIR = process.env.AACS_DATA_DIR || path.resolve(process.cwd(), 'data');
mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(process.env.AACS_DB || path.join(DATA_DIR, 'aacs.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS orgs (id TEXT PRIMARY KEY, name TEXT NOT NULL, region TEXT NOT NULL DEFAULT 'in', settings TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, pw_hash TEXT NOT NULL,
  role TEXT NOT NULL, team TEXT NOT NULL DEFAULT '', department TEXT NOT NULL DEFAULT '', mfa_secret TEXT, mfa_enabled INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS resources (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, project_id TEXT, kind TEXT NOT NULL, name TEXT NOT NULL, data TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'draft', created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS resources_org_kind ON resources(org_id, kind);
CREATE TABLE IF NOT EXISTS versions (id TEXT PRIMARY KEY, resource_id TEXT NOT NULL, version INTEGER NOT NULL, name TEXT NOT NULL, data TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
  created_by TEXT, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS versions_res ON versions(resource_id, version);
CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, table_id TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS records_table ON records(table_id);
CREATE TABLE IF NOT EXISTS chunks (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, kb_id TEXT NOT NULL, doc_id TEXT NOT NULL, doc_name TEXT NOT NULL, seq INTEGER NOT NULL, text TEXT NOT NULL, vec TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS chunks_kb ON chunks(kb_id);
CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, kind TEXT NOT NULL, resource_id TEXT, resource_name TEXT NOT NULL DEFAULT '', status TEXT NOT NULL,
  input TEXT NOT NULL DEFAULT '{}', output TEXT NOT NULL DEFAULT 'null', steps TEXT NOT NULL DEFAULT '[]', state TEXT NOT NULL DEFAULT '{}',
  tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0, cost REAL NOT NULL DEFAULT 0, latency_ms INTEGER NOT NULL DEFAULT 0,
  user_id TEXT, started_at TEXT NOT NULL, finished_at TEXT);
CREATE INDEX IF NOT EXISTS runs_org ON runs(org_id, started_at);
CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, run_id TEXT, kind TEXT NOT NULL DEFAULT 'run', title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending', requested_by TEXT, requested_at TEXT NOT NULL, decided_by TEXT, decided_at TEXT, comment TEXT);
CREATE TABLE IF NOT EXISTS usage (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, model TEXT NOT NULL, provider TEXT NOT NULL, source TEXT NOT NULL DEFAULT '',
  tokens_in INTEGER NOT NULL, tokens_out INTEGER NOT NULL, cost REAL NOT NULL, latency_ms INTEGER NOT NULL, ok INTEGER NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS usage_org ON usage(org_id, created_at);
CREATE TABLE IF NOT EXISTS audit (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, user_id TEXT, user_email TEXT NOT NULL DEFAULT '', action TEXT NOT NULL, target TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '', ip TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS audit_org ON audit(org_id, created_at);
CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, channel TEXT NOT NULL, recipient TEXT NOT NULL DEFAULT '', subject TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'queued', read INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS secrets (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT NOT NULL, value_enc TEXT NOT NULL, created_by TEXT, created_at TEXT NOT NULL, UNIQUE(org_id, name));
CREATE TABLE IF NOT EXISTS deployments (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, resource_id TEXT NOT NULL, resource_name TEXT NOT NULL, kind TEXT NOT NULL, version INTEGER NOT NULL, env TEXT NOT NULL,
  status TEXT NOT NULL, stages TEXT NOT NULL DEFAULT '[]', snapshot TEXT NOT NULL DEFAULT '{}', created_by TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS memory (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, agent_id TEXT NOT NULL, session_id TEXT NOT NULL, kind TEXT NOT NULL, role TEXT NOT NULL DEFAULT '', content TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS memory_agent ON memory(agent_id, session_id);
`);

export type Row = Record<string, any>;
export const uid = (prefix = '') => prefix + randomBytes(9).toString('base64url');
export const now = () => new Date().toISOString();
export const all = (sql: string, ...p: any[]): Row[] => db.prepare(sql).all(...p) as Row[];
export const get = (sql: string, ...p: any[]): Row | undefined => db.prepare(sql).get(...p) as Row | undefined;
export const run = (sql: string, ...p: any[]) => db.prepare(sql).run(...p);
export const parse = (s: unknown, fallback: any = null) => {
  try { return typeof s === 'string' ? JSON.parse(s) : fallback; } catch { return fallback; }
};

export interface Resource { id: string; org_id: string; project_id: string | null; kind: string; name: string; data: any; version: number; status: string; created_by: string | null; created_at: string; updated_at: string }

export function toResource(r: Row | undefined): Resource | undefined {
  return r ? ({ ...r, data: parse(r.data, {}) } as Resource) : undefined;
}
export function getResource(orgId: string, id: string, kind?: string): Resource | undefined {
  const r = toResource(get('SELECT * FROM resources WHERE id = ? AND org_id = ?', id, orgId));
  return r && (!kind || r.kind === kind) ? r : undefined;
}
export function listResources(orgId: string, kind: string, projectId?: string): Resource[] {
  const rows = projectId
    ? all('SELECT * FROM resources WHERE org_id = ? AND kind = ? AND (project_id = ? OR project_id IS NULL) ORDER BY updated_at DESC', orgId, kind, projectId)
    : all('SELECT * FROM resources WHERE org_id = ? AND kind = ? ORDER BY updated_at DESC', orgId, kind);
  return rows.map((r) => toResource(r)!);
}
export function createResource(orgId: string, userId: string | null, kind: string, name: string, data: any, projectId: string | null = null, status = 'draft'): Resource {
  const id = uid(kind.slice(0, 3) + '_');
  const t = now();
  run('INSERT INTO resources (id, org_id, project_id, kind, name, data, version, status, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,1,?,?,?,?)',
    id, orgId, projectId, kind, name, JSON.stringify(data ?? {}), status, userId, t, t);
  run('INSERT INTO versions (id, resource_id, version, name, data, note, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)', uid('v_'), id, 1, name, JSON.stringify(data ?? {}), 'Created', userId, t);
  return getResource(orgId, id)!;
}
export function updateResource(orgId: string, userId: string | null, id: string, patch: { name?: string; data?: any; status?: string; note?: string }): Resource | undefined {
  const cur = getResource(orgId, id);
  if (!cur) return undefined;
  const name = patch.name ?? cur.name;
  const data = patch.data ?? cur.data;
  const changed = name !== cur.name || JSON.stringify(data) !== JSON.stringify(cur.data);
  const version = changed ? cur.version + 1 : cur.version;
  const t = now();
  run('UPDATE resources SET name = ?, data = ?, status = ?, version = ?, updated_at = ? WHERE id = ?', name, JSON.stringify(data), patch.status ?? cur.status, version, t, id);
  if (changed) run('INSERT INTO versions (id, resource_id, version, name, data, note, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)', uid('v_'), id, version, name, JSON.stringify(data), patch.note ?? '', userId, t);
  return getResource(orgId, id);
}

export function audit(orgId: string, user: { id?: string; email?: string } | null, action: string, target = '', detail = '', ip = '') {
  run('INSERT INTO audit (id, org_id, user_id, user_email, action, target, detail, ip, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    uid('a_'), orgId, user?.id ?? null, user?.email ?? 'system', action, target, detail.slice(0, 2000), ip, now());
}
export function notify(orgId: string, channel: string, recipient: string, subject: string, body: string, status = 'queued') {
  const id = uid('n_');
  run('INSERT INTO notifications (id, org_id, channel, recipient, subject, body, status, created_at) VALUES (?,?,?,?,?,?,?,?)', id, orgId, channel, recipient, subject.slice(0, 500), body.slice(0, 20000), status, now());
  return id;
}
export function orgSettings(orgId: string): Row {
  return { firewall: 'block', maskInput: true, maskOutput: true, moderation: true, retentionDays: 365, routing: 'priority', ...parse(get('SELECT settings FROM orgs WHERE id = ?', orgId)?.settings, {}) };
}
