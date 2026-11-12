// Low-code application builder: drag components onto a 12-column canvas, bind them to tables, preview, run.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { DEL, fmtNum, GET, newId, POST, type Res } from '../api.ts';
import { BarChart, Fields, RankBars, Tabs, Workspace, useApp, useLoad, useRes, type EditorProps, type FieldDef } from '../ui.tsx';
import { cell, ColumnInput, recordTitle, type Column } from './Data.tsx';

interface Comp { id: string; type: string; label?: string; width?: number; [k: string]: any }
interface Page { id: string; name: string; components: Comp[] }
const INPUTS = ['textbox', 'number', 'dropdown', 'checkbox', 'date', 'richtext'];
const PALETTE: [string, [string, string][]][] = [
  ['Inputs', [['textbox', 'Textbox'], ['number', 'Number'], ['dropdown', 'Dropdown'], ['checkbox', 'Checkbox'], ['date', 'Date picker'], ['richtext', 'Rich text'], ['button', 'Button']]],
  ['Display', [['heading', 'Heading'], ['text', 'Text block'], ['grid', 'Grid / table'], ['chart', 'Chart'], ['metric', 'Metric'], ['calendar', 'Calendar']]],
];
const LABEL = Object.fromEntries(PALETTE.flatMap(([, x]) => x));
const DEFAULT_WIDTH: Record<string, number> = { heading: 12, text: 12, grid: 12, calendar: 12, chart: 6, metric: 4, button: 12, richtext: 12 };
const WIDTHS = [3, 4, 6, 8, 12].map((w) => ({ value: String(w), label: `${w} of 12 columns` }));
const AGGS = [{ value: 'count', label: 'Count of records' }, { value: 'sum', label: 'Sum' }, { value: 'avg', label: 'Average' }];

/** Loads every table definition and the records of the tables an app uses. */
function useAppData(pages: Page[]) {
  const { table: tables } = useRes('table');
  const ids = useMemo(() => [...new Set(pages.flatMap((p) => p.components).map((c) => c.tableId).filter(Boolean))] as string[], [pages]);
  const [tick, setTick] = useState(0);
  const { data } = useLoad(() => Promise.all(ids.map((id) => GET<any[]>(`/tables/${id}/records`).catch(() => []))), [ids.join(), tick]);
  return { tables, records: (id?: string) => (id ? data?.[ids.indexOf(id)] ?? [] : []), reload: () => setTick((t) => t + 1) };
}
function aggregate(rows: any[], agg: string, field?: string) {
  if (agg === 'count' || !field) return rows.length;
  const nums = rows.map((r) => Number(r[field])).filter((n) => Number.isFinite(n));
  const sum = nums.reduce((a, b) => a + b, 0);
  return agg === 'avg' ? (nums.length ? sum / nums.length : 0) : sum;
}
/** Minimal safe formatting for text blocks: **bold**, "- " lists, blank-line paragraphs. Rendered as elements, never as HTML. */
function Rich({ text }: { text: string }) {
  const inline = (s: string) => s.split(/(\*\*[^*]+\*\*)/).map((p, i) => (p.startsWith('**') && p.endsWith('**') ? <b key={i}>{p.slice(2, -2)}</b> : p));
  return <div className="col" style={{ gap: 6 }}>{text.split(/\n\s*\n/).map((block, i) => {
    const lines = block.split('\n');
    return lines.every((l) => l.trim().startsWith('- ')) ? <ul key={i} style={{ margin: 0, paddingLeft: 18 }}>{lines.map((l, j) => <li key={j}>{inline(l.trim().slice(2))}</li>)}</ul> : <p key={i}>{lines.map((l, j) => <span key={j}>{inline(l)}{j < lines.length - 1 && <br />}</span>)}</p>;
  })}</div>;
}

function Calendar({ rows, dateField, titleField }: { rows: any[]; dateField?: string; titleField?: string }) {
  const [month, setMonth] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const first = month.getDay(), days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const key = (d: number) => `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const shift = (n: number) => setMonth(new Date(month.getFullYear(), month.getMonth() + n, 1));
  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="row spread"><button className="btn sm" onClick={() => shift(-1)}>Previous</button><b>{month.toLocaleString(undefined, { month: 'long', year: 'numeric' })}</b><button className="btn sm" onClick={() => shift(1)}>Next</button></div>
      <div className="cal">
        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => <div key={d} className="head">{d}</div>)}
        {Array.from({ length: first }, (_, i) => <div key={`b${i}`} style={{ border: 0 }} />)}
        {Array.from({ length: days }, (_, i) => {
          const ev = dateField ? rows.filter((r) => String(r[dateField] ?? '').slice(0, 10) === key(i + 1)) : [];
          return <div key={i}><span className="muted">{i + 1}</span>{ev.slice(0, 3).map((r) => <div key={r.id} className="ev" title={cell(r[titleField ?? ''] ?? recordTitle(r))}>{cell(r[titleField ?? ''] ?? recordTitle(r))}</div>)}{ev.length > 3 && <div className="muted">+{ev.length - 3} more</div>}</div>;
        })}
      </div>
    </div>
  );
}

interface ViewCtx { tables: Res[]; records: (id?: string) => any[]; values: Record<string, any>; setValue: (k: string, v: any) => void; onAction: (c: Comp) => void; onDelete: (tableId: string, id: string) => void; live: boolean }
function View({ c, x }: { c: Comp; x: ViewCtx }): ReactNode {
  const table = x.tables.find((t) => t.id === c.tableId);
  const cols: Column[] = table?.data.columns ?? [];
  const rows = x.records(c.tableId);
  const needTable = <p className="muted small">Choose a table for this {LABEL[c.type]?.toLowerCase()}.</p>;
  switch (c.type) {
    case 'heading': return <h2>{c.label || 'Heading'}</h2>;
    case 'text': return <Rich text={c.text || c.label || 'Text'} />;
    case 'button': return <button className={`btn ${c.style === 'secondary' ? '' : 'primary'}`} onClick={() => x.onAction(c)}>{c.label || 'Button'}</button>;
    case 'metric': return <div className="card stat"><b>{table ? fmtNum(aggregate(rows, c.agg ?? 'count', c.valueField)) : 'n/a'}</b><span>{c.label || 'Metric'}</span></div>;
    case 'grid': {
      if (!table) return needTable;
      const show = c.columns?.length ? cols.filter((k) => c.columns.includes(k.name)) : cols;
      return (
        <div className="col" style={{ gap: 6 }}>
          {c.label && <h3>{c.label}</h3>}
          <div className="table-wrap"><table>
            <thead><tr>{show.map((k) => <th key={k.name}>{k.label || k.name}</th>)}{x.live && c.allowDelete && <th />}</tr></thead>
            <tbody>
              {rows.slice(0, +c.pageSize || 25).map((r) => <tr key={r.id}>{show.map((k) => <td key={k.name} className={k.type === 'number' ? 'num' : ''}>{cell(r[k.name]).slice(0, 120)}</td>)}{x.live && c.allowDelete && <td><button className="btn sm ghost danger" onClick={() => x.onDelete(table.id, r.id)}>Delete</button></td>}</tr>)}
              {!rows.length && <tr><td colSpan={show.length + 1} className="muted">No records yet.</td></tr>}
            </tbody>
          </table></div>
        </div>
      );
    }
    case 'chart': {
      if (!table || !c.groupField) return <p className="muted small">Choose a table and a field to group by.</p>;
      const groups = new Map<string, any[]>();
      for (const r of rows) { const k = cell(r[c.groupField]) || '(empty)'; groups.set(k, [...(groups.get(k) ?? []), r]); }
      const data = [...groups].map(([label, rs]) => ({ label, value: aggregate(rs, c.agg ?? 'count', c.valueField) })).sort((a, b) => b.value - a.value).slice(0, 12);
      return (
        <div className="card col">
          <h3>{c.label || 'Chart'}</h3>
          {!data.length ? <p className="muted small">No records yet.</p> : c.chart === 'ranked' ? <RankBars rows={data} fmt={fmtNum} /> : <BarChart data={data.map((d) => ({ label: d.label.slice(0, 10), values: [d.value] }))} series={[{ name: c.label || 'Value', color: 'var(--series-1)' }]} fmt={fmtNum} />}
        </div>
      );
    }
    case 'calendar': return table ? <div className="card col">{c.label && <h3>{c.label}</h3>}<Calendar rows={rows} dateField={c.dateField} titleField={c.titleField} /></div> : needTable;
    default: {
      const v = x.values[c.field || c.id];
      const col: Column = { name: c.field || c.id, type: ({ number: 'number', dropdown: 'choice', checkbox: 'boolean', date: 'date', richtext: 'longtext' } as any)[c.type] ?? 'text', options: c.options };
      return <label className="field">{c.label || LABEL[c.type]}<ColumnInput col={col} value={v} onChange={(n) => x.setValue(c.field || c.id, n)} /></label>;
    }
  }
}

function propDefs(c: Comp, tables: Res[], pages: Page[], workflows: Res[]): FieldDef[] {
  const cols = ((tables.find((t) => t.id === c.tableId)?.data.columns ?? []) as Column[]).map((k) => ({ value: k.name, label: k.label || k.name }));
  const tableSel: FieldDef = { key: 'tableId', label: 'Table', kind: 'select', options: tables.map((t) => ({ value: t.id, label: t.name })) };
  const out: FieldDef[] = [{ key: 'label', label: c.type === 'text' ? 'Title (optional)' : 'Label' }, { key: 'width', label: 'Width', kind: 'select', options: WIDTHS }];
  if (INPUTS.includes(c.type)) out.push({ key: 'field', label: 'Saves to column', hint: 'Column name in the table the Save button writes to', placeholder: 'e.g. vendor' });
  if (c.type === 'dropdown') out.push({ key: 'options', label: 'Options', kind: 'list' });
  if (c.type === 'text') out.push({ key: 'text', label: 'Text', kind: 'textarea', rows: 5, hint: 'Use **bold** and lines starting with "- " for lists.' });
  if (c.type === 'button') out.push(
    { key: 'action', label: 'When clicked', kind: 'select', options: [{ value: 'submit', label: 'Save the form as a record' }, { value: 'navigate', label: 'Go to another page' }, { value: 'workflow', label: 'Start a workflow' }] },
    { ...tableSel, label: 'Save into table', show: (v) => (v.action ?? 'submit') === 'submit' },
    { key: 'pageId', label: 'Page', kind: 'select', options: pages.map((p) => ({ value: p.id, label: p.name })), show: (v) => v.action === 'navigate' },
    { key: 'workflowId', label: 'Workflow', kind: 'select', options: workflows.map((w) => ({ value: w.id, label: w.name })), show: (v) => v.action === 'workflow', hint: 'The form values are passed as the workflow input.' },
    { key: 'style', label: 'Style', kind: 'select', options: [{ value: 'primary', label: 'Primary' }, { value: 'secondary', label: 'Secondary' }] });
  if (['grid', 'chart', 'metric', 'calendar'].includes(c.type)) out.push(tableSel);
  if (c.type === 'grid') out.push({ key: 'columns', label: 'Columns to show (all when none ticked)', kind: 'multi', options: cols }, { key: 'pageSize', label: 'Rows to show', kind: 'number', placeholder: '25' }, { key: 'allowDelete', label: 'Allow deleting rows', kind: 'bool' });
  if (c.type === 'chart') out.push({ key: 'chart', label: 'Chart type', kind: 'select', options: [{ value: 'bar', label: 'Columns' }, { value: 'ranked', label: 'Ranked bars' }] }, { key: 'groupField', label: 'Group by', kind: 'select', options: cols });
  if (c.type === 'chart' || c.type === 'metric') out.push({ key: 'agg', label: 'Calculation', kind: 'select', options: AGGS }, { key: 'valueField', label: 'Number column', kind: 'select', options: cols, show: (v) => v.agg === 'sum' || v.agg === 'avg' });
  if (c.type === 'calendar') out.push({ key: 'dateField', label: 'Date column', kind: 'select', options: cols }, { key: 'titleField', label: 'Title column', kind: 'select', options: cols });
  return out;
}

/** Runs one page: holds the form values and performs button actions. */
function PageView({ page, pages, data, goPage, live }: { page: Page; pages: Page[]; data: ReturnType<typeof useAppData>; goPage: (id: string) => void; live: boolean }) {
  const { toast } = useApp();
  const [values, setValues] = useState<Record<string, any>>({});
  useEffect(() => setValues({}), [page.id]);
  const onAction = async (c: Comp) => {
    try {
      if (c.action === 'navigate') return void (pages.some((p) => p.id === c.pageId) && goPage(c.pageId));
      if (c.action === 'workflow') { if (!c.workflowId) throw new Error('This button has no workflow'); const r = await POST(`/workflows/${c.workflowId}/run`, { input: values }); toast(`Workflow ${r.status}`); return; }
      if (!c.tableId) throw new Error('This button has no table to save into');
      await POST(`/tables/${c.tableId}/records`, values);
      setValues({}); data.reload(); toast('Saved');
    } catch (e: any) { toast(e.message, true); }
  };
  const x: ViewCtx = { tables: data.tables, records: data.records, values, setValue: (k, v) => setValues((s) => ({ ...s, [k]: v })), onAction, live,
    onDelete: (t, id) => { if (confirm('Delete this record?')) DEL(`/tables/${t}/records/${id}`).then(data.reload, (e) => toast(e.message, true)); } };
  return <>{page.components.map((c) => <div key={c.id} className="comp" style={{ gridColumn: `span ${c.width ?? DEFAULT_WIDTH[c.type] ?? 6}` }}><View c={c} x={x} /></div>)}</>;
}

function AppEditor({ res, data, set, readOnly }: EditorProps) {
  const pages: Page[] = data.pages ?? [];
  const [pageId, setPageId] = useState(pages[0]?.id);
  const [sel, setSel] = useState<string | null>(null);
  const [mode, setMode] = useState('Design');
  const [phone, setPhone] = useState(false);
  const [over, setOver] = useState<string | null>(null);
  const appData = useAppData(pages);
  const { workflow } = useRes('workflow');
  const page = pages.find((p) => p.id === pageId) ?? pages[0];
  const setPage = (p: Partial<Page>) => set({ pages: pages.map((x) => (x.id === page.id ? { ...x, ...p } : x)) });
  const comps = page?.components ?? [];
  const cur = comps.find((c) => c.id === sel);
  const drop = (raw: string, before?: string) => {
    let next = [...comps], item: Comp | undefined;
    if (raw.startsWith('new:')) { item = { id: newId(), type: raw.slice(4), label: LABEL[raw.slice(4)], width: DEFAULT_WIDTH[raw.slice(4)] ?? 6 }; setSel(item.id); }
    else if (raw.startsWith('move:')) { item = comps.find((c) => c.id === raw.slice(5)); next = next.filter((c) => c.id !== raw.slice(5)); }
    if (!item || item.id === before) return;
    const at = before ? next.findIndex((c) => c.id === before) : next.length;
    next.splice(at < 0 ? next.length : at, 0, item);
    setPage({ components: next });
  };
  const noop: ViewCtx = { tables: appData.tables, records: appData.records, values: {}, setValue: () => {}, onAction: () => {}, onDelete: () => {}, live: false };
  if (!page) return <div><button className="btn primary" onClick={() => { const p = { id: newId(), name: 'Page 1', components: [] }; set({ pages: [p] }); setPageId(p.id); }}>Add the first page</button></div>;
  return (
    <div className="col">
      <div className="row wrap spread">
        <div className="steps">
          {pages.map((p) => <button key={p.id} className={p.id === page.id ? 'on' : ''} onClick={() => { setPageId(p.id); setSel(null); }}>{p.name}</button>)}
          {!readOnly && <button onClick={() => { const p = { id: newId(), name: `Page ${pages.length + 1}`, components: [] }; set({ pages: [...pages, p] }); setPageId(p.id); }}>Add page</button>}
        </div>
        <div className="row wrap">
          <label className="check small"><input type="checkbox" checked={phone} onChange={(e) => setPhone(e.target.checked)} />Phone width</label>
          <a className="btn" href={`#/run/${res.id}`} target="_blank" rel="noreferrer">Open app</a>
        </div>
      </div>
      <Tabs tabs={['Design', 'Preview']} value={mode} onChange={setMode} />
      {mode === 'Preview' ? (
        <div className={`canvas ${phone ? 'phone' : ''}`} style={{ borderStyle: 'solid' }}><PageView page={page} pages={pages} data={appData} goPage={setPageId} live /></div>
      ) : (
        <div className="split" style={{ gridTemplateColumns: readOnly ? '1fr' : '160px minmax(0, 1fr) minmax(250px, 320px)' }}>
          {!readOnly && (
            <div className="palette">
              <span className="muted small">Drag onto the page, or click to add.</span>
              {PALETTE.map(([group, items]) => <div key={group} className="palette"><h4>{group}</h4>{items.map(([t, l]) => <button key={t} className="chip" draggable onDragStart={(e) => e.dataTransfer.setData('text/plain', `new:${t}`)} onClick={() => drop(`new:${t}`)}>{l}</button>)}</div>)}
            </div>
          )}
          <div className={`canvas ${phone ? 'phone' : ''} ${over === '' ? 'over' : ''}`} onDragOver={(e) => { e.preventDefault(); setOver((o) => o ?? ''); }} onDragLeave={(e) => e.currentTarget === e.target && setOver(null)}
            onDrop={(e) => { e.preventDefault(); drop(e.dataTransfer.getData('text/plain'), over || undefined); setOver(null); }}>
            {!comps.length && <p className="muted" style={{ gridColumn: '1 / -1', textAlign: 'center', padding: 40 }}>This page is empty. Drag a component here.</p>}
            {comps.map((c) => (
              <div key={c.id} className={`comp edit ${sel === c.id ? 'sel' : ''} ${over === c.id ? 'drop-before' : ''}`} style={{ gridColumn: `span ${phone ? 12 : c.width ?? DEFAULT_WIDTH[c.type] ?? 6}` }} draggable={!readOnly}
                onDragStart={(e) => e.dataTransfer.setData('text/plain', `move:${c.id}`)} onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setOver(c.id); }} onClick={() => setSel(c.id)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setSel(c.id)}>
                <View c={c} x={noop} />
              </div>
            ))}
          </div>
          {!readOnly && (
            <div className="card col">
              {cur ? (
                <>
                  <div className="row spread"><h3>{LABEL[cur.type]}</h3><button className="btn sm danger" onClick={() => { setPage({ components: comps.filter((c) => c.id !== cur.id) }); setSel(null); }}>Remove</button></div>
                  <Fields defs={propDefs(cur, appData.tables, pages, workflow)} value={{ ...cur, width: String(cur.width ?? DEFAULT_WIDTH[cur.type] ?? 6) }} onChange={(v) => setPage({ components: comps.map((c) => (c.id === cur.id ? { ...v, width: +v.width || 12 } : c)) })} />
                </>
              ) : (
                <>
                  <h3>Page settings</h3>
                  <label className="field">Page name<input value={page.name} onChange={(e) => setPage({ name: e.target.value })} /></label>
                  {pages.length > 1 && <div><button className="btn sm danger" onClick={() => { set({ pages: pages.filter((p) => p.id !== page.id) }); setPageId(pages.find((p) => p.id !== page.id)!.id); }}>Delete page</button></div>}
                  <p className="muted small">Select a component to edit its properties. Input components save to the column named in "Saves to column" when a Save button on the same page is clicked.</p>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** The finished application, as its users see it. /run/:id shows the working copy, /run/:id/prod a released version. */
export function AppRuntime({ id, env }: { id: string; env?: string }) {
  const { data: app, error } = useLoad(() => GET<Res>(env ? `/live/${env}/${id}` : `/resources/${id}`), [id, env]);
  const pages: Page[] = app?.data.pages ?? [];
  const data = useAppData(pages);
  const [pageId, setPageId] = useState('');
  const page = pages.find((p) => p.id === pageId) ?? pages[0];
  if (error) return <div className="page"><div className="notice bad">{error}</div></div>;
  if (!app) return null;
  return (
    <div className="main">
      <header className="top"><b>{app.name}</b><span className="badge">{env ? `${env.toUpperCase()} v${app.version}` : 'Working copy'}</span><div className="grow" /><div className="steps">{pages.map((p) => <button key={p.id} className={p.id === page?.id ? 'on' : ''} onClick={() => setPageId(p.id)}>{p.name}</button>)}</div></header>
      <main className="page"><div className="canvas" style={{ border: 0, background: 'transparent', maxWidth: 1100, margin: '0 auto' }}>{page ? <PageView page={page} pages={pages} data={data} goPage={setPageId} live /> : <p className="muted">This app has no pages.</p>}</div></main>
    </div>
  );
}

export const Apps = ({ id }: { id?: string }) => (
  <Workspace kind="app" id={id} base="/apps" title="Apps" noun="app" blurb="Build business applications without code: forms, grids, charts, calendars and dashboards on top of your data tables."
    blank={() => ({ pages: [{ id: newId(), name: 'Home', components: [] }] })} Editor={AppEditor} describe={(r) => `${r.data.pages?.length ?? 0} page(s), ${r.data.pages?.reduce((a: number, p: Page) => a + p.components.length, 0) ?? 0} component(s)`} />
);
