import { useState } from 'react';
import { DEL, fmtDate, GET, POST, PUT, type Res } from '../api.ts';
import { Empty, Modal, Tabs, Workspace, useAction, useLoad, useRes, type EditorProps } from '../ui.tsx';

export interface Column { name: string; label?: string; type: string; required?: boolean; unique?: boolean; indexed?: boolean; options?: string[]; relationTableId?: string }
const TYPES = [['text', 'Text'], ['longtext', 'Long text'], ['number', 'Number'], ['boolean', 'Yes / no'], ['date', 'Date'], ['choice', 'Choice'], ['relation', 'Relationship']];

/** One input for one column; shared by the record form and the app runtime. */
export function ColumnInput({ col, value, onChange, related }: { col: Column; value: any; onChange: (v: any) => void; related?: any[] }) {
  if (col.type === 'boolean') return <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />;
  if (col.type === 'choice') return <select value={value ?? ''} onChange={(e) => onChange(e.target.value)}><option value="">Choose</option>{col.options?.map((o) => <option key={o}>{o}</option>)}</select>;
  if (col.type === 'relation') return <select value={value ?? ''} onChange={(e) => onChange(e.target.value)}><option value="">Choose</option>{related?.map((r) => <option key={r.id} value={r.id}>{recordTitle(r)}</option>)}</select>;
  if (col.type === 'longtext') return <textarea value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
  return <input type={col.type === 'number' ? 'number' : col.type === 'date' ? 'date' : 'text'} step="any" value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
}
export const recordTitle = (r: any) => String(Object.entries(r).find(([k, v]) => k !== 'id' && k !== 'created_at' && v !== '' && v != null)?.[1] ?? r.id);
export const cell = (v: any) => (v === true ? 'Yes' : v === false ? 'No' : v == null ? '' : String(v));

function TableEditor({ res, data, set, dirty, readOnly }: EditorProps) {
  const [tab, setTab] = useState('Columns');
  const { table: tables } = useRes('table');
  const cols: Column[] = data.columns ?? [];
  const put = (i: number, p: Partial<Column>) => set({ columns: cols.map((c, j) => (j === i ? { ...c, ...p } : c)) });
  return (
    <div className="col">
      <Tabs tabs={['Columns', 'Records']} value={tab} onChange={setTab} />
      {tab === 'Columns' ? (
        <div className="col">
          <div className="table-wrap"><table>
            <thead><tr><th>Column name</th><th>Label</th><th>Type</th><th>Details</th><th>Required</th><th>Unique</th><th>Indexed</th><th /></tr></thead>
            <tbody>
              {cols.map((c, i) => (
                <tr key={i}>
                  <td><input aria-label="Column name" className="mono" value={c.name} disabled={readOnly} onChange={(e) => put(i, { name: e.target.value.replace(/[^A-Za-z0-9_]/g, '_') })} /></td>
                  <td><input aria-label="Label" value={c.label ?? ''} disabled={readOnly} onChange={(e) => put(i, { label: e.target.value })} /></td>
                  <td><select aria-label="Type" value={c.type} disabled={readOnly} onChange={(e) => put(i, { type: e.target.value })}>{TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></td>
                  <td style={{ minWidth: 180 }}>
                    {c.type === 'choice' && <input aria-label="Options" placeholder="Options, comma separated" defaultValue={(c.options ?? []).join(', ')} onBlur={(e) => put(i, { options: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} />}
                    {c.type === 'relation' && <select aria-label="Related table" value={c.relationTableId ?? ''} onChange={(e) => put(i, { relationTableId: e.target.value })}><option value="">Related table</option>{tables.filter((t) => t.id !== res.id).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>}
                  </td>
                  {(['required', 'unique', 'indexed'] as const).map((k) => <td key={k}><input type="checkbox" aria-label={k} checked={!!c[k]} disabled={readOnly} onChange={(e) => put(i, { [k]: e.target.checked })} /></td>)}
                  <td>{!readOnly && <button className="btn sm ghost danger" onClick={() => set({ columns: cols.filter((_, j) => j !== i) })}>Remove</button>}</td>
                </tr>
              ))}
              {!cols.length && <tr><td colSpan={8} className="muted">No columns yet.</td></tr>}
            </tbody>
          </table></div>
          {!readOnly && <div><button className="btn" onClick={() => set({ columns: [...cols, { name: `field_${cols.length + 1}`, label: '', type: 'text' }] })}>Add column</button></div>}
          <p className="muted small">Indexed and unique columns get a real database index. Relationships are checked when a record is saved.</p>
        </div>
      ) : dirty ? <div className="notice warn">Save the column changes to work with records.</div> : <Records table={res} />}
    </div>
  );
}

export function Records({ table }: { table: Res }) {
  const cols: Column[] = table.data.columns ?? [];
  const { data: rows, reload } = useLoad(() => GET<any[]>(`/tables/${table.id}/records`), [table.id, table.version]);
  const relIds = [...new Set(cols.filter((c) => c.type === 'relation' && c.relationTableId).map((c) => c.relationTableId!))];
  const { data: related } = useLoad(() => Promise.all(relIds.map((id) => GET<any[]>(`/tables/${id}/records`).catch(() => []))), [relIds.join()]);
  const rel = (c: Column) => related?.[relIds.indexOf(c.relationTableId!)] ?? [];
  const [edit, setEdit] = useState<any | null>(null);
  const { busy, act } = useAction();
  const save = () => act(async () => { if (edit.id) await PUT(`/tables/${table.id}/records/${edit.id}`, edit); else await POST(`/tables/${table.id}/records`, edit); setEdit(null); reload(); }, 'Record saved');
  if (!cols.length) return <Empty>Add columns first, then records can be entered here or through an app, a workflow or an agent.</Empty>;
  return (
    <div className="col">
      <div className="row spread"><span className="muted small">{rows?.length ?? 0} record(s)</span><button className="btn primary" onClick={() => setEdit({})}>Add record</button></div>
      <div className="table-wrap"><table>
        <thead><tr>{cols.map((c) => <th key={c.name}>{c.label || c.name}</th>)}<th>Created</th><th /></tr></thead>
        <tbody>
          {rows?.map((r) => (
            <tr key={r.id}>
              {cols.map((c) => <td key={c.name} className={c.type === 'number' ? 'num' : ''}>{c.type === 'relation' ? recordTitle(rel(c).find((x: any) => x.id === r[c.name]) ?? { id: r[c.name] ?? '' }) : cell(r[c.name]).slice(0, 140)}</td>)}
              <td className="muted small">{fmtDate(r.created_at)}</td>
              <td className="row"><button className="btn sm" onClick={() => setEdit(r)}>Edit</button><button className="btn sm ghost danger" onClick={() => confirm('Delete this record?') && act(async () => { await DEL(`/tables/${table.id}/records/${r.id}`); reload(); })}>Delete</button></td>
            </tr>
          ))}
          {rows && !rows.length && <tr><td colSpan={cols.length + 2} className="muted">No records yet.</td></tr>}
        </tbody>
      </table></div>
      {edit && (
        <Modal title={edit.id ? 'Edit record' : 'Add record'} onClose={() => setEdit(null)}>
          <form className="col" onSubmit={(e) => { e.preventDefault(); void save(); }}>
            {cols.map((c) => <label key={c.name} className="field">{c.label || c.name}{c.required ? ' (required)' : ''}<ColumnInput col={c} value={edit[c.name]} onChange={(v) => setEdit({ ...edit, [c.name]: v })} related={rel(c)} /></label>)}
            <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn primary" disabled={busy}>Save</button></div>
          </form>
        </Modal>
      )}
    </div>
  );
}

export const Data = ({ id }: { id?: string }) => (
  <Workspace kind="table" id={id} base="/data" title="Data tables" noun="table" blurb="Define tables, columns, relationships and indexes. Apps, workflows and agents read and write these records."
    blank={() => ({ columns: [{ name: 'name', label: 'Name', type: 'text', required: true }] })} Editor={TableEditor} describe={(r) => `${r.data.columns?.length ?? 0} column(s)`} />
);
