import { useEffect, useState } from 'react';
import { fitLength } from '../core/copy';
import { addUploadedVideo, createVideo, createVideoFromReference, decideVideo, deleteVideo, rerenderVideo } from '../core/actions';
import { analyzeReference, colorsFrom, describeReference, styleFor, targetFor } from '../video/reference';
import { inspectVideo, MAX_UPLOAD_BYTES, shapeOf, uploadMime, type VideoInfo } from '../video/upload';
import { canShareFiles, copyText, saveFile, shareFile } from '../core/files';
import { accountFor, desktopSocial, postNow } from '../core/publisher';
import { getBlob, patch, useStore } from '../core/store';
import { FORMAT_INFO, LANG_NAMES, PRESENTER_NAMES, TARGET_INFO, type Lang, type Presenter, type ScriptScene, type SocialTarget, type MusicMood, type ReferenceLook, type Video, type VideoFormat, type VideoStyle } from '../core/types';
import { canRenderVideo } from '../video/render';
import { Chip, Empty, Field, fmtDateTime, fmtSize, Icon, Modal, Picture, toast, useBlobUrl } from './common';

/** Re-creates a video; if that fails (for example storage is full) the owner is told instead of nothing happening. */
function remake(v: Video, fresh: boolean) {
  rerenderVideo(v, fresh).catch((e) => toast('Could not re-create the video: ' + String(e?.message ?? e)));
}

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
        {v.status === 'failed' && <button className="btn small" onClick={() => remake(v, false)}><Icon name="refresh" size={15} /> Retry</button>}
      </div>
    </div>
  );
}

const SCENE_NAMES: Record<ScriptScene['kind'], string> = { hook: 'Opening line', reveal: 'Product', feature: 'Selling point', offer: 'Price / offer', cta: 'Call to action' };
const optionsOf = (v?: Video) => ({ style: v?.style ?? 'bold', mood: v?.mood ?? 'upbeat', targetSeconds: v?.targetSeconds ?? Math.round(v?.script.reduce((a, s) => a + s.seconds, 0) ?? 20), presenter: v?.presenter ?? 'none', voice: v?.voice ?? false } as { style: VideoStyle; mood: MusicMood; targetSeconds: number; presenter: Presenter; voice: boolean });

export function VideoDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const { data } = useStore();
  const v = data.videos.find((x) => x.id === id);
  const url = useBlobUrl(v?.blobId, v?.mime ?? 'video/mp4');
  const poster = useBlobUrl(v?.thumbId, 'image/jpeg');
  const [script, setScript] = useState(v?.script ?? []);
  const [caption, setCaption] = useState(v?.caption ?? '');
  const [opts, setOpts] = useState(optionsOf(v));
  const [dirty, setDirty] = useState(false);
  // Keep the boxes in step with the video (after "New version" or a finished re-creation), unless the owner is mid-edit.
  const sig = v ? JSON.stringify([v.script, v.caption, optionsOf(v)]) : '';
  useEffect(() => {
    if (!v || dirty) return;
    setScript(v.script);
    setCaption(v.caption);
    setOpts(optionsOf(v));
  }, [sig]); // eslint-disable-line react-hooks/exhaustive-deps
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
    // A new length re-times the scenes; text edits are kept.
    const timed = opts.targetSeconds !== (v!.targetSeconds ?? 0) ? fitLength(script, opts.targetSeconds) : script;
    await rerenderVideo({ ...v!, ...opts, script: timed, caption }, false);
    setDirty(false);
    toast('Re-creating the video with your changes');
  }
  const edit = <T,>(fn: (x: T) => void) => (x: T) => { fn(x); setDirty(true); };
  const setScene = (i: number, key: 'text' | 'sub', value: string) => edit(setScript)(script.map((x, j) => (j === i ? { ...x, [key]: value } : x)));

  return (
    <Modal wide title={`${product?.name ?? 'Video'} — ${FORMAT_INFO[v.format].label}`} onClose={onClose}
      footer={
        <>
          <button className="btn danger" onClick={async () => { if (confirm('Delete this video?')) { await deleteVideo(v.id); onClose(); } }}><Icon name="trash" /> Delete</button>
          {done && !uploaded && <button className="btn" onClick={() => remake(v, true)}><Icon name="refresh" /> New version</button>}
          {v.status === 'pending' && <button className="btn danger" data-testid="reject-video" onClick={() => decideVideo(v.id, false)}>Reject</button>}
          {(v.status === 'pending' || v.status === 'rejected') && <button className="btn ok" data-testid="approve-video" disabled={dirty} title={dirty ? 'Re-create the video with your changes first' : undefined} onClick={() => decideVideo(v.id, true)}><Icon name="check" /> Approve</button>}
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
          {v.reference && <div className="notice" data-testid="reference-note">Made in the style of <b>{v.reference.name}</b>: {describeReference(v.reference)}{v.colors ? ', using its colours' : ''}.</div>}
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
          {uploaded ? <div className="notice">This is your own recording. It is posted exactly as you uploaded it; the app wrote the caption below.</div> : (
            <>
              <h3>Make changes, then press “Re-create video”</h3>
              <div className="form">
                <Field label="Look"><select data-testid="opt-style" value={opts.style} onChange={(e) => edit(setOpts)({ ...opts, style: e.target.value as VideoStyle })}><option value="real">Realistic (cinematic)</option><option value="bold">Bold</option><option value="clean">Clean</option><option value="luxe">Luxury</option></select></Field>
                <Field label="Music"><select value={opts.mood} onChange={(e) => edit(setOpts)({ ...opts, mood: e.target.value as MusicMood })}><option value="upbeat">Upbeat</option><option value="chill">Chill</option><option value="cinematic">Cinematic</option><option value="none">No music</option></select></Field>
                <Field label="Length"><select data-testid="opt-length" value={opts.targetSeconds} onChange={(e) => edit(setOpts)({ ...opts, targetSeconds: Number(e.target.value) })}>{[10, 15, 20, 25, 30].map((n) => <option key={n} value={n}>{n} seconds</option>)}</select></Field>
                <Field label="Presenter"><select data-testid="opt-presenter" value={opts.presenter} onChange={(e) => edit(setOpts)({ ...opts, presenter: e.target.value as Presenter })}>{(Object.keys(PRESENTER_NAMES) as Presenter[]).map((k) => <option key={k} value={k}>{PRESENTER_NAMES[k]}</option>)}</select></Field>
                <label className="check full"><input type="checkbox" checked={opts.voice} onChange={(e) => edit(setOpts)({ ...opts, voice: e.target.checked })} /> Voice-over (spoken by the computer's own voice; desktop app)</label>
              </div>
            </>
          )}
          {script.map((sc, i) => (
            <div className="stack" key={i} style={{ gap: 6 }}>
              <label className="field">
                <span>{SCENE_NAMES[sc.kind]} · {sc.seconds.toFixed(1)}s</span>
                <input data-testid="scene-text" value={sc.text} onChange={(e) => setScene(i, 'text', e.target.value)} />
              </label>
              {(sc.sub !== undefined || sc.kind !== 'feature') && <input aria-label={`${SCENE_NAMES[sc.kind]} second line`} placeholder="Second line (optional)" value={sc.sub ?? ''} onChange={(e) => setScene(i, 'sub', e.target.value)} />}
            </div>
          ))}
          {dirty && <div className="notice warn" data-testid="unsaved">You have changes that are not in the video yet. Press <b>Re-create video</b> to apply them{v.status === 'pending' ? ' before approving' : ''}.</div>}
          <Field label="Caption for the post">
            <textarea rows={5} value={caption} onChange={(e) => edit(setCaption)(e.target.value)} />
          </Field>
          <small>{v.hashtags.join(' ')}</small>
          {dirty && (
            <div className="row">
              {!uploaded && <button className="btn primary" data-testid="recreate" onClick={applyScript}>Re-create video</button>}
              <button className="btn" onClick={() => { setDirty(false); setScript(v.script); setCaption(v.caption); setOpts(optionsOf(v)); }}>Undo changes</button>
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
  const [referencing, setReferencing] = useState(false);
  const [filter, setFilter] = useState('all');
  const videos = [...data.videos].sort((a, b) => b.createdAt - a.createdAt).filter((v) => filter === 'all' || v.status === filter);
  return (
    <>
      <div className="head">
        <div className="grow"><h1>Videos</h1><p>Upload your own recordings or let the app create videos from your product photos. Every video waits for your approval.</p></div>
        <button className="btn" data-testid="upload-video" disabled={!data.products.length} onClick={() => setUploading(true)}><Icon name="share" /> Upload my video</button>
        <button className="btn" data-testid="reference-video" disabled={!data.products.length} onClick={() => setReferencing(true)}><Icon name="image" /> From a reference video</button>
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
      {referencing && <ReferenceVideo onClose={() => setReferencing(false)} onDone={(id) => { setReferencing(false); setOpen(id); }} />}
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
  const { settings } = useStore();
  const [seconds, setSeconds] = useState(settings.autopilot.videoSeconds);
  const [presenter, setPresenter] = useState<Presenter>(settings.autopilot.presenter);
  const [voice, setVoice] = useState(settings.autopilot.voice);
  return (
    <Modal title="Create a video" onClose={onClose}
      footer={<button className="btn primary" onClick={async () => { await createVideo(productId, format, style || undefined, mood || undefined, lang, { seconds, presenter, voice }); onClose(); toast('Video is being created'); }}>Create</button>}>
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
        <Field label="Length"><select data-testid="v-length" value={seconds} onChange={(e) => setSeconds(Number(e.target.value))}>{[10, 15, 20, 25, 30].map((n) => <option key={n} value={n}>{n} seconds</option>)}</select></Field>
        <Field label="Presenter"><select data-testid="v-presenter" value={presenter} onChange={(e) => setPresenter(e.target.value as Presenter)}>{(Object.keys(PRESENTER_NAMES) as Presenter[]).map((k) => <option key={k} value={k}>{PRESENTER_NAMES[k]}</option>)}</select></Field>
        <label className="check full"><input type="checkbox" checked={voice} onChange={(e) => setVoice(e.target.checked)} /> Voice-over (desktop app, uses this computer's own voices)</label>
        <Field label="Look">
          <select value={style} onChange={(e) => setStyle(e.target.value as VideoStyle)}>
            <option value="">Automatic</option><option value="real">Realistic (cinematic)</option><option value="bold">Bold</option><option value="clean">Clean</option><option value="luxe">Luxury</option>
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

const STYLE_NAMES: Record<VideoStyle, string> = { real: 'Realistic (cinematic)', bold: 'Bold', clean: 'Clean', luxe: 'Luxury' };
const MOOD_NAMES: Record<MusicMood, string> = { upbeat: 'Upbeat', chill: 'Chill', cinematic: 'Cinematic', none: 'No music' };

/** Upload a video whose style you like; the app makes a new video for your product in that style. */
function ReferenceVideo({ onClose, onDone }: { onClose: () => void; onDone: (videoId: string) => void }) {
  const { data, settings } = useStore();
  const [productId, setProductId] = useState(data.products[0]?.id ?? '');
  const [ref, setRef] = useState<ReferenceLook | null>(null);
  const [format, setFormat] = useState<VideoFormat>('reel');
  const [useColors, setUseColors] = useState(true);
  const [style, setStyle] = useState<VideoStyle | ''>('');
  const [mood, setMood] = useState<MusicMood | ''>('');
  const [lang, setLang] = useState<Lang>('en');
  const [presenter, setPresenter] = useState<Presenter>(settings.autopilot.presenter);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  async function choose(f?: File) {
    setError(''); setRef(null);
    if (!f) return;
    if (!f.type.startsWith('video/') && !uploadMime(f)) return setError('Please choose a video file (MP4, MOV or WebM).');
    if (f.size > MAX_UPLOAD_BYTES) return setError(`This video is ${fmtSize(f.size)}. The limit is ${fmtSize(MAX_UPLOAD_BYTES)}.`);
    setBusy('Studying the video… 0%');
    const look = await analyzeReference(f, (p) => setBusy(`Studying the video… ${Math.round(p * 100)}%`));
    setBusy('');
    if (!look) return setError('This device cannot read this video (common with some phone recordings). Export it as an MP4 (H.264) and try again.');
    setRef(look);
    setFormat(look.format);
  }
  async function create() {
    if (!ref) return;
    setBusy('Creating…');
    let id: string | null = null;
    try {
      id = await createVideoFromReference(productId, ref, { format, useColors, style: style || undefined, mood: mood || undefined, lang, presenter });
    } catch (e: any) {
      setBusy('');
      return setError('Could not save the new video: ' + String(e?.message ?? e));
    }
    setBusy('');
    if (!id) return setError('Choose a product first.');
    toast('Video is being created in the reference style — it will wait for your approval');
    onDone(id);
  }
  const auto = ref ? styleFor(ref) : null;
  const colors = ref ? colorsFrom(ref.palette) : null;
  return (
    <Modal title="Create from a reference video" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" data-testid="reference-create" disabled={!ref || !!busy || !productId} onClick={create}>{busy || 'Create video'}</button></>}>
      <div className="stack">
        <p className="muted">Upload a video whose style you like — an ad, a reel or one of your own. The app studies it on this device (length, cut rhythm, colours, brightness and energy) and creates a new video for your product with your photos and text in the same style. Nothing from the reference video is stored or shown in the new one.</p>
        <div className="form">
          <Field label="Product for the new video"><select value={productId} onChange={(e) => setProductId(e.target.value)}>{data.products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
          <Field label="Reference video" hint={`MP4, MOV or WebM, up to ${fmtSize(MAX_UPLOAD_BYTES)}`}>
            <input data-testid="reference-file" type="file" accept="video/*,.mp4,.m4v,.mov,.webm" onChange={(e) => choose(e.target.files?.[0])} />
          </Field>
        </div>
        {busy && !ref && <div className="notice" role="status">{busy}</div>}
        {error && <div className="notice bad" role="alert">{error}</div>}
        {ref && auto && (
          <>
            <div className="notice ok" data-testid="reference-info">
              <b>{ref.name}</b>: {describeReference(ref)}. The new video will be {targetFor(ref)} seconds with the same cut rhythm.
              <div className="row" style={{ gap: 6, marginTop: 8 }} aria-label="Colours found in the reference">
                {ref.palette.map((c) => <span key={c} title={c} style={{ width: 22, height: 22, borderRadius: 6, background: c, border: '1px solid var(--line, #ccc)' }} />)}
              </div>
            </div>
            <div className="form">
              <Field label="Shape" hint={FORMAT_INFO[format].use}>
                <select value={format} onChange={(e) => setFormat(e.target.value as VideoFormat)}>
                  {(Object.keys(FORMAT_INFO) as VideoFormat[]).map((f) => <option key={f} value={f}>{FORMAT_INFO[f].label}{f === ref.format ? ' (same as reference)' : ''}</option>)}
                </select>
              </Field>
              <Field label="Look"><select value={style} onChange={(e) => setStyle(e.target.value as VideoStyle)}><option value="">Match reference ({STYLE_NAMES[auto.style]})</option>{(Object.keys(STYLE_NAMES) as VideoStyle[]).map((k) => <option key={k} value={k}>{STYLE_NAMES[k]}</option>)}</select></Field>
              <Field label="Music"><select value={mood} onChange={(e) => setMood(e.target.value as MusicMood)}><option value="">Match reference ({MOOD_NAMES[auto.mood]})</option>{(Object.keys(MOOD_NAMES) as MusicMood[]).map((k) => <option key={k} value={k}>{MOOD_NAMES[k]}</option>)}</select></Field>
              <Field label="Language"><select value={lang} onChange={(e) => setLang(e.target.value as Lang)}>{(Object.keys(LANG_NAMES) as Lang[]).map((l) => <option key={l} value={l}>{LANG_NAMES[l]}</option>)}</select></Field>
              <Field label="Presenter"><select value={presenter} onChange={(e) => setPresenter(e.target.value as Presenter)}>{(Object.keys(PRESENTER_NAMES) as Presenter[]).map((k) => <option key={k} value={k}>{PRESENTER_NAMES[k]}</option>)}</select></Field>
              <label className="check full"><input type="checkbox" data-testid="reference-colors" checked={useColors && !!colors} disabled={!colors} onChange={(e) => setUseColors(e.target.checked)} /> {colors ? 'Use the reference video’s colours instead of my brand colours' : 'The reference is too grey to take colours from — your brand colours will be used'}</label>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
