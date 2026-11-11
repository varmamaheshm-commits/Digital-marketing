/**
 * Autopilot: decides what marketing work should exist and creates it as drafts.
 * It never publishes or sends anything — every item it creates starts as
 * `queued`/`pending` and waits for the owner's approval.
 */
import { buildCopy, buildLeadMessage, buildScript, rng } from './copy';
import { scoreLead } from './leads';
import type { Data } from './store';
import { uid, type Message, type MusicMood, type Platform, type Post, type Product, type Settings, type Video, type VideoFormat, type VideoStyle } from './types';

const DAY = 86_400_000;
const STYLES: VideoStyle[] = ['bold', 'clean', 'luxe'];
const MOOD_FOR: Record<VideoStyle, MusicMood> = { bold: 'upbeat', clean: 'chill', luxe: 'cinematic' };
const POST_PLATFORMS: Platform[] = ['instagram', 'facebook', 'youtube', 'whatsapp', 'email', 'ad'];
const POST_HOURS = [10, 13, 18, 20];

export function newVideo(p: Product, s: Settings, format: VideoFormat, opts: { style?: VideoStyle; mood?: MusicMood; seed?: number } = {}): Video {
  const seed = opts.seed ?? Math.floor(Math.random() * 2 ** 31);
  const r = rng(seed);
  const style = opts.style ?? (s.autopilot.videoStyle === 'auto' ? (s.tone === 'luxury' ? 'luxe' : STYLES[Math.floor(r() * 3)]) : s.autopilot.videoStyle);
  const mood = opts.mood ?? (s.autopilot.mood === 'auto' ? MOOD_FOR[style] : s.autopilot.mood);
  const copy = buildCopy(p, s, format === 'wide' ? 'youtube' : 'instagram', seed);
  return {
    id: uid(), productId: p.id, format, style, mood, seed,
    script: buildScript(p, s, seed),
    title: format === 'wide' ? copy.title : p.name,
    caption: copy.body, hashtags: copy.hashtags,
    status: 'queued', createdAt: Date.now(),
  };
}

export interface Plan {
  videos: Video[];
  posts: Post[];
  messages: Message[];
  scores: { id: string; score: number }[];
}

export function planAutopilot(data: Data, s: Settings, now = Date.now()): Plan {
  const plan: Plan = { videos: [], posts: [], messages: [], scores: [] };
  for (const l of data.leads) {
    const score = scoreLead(l, now);
    if (score !== l.score) plan.scores.push({ id: l.id, score });
  }
  if (!s.autopilot.enabled) return plan;
  const products = data.products.filter((p) => p.active);

  // 1. Videos: one fresh video per active product and format.
  for (const p of products) {
    for (const format of s.autopilot.videoFormats) {
      const mine = data.videos.filter((v) => v.productId === p.id && v.format === format && v.status !== 'failed');
      const inFlight = mine.some((v) => v.status === 'queued' || v.status === 'rendering' || v.status === 'pending');
      const recent = mine.some((v) => now - v.createdAt < s.autopilot.videoRefreshDays * DAY);
      if (!inFlight && !recent) plan.videos.push(newVideo(p, s, format));
    }
  }

  // 2. Content calendar: keep the coming 7 days filled.
  if (products.length && s.autopilot.postsPerWeek > 0) {
    const upcoming = data.posts.filter((x) => x.status !== 'rejected' && x.scheduledFor > now && x.scheduledFor <= now + 7 * DAY);
    const missing = Math.max(0, Math.min(21, s.autopilot.postsPerWeek) - upcoming.length);
    const total = data.posts.length;
    for (let i = 0; i < missing; i++) {
      const n = total + i;
      const p = products[n % products.length];
      const platform = POST_PLATFORMS[n % POST_PLATFORMS.length];
      const when = new Date(now + (1 + Math.floor((i * 7) / Math.max(1, missing))) * DAY);
      when.setHours(POST_HOURS[n % POST_HOURS.length], 0, 0, 0);
      const copy = buildCopy(p, s, platform, n * 7919 + 13);
      const wanted: VideoFormat = platform === 'youtube' ? 'wide' : 'reel';
      const video = data.videos.find((v) => v.productId === p.id && v.status === 'approved' && v.format === wanted);
      plan.posts.push({
        id: uid(), productId: p.id, platform, title: copy.title, body: copy.body, hashtags: copy.hashtags,
        scheduledFor: when.getTime(), status: 'pending', videoId: video?.id, createdAt: now,
      });
    }
  }

  // 3. Lead follow-ups (only for people who agreed to be contacted).
  for (const l of data.leads) {
    if (!l.consent || l.stage === 'won' || l.stage === 'lost') continue;
    if (!l.phone.trim() && !l.email.trim()) continue;
    const mine = data.messages.filter((m) => m.leadId === l.id);
    if (mine.some((m) => m.status === 'pending' || m.status === 'approved')) continue;
    const product = data.products.find((p) => p.id === l.productId);
    const channel: Message['channel'] = l.phone.trim() ? 'whatsapp' : 'email';
    let reason: Message['reason'] | null = null;
    if (mine.length === 0) reason = 'welcome';
    else if (mine.length < 4 && now - (l.lastContactAt ?? l.createdAt) > s.autopilot.followUpDays * DAY) {
      reason = mine.length === 2 && product?.offer ? 'offer' : 'follow-up';
    }
    if (!reason) continue;
    const text = buildLeadMessage(l, product, s, reason, l.createdAt + mine.length);
    plan.messages.push({ id: uid(), leadId: l.id, channel, reason, subject: text.subject, body: text.body, status: 'pending', createdAt: now });
  }
  return plan;
}
