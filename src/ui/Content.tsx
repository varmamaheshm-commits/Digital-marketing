import { useState } from 'react';
import { createPost, decidePost } from '../core/actions';
import { copyText } from '../core/files';
import { patch, remove, useStore } from '../core/store';
import type { Platform, Post } from '../core/types';
import { EditableText } from './Approvals';
import { Chip, Empty, Field, fmtDateTime, Icon, Modal, toast, toLocalInput } from './common';
import { VideoDetail } from './Videos';

const PLATFORMS: Platform[] = ['instagram', 'youtube', 'facebook', 'whatsapp', 'email', 'ad'];

export function Content() {
  const { data } = useStore();
  const [filter, setFilter] = useState<'upcoming' | 'approved' | 'published' | 'all'>('upcoming');
  const [creating, setCreating] = useState(false);
  const [video, setVideo] = useState<string | null>(null);
  const now = Date.now();
  const posts = [...data.posts]
    .filter((p) => (filter === 'all' ? true : filter === 'upcoming' ? p.status !== 'published' && p.status !== 'rejected' : p.status === filter))
    .sort((a, b) => a.scheduledFor - b.scheduledFor);
  const productName = (id: string) => data.products.find((p) => p.id === id)?.name ?? '—';
  const fullText = (p: Post) => [p.platform === 'youtube' || p.platform === 'email' ? p.title : '', p.body, p.hashtags.join(' ')].filter(Boolean).join('\n\n');

  return (
    <>
      <div className="head">
        <div className="grow"><h1>Content calendar</h1><p>Posts, emails, WhatsApp broadcasts and ad copy, written for each product.</p></div>
        <button className="btn primary" disabled={!data.products.length} onClick={() => setCreating(true)}><Icon name="plus" /> Write a post</button>
      </div>
      <div className="tabs">
        {(['upcoming', 'approved', 'published', 'all'] as const).map((f) => <button key={f} className={'tab' + (filter === f ? ' on' : '')} onClick={() => setFilter(f)}>{f[0].toUpperCase() + f.slice(1)}</button>)}
      </div>
      {posts.length === 0 ? <Empty title="Nothing scheduled">Autopilot fills the coming week once you have an active product.</Empty> : (
        <div className="grid g2">
          {posts.map((p) => (
            <div className="card stack" key={p.id}>
              <div className="row between">
                <b style={{ textTransform: 'capitalize' }}>{p.platform} · {productName(p.productId)}</b>
                <Chip status={p.status} />
              </div>
              <small>{fmtDateTime(p.scheduledFor)}{p.status === 'approved' && p.scheduledFor < now ? ' · due now' : ''} — {p.title}</small>
              <EditableText value={p.body} onSave={(body) => patch('posts', p.id, { body })} />
              {p.hashtags.length > 0 && <small>{p.hashtags.join(' ')}</small>}
              <div className="row">
                {p.status === 'pending' && <><button className="btn ok small" onClick={() => decidePost(p.id, true)}>Approve</button><button className="btn danger small" onClick={() => decidePost(p.id, false)}>Reject</button></>}
                {(p.status === 'approved' || p.status === 'published') && <button className="btn small" onClick={async () => { await copyText(fullText(p)); toast('Text copied — paste it into ' + p.platform); }}><Icon name="copy" size={15} /> Copy text</button>}
                {p.status === 'approved' && p.videoId && <button className="btn small" onClick={() => setVideo(p.videoId!)}><Icon name="video" size={15} /> Video</button>}
                {p.status === 'approved' && <button className="btn small" onClick={() => patch('posts', p.id, { status: 'published' })}>Mark as posted</button>}
                <button className="btn small ghost danger" onClick={() => confirm('Delete this post?') && remove('posts', p.id)} aria-label="Delete post"><Icon name="trash" size={15} /></button>
              </div>
            </div>
          ))}
        </div>
      )}
      {creating && <NewPost onClose={() => setCreating(false)} />}
      {video && <VideoDetail id={video} onClose={() => setVideo(null)} />}
    </>
  );
}

function NewPost({ onClose }: { onClose: () => void }) {
  const { data } = useStore();
  const [productId, setProductId] = useState(data.products[0]?.id ?? '');
  const [platform, setPlatform] = useState<Platform>('instagram');
  const [when, setWhen] = useState(toLocalInput(Date.now() + 86_400_000));
  return (
    <Modal title="Write a post" onClose={onClose}
      footer={<button className="btn primary" onClick={async () => { await createPost(productId, platform, new Date(when).getTime() || Date.now()); onClose(); toast('Draft written — waiting for your approval'); }}>Write it</button>}>
      <div className="form">
        <Field label="Product"><select value={productId} onChange={(e) => setProductId(e.target.value)}>{data.products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
        <Field label="Where"><select value={platform} onChange={(e) => setPlatform(e.target.value as Platform)}>{PLATFORMS.map((p) => <option key={p} value={p}>{p[0].toUpperCase() + p.slice(1)}</option>)}</select></Field>
        <Field label="When"><input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}
