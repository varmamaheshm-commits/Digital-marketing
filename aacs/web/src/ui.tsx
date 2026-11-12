// Shared building blocks: context, form fields, charts, the flow designer and the resource workspace.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { canWrite, DEL, fmtDate, GET, listRes, newId, POST, PUT, type Me, type Res } from './api.ts';

export interface AppState { me: Me; reloadMe: () => void; toast: (msg: string, error?: boolean) => void; projectId: string }
export const AppCtx = createContext<AppState>(null as any);
export const useApp = () => useContext(AppCtx);
export const go = (path: string) => { location.hash = path; };

export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | undefined>();
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    fn().then((d) => { if (live) { setData(d); setError(''); } }, (e) => live && setError(e.message));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { data, error, reload: useCallback(() => setTick((t) => t + 1), []), setData };
}
/** Run an action, show its error as a toast, and track the busy state. */
export function useAction() {
  const { toast } = useApp();
  const [busy, setBusy] = useState(false);
  const act = async <T,>(fn: () => Promise<T>, done?: string): Promise<T | undefined> => {
    setBusy(true);
    try { const r = await fn(); if (done) toast(done); return r; } catch (e: any) { toast(e.message, true); return undefined; } finally { setBusy(false); }
  };
  return { busy, act };
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => { const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose(); window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h); }, [onClose]);
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal col ${wide ? 'wide' : ''}`} role="dialog" aria-label={title}>
        <div className="row spread"><h2>{title}</h2><button className="btn ghost sm" onClick={onClose} aria-label="Close">Close</button></div>
        {children}
      </div>
    </div>
  );
}
export function Tabs({ tabs, value, onChange }: { tabs: string[]; value: string; onChange: (t: string) => void }) {
  return <div className="tabs" role="tablist">{tabs.map((t) => <button key={t} role="tab" aria-selected={t === value} className={t === value ? 'on' : ''} onClick={() => onChange(t)}>{t}</button>)}</div>;
}
const TONE: Record<string, string> = { succeeded: 'good', live: 'good', published: 'good', approved: 'good', passed: 'good', pass: 'good', done: 'good', delivered: 'good', active: 'good', failed: 'bad', rejected: 'bad', blocked: 'bad', fail: 'bad', disabled: 'bad', waiting: 'warn', pending: 'warn', pending_approval: 'warn', warn: 'warn', warning: 'warn', escalated: 'warn', queued: 'warn', running: 'info', generated: 'info' };
export const Badge = ({ status, children }: { status: string; children?: ReactNode }) => <span className={`badge ${TONE[status] ?? ''}`}>{children ?? status.replace(/_/g, ' ')}</span>;
export const Empty = ({ children, action }: { children: ReactNode; action?: ReactNode }) => <div className="empty"><p>{children}</p>{action}</div>;
export const PageHead = ({ title, blurb, children }: { title: string; blurb?: string; children?: ReactNode }) => (
  <div className="page-head"><div><h1>{title}</h1>{blurb && <p>{blurb}</p>}</div><div className="row wrap">{children}</div></div>
);

// ---------- metadata-driven form ----------
export interface FieldDef {
  key: string; label: string; kind?: 'text' | 'textarea' | 'number' | 'select' | 'multi' | 'bool' | 'list' | 'pairs' | 'kv' | 'password';
  options?: { value: string; label: string; hint?: string }[]; hint?: string; placeholder?: string; rows?: number; show?: (v: any) => boolean; wide?: boolean;
}
const getPath = (o: any, k: string) => k.split('.').reduce((a, p) => a?.[p], o);
const setPath = (o: any, k: string, v: any): any => { const [h, ...r] = k.split('.'); return { ...(o ?? {}), [h]: r.length ? setPath(o?.[h], r.join('.'), v) : v }; };

export function Fields({ defs, value, onChange, columns = 1 }: { defs: FieldDef[]; value: any; onChange: (v: any) => void; columns?: number }) {
  return (
    <div className="grid" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
      {defs.filter((d) => !d.show || d.show(value ?? {})).map((d) => {
        const v = getPath(value, d.key);
        const set = (x: any) => onChange(setPath(value, d.key, x));
        const span = d.wide || ['textarea', 'multi', 'pairs', 'kv'].includes(d.kind ?? '') ? { gridColumn: '1 / -1' } : undefined;
        if (d.kind === 'bool') return <label key={d.key} className="check" style={span}><input type="checkbox" checked={!!v} onChange={(e) => set(e.target.checked)} /><span>{d.label}{d.hint && <small>{d.hint}</small>}</span></label>;
        if (d.kind === 'multi') return (
          <div key={d.key} className="col" style={{ ...span, gap: 6 }}>
            <span className="small" style={{ fontWeight: 500, color: 'var(--text-2)' }}>{d.label}</span>
            {d.options?.length ? d.options.map((o) => (
              <label key={o.value} className="check"><input type="checkbox" checked={(v ?? []).includes(o.value)} onChange={(e) => set(e.target.checked ? [...(v ?? []), o.value] : (v ?? []).filter((x: string) => x !== o.value))} /><span>{o.label}{o.hint && <small>{o.hint}</small>}</span></label>
            )) : <span className="muted small">{d.hint ?? 'Nothing available yet.'}</span>}
          </div>
        );
        if (d.kind === 'pairs' || d.kind === 'kv') {
          const rows: { name: string; value: string }[] = d.kind === 'kv' ? Object.entries(v ?? {}).map(([name, value]) => ({ name, value: String(value) })) : v ?? [];
          const put = (r: typeof rows) => set(d.kind === 'kv' ? Object.fromEntries(r.map((x) => [x.name, x.value])) : r);
          return (
            <div key={d.key} className="col" style={{ ...span, gap: 6 }}>
              <span className="small" style={{ fontWeight: 500, color: 'var(--text-2)' }}>{d.label}{d.hint && <small className="muted"> - {d.hint}</small>}</span>
              {rows.map((r, i) => (
                <div className="row" key={i}>
                  {d.kind === 'kv' && d.options ? <select aria-label="Name" value={r.name} onChange={(e) => put(rows.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}><option value="">Choose</option>{d.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
                    : <input aria-label="Name" placeholder="Name" value={r.name} onChange={(e) => put(rows.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />}
                  <input aria-label="Value" placeholder="Value" value={r.value} onChange={(e) => put(rows.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
                  <button className="btn sm ghost" onClick={() => put(rows.filter((_, j) => j !== i))} aria-label="Remove">Remove</button>
                </div>
              ))}
              <div><button className="btn sm" onClick={() => put([...rows, { name: '', value: '' }])}>Add</button></div>
            </div>
          );
        }
        return (
          <label key={d.key} className="field" style={span}>
            {d.label}
            {d.kind === 'textarea' ? <textarea rows={d.rows ?? 3} value={v ?? ''} placeholder={d.placeholder} onChange={(e) => set(e.target.value)} />
              : d.kind === 'select' ? <select value={v ?? ''} onChange={(e) => set(e.target.value)}><option value="">Choose</option>{d.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
              : d.kind === 'list' ? <input value={(v ?? []).join(', ')} placeholder={d.placeholder ?? 'Comma separated'} onChange={(e) => set(e.target.value.split(',').map((s) => s.trim()).filter(Boolean))} />
              : <input type={d.kind === 'number' ? 'number' : d.kind === 'password' ? 'password' : 'text'} value={v ?? ''} placeholder={d.placeholder} autoComplete="off" onChange={(e) => set(d.kind === 'number' && e.target.value !== '' ? +e.target.value : e.target.value)} />}
            {d.hint && <small>{d.hint}</small>}
          </label>
        );
      })}
    </div>
  );
}

// ---------- charts (single axis, thin marks, hover detail, text in ink colours) ----------
export function BarChart({ data, series, height = 160, fmt = (n: number) => String(n) }: { data: { label: string; values: number[] }[]; series: { name: string; color: string }[]; height?: number; fmt?: (n: number) => string }) {
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  const W = 640, pad = { l: 48, r: 6, t: 8, b: 20 };
  const max = Math.max(1e-9, ...data.map((d) => d.values.reduce((a, b) => a + b, 0)));
  const ih = height - pad.t - pad.b, slot = (W - pad.l - pad.r) / Math.max(1, data.length), bw = Math.min(22, Math.max(3, slot - 4));
  const every = Math.ceil(data.length / 8);
  return (
    <div className="viz col" style={{ gap: 6, position: 'relative' }} onMouseLeave={() => setTip(null)}>
      {series.length > 1 && <div className="legend">{series.map((s) => <span key={s.name}><i style={{ background: s.color }} />{s.name}</span>)}</div>}
      <svg viewBox={`0 0 ${W} ${height}`} width="100%" role="img" aria-label={`Bar chart: ${series.map((s) => s.name).join(', ')}`}>
        {[0, 0.5, 1].map((f) => <g key={f}><line x1={pad.l} x2={W - pad.r} y1={pad.t + ih * (1 - f)} y2={pad.t + ih * (1 - f)} stroke="var(--grid)" /><text x={pad.l - 6} y={pad.t + ih * (1 - f) + 4} textAnchor="end">{fmt(max * f)}</text></g>)}
        {data.map((d, i) => {
          const x = pad.l + slot * i + (slot - bw) / 2;
          let y = pad.t + ih;
          const total = d.values.reduce((a, b) => a + b, 0);
          return (
            <g key={i} onMouseMove={(e) => { const box = (e.currentTarget.ownerSVGElement!.parentElement as HTMLElement).getBoundingClientRect(); setTip({ x: e.clientX - box.left, y: e.clientY - box.top, text: `${d.label}: ${d.values.map((v, k) => `${series.length > 1 ? series[k].name + ' ' : ''}${fmt(v)}`).join(', ')}` }); }}>
              <rect x={pad.l + slot * i} y={pad.t} width={slot} height={ih} fill="transparent" />
              {d.values.map((v, k) => {
                const h = (v / max) * ih;
                if (h <= 0) return null;
                y -= h;
                const top = d.values.slice(k + 1).every((n) => n <= 0);
                const hh = Math.max(1, h - (top ? 0 : 2));
                const r = top ? Math.min(4, bw / 2, hh) : 0;
                return <path key={k} fill={series[k].color} d={`M${x},${y + hh} V${y + r} Q${x},${y} ${x + r},${y} H${x + bw - r} Q${x + bw},${y} ${x + bw},${y + r} V${y + hh} Z`} />;
              })}
              {total === 0 && <rect x={x} y={pad.t + ih - 1} width={bw} height={1} fill="var(--line-strong)" />}
              {i % every === 0 && <text x={x + bw / 2} y={height - 5} textAnchor="middle">{d.label}</text>}
            </g>
          );
        })}
      </svg>
      {tip && <div className="tip" style={{ left: tip.x, top: tip.y }}>{tip.text}</div>}
    </div>
  );
}
/** Horizontal ranked bars for categories with long names. */
export function RankBars({ rows, fmt = (n: number) => String(n) }: { rows: { label: string; value: number; note?: string }[]; fmt?: (n: number) => string }) {
  const max = Math.max(1e-9, ...rows.map((r) => r.value));
  if (!rows.length) return <p className="muted small">No data yet.</p>;
  return (
    <div className="col" style={{ gap: 8 }}>
      {rows.map((r) => (
        <div key={r.label} className="score" title={`${r.label}: ${fmt(r.value)}`}>
          <div className="row spread small"><span>{r.label}{r.note && <span className="muted"> {r.note}</span>}</span><span className="num">{fmt(r.value)}</span></div>
          <div className="bar"><i style={{ width: `${(r.value / max) * 100}%` }} /></div>
        </div>
      ))}
    </div>
  );
}

export function RunTrace({ steps }: { steps: any[] }) {
  if (!steps?.length) return <p className="muted small">No steps were recorded.</p>;
  return (
    <div className="trace">
      {steps.map((s, i) => (
        <div key={i} className={s.error ? 'failed' : s.status ?? 'done'}>
          <div className="row spread"><b className="small">{s.name}</b><span className="muted small num">{s.type}{s.ms != null ? ` · ${s.ms} ms` : ''}</span></div>
          <pre className="small muted">{s.detail}</pre>
        </div>
      ))}
    </div>
  );
}

// ---------- visual flow designer (workflows and bots) ----------
export interface StepType { type: string; label: string; group: string; fields: FieldDef[]; summary?: (c: any) => string }
export interface FlowStep { id: string; type: string; name?: string; config: any }

export function FlowDesigner({ types, steps, onChange, refHint, readOnly }: { types: StepType[]; steps: FlowStep[]; onChange: (s: FlowStep[]) => void; refHint?: (s: FlowStep) => string; readOnly?: boolean }) {
  const [sel, setSel] = useState<string | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const flow = useRef<HTMLDivElement>(null);
  const byType = Object.fromEntries(types.map((t) => [t.type, t]));
  const groups = [...new Set(types.map((t) => t.group))];
  const add = (type: string, at = steps.length) => {
    let n = 1;
    while (steps.some((s) => s.id === `${type}${n}`)) n++;
    const step = { id: `${type}${n}`, type, name: byType[type].label, config: {} };
    onChange([...steps.slice(0, at), step, ...steps.slice(at)]);
    setSel(step.id);
  };
  const move = (from: number, to: number) => {
    if (to < 0 || to > steps.length) return;
    const next = [...steps];
    const [s] = next.splice(from, 1);
    next.splice(to > from ? to - 1 : to, 0, s);
    onChange(next);
  };
  const indexAt = (y: number) => {
    const nodes = [...(flow.current?.querySelectorAll('.node') ?? [])];
    const i = nodes.findIndex((n) => y < n.getBoundingClientRect().top + n.getBoundingClientRect().height / 2);
    return i < 0 ? steps.length : i;
  };
  const cur = steps.find((s) => s.id === sel);
  const patch = (p: Partial<FlowStep>) => onChange(steps.map((s) => (s.id === sel ? { ...s, ...p } : s)));
  return (
    <div className="split" style={{ gridTemplateColumns: readOnly ? '1fr' : '170px minmax(0, 1fr) minmax(260px, 340px)' }}>
      {!readOnly && (
        <div className="palette">
          <span className="muted small">Drag a step into the flow, or click to add it at the end.</span>
          {groups.map((g) => (
            <div className="palette" key={g}>
              <h4>{g}</h4>
              {types.filter((t) => t.group === g).map((t) => <button key={t.type} className="chip" draggable onDragStart={(e) => e.dataTransfer.setData('text/plain', `new:${t.type}`)} onClick={() => add(t.type)}>{t.label}</button>)}
            </div>
          ))}
        </div>
      )}
      <div ref={flow} className={`flow ${over !== null ? 'over' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setOver(indexAt(e.clientY)); }} onDragLeave={(e) => e.currentTarget === e.target && setOver(null)}
        onDrop={(e) => { e.preventDefault(); const d = e.dataTransfer.getData('text/plain'); const at = indexAt(e.clientY); setOver(null); if (d.startsWith('new:')) add(d.slice(4), at); else if (d.startsWith('move:')) move(+d.slice(5), at); }}>
        {!steps.length && <p className="muted" style={{ margin: 'auto', textAlign: 'center' }}>The flow is empty. Add the first step from the left.</p>}
        {steps.map((s, i) => (
          <div key={s.id}>
            {over === i && <div className="drop-line" />}
            {i > 0 && over !== i && <div className="link" />}
            <div className={`node ${sel === s.id ? 'sel' : ''}`} draggable={!readOnly} onDragStart={(e) => e.dataTransfer.setData('text/plain', `move:${i}`)} onClick={() => setSel(s.id)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setSel(s.id)}>
              <span className="kind">{byType[s.type]?.label ?? s.type}</span>
              <div className="grow"><b>{s.name || byType[s.type]?.label}</b><div className="muted small" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{byType[s.type]?.summary?.(s.config) ?? ''}</div></div>
              <span className="muted small num">{i + 1}</span>
            </div>
          </div>
        ))}
        {over === steps.length && steps.length > 0 && <div className="drop-line" />}
      </div>
      {!readOnly && (
        <div className="card col">
          {cur ? (
            <>
              <div className="row spread"><h3>{byType[cur.type]?.label}</h3><span className="muted small mono">{cur.id}</span></div>
              <label className="field">Step name<input value={cur.name ?? ''} onChange={(e) => patch({ name: e.target.value })} /></label>
              <Fields defs={byType[cur.type]?.fields ?? []} value={cur.config} onChange={(config) => patch({ config })} />
              {refHint && <p className="muted small">{refHint(cur)}</p>}
              <div className="row wrap">
                <button className="btn sm" onClick={() => move(steps.indexOf(cur), steps.indexOf(cur) - 1)} disabled={steps.indexOf(cur) === 0}>Move up</button>
                <button className="btn sm" onClick={() => move(steps.indexOf(cur), steps.indexOf(cur) + 2)} disabled={steps.indexOf(cur) === steps.length - 1}>Move down</button>
                <button className="btn sm danger" onClick={() => { onChange(steps.filter((s) => s.id !== cur.id)); setSel(null); }}>Remove step</button>
              </div>
            </>
          ) : <p className="muted">Select a step to configure it.</p>}
        </div>
      )}
    </div>
  );
}

// ---------- resource workspace: list, create, edit, versions, release ----------
export interface EditorProps { res: Res; data: any; set: (patch: any) => void; save: () => Promise<Res | undefined>; dirty: boolean; readOnly: boolean }
const RELEASABLE = ['app', 'agent', 'workflow', 'bot', 'crew'];

export function Workspace({ kind, title, blurb, noun, blank, Editor, id, base, describe }: { kind: string; title: string; blurb: string; noun: string; blank: () => any; Editor: (p: EditorProps) => ReactNode; id?: string; base: string; describe?: (r: Res) => string }) {
  return id ? <Detail key={id} id={id} kind={kind} noun={noun} Editor={Editor} base={base} /> : <List kind={kind} title={title} blurb={blurb} noun={noun} blank={blank} base={base} describe={describe} />;
}

function List({ kind, title, blurb, noun, blank, base, describe }: { kind: string; title: string; blurb: string; noun: string; blank: () => any; base: string; describe?: (r: Res) => string }) {
  const { me, projectId } = useApp();
  const { data, error } = useLoad(() => GET<Res[]>(`/resources?kind=${kind}&project=${projectId}`), [kind, projectId]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const { busy, act } = useAction();
  const writable = canWrite(me.user.role, kind);
  const create = () => act(async () => { const r = await POST<Res>('/resources', { kind, name, data: blank(), projectId }); go(`${base}/${r.id}`); });
  return (
    <div className="col">
      <PageHead title={title} blurb={blurb}>{writable && <button className="btn primary" onClick={() => { setName(''); setCreating(true); }}>New {noun}</button>}</PageHead>
      {error && <div className="notice bad">{error}</div>}
      {data && !data.length && <Empty action={<div className="row" style={{ justifyContent: 'center' }}>{writable && <button className="btn primary" onClick={() => setCreating(true)}>New {noun}</button>}<a className="btn" href="#/marketplace">Browse the marketplace</a></div>}>No {title.toLowerCase()} yet. Create one from scratch or install a ready-made template.</Empty>}
      <div className="grid auto-cards">
        {data?.map((r) => (
          <a key={r.id} className="card click col" style={{ gap: 6, color: 'inherit', textDecoration: 'none' }} href={`#${base}/${r.id}`}>
            <div className="row spread"><h3>{r.name}</h3><Badge status={r.status} /></div>
            <p className="muted small">{describe?.(r) || ' '}</p>
            <p className="muted small">Version {r.version} · updated {fmtDate(r.updated_at)}</p>
          </a>
        ))}
      </div>
      {creating && (
        <Modal title={`New ${noun}`} onClose={() => setCreating(false)}>
          <form className="col" onSubmit={(e) => { e.preventDefault(); void create(); }}>
            <label className="field">Name<input autoFocus value={name} onChange={(e) => setName(e.target.value)} required /></label>
            <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn primary" disabled={busy || !name.trim()}>Create</button></div>
          </form>
        </Modal>
      )}
    </div>
  );
}

function Detail({ id, kind, noun, Editor, base }: { id: string; kind: string; noun: string; Editor: (p: EditorProps) => ReactNode; base: string }) {
  const { me, toast } = useApp();
  const { data: res, error, setData: setRes } = useLoad(() => GET<Res>(`/resources/${id}`), [id]);
  const [name, setName] = useState('');
  const [data, setData] = useState<any>(null);
  const [panel, setPanel] = useState<'' | 'history' | 'release' | 'publish'>('');
  const { busy, act } = useAction();
  useEffect(() => { if (res) { setName(res.name); setData(res.data); } }, [res]);
  if (error) return <div className="notice bad">{error} <a href={`#${base}`}>Back</a></div>;
  if (!res || data === null) return <p className="muted">Loading</p>;
  const readOnly = !canWrite(me.user.role, kind);
  const dirty = name !== res.name || JSON.stringify(data) !== JSON.stringify(res.data);
  const save = () => act(async () => { const r = await PUT<Res>(`/resources/${id}`, { name, data }); setRes(r); return r; }, 'Saved');
  return (
    <div className="col">
      <div className="row wrap spread">
        <div className="row grow" style={{ minWidth: 240 }}>
          <a href={`#${base}`} className="btn ghost sm" aria-label="Back to list">Back</a>
          <input aria-label={`${noun} name`} value={name} onChange={(e) => setName(e.target.value)} disabled={readOnly} style={{ fontSize: 17, fontWeight: 650, maxWidth: 420 }} />
          <Badge status={res.status} /><span className="muted small">v{res.version}</span>
        </div>
        <div className="row wrap">
          <button className="btn" onClick={() => setPanel('history')}>History</button>
          {RELEASABLE.includes(kind) && <button className="btn" onClick={() => (dirty ? toast('Save your changes before releasing', true) : setPanel('release'))}>Release</button>}
          {!readOnly && <button className="btn" onClick={() => setPanel('publish')}>Share</button>}
          {!readOnly && <button className="btn danger" disabled={busy} onClick={() => confirm(`Delete "${res.name}"? This cannot be undone.`) && act(async () => { await DEL(`/resources/${id}`); go(base); })}>Delete</button>}
          {!readOnly && <button className="btn primary" disabled={!dirty || busy} onClick={() => void save()}>{dirty ? 'Save' : 'Saved'}</button>}
        </div>
      </div>
      {readOnly && <div className="notice">Your role ({me.user.role.replace('_', ' ')}) can view and run this {noun} but not change it.</div>}
      <Editor res={res} data={data} set={(p) => setData((d: any) => ({ ...d, ...(typeof p === 'function' ? p(d) : p) }))} save={save} dirty={dirty} readOnly={readOnly} />
      {panel === 'history' && <History res={res} readOnly={readOnly} onClose={() => setPanel('')} onRestore={(r) => { setRes(r); setPanel(''); }} />}
      {panel === 'release' && <Release res={res} onClose={() => setPanel('')} onDone={() => GET<Res>(`/resources/${id}`).then(setRes)} />}
      {panel === 'publish' && <Publish res={res} onClose={() => setPanel('')} />}
    </div>
  );
}

function History({ res, readOnly, onClose, onRestore }: { res: Res; readOnly: boolean; onClose: () => void; onRestore: (r: Res) => void }) {
  const { data } = useLoad(() => GET<any[]>(`/resources/${res.id}/versions`), [res.id, res.version]);
  const { busy, act } = useAction();
  return (
    <Modal title="Version history" onClose={onClose} wide>
      <p className="muted small">Every saved change creates a version. Restoring an older one creates a new version with the old content.</p>
      <div className="table-wrap"><table><thead><tr><th>Version</th><th>Name</th><th>Saved</th><th>By</th><th>Note</th><th /></tr></thead><tbody>
        {data?.map((v) => (
          <tr key={v.version}><td className="num">{v.version}</td><td>{v.name}</td><td>{fmtDate(v.created_at)}</td><td>{v.email ?? ''}</td><td>{v.note}</td>
            <td>{v.version !== res.version && !readOnly && <button className="btn sm" disabled={busy} onClick={() => act(async () => onRestore(await POST<Res>(`/resources/${res.id}/restore`, { version: v.version })), `Restored version ${v.version}`)}>Restore</button>}</td></tr>
        ))}
      </tbody></table></div>
    </Modal>
  );
}

export function StageList({ stages }: { stages: { name: string; status: string; detail: string }[] }) {
  return <div className="col" style={{ gap: 6 }}>{stages.map((s, i) => <div key={i} className="row top"><span style={{ minWidth: 76 }}><Badge status={s.status} /></span><div><b>{s.name}</b><div className="muted small">{s.detail}</div></div></div>)}</div>;
}
function Release({ res, onClose, onDone }: { res: Res; onClose: () => void; onDone: () => void }) {
  const { me } = useApp();
  const [env, setEnv] = useState('dev');
  const [result, setResult] = useState<any>(null);
  const { busy, act } = useAction();
  const allowed = ['admin', 'developer'].includes(me.user.role);
  return (
    <Modal title={`Release ${res.name} v${res.version}`} onClose={onClose}>
      <p className="muted small">The pipeline runs commit, build, scan, promotion gate, validate (linked test suites) and release. A version must pass through each environment in order, and production waits for an approver.</p>
      {!allowed && <div className="notice warn">Only developers and admins can release.</div>}
      <div className="steps">{me.envs.map((e) => <button key={e} className={e === env ? 'on' : ''} onClick={() => { setEnv(e); setResult(null); }}>{e.toUpperCase()}</button>)}</div>
      {result && <><div className="row"><b>Result</b><Badge status={result.status} /></div><StageList stages={result.stages} /></>}
      <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn primary" disabled={busy || !allowed} onClick={() => act(async () => { setResult(await POST('/deployments', { resourceId: res.id, env })); onDone(); })}>{busy ? 'Running pipeline' : `Release to ${env.toUpperCase()}`}</button></div>
    </Modal>
  );
}
function Publish({ res, onClose }: { res: Res; onClose: () => void }) {
  const [description, setDescription] = useState('');
  const { busy, act } = useAction();
  return (
    <Modal title="Share in the marketplace" onClose={onClose}>
      <p className="muted small">Publishes a copy of this {res.kind} to your organisation's marketplace so colleagues can install it. Definitions with hard-coded credentials are refused.</p>
      <label className="field">Description<textarea value={description} onChange={(e) => setDescription(e.target.value)} /></label>
      <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn primary" disabled={busy} onClick={() => act(async () => { await POST('/marketplace/publish', { resourceId: res.id, description }); onClose(); }, 'Published to the marketplace')}>Publish</button></div>
    </Modal>
  );
}

export const opts = (rs: Res[] | undefined) => (rs ?? []).map((r) => ({ value: r.id, label: r.name }));
export function useRes(...kinds: string[]) {
  const { data } = useLoad(() => Promise.all(kinds.map(listRes)), [kinds.join()]);
  return Object.fromEntries(kinds.map((k, i) => [k, data?.[i] ?? []])) as Record<string, Res[]>;
}
export { newId };
