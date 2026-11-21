import { describe, expect, it } from 'vitest';
import { planAutopilot } from '../src/core/autopilot';
import { buildLandingPage, trackedLink, validFormUrl, waNumber, whatsappLink } from '../src/core/landing';
import { buildReport, reportCsv, reportHtml, weekStart } from '../src/core/report';
import { buildSeo, clip, scoreSeo, slugify } from '../src/core/seo';
import type { Data } from '../src/core/store';
import { DEFAULT_SETTINGS, type Campaign, type Lead, type Product, type Settings } from '../src/core/types';

const product: Product = { id: 'p1', name: 'Herbal Hair Oil', category: 'hair care', description: 'Cold-pressed oil with bhringraj and amla for stronger hair.', price: '349', offer: 'Buy 2 get 1 free', features: ['No mineral oil', 'Ayurvedic herbs', 'Reduces hair fall'], audience: 'women and men', keywords: ['hair oil'], imageIds: ['img1'], active: true, createdAt: 0 };
const S: Settings = { ...DEFAULT_SETTINGS, business: { name: 'Varma Naturals', tagline: '', phone: '98765 43210', website: 'https://varma.example', city: 'Hyderabad' } };
const data = (over: Partial<Data> = {}): Data => ({ products: [product], videos: [], posts: [], leads: [], messages: [], campaigns: [], activity: [], knowledge: [], accounts: [], publications: [], images: [], settings: [], ...over });
const lead = (over: Partial<Lead>): Lead => ({ id: Math.random().toString(16).slice(2), name: 'A', phone: '', email: '', source: 'instagram', stage: 'new', score: 0, notes: '', consent: false, value: 0, createdAt: 0, ...over });

describe('SEO', () => {
  it('writes search texts within the usual limits', () => {
    const s = buildSeo(product, S);
    expect(s.title.length).toBeLessThanOrEqual(60);
    expect(s.description.length).toBeLessThanOrEqual(155);
    expect(s.slug).toBe('herbal-hair-oil');
    expect(s.keyword).toBe('hair oil');
    expect(s.keywords).toContain('hair care in hyderabad');
    expect(JSON.parse(s.jsonLd.replace(/<\/?script[^>]*>/g, ''))).toMatchObject({ '@type': 'Product', name: 'Herbal Hair Oil', offers: { price: '349.00', priceCurrency: 'INR' } });
    expect(s.article).toContain('## Frequently asked questions');
  });
  it('scores titles and descriptions', () => {
    const good = scoreSeo({ keyword: 'hair oil', title: 'Herbal Hair Oil for strong hair | Varma Naturals', description: 'Cold-pressed herbal hair oil with bhringraj and amla. Reduces hair fall. Order in Hyderabad today.', slug: 'herbal-hair-oil' });
    const bad = scoreSeo({ keyword: 'hair oil', title: 'Oil', description: 'Buy now', slug: 'Some Page!' });
    expect(good.score).toBe(100);
    expect(bad.score).toBeLessThan(40);
    expect(bad.checks.find((c) => c.label.startsWith('Title length'))?.ok).toBe(false);
  });
  it('cuts at word boundaries and makes clean addresses', () => {
    expect(clip('one two three four five', 12)).toBe('one two…');
    expect(slugify('Café Spécial – 100% Pure!')).toBe('cafe-special-100-pure');
  });
});

describe('lead capture page', () => {
  it('builds a safe page with a consent box and the form address', () => {
    const html = buildLandingPage({ ...product, name: 'Oil <script>alert(1)</script>' }, { ...S, capture: { formUrl: 'https://n8n.example.com/webhook/new-lead', whatsapp: '' } }, { photo: 'data:image/jpeg;base64,AAAA' });
    expect(html).not.toContain('<script>alert(1)');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('name="consent"');
    expect(html).toContain('connect-src https://n8n.example.com');
    expect(html).toContain('"formUrl":"https://n8n.example.com/webhook/new-lead"');
    expect(html).toContain('data:image/jpeg;base64,AAAA');
  });
  it('refuses unsafe form addresses and photos', () => {
    const html = buildLandingPage(product, { ...S, capture: { formUrl: 'javascript:alert(1)', whatsapp: '' } }, { photo: 'javascript:alert(1)' });
    expect(html).toContain('"formUrl":""');
    expect(html).toContain("connect-src 'none'");
    expect(html).not.toContain('javascript:alert');
    expect(validFormUrl('http://evil.example')).toBe(false);
    expect(validFormUrl('http://localhost:5678/webhook/x')).toBe(true);
  });
  it('makes WhatsApp and tracked links', () => {
    expect(waNumber('98765 43210')).toBe('919876543210');
    expect(waNumber('+44 20 7946 0958')).toBe('442079460958');
    expect(whatsappLink('9876543210', 'Hi there')).toBe('https://wa.me/919876543210?text=Hi%20there');
    expect(trackedLink('varma.example/oil', { source: 'Instagram', medium: 'social', campaign: 'Diwali Sale' })).toBe('https://varma.example/oil?utm_source=instagram&utm_medium=social&utm_campaign=diwali-sale');
    expect(trackedLink('not a url', { source: 'x', medium: 'y', campaign: 'z' })).toBe('');
  });
});

describe('reports', () => {
  const now = new Date(2026, 10, 20, 12).getTime();
  const day = 86_400_000;
  const camp: Campaign = { id: 'c', name: '=HYPERLINK("x")', goal: '', channels: ['instagram'], budget: 1000, start: now - 10 * day, end: now + day, status: 'active', metrics: { impressions: 10000, clicks: 200, leads: 10, sales: 2, spend: 1000, revenue: 4000 }, createdAt: 0 };
  const d = data({
    leads: [
      lead({ createdAt: now - day, stage: 'won', value: 700, phone: '9', consent: true, productId: 'p1' }),
      lead({ createdAt: now - 2 * day, stage: 'lost', email: 'a@b.c', source: 'Website form' }),
      lead({ createdAt: now - 3 * day, source: 'website form' }),
      lead({ createdAt: now - 40 * day }),
    ],
    campaigns: [camp],
  });
  it('adds up leads, sources and campaign returns for the period', () => {
    const r = buildReport(d, now - 30 * day, now + day);
    expect(r.leads).toMatchObject({ total: 3, won: 1, lost: 1, winRate: 0.5, wonValue: 700, withPhone: 1, withEmail: 1, consented: 1 });
    expect(r.bySource[0]).toEqual({ source: 'website form', leads: 2, won: 0 });
    expect(r.campaigns[0]).toMatchObject({ ctr: 0.02, cpl: 100, roas: 4 });
    expect(r.totals).toMatchObject({ spend: 1000, revenue: 4000, roas: 4 });
    expect(r.weekly.reduce((a, w) => a + w.leads, 0)).toBe(3);
  });
  it('exports a spreadsheet that cannot run formulas, and a printable page', () => {
    const r = buildReport(d, now - 30 * day, now + day);
    const csv = reportCsv(r, S);
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    const html = reportHtml(r, S);
    expect(html).toContain('Marketing report');
    expect(html).not.toContain('=HYPERLINK("x")</td>');
  });
  it('starts weeks on Monday', () => {
    expect(new Date(weekStart(new Date(2026, 10, 22).getTime())).getDay()).toBe(1);
  });
});

describe('autopilot images', () => {
  it('plans a square and a story image per product with photos, once per refresh period', () => {
    const plan = planAutopilot(data(), S, 1_000_000_000);
    expect(plan.images).toEqual([{ productId: 'p1', format: 'square' }, { productId: 'p1', format: 'story' }]);
    const recent = data({ images: [{ id: 'i', productId: 'p1', format: 'square', template: 'split', headline: '', sub: '', badge: '', cta: '', seed: 1, caption: '', hashtags: [], status: 'approved', createdAt: 1_000_000_000 - 1000 }] });
    expect(planAutopilot(recent, S, 1_000_000_000).images).toEqual([{ productId: 'p1', format: 'story' }]);
    expect(planAutopilot(data({ products: [{ ...product, imageIds: [] }] }), S, 1_000_000_000).images).toEqual([]);
  });
});
