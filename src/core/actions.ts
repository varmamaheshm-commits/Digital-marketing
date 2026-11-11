/** Owner- and autopilot-level operations built on the encrypted store. */
import { cancelRender, pumpQueue } from '../video/queue';
import { aiCopy, aiLeadMessage } from './agents';
import { aiModels } from './ai';
import { newVideo, planAutopilot } from './autopilot';
import { buildCopy, buildLeadMessage } from './copy';
import { scoreLead } from './leads';
import { delBlob, getOne, getSnapshot, log, patch, put, remove } from './store';
import { uid, type Lang, type Lead, type Message, type MusicMood, type Platform, type Post, type Video, type VideoFormat, type VideoStyle } from './types';

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
  return { videos, posts, messages, total: videos + posts + messages };
}

const textStatus = () => (getSnapshot().settings.approvals === 'all' ? 'pending' : 'approved') as 'pending' | 'approved';
const name = (productId?: string) => getOne('products', productId)?.name ?? 'product';

// ----- videos -----
export async function createVideo(productId: string, format: VideoFormat, style?: VideoStyle, mood?: MusicMood, lang?: Lang) {
  const p = getOne('products', productId);
  if (!p) return;
  await put('videos', newVideo(p, getSnapshot().settings, format, { style, mood, lang }));
  void pumpQueue();
}
export async function decideVideo(id: string, approve: boolean, note = '') {
  const v = getOne('videos', id);
  if (!v) return;
  await patch('videos', id, { status: approve ? 'approved' : 'rejected', decidedAt: Date.now(), note });
  await log('owner', `${approve ? 'Approved' : 'Rejected'} video for ${name(v.productId)} (${v.format}).`);
}
/** Renders the same video again (after script edits) or a fresh variation. */
export async function rerenderVideo(v: Video, fresh: boolean) {
  await delBlob(v.blobId);
  await delBlob(v.thumbId);
  let next: Video = { ...v, status: 'queued', blobId: undefined, thumbId: undefined, progress: undefined, error: undefined, decidedAt: undefined, createdAt: Date.now() };
  if (fresh) {
    const p = getOne('products', v.productId);
    if (p) next = { ...newVideo(p, getSnapshot().settings, v.format, { lang: v.lang }), id: v.id };
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
  await remove('videos', id);
}

// ----- products -----
export async function deleteProduct(id: string) {
  const p = getOne('products', id);
  if (!p) return;
  const d = getSnapshot().data;
  for (const v of d.videos.filter((x) => x.productId === id)) await deleteVideo(v.id);
  for (const x of d.posts.filter((x) => x.productId === id)) await remove('posts', x.id);
  for (const img of p.imageIds) await delBlob(img);
  await remove('products', id);
  await log('owner', `Deleted product ${p.name}.`);
}

// ----- posts -----
export async function createPost(productId: string, platform: Platform, when: number) {
  const p = getOne('products', productId);
  if (!p) return;
  const copy = buildCopy(p, getSnapshot().settings, platform, Math.floor(Math.random() * 1e9));
  const video = getSnapshot().data.videos.find((v) => v.productId === productId && v.status === 'approved' && v.format === (platform === 'youtube' ? 'wide' : 'reel'));
  const post: Post = { id: uid(), productId, platform, title: copy.title, body: copy.body, hashtags: copy.hashtags, scheduledFor: when, status: textStatus(), videoId: video?.id, createdAt: Date.now() };
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
  await put('leads', { ...lead, score: scoreLead(lead) });
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
