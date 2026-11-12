/**
 * Publisher agent: posts APPROVED videos to the connected platforms.
 * The actual upload happens in the desktop app's main process (see electron/publish.cjs);
 * this module decides what to post, keeps the record, and never sends an unapproved video.
 */
import type { Data } from './store';
import { getBlob, getOne, getSnapshot, log, patch, put } from './store';
import { TARGET_INFO, uid, type Publication, type Settings, type SocialAccount, type SocialProvider, type SocialTarget, type Video } from './types';

export interface DesktopSocial {
  connect: (provider: SocialProvider, creds: { clientId: string; clientSecret: string; organizationId?: string }) => Promise<{ ok: boolean; error?: string; account?: Partial<SocialAccount> }>;
  publish: (target: SocialTarget, account: SocialAccount, job: { video: ArrayBuffer; title: string; text: string; tags: string[]; format: string }) => Promise<{ ok: boolean; url?: string; id?: string; error?: string; retryable?: boolean; tokens?: Partial<SocialAccount> }>;
}
export const desktopSocial = (): DesktopSocial | undefined => (globalThis as any).desktop?.social;

const clip = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…');

/** The title, text and tags used on each platform (each has its own limits and habits). */
export function postText(target: SocialTarget, v: Video, productName: string, s: Settings): { title: string; text: string; tags: string[] } {
  const tags = v.hashtags.map((t) => t.replace(/^#/, ''));
  const caption = v.caption.trim();
  if (target === 'youtube') {
    const title = v.format === 'wide' ? v.title || productName : `${productName}${s.business.name ? ' | ' + s.business.name : ''} #Shorts`;
    return { title: clip(title, 100), text: [caption, v.hashtags.slice(0, 8).join(' ')].filter(Boolean).join('\n\n'), tags };
  }
  if (target === 'x') {
    const few = v.hashtags.slice(0, 3).join(' ');
    const first = caption.split(/\n\s*\n/)[0] || productName;
    const contact = s.business.phone || s.business.website;
    const base = [first, contact].filter(Boolean).join(' — ');
    return { title: productName, text: [clip(base, 268 - few.length), few].filter(Boolean).join('\n'), tags };
  }
  if (target === 'linkedin') return { title: productName, text: [caption, v.hashtags.slice(0, 5).join(' ')].filter(Boolean).join('\n\n'), tags };
  return { title: productName, text: [caption, v.hashtags.join(' ')].filter(Boolean).join('\n\n'), tags };
}

export const accountFor = (data: Data, target: SocialTarget): SocialAccount | undefined => {
  const a = data.accounts.find((x) => x.id === TARGET_INFO[target].provider);
  if (!a?.accessToken) return undefined;
  if (target === 'instagram' && !a.extra?.igUserId) return undefined;
  return a;
};

/** New posting jobs: every approved video × every destination with auto-post on, once. */
export function planPublications(data: Data, now = Date.now()): Publication[] {
  const out: Publication[] = [];
  for (const target of Object.keys(TARGET_INFO) as SocialTarget[]) {
    const acc = accountFor(data, target);
    const cfg = acc?.targets[target];
    if (!acc || !cfg?.auto) continue;
    for (const v of data.videos) {
      if (v.status !== 'approved' || !v.blobId || !cfg.formats.includes(v.format)) continue;
      if ((v.decidedAt ?? 0) < cfg.since) continue; // never back-post videos approved before auto-post was switched on
      if (data.publications.some((p) => p.videoId === v.id && p.target === target)) continue;
      out.push({ id: uid(), videoId: v.id, target, status: 'queued', attempts: 0, createdAt: now });
    }
  }
  return out;
}

const RETRY_AFTER = 15 * 60_000;
const MAX_ATTEMPTS = 3;
export const dueForRetry = (p: Publication, now = Date.now()) =>
  p.status === 'failed' && p.retryable === true && p.attempts < MAX_ATTEMPTS && now - (p.triedAt ?? 0) > RETRY_AFTER;

let running = false;

/** Queues a single video for one destination by hand (still only if it is approved). */
export async function postNow(videoId: string, target: SocialTarget) {
  const v = getOne('videos', videoId);
  if (!v || v.status !== 'approved') return;
  const old = getSnapshot().data.publications.find((p) => p.videoId === videoId && p.target === target);
  if (old?.status === 'posted' || old?.status === 'posting') return;
  await put('publications', { id: old?.id ?? uid(), videoId, target, status: 'queued', attempts: 0, createdAt: old?.createdAt ?? Date.now() });
  void runPublisher();
}

export async function runPublisher(): Promise<void> {
  const bridge = desktopSocial();
  if (running || !bridge || getSnapshot().status !== 'unlocked') return;
  running = true;
  try {
    for (const p of planPublications(getSnapshot().data)) await put('publications', p);
    for (;;) {
      const snap = getSnapshot();
      if (snap.status !== 'unlocked') break;
      const job = snap.data.publications.find((p) => p.status === 'queued') ?? snap.data.publications.find((p) => dueForRetry(p));
      if (!job) break;
      const label = TARGET_INFO[job.target].label;
      const v = getOne('videos', job.videoId);
      const acc = accountFor(snap.data, job.target);
      const fail = (error: string, retryable = false) => patch('publications', job.id, { status: 'failed', error, retryable, triedAt: Date.now(), attempts: job.attempts + 1 });
      // The approval rule is enforced again at the moment of sending.
      if (!v || v.status !== 'approved' || !v.blobId) { await fail('The video is no longer approved, so it was not posted.'); continue; }
      if (!acc) { await fail(`${label} is not connected.`); continue; }
      const bytes = await getBlob(v.blobId);
      if (!bytes) { await fail('The video file is missing.'); continue; }
      await patch('publications', job.id, { status: 'posting', triedAt: Date.now(), error: undefined });
      const product = getOne('products', v.productId);
      const text = postText(job.target, v, product?.name ?? 'Our product', snap.settings);
      let res: Awaited<ReturnType<DesktopSocial['publish']>>;
      try {
        res = await bridge.publish(job.target, acc, { video: bytes, ...text, format: v.format });
      } catch (e: any) {
        res = { ok: false, error: String(e?.message ?? e) };
      }
      if (getSnapshot().status !== 'unlocked') break;
      if (res.tokens) await patch('accounts', acc.id, res.tokens); // renewed access is kept (some platforms rotate it)
      if (res.ok) {
        await patch('publications', job.id, { status: 'posted', url: res.url, postedAt: Date.now(), attempts: job.attempts + 1, error: undefined });
        await log('auto', `Publisher agent posted the ${product?.name ?? ''} video to ${label}.`);
      } else {
        await fail(res.error ?? 'Unknown error.', res.retryable === true);
        await log('auto', `Posting to ${label} failed: ${res.error ?? 'unknown error'}`);
      }
    }
  } finally {
    running = false;
  }
}

/** A post cut off mid-upload (app closed) is not retried automatically, to avoid posting twice. */
export async function recoverPublications() {
  for (const p of getSnapshot().data.publications) {
    if (p.status === 'posting') {
      await patch('publications', p.id, { status: 'failed', retryable: false, attempts: MAX_ATTEMPTS, error: 'The app was closed while this was uploading. Check the platform before posting again, so it is not posted twice.' });
    }
  }
}
