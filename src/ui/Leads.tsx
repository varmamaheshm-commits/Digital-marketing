import { useState, type FormEvent } from 'react';
import { decideMessage, deleteLead, draftMessage, markMessageSent, messageLink, runAutopilot, saveLead } from '../core/actions';
import { copyText, saveFile } from '../core/files';
import { leadsFromCsv, leadsToCsv } from '../core/leads';
import { log, useStore, verifyPassword } from '../core/store';
import { uid, type Lead, type LeadStage } from '../core/types';
import { Chip, Empty, Field, fmtDate, Icon, Modal, toast } from './common';

const STAGES: LeadStage[] = ['new', 'contacted', 'qualified', 'won', 'lost'];
const blank = (): Lead => ({ id: uid(), name: '', phone: '', email: '', source: 'manual', stage: 'new', score: 0, notes: '', consent: false, value: 0, createdAt: Date.now() });

export function Leads() {
  const { data } = useStore();
  const [stage, setStage] = useState<LeadStage | 'all'>('all');
  const [q, setQ] = useState('');
  const [edit, setEdit] = useState<Lead | null>(null);
  const [kiosk, setKiosk] = useState(false);
  const productName = (id?: string) => data.products.find((p) => p.id === id)?.name ?? '';
  const leads = data.leads
    .filter((l) => (stage === 'all' || l.stage === stage) && (l.name + l.phone + l.email).toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => b.score - a.score || b.createdAt - a.createdAt);

  async function importCsv(file?: File) {
    if (!file) return;
    const found = leadsFromCsv(await file.text());
    for (const l of found) await saveLead(l);
    await log('owner', `Imported ${found.length} lead(s) from ${file.name}.`);
    toast(found.length ? `Imported ${found.length} lead(s)` : 'No leads found in this file');
  }

  if (kiosk) return <Kiosk onExit={() => setKiosk(false)} />;
  return (
    <>
      <div className="head">
        <div className="grow"><h1>Leads</h1><p>Every enquiry in one place, scored and followed up automatically.</p></div>
        <button className="btn" onClick={() => setKiosk(true)}>Capture form</button>
        <label className="btn">Import CSV<input type="file" accept=".csv,text/csv" hidden onChange={(e) => { void importCsv(e.target.files?.[0]); e.target.value = ''; }} /></label>
        <button className="btn" disabled={!data.leads.length} onClick={() => saveFile(new Blob([leadsToCsv(data.leads, productName)], { type: 'text/csv' }), 'leads.csv')}>Export</button>
        <button className="btn primary" data-testid="add-lead" onClick={() => setEdit(blank())}><Icon name="plus" /> Add lead</button>
      </div>
      <div className="tabs">
        {(['all', ...STAGES] as const).map((s) => (
          <button key={s} className={'tab' + (stage === s ? ' on' : '')} onClick={() => setStage(s)}>
            {s[0].toUpperCase() + s.slice(1)} ({s === 'all' ? data.leads.length : data.leads.filter((l) => l.stage === s).length})
          </button>
        ))}
        <input style={{ maxWidth: 220 }} placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search leads" />
      </div>
      {leads.length === 0 ? <Empty title="No leads here">Add leads by hand, import a CSV, or use the capture form at your counter or event.</Empty> : (
        <div className="card table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Contact</th><th>Interested in</th><th>Stage</th><th>Score</th><th>Added</th></tr></thead>
            <tbody>
              {leads.map((l) => (
                <tr key={l.id} className="click" onClick={() => setEdit(l)}>
                  <td><b>{l.name || '—'}</b><br /><small>{l.source}</small></td>
                  <td>{l.phone}<br /><small>{l.email}</small></td>
                  <td>{productName(l.productId) || '—'}</td>
                  <td><Chip status={l.stage} /></td>
                  <td><b>{l.score}</b></td>
                  <td>{fmtDate(l.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {edit && <LeadForm initial={edit} onClose={() => setEdit(null)} />}
    </>
  );
}

function LeadForm({ initial, onClose }: { initial: Lead; onClose: () => void }) {
  const { data } = useStore();
  const [l, setL] = useState(initial);
  const isNew = !data.leads.some((x) => x.id === initial.id);
  const set = (k: keyof Lead, v: any) => setL((x) => ({ ...x, [k]: v }));
  const messages = data.messages.filter((m) => m.leadId === l.id).sort((a, b) => b.createdAt - a.createdAt);

  async function save() {
    if (!l.name.trim() && !l.phone.trim() && !l.email.trim()) return toast('Enter a name, phone or email');
    await saveLead(l);
    onClose();
    await runAutopilot();
  }
  return (
    <Modal wide title={isNew ? 'Add lead' : l.name || 'Lead'} onClose={onClose}
      footer={
        <>
          {!isNew && <button className="btn danger" onClick={async () => { if (confirm('Delete this lead and its messages?')) { await deleteLead(l.id); onClose(); } }}><Icon name="trash" /> Delete</button>}
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" data-testid="save-lead" onClick={save}>Save</button>
        </>
      }>
      <div className="form">
        <Field label="Name"><input data-testid="l-name" value={l.name} onChange={(e) => set('name', e.target.value)} autoFocus /></Field>
        <Field label="Phone / WhatsApp"><input data-testid="l-phone" value={l.phone} onChange={(e) => set('phone', e.target.value)} inputMode="tel" /></Field>
        <Field label="Email"><input value={l.email} onChange={(e) => set('email', e.target.value)} inputMode="email" /></Field>
        <Field label="Source"><input value={l.source} onChange={(e) => set('source', e.target.value)} placeholder="Instagram, referral, walk-in…" /></Field>
        <Field label="Interested in">
          <select value={l.productId ?? ''} onChange={(e) => set('productId', e.target.value || undefined)}>
            <option value="">—</option>{data.products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
        <Field label="Stage"><select value={l.stage} onChange={(e) => set('stage', e.target.value)}>{STAGES.map((s) => <option key={s}>{s}</option>)}</select></Field>
        <Field label="Deal value"><input type="number" min={0} value={l.value || ''} onChange={(e) => set('value', Number(e.target.value) || 0)} /></Field>
        <Field label="Notes" full><textarea value={l.notes} onChange={(e) => set('notes', e.target.value)} /></Field>
        <label className="check full"><input data-testid="l-consent" type="checkbox" checked={l.consent} onChange={(e) => set('consent', e.target.checked)} /> This person agreed to be contacted (required before any follow-up is drafted)</label>
      </div>
      {!isNew && (
        <div className="stack" style={{ marginTop: 18 }}>
          <div className="row between">
            <h3>Messages</h3>
            <div className="row">
              <button className="btn small" disabled={!l.consent} onClick={() => draftMessage(l.id, 'follow-up')}>Draft follow-up</button>
              <button className="btn small" disabled={!l.consent} onClick={() => draftMessage(l.id, 'offer')}>Draft offer</button>
            </div>
          </div>
          {messages.length === 0 && <small className="muted">No messages yet.</small>}
          {messages.map((m) => (
            <div className="card stack" key={m.id}>
              <div className="row between"><span className="chip">{m.channel} · {m.reason}</span><Chip status={m.status} /></div>
              <div className="pre">{m.body}</div>
              <div className="row">
                {m.status === 'pending' && <><button className="btn ok small" onClick={() => decideMessage(m.id, true)}>Approve</button><button className="btn danger small" onClick={() => decideMessage(m.id, false)}>Reject</button></>}
                {m.status === 'approved' && (
                  <>
                    <a className="btn small primary" href={messageLink(m, l)} target="_blank" rel="noreferrer noopener">Open in {m.channel === 'email' ? 'email' : m.channel === 'sms' ? 'SMS' : 'WhatsApp'}</a>
                    <button className="btn small" onClick={async () => { await copyText(m.body); toast('Message copied'); }}><Icon name="copy" size={15} /> Copy</button>
                    <button className="btn small" onClick={() => markMessageSent(m.id)}>Mark as sent</button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

/** Full-screen enquiry form for a shop counter or event. Leaving it needs the master password. */
function Kiosk({ onExit }: { onExit: () => void }) {
  const { data, settings } = useStore();
  const [l, setL] = useState(blank());
  const [thanks, setThanks] = useState(false);
  const [exiting, setExiting] = useState(false);
  const [pw, setPw] = useState('');
  const set = (k: keyof Lead, v: any) => setL((x) => ({ ...x, [k]: v }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!l.name.trim() || (!l.phone.trim() && !l.email.trim())) return toast('Please enter your name and a phone or email');
    await saveLead({ ...l, source: 'capture form', createdAt: Date.now() });
    setL(blank());
    setThanks(true);
    setTimeout(() => setThanks(false), 3500);
  }
  async function exit(e: FormEvent) {
    e.preventDefault();
    if (await verifyPassword(pw)) { onExit(); void runAutopilot(); }
    else { toast('Wrong password'); setPw(''); }
  }
  return (
    <div className="kiosk">
      <div className="card stack" style={{ width: 'min(520px, 100%)' }}>
        {exiting ? (
          <form className="stack" onSubmit={exit}>
            <h2>Enter the master password to close the form</h2>
            <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus aria-label="Master password" />
            <div className="row"><button className="btn primary">Close form</button><button type="button" className="btn" onClick={() => setExiting(false)}>Back</button></div>
          </form>
        ) : thanks ? (
          <div className="empty"><b>Thank you!</b>We will be in touch soon.</div>
        ) : (
          <form className="stack" onSubmit={submit}>
            <h1>{settings.business.name || 'Get in touch'}</h1>
            <p className="muted">Leave your details and we will contact you.</p>
            <Field label="Your name"><input value={l.name} onChange={(e) => set('name', e.target.value)} /></Field>
            <Field label="Phone / WhatsApp"><input value={l.phone} onChange={(e) => set('phone', e.target.value)} inputMode="tel" /></Field>
            <Field label="Email (optional)"><input value={l.email} onChange={(e) => set('email', e.target.value)} inputMode="email" /></Field>
            {data.products.length > 0 && (
              <Field label="I am interested in">
                <select value={l.productId ?? ''} onChange={(e) => set('productId', e.target.value || undefined)}>
                  <option value="">Not sure yet</option>{data.products.filter((p) => p.active).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </Field>
            )}
            <label className="check"><input type="checkbox" checked={l.consent} onChange={(e) => set('consent', e.target.checked)} /> I agree to be contacted about my enquiry</label>
            <button className="btn primary">Send</button>
            <button type="button" className="btn ghost small" onClick={() => setExiting(true)}><Icon name="lock" size={14} /> Staff</button>
          </form>
        )}
      </div>
    </div>
  );
}
