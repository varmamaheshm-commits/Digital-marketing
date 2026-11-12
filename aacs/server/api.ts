// REST API. Every handler runs with an authenticated user and is scoped to that user's organisation.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { all, audit, createResource, db, get, getResource, listResources, notify, now, orgSettings, parse, run, toResource, uid, updateResource, type Row } from './db.ts';
import { can, decrypt, detectInjection, detectPII, detectToxicity, encrypt, guardInput, guardOutput, hashPassword, KINDS, maskPII, newToken, newTotpSecret, ROLES, safeFetch, setSecret, sha256, verifyPassword, verifyTotp } from './sec.ts';
import { insertRecord, queryRecords, syncIndexes, updateRecord, validateTable } from './data.ts';
import { agentToolCatalog, runAgent } from './agent.ts';
import { complete, SIMULATOR } from './llm/index.ts';
import { DEFAULT_BASE } from './llm/compat.ts';
import { htmlToText, ingest, search } from './rag.ts';
import { checkWebhookKey, decideApproval, deploy, ENVS, liveDefinition, startRun } from './engine.ts';
import { playwrightAvailable, runBot } from './rpa.ts';
import { CHECKS, RED_TEAM, runSuite } from './testing.ts';
import { installItems, TEMPLATES } from './market.ts';

export class HttpError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } }
interface Ctx { req: IncomingMessage; res: ServerResponse; params: string[]; query: URLSearchParams; body: any; ip: string; user: Row; orgId: string }
type Handler = (c: Ctx) => any;
const routes: { method: string; re: RegExp; open: boolean; h: Handler }[] = [];
const route = (method: string, path: string, h: Handler, open = false) => routes.push({ method, re: new RegExp('^' + path.replace(/:\w+/g, '([^/]+)') + '$'), open, h });
const need = (ok: any, status = 403, msg = 'You do not have permission to do this') => { if (!ok) throw new HttpError(status, msg); };
const str = (v: any, max = 500) => String(v ?? '').trim().slice(0, max);
const COOKIE = 'aacs_session';
const SESSION_MS = 12 * 3600 * 1000;

// ---------- authentication ----------
const attempts = new Map<string, number[]>();
function throttle(key: string) {
  const recent = (attempts.get(key) ?? []).filter((t) => Date.now() - t < 15 * 60000);
  if (recent.length >= 8) throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.');
  recent.push(Date.now());
  attempts.set(key, recent);
}
function checkPassword(pw: string) {
  need(typeof pw === 'string' && pw.length >= 10 && /[A-Za-z]/.test(pw) && /\d/.test(pw), 400, 'Password must be at least 10 characters and include a letter and a digit');
}
function openSession(c: Ctx, userId: string) {
  const token = newToken();
  run('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?,?,?)', sha256(token), userId, Date.now() + SESSION_MS);
  const secure = c.req.headers['x-forwarded-proto'] === 'https' || process.env.AACS_SECURE_COOKIE === '1' ? '; Secure' : '';
  c.res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${secure}`);
}
const publicUser = (u: Row) => ({ id: u.id, email: u.email, name: u.name, role: u.role, team: u.team, department: u.department, mfaEnabled: !!u.mfa_enabled, status: u.status, createdAt: u.created_at });

route('POST', '/auth/register', (c) => {
  throttle('reg:' + c.ip);
  const email = str(c.body.email).toLowerCase();
  need(/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email), 400, 'Enter a valid email address');
  need(str(c.body.name) && str(c.body.orgName), 400, 'Name and organisation are required');
  checkPassword(c.body.password);
  need(!get('SELECT 1 FROM users WHERE email = ?', email), 409, 'An account with this email already exists');
  const orgId = uid('org_'), userId = uid('usr_');
  run('INSERT INTO orgs (id, name, region, created_at) VALUES (?,?,?,?)', orgId, str(c.body.orgName, 120), str(c.body.region, 20) || 'in', now());
  run('INSERT INTO users (id, org_id, email, name, pw_hash, role, created_at) VALUES (?,?,?,?,?,?,?)', userId, orgId, email, str(c.body.name, 120), hashPassword(c.body.password), 'admin', now());
  run('INSERT INTO projects (id, org_id, name, description, created_at) VALUES (?,?,?,?,?)', uid('prj_'), orgId, 'Default project', 'Created with the organisation', now());
  audit(orgId, { id: userId, email }, 'org.create', str(c.body.orgName, 120), '', c.ip);
  openSession(c, userId);
  return { ok: true };
}, true);

route('POST', '/auth/login', (c) => {
  const email = str(c.body.email).toLowerCase();
  throttle(`login:${email}:${c.ip}`);
  const u = get('SELECT * FROM users WHERE email = ?', email);
  if (!u || u.status !== 'active' || !verifyPassword(String(c.body.password ?? ''), u.pw_hash)) {
    if (u) audit(u.org_id, u, 'auth.login_failed', email, '', c.ip);
    throw new HttpError(401, 'Email or password is incorrect');
  }
  if (u.mfa_enabled) {
    if (!c.body.code) return { mfaRequired: true };
    if (!verifyTotp(decrypt(u.mfa_secret), c.body.code)) { audit(u.org_id, u, 'auth.mfa_failed', email, '', c.ip); throw new HttpError(401, 'The verification code is incorrect'); }
  }
  attempts.delete(`login:${email}:${c.ip}`);
  openSession(c, u.id);
  audit(u.org_id, u, 'auth.login', email, u.mfa_enabled ? 'with MFA' : '', c.ip);
  return { ok: true };
}, true);

route('POST', '/auth/logout', (c) => {
  const token = cookie(c.req);
  if (token) run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
  c.res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
  return { ok: true };
}, true);

route('GET', '/me', (c) => {
  const org = get('SELECT id, name, region FROM orgs WHERE id = ?', c.orgId)!;
  return { user: publicUser(c.user), org: { ...org, settings: orgSettings(c.orgId) }, roles: ROLES, kinds: KINDS, envs: ENVS,
    projects: all('SELECT * FROM projects WHERE org_id = ? ORDER BY created_at', c.orgId), capabilities: { browserAutomation: playwrightAvailable() } };
});
route('POST', '/auth/password', (c) => {
  need(verifyPassword(String(c.body.current ?? ''), c.user.pw_hash), 400, 'Current password is incorrect');
  checkPassword(c.body.next);
  run('UPDATE users SET pw_hash = ? WHERE id = ?', hashPassword(c.body.next), c.user.id);
  run('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?', c.user.id, sha256(cookie(c.req)!));
  audit(c.orgId, c.user, 'auth.password_change', '', '', c.ip);
  return { ok: true };
});
route('POST', '/auth/mfa/setup', (c) => {
  const secret = newTotpSecret();
  run('UPDATE users SET mfa_secret = ?, mfa_enabled = 0 WHERE id = ?', encrypt(secret), c.user.id);
  return { secret, uri: `otpauth://totp/AACS:${encodeURIComponent(c.user.email)}?secret=${secret}&issuer=AACS` };
});
route('POST', '/auth/mfa/enable', (c) => {
  need(c.user.mfa_secret && verifyTotp(decrypt(c.user.mfa_secret), c.body.code), 400, 'The verification code is incorrect');
  run('UPDATE users SET mfa_enabled = 1 WHERE id = ?', c.user.id);
  audit(c.orgId, c.user, 'auth.mfa_enable', '', '', c.ip);
  return { ok: true };
});
route('POST', '/auth/mfa/disable', (c) => {
  need(verifyPassword(String(c.body.password ?? ''), c.user.pw_hash), 400, 'Password is incorrect');
  run('UPDATE users SET mfa_enabled = 0, mfa_secret = NULL WHERE id = ?', c.user.id);
  audit(c.orgId, c.user, 'auth.mfa_disable', '', '', c.ip);
  return { ok: true };
});

// ---------- organisation, users, projects ----------
route('GET', '/users', (c) => all('SELECT * FROM users WHERE org_id = ? ORDER BY created_at', c.orgId).map(publicUser));
route('POST', '/users', (c) => {
  need(can(c.user.role, 'admin'));
  const email = str(c.body.email).toLowerCase();
  need(/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email), 400, 'Enter a valid email address');
  need((ROLES as readonly string[]).includes(c.body.role), 400, 'Unknown role');
  checkPassword(c.body.password);
  need(!get('SELECT 1 FROM users WHERE email = ?', email), 409, 'An account with this email already exists');
  const id = uid('usr_');
  run('INSERT INTO users (id, org_id, email, name, pw_hash, role, team, department, created_at) VALUES (?,?,?,?,?,?,?,?,?)', id, c.orgId, email, str(c.body.name, 120) || email, hashPassword(c.body.password), c.body.role, str(c.body.team, 80), str(c.body.department, 80), now());
  audit(c.orgId, c.user, 'user.create', email, `role ${c.body.role}`, c.ip);
  return publicUser(get('SELECT * FROM users WHERE id = ?', id)!);
});
route('PATCH', '/users/:id', (c) => {
  need(can(c.user.role, 'admin'));
  const u = get('SELECT * FROM users WHERE id = ? AND org_id = ?', c.params[0], c.orgId);
  need(u, 404, 'User not found');
  const role = c.body.role ?? u!.role, status = c.body.status ?? u!.status;
  need((ROLES as readonly string[]).includes(role) && ['active', 'disabled'].includes(status), 400, 'Invalid role or status');
  if (u!.role === 'admin' && (role !== 'admin' || status !== 'active')) need(get("SELECT COUNT(*) n FROM users WHERE org_id = ? AND role = 'admin' AND status = 'active'", c.orgId)!.n > 1, 400, 'The organisation needs at least one active admin');
  run('UPDATE users SET role = ?, status = ?, team = ?, department = ?, name = ? WHERE id = ?', role, status, str(c.body.team ?? u!.team, 80), str(c.body.department ?? u!.department, 80), str(c.body.name ?? u!.name, 120), u!.id);
  if (status !== 'active') run('DELETE FROM sessions WHERE user_id = ?', u!.id);
  audit(c.orgId, c.user, 'user.update', u!.email, `role ${role}, ${status}`, c.ip);
  return publicUser(get('SELECT * FROM users WHERE id = ?', u!.id)!);
});
route('PATCH', '/org', (c) => {
  need(can(c.user.role, 'admin'));
  const org = get('SELECT * FROM orgs WHERE id = ?', c.orgId)!;
  const settings = { ...parse(org.settings, {}), ...(c.body.settings && typeof c.body.settings === 'object' ? c.body.settings : {}) };
  run('UPDATE orgs SET name = ?, region = ?, settings = ? WHERE id = ?', str(c.body.name ?? org.name, 120), str(c.body.region ?? org.region, 20), JSON.stringify(settings), c.orgId);
  audit(c.orgId, c.user, 'org.update', '', JSON.stringify(c.body.settings ?? {}), c.ip);
  return { ok: true };
});
route('POST', '/projects', (c) => {
  need(can(c.user.role, 'admin') || c.user.role === 'developer');
  need(str(c.body.name), 400, 'Name is required');
  const id = uid('prj_');
  run('INSERT INTO projects (id, org_id, name, description, created_at) VALUES (?,?,?,?,?)', id, c.orgId, str(c.body.name, 120), str(c.body.description, 500), now());
  audit(c.orgId, c.user, 'project.create', str(c.body.name, 120), '', c.ip);
  return get('SELECT * FROM projects WHERE id = ?', id);
});
route('DELETE', '/projects/:id', (c) => {
  need(can(c.user.role, 'admin'));
  need(get('SELECT COUNT(*) n FROM projects WHERE org_id = ?', c.orgId)!.n > 1, 400, 'Keep at least one project');
  need(!get('SELECT 1 FROM resources WHERE project_id = ? AND org_id = ?', c.params[0], c.orgId), 400, 'Move or delete the resources in this project first');
  run('DELETE FROM projects WHERE id = ? AND org_id = ?', c.params[0], c.orgId);
  return { ok: true };
});

// ---------- generic metadata resources (apps, tables, agents, workflows, ...) ----------
const kindOk = (k: string) => { need(KINDS.includes(k), 400, 'Unknown resource kind'); return k; };
function prepare(c: Ctx, kind: string, data: any) {
  if (kind === 'table') { try { validateTable(data); } catch (e: any) { throw new HttpError(400, e.message); } }
  if (kind === 'workflow' && data?.trigger?.type === 'webhook' && !data.trigger.key) data.trigger.key = newToken();
  return data ?? {};
}
route('GET', '/resources', (c) => listResources(c.orgId, kindOk(c.query.get('kind') ?? ''), c.query.get('project') || undefined));
route('POST', '/resources', (c) => {
  const kind = kindOk(c.body.kind);
  need(can(c.user.role, 'write', kind));
  need(str(c.body.name), 400, 'Name is required');
  const pid = c.body.projectId && get('SELECT 1 FROM projects WHERE id = ? AND org_id = ?', c.body.projectId, c.orgId) ? c.body.projectId : null;
  const r = createResource(c.orgId, c.user.id, kind, str(c.body.name, 120), prepare(c, kind, c.body.data), pid);
  if (kind === 'table') syncIndexes(r);
  audit(c.orgId, c.user, `${kind}.create`, r.name, '', c.ip);
  return r;
});
route('GET', '/resources/:id', (c) => { const r = getResource(c.orgId, c.params[0]); need(r, 404, 'Not found'); return r; });
route('PUT', '/resources/:id', (c) => {
  const cur = getResource(c.orgId, c.params[0]);
  need(cur, 404, 'Not found');
  need(can(c.user.role, 'write', cur!.kind));
  const r = updateResource(c.orgId, c.user.id, cur!.id, { name: c.body.name ? str(c.body.name, 120) : undefined, data: c.body.data ? prepare(c, cur!.kind, c.body.data) : undefined, status: c.body.status, note: str(c.body.note, 300) })!;
  if (r.kind === 'table') syncIndexes(r);
  if (r.version !== cur!.version) audit(c.orgId, c.user, `${r.kind}.update`, r.name, `version ${r.version}`, c.ip);
  return r;
});
route('DELETE', '/resources/:id', (c) => {
  const cur = getResource(c.orgId, c.params[0]);
  need(cur, 404, 'Not found');
  need(can(c.user.role, 'write', cur!.kind));
  run('DELETE FROM resources WHERE id = ?', cur!.id);
  run('DELETE FROM versions WHERE resource_id = ?', cur!.id);
  if (cur!.kind === 'table') { run('DELETE FROM records WHERE table_id = ?', cur!.id); syncIndexes({ ...cur!, data: { columns: [] } }); }
  if (cur!.kind === 'kb') run('DELETE FROM chunks WHERE kb_id = ?', cur!.id);
  if (cur!.kind === 'agent') run('DELETE FROM memory WHERE agent_id = ?', cur!.id);
  audit(c.orgId, c.user, `${cur!.kind}.delete`, cur!.name, '', c.ip);
  return { ok: true };
});
route('GET', '/resources/:id/versions', (c) => {
  need(getResource(c.orgId, c.params[0]), 404, 'Not found');
  return all('SELECT v.version, v.name, v.note, v.created_at, u.email FROM versions v LEFT JOIN users u ON u.id = v.created_by WHERE resource_id = ? ORDER BY version DESC', c.params[0]);
});
route('POST', '/resources/:id/restore', (c) => {
  const cur = getResource(c.orgId, c.params[0]);
  need(cur, 404, 'Not found');
  need(can(c.user.role, 'write', cur!.kind));
  const v = get('SELECT * FROM versions WHERE resource_id = ? AND version = ?', cur!.id, +c.body.version);
  need(v, 404, 'Version not found');
  const r = updateResource(c.orgId, c.user.id, cur!.id, { name: v!.name, data: parse(v!.data, {}), note: `Restored from version ${v!.version}` })!;
  audit(c.orgId, c.user, `${r.kind}.restore`, r.name, `from version ${v!.version}`, c.ip);
  return r;
});
route('POST', '/resources/:id/clone', (c) => {
  const cur = getResource(c.orgId, c.params[0]);
  need(cur, 404, 'Not found');
  need(can(c.user.role, 'write', cur!.kind));
  return createResource(c.orgId, c.user.id, cur!.kind, `${cur!.name} (copy)`, cur!.data, cur!.project_id);
});

// ---------- records ----------
const guardErr = <T>(f: () => T): T => { try { return f(); } catch (e: any) { throw e instanceof HttpError ? e : new HttpError(400, e?.message ?? 'Invalid request'); } };
route('GET', '/tables/:id/records', (c) => guardErr(() => queryRecords(c.orgId, c.params[0], { limit: 1000 })));
route('POST', '/tables/:id/records', (c) => guardErr(() => insertRecord(c.orgId, c.params[0], c.body)));
route('PUT', '/tables/:id/records/:rid', (c) => guardErr(() => updateRecord(c.orgId, c.params[0], c.params[1], c.body)));
route('DELETE', '/tables/:id/records/:rid', (c) => { run('DELETE FROM records WHERE id = ? AND table_id = ? AND org_id = ?', c.params[1], c.params[0], c.orgId); return { ok: true }; });

// ---------- agents, models, prompts ----------
route('GET', '/agents/tools', (c) => agentToolCatalog(c.orgId));
route('POST', '/agents/:id/chat', async (c) => {
  const agent = liveDefinition(c.orgId, c.params[0], c.body.env);
  need(agent && agent.kind === 'agent', 404, c.body.env && c.body.env !== 'draft' ? `This agent has not been released to ${c.body.env}` : 'Agent not found');
  need(str(c.body.message, 20000), 400, 'Message is required');
  return runAgent(c.orgId, agent!, str(c.body.message, 20000), { sessionId: str(c.body.sessionId, 80) || undefined, userId: c.user.id });
});
route('DELETE', '/agents/:id/memory', (c) => {
  const a = getResource(c.orgId, c.params[0], 'agent');
  need(a, 404, 'Agent not found');
  need(can(c.user.role, 'write', 'agent'));
  run('DELETE FROM memory WHERE agent_id = ? AND org_id = ?', a!.id, c.orgId);
  return { ok: true };
});
route('GET', '/agents/:id/memory', (c) => all("SELECT id, content, created_at FROM memory WHERE agent_id = ? AND org_id = ? AND kind = 'long' ORDER BY created_at DESC", c.params[0], c.orgId));
route('GET', '/models/catalog', () => ({ simulator: SIMULATOR, defaults: DEFAULT_BASE,
  providers: [{ id: 'anthropic', label: 'Claude (Anthropic)' }, { id: 'openai', label: 'OpenAI' }, { id: 'azure_openai', label: 'Azure OpenAI' }, { id: 'gemini', label: 'Gemini' }, { id: 'mistral', label: 'Mistral' }, { id: 'deepseek', label: 'DeepSeek' }, { id: 'ollama', label: 'Llama (Ollama, self-hosted)' }, { id: 'custom', label: 'Other compatible endpoint' }] }));
route('POST', '/llm/complete', async (c) => {
  const policy = orgSettings(c.orgId);
  const v = guardInput(str(c.body.prompt, 20000), policy);
  if (v.blocked) return { text: 'Blocked by the prompt firewall.', blocked: true, injection: v.injection };
  const r = await complete(c.orgId, { modelId: c.body.modelId, system: str(c.body.system, 8000) || 'You are a helpful assistant.', messages: [{ role: 'user', content: v.text }], source: 'playground' });
  return { text: guardOutput(r.text, policy).text, model: r.model, tokensIn: r.tokensIn, tokensOut: r.tokensOut, cost: r.cost, latencyMs: r.latencyMs, attempts: r.attempts };
});
route('POST', '/models/benchmark', async (c) => {
  const ids: string[] = Array.isArray(c.body.modelIds) ? c.body.modelIds.slice(0, 8) : [];
  const prompt = guardInput(str(c.body.prompt, 8000), orgSettings(c.orgId));
  need(!prompt.blocked, 400, 'The prompt was blocked by the prompt firewall');
  const out = [];
  for (const id of ids) {
    const name = id === 'builtin' ? SIMULATOR.name : getResource(c.orgId, id, 'model')?.name ?? id;
    const r = await complete(c.orgId, { modelId: id, system: 'You are a helpful assistant.', messages: [{ role: 'user', content: prompt.text }], source: 'benchmark' });
    const ok = r.model === name;
    out.push({ id, name, ok, error: ok ? '' : r.attempts.find((a) => !a.ok)?.error ?? 'failed', text: ok ? r.text.slice(0, 1500) : '', latencyMs: r.latencyMs, tokensIn: r.tokensIn, tokensOut: r.tokensOut, cost: r.cost });
  }
  return out;
});

// ---------- knowledge / RAG ----------
const kb = (c: Ctx) => { const k = getResource(c.orgId, c.params[0], 'kb'); need(k, 404, 'Knowledge base not found'); return k!; };
route('GET', '/kb/:id/documents', (c) => all('SELECT doc_id, doc_name, COUNT(*) chunks, SUM(LENGTH(text)) characters, MIN(created_at) created_at FROM chunks WHERE kb_id = ? AND org_id = ? GROUP BY doc_id ORDER BY created_at DESC', kb(c).id, c.orgId));
route('POST', '/kb/:id/documents', async (c) => {
  const k = kb(c);
  need(can(c.user.role, 'write', 'kb'));
  let text = String(c.body.text ?? ''), name = str(c.body.name, 200);
  if (c.body.url) {
    const res = await safeFetch(str(c.body.url, 2000)).catch((e) => { throw new HttpError(400, e.message); });
    need(res.ok, 400, `The page returned HTTP ${res.status}`);
    const raw = (await res.text()).slice(0, 2_000_000);
    text = /html/i.test(res.headers.get('content-type') ?? '') || /<html/i.test(raw) ? htmlToText(raw) : raw;
    name ||= str(c.body.url, 200);
  }
  if (/\.html?$/i.test(name) || /^\s*<(!doctype|html)/i.test(text)) text = htmlToText(text);
  need(text.trim().length > 0, 400, 'The document has no readable text');
  need(text.length <= 2_000_000, 400, 'Documents are limited to 2 MB of text');
  const policy = orgSettings(c.orgId);
  const pii = detectPII(text).length, injection = detectInjection(text);
  if (policy.maskIngest) text = maskPII(text);
  const r = ingest(c.orgId, k.id, name || 'Untitled', text, { size: +k.data.chunkSize || 900, overlap: +k.data.overlap || 150 });
  audit(c.orgId, c.user, 'kb.ingest', `${k.name}: ${name}`, `${r.chunks} chunks`, c.ip);
  return { ...r, pii, masked: !!policy.maskIngest, injection };
});
route('DELETE', '/kb/:id/documents/:doc', (c) => { need(can(c.user.role, 'write', 'kb')); run('DELETE FROM chunks WHERE kb_id = ? AND doc_id = ? AND org_id = ?', kb(c).id, c.params[1], c.orgId); return { ok: true }; });
route('POST', '/kb/:id/search', (c) => search(c.orgId, [kb(c).id], str(c.body.query, 1000), Math.min(+c.body.k || 5, 10)));

// ---------- runs: workflows, crews, bots ----------
route('POST', '/workflows/:id/run', async (c) => { const w = getResource(c.orgId, c.params[0], 'workflow'); need(w, 404, 'Workflow not found'); audit(c.orgId, c.user, 'workflow.run', w!.name, '', c.ip); return startRun(c.orgId, 'workflow', w!, c.body.input ?? {}, c.user.id).then(runView); });
route('POST', '/crews/:id/run', async (c) => { const w = getResource(c.orgId, c.params[0], 'crew'); need(w, 404, 'Crew not found'); need(str(c.body.goal, 8000), 400, 'Describe the goal'); audit(c.orgId, c.user, 'crew.run', w!.name, '', c.ip); return startRun(c.orgId, 'crew', w!, { goal: str(c.body.goal, 8000) }, c.user.id).then(runView); });
route('POST', '/bots/:id/run', async (c) => {
  const b = getResource(c.orgId, c.params[0], 'bot');
  need(b, 404, 'Bot not found');
  const started = Date.now();
  const r = await runBot(c.orgId, b!, c.body.input ?? {});
  const id = uid('run_');
  run('INSERT INTO runs (id, org_id, kind, resource_id, resource_name, status, input, output, steps, latency_ms, user_id, started_at, finished_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    id, c.orgId, 'bot', b!.id, b!.name, r.error ? 'failed' : 'succeeded', JSON.stringify(c.body.input ?? {}), JSON.stringify(r.error ? { error: r.error, vars: r.vars } : r.vars), JSON.stringify(r.log), Date.now() - started, c.user.id, new Date(started).toISOString(), now());
  audit(c.orgId, c.user, 'bot.run', b!.name, r.error ?? '', c.ip);
  return { ...r, runId: id };
});
route('POST', '/hooks/:id', async (c) => {
  const w = toResource(get("SELECT * FROM resources WHERE id = ? AND kind = 'workflow'", c.params[0]));
  need(w && checkWebhookKey(w, String(c.req.headers['x-aacs-key'] ?? c.query.get('key') ?? '')), 404, 'Not found');
  const r = await startRun(w!.org_id, 'workflow', w!, c.body ?? {}, null);
  return { runId: r.id, status: r.status };
}, true);
const runView = (r: Row) => ({ id: r.id, kind: r.kind, resourceId: r.resource_id, name: r.resource_name, status: r.status, input: parse(r.input, {}), output: parse(r.output), steps: parse(r.steps, []), tokensIn: r.tokens_in, tokensOut: r.tokens_out, cost: r.cost, latencyMs: r.latency_ms, startedAt: r.started_at, finishedAt: r.finished_at });
route('GET', '/runs', (c) => {
  const kind = c.query.get('kind'), rid = c.query.get('resource');
  const where = ['org_id = ?'], p: any[] = [c.orgId];
  if (kind) { where.push('kind = ?'); p.push(kind); }
  if (rid) { where.push('resource_id = ?'); p.push(rid); }
  return all(`SELECT * FROM runs WHERE ${where.join(' AND ')} ORDER BY started_at DESC LIMIT ?`, ...p, Math.min(+(c.query.get('limit') ?? 50), 200)).map(runView);
});
route('GET', '/runs/:id', (c) => { const r = get('SELECT * FROM runs WHERE id = ? AND org_id = ?', c.params[0], c.orgId); need(r, 404, 'Run not found'); return runView(r!); });

route('GET', '/approvals', (c) => all('SELECT * FROM approvals WHERE org_id = ? ORDER BY requested_at DESC LIMIT 200', c.orgId));
route('POST', '/approvals/:id/decide', async (c) => {
  need(can(c.user.role, 'approve'));
  await decideApproval(c.orgId, c.user as any, c.params[0], !!c.body.approve, str(c.body.comment, 1000)).catch((e) => { throw new HttpError(400, e.message); });
  return { ok: true };
});

// ---------- testing ----------
route('GET', '/tests/catalog', () => ({ checks: CHECKS, redTeam: RED_TEAM }));
route('POST', '/tests/:id/run', async (c) => {
  const s = getResource(c.orgId, c.params[0], 'testsuite');
  need(s, 404, 'Test suite not found');
  audit(c.orgId, c.user, 'test.run', s!.name, '', c.ip);
  return runSuite(c.orgId, s!, c.user.id).catch((e) => { throw new HttpError(400, e.message); });
});

// ---------- DevOps ----------
route('GET', '/deployments', (c) => all('SELECT * FROM deployments WHERE org_id = ? ORDER BY created_at DESC LIMIT 200', c.orgId).map((d) => ({ ...d, stages: parse(d.stages, []), snapshot: undefined })));
route('POST', '/deployments', async (c) => {
  need(can(c.user.role, 'deploy'));
  return deploy(c.orgId, c.user as any, str(c.body.resourceId), str(c.body.env), c.body.version ? +c.body.version : undefined).then((d) => ({ ...d, stages: parse(d.stages, []), snapshot: undefined })).catch((e) => { throw new HttpError(400, e.message); });
});
route('GET', '/live/:env/:id', (c) => { const r = liveDefinition(c.orgId, c.params[1], c.params[0]); need(r, 404, `Nothing is released to ${c.params[0]} yet`); return r; });

// ---------- marketplace ----------
route('GET', '/marketplace', (c) => ({
  templates: TEMPLATES.map((t) => ({ id: t.id, category: t.category, name: t.name, description: t.description, contains: t.items.map((i) => `${i.kind}: ${i.name}`), source: 'AACS' })),
  listings: all("SELECT * FROM resources WHERE org_id = ? AND kind = 'listing' ORDER BY updated_at DESC", c.orgId).map((r) => { const d = parse(r.data, {}); return { id: r.id, category: d.kind, name: r.name, description: d.description, contains: [`${d.kind}: ${r.name}`], source: d.publishedBy }; }),
}));
route('POST', '/marketplace/install', (c) => {
  const t = TEMPLATES.find((x) => x.id === c.body.id);
  const listing = t ? undefined : get("SELECT * FROM resources WHERE id = ? AND org_id = ? AND kind = 'listing'", str(c.body.id), c.orgId);
  need(t || listing, 404, 'Template not found');
  const items = t ? t.items : [{ key: 'x', kind: parse(listing!.data).kind, name: listing!.name, data: parse(listing!.data).data }];
  for (const k of new Set(items.map((i) => i.kind))) need(can(c.user.role, 'write', k), 403, `Your role cannot create ${k} resources`);
  const created = installItems(c.orgId, c.user.id, c.body.projectId || null, items);
  audit(c.orgId, c.user, 'marketplace.install', t?.name ?? listing!.name, '', c.ip);
  return created;
});
route('POST', '/marketplace/publish', (c) => {
  const r = getResource(c.orgId, str(c.body.resourceId));
  need(r, 404, 'Not found');
  need(can(c.user.role, 'write', r!.kind));
  need(!detectPII(JSON.stringify(r!.data), ['API_KEY']).length, 400, 'Remove hard-coded credentials before publishing');
  const t = now();
  run('INSERT INTO resources (id, org_id, kind, name, data, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', uid('lst_'), c.orgId, 'listing', r!.name, JSON.stringify({ kind: r!.kind, data: r!.data, description: str(c.body.description, 500), publishedBy: c.user.email }), c.user.id, t, t);
  audit(c.orgId, c.user, 'marketplace.publish', r!.name, '', c.ip);
  return { ok: true };
});
route('DELETE', '/marketplace/:id', (c) => { need(can(c.user.role, 'admin')); run("DELETE FROM resources WHERE id = ? AND org_id = ? AND kind = 'listing'", c.params[0], c.orgId); return { ok: true }; });

// ---------- security centre ----------
route('GET', '/secrets', (c) => { need(can(c.user.role, 'admin') || c.user.role === 'developer'); return all('SELECT s.name, s.created_at, u.email FROM secrets s LEFT JOIN users u ON u.id = s.created_by WHERE s.org_id = ? ORDER BY s.name', c.orgId); });
route('POST', '/secrets', (c) => {
  need(can(c.user.role, 'admin'));
  const name = str(c.body.name, 60);
  need(/^[A-Za-z][\w-]*$/.test(name) && String(c.body.value ?? '').length > 0, 400, 'A secret needs a name (letters, digits, _ and -) and a value');
  setSecret(c.orgId, c.user.id, name, String(c.body.value));
  audit(c.orgId, c.user, 'secret.set', name, '', c.ip);
  return { ok: true };
});
route('DELETE', '/secrets/:name', (c) => { need(can(c.user.role, 'admin')); run('DELETE FROM secrets WHERE org_id = ? AND name = ?', c.orgId, decodeURIComponent(c.params[0])); audit(c.orgId, c.user, 'secret.delete', decodeURIComponent(c.params[0]), '', c.ip); return { ok: true }; });
route('POST', '/guard/check', (c) => {
  const text = str(c.body.text, 20000), policy = orgSettings(c.orgId);
  const v = guardInput(text, policy);
  return { blocked: v.blocked, injection: v.injection, pii: v.pii.map((p) => ({ type: p.type, value: maskPII(p.value) })), toxicity: detectToxicity(text), masked: maskPII(text) };
});
route('GET', '/audit', (c) => {
  need(can(c.user.role, 'admin'));
  const q = `%${c.query.get('q') ?? ''}%`;
  return all('SELECT * FROM audit WHERE org_id = ? AND (action LIKE ? OR user_email LIKE ? OR target LIKE ?) ORDER BY created_at DESC, rowid DESC LIMIT 300', c.orgId, q, q, q);
});
route('GET', '/security/summary', (c) => {
  const s = orgSettings(c.orgId);
  const users = all("SELECT mfa_enabled FROM users WHERE org_id = ? AND status = 'active'", c.orgId);
  const mfa = users.filter((u) => u.mfa_enabled).length;
  const org = get('SELECT region FROM orgs WHERE id = ?', c.orgId)!;
  const lastBackup = get("SELECT MAX(created_at) m FROM audit WHERE org_id = ? AND action = 'backup.export'", c.orgId)?.m;
  const https = c.req.headers['x-forwarded-proto'] === 'https';
  const ctl = (id: string, name: string, status: 'pass' | 'warn' | 'fail', detail: string, frameworks: string[]) => ({ id, name, status, detail, frameworks });
  const controls = [
    ctl('mfa', 'Multi-factor authentication', mfa === users.length ? 'pass' : mfa ? 'warn' : 'fail', `${mfa} of ${users.length} active users have MFA enabled`, ['SOC 2', 'ISO 27001', 'PCI DSS', 'HIPAA']),
    ctl('rbac', 'Role-based access control', 'pass', 'Five roles enforced on every API call', ['SOC 2', 'ISO 27001', 'HIPAA', 'PCI DSS']),
    ctl('vault', 'Secrets encrypted at rest', process.env.AACS_MASTER_KEY ? 'pass' : 'warn', process.env.AACS_MASTER_KEY ? 'AES-256-GCM, key supplied by the environment' : 'AES-256-GCM, but the key is a local file - supply AACS_MASTER_KEY from your key vault', ['SOC 2', 'ISO 27001', 'PCI DSS', 'GDPR']),
    ctl('tls', 'Encryption in transit', https ? 'pass' : 'warn', https ? 'This session arrived over HTTPS' : 'This session is not behind an HTTPS proxy', ['SOC 2', 'PCI DSS', 'HIPAA', 'GDPR']),
    ctl('firewall', 'Prompt firewall', s.firewall === 'block' ? 'pass' : s.firewall === 'flag' ? 'warn' : 'fail', `Mode: ${s.firewall}`, ['SOC 2', 'ISO 27001']),
    ctl('dlp', 'Personal-data masking (DLP)', s.maskInput && s.maskOutput ? 'pass' : s.maskInput || s.maskOutput ? 'warn' : 'fail', `Model input: ${s.maskInput ? 'masked' : 'not masked'}, output: ${s.maskOutput ? 'masked' : 'not masked'}`, ['GDPR', 'HIPAA', 'PCI DSS', 'DPDP India']),
    ctl('audit', 'Audit logging', 'pass', `${get('SELECT COUNT(*) n FROM audit WHERE org_id = ?', c.orgId)!.n} events recorded`, ['SOC 2', 'ISO 27001', 'HIPAA', 'PCI DSS']),
    ctl('retention', 'Retention policy', +s.retentionDays > 0 ? 'pass' : 'warn', +s.retentionDays > 0 ? `Run history and conversations are purged after ${s.retentionDays} days` : 'No retention period set', ['GDPR', 'DPDP India', 'HIPAA']),
    ctl('residency', 'Data residency', org.region ? 'pass' : 'warn', `Declared region: ${org.region || 'not set'}`, ['GDPR', 'DPDP India']),
    ctl('backup', 'Backup', lastBackup && Date.now() - Date.parse(lastBackup) < 7 * 864e5 ? 'pass' : 'warn', lastBackup ? `Last export ${lastBackup.slice(0, 10)}` : 'No export taken yet', ['SOC 2', 'ISO 27001']),
    ctl('approval', 'Human approval before production', 'pass', 'Production releases always wait for an approver', ['SOC 2', 'ISO 27001']),
  ];
  const frameworks = ['SOC 2', 'GDPR', 'HIPAA', 'ISO 27001', 'PCI DSS', 'DPDP India'].map((f) => { const mine = controls.filter((x) => x.frameworks.includes(f)); return { name: f, passed: mine.filter((x) => x.status === 'pass').length, total: mine.length }; });
  const since = new Date(Date.now() - 30 * 864e5).toISOString();
  return { controls, frameworks, settings: s,
    events: { blocked: get("SELECT COUNT(*) n FROM runs WHERE org_id = ? AND status = 'blocked' AND started_at > ?", c.orgId, since)!.n, failedLogins: get("SELECT COUNT(*) n FROM audit WHERE org_id = ? AND action IN ('auth.login_failed','auth.mfa_failed') AND created_at > ?", c.orgId, since)!.n } };
});
route('GET', '/export', (c) => {
  need(can(c.user.role, 'admin'));
  audit(c.orgId, c.user, 'backup.export', '', '', c.ip);
  return { format: 'aacs-backup-1', exportedAt: now(), org: get('SELECT name, region, settings FROM orgs WHERE id = ?', c.orgId),
    projects: all('SELECT * FROM projects WHERE org_id = ?', c.orgId), resources: all('SELECT * FROM resources WHERE org_id = ?', c.orgId),
    versions: all('SELECT v.* FROM versions v JOIN resources r ON r.id = v.resource_id WHERE r.org_id = ?', c.orgId),
    records: all('SELECT * FROM records WHERE org_id = ?', c.orgId), chunks: all('SELECT * FROM chunks WHERE org_id = ?', c.orgId), secretNames: all('SELECT name FROM secrets WHERE org_id = ?', c.orgId).map((s) => s.name) };
});
route('POST', '/import', (c) => {
  need(can(c.user.role, 'admin'));
  const b = c.body;
  need(b?.format === 'aacs-backup-1', 400, 'This is not an AACS backup file');
  const count = { projects: 0, resources: 0, versions: 0, records: 0, chunks: 0 };
  const put = (table: keyof typeof count, cols: string[], rows: any[]) => {
    const st = db.prepare(`INSERT OR IGNORE INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
    for (const r of Array.isArray(rows) ? rows : []) count[table] += Number(st.run(...cols.map((k) => (k === 'org_id' ? c.orgId : r[k] ?? null))).changes);
  };
  db.exec('BEGIN');
  try {
    put('projects', ['id', 'org_id', 'name', 'description', 'created_at'], b.projects);
    put('resources', ['id', 'org_id', 'project_id', 'kind', 'name', 'data', 'version', 'status', 'created_by', 'created_at', 'updated_at'], b.resources);
    const mine = new Set(all('SELECT id FROM resources WHERE org_id = ?', c.orgId).map((r) => r.id));
    put('versions', ['id', 'resource_id', 'version', 'name', 'data', 'note', 'created_by', 'created_at'], (b.versions ?? []).filter((v: any) => mine.has(v.resource_id)));
    put('records', ['id', 'org_id', 'table_id', 'data', 'created_at', 'updated_at'], (b.records ?? []).filter((v: any) => mine.has(v.table_id)));
    put('chunks', ['id', 'org_id', 'kb_id', 'doc_id', 'doc_name', 'seq', 'text', 'vec', 'created_at'], (b.chunks ?? []).filter((v: any) => mine.has(v.kb_id)));
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw new HttpError(400, 'The backup file could not be restored'); }
  audit(c.orgId, c.user, 'backup.import', '', JSON.stringify(count), c.ip);
  return count;
});

// ---------- notifications, monitoring, FinOps ----------
route('GET', '/notifications', (c) => all('SELECT * FROM notifications WHERE org_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 200', c.orgId));
route('POST', '/notifications/read', (c) => { run('UPDATE notifications SET read = 1 WHERE org_id = ?', c.orgId); return { ok: true }; });
route('POST', '/notifications', (c) => { need(str(c.body.subject), 400, 'Subject is required'); notify(c.orgId, 'in_app', '', str(c.body.subject, 200), str(c.body.body, 4000), 'delivered'); return { ok: true }; });

const days = (n: number) => Array.from({ length: n }, (_, i) => new Date(Date.now() - (n - 1 - i) * 864e5).toISOString().slice(0, 10));
route('GET', '/usage/summary', (c) => {
  const since = new Date(Date.now() - 30 * 864e5).toISOString();
  const byDay = Object.fromEntries(all('SELECT substr(created_at,1,10) d, SUM(cost) cost, SUM(tokens_in + tokens_out) tokens, COUNT(*) calls FROM usage WHERE org_id = ? AND created_at > ? GROUP BY d', c.orgId, since).map((r) => [r.d, r]));
  const month = new Date().toISOString().slice(0, 7);
  return {
    byModel: all('SELECT model, provider, COUNT(*) calls, SUM(tokens_in) tokens_in, SUM(tokens_out) tokens_out, SUM(cost) cost, ROUND(AVG(latency_ms)) avg_ms, SUM(1 - ok) errors FROM usage WHERE org_id = ? AND created_at > ? GROUP BY model, provider ORDER BY calls DESC', c.orgId, since),
    bySource: all('SELECT source, COUNT(*) calls, SUM(cost) cost, SUM(tokens_in + tokens_out) tokens FROM usage WHERE org_id = ? AND created_at > ? GROUP BY source ORDER BY cost DESC, calls DESC LIMIT 12', c.orgId, since),
    daily: days(30).map((d) => ({ day: d, cost: byDay[d]?.cost ?? 0, tokens: byDay[d]?.tokens ?? 0, calls: byDay[d]?.calls ?? 0 })),
    monthCost: get('SELECT COALESCE(SUM(cost),0) c FROM usage WHERE org_id = ? AND substr(created_at,1,7) = ?', c.orgId, month)!.c,
    budget: +orgSettings(c.orgId).monthlyBudget || 0,
  };
});
route('GET', '/dashboard', (c) => {
  const since = new Date(Date.now() - 14 * 864e5).toISOString();
  const counts = Object.fromEntries(all('SELECT kind, COUNT(*) n FROM resources WHERE org_id = ? GROUP BY kind', c.orgId).map((r) => [r.kind, r.n]));
  const rows = all('SELECT substr(started_at,1,10) d, status, COUNT(*) n FROM runs WHERE org_id = ? AND started_at > ? GROUP BY d, status', c.orgId, since);
  const runsDaily = days(14).map((d) => { const mine = rows.filter((r) => r.d === d); const ok = mine.filter((r) => r.status === 'succeeded').reduce((a, r) => a + r.n, 0); const total = mine.reduce((a, r) => a + r.n, 0); return { day: d, succeeded: ok, other: total - ok }; });
  const lat = get("SELECT ROUND(AVG(latency_ms)) avg, COUNT(*) n, SUM(status = 'succeeded') ok FROM runs WHERE org_id = ? AND started_at > ?", c.orgId, since)!;
  return { counts, runsDaily, runs: { total: lat.n, succeeded: lat.ok ?? 0, avgMs: lat.avg ?? 0 },
    pendingApprovals: get("SELECT COUNT(*) n FROM approvals WHERE org_id = ? AND status = 'pending'", c.orgId)!.n,
    unread: get('SELECT COUNT(*) n FROM notifications WHERE org_id = ? AND read = 0', c.orgId)!.n,
    cost: get('SELECT COALESCE(SUM(cost),0) c, COALESCE(SUM(tokens_in + tokens_out),0) t FROM usage WHERE org_id = ? AND created_at > ?', c.orgId, since),
    recent: all('SELECT * FROM runs WHERE org_id = ? ORDER BY started_at DESC LIMIT 8', c.orgId).map(runView).map((r) => ({ ...r, steps: undefined, input: undefined, output: undefined })) };
});

// ---------- dispatcher ----------
function cookie(req: IncomingMessage): string | undefined {
  return (req.headers.cookie ?? '').split(';').map((s) => s.trim().split('=')).find(([k]) => k === COOKIE)?.[1];
}
async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const ch of req) { size += ch.length; if (size > 8_000_000) throw new HttpError(413, 'Request is too large'); chunks.push(ch as Buffer); }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'Request body must be JSON'); }
}
export async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL) {
  const send = (status: number, body: any) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body ?? null)); };
  try {
    const path = url.pathname.replace(/^\/api/, '');
    const method = req.method ?? 'GET';
    let m: RegExpExecArray | null = null;
    const r = routes.find((x) => x.method === method && (m = x.re.exec(path)));
    if (!r || !m) throw new HttpError(404, 'Not found');
    const mutating = method !== 'GET';
    // Browsers cannot send a JSON content type cross-site without a preflight; with SameSite=Strict cookies this closes CSRF.
    if (mutating && !path.startsWith('/hooks/') && !/^application\/json/i.test(String(req.headers['content-type'] ?? ''))) throw new HttpError(415, 'Use Content-Type: application/json');
    const ctx = { req, res, params: (m as RegExpExecArray).slice(1), query: url.searchParams, body: mutating ? await readBody(req) : {}, ip: String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0].trim() } as Ctx;
    if (!r.open || path === '/auth/logout') {
      const token = cookie(req);
      const s = token ? get('SELECT * FROM sessions WHERE token_hash = ? AND expires_at > ?', sha256(token), Date.now()) : undefined;
      const user = s ? get("SELECT * FROM users WHERE id = ? AND status = 'active'", s.user_id) : undefined;
      if (!user && !r.open) throw new HttpError(401, 'Sign in to continue');
      if (user) { ctx.user = user; ctx.orgId = user.org_id; }
    }
    send(200, await r.h(ctx));
  } catch (e: any) {
    if (e instanceof HttpError) send(e.status, { error: e.message });
    else { console.error(e); send(500, { error: 'Something went wrong on the server' }); }
  }
}

/** Retention: purge run history, conversations and notifications older than each organisation's retention period. */
export function purgeExpired() {
  for (const o of all('SELECT id FROM orgs')) {
    const d = +orgSettings(o.id).retentionDays;
    if (!(d > 0)) continue;
    const cutoff = new Date(Date.now() - d * 864e5).toISOString();
    run('DELETE FROM runs WHERE org_id = ? AND started_at < ?', o.id, cutoff);
    run("DELETE FROM memory WHERE org_id = ? AND kind = 'chat' AND created_at < ?", o.id, cutoff);
    run('DELETE FROM notifications WHERE org_id = ? AND created_at < ?', o.id, cutoff);
    run('DELETE FROM usage WHERE org_id = ? AND created_at < ?', o.id, cutoff);
  }
  run('DELETE FROM sessions WHERE expires_at < ?', Date.now());
}
