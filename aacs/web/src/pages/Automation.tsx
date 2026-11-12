// Workflow automation, the RPA bot designer, and REST connectors.
import { useState } from 'react';
import { fmtDate, GET, POST, type Res } from '../api.ts';
import { Badge, Fields, FlowDesigner, RunTrace, Tabs, Workspace, opts, useAction, useApp, useLoad, useRes, type EditorProps, type FieldDef, type StepType } from '../ui.tsx';

const OPS = [['equals', 'equals'], ['not_equals', 'does not equal'], ['contains', 'contains'], ['not_contains', 'does not contain'], ['greater', 'is greater than'], ['less', 'is less than'], ['empty', 'is empty'], ['not_empty', 'is not empty']].map(([value, label]) => ({ value, label }));
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => ({ value: m, label: m }));
const conditionFields: FieldDef[] = [
  { key: 'left', label: 'Value', placeholder: '{{trigger.amount}}' }, { key: 'op', label: 'Test', kind: 'select', options: OPS }, { key: 'right', label: 'Compared with', show: (v) => !['empty', 'not_empty'].includes(v.op) },
  { key: 'onFalse', label: 'When the test is false', kind: 'select', options: [{ value: 'skip', label: 'Skip the next step(s)' }, { value: 'stop', label: 'Stop here' }] }, { key: 'skip', label: 'Steps to skip', kind: 'number', placeholder: '1', show: (v) => v.onFalse !== 'stop' },
];

function History({ res, kind }: { res: Res; kind: string }) {
  const { data } = useLoad(() => GET<any[]>(`/runs?kind=${kind}&resource=${res.id}&limit=15`), [res.id]);
  const [open, setOpen] = useState<string | null>(null);
  if (!data?.length) return <p className="muted small">No runs yet.</p>;
  return (
    <div className="col" style={{ gap: 6 }}>
      {data.map((r) => (
        <div key={r.id} className="card flat">
          <button className="btn ghost sm" style={{ width: '100%', justifyContent: 'space-between' }} onClick={() => setOpen(open === r.id ? null : r.id)}><span>{fmtDate(r.startedAt)}</span><Badge status={r.status} /></button>
          {open === r.id && <div style={{ marginTop: 8 }}><RunTrace steps={r.steps} /></div>}
        </div>
      ))}
    </div>
  );
}

function WorkflowEditor({ res, data, set, dirty, readOnly }: EditorProps) {
  const { me } = useApp();
  const { agent, bot, table } = useRes('agent', 'bot', 'table');
  const [tab, setTab] = useState('Design');
  const [input, setInput] = useState('{\n  \n}');
  const [run, setRun] = useState<any>(null);
  const { busy, act } = useAction();
  const cols = (id?: string) => ((table.find((t) => t.id === id)?.data.columns ?? []) as any[]).map((c) => ({ value: c.name, label: c.label || c.name }));
  const trigger = data.trigger ?? { type: 'manual' };
  const types: StepType[] = [
    { type: 'agent', label: 'AI agent', group: 'AI and bots', summary: (c) => agent.find((a) => a.id === c.agentId)?.name ?? 'Choose an agent', fields: [{ key: 'agentId', label: 'Agent', kind: 'select', options: opts(agent) }, { key: 'input', label: 'Message to the agent', kind: 'textarea', rows: 4, placeholder: 'Validate invoice {{trigger.invoice_no}}' }] },
    { type: 'bot', label: 'RPA bot', group: 'AI and bots', summary: (c) => bot.find((a) => a.id === c.botId)?.name ?? 'Choose a bot', fields: [{ key: 'botId', label: 'Bot', kind: 'select', options: opts(bot), hint: 'The trigger data is passed to the bot as variables.' }] },
    { type: 'db_insert', label: 'Add record', group: 'Data', summary: (c) => table.find((t) => t.id === c.tableId)?.name ?? 'Choose a table', fields: [{ key: 'tableId', label: 'Table', kind: 'select', options: opts(table) }, { key: 'values', label: 'Column values', kind: 'kv' }] },
    { type: 'db_update', label: 'Update record', group: 'Data', summary: (c) => table.find((t) => t.id === c.tableId)?.name ?? 'Choose a table', fields: [{ key: 'tableId', label: 'Table', kind: 'select', options: opts(table) }, { key: 'recordId', label: 'Record id', placeholder: '{{trigger.record.id}}' }, { key: 'values', label: 'Column values', kind: 'kv' }] },
    { type: 'http', label: 'Call an API', group: 'Data', summary: (c) => `${c.method ?? 'GET'} ${c.url ?? ''}`, fields: [{ key: 'method', label: 'Method', kind: 'select', options: METHODS }, { key: 'url', label: 'URL', placeholder: 'https://api.example.com/orders' }, { key: 'headers', label: 'Headers', kind: 'pairs', hint: 'use {{secrets.NAME}} for credentials' }, { key: 'body', label: 'JSON body', kind: 'textarea', rows: 4 }] },
    { type: 'document', label: 'Generate document', group: 'Data', summary: (c) => c.title ?? '', fields: [{ key: 'title', label: 'Title' }, { key: 'template', label: 'Template', kind: 'textarea', rows: 6, placeholder: 'Invoice {{trigger.invoice_no}} was approved by {{steps.approval1.output.by}}.' }] },
    { type: 'email', label: 'Send email', group: 'Notify', summary: (c) => c.to ?? '', fields: [{ key: 'to', label: 'To' }, { key: 'subject', label: 'Subject' }, { key: 'body', label: 'Body', kind: 'textarea', rows: 5 }] },
    { type: 'sms', label: 'Send SMS', group: 'Notify', summary: (c) => c.to ?? '', fields: [{ key: 'to', label: 'Phone number' }, { key: 'body', label: 'Message', kind: 'textarea' }] },
    { type: 'notify', label: 'In-app notification', group: 'Notify', summary: (c) => c.subject ?? '', fields: [{ key: 'subject', label: 'Subject' }, { key: 'body', label: 'Body', kind: 'textarea' }] },
    { type: 'condition', label: 'Condition', group: 'Logic', summary: (c) => `${c.left ?? ''} ${c.op ?? ''} ${c.right ?? ''}`, fields: conditionFields },
    { type: 'approval', label: 'Human approval', group: 'Logic', summary: (c) => c.title ?? '', fields: [{ key: 'title', label: 'Question for the approver' }, { key: 'detail', label: 'Details shown to the approver', kind: 'textarea', rows: 4 }] },
    { type: 'set', label: 'Set variable', group: 'Logic', summary: (c) => `${c.name ?? ''} = ${c.value ?? ''}`, fields: [{ key: 'name', label: 'Variable name' }, { key: 'value', label: 'Value' }] },
  ];
  const triggerDefs: FieldDef[] = [
    { key: 'type', label: 'Starts when', kind: 'select', options: [{ value: 'manual', label: 'Someone starts it (or an app button)' }, { value: 'schedule', label: 'On a schedule' }, { value: 'record', label: 'A record is added to a table' }, { value: 'webhook', label: 'An API call or webhook arrives' }] },
    { key: 'everyMinutes', label: 'Every (minutes)', kind: 'number', placeholder: '60', show: (v) => v.type === 'schedule' },
    { key: 'tableId', label: 'Table', kind: 'select', options: opts(table), show: (v) => v.type === 'record' },
  ];
  const hookUrl = `${location.origin}/api/hooks/${res.id}`;
  const start = () => act(async () => { let parsed: any; try { parsed = JSON.parse(input || '{}'); } catch { throw new Error('The test input is not valid JSON'); } setRun(await POST(`/workflows/${res.id}/run`, { input: parsed })); });
  return (
    <div className="col">
      <div className="card col">
        <div className="row spread wrap"><h3>Trigger</h3><label className="check"><input type="checkbox" checked={!!data.enabled} disabled={readOnly} onChange={(e) => set({ enabled: e.target.checked })} /><span>Trigger is switched on</span></label></div>
        <fieldset disabled={readOnly} style={{ border: 0, padding: 0, margin: 0 }}><Fields columns={3} defs={triggerDefs} value={trigger} onChange={(v) => set({ trigger: v })} /></fieldset>
        {trigger.type === 'webhook' && (trigger.key
          ? <div className="notice small">Send a POST with a JSON body to <code>{hookUrl}</code> with the header <code>x-aacs-key: {me.user.role === 'admin' || !readOnly ? trigger.key : 'hidden'}</code>. Email, file-upload, Teams and WhatsApp events reach a workflow this way, through the provider's own webhook or forwarding rule.</div>
          : <div className="notice small">Save the workflow to generate its webhook address and key.</div>)}
        {trigger.type === 'record' && <p className="muted small">The new record is available as <code>{'{{trigger.record.id}}'}</code> and each column as <code>{'{{trigger.column_name}}'}</code>.</p>}
      </div>
      <Tabs tabs={['Design', 'Test run', 'Run history']} value={tab} onChange={setTab} />
      {tab === 'Design' && <FlowDesigner types={types} steps={data.steps ?? []} onChange={(steps) => set({ steps })} readOnly={readOnly} refHint={(s) => `Later steps can use this step's result as {{steps.${s.id}.output}}. Trigger data is {{trigger.field}}.${s.type === 'db_insert' || s.type === 'db_update' ? ` Columns: ${cols(s.config.tableId).map((c) => c.value).join(', ') || 'choose a table'}.` : ''}`} />}
      {tab === 'Test run' && (
        <div className="split" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1.4fr)' }}>
          <div className="card col">
            {dirty && <div className="notice warn">Save first: runs use the saved version.</div>}
            <label className="field">Trigger data (JSON)<textarea className="mono" rows={8} value={input} onChange={(e) => setInput(e.target.value)} /></label>
            <div><button className="btn primary" disabled={busy} onClick={() => void start()}>{busy ? 'Running' : 'Run now'}</button></div>
          </div>
          <div className="card col">{run ? <><div className="row"><b>Result</b><Badge status={run.status} />{run.status === 'waiting' && <a className="small" href="#/approvals">Open approvals</a>}</div><RunTrace steps={run.steps} /></> : <p className="muted">Run the workflow to see each step's result here.</p>}</div>
        </div>
      )}
      {tab === 'Run history' && <History res={res} kind="workflow" />}
    </div>
  );
}
export const Workflows = ({ id }: { id?: string }) => (
  <Workspace kind="workflow" id={id} base="/workflows" title="Workflows" noun="workflow" blurb="Automate a process: choose a trigger, then chain actions such as an AI agent, an RPA bot, a database update, an API call, an approval or an email."
    blank={() => ({ enabled: false, trigger: { type: 'manual' }, steps: [] })} Editor={WorkflowEditor} describe={(r) => `${r.data.steps?.length ?? 0} step(s) · ${r.data.trigger?.type ?? 'manual'} trigger${r.data.enabled ? ' · on' : ''}`} />
);

// ---------- RPA ----------
const BOT_TYPES: StepType[] = [
  { type: 'goto', label: 'Open page', group: 'Web', summary: (c) => c.url ?? '', fields: [{ key: 'url', label: 'URL', placeholder: 'https://example.com' }] },
  { type: 'click', label: 'Click', group: 'Web', summary: (c) => c.selector ?? '', fields: [{ key: 'selector', label: 'Element (CSS selector or text=Label)', placeholder: 'button#submit' }] },
  { type: 'type', label: 'Type', group: 'Web', summary: (c) => c.selector ?? '', fields: [{ key: 'selector', label: 'Field (CSS selector)', placeholder: 'input[name=q]' }, { key: 'text', label: 'Text', hint: 'Use {{secrets.NAME}} for passwords and {{vars.name}} for values read earlier.' }] },
  { type: 'press', label: 'Press key', group: 'Web', summary: (c) => c.key ?? 'Enter', fields: [{ key: 'key', label: 'Key', placeholder: 'Enter' }] },
  { type: 'read', label: 'Read', group: 'Web', summary: (c) => `${c.selector ?? ''} -> ${c.var ?? 'value'}`, fields: [{ key: 'selector', label: 'Element (CSS selector)', placeholder: 'h1' }, { key: 'var', label: 'Store in variable', placeholder: 'value' }, { key: 'attribute', label: 'Attribute (optional)', placeholder: 'href' }] },
  { type: 'wait', label: 'Wait', group: 'Web', summary: (c) => c.selector ?? `${c.ms ?? 1000} ms`, fields: [{ key: 'selector', label: 'Until this element appears' }, { key: 'ms', label: 'or for milliseconds', kind: 'number' }] },
  { type: 'screenshot', label: 'Screenshot', group: 'Web', fields: [] },
  { type: 'loop', label: 'Loop', group: 'Logic', summary: (c) => `${c.times ?? 1} time(s) over the next ${c.span ?? 1} step(s)`, fields: [{ key: 'times', label: 'Repeat', kind: 'number', placeholder: '3' }, { key: 'span', label: 'Number of following steps to repeat', kind: 'number', placeholder: '1', hint: 'The pass number is available as {{vars.index}}.' }] },
  { type: 'condition', label: 'Condition', group: 'Logic', summary: (c) => `${c.left ?? ''} ${c.op ?? ''} ${c.right ?? ''}`, fields: conditionFields.map((f) => (f.key === 'left' ? { ...f, placeholder: '{{vars.value}}' } : f)) },
  { type: 'set', label: 'Set variable', group: 'Logic', summary: (c) => `${c.name ?? ''} = ${c.value ?? ''}`, fields: [{ key: 'name', label: 'Variable name' }, { key: 'value', label: 'Value' }] },
  { type: 'api', label: 'Call an API', group: 'Integrate', summary: (c) => `${c.method ?? 'GET'} ${c.url ?? ''}`, fields: [{ key: 'method', label: 'Method', kind: 'select', options: METHODS }, { key: 'url', label: 'URL' }, { key: 'body', label: 'JSON body', kind: 'textarea' }, { key: 'var', label: 'Store response in variable', placeholder: 'response' }] },
  { type: 'email', label: 'Send email', group: 'Integrate', summary: (c) => c.to ?? '', fields: [{ key: 'to', label: 'To' }, { key: 'subject', label: 'Subject' }, { key: 'body', label: 'Body', kind: 'textarea' }] },
];
function BotEditor({ res, data, set, dirty, readOnly }: EditorProps) {
  const { me } = useApp();
  const [tab, setTab] = useState('Design');
  const [run, setRun] = useState<any>(null);
  const { busy, act } = useAction();
  return (
    <div className="col">
      {!me.capabilities.browserAutomation && <div className="notice warn">Browser automation is not installed on this server, so web steps will fail. API, email, loop and condition steps still run. Install it with <code>npm install playwright && npx playwright install chromium</code>.</div>}
      <Tabs tabs={['Design', 'Test run', 'Run history']} value={tab} onChange={setTab} />
      {tab === 'Design' && <FlowDesigner types={BOT_TYPES} steps={data.steps ?? []} onChange={(steps) => set({ steps })} readOnly={readOnly} refHint={() => 'Values read by earlier steps are available as {{vars.name}}.'} />}
      {tab === 'Test run' && (
        <div className="card col">
          {dirty && <div className="notice warn">Save first: runs use the saved version.</div>}
          <div><button className="btn primary" disabled={busy} onClick={() => act(async () => setRun(await POST(`/bots/${res.id}/run`, {})))}>{busy ? 'Bot is running' : 'Run bot'}</button></div>
          {run && <>
            <div className="row"><b>Result</b><Badge status={run.error ? 'failed' : 'succeeded'} /></div>
            {run.error && <div className="notice bad">{run.error}</div>}
            <RunTrace steps={run.log} />
            {Object.keys(run.vars).length > 0 && <div><h4>Variables</h4><pre>{JSON.stringify(run.vars, null, 2)}</pre></div>}
            {run.screenshot && <img src={run.screenshot} alt="Page captured by the bot" style={{ maxWidth: '100%', border: '1px solid var(--line)', borderRadius: 6 }} />}
          </>}
        </div>
      )}
      {tab === 'Run history' && <History res={res} kind="bot" />}
    </div>
  );
}
export const Bots = ({ id }: { id?: string }) => (
  <Workspace kind="bot" id={id} base="/bots" title="RPA bots" noun="bot" blurb="Design bots that work through web pages the way a person would: open, click, type, read, loop and decide. Bots run in a headless browser on the server and can be used as workflow steps."
    blank={() => ({ steps: [] })} Editor={BotEditor} describe={(r) => `${r.data.steps?.length ?? 0} step(s)`} />
);

// ---------- connectors ----------
function ConnectorEditor({ data, set, readOnly }: EditorProps) {
  return (
    <div className="card col" style={{ maxWidth: 760 }}>
      <fieldset disabled={readOnly} style={{ border: 0, padding: 0, margin: 0 }}>
        <Fields value={data} onChange={(v) => set(v)} defs={[
          { key: 'baseUrl', label: 'Base URL', placeholder: 'https://api.example.com/v1' },
          { key: 'description', label: 'What agents can do with it', kind: 'textarea', hint: 'Shown to the model so it knows when and how to call this API.' },
          { key: 'methods', label: 'Allowed methods', kind: 'multi', options: METHODS },
          { key: 'headers', label: 'Headers', kind: 'pairs', hint: 'keep credentials in the vault: Bearer {{secrets.NAME}}' },
        ]} />
      </fieldset>
      <p className="muted small">A connector becomes a tool that agents can be given (Agents, step 4). Calls are limited to this base URL and to the methods ticked here.</p>
    </div>
  );
}
export const Connectors = ({ id }: { id?: string }) => (
  <Workspace kind="connector" id={id} base="/connectors" title="Connectors" noun="connector" blurb="REST connections to systems such as SAP, Salesforce, Microsoft 365, Oracle and Workday. Templates are in the marketplace."
    blank={() => ({ baseUrl: '', description: '', methods: ['GET'], headers: [] })} Editor={ConnectorEditor} describe={(r) => r.data.baseUrl || ''} />
);
