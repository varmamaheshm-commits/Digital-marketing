import 'fake-indexeddb/auto';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handleLink, newPairingCode } from '../src/core/link';
import { getSnapshot, lock, put, putBlob, setupVault, unlock } from '../src/core/store';
import type { Product, Video } from '../src/core/types';

const require = createRequire(import.meta.url);
const link = require('../electron/link.cjs');

const PW = 'blue-Tiger-2026!';
const CODE = 'ABCDE-FGHJK-MNPQR-STVWX';
const product: Product = { id: 'aaaaaaaa01', name: 'Glow Serum', category: 'skincare', description: '', price: '499', offer: '', features: [], audience: '', keywords: [], imageIds: [], active: true, createdAt: 0 };
const video = (over: Partial<Video>): Video => ({ id: 'bbbbbbbb01', productId: product.id, format: 'reel', style: 'bold', mood: 'none', seed: 1, script: [], caption: 'A caption', hashtags: ['#Glow'], title: 'Glow Serum', status: 'pending', createdAt: 1, seconds: 19, mime: 'video/mp4', ...over });

describe('phone link: what the app allows', () => {
  let fileBytes: Uint8Array;
  beforeAll(async () => {
    await setupVault(PW);
    await put('products', product);
    fileBytes = new Uint8Array(5000).map((_, i) => i % 251);
    const blobId = await putBlob(fileBytes);
    const thumbId = await putBlob(new Uint8Array([1, 2, 3]));
    await put('videos', video({ blobId, thumbId }));
    await put('videos', video({ id: 'bbbbbbbb02', status: 'rejected', blobId }));
  }, 30000);

  it('lists only videos waiting for approval, with caption and shape', async () => {
    const r = await handleLink({ method: 'GET', path: '/api/approvals', body: null });
    expect(r.status).toBe(200);
    const videos = (r as any).json.videos;
    expect(videos).toHaveLength(1);
    expect(videos[0]).toMatchObject({ id: 'bbbbbbbb01', product: 'Glow Serum', shape: 'Vertical 9:16', seconds: 19 });
    expect(videos[0].caption).toContain('#Glow');
  });
  it('serves the video file for preview, but not for a rejected video', async () => {
    const ok = await handleLink({ method: 'GET', path: '/api/videos/bbbbbbbb01/file', body: null });
    expect(ok.status).toBe(200);
    expect(new Uint8Array((ok as any).buffer)).toEqual(fileBytes);
    expect((await handleLink({ method: 'GET', path: '/api/videos/bbbbbbbb02/file', body: null })).status).toBe(404);
    expect((await handleLink({ method: 'GET', path: '/api/videos/../../etc/file', body: null })).status).toBe(404);
  });
  it('approves from the phone exactly once', async () => {
    const r = await handleLink({ method: 'POST', path: '/api/videos/bbbbbbbb01/approve', body: null });
    expect(r).toMatchObject({ status: 200, json: { status: 'approved' } });
    expect(getSnapshot().data.videos.find((v) => v.id === 'bbbbbbbb01')!.status).toBe('approved');
    expect((await handleLink({ method: 'POST', path: '/api/videos/bbbbbbbb01/reject', body: null })).status).toBe(409);
  });
  it('adds a lead from an automation, never assuming consent, and exposes no way to read leads', async () => {
    const r = await handleLink({ method: 'POST', path: '/api/leads', body: { name: '  Asha Rao ', phone: '+91 98765 43210', source: 'website form', product: 'glow', consent: 'yes', notes: 'x'.repeat(5000) } });
    expect(r.status).toBe(201);
    const lead = getSnapshot().data.leads[0];
    expect(lead).toMatchObject({ name: 'Asha Rao', source: 'website form', productId: product.id, consent: false, stage: 'new' });
    expect(lead.notes.length).toBe(1000);
    expect((await handleLink({ method: 'POST', path: '/api/leads', body: { notes: 'no contact' } })).status).toBe(400);
    expect((await handleLink({ method: 'GET', path: '/api/leads', body: null })).status).toBe(404);
    expect((await handleLink({ method: 'GET', path: '/api/settings', body: null })).status).toBe(404);
  });
  it('answers "locked" when the app is locked', async () => {
    lock();
    expect((await handleLink({ method: 'GET', path: '/api/approvals', body: null })).status).toBe(503);
    expect(await unlock({ password: PW })).toBeNull();
  }, 30000);
  it('creates pairing codes that are long and unpredictable', () => {
    const a = newPairingCode(), b = newPairingCode();
    expect(a).toMatch(/^([A-Z2-9]{5}-){3}[A-Z2-9]{5}$/);
    expect(a).not.toBe(b);
  });
});

describe('phone link: the server on the PC', () => {
  let server: any, base = '';
  const seen: any[] = [];
  const file = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));
  const get = (path: string, headers: Record<string, string> = {}) => fetch(base + path, { headers });
  const auth = { Authorization: 'Bearer ' + CODE };

  beforeAll(async () => {
    server = link.createLinkServer({
      code: CODE,
      handle: async (req: any) => { seen.push(req); return req.path.endsWith('/file') ? { status: 200, type: 'video/mp4', buffer: file } : { status: 200, json: { ok: true, path: req.path, body: req.body } }; },
    });
    base = 'http://127.0.0.1:' + (await server.listen(0, '127.0.0.1'));
  });
  afterAll(() => server.close());

  it('serves the phone page without a code, and it contains no data', async () => {
    const r = await get('/');
    const html = await r.text();
    expect(r.status).toBe(200);
    expect(r.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(html).toContain('pairing code');
    expect(html).not.toContain(CODE);
  });
  it('refuses API requests without the right code and never reaches the app', async () => {
    seen.length = 0;
    expect((await get('/api/approvals')).status).toBe(401);
    expect((await get('/api/approvals', { Authorization: 'Bearer WRONG-CODE-12345-67890' })).status).toBe(401);
    expect(seen).toHaveLength(0);
  });
  it('accepts the code however it is typed (case, spaces, dashes)', async () => {
    expect((await get('/api/approvals', { Authorization: 'Bearer abcde fghjk mnpqr stvwx' })).status).toBe(200);
    expect((await get('/api/videos/x/thumb?k=' + encodeURIComponent(CODE))).status).toBe(200);
  });
  it('passes JSON bodies through and rejects broken or oversized ones', async () => {
    const ok = await fetch(base + '/api/leads', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'A' }) });
    expect((await ok.json()).body).toEqual({ name: 'A' });
    expect((await fetch(base + '/api/leads', { method: 'POST', headers: auth, body: '{not json' })).status).toBe(400);
    expect((await fetch(base + '/api/leads', { method: 'POST', headers: auth, body: 'x'.repeat(70_000) })).status).toBe(413);
    expect((await fetch(base + '/api/leads', { method: 'DELETE', headers: auth })).status).toBe(405);
  });
  it('supports seeking in a video (byte ranges), as phones require', async () => {
    const part = await get('/api/videos/v1/file', { ...auth, Range: 'bytes=100-199' });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe('bytes 100-199/1000');
    expect(Buffer.from(await part.arrayBuffer())).toEqual(file.subarray(100, 200));
    const tail = await get('/api/videos/v1/file', { ...auth, Range: 'bytes=-10' });
    expect(Buffer.from(await tail.arrayBuffer())).toEqual(file.subarray(990));
    expect((await get('/api/videos/v1/file', { ...auth, Range: 'bytes=5000-' })).status).toBe(416);
    // the decrypted file is reused for the follow-up range requests instead of asking the app again
    expect(seen.filter((r) => r.path === '/api/videos/v1/file')).toHaveLength(1);
  });
  it('locks out an address after five wrong codes', async () => {
    const s = link.createLinkServer({ code: CODE, handle: async () => ({ status: 200, json: {} }) });
    const b = 'http://127.0.0.1:' + (await s.listen(0, '127.0.0.1'));
    for (let i = 0; i < 5; i++) expect((await fetch(b + '/api/status', { headers: { Authorization: 'Bearer NOPE' + i } })).status).toBe(401);
    const locked = await fetch(b + '/api/status', { headers: auth });
    expect(locked.status).toBe(429);
    expect((await locked.json()).error).toMatch(/Try again in \d+ seconds/);
    await s.close();
  });
  it('refuses callers from outside the local network', async () => {
    const s = link.createLinkServer({ code: CODE, isAllowed: () => false, handle: async () => ({ status: 200, json: {} }) });
    const b = 'http://127.0.0.1:' + (await s.listen(0, '127.0.0.1'));
    expect((await fetch(b + '/api/status', { headers: auth })).status).toBe(403);
    expect((await fetch(b + '/')).status).toBe(403);
    await s.close();
    for (const ip of ['127.0.0.1', '::ffff:192.168.1.5', '10.0.0.2', '172.20.1.1', 'fd12:3456::1']) expect(link.isPrivateAddress(ip)).toBe(true);
    for (const ip of ['8.8.8.8', '172.32.0.1', '2001:db8::1', '', '192.169.0.1']) expect(link.isPrivateAddress(ip)).toBe(false);
  });
  it('signs automation events so the receiver can verify them', async () => {
    const calls: any[] = [];
    const res = await link.notify('http://localhost:5678/webhook/x', CODE, 'video.approved', { product: 'Glow Serum' }, async (url: string, init: any) => { calls.push({ url, init }); return { ok: true }; });
    expect(res).toEqual({ ok: true });
    const { createHmac } = require('node:crypto');
    expect(calls[0].init.headers['X-Marketing-Studio-Signature']).toBe('sha256=' + createHmac('sha256', CODE).update(calls[0].init.body).digest('hex'));
    expect(JSON.parse(calls[0].init.body)).toMatchObject({ event: 'video.approved', data: { product: 'Glow Serum' } });
    expect((await link.notify('ftp://x/y', CODE, 'test', {})).ok).toBe(false);
    expect((await link.notify('not a url', CODE, 'test', {})).ok).toBe(false);
  });
});
