import { useState } from 'react';
import { createVideo, decideVideo, deleteVideo, rerenderVideo } from '../core/actions';
import { canShareFiles, copyText, saveFile, shareFile } from '../core/files';
import { getBlob, patch, useStore } from '../core/store';
import { FORMAT_INFO, type MusicMood, type Video, type VideoFormat, type VideoStyle } from '../core/types';
import { canRenderVideo } from '../video/render';
import { Chip, Empty, Field, fmtDateTime, fmtSize, Icon, Modal, Picture, toast, useBlobUrl } from './common';

export function VideoCard({ v, onOpen }: { v: Video; onOpen: () => void }) {
  const { data } = useStore();
  const product = data.products.find((p) => p.id === v.productId);
  return (
    <div className="card stack">
      <button className="btn ghost" style={{ padding: 0, display: 'block' }} onClick={onOpen} aria-label={`Open video for ${product?.name}`}>
        <Picture id={v.thumbId} alt="" contain />
      </button>
      <div className="row between"><b>{product?.name ?? 'Deleted product'}</b><Chip status={v.status} /></div>
      <small>{FORMAT_INFO[v.format].label} · {v.style} · {fmtDateTime(v.createdAt)}</small>
      {(v.status === 'rendering' || v.status === 'queued') && (
        <div className="bar"><i style={{ width: `${Math.round((v.progress ?? 0) * 100)}%` }} /></div>
      )}
      {v.status === 'failed' && <div className="notice bad">{v.error}</div>}
      <div className="row">
        <button className="btn small" onClick={onOpen}>{v.status === 'pending' ? 'Review' : 'Open'}</button>
        {v.status === 'failed' && <button className="btn small" onClick={() => rerenderVideo(v, false)}><Icon name="refresh" size={15} /> Retry</button>}
      </div>
    </div>
  );
}

export function VideoDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const { data } = useStore();
  const v = data.videos.find((x) => x.id === id);
  const url = useBlobUrl(v?.blobId, v?.mime ?? 'video/mp4');
  const poster = useBlobUrl(v?.thumbId, 'image/jpeg');
  const [script, setScript] = useState(v?.script ?? []);
  const [caption, setCaption] = useState(v?.caption ?? '');
  const [dirty, setDirty] = useState(false);
  if (!v) return null;
  const product = data.products.find((p) => p.id === v.productId);
  const fileName = `${product?.name ?? 'video'}-${v.format}.mp4`;
  const fullCaption = [caption, v.hashtags.join(' ')].filter(Boolean).join('\n\n');
  const done = v.status === 'pending' || v.status === 'approved' || v.status === 'rejected';

  async function file() {
    const b = v!.blobId ? await getBlob(v!.blobId) : null;
    return b ? new Blob([b], { type: v!.mime ?? 'video/mp4' }) : null;
  }
  async function download() {
    const b = await file();
    if (b) { await saveFile(b, fileName); toast('Video saved'); }
  }
  async function share() {
    const b = await file();
    if (b) await shareFile(b, fileName, fullCaption).catch((e) => toast(String(e?.message ?? e)));
  }
  async function applyScript() {
    await rerenderVideo({ ...v!, script, caption }, false);
    setDirty(false);
    toast('Re-creating the video with your changes');
  }

  return (
    <Modal wide title={`${product?.name ?? 'Video'} — ${FORMAT_INFO[v.format].label}`} onClose={onClose}
      footer={
        <>
          <button className="btn danger" onClick={async () => { if (confirm('Delete this video?')) { await deleteVideo(v.id); onClose(); } }}><Icon name="trash" /> Delete</button>
          {done && <button className="btn" onClick={() => rerenderVideo(v, true)}><Icon name="refresh" /> New version</button>}
          {v.status === 'pending' && <button className="btn danger" data-testid="reject-video" onClick={() => decideVideo(v.id, false)}>Reject</button>}
          {(v.status === 'pending' || v.status === 'rejected') && <button className="btn ok" data-testid="approve-video" onClick={() => decideVideo(v.id, true)}><Icon name="check" /> Approve</button>}
          {v.status === 'approved' && (
            <>
              <button className="btn" onClick={async () => { await copyText(fullCaption); toast('Caption copied'); }}><Icon name="copy" /> Copy caption</button>
              {canShareFiles() && <button className="btn" onClick={share}><Icon name="share" /> Share</button>}
              <button className="btn primary" data-testid="download-video" onClick={download}><Icon name="download" /> Save video</button>
            </>
          )}
        </>
      }>
      <div className="grid g2">
        <div className="stack">
          {url ? <video className="player" src={url} poster={poster ?? undefined} controls playsInline data-testid="player" /> : (
            <div className="thumb" style={{ aspectRatio: '16/10' }}>
              {v.status === 'failed' ? 'Could not create this video' : v.status === 'queued' ? 'Waiting in queue…' : v.status === 'rendering' ? `Creating… ${Math.round((v.progress ?? 0) * 100)}%` : 'Loading…'}
            </div>
          )}
          <div className="row"><Chip status={v.status} /><small>{v.codec} · {fmtSize(v.sizeBytes)} · {v.seconds?.toFixed(0)}s</small></div>
          {v.status === 'pending' && <div className="notice warn">Waiting for your approval. Saving and sharing unlock after you approve.</div>}
          {v.status === 'approved' && <div className="notice ok">Approved. Save or share it to {FORMAT_INFO[v.format].use}.</div>}
          {v.error && <div className="notice bad">{v.error}</div>}
        </div>
        <div className="stack">
          <h3>Script</h3>
          {script.map((sc, i) => (
            <label className="field" key={i}>
              <span style={{ textTransform: 'capitalize' }}>{sc.kind}</span>
              <input value={sc.text} onChange={(e) => { setScript(script.map((x, j) => (j === i ? { ...x, text: e.target.value } : x))); setDirty(true); }} />
            </label>
          ))}
          <Field label="Caption for the post">
            <textarea rows={5} value={caption} onChange={(e) => { setCaption(e.target.value); setDirty(true); }} />
          </Field>
          <small>{v.hashtags.join(' ')}</small>
          {dirty && (
            <div className="row">
              <button className="btn primary" onClick={applyScript}>Re-create with changes</button>
              <button className="btn" onClick={async () => { await patch('videos', v.id, { caption }); setDirty(false); toast('Caption saved'); }}>Save caption only</button>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

export function Videos() {
  const { data } = useStore();
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState('all');
  const videos = [...data.videos].sort((a, b) => b.createdAt - a.createdAt).filter((v) => filter === 'all' || v.status === filter);
  return (
    <>
      <div className="head">
        <div className="grow"><h1>Videos</h1><p>Created automatically from your product photos, in full HD, on this device.</p></div>
        <button className="btn primary" disabled={!data.products.length} onClick={() => setCreating(true)}><Icon name="plus" /> Create video</button>
      </div>
      {!canRenderVideo() && <div className="notice bad" style={{ marginBottom: 12 }}>This browser has no built-in video encoder. Use the desktop or Android app, or a current Chrome, Edge or Safari.</div>}
      <div className="tabs">
        {['all', 'pending', 'approved', 'rejected', 'failed'].map((f) => (
          <button key={f} className={'tab' + (filter === f ? ' on' : '')} onClick={() => setFilter(f)}>{f === 'pending' ? 'Needs approval' : f[0].toUpperCase() + f.slice(1)}</button>
        ))}
      </div>
      {videos.length === 0 ? (
        <Empty title="No videos here yet">Add a product and Autopilot will create videos for it.</Empty>
      ) : (
        <div className="grid g3">{videos.map((v) => <VideoCard key={v.id} v={v} onOpen={() => setOpen(v.id)} />)}</div>
      )}
      {open && <VideoDetail id={open} onClose={() => setOpen(null)} />}
      {creating && <CreateVideo onClose={() => setCreating(false)} />}
    </>
  );
}

function CreateVideo({ onClose }: { onClose: () => void }) {
  const { data } = useStore();
  const [productId, setProductId] = useState(data.products[0]?.id ?? '');
  const [format, setFormat] = useState<VideoFormat>('reel');
  const [style, setStyle] = useState<VideoStyle | ''>('');
  const [mood, setMood] = useState<MusicMood | ''>('');
  return (
    <Modal title="Create a video" onClose={onClose}
      footer={<button className="btn primary" onClick={async () => { await createVideo(productId, format, style || undefined, mood || undefined); onClose(); toast('Video is being created'); }}>Create</button>}>
      <div className="form">
        <Field label="Product"><select value={productId} onChange={(e) => setProductId(e.target.value)}>{data.products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
        <Field label="Shape" hint={FORMAT_INFO[format].use}>
          <select value={format} onChange={(e) => setFormat(e.target.value as VideoFormat)}>
            {(Object.keys(FORMAT_INFO) as VideoFormat[]).map((f) => <option key={f} value={f}>{FORMAT_INFO[f].label} ({FORMAT_INFO[f].w}×{FORMAT_INFO[f].h})</option>)}
          </select>
        </Field>
        <Field label="Look">
          <select value={style} onChange={(e) => setStyle(e.target.value as VideoStyle)}>
            <option value="">Automatic</option><option value="bold">Bold</option><option value="clean">Clean</option><option value="luxe">Luxury</option>
          </select>
        </Field>
        <Field label="Music">
          <select value={mood} onChange={(e) => setMood(e.target.value as MusicMood)}>
            <option value="">Automatic</option><option value="upbeat">Upbeat</option><option value="chill">Chill</option><option value="cinematic">Cinematic</option><option value="none">No music</option>
          </select>
        </Field>
      </div>
    </Modal>
  );
}
