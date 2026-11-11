import { describe, expect, it } from 'vitest';
import { planAutopilot } from '../src/core/autopilot';
import { buildCopy, buildScript } from '../src/core/copy';
import { changePassword, createVault, lockoutDelayMs, open, openJson, passwordStrength, seal, sealJson, unlockWithPassword, unlockWithRecoveryKey } from '../src/core/crypto';
import { leadsFromCsv, leadsToCsv, scoreLead } from '../src/core/leads';
import type { Data } from '../src/core/store';
import { DEFAULT_SETTINGS, type Lead, type Product } from '../src/core/types';

const IT = 1000; // low PBKDF2 cost keeps tests fast; production uses 600,000
const product: Product = { id: 'p1', name: 'Glow Serum', category: 'skincare', description: 'A light vitamin C serum. Brightens in two weeks.', price: '499', offer: '20% off', features: ['Vitamin C', 'No parabens', 'Dermatologist tested', 'Vegan'], audience: 'busy women', keywords: ['glow'], imageIds: [], active: true, createdAt: 0 };
const lead = (over: Partial<Lead> = {}): Lead => ({ id: 'l1', name: 'Asha Rao', phone: '9876543210', email: '', source: 'instagram', stage: 'new', score: 0, notes: '', consent: true, value: 0, createdAt: 1_000_000, ...over });
const data = (over: Partial<Data> = {}): Data => ({ products: [], videos: [], posts: [], leads: [], messages: [], campaigns: [], activity: [], settings: [], ...over });

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

describe('autopilot', () => {
  const now = 1_700_000_000_000;
  it('queues one video per format, a week of posts and a welcome message – all awaiting approval', () => {
    const plan = planAutopilot(data({ products: [product], leads: [lead({ createdAt: now })] }), DEFAULT_SETTINGS, now);
    expect(plan.videos.map((v) => v.format).sort()).toEqual(['reel', 'wide']);
    expect(plan.videos.every((v) => v.status === 'queued')).toBe(true);
    expect(plan.posts.length).toBe(DEFAULT_SETTINGS.autopilot.postsPerWeek);
    expect(plan.posts.every((p) => p.status === 'pending' && p.scheduledFor > now)).toBe(true);
    expect(plan.messages).toHaveLength(1);
    expect(plan.messages[0]).toMatchObject({ reason: 'welcome', status: 'pending', channel: 'whatsapp' });
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
