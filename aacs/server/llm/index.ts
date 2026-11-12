// AI orchestration: model registry, routing, fallback, usage + cost tracking.
import { getResource, listResources, now, orgSettings, run, uid, type Resource } from '../db.ts';
import { getSecret } from '../sec.ts';
import { claudeChat } from './claude.ts';
import { compatChat } from './compat.ts';
import type { ChatRequest, ChatResult, ModelCfg } from './types.ts';
export type { ChatRequest, ChatResult, Msg, ToolCall, ToolDef } from './types.ts';

const est = (s: string) => Math.ceil(s.length / 4);

/** Built-in offline model. Deterministic: it calls the knowledge / table tools it is given and answers from their results.
 *  It lets every feature be exercised without a provider key; it is not a language model. */
function simulator(req: ChatRequest): ChatResult {
  const lastUser = [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  const lastUserIdx = req.messages.map((m) => m.role).lastIndexOf('user');
  const results = req.messages.slice(lastUserIdx + 1).filter((m) => m.role === 'tool');
  const called = new Set(req.messages.slice(lastUserIdx + 1).flatMap((m) => m.toolCalls ?? []).map((c) => c.name));
  const tool = (n: string) => req.tools?.find((t) => t.name === n);
  const calls: ChatResult['toolCalls'] = [];
  if (tool('knowledge_search') && !called.has('knowledge_search')) calls.push({ id: uid('call_'), name: 'knowledge_search', input: { query: lastUser.slice(0, 300) } });
  const tq = tool('table_query');
  const table = (tq?.schema.properties?.table?.enum as string[] | undefined)?.find((n) => lastUser.toLowerCase().includes(n.toLowerCase()));
  if (tq && table && !called.has('table_query')) calls.push({ id: uid('call_'), name: 'table_query', input: { table } });
  const tokensIn = est(req.system + req.messages.map((m) => m.content).join(' '));
  if (calls.length) return { text: '', toolCalls: calls, tokensIn, tokensOut: 20 };

  const useful = results.filter((r) => !r.isError && r.content && !/^No (matching|records)/.test(r.content));
  const role = /Role: (.+)/.exec(req.system)?.[1] ?? 'assistant';
  let answer = useful.length
    ? `Here is what I found:\n\n${useful.map((r) => r.content.slice(0, 900)).join('\n\n')}`
    : `As ${role}, I received: "${lastUser.slice(0, 400)}". No stored knowledge matched this request, so I cannot give a grounded answer.`;
  answer += '\n\n(Offline simulator response - connect a model provider under Models for generated answers.)';
  if (/valid JSON/.test(req.system)) answer = JSON.stringify({ answer, sources: useful.length });
  return { text: answer, toolCalls: [], tokensIn, tokensOut: est(answer) };
}

export const SIMULATOR = { id: 'builtin', name: 'Offline simulator', provider: 'builtin', modelId: 'simulator' };

function cfgOf(orgId: string, m: Resource): ModelCfg {
  const d = m.data;
  return { name: m.name, provider: d.provider, modelId: d.modelId, baseUrl: d.baseUrl || undefined, apiKey: d.secretName ? getSecret(orgId, d.secretName) : undefined, inCost: +d.inCost || 0, outCost: +d.outCost || 0 };
}
function chain(orgId: string, modelId?: string): Resource[] {
  const enabled = listResources(orgId, 'model').filter((m) => m.data.enabled !== false);
  if (modelId && modelId !== 'auto') {
    if (modelId === 'builtin') return [];
    const out: Resource[] = [];
    let cur = getResource(orgId, modelId, 'model');
    while (cur && out.length < 4 && !out.some((o) => o.id === cur!.id)) {
      out.push(cur);
      cur = cur.data.fallbackId ? getResource(orgId, cur.data.fallbackId, 'model') : undefined;
    }
    return out;
  }
  const byCost = orgSettings(orgId).routing === 'cost';
  return enabled.sort((a, b) => byCost ? (+a.data.inCost + +a.data.outCost) - (+b.data.inCost + +b.data.outCost) : (+a.data.priority || 99) - (+b.data.priority || 99));
}

export interface Completion extends ChatResult { model: string; provider: string; cost: number; latencyMs: number; attempts: { model: string; ok: boolean; error?: string }[] }

export async function complete(orgId: string, req: ChatRequest & { modelId?: string; source?: string }): Promise<Completion> {
  const attempts: Completion['attempts'] = [];
  const record = (model: string, provider: string, r: ChatResult | null, cost: number, ms: number) =>
    run('INSERT INTO usage (id, org_id, model, provider, source, tokens_in, tokens_out, cost, latency_ms, ok, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      uid('u_'), orgId, model, provider, req.source ?? '', r?.tokensIn ?? 0, r?.tokensOut ?? 0, cost, ms, r ? 1 : 0, now());
  for (const m of chain(orgId, req.modelId)) {
    const cfg = cfgOf(orgId, m);
    const t = Date.now();
    try {
      const r = cfg.provider === 'anthropic' ? await claudeChat(cfg, req) : await compatChat(cfg, req);
      const cost = (r.tokensIn * cfg.inCost + r.tokensOut * cfg.outCost) / 1e6;
      const latencyMs = Date.now() - t;
      record(m.name, cfg.provider, r, cost, latencyMs);
      attempts.push({ model: m.name, ok: true });
      return { ...r, model: m.name, provider: cfg.provider, cost, latencyMs, attempts };
    } catch (e: any) {
      record(m.name, cfg.provider, null, 0, Date.now() - t);
      attempts.push({ model: m.name, ok: false, error: String(e?.message ?? e).slice(0, 300) });
    }
  }
  if (attempts.length && orgSettings(orgId).simulatorFallback === false) throw new Error(`All models failed: ${attempts.map((a) => `${a.model}: ${a.error}`).join('; ')}`);
  const t = Date.now();
  const r = simulator(req);
  record(SIMULATOR.name, 'builtin', r, 0, Date.now() - t);
  attempts.push({ model: SIMULATOR.name, ok: true });
  return { ...r, model: SIMULATOR.name, provider: 'builtin', cost: 0, latencyMs: Date.now() - t, attempts };
}
