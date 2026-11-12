// AI Agent Builder (wizard + playground), multi-agent crews, and the prompt library.
import { useEffect, useRef, useState } from 'react';
import { DEL, fmtCost, GET, POST, type Res } from '../api.ts';
import { Badge, Fields, RunTrace, Workspace, opts, useAction, useLoad, useRes, type EditorProps, type FieldDef } from '../ui.tsx';

const STEPS = ['Identity', 'Brain', 'Knowledge', 'Tools', 'Memory', 'Output'];
export const modelOptions = (models: Res[]) => [{ value: 'auto', label: 'Automatic routing' }, ...opts(models), { value: 'builtin', label: 'Offline simulator' }];

function AgentEditor({ res, data, set, dirty, readOnly }: EditorProps) {
  const [step, setStep] = useState(0);
  const { kb, table, model, prompt } = useRes('kb', 'table', 'model', 'prompt');
  const { data: tools } = useLoad(() => GET<{ id: string; label: string; description: string }[]>('/agents/tools'), []);
  const defs: FieldDef[][] = [
    [{ key: 'role', label: 'Role', placeholder: 'Invoice Validation Expert', hint: 'Who the agent is.' }, { key: 'goal', label: 'Goal', kind: 'textarea', rows: 2, placeholder: 'Validate invoices and approvals.', hint: 'What it is trying to achieve.' }],
    [{ key: 'instructions', label: 'Instructions', kind: 'textarea', rows: 9, hint: 'Rules, steps and tone. Describe what to do and why, as you would brief a new colleague.' },
      { key: 'promptId', label: 'Prompt template (optional)', kind: 'select', options: opts(prompt), hint: 'A versioned prompt from the prompt library, placed before the instructions.' },
      { key: 'modelId', label: 'Model', kind: 'select', options: modelOptions(model), hint: 'Automatic routing follows the organisation policy and falls back when a provider fails.' }],
    [{ key: 'kbIds', label: 'Knowledge bases the agent may search', kind: 'multi', options: opts(kb), hint: 'No knowledge bases yet. Create one under Knowledge.' }],
    [{ key: 'tools', label: 'Tools the agent may use', kind: 'multi', options: (tools ?? []).map((t) => ({ value: t.id, label: t.label, hint: t.description })) },
      { key: 'tableIds', label: 'Tables the database tools may touch', kind: 'multi', options: opts(table), hint: 'No tables yet. Create one under Data tables.', show: (v) => (v.tools ?? []).some((t: string) => t.startsWith('table_')) }],
    [{ key: 'memory.conversation', label: 'Conversation memory', kind: 'bool', hint: 'Remember earlier messages in the same conversation.' },
      { key: 'memory.shortTerm', label: 'Short-term window (turns)', kind: 'number', placeholder: '6', hint: 'How many recent exchanges are sent to the model.' },
      { key: 'memory.longTerm', label: 'Long-term memory', kind: 'bool', hint: 'Lets the agent save durable facts with the "Long-term memory" tool and recall them in every conversation.' }],
    [{ key: 'outputFormat', label: 'Output format', kind: 'select', options: [{ value: 'text', label: 'Plain text' }, { value: 'markdown', label: 'Markdown' }, { value: 'json', label: 'JSON' }] },
      { key: 'outputSchema', label: 'JSON shape', kind: 'textarea', placeholder: '{"decision": "approve | reject", "reason": "string"}', show: (v) => v.outputFormat === 'json' }],
  ];
  const warn = step === 3 && (data.tools ?? []).includes('knowledge_search') && !(data.kbIds ?? []).length ? 'Knowledge search is ticked but no knowledge base is attached.' : step === 4 && (data.memory?.longTerm && !(data.tools ?? []).includes('remember')) ? 'Tick the "Long-term memory" tool so the agent can save facts.' : '';
  return (
    <div className="split" style={{ gridTemplateColumns: 'minmax(0, 1.1fr) minmax(0, 1fr)' }}>
      <div className="card col">
        <div className="steps">{STEPS.map((s, i) => <button key={s} className={i === step ? 'on' : ''} onClick={() => setStep(i)}>{i + 1}. {s}</button>)}</div>
        <fieldset disabled={readOnly} style={{ border: 0, padding: 0, margin: 0 }}><Fields defs={defs[step]} value={data} onChange={(v) => set(v)} /></fieldset>
        {warn && <div className="notice warn">{warn}</div>}
        <div className="row spread"><button className="btn" disabled={step === 0} onClick={() => setStep(step - 1)}>Previous</button><button className="btn" disabled={step === STEPS.length - 1} onClick={() => setStep(step + 1)}>Next</button></div>
        {step === 4 && data.memory?.longTerm && <LongTermMemory agent={res} readOnly={readOnly} />}
      </div>
      <Playground agent={res} dirty={dirty} />
    </div>
  );
}

function LongTermMemory({ agent, readOnly }: { agent: Res; readOnly: boolean }) {
  const { data, reload } = useLoad(() => GET<any[]>(`/agents/${agent.id}/memory`), [agent.id]);
  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="row spread"><h4>Remembered facts</h4>{!readOnly && !!data?.length && <button className="btn sm danger" onClick={() => confirm('Erase everything this agent remembers, including conversations?') && DEL(`/agents/${agent.id}/memory`).then(reload)}>Erase memory</button>}</div>
      {data?.length ? data.map((m) => <div key={m.id} className="small">- {m.content}</div>) : <p className="muted small">Nothing remembered yet.</p>}
    </div>
  );
}

function Playground({ agent, dirty }: { agent: Res; dirty: boolean }) {
  const [msgs, setMsgs] = useState<{ role: string; text: string; meta?: any }[]>([]);
  const [text, setText] = useState('');
  const [trace, setTrace] = useState<any>(null);
  const session = useRef(`play-${Math.random().toString(36).slice(2)}`);
  const { busy, act } = useAction();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { box.current?.scrollTo({ top: box.current.scrollHeight }); }, [msgs, busy]);
  const send = () => {
    const message = text.trim();
    if (!message) return;
    setText(''); setMsgs((m) => [...m, { role: 'user', text: message }]);
    void act(async () => { const r = await POST(`/agents/${agent.id}/chat`, { message, sessionId: session.current }); setMsgs((m) => [...m, { role: r.blocked ? 'blocked' : 'bot', text: r.output, meta: r }]); setTrace(r); });
  };
  return (
    <div className="card col">
      <div className="row spread"><h3>Playground</h3><button className="btn sm" onClick={() => { setMsgs([]); setTrace(null); session.current = `play-${Math.random().toString(36).slice(2)}`; }}>New conversation</button></div>
      {dirty && <div className="notice warn">The playground uses the last saved version. Save to test your changes.</div>}
      <div className="chat" aria-live="polite" ref={box}>
        {!msgs.length && <p className="muted small">Send a message to test the agent. Each reply shows which model answered, the tools it called and what the guardrails did.</p>}
        {msgs.map((m, i) => <div key={i} className={`msg ${m.role === 'user' ? 'user' : m.role === 'blocked' ? 'bot blocked' : 'bot'}`}>{m.text}</div>)}
        {busy && <div className="msg bot muted">Working</div>}
      </div>
      <form className="row" onSubmit={(e) => { e.preventDefault(); send(); }}>
        <input aria-label="Message" value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask the agent something" /><button className="btn primary" disabled={busy || !text.trim()}>Send</button>
      </form>
      {trace && (
        <details open>
          <summary className="small muted">Last reply: {trace.model} · {trace.tokensIn + trace.tokensOut} tokens · {fmtCost(trace.cost)} · {trace.latencyMs} ms{trace.jsonValid === false ? ' · output is not valid JSON' : ''}</summary>
          <div style={{ marginTop: 8 }}><RunTrace steps={trace.steps} /></div>
        </details>
      )}
    </div>
  );
}

export const Agents = ({ id }: { id?: string }) => (
  <Workspace kind="agent" id={id} base="/agents" title="Agents" noun="agent" blurb="Create AI agents with a role, a goal, instructions, knowledge, tools, memory and an output format. Test them in the playground before releasing."
    blank={() => ({ role: '', goal: '', instructions: '', modelId: 'auto', kbIds: [], tools: [], tableIds: [], memory: { conversation: true, shortTerm: 6, longTerm: false }, outputFormat: 'text' })}
    Editor={AgentEditor} describe={(r) => r.data.role || 'No role yet'} />
);

// ---------- multi-agent crews ----------
function CrewEditor({ res, data, set, dirty, readOnly }: EditorProps) {
  const { agent } = useRes('agent');
  const members: any[] = data.members ?? [];
  const put = (i: number, p: any) => set({ members: members.map((m, j) => (j === i ? { ...m, ...p } : m)) });
  const [goal, setGoal] = useState('');
  const [run, setRun] = useState<any>(null);
  const { busy, act } = useAction();
  return (
    <div className="split" style={{ gridTemplateColumns: 'minmax(0, 1.2fr) minmax(0, 1fr)' }}>
      <div className="col">
        <div className="card col">
          <h3>Collaboration order</h3>
          <p className="muted small">Agents work in sequence. Each receives the goal and the hand-off from the agent before it. A reviewer can send work back to the previous agent by starting its answer with REJECTED (at most twice).</p>
          {members.map((m, i) => (
            <div key={i} className="card flat col" style={{ gap: 8 }}>
              <div className="row"><span className="badge info">{i + 1}</span>
                <select aria-label="Agent" value={m.agentId ?? ''} disabled={readOnly} onChange={(e) => put(i, { agentId: e.target.value })}><option value="">Choose an agent</option>{agent.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
                <input aria-label="Title" placeholder="Title, e.g. Planner" value={m.title ?? ''} disabled={readOnly} onChange={(e) => put(i, { title: e.target.value })} />
                {!readOnly && <button className="btn sm ghost danger" onClick={() => set({ members: members.filter((_, j) => j !== i) })}>Remove</button>}
              </div>
              <textarea aria-label="Task" rows={2} placeholder="What this agent contributes" value={m.task ?? ''} disabled={readOnly} onChange={(e) => put(i, { task: e.target.value })} />
              {i > 0 && <label className="check small"><input type="checkbox" checked={!!m.reviewer} disabled={readOnly} onChange={(e) => put(i, { reviewer: e.target.checked })} /><span>Reviewer: may escalate work back to agent {i}</span></label>}
            </div>
          ))}
          {!readOnly && <div><button className="btn" onClick={() => set({ members: [...members, { agentId: '', title: '', task: '' }] })}>Add agent</button></div>}
          <label className="check"><input type="checkbox" checked={!!data.humanApproval} disabled={readOnly} onChange={(e) => set({ humanApproval: e.target.checked })} /><span>Human in the loop<small>Pause for a person to approve the result before the run completes.</small></span></label>
        </div>
      </div>
      <div className="card col">
        <h3>Run the crew</h3>
        {dirty && <div className="notice warn">Save first: runs use the saved version.</div>}
        <label className="field">Goal<textarea value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="Describe what the crew should deliver" /></label>
        <div><button className="btn primary" disabled={busy || !goal.trim() || !members.length} onClick={() => act(async () => setRun(await POST(`/crews/${res.id}/run`, { goal })))}>{busy ? 'Agents are working' : 'Start'}</button></div>
        {run && <>
          <div className="row"><b>Run</b><Badge status={run.status} />{run.status === 'waiting' && <a href="#/approvals" className="small">Open approvals</a>}</div>
          <RunTrace steps={run.steps} />
          {run.output && <div className="col" style={{ gap: 4 }}><h4>Result</h4><pre>{typeof run.output === 'string' ? run.output : JSON.stringify(run.output, null, 2)}</pre></div>}
        </>}
      </div>
    </div>
  );
}
export const Crews = ({ id }: { id?: string }) => (
  <Workspace kind="crew" id={id} base="/crews" title="Agent crews" noun="crew" blurb="Orchestrate several agents on one goal: planner, developer, tester, approver. Agents hand work to each other, reviewers escalate, and a person can approve the result."
    blank={() => ({ members: [], humanApproval: true })} Editor={CrewEditor} describe={(r) => `${r.data.members?.length ?? 0} agent(s)${r.data.humanApproval ? ', human approval' : ''}`} />
);

// ---------- prompt library ----------
function PromptEditor({ data, set, readOnly }: EditorProps) {
  const { model } = useRes('model');
  const [input, setInput] = useState('');
  const [modelId, setModelId] = useState('auto');
  const [out, setOut] = useState<any>(null);
  const { busy, act } = useAction();
  return (
    <div className="split" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)' }}>
      <div className="card col">
        <fieldset disabled={readOnly} style={{ border: 0, padding: 0, margin: 0 }}>
          <Fields defs={[{ key: 'description', label: 'What this prompt is for' }, { key: 'text', label: 'Prompt', kind: 'textarea', rows: 12 }]} value={data} onChange={(v) => set(v)} />
        </fieldset>
        <p className="muted small">Every save creates a version (see History). Agents that use this template pick up the latest saved version.</p>
      </div>
      <div className="card col">
        <h3>Try it</h3>
        <label className="field">Input<textarea rows={5} value={input} onChange={(e) => setInput(e.target.value)} placeholder="Text to apply the prompt to" /></label>
        <div className="row"><select aria-label="Model" value={modelId} onChange={(e) => setModelId(e.target.value)} style={{ maxWidth: 240 }}>{modelOptions(model).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
          <button className="btn primary" disabled={busy || !input.trim()} onClick={() => act(async () => setOut(await POST('/llm/complete', { system: data.text, prompt: input, modelId })))}>Run</button></div>
        {out && <><p className="muted small">{out.model} · {out.tokensIn + out.tokensOut} tokens · {fmtCost(out.cost)} · {out.latencyMs} ms</p><pre>{out.text}</pre></>}
      </div>
    </div>
  );
}
export const Prompts = ({ id }: { id?: string }) => (
  <Workspace kind="prompt" id={id} base="/prompts" title="Prompts" noun="prompt" blurb="A versioned library of prompt templates that agents can share." blank={() => ({ description: '', text: '' })} Editor={PromptEditor} describe={(r) => r.data.description || ''} />
);
