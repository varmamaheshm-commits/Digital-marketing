import { afterEach, describe, expect, it, vi } from 'vitest';
import { aiAnswer, aiCopy, aiScript } from '../src/core/agents';
import { planAutopilot } from '../src/core/autopilot';
import { buildCopy, buildScript } from '../src/core/copy';
import { changePassword, createVault, lockoutDelayMs, open, openJson, passwordStrength, seal, sealJson, unlockWithPassword, unlockWithRecoveryKey } from '../src/core/crypto';
import { draftAnswer, search } from '../src/core/knowledge';
import { leadsFromCsv, leadsToCsv, scoreLead } from '../src/core/leads';
import type { Data } from '../src/core/store';
import { DEFAULT_SETTINGS, type Lead, type Product } from '../src/core/types';

const IT = 1000; // low PBKDF2 cost keeps tests fast; production uses 600,000
const product: Product = { id: 'p1', name: 'Glow Serum', category: 'skincare', description: 'A light vitamin C serum. Brightens in two weeks.', price: '499', offer: '20% off', features: ['Vitamin C', 'No parabens', 'Dermatologist tested', 'Vegan'], audience: 'busy women', keywords: ['glow'], imageIds: [], active: true, createdAt: 0 };
const lead = (over: Partial<Lead> = {}): Lead => ({ id: 'l1', name: 'Asha Rao', phone: '9876543210', email: '', source: 'instagram', stage: 'new', score: 0, notes: '', consent: true, value: 0, createdAt: 1_000_000, ...over });
const data = (over: Partial<Data> = {}): Data => ({ products: [], videos: [], posts: [], leads: [], messages: [], campaigns: [], activity: [], knowledge: [], accounts: [], publications: [], settings: [], ...over });
const ALL = { ...DEFAULT_SETTINGS, approvals: 'all' as const };

describe('vault encryption', () => {
  it('unlocks with the right password and rejects a wrong one', async () => {
    const { meta, dek } = await createVault('correct horse 42', IT);
    const sealed = await sealJson(dek, { secret: 'lead list' }, 'leads:1');
    const again = await unlockWithPassword(meta, 'correct horse 42');
    expect(await openJson(again, sealed, 'leads:1')).toEqual({ secret: 'lead list' });
    await expect(unlockWithPassword(meta, 'wrong password')).rejects.toThrow();
  });
  it('keeps the data key non-extractable and the ciphertext unreadable', async () => {
    const { dek } = await createVault('correct horse 42', IT);
    expect(dek.extractable).toBe(false);
    const sealed = await seal(dek, new TextEncoder().encode('phone 9876543210'), 'x');
    expect(new TextDecoder().decode(sealed.ct)).not.toContain('9876543210');
  });
  it('refuses a record moved to another slot or tampered with', async () => {
    const { dek } = await createVault('correct horse 42', IT);
    const sealed = await sealJson(dek, { a: 1 }, 'leads:1');
    await expect(open(dek, sealed, 'leads:2')).rejects.toThrow();
    new Uint8Array(sealed.ct)[0] ^= 1;
    await expect(open(dek, sealed, 'leads:1')).rejects.toThrow();
  });
  it('recovers with the recovery key and supports password change', async () => {
    const { meta, dek, recoveryKey } = await createVault('first password 1', IT);
    const sealed = await sealJson(dek, 'hello', 'k');
    expect(recoveryKey).toMatch(/^([A-Z2-9]{5}-){5}[A-Z2-9]{5}$/);
    expect(await openJson(await unlockWithRecoveryKey(meta, recoveryKey.toLowerCase()), sealed, 'k')).toBe('hello');
    await expect(unlockWithRecoveryKey(meta, 'AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA')).rejects.toThrow();
    const meta2 = await changePassword(meta, { recoveryKey }, 'second password 2');
    await expect(unlockWithPassword(meta2, 'first password 1')).rejects.toThrow();
    expect(await openJson(await unlockWithPassword(meta2, 'second password 2'), sealed, 'k')).toBe('hello');
    await expect(changePassword(meta2, { password: 'nope' }, 'x')).rejects.toThrow();
  });
  it('rates passwords and escalates lockout delays', () => {
    expect(passwordStrength('short').ok).toBe(false);
    expect(passwordStrength('aaaaaaaaaaaaaaaa').ok).toBe(false);
    expect(passwordStrength('blue-Tiger-2026').ok).toBe(true);
    expect(lockoutDelayMs(4)).toBe(0);
    expect(lockoutDelayMs(5)).toBe(30_000);
    expect(lockoutDelayMs(7)).toBe(120_000);
    expect(lockoutDelayMs(50)).toBe(15 * 60_000);
  });
});

describe('copywriter', () => {
  it('builds a full script that is stable for a seed', () => {
    const a = buildScript(product, DEFAULT_SETTINGS, 7);
    expect(a.map((s) => s.kind)).toEqual(['hook', 'reveal', 'feature', 'feature', 'feature', 'offer', 'cta']);
    expect(a[1].text).toBe('Glow Serum');
    expect(a.find((s) => s.kind === 'offer')!.text).toBe('₹499');
    expect(buildScript(product, DEFAULT_SETTINGS, 7)).toEqual(a);
  });
  it('still works for a product with only a name', () => {
    const bare = { ...product, description: '', price: '', offer: '', features: [], audience: '' };
    const s = buildScript(bare, DEFAULT_SETTINGS, 1);
    expect(s.some((x) => x.kind === 'offer')).toBe(false);
    expect(s.filter((x) => x.kind === 'feature').length).toBe(3);
  });
  it('writes copy for every platform', () => {
    for (const p of ['instagram', 'youtube', 'facebook', 'whatsapp', 'email', 'ad'] as const) {
      const c = buildCopy(product, DEFAULT_SETTINGS, p, 3);
      expect(c.body).toContain('Glow Serum');
      expect(c.title.length).toBeGreaterThan(3);
    }
    expect(buildCopy(product, DEFAULT_SETTINGS, 'instagram', 3).hashtags).toContain('#GlowSerum');
    expect(buildCopy(product, DEFAULT_SETTINGS, 'youtube', 3).title.length).toBeLessThanOrEqual(95);
  });
});

describe('leads', () => {
  it('scores warm, complete leads higher', () => {
    const now = 2_000_000;
    expect(scoreLead(lead({ stage: 'qualified', email: 'a@b.c', productId: 'p1' }), now)).toBeGreaterThan(scoreLead(lead({ phone: '', consent: false }), now));
    expect(scoreLead(lead({ stage: 'won' }))).toBe(100);
    expect(scoreLead(lead({ stage: 'lost' }))).toBe(0);
  });
  it('imports CSV with quotes and never assumes consent', () => {
    const rows = leadsFromCsv('Name,Mobile,Email,Notes\n"Rao, Asha",98765,a@b.c,"said ""call me"""\n\nRavi,12345,,\n');
    expect(rows.length).toBe(2);
    expect(rows[0]).toMatchObject({ name: 'Rao, Asha', phone: '98765', email: 'a@b.c', notes: 'said "call me"', consent: false });
  });
  it('neutralises spreadsheet formulas on export', () => {
    const csv = leadsToCsv([lead({ name: '=HYPERLINK("http://evil")', notes: '+1' })], () => '');
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(csv).toContain(",'+1");
  });
});

describe('knowledge base', () => {
  const docs = [
    { id: 'd1', title: 'Policies', text: 'Returns are accepted within 7 days of delivery if the seal is unopened.\n\nDelivery takes 3 to 5 working days across India. Shipping is free above 999.', createdAt: 0 },
    { id: 'd2', title: 'Glow Serum FAQ', text: 'Apply two drops every morning before sunscreen. Suitable for all skin types.', createdAt: 0 },
  ];
  it('finds the passage that answers a question', () => {
    expect(search(docs, 'what is your return policy?')[0].text).toContain('Returns are accepted');
    expect(search(docs, 'how long does delivery take')[0].text).toContain('3 to 5 working days');
    expect(search(docs, 'how do I apply the serum')[0].title).toBe('Glow Serum FAQ');
    expect(search(docs, 'cryptocurrency')).toEqual([]);
  });
  it('drafts a reply only from the documents', () => {
    const reply = draftAnswer(search(docs, 'return policy'), DEFAULT_SETTINGS, 'Asha Rao');
    expect(reply).toContain('Hi Asha,');
    expect(reply).toContain('within 7 days');
    expect(draftAnswer([], DEFAULT_SETTINGS)).toContain('get back to you');
  });
});

describe('AI agents (local engine)', () => {
  afterEach(() => vi.unstubAllGlobals());
  const engine = (reply: unknown) => {
    const calls: { url: string; body?: any }[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: any) => {
      calls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
      if (url.endsWith('/api/tags')) return new Response(JSON.stringify({ models: [{ name: 'local-model' }] }));
      return new Response(JSON.stringify({ message: { content: typeof reply === 'string' ? reply : JSON.stringify(reply) } }));
    });
    return calls;
  };
  const docs = [{ id: 'd', title: 'FAQ', text: 'Glow Serum is made in Hyderabad in small batches.', createdAt: 0 }];
  const base = buildScript(product, DEFAULT_SETTINGS, 7);

  it('script writer keeps the product name and only talks to this computer, with retrieved facts', async () => {
    const calls = engine({ hook: 'మీ చర్మానికి కొత్త మెరుపు', tagline: 'Two weeks to brighter skin', features: ['Pure vitamin C', 'x'.repeat(200), 42], offer_note: 'This week only', cta: 'ఈరోజే ఆర్డర్ చేయండి' });
    const out = await aiScript('local-model', product, DEFAULT_SETTINGS, 'te', base, docs);
    expect(out[0].text).toBe('మీ చర్మానికి కొత్త మెరుపు');
    expect(out[1].text).toBe('Glow Serum');
    expect(out.at(-1)!.text).toBe('ఈరోజే ఆర్డర్ చేయండి');
    const feats = out.filter((s) => s.kind === 'feature');
    expect(feats[0].text).toBe('Pure vitamin C');
    expect(feats[1].text).toBe(base.filter((s) => s.kind === 'feature')[1].text); // over-long line rejected
    expect(feats[2].text).toBe(base.filter((s) => s.kind === 'feature')[2].text); // wrong type rejected
    expect(calls.every((c) => /^http:\/\/(127\.0\.0\.1|localhost):11434\//.test(c.url))).toBe(true);
    const prompt = calls.at(-1)!.body.messages[1].content;
    expect(prompt).toContain('made in Hyderabad');
    expect(prompt).toContain('Telugu');
  });
  it('falls back to the template when the engine returns rubbish', async () => {
    engine({ title: 5, body: '', hashtags: ['no-hash', '#Good_One'] });
    const fallback = buildCopy(product, DEFAULT_SETTINGS, 'instagram', 1);
    const out = await aiCopy('local-model', product, DEFAULT_SETTINGS, 'instagram', fallback, []);
    expect(out.title).toBe(fallback.title);
    expect(out.body).toBe(fallback.body);
    expect(out.hashtags).toEqual(['#Good_One']);
    engine('not json at all');
    await expect(aiAnswer('local-model', 'q', [], DEFAULT_SETTINGS)).rejects.toThrow();
  });
});

describe('autopilot', () => {
  const now = 1_700_000_000_000;
  it('queues one video per format, a week of posts and a welcome message – all awaiting approval', () => {
    const plan = planAutopilot(data({ products: [product], leads: [lead({ createdAt: now })] }), ALL, now);
    expect(plan.videos.map((v) => v.format).sort()).toEqual(['reel', 'wide']);
    expect(plan.videos.every((v) => v.status === 'queued')).toBe(true);
    expect(plan.posts.length).toBe(DEFAULT_SETTINGS.autopilot.postsPerWeek);
    expect(plan.posts.every((p) => p.status === 'pending' && p.scheduledFor > now)).toBe(true);
    expect(plan.messages).toHaveLength(1);
    expect(plan.messages[0]).toMatchObject({ reason: 'welcome', status: 'pending', channel: 'whatsapp' });
  });
  it('by default holds only videos for approval and makes one video per language', () => {
    const s = { ...DEFAULT_SETTINGS, autopilot: { ...DEFAULT_SETTINGS.autopilot, languages: ['en', 'te'] as const } };
    const plan = planAutopilot(data({ products: [product], leads: [lead({ createdAt: now })] }), s as any, now);
    expect(plan.videos.map((v) => `${v.format}-${v.lang}`).sort()).toEqual(['reel-en', 'reel-te', 'wide-en', 'wide-te']);
    expect(plan.videos.every((v) => v.status === 'queued')).toBe(true);
    expect(plan.posts.every((p) => p.status === 'approved')).toBe(true);
    expect(plan.messages[0].status).toBe('approved');
    const te = plan.videos.find((v) => v.lang === 'te')!;
    expect(te.script.at(-1)!.text).toMatch(/[\u0C00-\u0C7F]/);
    expect(te.script[1].text).toBe('Glow Serum');
  });
  it('does not duplicate work that already exists', () => {
    const d = data({ products: [product], leads: [lead({ createdAt: now })] });
    const first = planAutopilot(d, DEFAULT_SETTINGS, now);
    const second = planAutopilot({ ...d, videos: first.videos, posts: first.posts, messages: first.messages }, DEFAULT_SETTINGS, now + 1000);
    expect(second.videos.length + second.posts.length + second.messages.length).toBe(0);
  });
  it('never drafts messages for people who did not consent, and does nothing when switched off', () => {
    const d = data({ products: [product], leads: [lead({ consent: false })] });
    expect(planAutopilot(d, DEFAULT_SETTINGS, now).messages).toHaveLength(0);
    const off = { ...DEFAULT_SETTINGS, autopilot: { ...DEFAULT_SETTINGS.autopilot, enabled: false } };
    const plan = planAutopilot(data({ products: [product], leads: [lead()] }), off, now);
    expect(plan.videos.length + plan.posts.length + plan.messages.length).toBe(0);
  });
  it('drafts a follow-up only after the quiet period', () => {
    const sent = { id: 'm1', leadId: 'l1', channel: 'whatsapp' as const, reason: 'welcome' as const, subject: '', body: '', status: 'sent' as const, createdAt: now };
    const l = lead({ createdAt: now, lastContactAt: now, stage: 'contacted' });
    expect(planAutopilot(data({ leads: [l], messages: [sent] }), DEFAULT_SETTINGS, now + 86_400_000).messages).toHaveLength(0);
    const later = planAutopilot(data({ leads: [l], messages: [sent] }), DEFAULT_SETTINGS, now + 4 * 86_400_000);
    expect(later.messages[0]?.reason).toBe('follow-up');
  });
});
