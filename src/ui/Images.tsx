import { useState } from 'react';
import { decideCreative, deleteCreative } from '../core/actions';
import { canShareFiles, copyText, saveFile, shareFile } from '../core/files';
import { getBlob, patch, put, useStore } from '../core/store';
import { POSTER_INFO, type Creative, type PosterFormat, type PosterTemplate } from '../core/types';
import { newCreative, pumpPosters } from '../video/poster';
import { Chip, Empty, Field, Icon, Modal, toast, useBlobUrl } from './common';

const TEMPLATES: { id: PosterTemplate; label: string }[] = [
  { id: 'spotlight', label: 'Spotlight: full photo, text at the bottom' },
  { id: 'split', label: 'Split: photo and brand panel' },
  { id: 'offer', label: 'Offer: big offer text, round photo' },
];

function Preview({ c }: { c: Creative }) {
  const url = useBlobUrl(c.blobId, 'image/png');
  const { w, h } = POSTER_INFO[c.format];
  return (
    <div className="thumb contain" style={{ aspectRatio: `${w} / ${h}`, maxHeight: 360 }}>
      {url ? <img src={url} alt={c.headline} /> : <small>{c.status === 'failed' ? c.error ?? 'Failed' : 'Drawing…'}</small>}
    </div>
  );
}

export function Images() {
  const { data, settings } = useStore();
  const [make, setMake] = useState<Creative | null>(null);
  const [edit, setEdit] = useState<Creative | null>(null);
  const [filter, setFilter] = useState('');
  const list = [...data.images].filter((c) => !filter || c.productId === filter).sort((a, b) => b.createdAt - a.createdAt);
  const products = data.products;
  const productName = (id: string) => products.find((p) => p.id === id)?.name ?? 'Deleted product';

  function start() {
    const p = products.find((x) => x.imageIds.length) ?? products[0];
    if (!p) return toast('Add a product first.');
    setMake(newCreative(p, settings, 'square'));
  }
  async function file(c: Creative) {
    const b = c.blobId ? await getBlob(c.blobId) : null;
    if (!b) { toast('The image is not ready yet.'); return null; }
    return new Blob([b], { type: 'image/png' });
  }
  const fname = (c: Creative) => `${productName(c.productId)}-${c.format}.png`;
  const caption = (c: Creative) => [c.caption, c.hashtags.join(' ')].filter(Boolean).join('\n\n');

  return (
    <>
      <div className="head">
        <div className="grow"><h1>Images</h1><p>Posters for feeds, stories, WhatsApp and ads, drawn from your product photos and brand colours. Autopilot makes fresh ones regularly.</p></div>
        <select value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter by product">
          <option value="">All products</option>
          {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <button className="btn primary" onClick={start}><Icon name="plus" /> Create image</button>
      </div>
      {list.length === 0 ? <Empty title="No images yet">Add a product with photos; Autopilot will draw images, or press Create image.</Empty> : (
        <div className="grid g3">
          {list.map((c) => (
            <div className="card stack" key={c.id} data-testid="image-card">
              <div className="row between"><b>{productName(c.productId)}</b><Chip status={c.status} /></div>
              <small>{POSTER_INFO[c.format].label} · {c.template}</small>
              <Preview c={c} />
              <div className="row wrap">
                {c.status === 'pending' && <>
                  <button className="btn small primary" onClick={() => decideCreative(c.id, true)}>Approve</button>
                  <button className="btn small" onClick={() => decideCreative(c.id, false)}>Reject</button>
                </>}
                <button className="btn small" disabled={!c.blobId} onClick={async () => { const b = await file(c); if (b) await saveFile(b, fname(c)); }}><Icon name="download" /> Download</button>
                {canShareFiles() && <button className="btn small" disabled={!c.blobId} onClick={async () => { const b = await file(c); if (b) await shareFile(b, fname(c), caption(c)).catch(() => toast('Sharing failed.')); }}><Icon name="share" /> Share</button>}
                <button className="btn small" onClick={async () => toast((await copyText(caption(c))) ? 'Caption copied' : 'Copy failed')}><Icon name="copy" /> Caption</button>
                <button className="btn small" onClick={() => setEdit(c)}>Edit</button>
                <button className="btn small" aria-label="Delete image" onClick={() => deleteCreative(c.id)}><Icon name="trash" /></button>
              </div>
            </div>
          ))}
        </div>
      )}
      {make && <ImageForm initial={make} isNew onClose={() => setMake(null)} />}
      {edit && <ImageForm initial={edit} onClose={() => setEdit(null)} />}
    </>
  );
}

function ImageForm({ initial, isNew, onClose }: { initial: Creative; isNew?: boolean; onClose: () => void }) {
  const { data, settings } = useStore();
  const [c, setC] = useState(initial);
  const set = (k: Partial<Creative>) => setC({ ...c, ...k });
  async function save() {
    if (!c.headline.trim()) return toast('Add a headline.');
    if (isNew) await put('images', { ...c, status: 'queued', createdAt: Date.now() });
    else await patch('images', c.id, { ...c, status: 'queued', error: undefined });
    void pumpPosters();
    toast(isNew ? 'Drawing the image…' : 'Redrawing the image…');
    onClose();
  }
  return (
    <Modal title={isNew ? 'Create image' : 'Edit image'} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save} data-testid="save-image">{isNew ? 'Create' : 'Redraw'}</button></>}>
      <div className="form">
        <Field label="Product">
          <select value={c.productId} onChange={(e) => { const p = data.products.find((x) => x.id === e.target.value); if (p) setC({ ...newCreative(p, settings, c.format, c.template), id: c.id }); }} data-testid="img-product">
            {data.products.map((p) => <option key={p.id} value={p.id}>{p.name}{p.imageIds.length ? '' : ' (no photos)'}</option>)}
          </select>
        </Field>
        <Field label="Shape">
          <select value={c.format} onChange={(e) => set({ format: e.target.value as PosterFormat })} data-testid="img-format">
            {(Object.keys(POSTER_INFO) as PosterFormat[]).map((f) => <option key={f} value={f}>{POSTER_INFO[f].label} – {POSTER_INFO[f].use}</option>)}
          </select>
        </Field>
        <Field label="Layout">
          <select value={c.template} onChange={(e) => set({ template: e.target.value as PosterTemplate })}>
            {TEMPLATES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
        </Field>
        <Field label="Headline"><input value={c.headline} maxLength={80} onChange={(e) => set({ headline: e.target.value })} data-testid="img-headline" /></Field>
        <Field label="Second line"><input value={c.sub} maxLength={120} onChange={(e) => set({ sub: e.target.value })} /></Field>
        <Field label="Badge (offer or price)"><input value={c.badge} maxLength={40} onChange={(e) => set({ badge: e.target.value })} /></Field>
        <Field label="Call to action" full><input value={c.cta} maxLength={70} onChange={(e) => set({ cta: e.target.value })} /></Field>
        <Field label="Caption for the post" full><textarea value={c.caption} rows={4} onChange={(e) => set({ caption: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}
