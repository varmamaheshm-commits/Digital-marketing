// Testing platform: AI/agent evaluations, API, UI and load tests, with a scorecard and regression history.
import { useState } from 'react';
import { fmtCost, fmtDate, GET, POST } from '../api.ts';
import { Badge, BarChart, Fields, Tabs, Workspace, opts, useAction, useLoad, useRes, type EditorProps } from '../ui.tsx';

const TYPES = [{ value: 'agent', label: 'AI agent evaluation' }, { value: 'api', label: 'API test' }, { value: 'ui', label: 'UI test (runs a bot)' }, { value: 'load', label: 'Load / stress test' }];
const CARD: [string, string][] = [['quality', 'Quality'], ['performance', 'Performance'], ['security', 'Security'], ['compliance', 'Compliance']];

export function Scorecard({ card }: { card: Record<string, number | null> }) {
  return (
    <div className="grid g4">
      {CARD.map(([k, label]) => (
        <div key={k} className="card flat score">
          <div className="row spread"><span className="small muted">{label} score</span><b className="num">{card[k] == null ? 'n/a' : card[k]}</b></div>
          <div className="bar"><i style={{ width: `${card[k] ?? 0}%` }} /></div>
        </div>
      ))}
    </div>
  );
}

function SuiteEditor({ res, data, set, dirty, readOnly }: EditorProps) {
  const { agent, bot } = useRes('agent', 'bot');
  const { data: cat } = useLoad(() => GET('/tests/catalog'), []);
  const { data: history, reload } = useLoad(() => GET<any[]>(`/runs?kind=test&resource=${res.id}&limit=20`), [res.id]);
  const [tab, setTab] = useState('Cases');
  const [result, setResult] = useState<any>(null);
  const { busy, act } = useAction();
  const type = data.type ?? 'agent';
  const cases: any[] = data.cases ?? [];
  const put = (i: number, p: any) => set({ cases: cases.map((c, j) => (j === i ? { ...c, ...p } : c)) });
  const checks = cat?.checks ?? {};
  const runIt = () => act(async () => { setResult(await POST(`/tests/${res.id}/run`)); setTab('Results'); reload(); });
  const prev = history?.[1]?.output?.scorecard?.overall;
  return (
    <div className="col">
      <div className="card col">
        <fieldset disabled={readOnly} style={{ border: 0, padding: 0, margin: 0 }}>
          <Fields columns={2} value={data} onChange={(v) => set(v)} defs={[
            { key: 'type', label: 'Suite type', kind: 'select', options: TYPES },
            { key: 'targetId', label: 'Agent under test', kind: 'select', options: opts(agent), show: (v) => (v.type ?? 'agent') === 'agent', hint: 'Suites linked to an agent also gate its release to TEST, UAT and PROD (minimum score 70).' },
            { key: 'url', label: 'URL to load', show: (v) => v.type === 'load', placeholder: 'https://your-app.example.com/health' },
            { key: 'requests', label: 'Requests (max 300)', kind: 'number', show: (v) => v.type === 'load', placeholder: '50' },
            { key: 'concurrency', label: 'Concurrent users (max 25)', kind: 'number', show: (v) => v.type === 'load', placeholder: '5' },
            { key: 'maxP95Ms', label: 'Pass when p95 is under (ms)', kind: 'number', show: (v) => v.type === 'load', placeholder: '1000' },
            { key: 'maxErrorRate', label: 'Pass when errors are under (%)', kind: 'number', show: (v) => v.type === 'load', placeholder: '1' },
          ]} />
        </fieldset>
        {type === 'load' && <p className="muted small">Only test systems you own or are authorised to test. The limits keep this a check of your own service, not a traffic generator.</p>}
        <div className="row"><button className="btn primary" disabled={busy || dirty} onClick={() => void runIt()}>{busy ? 'Running tests' : 'Run suite'}</button>{dirty && <span className="muted small">Save before running.</span>}</div>
      </div>
      <Tabs tabs={type === 'load' ? ['Results', 'History'] : ['Cases', 'Results', 'History']} value={type === 'load' && tab === 'Cases' ? 'Results' : tab} onChange={setTab} />

      {tab === 'Cases' && type !== 'load' && (
        <div className="col">
          {cases.map((c, i) => (
            <div key={i} className="card col" style={{ gap: 8 }}>
              <div className="row"><input aria-label="Case name" placeholder="Case name" value={c.name ?? ''} disabled={readOnly} onChange={(e) => put(i, { name: e.target.value })} />{!readOnly && <button className="btn sm ghost danger" onClick={() => set({ cases: cases.filter((_, j) => j !== i) })}>Remove</button>}</div>
              {type === 'agent' && <>
                <textarea aria-label="Input" rows={2} placeholder="What the user says to the agent" value={c.input ?? ''} disabled={readOnly} onChange={(e) => put(i, { input: e.target.value })} />
                {(c.checks ?? []).map((ch: any, k: number) => (
                  <div className="row" key={k}>
                    <select aria-label="Check" value={ch.type} disabled={readOnly} onChange={(e) => put(i, { checks: c.checks.map((x: any, m: number) => (m === k ? { ...x, type: e.target.value } : x)) })}>{Object.entries(checks).map(([id, d]: any) => <option key={id} value={id}>{d.label}</option>)}</select>
                    <input aria-label="Expected value" placeholder={checks[ch.type]?.hint || 'no value needed'} value={ch.value ?? ''} disabled={readOnly} onChange={(e) => put(i, { checks: c.checks.map((x: any, m: number) => (m === k ? { ...x, value: e.target.value } : x)) })} />
                    <Badge status="">{checks[ch.type]?.category}</Badge>
                    {!readOnly && <button className="btn sm ghost" onClick={() => put(i, { checks: c.checks.filter((_: any, m: number) => m !== k) })}>Remove</button>}
                  </div>
                ))}
                {!readOnly && <div><button className="btn sm" onClick={() => put(i, { checks: [...(c.checks ?? []), { type: 'contains', value: '' }] })}>Add check</button></div>}
              </>}
              {type === 'api' && <Fields columns={3} value={c} onChange={(v) => put(i, v)} defs={[{ key: 'method', label: 'Method', kind: 'select', options: ['GET', 'POST', 'PUT', 'DELETE'].map((m) => ({ value: m, label: m })) }, { key: 'url', label: 'URL' }, { key: 'expectStatus', label: 'Expected status', kind: 'number', placeholder: '200' }, { key: 'body', label: 'JSON body' }, { key: 'expectContains', label: 'Response contains' }, { key: 'maxMs', label: 'Slower than (ms) fails', kind: 'number' }]} />}
              {type === 'ui' && <Fields columns={3} value={c} onChange={(v) => put(i, v)} defs={[{ key: 'botId', label: 'Bot that walks through the screen', kind: 'select', options: opts(bot) }, { key: 'expectVar', label: 'Variable the bot read', placeholder: 'heading' }, { key: 'expectContains', label: 'Must contain' }]} />}
            </div>
          ))}
          {!readOnly && (
            <div className="row wrap">
              <button className="btn" onClick={() => set({ cases: [...cases, type === 'agent' ? { name: '', input: '', checks: [{ type: 'contains', value: '' }] } : type === 'api' ? { name: '', method: 'GET', url: '', expectStatus: 200 } : { name: '', botId: '' }] })}>Add case</button>
              {type === 'agent' && <button className="btn" onClick={() => set({ cases: [...cases, ...(cat?.redTeam ?? [])] })}>Add the red-team pack</button>}
            </div>
          )}
          {type === 'agent' && <p className="muted small">The red-team pack adds prompt-injection, jailbreak, data-leakage, personal-data and toxicity cases. "Grounded" and "similar to" are word-overlap heuristics, useful for catching regressions rather than as an absolute measure of truth.</p>}
        </div>
      )}

      {tab === 'Results' && (result ? (
        <div className="col">
          <div className="row"><h3>{result.passed} of {result.total} case(s) passed</h3><Badge status={result.passed === result.total ? 'passed' : 'failed'} />{prev != null && result.scorecard.overall != null && <span className="muted small">Overall {result.scorecard.overall} (previous run {prev}, {result.scorecard.overall - prev >= 0 ? '+' : ''}{result.scorecard.overall - prev})</span>}</div>
          <Scorecard card={result.scorecard} />
          {result.metrics && <div className="grid g4">{[['p50', 'Median (ms)'], ['p95', '95th percentile (ms)'], ['rps', 'Requests per second'], ['errorRate', 'Errors (%)']].map(([k, l]) => <div key={k} className="card stat"><b>{result.metrics[k]}</b><span>{l}</span></div>)}</div>}
          {result.cases.map((c: any, i: number) => (
            <details key={i} className="card" open={!c.pass}>
              <summary className="row spread" style={{ cursor: 'pointer' }}><b>{c.name}</b><span className="row"><span className="muted small num">{c.latencyMs} ms{c.cost ? ` · ${fmtCost(c.cost)}` : ''}</span><Badge status={c.pass ? 'passed' : 'failed'} /></span></summary>
              <div className="col" style={{ marginTop: 10, gap: 6 }}>
                {c.checks.map((ch: any, k: number) => <div key={k} className="row top small"><span style={{ minWidth: 64 }}><Badge status={ch.pass ? 'pass' : 'fail'} /></span><span><b>{checks[ch.type]?.label ?? ch.type}</b> <span className="muted">({ch.category})</span><br />{ch.detail}</span></div>)}
                {c.output && <pre className="small muted">{c.output}</pre>}
              </div>
            </details>
          ))}
        </div>
      ) : <p className="muted">Run the suite to see results and the scorecard.</p>)}

      {tab === 'History' && (history?.length ? (
        <div className="col">
          <div className="card col"><h3>Overall score by run (regression view)</h3><BarChart data={[...history].reverse().map((h) => ({ label: h.startedAt.slice(5, 10), values: [h.output?.scorecard?.overall ?? 0] }))} series={[{ name: 'Overall score', color: 'var(--series-1)' }]} /></div>
          <div className="table-wrap"><table><thead><tr><th>Run</th><th>Status</th><th className="num">Passed</th><th className="num">Quality</th><th className="num">Performance</th><th className="num">Security</th><th className="num">Compliance</th></tr></thead><tbody>
            {history.map((h) => <tr key={h.id} className="click" onClick={() => { setResult(h.output); setTab('Results'); }}><td>{fmtDate(h.startedAt)}</td><td><Badge status={h.status === 'succeeded' ? 'passed' : 'failed'} /></td><td className="num">{h.output?.passed}/{h.output?.total}</td>{CARD.map(([k]) => <td key={k} className="num">{h.output?.scorecard?.[k] ?? 'n/a'}</td>)}</tr>)}
          </tbody></table></div>
        </div>
      ) : <p className="muted">No runs yet.</p>)}
    </div>
  );
}

export const Testing = ({ id }: { id?: string }) => (
  <Workspace kind="testsuite" id={id} base="/testing" title="Testing" noun="test suite" blurb="Evaluate agents for accuracy, hallucination, prompt injection, data leakage, toxicity and bias; test APIs and screens; run load tests. Every run produces a quality, performance, security and compliance scorecard."
    blank={() => ({ type: 'agent', targetId: '', cases: [] })} Editor={SuiteEditor} describe={(r) => `${TYPES.find((t) => t.value === (r.data.type ?? 'agent'))?.label} · ${r.data.type === 'load' ? r.data.url ?? '' : `${r.data.cases?.length ?? 0} case(s)`}`} />
);
