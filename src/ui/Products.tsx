import { useState } from 'react';
import { deleteProduct, runAutopilot } from '../core/actions';
import { formatPrice } from '../core/copy';
import { importPhoto } from '../core/files';
import { delBlob, log, put, putBlob, useStore } from '../core/store';
import { uid, type Product } from '../core/types';
import { Empty, Field, Icon, Modal, Picture, toast, useBlobUrl } from './common';

const blank = (): Product => ({ id: uid(), name: '', category: '', description: '', price: '', offer: '', features: [], audience: '', keywords: [], imageIds: [], active: true, createdAt: Date.now() });

export function Products() {
  const { data, settings } = useStore();
  const [edit, setEdit] = useState<Product | null>(null);
  const products = [...data.products].sort((a, b) => b.createdAt - a.createdAt);
  return (
    <>
      <div className="head">
        <div className="grow"><h1>Products</h1><p>Add a product once — videos, posts and follow-ups are prepared from it.</p></div>
        <button className="btn primary" data-testid="add-product" onClick={() => setEdit(blank())}><Icon name="plus" /> Add product</button>
      </div>
      {products.length === 0 ? (
        <Empty title="No products yet">Add your first product with a few clear photos.</Empty>
      ) : (
        <div className="grid g3">
          {products.map((p) => (
            <div className="card stack" key={p.id}>
              <Picture id={p.imageIds[0]} alt={p.name} />
              <div className="row between"><b>{p.name}</b><span className={'chip ' + (p.active ? 'active' : '')}>{p.active ? 'active' : 'paused'}</span></div>
              <small>{[p.category, formatPrice(p, settings), `${p.imageIds.length} photo(s)`].filter(Boolean).join(' · ')}</small>
              <small>{data.videos.filter((v) => v.productId === p.id).length} video(s) · {data.leads.filter((l) => l.productId === p.id).length} lead(s)</small>
              <div><button className="btn small" onClick={() => setEdit(p)}>Edit</button></div>
            </div>
          ))}
        </div>
      )}
      {edit && <ProductForm initial={edit} isNew={!data.products.some((p) => p.id === edit.id)} onClose={() => setEdit(null)} />}
    </>
  );
}

function Photo({ id, onRemove }: { id: string; onRemove: () => void }) {
  const url = useBlobUrl(id, 'image/jpeg');
  return <div className="ph">{url && <img src={url} alt="" />}<button type="button" onClick={onRemove} aria-label="Remove photo">×</button></div>;
}

function ProductForm({ initial, isNew, onClose }: { initial: Product; isNew: boolean; onClose: () => void }) {
  const [p, setP] = useState(initial);
  const [features, setFeatures] = useState(initial.features.join('\n'));
  const [keywords, setKeywords] = useState(initial.keywords.join(', '));
  const [busy, setBusy] = useState(false);
  const [removed, setRemoved] = useState<string[]>([]);
  const set = (k: keyof Product, v: any) => setP((x) => ({ ...x, [k]: v }));

  async function addPhotos(files: FileList | null) {
    if (!files) return;
    setBusy(true);
    const ids: string[] = [];
    for (const f of Array.from(files).slice(0, 10)) {
      try { ids.push(await putBlob(await importPhoto(f))); } catch { toast(`Could not read ${f.name}`); }
    }
    setP((x) => ({ ...x, imageIds: [...x.imageIds, ...ids].slice(0, 12) }));
    setBusy(false);
  }
  async function save() {
    if (!p.name.trim()) return toast('Please enter the product name');
    const product: Product = {
      ...p, name: p.name.trim(),
      features: features.split('\n').map((s) => s.trim()).filter(Boolean),
      keywords: keywords.split(',').map((s) => s.trim()).filter(Boolean),
    };
    await put('products', product);
    for (const id of removed) await delBlob(id);
    if (isNew) await log('owner', `Added product ${product.name}.`);
    onClose();
    const made = await runAutopilot();
    if (made.videos) toast(`Creating ${made.videos} video(s) for ${product.name}`);
  }
  return (
    <Modal title={isNew ? 'Add product' : 'Edit product'} onClose={onClose}
      footer={
        <>
          {!isNew && <button className="btn danger" onClick={async () => { if (confirm(`Delete ${p.name} with its videos and posts?`)) { await deleteProduct(p.id); onClose(); } }}><Icon name="trash" /> Delete</button>}
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" data-testid="save-product" onClick={save} disabled={busy}>Save</button>
        </>
      }>
      <div className="form">
        <Field label="Product name"><input data-testid="p-name" value={p.name} onChange={(e) => set('name', e.target.value)} autoFocus /></Field>
        <Field label="Category"><input data-testid="p-category" value={p.category} onChange={(e) => set('category', e.target.value)} placeholder="e.g. skincare" /></Field>
        <Field label="Price"><input data-testid="p-price" value={p.price} onChange={(e) => set('price', e.target.value)} placeholder="e.g. 499" /></Field>
        <Field label="Offer"><input data-testid="p-offer" value={p.offer} onChange={(e) => set('offer', e.target.value)} placeholder="e.g. 20% off this week" /></Field>
        <Field label="Description" full><textarea data-testid="p-desc" value={p.description} onChange={(e) => set('description', e.target.value)} /></Field>
        <Field label="Key selling points" hint="One per line — each becomes a scene in the video." full><textarea data-testid="p-features" value={features} onChange={(e) => setFeatures(e.target.value)} /></Field>
        <Field label="Who is it for?"><input value={p.audience} onChange={(e) => set('audience', e.target.value)} placeholder="e.g. busy parents" /></Field>
        <Field label="Keywords" hint="Comma separated — used for hashtags."><input value={keywords} onChange={(e) => setKeywords(e.target.value)} /></Field>
        <div className="full stack">
          <b style={{ fontSize: '.86rem' }}>Photos</b>
          <div className="photos">
            {p.imageIds.map((id) => <Photo key={id} id={id} onRemove={() => { setRemoved((r) => [...r, id]); set('imageIds', p.imageIds.filter((x) => x !== id)); }} />)}
            <label className="btn" style={{ width: 86, height: 86 }}>
              <Icon name="plus" />
              <input data-testid="p-photos" type="file" accept="image/*" multiple hidden onChange={(e) => { void addPhotos(e.target.files); e.target.value = ''; }} />
            </label>
          </div>
          <small className="muted">{busy ? 'Adding photos…' : 'Use 3–6 sharp, well-lit photos. Real photos make the videos look real. Location data is removed automatically.'}</small>
        </div>
        <label className="check full"><input type="checkbox" checked={p.active} onChange={(e) => set('active', e.target.checked)} /> Active — let Autopilot create marketing for this product</label>
      </div>
    </Modal>
  );
}
