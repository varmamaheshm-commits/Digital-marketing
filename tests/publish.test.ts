import { createRequire } from 'node:module';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dueForRetry, planPublications, postText } from '../src/core/publisher';
import type { Data } from '../src/core/store';
import { DEFAULT_SETTINGS, type SocialAccount, type Video } from '../src/core/types';

const require = createRequire(import.meta.url);
const social = require('../electron/publish.cjs');
const { startMockPlatforms } = require('./mock-platforms.cjs');

let mock: any;
let deps: any;
const video = Buffer.alloc(9 * 1024 * 1024 + 123, 7); // ~9 MB so chunked paths are exercised
const job = { video, title: 'Glow Serum | Skincare', text: 'Your new favourite just arrived.\n\n#GlowSerum', tags: ['GlowSerum'], format: 'reel' };
const meta = { accessToken: 'm-long', expiresAt: 0, extra: { pageId: 'PG1', pageToken: 'page-token', igUserId: 'IG1' } };
const calls = (path: string) => mock.log.filter((r: any) => r.path === path);

beforeAll(async () => {
  mock = await startMockPlatforms();
  deps = { endpoints: mock.endpoints, allowHost: (u: string) => new URL(u).hostname === '127.0.0.1', sleep: async () => {} };
});
afterAll(() => mock.close());
beforeEach(() => { mock.log.length = 0; Object.assign(mock.state, { igPolls: 0, liPosts: 0, xPolls: 0 }); });

describe('connecting accounts (OAuth)', () => {
  const browser = (url: string) => fetch(url).then(() => {});
  it('YouTube: signs in with PKCE and stores a refresh token', async () => {
    const acc = await social.connect('google', { clientId: 'cid', clientSecret: 'sec' }, browser, deps);
    expect(acc).toMatchObject({ accessToken: 'g-access', refreshToken: 'g-refresh', name: 'Glow Naturals Channel' });
    const auth = calls('/g/auth')[0].query;
    expect(auth.code_challenge_method).toBe('S256');
    expect(auth.redirect_uri).toBe('http://127.0.0.1:53682/oauth');
    expect(auth.scope).toContain('youtube.upload');
    expect(new URLSearchParams(calls('/g/token')[0].text).get('code_verifier')).toBeTruthy();
  });
  it('Meta: upgrades to long-term access and lists Pages with their Instagram accounts', async () => {
    const acc = await social.connect('meta', { clientId: 'app', clientSecret: 'sec' }, browser, deps);
    expect(acc.extra.pages).toHaveLength(2);
    expect(acc.extra).toMatchObject({ pageId: 'PG1', pageToken: 'page-token', igUserId: 'IG1', igName: 'glownaturals' });
    expect(calls('/m/graph/me/accounts')[0].query.access_token).toBe('m-long');
  });
  it('LinkedIn and X: read the profile to post as', async () => {
    const li = await social.connect('linkedin', { clientId: 'cid', clientSecret: 'sec' }, browser, deps);
    expect(li.extra.author).toBe('urn:li:person:abc123');
    const org = await social.connect('linkedin', { clientId: 'cid', clientSecret: 'sec', organizationId: '5551' }, browser, deps);
    expect(org.extra.author).toBe('urn:li:organization:5551');
    expect(calls('/l/auth')[1].query.scope).toContain('w_organization_social');
    const x = await social.connect('x', { clientId: 'cid', clientSecret: '' }, browser, deps);
    expect(x).toMatchObject({ name: '@glownaturals', refreshToken: 'x-refresh' });
    expect(calls('/x/auth')[0].query.scope).toContain('media.write');
  });
  it('rejects a sign-in answer that does not belong to this request', async () => {
    const forged = (url: string) => fetch(`http://127.0.0.1:53682/oauth?code=stolen&state=wrong`).then(() => {}, () => {}).then(() => void url);
    await expect(social.connect('google', { clientId: 'cid', clientSecret: 's' }, forged, deps)).rejects.toThrow(/did not match|cancelled/);
    expect(calls('/g/token')).toHaveLength(0);
  });
});

describe('posting a video', () => {
  it('YouTube: resumable upload with title, description and privacy', async () => {
    const res = await social.publish('youtube', { accessToken: 'g-access', expiresAt: Date.now() + 3.6e6, extra: { privacy: 'unlisted' } }, job, deps);
    expect(res).toMatchObject({ ok: true, id: 'yt123', url: 'https://www.youtube.com/watch?v=yt123' });
    const start = calls('/g/upload')[0];
    expect(start.headers.authorization).toBe('Bearer g-access');
    expect(start.headers['x-upload-content-length']).toBe(String(video.length));
    expect(JSON.parse(start.text)).toMatchObject({ snippet: { title: 'Glow Serum | Skincare' }, status: { privacyStatus: 'unlisted' } });
    expect(calls('/g/session/abc')[0].size).toBe(video.length);
  });
  it('accepts the file the way the app hands it over (ArrayBuffer / typed array)', async () => {
    const ab = new Uint8Array(1000).fill(3).buffer;
    for (const v of [ab, new Uint8Array(ab)]) {
      mock.log.length = 0;
      const res = await social.publish('youtube', { accessToken: 'g-access', expiresAt: Date.now() + 3.6e6, extra: {} }, { ...job, video: v }, deps);
      expect(res.ok).toBe(true);
      expect(calls('/g/session/abc')[0].size).toBe(1000);
    }
    expect((await social.publish('youtube', { accessToken: 't', extra: {} }, { ...job, video: new ArrayBuffer(0) }, deps)).error).toMatch(/empty/);
  });
  it('YouTube: renews expired access first and hands the new token back', async () => {
    const res = await social.publish('youtube', { accessToken: 'old', refreshToken: 'g-refresh', clientId: 'cid', clientSecret: 'sec', expiresAt: Date.now() - 1000, extra: {} }, job, deps);
    expect(res.ok).toBe(true);
    expect(res.tokens.accessToken).toBe('g-access-2');
    expect(calls('/g/upload')[0].headers.authorization).toBe('Bearer g-access-2');
  });
  it('Instagram: container → upload → wait for processing → publish', async () => {
    const res = await social.publish('instagram', meta, job, deps);
    expect(res).toMatchObject({ ok: true, id: 'igm1', url: 'https://www.instagram.com/reel/ABC/' });
    const box = new URLSearchParams(calls('/m/graph/IG1/media')[0].text);
    expect(box.get('media_type')).toBe('REELS');
    expect(box.get('upload_type')).toBe('resumable');
    const up = calls('/m/rupload/ig/c1')[0];
    expect(up.size).toBe(video.length);
    expect(up.headers).toMatchObject({ authorization: 'OAuth page-token', offset: '0', file_size: String(video.length) });
    expect(calls('/m/graph/c1')).toHaveLength(2);
    expect(new URLSearchParams(calls('/m/graph/IG1/media_publish')[0].text).get('creation_id')).toBe('c1');
  });
  it('Facebook: vertical videos go out as a Reel, others as a Page video', async () => {
    const reel = await social.publish('facebook', meta, job, deps);
    expect(reel).toMatchObject({ ok: true, url: 'https://www.facebook.com/reel/v1' });
    const phases = calls('/m/graph/PG1/video_reels').map((r: any) => new URLSearchParams(r.text));
    expect(phases.map((p: any) => p.get('upload_phase'))).toEqual(['start', 'finish']);
    expect(phases[1].get('video_state')).toBe('PUBLISHED');
    expect(calls('/m/rupload/fb/v1')[0].size).toBe(video.length);
    const wide = await social.publish('facebook', meta, { ...job, format: 'wide' }, deps);
    expect(wide).toMatchObject({ ok: true, id: 'fbv9' });
    expect(calls('/m/gv/PG1/videos')[0].size).toBeGreaterThan(video.length);
  });
  it('LinkedIn: uploads in parts, finalises with their IDs in order, waits until the video is ready', async () => {
    const res = await social.publish('linkedin', { accessToken: 'l-access', expiresAt: Date.now() + 1e9, extra: { author: 'urn:li:person:abc123' } }, job, deps);
    expect(res).toMatchObject({ ok: true, url: 'https://www.linkedin.com/feed/update/urn:li:share:777' });
    expect(calls('/l/up/0')[0].size + calls('/l/up/1')[0].size).toBe(video.length);
    const fin = mock.log.find((r: any) => r.query.action === 'finalizeUpload');
    expect(JSON.parse(fin.text).finalizeUploadRequest).toMatchObject({ video: 'urn:li:video:V1', uploadedPartIds: ['etag-0', 'etag-1'] });
    expect(fin.headers['linkedin-version']).toBe('202606');
    expect(calls('/l/api/rest/posts')).toHaveLength(2);
    expect(JSON.parse(calls('/l/api/rest/posts')[1].text)).toMatchObject({ author: 'urn:li:person:abc123', content: { media: { id: 'urn:li:video:V1' } }, lifecycleState: 'PUBLISHED' });
  });
  it('X: chunked upload, waits for processing, then posts with the media attached', async () => {
    const res = await social.publish('x', { accessToken: 'x-access', expiresAt: Date.now() + 1e9, extra: {} }, { ...job, text: 'x'.repeat(400) }, deps);
    expect(res).toMatchObject({ ok: true, url: 'https://x.com/i/status/999' });
    expect(JSON.parse(calls('/x/api/2/media/upload/initialize')[0].text)).toEqual({ media_type: 'video/mp4', total_bytes: video.length, media_category: 'tweet_video' });
    expect(calls('/x/api/2/media/upload/M1/append')).toHaveLength(3);
    expect(calls('/x/api/2/media/upload')).toHaveLength(2);
    const post = JSON.parse(calls('/x/api/2/tweets')[0].text);
    expect(post.media.media_ids).toEqual(['M1']);
    expect(post.text.length).toBeLessThanOrEqual(270);
  });
});

describe('safety', () => {
  it('only ever contacts the platforms’ own secure addresses', async () => {
    expect(social.productionHost('https://rupload.facebook.com/ig-api-upload/v25.0/1')).toBe(true);
    expect(social.productionHost('https://api.x.com/2/tweets')).toBe(true);
    expect(social.productionHost('https://facebook.com.evil.example/')).toBe(false);
    expect(social.productionHost('http://graph.facebook.com/')).toBe(false);
    // With production rules, an upload address pointing anywhere else is refused before any data is sent.
    const res = await social.publish('youtube', { accessToken: 't', expiresAt: Date.now() + 1e9, extra: {} }, job, { endpoints: mock.endpoints });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Blocked/);
    expect(mock.log).toHaveLength(0);
  });
  it('reports refusals in plain words, without the access key, and marks only temporary failures for retry', async () => {
    const denied = await social.publish('x', { accessToken: 'SECRET-TOKEN', expiresAt: Date.now() + 1e9, extra: {} }, job, { ...deps, endpoints: { ...mock.endpoints, x: { ...mock.endpoints.x, api: mock.base + '/fail/api' } } });
    expect(denied).toMatchObject({ ok: false, retryable: false });
    expect(denied.error).toContain('Your plan does not include this endpoint');
    expect(denied.error).not.toContain('SECRET-TOKEN');
    const busy = await social.publish('youtube', { accessToken: 't', expiresAt: Date.now() + 1e9, extra: {} }, job, { ...deps, endpoints: { ...mock.endpoints, google: { ...mock.endpoints.google, upload: mock.base + '/busy/upload' } } });
    expect(busy).toMatchObject({ ok: false, retryable: true });
    expect((await social.publish('instagram', { accessToken: 't', extra: { pageId: 'PG2', pageToken: 'p' } }, job, deps)).error).toMatch(/no Instagram/);
    expect((await social.publish('youtube', { accessToken: '' }, job, deps)).error).toMatch(/not connected/);
  });
});

describe('publisher agent planning', () => {
  const now = 1_800_000_000_000;
  const v = (over: Partial<Video>): Video => ({ id: 'v1', productId: 'p1', format: 'reel', style: 'bold', mood: 'upbeat', seed: 1, script: [], caption: 'First paragraph about the serum.\n\nSecond paragraph.', hashtags: ['#GlowSerum', '#Skincare', '#ShopNow', '#MustHave'], title: 'Glow Serum | Skincare | ₹499', status: 'approved', blobId: 'b', createdAt: now, decidedAt: now, ...over });
  const account = (id: SocialAccount['id'], targets: SocialAccount['targets'], extra = {}): SocialAccount => ({ id, clientId: '', clientSecret: '', accessToken: 't', refreshToken: '', expiresAt: 0, name: '', extra, connectedAt: now - 1000, targets });
  const data = (over: Partial<Data>): Data => ({ products: [], videos: [], posts: [], leads: [], messages: [], campaigns: [], activity: [], knowledge: [], accounts: [], publications: [], settings: [], ...over });
  const on = (formats: any) => ({ auto: true, formats, since: now - 500 });

  it('posts only approved videos, only where auto-post is on, only matching shapes, and only once', () => {
    const d = data({
      videos: [v({ id: 'ok' }), v({ id: 'pending', status: 'pending' }), v({ id: 'rejected', status: 'rejected' }), v({ id: 'old', decidedAt: now - 9999 }), v({ id: 'wide', format: 'wide' })],
      accounts: [account('google', { youtube: on(['reel', 'wide']) }), account('meta', { instagram: on(['reel']), facebook: { auto: false, formats: ['reel'], since: 0 } }, { igUserId: 'IG1' }), account('x', { x: on(['wide']) })],
    });
    const plan = planPublications(d, now).map((p) => `${p.target}:${p.videoId}`).sort();
    expect(plan).toEqual(['instagram:ok', 'x:wide', 'youtube:ok', 'youtube:wide']);
    const again = planPublications({ ...d, publications: planPublications(d, now) }, now);
    expect(again).toHaveLength(0);
  });
  it('skips Instagram when the Page has no Instagram account, and retries only temporary failures', () => {
    const d = data({ videos: [v({})], accounts: [account('meta', { instagram: on(['reel']) })] });
    expect(planPublications(d, now)).toHaveLength(0);
    const p = { id: 'p', videoId: 'v1', target: 'x' as const, status: 'failed' as const, attempts: 1, createdAt: now, triedAt: now };
    expect(dueForRetry({ ...p, retryable: true }, now + 16 * 60_000)).toBe(true);
    expect(dueForRetry({ ...p, retryable: true }, now + 60_000)).toBe(false);
    expect(dueForRetry({ ...p, retryable: false }, now + 16 * 60_000)).toBe(false);
    expect(dueForRetry({ ...p, retryable: true, attempts: 3 }, now + 16 * 60_000)).toBe(false);
  });
  it('fits each platform’s text rules', () => {
    const s = { ...DEFAULT_SETTINGS, business: { ...DEFAULT_SETTINGS.business, name: 'Glow Naturals', phone: '+91 98765 43210' } };
    const x = postText('x', v({ caption: 'A'.repeat(500) }), 'Glow Serum', s);
    expect(x.text.length).toBeLessThanOrEqual(280);
    expect(x.text).toContain('#GlowSerum');
    expect(postText('youtube', v({}), 'Glow Serum', s).title).toBe('Glow Serum | Glow Naturals #Shorts');
    expect(postText('youtube', v({ format: 'wide' }), 'Glow Serum', s).title).toBe('Glow Serum | Skincare | ₹499');
    expect(postText('instagram', v({}), 'Glow Serum', s).text).toContain('#MustHave');
  });
});
