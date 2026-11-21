/**
 * SEO helper: writes search-friendly texts for a product (page title, meta description,
 * address slug, keywords, Google product markup, a blog article, YouTube title and tags)
 * and scores any title / description against the usual search-engine guidelines.
 * Everything is worked out on this device; nothing is sent anywhere.
 */
import { buildHashtags, formatPrice, productFeatures } from './copy';
import type { Product, Settings } from './types';

export interface SeoPack {
  keyword: string;
  title: string;
  description: string;
  slug: string;
  keywords: string[];
  h1: string;
  jsonLd: string;
  article: string;
  youtubeTitle: string;
  youtubeTags: string[];
  imageAlt: string;
}

export interface SeoCheck { ok: boolean; label: string; tip: string }
export interface SeoScore { score: number; checks: SeoCheck[] }

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();
/** Shortens at a word boundary without cutting a word in half. */
export function clip(s: string, max: number): string {
  s = clean(s);
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const at = cut.lastIndexOf(' ');
  return (at > max * 0.4 ? cut.slice(0, at) : cut).replace(/[\s,.;:–-]+$/, '') + '…';
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70)
    .replace(/-+$/, '');
}

const unique = (list: string[]) => {
  const seen = new Set<string>();
  return list.map(clean).filter((k) => k && !seen.has(k.toLowerCase()) && seen.add(k.toLowerCase()));
};

export function keywordIdeas(p: Product, s: Settings): string[] {
  const name = clean(p.name).toLowerCase();
  const cat = clean(p.category).toLowerCase();
  const city = clean(s.seo.city || s.business.city).toLowerCase();
  const own = p.keywords.map((k) => k.toLowerCase());
  const ideas = [
    ...own,
    name,
    cat && `${cat}`,
    cat && `best ${cat}`,
    `buy ${name}`,
    `${name} price`,
    cat && `${cat} online`,
    city && cat && `${cat} in ${city}`,
    city && `${name} ${city}`,
    p.audience && cat && `${cat} for ${clean(p.audience).toLowerCase()}`,
    s.business.name && `${s.business.name.toLowerCase()} ${name}`,
  ];
  return unique(ideas.filter(Boolean) as string[]).slice(0, 12);
}

export function buildSeo(p: Product, s: Settings): SeoPack {
  const brand = clean(s.business.name);
  const city = clean(s.seo.city || s.business.city);
  const keywords = keywordIdeas(p, s);
  const keyword = keywords[0] || clean(p.name).toLowerCase();
  const price = p.price ? formatPrice(p, s) : '';
  const features = productFeatures(p);
  const site = clean(s.seo.siteUrl || s.business.website).replace(/\/+$/, '');
  const slug = slugify(p.name);

  const titleCore = p.category && !p.name.toLowerCase().includes(p.category.toLowerCase()) ? `${p.name} – ${p.category}` : p.name;
  const title = clip(brand && titleCore.length + brand.length + 3 <= 60 ? `${titleCore} | ${brand}` : titleCore, 60);
  const lead = clip(p.description || features.slice(0, 2).join(', '), 90);
  const desc = [lead, price && `From ${price}.`, p.offer && clip(p.offer, 40), city ? `Order in ${city} today.` : 'Order today.'].filter(Boolean).join(' ');
  const description = clip(desc, 155);

  const schema: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: p.name,
    description: clean(p.description || features.join('. ')),
    ...(p.category ? { category: p.category } : {}),
    ...(brand ? { brand: { '@type': 'Brand', name: brand } } : {}),
    ...(site ? { url: `${site}/${slug}` } : {}),
  };
  const amount = Number(String(p.price).replace(/[^0-9.]/g, ''));
  if (amount > 0) {
    schema.offers = {
      '@type': 'Offer',
      price: amount.toFixed(2),
      priceCurrency: s.currency === '₹' ? 'INR' : s.currency === '$' ? 'USD' : s.currency === '€' ? 'EUR' : s.currency === '£' ? 'GBP' : 'INR',
      availability: p.active ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
    };
  }
  const jsonLd = `<script type="application/ld+json">\n${JSON.stringify(schema, null, 2)}\n</script>`;

  const h1 = p.name;
  const lines = [
    `# ${p.name}${city ? ` in ${city}` : ''}: what to know before you buy`,
    '',
    `Looking for ${keyword}? ${clean(p.description || `${p.name} is one of our most asked-about products.`)}`,
    '',
    `## Why people choose ${p.name}`,
    ...features.map((f) => `- ${f}`),
    '',
    p.audience ? `## Who it is for\n${p.name} is made for ${clean(p.audience)}.\n` : '',
    price || p.offer ? `## Price and offers\n${[price && `${p.name} is available from ${price}.`, p.offer].filter(Boolean).join(' ')}\n` : '',
    `## Frequently asked questions`,
    `**Where can I buy ${p.name}?** ${brand ? `Directly from ${brand}` : 'Directly from us'}${site ? ` at ${site}` : ''}${s.business.phone ? ` or call ${s.business.phone}` : ''}.`,
    '',
    `**Is ${p.name} worth it?** ${features[0] ? `Customers like it most for: ${features[0].toLowerCase()}.` : 'Ask us for a demo and decide for yourself.'}`,
    '',
    `## Get yours`,
    `${p.offer ? clean(p.offer) + ' ' : ''}Message us today${s.business.phone ? ` on ${s.business.phone}` : ''} and we will help you choose.`,
  ];
  const article = lines.filter((l) => l !== '').join('\n\n').replace(/\n\n- /g, '\n- ');

  const youtubeTitle = clip(`${p.name}${p.offer ? ' – ' + p.offer : features[0] ? ' – ' + features[0] : ''}${brand ? ' | ' + brand : ''}`, 70);
  const youtubeTags = unique([...keywords, ...buildHashtags(p, s).map((h) => h.replace(/^#/, ''))]).slice(0, 15);
  const imageAlt = clip(`${p.name}${p.category ? ` – ${p.category}` : ''}${brand ? ` by ${brand}` : ''}`, 120);

  return { keyword, title, description, slug, keywords, h1, jsonLd, article, youtubeTitle, youtubeTags, imageAlt };
}

/** Scores a page title + description for one focus keyword. */
export function scoreSeo(input: { keyword: string; title: string; description: string; slug: string; article?: string; imageAlt?: string }): SeoScore {
  const kw = clean(input.keyword).toLowerCase();
  const has = (t = '') => !!kw && t.toLowerCase().includes(kw);
  const words = (input.article ?? '').split(/\s+/).filter(Boolean).length;
  const t = clean(input.title), d = clean(input.description);
  const checks: SeoCheck[] = [
    { ok: !!kw, label: 'A focus keyword is chosen', tip: 'Pick the phrase people type into Google to find this product.' },
    { ok: t.length >= 30 && t.length <= 60, label: `Title length ${t.length} (best 30–60)`, tip: 'Longer titles are cut off in search results; very short ones waste space.' },
    { ok: has(t), label: 'Keyword appears in the title', tip: 'Put the keyword near the start of the title.' },
    { ok: d.length >= 70 && d.length <= 160, label: `Description length ${d.length} (best 70–160)`, tip: 'This is the grey text under the title in search results.' },
    { ok: has(d), label: 'Keyword appears in the description', tip: 'Search engines bold the words that match the search.' },
    { ok: /^[a-z0-9\p{L}-]+$/u.test(input.slug) && input.slug.length <= 70 && input.slug.length > 0, label: 'Short, clean page address', tip: 'Use lowercase words joined by hyphens.' },
    { ok: has(input.slug.replace(/-/g, ' ')), label: 'Keyword appears in the page address', tip: 'For example /herbal-hair-oil.' },
  ];
  if (input.article !== undefined) {
    checks.push({ ok: words >= 300, label: `Article length ${words} words (aim for 300+)`, tip: 'Longer, helpful pages rank better. Add real answers to customer questions.' });
    checks.push({ ok: has(input.article), label: 'Keyword appears in the article', tip: 'Use it naturally in the first paragraph.' });
  }
  if (input.imageAlt !== undefined) checks.push({ ok: clean(input.imageAlt).length >= 5, label: 'Photos have a description (alt text)', tip: 'Helps Google Images and people using screen readers.' });
  const score = Math.round((checks.filter((c) => c.ok).length / checks.length) * 100);
  return { score, checks };
}
