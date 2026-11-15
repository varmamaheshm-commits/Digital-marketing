import { useState } from 'react';
import { addUploadedVideo, createVideo, decideVideo, deleteVideo, rerenderVideo } from '../core/actions';
import { inspectVideo, MAX_UPLOAD_BYTES, shapeOf, uploadMime, type VideoInfo } from '../video/upload';
import { canShareFiles, copyText, saveFile, shareFile } from '../core/files';
import { accountFor, desktopSocial, postNow } from '../core/publisher';
import { getBlob, patch, useStore } from '../core/store';
import { FORMAT_INFO, LANG_NAMES, TARGET_INFO, type Lang, type SocialTarget, type MusicMood, type Video, type VideoFormat, type VideoStyle } from '../core/types';
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
      <div className="row between"><b>{product?.name ?? 'Deleted product'}</b><span className="row">{v.source === 'upload' && <span className="chip">your video</span>}{v.aiScript && <span className="chip">AI script</span>}<Chip status={v.status} /></span></div>
      <small>{FORMAT_INFO[v.format].label} · {v.source === 'upload' ? 'uploaded' : `${LANG_NAMES[v.lang ?? 'en']} · ${v.style}`} · {fmtDateTime(v.createdAt)}</small>
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
  const uploaded = v.source === 'upload';
  const fileName = `${product?.name ?? 'video'}-${v.format}.${v.mime === 'video/quicktime' ? 'mov' : 'mp4'}`;
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
          {done && !uploaded && <button className="btn" onClick={() => rerenderVideo(v, true)}><Icon name="refresh" /> New version</button>}
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
          <div className="row"><Chip status={v.status} /><small>{[v.codec, fmtSize(v.sizeBytes), v.seconds ? v.seconds.toFixed(0) + 's' : ''].filter(Boolean).join(' · ')}</small></div>
          {v.status === 'pending' && <div className="notice warn">Waiting for your approval. Saving and sharing unlock after you approve.</div>}
          {v.status === 'approved' && <div className="notice ok">Approved. Save or share it to {FORMAT_INFO[v.format].use}.</div>}
          {v.error && <div className="notice bad">{v.error}</div>}
          {v.status === 'approved' && desktopSocial() && (
            <div className="stack">
              <h3>Post to</h3>
              <div className="row">
                {(Object.keys(TARGET_INFO) as SocialTarget[]).filter((t) => accountFor(data, t)).map((t) => {
                  const pub = data.publications.find((p) => p.videoId === v.id && p.target === t);
                  if (pub?.status === 'posted') return pub.url ? <a key={t} className="btn small ok" href={pub.url} target="_blank" rel="noreferrer noopener">{TARGET_INFO[t].label} ✓</a> : <span key={t} className="chip published">{TARGET_INFO[t].label} ✓</span>;
                  if (pub?.status === 'queued' || pub?.status === 'posting') return <span key={t} className="chip rendering">{TARGET_INFO[t].label}…</span>;
                  return <button key={t} className="btn small" title={pub?.error} onClick={() => postNow(v.id, t)}>{pub?.status === 'failed' ? 'Retry ' : ''}{TARGET_INFO[t].label}</button>;
                })}
                {!(Object.keys(TARGET_INFO) as SocialTarget[]).some((t) => accountFor(data, t)) && <small className="muted">Connect your accounts on the Auto-post page.</small>}
              </div>
            </div>
          )}
        </div>
        <div className="stack">
          {uploaded ? <div className="notice">This is your own recording. It is posted exactly as you uploaded it; the app wrote the caption below.</div> : <h3>Script</h3>}
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
              {!uploaded && <button className="btn primary" onClick={applyScript}>Re-create with changes</button>}
              <button className={'btn' + (uploaded ? ' primary' : '')} onClick={async () => { await patch('videos', v.id, { caption }); setDirty(false); toast('Caption saved'); }}>{uploaded ? 'Save caption' : 'Save caption only'}</button>
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
  const [uploading, setUploading] = useState(false);
  const [filter, setFilter] = useState('all');
  const videos = [...data.videos].sort((a, b) => b.createdAt - a.createdAt).filter((v) => filter === 'all' || v.status === filter);
  return (
    <>
      <div className="head">
        <div className="grow"><h1>Videos</h1><p>Upload your own recordings or let the app create videos from your product photos. Every video waits for your approval.</p></div>
        <button className="btn" data-testid="upload-video" disabled={!data.products.length} onClick={() => setUploading(true)}><Icon name="share" /> Upload my video</button>
        <button className="btn primary" disabled={!data.products.length} onClick={() => setCreating(true)}><Icon name="plus" /> Create video</button>
      </div>
      {!canRenderVideo() && <div className="notice bad" style={{ marginBottom: 12 }}>This browser has no built-in video encoder. Use the desktop or Android app, or a current Chrome, Edge or Safari.</div>}
      <div className="tabs">
        {['all', 'pending', 'approved', 'rejected', 'failed'].map((f) => (
          <button key={f} className={'tab' + (filter === f ? ' on' : '')} onClick={() => setFilter(f)}>{f === 'pending' ? 'Needs approval' : f[0].toUpperCase() + f.slice(1)}</button>
        ))}
      </div>
      {videos.length === 0 ? (
        <Empty title="No videos here yet">Add a product, then upload your own recording or let Autopilot create videos for it.</Empty>
      ) : (
        <div className="grid g3">{videos.map((v) => <VideoCard key={v.id} v={v} onOpen={() => setOpen(v.id)} />)}</div>
      )}
      {open && <VideoDetail id={open} onClose={() => setOpen(null)} />}
      {creating && <CreateVideo onClose={() => setCreating(false)} />}
      {uploading && <UploadVideo onClose={() => setUploading(false)} onDone={(id) => { setUploading(false); setOpen(id); }} />}
    </>
  );
}

function CreateVideo({ onClose }: { onClose: () => void }) {
  const { data } = useStore();
  const [productId, setProductId] = useState(data.products[0]?.id ?? '');
  const [format, setFormat] = useState<VideoFormat>('reel');
  const [style, setStyle] = useState<VideoStyle | ''>('');
  const [mood, setMood] = useState<MusicMood | ''>('');
  const [lang, setLang] = useState<Lang>('en');
  return (
    <Modal title="Create a video" onClose={onClose}
      footer={<button className="btn primary" onClick={async () => { await createVideo(productId, format, style || undefined, mood || undefined, lang); onClose(); toast('Video is being created'); }}>Create</button>}>
      <div className="form">
        <Field label="Product"><select value={productId} onChange={(e) => setProductId(e.target.value)}>{data.products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
        <Field label="Shape" hint={FORMAT_INFO[format].use}>
          <select value={format} onChange={(e) => setFormat(e.target.value as VideoFormat)}>
            {(Object.keys(FORMAT_INFO) as VideoFormat[]).map((f) => <option key={f} value={f}>{FORMAT_INFO[f].label} ({FORMAT_INFO[f].w}×{FORMAT_INFO[f].h})</option>)}
          </select>
        </Field>
        <Field label="Language" hint="Fixed phrases are translated; your product text is used as you typed it.">
          <select data-testid="v-lang" value={lang} onChange={(e) => setLang(e.target.value as Lang)}>{(Object.keys(LANG_NAMES) as Lang[]).map((l) => <option key={l} value={l}>{LANG_NAMES[l]}</option>)}</select>
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

function UploadVideo({ onClose, onDone }: { onClose: () => void; onDone: (videoId: string) => void }) {
  const { data } = useStore();
  const [productId, setProductId] = useState(data.products[0]?.id ?? '');
  const [file, setFile] = useState<File | null>(null);
  const [info, setInfo] = useState<VideoInfo | null>(null);
  const [format, setFormat] = useState<VideoFormat>('reel');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  async function choose(f?: File) {
    setError(''); setFile(null); setInfo(null);
    if (!f) return;
    if (!uploadMime(f)) return setError('Please choose an MP4 or MOV video. Other types are not accepted by all platforms.');
    if (f.size > MAX_UPLOAD_BYTES) return setError(`This video is ${fmtSize(f.size)}. The limit is ${fmtSize(MAX_UPLOAD_BYTES)} — export it at 1080p or trim it.`);
    if (f.size === 0) return setError('This file is empty.');
    setBusy('Reading the video…');
    const i = await inspectVideo(f);
    setBusy('');
    setFile(f); setInfo(i);
    if (i.readable) setFormat(shapeOf(i.width, i.height));
  }
  async function save() {
    if (!file || !info) return;
    setBusy('Securing the video… 0%');
    try {
      const id = await addUploadedVideo(
        { productId, bytes: await file.arrayBuffer(), mime: uploadMime(file)!, format, seconds: info.seconds, width: info.width, height: info.height, thumb: info.thumb },
        (p) => setBusy(`Securing the video… ${Math.round(p * 100)}%`),
      );
      if (id) { toast('Uploaded — caption written, waiting for your approval'); onDone(id); } else setError('Choose a product first.');
    } catch (e: any) {
      setError('Could not store this video: ' + String(e?.message ?? e));
    }
    setBusy('');
  }
  return (
    <Modal title="Upload my video" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" data-testid="upload-save" disabled={!file || !!busy} onClick={save}>{busy || 'Upload'}</button></>}>
      <div className="stack">
        <p className="muted">Record on your phone or camera, then upload here. The app stores it encrypted, writes the caption, title and hashtags, and — once you approve — posts it to your connected platforms.</p>
        <div className="form">
          <Field label="Which product is this video about?"><select value={productId} onChange={(e) => setProductId(e.target.value)}>{data.products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
          <Field label="Video file" hint={`MP4 or MOV, up to ${fmtSize(MAX_UPLOAD_BYTES)}`}>
            <input data-testid="upload-file" type="file" accept="video/mp4,video/quicktime,.mp4,.m4v,.mov" onChange={(e) => choose(e.target.files?.[0])} />
          </Field>
        </div>
        {error && <div className="notice bad" role="alert">{error}</div>}
        {file && info && (
          <>
            {info.readable
              ? <div className="notice ok" data-testid="upload-info">{file.name} · {info.width}×{info.height} · {Math.round(info.seconds)} seconds · {fmtSize(file.size)}</div>
              : <div className="notice warn">This PC cannot preview this recording (common with some phone formats), but it can still be uploaded and posted. Please choose its shape below.</div>}
            <Field label="Shape" hint={FORMAT_INFO[format].use}>
              <select value={format} onChange={(e) => setFormat(e.target.value as VideoFormat)}>
                {(Object.keys(FORMAT_INFO) as VideoFormat[]).map((f) => <option key={f} value={f}>{FORMAT_INFO[f].label}</option>)}
              </select>
            </Field>
            {info.seconds > 140 && <div className="notice warn">Longer than 2 minutes 20 seconds: X may refuse it, and Instagram and Facebook show reels best under 90 seconds.</div>}
            {format === 'reel' && info.seconds > 180 && <div className="notice warn">YouTube treats vertical videos over 3 minutes as normal videos, not Shorts.</div>}
          </>
        )}
      </div>
    </Modal>
  );
}
