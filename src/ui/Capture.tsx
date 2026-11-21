import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { copyText, saveFile } from '../core/files';
import { buildLandingPage, trackedLink, validFormUrl, whatsappLink } from '../core/landing';
import { slugify } from '../core/seo';
import { getBlob, saveSettings, useStore } from '../core/store';
import { Empty, Field, Icon, toast } from './common';

/** The product's first photo, shrunk to a JPEG that can sit inside the page file. */
async function photoDataUrl(id?: string): Promise<string> {
  const bytes = id ? await getBlob(id) : null;
  if (!bytes) return '';
  const bmp = await createImageBitmap(new Blob([bytes]));
  const k = Math.min(1, 1000 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  return c.toDataURL('image/jpeg', 0.82);
}

function Qr({ text, name }: { text: string; name: string }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    let alive = true;
    if (!text) { setUrl(''); return; }
    QRCode.toDataURL(text, { width: 600, margin: 2, errorCorrectionLevel: 'M' }).then((u) => alive && setUrl(u)).catch(() => setUrl(''));
    return () => { alive = false; };
  }, [text]);
  if (!url) return null;
  return (
    <div className="stack" style={{ alignItems: 'flex-start' }}>
      <img src={url} alt={`QR code for ${name}`} style={{ width: 180, height: 180, background: '#fff', borderRadius: 10 }} data-testid="qr" />
      <button className="btn small" onClick={async () => saveFile(await (await fetch(url)).blob(), `${name}-qr.png`)}><Icon name="download" /> QR code</button>
    </div>
  );
}

export function Capture() {
  const { data, settings } = useStore();
  const [pid, setPid] = useState(data.products[0]?.id ?? '');
  const product = data.products.find((p) => p.id === pid) ?? data.products[0];
  const [formUrl, setFormUrl] = useState(settings.capture.formUrl);
  const [wa, setWa] = useState(settings.capture.whatsapp || settings.business.phone);
  const [source, setSource] = useState('instagram');
  const [medium, setMedium] = useState('social');
  const [campaign, setCampaign] = useState(product ? slugify(product.name) : '');
  const [busy, setBusy] = useState(false);
  const site = (settings.seo.siteUrl || settings.business.website).replace(/\/+$/, '');
  const [base, setBase] = useState(site && product ? `${site}/${slugify(product.name)}` : site);
  useEffect(() => { if (product) { setCampaign(slugify(product.name)); if (site) setBase(`${site}/${slugify(product.name)}`); } }, [product?.id]);

  if (!product) return (<><div className="head"><div className="grow"><h1>Lead capture</h1></div></div><Empty title="No products yet">Add a product to build an offer page with an enquiry form.</Empty></>);
  const link = base ? trackedLink(base, { source, medium, campaign }) : '';
  const waText = `Hi ${settings.business.name || ''}, I am interested in ${product.name}.`.replace(/\s+/g, ' ');
  const waUrl = wa.replace(/\D/g, '').length >= 10 ? whatsappLink(wa, waText) : '';
  const formOk = !formUrl.trim() || validFormUrl(formUrl.trim());

  async function saveCapture() {
    if (!formOk) return toast('The form address must start with https://');
    await saveSettings({ ...settings, capture: { formUrl: formUrl.trim(), whatsapp: wa.trim() } });
    toast('Saved');
  }
  async function download() {
    if (!formOk) return toast('The form address must start with https://');
    setBusy(true);
    try {
      const s = { ...settings, capture: { formUrl: formUrl.trim(), whatsapp: wa.trim() } };
      const html = buildLandingPage(product!, s, { photo: await photoDataUrl(product!.imageIds[0]), source: `${source} page` });
      await saveFile(new Blob([html], { type: 'text/html' }), `${slugify(product!.name) || 'offer'}.html`);
      toast('Offer page saved');
    } finally { setBusy(false); }
  }

  return (
    <>
      <div className="head">
        <div className="grow"><h1>Lead capture</h1><p>Turn viewers into enquiries: an offer page with a form that collects name, phone and email with consent, tracked links and QR codes for posts, posters and shop counters.</p></div>
        <select value={product.id} onChange={(e) => setPid(e.target.value)} aria-label="Product" data-testid="capture-product">
          {data.products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>
      <div className="grid g2">
        <div className="card stack">
          <h2>1. Offer page with enquiry form</h2>
          <p className="muted">A single web page for {product.name}. Put it on your website, GitHub Pages or any host, and link it from your posts and bio.</p>
          <div className="form">
            <Field label="Form sends enquiries to" hint="Your n8n webhook (import n8n/lead-from-form.json). New enquiries appear in Leads automatically. Leave empty to send them to WhatsApp instead." full>
              <input value={formUrl} placeholder="https://your-n8n.example.com/webhook/new-lead" onChange={(e) => setFormUrl(e.target.value)} data-testid="form-url" />
            </Field>
            <Field label="WhatsApp number" hint="Shown as a Chat on WhatsApp button." full><input value={wa} inputMode="tel" onChange={(e) => setWa(e.target.value)} /></Field>
          </div>
          {!formOk && <div className="notice bad">The form address must start with https://</div>}
          <div className="row">
            <button className="btn primary" disabled={busy} onClick={download} data-testid="download-page"><Icon name="download" /> {busy ? 'Building…' : 'Download offer page'}</button>
            <button className="btn" onClick={saveCapture}>Save</button>
          </div>
        </div>
        <div className="card stack">
          <h2>2. WhatsApp chat link</h2>
          <p className="muted">One tap opens WhatsApp with “{waText}” ready to send. Use it in bios, ads and on posters.</p>
          {waUrl ? <>
            <code style={{ wordBreak: 'break-all' }}>{waUrl}</code>
            <div className="row"><button className="btn small" onClick={async () => toast((await copyText(waUrl)) ? 'Copied' : 'Copy failed')}><Icon name="copy" /> Copy link</button></div>
            <Qr text={waUrl} name={`${slugify(product.name)}-whatsapp`} />
          </> : <div className="notice">Add a WhatsApp number on the left.</div>}
        </div>
        <div className="card stack" style={{ gridColumn: '1 / -1' }}>
          <h2>3. Tracked link and QR code</h2>
          <p className="muted">Tags each link with where it was shared, so Google Analytics (or any web statistics) shows which post, poster or channel brings visitors.</p>
          <div className="form">
            <Field label="Page address" full><input value={base} placeholder="https://www.example.com/product" onChange={(e) => setBase(e.target.value)} data-testid="link-base" /></Field>
            <Field label="Where it is shared"><select value={source} onChange={(e) => setSource(e.target.value)}>{['instagram', 'facebook', 'youtube', 'whatsapp', 'linkedin', 'x', 'google', 'email', 'poster', 'shop'].map((s) => <option key={s}>{s}</option>)}</select></Field>
            <Field label="Type"><select value={medium} onChange={(e) => setMedium(e.target.value)}>{['social', 'paid', 'email', 'print', 'qr', 'referral'].map((s) => <option key={s}>{s}</option>)}</select></Field>
            <Field label="Campaign name" full><input value={campaign} onChange={(e) => setCampaign(e.target.value)} /></Field>
          </div>
          {link ? <>
            <code style={{ wordBreak: 'break-all' }} data-testid="tracked-link">{link}</code>
            <div className="row"><button className="btn small" onClick={async () => toast((await copyText(link)) ? 'Copied' : 'Copy failed')}><Icon name="copy" /> Copy link</button></div>
            <Qr text={link} name={`${slugify(product.name)}-${source}`} />
          </> : <div className="notice">Enter your page address (add your website in SEO or Settings to fill it in).</div>}
        </div>
      </div>
    </>
  );
}
