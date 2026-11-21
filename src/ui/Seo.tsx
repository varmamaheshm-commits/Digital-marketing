import { useEffect, useMemo, useState } from 'react';
import { copyText, saveFile } from '../core/files';
import { buildSeo, scoreSeo, slugify, type SeoPack } from '../core/seo';
import { saveSettings, useStore } from '../core/store';
import { Empty, Field, Icon, toast } from './common';

function Copy({ text, label = 'Copy' }: { text: string; label?: string }) {
  return <button className="btn small" onClick={async () => toast((await copyText(text)) ? 'Copied' : 'Copy failed')}><Icon name="copy" /> {label}</button>;
}

export function Seo() {
  const { data, settings } = useStore();
  const [pid, setPid] = useState(data.products[0]?.id ?? '');
  const product = data.products.find((p) => p.id === pid) ?? data.products[0];
  // Rebuild only when the product or the details used in the texts change, so the owner's edits are kept.
  const b = settings.business;
  const auto = useMemo(() => (product ? buildSeo(product, settings) : null), [product, b.name, b.city, b.phone, b.website, settings.seo.siteUrl, settings.seo.city, settings.currency]);
  const [pack, setPack] = useState<SeoPack | null>(auto);
  useEffect(() => setPack(auto), [auto]);
  const [site, setSite] = useState(settings.seo.siteUrl || settings.business.website);
  const [city, setCity] = useState(settings.seo.city || settings.business.city);

  if (!product || !pack) return (<><div className="head"><div className="grow"><h1>SEO</h1></div></div><Empty title="No products yet">Add a product to get search-friendly titles, descriptions and articles.</Empty></>);
  const set = (k: Partial<SeoPack>) => setPack({ ...pack, ...k });
  const score = scoreSeo(pack);
  const color = score.score >= 80 ? 'var(--ok)' : score.score >= 50 ? 'var(--warn)' : 'var(--bad)';
  const html = `<title>${pack.title}</title>\n<meta name="description" content="${pack.description.replace(/"/g, '&quot;')}">\n<meta name="keywords" content="${pack.keywords.join(', ')}">\n${pack.jsonLd}`;

  return (
    <>
      <div className="head">
        <div className="grow"><h1>SEO</h1><p>Get found on Google and YouTube: titles, descriptions, keywords, product markup and a ready blog article for each product.</p></div>
        <select value={product.id} onChange={(e) => setPid(e.target.value)} aria-label="Product" data-testid="seo-product">
          {data.products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>
      <div className="grid g2">
        <div className="card stack">
          <div className="row between"><h2>Search result</h2><b style={{ color, fontSize: '1.6rem' }} data-testid="seo-score">{score.score}/100</b></div>
          <div className="card" style={{ background: 'var(--bg)' }}>
            <small>{(site || 'yourwebsite.com').replace(/^https?:\/\//, '')} › {pack.slug}</small>
            <div style={{ color: '#8ab4f8', fontSize: '1.1rem', margin: '4px 0' }}>{pack.title}</div>
            <small>{pack.description}</small>
          </div>
          <div className="form">
            <Field label="Focus keyword" full><input value={pack.keyword} onChange={(e) => set({ keyword: e.target.value })} data-testid="seo-keyword" /></Field>
            <Field label={`Page title (${pack.title.length}/60)`} full><input value={pack.title} onChange={(e) => set({ title: e.target.value })} data-testid="seo-title" /></Field>
            <Field label={`Meta description (${pack.description.length}/160)`} full><textarea rows={3} value={pack.description} onChange={(e) => set({ description: e.target.value })} /></Field>
            <Field label="Page address" full><input value={pack.slug} onChange={(e) => set({ slug: slugify(e.target.value) })} /></Field>
          </div>
          <div className="stack">
            {score.checks.map((c) => (
              <div key={c.label} className="row" title={c.tip}><span style={{ color: c.ok ? 'var(--ok)' : 'var(--bad)' }}>{c.ok ? '✔' : '✘'}</span><span>{c.label}</span>{!c.ok && <small> – {c.tip}</small>}</div>
            ))}
          </div>
          <div className="row"><Copy text={html} label="Copy page tags" /><button className="btn small" onClick={() => setPack(auto)}><Icon name="refresh" /> Reset</button></div>
        </div>
        <div className="card stack">
          <h2>Keywords to target</h2>
          <div className="row">{pack.keywords.map((k) => <span className="chip" key={k}>{k}</span>)}</div>
          <Copy text={pack.keywords.join(', ')} />
          <h2>YouTube</h2>
          <Field label="Video title"><input value={pack.youtubeTitle} onChange={(e) => set({ youtubeTitle: e.target.value })} /></Field>
          <small>Tags: {pack.youtubeTags.join(', ')}</small>
          <div className="row"><Copy text={pack.youtubeTitle} label="Copy title" /><Copy text={pack.youtubeTags.join(', ')} label="Copy tags" /></div>
          <h2>Photo description (alt text)</h2>
          <Field label="Alt text"><input value={pack.imageAlt} onChange={(e) => set({ imageAlt: e.target.value })} /></Field>
          <h2>Google product markup</h2>
          <small>Paste into your product page so Google can show price and stock.</small>
          <pre className="pre" style={{ maxHeight: 180, overflow: 'auto' }}>{pack.jsonLd}</pre>
          <Copy text={pack.jsonLd} />
        </div>
        <div className="card stack" style={{ gridColumn: '1 / -1' }}>
          <div className="row between"><h2>Blog article</h2><small>{pack.article.split(/\s+/).length} words</small></div>
          <textarea rows={14} value={pack.article} onChange={(e) => set({ article: e.target.value })} aria-label="Blog article" />
          <div className="row">
            <Copy text={pack.article} />
            <button className="btn small" onClick={() => saveFile(new Blob([pack.article], { type: 'text/markdown' }), `${pack.slug || 'article'}.md`)}><Icon name="download" /> Download</button>
          </div>
        </div>
        <div className="card stack" style={{ gridColumn: '1 / -1' }}>
          <h2>Website details</h2>
          <div className="form">
            <Field label="Website address" hint="Used for the search preview, tracked links and product markup."><input value={site} placeholder="https://www.example.com" onChange={(e) => setSite(e.target.value)} /></Field>
            <Field label="City or area you serve" hint="Adds local searches like “hair oil in Hyderabad”."><input value={city} onChange={(e) => setCity(e.target.value)} /></Field>
          </div>
          <div><button className="btn" onClick={async () => { await saveSettings({ ...settings, seo: { siteUrl: site.trim(), city: city.trim() } }); toast('Saved'); }}>Save</button></div>
        </div>
      </div>
    </>
  );
}
