// AI model management: providers, routing, fallback, cost rates and benchmarking.
import { useState } from 'react';
import { api, fmtCost, GET, POST, listRes } from '../api.ts';
import { Badge, Fields, PageHead, Workspace, opts, useAction, useApp, useLoad, useRes, type EditorProps } from '../ui.tsx';

function ModelEditor({ res, data, set, readOnly }: EditorProps) {
  const { data: cat } = useLoad(() => GET('/models/catalog'), []);
  const { data: secrets } = useLoad(() => GET<any[]>('/secrets').catch(() => []), []);
  const { model } = useRes('model');
  const [out, setOut] = useState<any>(null);
  const { busy, act } = useAction();
  return (
    <div className="split" style={{ gridTemplateColumns: 'minmax(0, 1.2fr) minmax(0, 1fr)' }}>
      <div className="card col">
        <fieldset disabled={readOnly} style={{ border: 0, padding: 0, margin: 0 }}>
          <Fields columns={2} value={data} onChange={(v) => set(v)} defs={[
            { key: 'provider', label: 'Provider', kind: 'select', options: (cat?.providers ?? []).map((p: any) => ({ value: p.id, label: p.label })) },
            { key: 'modelId', label: 'Model id', placeholder: data.provider === 'anthropic' ? 'claude-opus-5-5' : 'the id your provider documents', hint: 'Exactly as the provider names it.' },
            { key: 'baseUrl', label: 'Base URL', wide: true, placeholder: data.provider === 'anthropic' ? 'Leave empty for the Claude API' : cat?.defaults?.[data.provider] ?? 'https://your-endpoint/v1', hint: data.provider === 'azure_openai' || data.provider === 'custom' ? 'Required: the chat-completions compatible endpoint of your deployment.' : 'Leave empty to use the provider default.' },
            { key: 'secretName', label: 'API key (from the secrets vault)', kind: 'select', options: (secrets ?? []).map((s) => ({ value: s.name, label: s.name })), hint: 'Add keys under Security, Secrets vault. Keys are never stored in the model definition.' },
            { key: 'priority', label: 'Routing priority', kind: 'number', placeholder: '1', hint: 'Lower numbers are tried first.' },
            { key: 'inCost', label: 'Input price (USD per million tokens)', kind: 'number' },
            { key: 'outCost', label: 'Output price (USD per million tokens)', kind: 'number' },
            { key: 'fallbackId', label: 'Fallback model', kind: 'select', options: opts(model.filter((m) => m.id !== res.id)), hint: 'Used when this model fails and an agent is pinned to it.' },
            { key: 'enabled', label: 'Available for automatic routing', kind: 'bool' },
          ]} />
        </fieldset>
        <p className="muted small">Prices are entered by you from your provider's price list and drive the cost figures everywhere in the platform.</p>
      </div>
      <div className="card col">
        <h3>Connection test</h3>
        <p className="muted small">Sends one short prompt to the saved configuration.</p>
        <div><button className="btn primary" disabled={busy} onClick={() => act(async () => setOut(await POST('/llm/complete', { prompt: 'Reply with the single word: ready', modelId: res.id })))}>Test</button></div>
        {out && (out.model === res.name
          ? <div className="notice good small">Connected. Reply: "{out.text.slice(0, 200)}" · {out.latencyMs} ms · {fmtCost(out.cost)}</div>
          : <div className="notice bad small">The model did not answer: {out.attempts?.find((a: any) => !a.ok)?.error ?? 'unknown error'}. The request was answered by {out.model} instead.</div>)}
      </div>
    </div>
  );
}

function Overview() {
  const { me, reloadMe, toast } = useApp();
  const { model } = useRes('model');
  const [prompt, setPrompt] = useState('Explain in two sentences what a purchase order is.');
  const [picked, setPicked] = useState<string[]>(['builtin']);
  const [rows, setRows] = useState<any[] | null>(null);
  const { busy, act } = useAction();
  const s = me.org.settings;
  const save = (settings: any) => api('PATCH', '/org', { settings }).then(() => { reloadMe(); toast('Routing policy saved'); }, (e) => toast(e.message, true));
  const all = [...model.map((m) => ({ id: m.id, name: m.name })), { id: 'builtin', name: 'Offline simulator' }];
  return (
    <div className="grid g2">
      <div className="card col">
        <h3>Routing policy</h3>
        <p className="muted small">Applies to agents set to "Automatic routing". When a model fails, the next one is tried; every attempt is recorded under Cost and usage.</p>
        <fieldset disabled={me.user.role !== 'admin'} style={{ border: 0, padding: 0, margin: 0 }} className="col">
          <label className="field">Order<select value={s.routing ?? 'priority'} onChange={(e) => save({ routing: e.target.value })}><option value="priority">By priority number</option><option value="cost">Cheapest first (cost optimisation)</option></select></label>
          <label className="check"><input type="checkbox" checked={s.simulatorFallback !== false} onChange={(e) => save({ simulatorFallback: e.target.checked })} /><span>Fall back to the offline simulator<small>When every provider fails, answer from retrieved data instead of returning an error.</small></span></label>
        </fieldset>
        {!model.length && <div className="notice small">No provider is connected, so agents answer with the offline simulator: it retrieves from knowledge bases and tables but does not generate language. Add a model to get real answers.</div>}
      </div>
      <div className="card col">
        <h3>Benchmark</h3>
        <label className="field">Prompt<textarea rows={2} value={prompt} onChange={(e) => setPrompt(e.target.value)} /></label>
        <div className="row wrap">{all.map((m) => <label key={m.id} className="check small"><input type="checkbox" checked={picked.includes(m.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, m.id] : picked.filter((x) => x !== m.id))} />{m.name}</label>)}</div>
        <div><button className="btn primary" disabled={busy || !picked.length || !prompt.trim()} onClick={() => act(async () => setRows(await POST('/models/benchmark', { prompt, modelIds: picked })))}>{busy ? 'Running' : 'Compare'}</button></div>
        {rows && <div className="table-wrap"><table><thead><tr><th>Model</th><th>Result</th><th className="num">Latency</th><th className="num">Tokens</th><th className="num">Cost</th></tr></thead><tbody>
          {rows.map((r) => <tr key={r.id}><td>{r.name}</td><td>{r.ok ? <span className="small">{r.text.slice(0, 220)}</span> : <Badge status="failed">{r.error.slice(0, 80)}</Badge>}</td><td className="num">{r.latencyMs} ms</td><td className="num">{r.tokensIn + r.tokensOut}</td><td className="num">{fmtCost(r.cost)}</td></tr>)}
        </tbody></table></div>}
      </div>
    </div>
  );
}

export function Models({ id }: { id?: string }) {
  return (
    <div className="col gap-lg">
      <Workspace kind="model" id={id} base="/models" title="Models" noun="model" blurb="Connect Claude, OpenAI, Azure OpenAI, Gemini, Mistral, DeepSeek or self-hosted Llama models. Only administrators can change model connections."
        blank={() => ({ provider: 'anthropic', modelId: 'claude-opus-5-5', baseUrl: '', secretName: '', inCost: 4, outCost: 20, priority: 1, enabled: true })} Editor={ModelEditor}
        describe={(r) => `${r.data.provider} · ${r.data.modelId}${r.data.enabled === false ? ' · not routed' : ''}`} />
      {!id && <Overview />}
    </div>
  );
}
export { listRes };
