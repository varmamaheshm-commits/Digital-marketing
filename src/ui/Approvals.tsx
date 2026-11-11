import { useState } from 'react';
import { decideMessage, decidePost, decideVideo } from '../core/actions';
import { patch, useStore } from '../core/store';
import type { Message, Post } from '../core/types';
import { Empty, fmtDateTime, Icon, toast } from './common';
import { VideoCard, VideoDetail } from './Videos';

export function EditableText({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(value);
  if (!editing) return <div className="stack"><div className="pre clamp">{value}</div><div><button className="btn small ghost" onClick={() => { setText(value); setEditing(true); }}>Edit text</button></div></div>;
  return (
    <div className="stack">
      <textarea rows={7} value={text} onChange={(e) => setText(e.target.value)} />
      <div className="row"><button className="btn small primary" onClick={() => { onSave(text); setEditing(false); }}>Save</button><button className="btn small" onClick={() => setEditing(false)}>Cancel</button></div>
    </div>
  );
}

export function Approvals() {
  const { data } = useStore();
  const [open, setOpen] = useState<string | null>(null);
  const videos = data.videos.filter((v) => v.status === 'pending');
  const working = data.videos.filter((v) => v.status === 'queued' || v.status === 'rendering');
  const posts = data.posts.filter((p) => p.status === 'pending').sort((a, b) => a.scheduledFor - b.scheduledFor);
  const messages = data.messages.filter((m) => m.status === 'pending');
  const productName = (id: string) => data.products.find((p) => p.id === id)?.name ?? '—';
  const lead = (id: string) => data.leads.find((l) => l.id === id);
  const nothing = videos.length + posts.length + messages.length + working.length === 0;

  async function approveAll(kind: 'posts' | 'messages') {
    if (!confirm(`Approve all ${kind === 'posts' ? posts.length + ' posts' : messages.length + ' messages'}?`)) return;
    if (kind === 'posts') for (const p of posts) await decidePost(p.id, true);
    else for (const m of messages) await decideMessage(m.id, true);
    toast('Approved');
  }

  return (
    <>
      <div className="head">
        <div className="grow"><h1>Approvals</h1><p>You have the final say. Review each item, then approve or reject it.</p></div>
      </div>
      {nothing && <Empty title="All caught up">Nothing is waiting for you right now.</Empty>}

      {(videos.length > 0 || working.length > 0) && (
        <section style={{ marginBottom: 22 }}>
          <h2>Videos ({videos.length}){working.length > 0 && <small className="muted"> · {working.length} still being created</small>}</h2>
          <div className="grid g3">
            {[...videos, ...working].map((v) => <VideoCard key={v.id} v={v} onOpen={() => setOpen(v.id)} />)}
          </div>
        </section>
      )}

      {posts.length > 0 && (
        <section style={{ marginBottom: 22 }}>
          <div className="row between"><h2>Posts & ads ({posts.length})</h2><button className="btn small" onClick={() => approveAll('posts')}>Approve all</button></div>
          <div className="grid g2">
            {posts.map((p: Post) => (
              <div className="card stack" key={p.id}>
                <div className="row between"><b style={{ textTransform: 'capitalize' }}>{p.platform} · {productName(p.productId)}</b><small>{fmtDateTime(p.scheduledFor)}</small></div>
                <small>{p.title}</small>
                <EditableText value={p.body} onSave={(body) => patch('posts', p.id, { body })} />
                {p.hashtags.length > 0 && <small>{p.hashtags.join(' ')}</small>}
                <div className="row">
                  <button className="btn ok small" data-testid="approve-post" onClick={() => decidePost(p.id, true)}><Icon name="check" size={15} /> Approve</button>
                  <button className="btn danger small" onClick={() => decidePost(p.id, false)}>Reject</button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {messages.length > 0 && (
        <section>
          <div className="row between"><h2>Lead messages ({messages.length})</h2><button className="btn small" onClick={() => approveAll('messages')}>Approve all</button></div>
          <div className="grid g2">
            {messages.map((m: Message) => (
              <div className="card stack" key={m.id}>
                <div className="row between"><b>To {lead(m.leadId)?.name || 'lead'}</b><span className="chip">{m.channel} · {m.reason}</span></div>
                <EditableText value={m.body} onSave={(body) => patch('messages', m.id, { body })} />
                <div className="row">
                  <button className="btn ok small" data-testid="approve-message" onClick={() => decideMessage(m.id, true)}><Icon name="check" size={15} /> Approve</button>
                  <button className="btn danger small" onClick={() => decideMessage(m.id, false)}>Reject</button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
      {open && <VideoDetail id={open} onClose={() => setOpen(null)} />}
    </>
  );
}
