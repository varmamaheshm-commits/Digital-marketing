// Workflow engine: runs workflows and multi-agent crews step by step, pauses for human approval, and fires triggers.
import { AsyncLocalStorage } from 'node:async_hooks';
import { timingSafeEqual } from 'node:crypto';
import { all, audit, get, getResource, listResources, notify, now, parse, run, uid, type Resource, type Row } from './db.ts';
import { insertRecord, recordListeners, updateRecord } from './data.ts';
import { runAgent, withSecrets } from './agent.ts';
import { runBot } from './rpa.ts';
import { safeFetch } from './sec.ts';

export interface Step { id: string; type: string; name?: string; config: Record<string, any> }
interface State { plan: Step[]; cursor: number; ctx: { trigger: any; steps: Record<string, any>; vars: Record<string, any> }; reworks: number; finalFrom?: string }
interface Log { id: string; type: string; name: string; status: string; detail: string; ms: number; at: string }

const lookup = (ctx: any, path: string) => path.trim().split('.').reduce((o, k) => (o == null ? undefined : o[k]), path.startsWith('input') ? { ...ctx, input: ctx.trigger } : ctx);
/** Resolve {{trigger.x}}, {{steps.id.output}}, {{vars.x}}. A string that is exactly one placeholder keeps the value's type. */
export function tpl(value: any, ctx: any): any {
  if (typeof value !== 'string') {
    if (Array.isArray(value)) return value.map((v) => tpl(v, ctx));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, tpl(v, ctx)]));
    return value;
  }
  const single = /^\{\{\s*((?:trigger|input|steps|vars)[\w.\- ]*)\}\}$/.exec(value);
  if (single) return lookup(ctx, single[1]) ?? '';
  return value.replace(/\{\{\s*((?:trigger|input|steps|vars)[\w.\- ]*)\}\}/g, (_, p) => { const v = lookup(ctx, p); return v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v); });
}
export function compare(left: any, op: string, right: any): boolean {
  const l = String(left ?? ''), r = String(right ?? '');
  const ln = Number(l), rn = Number(r), num = l !== '' && r !== '' && !Number.isNaN(ln) && !Number.isNaN(rn);
  switch (op) {
    case 'equals': return num ? ln === rn : l.toLowerCase() === r.toLowerCase();
    case 'not_equals': return num ? ln !== rn : l.toLowerCase() !== r.toLowerCase();
    case 'contains': return l.toLowerCase().includes(r.toLowerCase());
    case 'not_contains': return !l.toLowerCase().includes(r.toLowerCase());
    case 'greater': return num ? ln > rn : l > r;
    case 'less': return num ? ln < rn : l < r;
    case 'empty': return l.trim() === '';
    case 'not_empty': return l.trim() !== '';
    default: return false;
  }
}

function compileCrew(crew: Resource): Step[] {
  const members: any[] = crew.data.members ?? [];
  const steps: Step[] = members.map((m, i) => ({
    id: `a${i + 1}`, type: 'agent', name: m.title || `Agent ${i + 1}`,
    config: {
      agentId: m.agentId,
      input: `Overall goal: {{trigger.goal}}\n\nYour task: ${m.task || 'Contribute your part.'}` + (i ? `\n\nHand-off from the previous agent:\n{{steps.a${i}.output}}` : '') + '\n\n{{vars.feedback}}',
      ...(m.reviewer && i ? { rejectWord: 'REJECTED', reworkStepId: `a${i}` } : {}),
      reviewer: !!m.reviewer,
    },
  }));
  if (crew.data.humanApproval) steps.push({ id: 'approval', type: 'approval', name: 'Human approval', config: { title: `Approve the result of ${crew.name}`, detail: `{{steps.a${members.length}.output}}` } });
  return steps;
}

const depth = new AsyncLocalStorage<number>();

export async function startRun(orgId: string, kind: 'workflow' | 'crew', res: Resource, input: any, userId?: string | null): Promise<Row> {
  const plan = kind === 'crew' ? compileCrew(res) : ((res.data.steps ?? []) as Step[]);
  const state: State = { plan, cursor: 0, ctx: { trigger: input ?? {}, steps: {}, vars: {} }, reworks: 0 };
  if (kind === 'crew') state.finalFrom = [...plan].reverse().find((s) => s.type === 'agent' && !s.config.reviewer)?.id;
  const id = uid('run_');
  run('INSERT INTO runs (id, org_id, kind, resource_id, resource_name, status, input, state, user_id, started_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    id, orgId, kind, res.id, res.name, 'running', JSON.stringify(input ?? {}), JSON.stringify(state), userId ?? null, now());
  await depth.run((depth.getStore() ?? 0) + 1, () => execute(orgId, id));
  return get('SELECT * FROM runs WHERE id = ?', id)!;
}

async function execute(orgId: string, runId: string) {
  const row = get('SELECT * FROM runs WHERE id = ? AND org_id = ?', runId, orgId);
  if (!row) return;
  const state: State = parse(row.state, {});
  const logs: Log[] = parse(row.steps, []);
  let cost = row.cost, tin = row.tokens_in, tout = row.tokens_out;
  const started = Date.parse(row.started_at);
  const save = (status: string, output?: any) => run('UPDATE runs SET status = ?, steps = ?, state = ?, output = ?, cost = ?, tokens_in = ?, tokens_out = ?, latency_ms = ?, finished_at = ? WHERE id = ?',
    status, JSON.stringify(logs), JSON.stringify(state), JSON.stringify(output ?? null), cost, tin, tout, Date.now() - started, ['running', 'waiting'].includes(status) ? null : now(), runId);
  const ctx = state.ctx;
  let guard = 0;
  while (state.cursor < state.plan.length) {
    if (++guard > 200) { save('failed', { error: 'Step limit reached' }); return; }
    const step = state.plan[state.cursor];
    const c = tpl(step.config ?? {}, ctx);
    const t = Date.now();
    const log = (status: string, detail: string) => logs.push({ id: step.id, type: step.type, name: step.name || step.type, status, detail: detail.slice(0, 1500), ms: Date.now() - t, at: now() });
    try {
      let output: any = null;
      let next = state.cursor + 1;
      switch (step.type) {
        case 'agent': {
          const agent = getResource(orgId, c.agentId, 'agent');
          if (!agent) throw new Error('Agent not found');
          const r = await runAgent(orgId, agent, String(c.input || JSON.stringify(ctx.trigger)), { record: false, source: `${row.kind}:${row.resource_name}` });
          cost += r.cost; tin += r.tokensIn; tout += r.tokensOut;
          output = r.output;
          if (r.blocked) throw new Error(r.output);
          if (c.rejectWord && r.output.includes(c.rejectWord) && state.reworks < 2) {
            const back = state.plan.findIndex((s) => s.id === c.reworkStepId);
            if (back >= 0) { state.reworks++; ctx.vars.feedback = `Reviewer feedback to address:\n${r.output}`; next = back; log('escalated', `${agent.name} sent the work back: ${r.output.slice(0, 600)}`); ctx.steps[step.id] = { output }; state.cursor = next; continue; }
          }
          ctx.vars.feedback = '';
          log('done', `${agent.name} (${r.model}): ${r.output}`);
          break;
        }
        case 'bot': {
          const bot = getResource(orgId, c.botId, 'bot');
          if (!bot) throw new Error('Bot not found');
          const r = await runBot(orgId, bot, c.input && typeof c.input === 'object' ? c.input : ctx.trigger);
          if (r.error) throw new Error(r.error);
          output = r.vars; log('done', `Bot ${bot.name} finished: ${JSON.stringify(r.vars)}`);
          break;
        }
        case 'db_insert': output = insertRecord(orgId, c.tableId, c.values ?? {}); log('done', `Created record ${output.id}`); break;
        case 'db_update': output = updateRecord(orgId, c.tableId, String(c.recordId), c.values ?? {}); log('done', `Updated record ${output.id}`); break;
        case 'http': {
          const headers: Record<string, string> = {};
          for (const h of c.headers ?? []) if (h.name) headers[h.name] = withSecrets(orgId, h.value);
          const method = String(c.method || 'GET').toUpperCase();
          const hasBody = method !== 'GET' && c.body !== undefined && c.body !== '';
          if (hasBody && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json';
          const res = await safeFetch(String(c.url), { method, headers, body: hasBody ? (typeof c.body === 'string' ? c.body : JSON.stringify(c.body)) : undefined });
          const text = (await res.text()).slice(0, 20000);
          output = { status: res.status, body: parse(text, text) };
          log(res.ok ? 'done' : 'warning', `${method} ${c.url} -> HTTP ${res.status}`);
          break;
        }
        case 'email': notify(orgId, 'email', String(c.to ?? ''), String(c.subject ?? ''), String(c.body ?? '')); output = { queued: true }; log('done', `Email to ${c.to} queued`); break;
        case 'sms': notify(orgId, 'sms', String(c.to ?? ''), '', String(c.body ?? '')); output = { queued: true }; log('done', `SMS to ${c.to} queued`); break;
        case 'notify': notify(orgId, 'in_app', '', String(c.subject ?? step.name ?? 'Notification'), String(c.body ?? ''), 'delivered'); output = { delivered: true }; log('done', String(c.subject ?? '')); break;
        case 'document': {
          const id = notify(orgId, 'document', '', String(c.title ?? 'Document'), String(c.template ?? ''), 'generated');
          output = { documentId: id, title: c.title, text: c.template }; log('done', `Generated document "${c.title}"`);
          break;
        }
        case 'set': ctx.vars[String(c.name)] = c.value; output = c.value; log('done', `${c.name} = ${JSON.stringify(c.value)}`); break;
        case 'condition': {
          const ok = compare(c.left, c.op, c.right);
          output = ok;
          if (!ok && c.onFalse === 'stop') { log('done', 'Condition false - workflow stopped'); ctx.steps[step.id] = { output }; state.cursor = state.plan.length; continue; }
          if (!ok) next = state.cursor + 1 + Math.max(1, +c.skip || 1);
          log('done', `Condition ${ok ? 'true' : `false - skipped ${Math.max(1, +c.skip || 1)} step(s)`}`);
          break;
        }
        case 'approval': {
          run('INSERT INTO approvals (id, org_id, run_id, kind, title, detail, requested_by, requested_at) VALUES (?,?,?,?,?,?,?,?)',
            uid('apr_'), orgId, runId, 'run', String(c.title || `Approval needed: ${row.resource_name}`), String(c.detail ?? '').slice(0, 8000), row.user_id, now());
          notify(orgId, 'in_app', '', 'Approval requested', String(c.title || row.resource_name), 'delivered');
          log('waiting', 'Waiting for human approval');
          save('waiting');
          return;
        }
        default: throw new Error(`Unknown step type "${step.type}"`);
      }
      ctx.steps[step.id] = { output };
      state.cursor = next;
    } catch (e: any) {
      log('failed', String(e?.message ?? e));
      save('failed', { error: String(e?.message ?? e) });
      return;
    }
  }
  const lastId = state.finalFrom ?? state.plan[state.plan.length - 1]?.id;
  save('succeeded', lastId ? ctx.steps[lastId]?.output ?? null : null);
}

export async function decideApproval(orgId: string, user: { id: string; email: string }, id: string, approve: boolean, comment = '') {
  const a = get("SELECT * FROM approvals WHERE id = ? AND org_id = ? AND status = 'pending'", id, orgId);
  if (!a) throw new Error('Approval not found or already decided');
  run('UPDATE approvals SET status = ?, decided_by = ?, decided_at = ?, comment = ? WHERE id = ?', approve ? 'approved' : 'rejected', user.email, now(), comment, id);
  audit(orgId, user, approve ? 'approval.approve' : 'approval.reject', a.title, comment);
  if (a.kind === 'deploy') {
    const p = parse(a.payload, {});
    if (approve) releaseDeployment(orgId, p.deploymentId, user);
    else run("UPDATE deployments SET status = 'rejected' WHERE id = ? AND org_id = ?", p.deploymentId, orgId);
    return;
  }
  const row = get("SELECT * FROM runs WHERE id = ? AND org_id = ? AND status = 'waiting'", a.run_id, orgId);
  if (!row) return;
  const state: State = parse(row.state, {});
  const logs: Log[] = parse(row.steps, []);
  const step = state.plan[state.cursor];
  logs.push({ id: step.id, type: 'approval', name: step.name || 'Approval', status: approve ? 'done' : 'failed', detail: `${approve ? 'Approved' : 'Rejected'} by ${user.email}${comment ? `: ${comment}` : ''}`, ms: 0, at: now() });
  state.ctx.steps[step.id] = { output: { approved: approve, comment, by: user.email } };
  state.cursor++;
  if (!approve) { run("UPDATE runs SET status = 'rejected', steps = ?, state = ?, finished_at = ? WHERE id = ?", JSON.stringify(logs), JSON.stringify(state), now(), row.id); return; }
  run("UPDATE runs SET status = 'running', steps = ?, state = ? WHERE id = ?", JSON.stringify(logs), JSON.stringify(state), row.id);
  await execute(orgId, row.id);
}

// ---------- triggers ----------
recordListeners.push((orgId, table, record) => {
  if ((depth.getStore() ?? 0) >= 3) return; // stop trigger cascades
  for (const wf of listResources(orgId, 'workflow')) {
    const tr = wf.data.trigger;
    if (wf.data.enabled && tr?.type === 'record' && tr.tableId === table.id) void startRun(orgId, 'workflow', wf, { table: table.name, record, ...record }).catch(() => {});
  }
});
export function checkWebhookKey(wf: Resource, key: string): boolean {
  const want = Buffer.from(String(wf.data.trigger?.key ?? ''));
  const got = Buffer.from(String(key ?? ''));
  return wf.data.enabled && wf.data.trigger?.type === 'webhook' && want.length > 8 && want.length === got.length && timingSafeEqual(want, got);
}
const lastScheduled = new Map<string, number>();
export function startScheduler() {
  const tick = () => {
    for (const wf of all("SELECT * FROM resources WHERE kind = 'workflow'").map((r) => ({ ...r, data: parse(r.data, {}) }) as Resource)) {
      const tr = wf.data.trigger;
      if (!wf.data.enabled || tr?.type !== 'schedule') continue;
      const every = Math.max(1, +tr.everyMinutes || 60) * 60000;
      const last = lastScheduled.get(wf.id) ?? Date.parse(get("SELECT MAX(started_at) m FROM runs WHERE resource_id = ?", wf.id)?.m ?? wf.updated_at);
      if (Date.now() - last >= every) { lastScheduled.set(wf.id, Date.now()); void startRun(wf.org_id, 'workflow', wf, { scheduledAt: now() }).catch(() => {}); }
    }
  };
  setInterval(tick, 30000).unref();
}

// ---------- DevOps: environments and the release pipeline ----------
export const ENVS = ['dev', 'test', 'uat', 'prod'];
import { runSuite } from './testing.ts';
import { detectPII } from './sec.ts';

export async function deploy(orgId: string, user: { id: string; email: string; role: string }, resourceId: string, env: string, version?: number) {
  const res = getResource(orgId, resourceId);
  if (!res) throw new Error('Resource not found');
  if (!ENVS.includes(env)) throw new Error('Unknown environment');
  const v = version ?? res.version;
  const snap = get('SELECT * FROM versions WHERE resource_id = ? AND version = ?', res.id, v);
  if (!snap) throw new Error(`Version ${v} not found`);
  const data = parse(snap.data, {});
  const stages: { name: string; status: string; detail: string }[] = [];
  const stage = (name: string, ok: boolean | 'skipped', detail: string) => { stages.push({ name, status: ok === 'skipped' ? 'skipped' : ok ? 'passed' : 'failed', detail }); return ok !== false; };
  let ok = stage('Commit', true, `${res.kind} "${snap.name}" version ${v}`);

  const problems: string[] = [];
  if (res.kind === 'agent' && !(data.role && data.goal)) problems.push('agent needs a role and a goal');
  if (res.kind === 'workflow' && !(data.steps?.length)) problems.push('workflow has no steps');
  if (res.kind === 'app' && !(data.pages?.some((p: any) => p.components?.length))) problems.push('app has no components');
  if (res.kind === 'bot' && !(data.steps?.length)) problems.push('bot has no steps');
  if (res.kind === 'crew' && !(data.members?.length)) problems.push('crew has no agents');
  ok = stage('Build', problems.length === 0, problems.length ? problems.join('; ') : 'Definition is complete') && ok;

  const pii = detectPII(JSON.stringify(data));
  const keys = pii.filter((p) => p.type === 'API_KEY');
  ok = stage('Scan', keys.length === 0, keys.length ? `${keys.length} hard-coded credential(s) found - move them to the secrets vault` : pii.length ? `No credentials. ${pii.length} personal-data value(s) present in the definition (review).` : 'No credentials or personal data in the definition') && ok;

  const idx = ENVS.indexOf(env);
  if (ok && idx > 0) {
    const prev = get("SELECT 1 FROM deployments WHERE org_id = ? AND resource_id = ? AND env = ? AND version = ? AND status IN ('live','superseded')", orgId, res.id, ENVS[idx - 1], v);
    ok = stage('Promotion gate', !!prev, prev ? `Version ${v} was released to ${ENVS[idx - 1]}` : `Version ${v} must be released to ${ENVS[idx - 1]} first`) && ok;
  }
  if (ok && idx > 0) {
    const suites = listResources(orgId, 'testsuite').filter((s) => s.data.targetId === res.id);
    if (!suites.length) stage('Validate', 'skipped', 'No test suite is linked to this resource');
    else {
      const results = [];
      for (const s of suites) results.push({ name: s.name, r: await runSuite(orgId, s, user.id) });
      const bad = results.filter((x) => (x.r.scorecard.overall ?? 0) < 70);
      ok = stage('Validate', bad.length === 0, results.map((x) => `${x.name}: ${x.r.scorecard.overall ?? 'n/a'}`).join(', ') + (bad.length ? ' - minimum is 70' : '')) && ok;
    }
  }
  const id = uid('dep_');
  const needsApproval = ok && env === 'prod';
  run('INSERT INTO deployments (id, org_id, resource_id, resource_name, kind, version, env, status, stages, snapshot, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    id, orgId, res.id, snap.name, res.kind, v, env, !ok ? 'failed' : needsApproval ? 'pending_approval' : 'pending', JSON.stringify(stages), JSON.stringify({ name: snap.name, data }), user.email, now());
  if (needsApproval) {
    run('INSERT INTO approvals (id, org_id, kind, title, detail, payload, requested_by, requested_at) VALUES (?,?,?,?,?,?,?,?)',
      uid('apr_'), orgId, 'deploy', `Release ${snap.name} v${v} to production`, stages.map((s) => `${s.name}: ${s.status} - ${s.detail}`).join('\n'), JSON.stringify({ deploymentId: id }), user.id, now());
  } else if (ok) releaseDeployment(orgId, id, user);
  audit(orgId, user, 'deploy.request', `${snap.name} v${v} -> ${env}`, ok ? (needsApproval ? 'awaiting approval' : 'released') : 'pipeline failed');
  return get('SELECT * FROM deployments WHERE id = ?', id)!;
}
function releaseDeployment(orgId: string, id: string, user: { id: string; email: string }) {
  const d = get('SELECT * FROM deployments WHERE id = ? AND org_id = ?', id, orgId);
  if (!d) return;
  const stages = parse(d.stages, []);
  stages.push({ name: 'Release', status: 'passed', detail: `Released by ${user.email}` });
  run("UPDATE deployments SET status = 'superseded' WHERE org_id = ? AND resource_id = ? AND env = ? AND status = 'live'", orgId, d.resource_id, d.env);
  run("UPDATE deployments SET status = 'live', stages = ? WHERE id = ?", JSON.stringify(stages), id);
  if (d.env === 'prod') run("UPDATE resources SET status = 'published' WHERE id = ? AND org_id = ?", d.resource_id, orgId);
  audit(orgId, user, 'deploy.release', `${d.resource_name} v${d.version} -> ${d.env}`);
}
/** The definition that is live in an environment (falls back to the working copy for "dev" when nothing was released). */
export function liveDefinition(orgId: string, resourceId: string, env?: string): Resource | undefined {
  const res = getResource(orgId, resourceId);
  if (!res || !env || env === 'draft') return res;
  const d = get("SELECT * FROM deployments WHERE org_id = ? AND resource_id = ? AND env = ? AND status = 'live'", orgId, resourceId, env);
  if (!d) return undefined;
  const snap = parse(d.snapshot, {});
  return { ...res, name: snap.name, data: snap.data, version: d.version };
}
