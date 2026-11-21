import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { planPublications, textFor } from '../src/core/publisher';
import type { Data } from '../src/core/store';
import { DEFAULT_SETTINGS, type Creative, type Post, type SocialAccount } from '../src/core/types';

const require = createRequire(import.meta.url);
const social = require('../electron/publish.cjs');

/** A fake network: answers by URL path and records every request. */
function fakeNet(routes: Record<string, (body: any, init: any) => any>) {
  const log: { url: string; method: string; headers: Record<string, string>; body: any }[] = [];
  const fetch = async (url: string, init: any = {}) => {
    const u = new URL(url);
    const key = Object.keys(routes).find((k) => u.pathname.endsWith(k));
    let body: any = init.body;
    if (body instanceof URLSearchParams) body = Object.fromEntries(body);
    else if (typeof body === 'string') { try { body = JSON.parse(body); } catch { /* raw */ } }
    log.push({ url, method: init.method ?? 'GET', headers: init.headers ?? {}, body });
    if (!key) return new Response(JSON.stringify({ error: { message: 'unknown ' + u.pathname } }), { status: 404 });
    const out = routes[key](body, init);
    return new Response(JSON.stringify(out?.json ?? out), { status: out?.status ?? 200, headers: out?.headers ?? {} });
  };
  return { log, deps: { fetch, allowHost: () => true, sleep: async () => {} } };
}
const png = Buffer.from('89504e470d0a1a0a0000', 'hex');
/** Placeholder in the shape of a Telegram bot key (digits, colon, 35 letters). Made up at run time; not a real key. */
const fakeBotKey = (): string => `${100000000 + Math.floor(Math.random() * 899999999)}:${'x'.repeat(35)}`;
const BOT = fakeBotKey();

describe('Telegram channel', () => {
  it('connects with a bot token and channel name, without a browser sign-in', async () => {
    const net = fakeNet({ '/getMe': () => ({ ok: true, result: { username: 'glowbot' } }), '/getChat': () => ({ ok: true, result: { id: -1001, title: 'Glow Offers', username: 'glowoffers' } }) });
    const acc = await social.connect('telegram', { clientSecret: BOT, organizationId: 'https://t.me/glowoffers' }, () => { throw new Error('no browser'); }, net.deps);
    expect(acc).toMatchObject({ accessToken: BOT, name: 'Glow Offers', extra: { chatId: '-1001', username: 'glowoffers' } });
    expect(new URL(net.log[1].url).searchParams.get('chat_id')).toBe('@glowoffers');
  });
  it('refuses a malformed token or channel before contacting Telegram', async () => {
    const net = fakeNet({});
    await expect(social.connect('telegram', { clientSecret: 'nope', organizationId: '@glow_offers' }, () => {}, net.deps)).rejects.toThrow(/BotFather/);
    await expect(social.connect('telegram', { clientSecret: BOT, organizationId: 'glow offers' }, () => {}, net.deps)).rejects.toThrow(/@channelname/);
    expect(net.log).toHaveLength(0);
  });
  it('sends images as photos and posts as messages, and never shows the token in errors', async () => {
    const net = fakeNet({ '/sendPhoto': () => ({ ok: true, result: { message_id: 41 } }), '/sendMessage': () => ({ status: 403, json: { ok: false, description: 'bot is not a member' } }) });
    const acc = { accessToken: BOT, expiresAt: 0, extra: { chatId: '-1001', username: 'glowoffers' } };
    const img = await social.publish('telegram', acc, { kind: 'image', media: png, title: 'Glow', text: 'Offer today', tags: [] }, net.deps);
    expect(img).toMatchObject({ ok: true, url: 'https://t.me/glowoffers/41' });
    const txt = await social.publish('telegram', acc, { kind: 'text', title: 'Glow', text: 'Hello', tags: [] }, net.deps);
    expect(txt.ok).toBe(false);
    expect(txt.error).not.toContain(BOT);
  });
});

describe('images and text posts on the other platforms', () => {
  it('Pinterest: pins the image to the chosen board with the website link', async () => {
    const net = fakeNet({ '/pins': () => ({ id: 'P9' }) });
    const res = await social.publish('pinterest', { accessToken: 'p', expiresAt: 0, extra: { boardId: 'B1' } }, { kind: 'image', media: png, title: 'Glow Serum', text: 'Bright skin', tags: [], link: 'https://glow.example' }, net.deps);
    expect(res).toMatchObject({ ok: true, url: 'https://www.pinterest.com/pin/P9/' });
    expect(net.log[0].body).toMatchObject({ board_id: 'B1', link: 'https://glow.example', media_source: { source_type: 'image_base64', content_type: 'image/png', data: png.toString('base64') } });
  });
  it('TikTok: posts privately while the app is unaudited, uploading with byte ranges', async () => {
    const net = fakeNet({
      '/creator_info/query/': () => ({ data: { privacy_level_options: ['SELF_ONLY'] }, error: { code: 'ok' } }),
      '/video/init/': () => ({ data: { publish_id: 'pub1', upload_url: 'https://upload.tiktokapis.com/video/?id=1' }, error: { code: 'ok' } }),
      '/video/': () => ({}),
      '/status/fetch/': () => ({ data: { status: 'PUBLISH_COMPLETE' }, error: { code: 'ok' } }),
    });
    const video = Buffer.alloc(1000, 1);
    const res = await social.publish('tiktok', { accessToken: 't', expiresAt: 0, extra: {} }, { kind: 'video', media: video, title: 'Glow', text: 'New #glow', tags: [], format: 'reel' }, net.deps);
    expect(res).toMatchObject({ ok: true, id: 'pub1' });
    expect(res.note).toMatch(/private/);
    expect(net.log[1].body.post_info.privacy_level).toBe('SELF_ONLY');
    expect(net.log[2].headers['Content-Range']).toBe('bytes 0-999/1000');
  });
  it('TikTok: reports an error object sent with status 200', async () => {
    const net = fakeNet({ '/creator_info/query/': () => ({ error: { code: 'access_token_invalid', message: 'The access token is invalid' } }) });
    const res = await social.publish('tiktok', { accessToken: 't', expiresAt: 0, extra: {} }, { kind: 'video', media: Buffer.alloc(10), title: '', text: 'x', tags: [] }, net.deps);
    expect(res).toMatchObject({ ok: false });
    expect(res.error).toMatch(/access token is invalid/);
  });
  it('Threads: creates the text container, then publishes it', async () => {
    const net = fakeNet({ '/U1/threads': () => ({ id: 'C1' }), '/threads_publish': () => ({ id: 'T1' }), '/T1': () => ({ permalink: 'https://www.threads.net/@glow/post/T1' }) });
    const res = await social.publish('threads', { accessToken: 'th', expiresAt: Date.now() + 9e9, extra: { userId: 'U1' } }, { kind: 'text', title: '', text: 'Fresh stock is in!', tags: [] }, net.deps);
    expect(res).toMatchObject({ ok: true, url: 'https://www.threads.net/@glow/post/T1' });
    expect(net.log[0].body).toMatchObject({ media_type: 'TEXT', text: 'Fresh stock is in!' });
    expect(net.log[1].body.creation_id).toBe('C1');
  });
  it('Facebook text post and X text-only post', async () => {
    const net = fakeNet({ '/PG1/feed': () => ({ id: 'PG1_5' }), '/2/tweets': () => ({ data: { id: '77' } }) });
    const fb = await social.publish('facebook', { accessToken: 'm', expiresAt: 0, extra: { pageId: 'PG1', pageToken: 'pt' } }, { kind: 'text', title: '', text: 'Sale this week', tags: [] }, net.deps);
    const x = await social.publish('x', { accessToken: 'x', expiresAt: 0, extra: {} }, { kind: 'text', title: '', text: 'Sale this week', tags: [] }, net.deps);
    expect(fb).toMatchObject({ ok: true, url: 'https://www.facebook.com/PG1_5' });
    expect(x).toMatchObject({ ok: true, url: 'https://x.com/i/status/77' });
    expect(net.log[1].body).toEqual({ text: 'Sale this week' });
  });
  it('reports refusals and network failures on the new platforms in plain words, without the access key', async () => {
    const key = fakeBotKey();
    const refused = fakeNet({ '/pins': () => ({ status: 401, json: { message: 'Authentication failed.' } }), '/U1/threads': () => ({ status: 500, json: { error: { message: 'Temporary problem' } } }) });
    const pin = await social.publish('pinterest', { accessToken: key, expiresAt: 0, extra: { boardId: 'B1' } }, { kind: 'image', media: png, title: 'Glow', text: 'x', tags: [] }, refused.deps);
    expect(pin).toMatchObject({ ok: false, retryable: false });
    expect(pin.error).toMatch(/refused \(401\): Authentication failed/);
    const th = await social.publish('threads', { accessToken: key, expiresAt: Date.now() + 86_400_000, extra: { userId: 'U1' } }, { kind: 'text', title: '', text: 'hi', tags: [] }, refused.deps);
    expect(th).toMatchObject({ ok: false, retryable: true });
    const offline = { ...refused.deps, fetch: async () => { throw new TypeError('fetch failed'); } };
    for (const [target, acc, kind] of [['telegram', { extra: { chatId: '-1' } }, 'text'], ['tiktok', { extra: {} }, 'video'], ['pinterest', { extra: { boardId: 'B1' } }, 'image']] as const) {
      const res = await social.publish(target, { accessToken: key, expiresAt: 0, ...acc }, { kind, media: Buffer.alloc(10, 1), title: 't', text: 'x', tags: [] }, offline);
      expect(res).toMatchObject({ ok: false, retryable: true });
      expect(res.error).toMatch(/network problem/);
      expect(res.error).not.toContain(key);
    }
  });
  it('refuses what a platform cannot take, and empty posts', async () => {
    const net = fakeNet({});
    expect((await social.publish('youtube', { accessToken: 'g', expiresAt: 0, extra: {} }, { kind: 'image', media: png, title: '', text: 'x', tags: [] }, net.deps)).error).toMatch(/does not accept images/);
    expect((await social.publish('threads', { accessToken: 't', expiresAt: 0, extra: {} }, { kind: 'text', title: '', text: '   ', tags: [] }, net.deps)).error).toMatch(/no text/);
    expect(net.log).toHaveLength(0);
  });
});

describe('publisher agent: images and posts', () => {
  const now = 2_000_000;
  const acc = (id: SocialAccount['id'], targets: SocialAccount['targets']): SocialAccount => ({ id, clientId: '', clientSecret: '', accessToken: 'a', refreshToken: '', expiresAt: 0, name: '', extra: { igUserId: 'IG' }, connectedAt: 0, targets });
  const img = (over: Partial<Creative>): Creative => ({ id: 'i1', productId: 'p1', format: 'square', template: 'split', headline: 'Glow', sub: '', badge: '', cta: '', seed: 1, caption: 'c', hashtags: [], status: 'approved', blobId: 'b', createdAt: now, decidedAt: now, ...over });
  const post = (over: Partial<Post>): Post => ({ id: 'po1', productId: 'p1', platform: 'facebook', title: 't', body: 'b', hashtags: [], scheduledFor: now - 1, status: 'approved', createdAt: now, decidedAt: now, ...over });
  const data = (over: Partial<Data>): Data => ({ products: [], videos: [], posts: [], leads: [], messages: [], campaigns: [], activity: [], knowledge: [], accounts: [], publications: [], images: [], settings: [], ...over });
  const on = { auto: true, formats: [], since: now - 10, images: true, posts: true };

  it('queues approved images in shapes the platform takes, and only approved posts whose time has come', () => {
    const d = data({
      accounts: [acc('meta', { instagram: on, facebook: on }), acc('telegram', { telegram: { ...on, posts: false } })],
      images: [img({}), img({ id: 'i2', format: 'story' }), img({ id: 'i3', status: 'pending' }), img({ id: 'i4', decidedAt: now - 100 })],
      posts: [post({}), post({ id: 'po2', scheduledFor: now + 1000 }), post({ id: 'po3', status: 'pending' }), post({ id: 'po4', platform: 'email' }), post({ id: 'po5', videoId: 'v1' })],
    });
    const plan = planPublications(d, now).map((p) => `${p.kind}:${p.itemId}>${p.target}`).sort();
    expect(plan).toEqual(['image:i1>facebook', 'image:i1>instagram', 'image:i1>telegram', 'image:i2>facebook', 'image:i2>telegram', 'post:po1>facebook']);
  });
  it('never queues the same item twice for one platform', () => {
    const d = data({ accounts: [acc('meta', { facebook: on })], images: [img({})], publications: [{ id: 'x', kind: 'image', videoId: '', itemId: 'i1', target: 'facebook', status: 'posted', attempts: 1, createdAt: now }] });
    expect(planPublications(d, now)).toEqual([]);
  });
  it('fits Threads and Pinterest text rules', () => {
    const long = { title: 'Glow', caption: 'word '.repeat(200), hashtags: ['#a', '#b', '#c', '#d'], format: 'square' };
    expect(textFor('threads', long, 'Glow', DEFAULT_SETTINGS).text.length).toBeLessThanOrEqual(490);
    expect(textFor('pinterest', long, 'Glow', DEFAULT_SETTINGS).text.length).toBeLessThanOrEqual(490);
  });
});
