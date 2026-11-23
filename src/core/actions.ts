/** Owner- and autopilot-level operations built on the encrypted store. */
import { cancelRender, pumpQueue } from '../video/queue';
import { newCreative, pumpPosters } from '../video/poster';
import { applyReference, targetFor } from '../video/reference';
import { aiCopy, aiLeadMessage } from './agents';
import { aiModels } from './ai';
import { newVideo, planAutopilot } from './autopilot';
import { buildCopy, buildLeadMessage } from './copy';
import { scoreLead } from './leads';
import { emitEvent } from './events';
import { runPublisher } from './publisher';
import { delBlob, getOne, getSnapshot, log, patch, put, putBlob, remove } from './store';
import { uid, type Lang, type Lead, type Presenter, type Message, type MusicMood, type Platform, type Post, type ReferenceLook, type Video, type VideoFormat, type VideoStyle } from './types';

let busy = false;
export async function runAutopilot(): Promise<{ videos: number; posts: number; messages: number }> {
  const none = { videos: 0, posts: 0, messages: 0 };
  if (busy) return none;
  const snap = getSnapshot();
  if (snap.status !== 'unlocked') return none;
  busy = true;
  try {
    const plan = planAutopilot(snap.data, snap.settings);
    for (const s of plan.scores) await patch('leads', s.id, { score: s.score });
    for (const v of plan.videos) await put('videos', v);
    for (const im of plan.images) {
      const product = getOne('products', im.productId);
      if (product) await put('images', newCreative(product, snap.settings, im.format));
    }
    // Hand the drafts to the AI agents when the owner's AI engine is running; otherwise keep the template text.
    const model = plan.posts.length + plan.messages.length > 0 ? await agentModel() : null;
    for (const p of plan.posts) {
      const product = getOne('products', p.productId);
      if (model && snap.settings.ai.agents.posts && product) {
        try { Object.assign(p, await aiCopy(model, product, snap.settings, p.platform, p, snap.data.knowledge)); } catch { /* keep template */ }
      }
      await put('posts', p);
    }
    for (const m of plan.messages) {
      const lead = getOne('leads', m.leadId);
      if (model && snap.settings.ai.agents.leads && lead) {
        try { Object.assign(m, await aiLeadMessage(model, lead, getOne('products', lead.productId), snap.settings, m.reason, m, snap.data.knowledge)); } catch { /* keep template */ }
      }
      await put('messages', m);
    }
    if (model && plan.posts.length + plan.messages.length > 0) await log('auto', `AI agents wrote ${plan.posts.length} post(s) and ${plan.messages.length} lead message(s) using ${model}.`);
    const made = { videos: plan.videos.length, posts: plan.posts.length, messages: plan.messages.length };
    if (made.videos + made.posts + made.messages > 0) {
      await log('auto', `Autopilot prepared ${made.videos} video(s) for your approval, plus ${made.posts} post(s) and ${made.messages} lead message(s).`);
    }
    void pumpQueue();
    if (plan.images.length) void pumpPosters().catch(() => {});
    void runPublisher();
    return made;
  } finally {
    busy = false;
  }
}

/** The model the agents should use, or null when AI is switched off or the engine is not running. */
export async function agentModel(): Promise<string | null> {
  const ai = getSnapshot().settings.ai;
  if (!ai.enabled) return null;
  const models = await aiModels();
  if (!models?.length) return null;
  return models.includes(ai.model) ? ai.model : models[0];
}

export function pendingCounts() {
  const d = getSnapshot().data;
  const videos = d.videos.filter((v) => v.status === 'pending').length;
  const posts = d.posts.filter((p) => p.status === 'pending').length;
  const messages = d.messages.filter((m) => m.status === 'pending').length;
  const images = d.images.filter((c) => c.status === 'pending').length;
  return { videos, posts, messages, images, total: videos + posts + messages + images };
}

const textStatus = () => (getSnapshot().settings.approvals === 'all' ? 'pending' : 'approved') as 'pending' | 'approved';
const name = (productId?: string) => getOne('products', productId)?.name ?? 'product';

// ----- videos -----
export async function createVideo(productId: string, format: VideoFormat, style?: VideoStyle, mood?: MusicMood, lang?: Lang, more: { seconds?: number; presenter?: Presenter; voice?: boolean } = {}) {
  const p = getOne('products', productId);
  if (!p) return;
  await put('videos', newVideo(p, getSnapshot().settings, format, { style, mood, lang, ...more }));
  void pumpQueue();
}

/** Creates a video for a product in the style of a reference video the owner uploaded. It waits for approval like every video. */
export async function createVideoFromReference(productId: string, ref: ReferenceLook, opts: { format?: VideoFormat; useColors: boolean; style?: VideoStyle; mood?: MusicMood; lang?: Lang; presenter?: Presenter; voice?: boolean }): Promise<string | null> {
  const p = getOne('products', productId);
  if (!p) return null;
  const base = newVideo(p, getSnapshot().settings, opts.format ?? ref.format, { lang: opts.lang, seconds: targetFor(ref), presenter: opts.presenter, voice: opts.voice });
  const v = applyReference(base, ref, { useColors: opts.useColors, style: opts.style, mood: opts.mood });
  await put('videos', v);
  void pumpQueue();
  return v.id;
}
export async function decideVideo(id: string, approve: boolean, note = '') {
  const v = getOne('videos', id);
  if (!v) return;
  await patch('videos', id, { status: approve ? 'approved' : 'rejected', decidedAt: Date.now(), note });
  await log('owner', `${approve ? 'Approved' : 'Rejected'} video for ${name(v.productId)} (${v.format}).`);
  emitEvent(approve ? 'video.approved' : 'video.rejected', { videoId: id, product: name(v.productId), shape: v.format });
  if (approve) void runPublisher();
}
/** Renders the same video again (after script edits) or a fresh variation. */
export async function rerenderVideo(v: Video, fresh: boolean) {
  if (v.source === 'upload') return; // an uploaded recording is never re-created by the app
  await delBlob(v.blobId);
  await delBlob(v.thumbId);
  let next: Video = { ...v, status: 'queued', blobId: undefined, thumbId: undefined, progress: undefined, error: undefined, decidedAt: undefined, createdAt: Date.now() };
  if (fresh) {
    const p = getOne('products', v.productId);
    if (p) {
      next = { ...newVideo(p, getSnapshot().settings, v.format, { lang: v.lang, style: v.style, mood: v.mood, seconds: v.targetSeconds, presenter: v.presenter, voice: v.voice }), id: v.id };
      // A fresh version of a reference-styled video keeps the reference's rhythm and colours.
      if (v.reference) next = { ...applyReference(next, v.reference, { useColors: !!v.colors, style: v.style, mood: v.mood }), id: v.id };
    }
  }
  await put('videos', next);
  void pumpQueue();
}
export async function deleteVideo(id: string) {
  const v = getOne('videos', id);
  if (!v) return;
  cancelRender(id);
  await delBlob(v.blobId);
  await delBlob(v.thumbId);
  for (const p of getSnapshot().data.publications.filter((x) => x.videoId === id)) await remove('publications', p.id);
  await remove('videos', id);
}

/**
 * Adds the owner's own recording. The file is stored encrypted exactly as uploaded; the app writes
 * the caption, title and hashtags, then the video waits for approval like every other video.
 */
export async function addUploadedVideo(input: { productId: string; bytes: ArrayBuffer; mime: string; format: VideoFormat; seconds: number; width: number; height: number; thumb: ArrayBuffer | null }, onProgress?: (fraction: number) => void): Promise<string | null> {
  const p = getOne('products', input.productId);
  if (!p) return null;
  const snap = getSnapshot();
  const seed = Math.floor(Math.random() * 2 ** 31);
  let copy = buildCopy(p, snap.settings, input.format === 'wide' ? 'youtube' : 'instagram', seed);
  if (snap.settings.ai.agents.posts) {
    const model = await agentModel();
    if (model) {
      try { copy = await aiCopy(model, p, snap.settings, input.format === 'wide' ? 'youtube' : 'instagram', copy, snap.data.knowledge); } catch { /* keep template */ }
    }
  }
  const blobId = await putBlob(input.bytes, undefined, onProgress);
  const thumbId = input.thumb ? await putBlob(input.thumb) : undefined;
  const size = input.width && input.height ? ` ${input.width}×${input.height}` : '';
  const video: Video = {
    id: uid(), productId: p.id, format: input.format, lang: 'en', source: 'upload', style: 'clean', mood: 'none', seed, script: [],
    title: input.format === 'wide' ? copy.title : p.name, caption: copy.body, hashtags: copy.hashtags,
    status: 'pending', blobId, thumbId, mime: input.mime, sizeBytes: input.bytes.byteLength, seconds: input.seconds || undefined,
    codec: `Your recording (${input.mime === 'video/quicktime' ? 'MOV' : 'MP4'}${size})`, createdAt: Date.now(),
  };
  await put('videos', video);
  await log('owner', `Uploaded a video for ${p.name}; caption written, waiting for approval.`);
  return video.id;
}

// ----- products -----
export async function deleteProduct(id: string) {
  const p = getOne('products', id);
  if (!p) return;
  const d = getSnapshot().data;
  for (const v of d.videos.filter((x) => x.productId === id)) await deleteVideo(v.id);
  for (const x of d.posts.filter((x) => x.productId === id)) await remove('posts', x.id);
  for (const c of d.images.filter((x) => x.productId === id)) await deleteCreative(c.id);
  for (const img of p.imageIds) await delBlob(img);
  await remove('products', id);
  await log('owner', `Deleted product ${p.name}.`);
}

// ----- image posts -----
export async function decideCreative(id: string, approve: boolean) {
  const c = getOne('images', id);
  if (!c) return;
  await patch('images', id, { status: approve ? 'approved' : 'rejected', decidedAt: Date.now() });
  await log('owner', `${approve ? 'Approved' : 'Rejected'} an image post for ${name(c.productId)}.`);
}
export async function deleteCreative(id: string) {
  const c = getOne('images', id);
  if (!c) return;
  await delBlob(c.blobId);
  await remove('images', id);
}

// ----- posts -----
export async function createPost(productId: string, platform: Platform, when: number) {
  const p = getOne('products', productId);
  if (!p) return;
  const copy = buildCopy(p, getSnapshot().settings, platform, Math.floor(Math.random() * 1e9));
  const video = getSnapshot().data.videos.find((v) => v.productId === productId && v.status === 'approved' && v.format === (platform === 'youtube' ? 'wide' : 'reel'));
  const post: Post = { id: uid(), productId, platform, title: copy.title, body: copy.body, hashtags: copy.hashtags, scheduledFor: when, status: 'pending', videoId: video?.id, createdAt: Date.now() };
  await put('posts', post);
}
export async function decidePost(id: string, approve: boolean) {
  const p = getOne('posts', id);
  if (!p) return;
  await patch('posts', id, { status: approve ? 'approved' : 'rejected', decidedAt: Date.now() });
  await log('owner', `${approve ? 'Approved' : 'Rejected'} ${p.platform} post for ${name(p.productId)}.`);
}

// ----- leads -----
export async function saveLead(lead: Lead) {
  const isNew = !getOne('leads', lead.id);
  await put('leads', { ...lead, score: scoreLead(lead) });
  // Contact details stay on the PC: the event carries no name, phone or email.
  if (isNew) emitEvent('lead.created', { leadId: lead.id, source: lead.source, product: lead.productId ? name(lead.productId) : '', consent: lead.consent });
}
export async function deleteLead(id: string) {
  for (const m of getSnapshot().data.messages.filter((m) => m.leadId === id)) await remove('messages', m.id);
  await remove('leads', id);
}
export async function draftMessage(leadId: string, reason: Message['reason']) {
  const l = getOne('leads', leadId);
  if (!l) return;
  const text = buildLeadMessage(l, getOne('products', l.productId), getSnapshot().settings, reason, Date.now());
  await put('messages', { id: uid(), leadId, channel: l.phone.trim() ? 'whatsapp' : 'email', reason, subject: text.subject, body: text.body, status: textStatus(), createdAt: Date.now() });
}
export async function decideMessage(id: string, approve: boolean) {
  const m = getOne('messages', id);
  if (!m) return;
  await patch('messages', id, { status: approve ? 'approved' : 'rejected', decidedAt: Date.now() });
  await log('owner', `${approve ? 'Approved' : 'Rejected'} message to ${getOne('leads', m.leadId)?.name || 'lead'}.`);
}
export async function markMessageSent(id: string) {
  const m = getOne('messages', id);
  if (!m) return;
  await patch('messages', id, { status: 'sent' });
  const l = getOne('leads', m.leadId);
  if (l) await saveLead({ ...l, lastContactAt: Date.now(), stage: l.stage === 'new' ? 'contacted' : l.stage });
}

/** Link that opens the owner's own mail / messaging app with the approved text filled in. */
export function messageLink(m: Message, lead: Lead): string {
  const body = encodeURIComponent(m.body);
  if (m.channel === 'email') return `mailto:${encodeURIComponent(lead.email)}?subject=${encodeURIComponent(m.subject)}&body=${body}`;
  const digits = lead.phone.replace(/[^\d+]/g, '');
  if (m.channel === 'sms') return `sms:${digits}?body=${body}`;
  return `https://wa.me/${digits.replace(/\D/g, '')}?text=${body}`;
}
