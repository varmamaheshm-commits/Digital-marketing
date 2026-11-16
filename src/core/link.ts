/**
 * Answers requests arriving over the phone link / automation API (see electron/link.cjs).
 * Runs inside the unlocked app, so it works on decrypted data; the server in the main
 * process has already checked the pairing code and that the caller is on the local network.
 *
 * Deliberately small surface: read what is waiting, approve or reject a video, add a lead.
 * It cannot read the lead list, change settings or export anything.
 */
import { decideVideo, pendingCounts, runAutopilot, saveLead } from './actions';
import { getBlob, getOne, getSnapshot } from './store';
import { FORMAT_INFO, TARGET_INFO, uid, type Lead } from './types';

export interface LinkRequest { method: string; path: string; body: unknown }
export type LinkReply = { status: number; json: unknown } | { status: number; type: string; buffer: ArrayBuffer };

const fail = (status: number, error: string): LinkReply => ({ status, json: { error } });
const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, max) : '');

export async function handleLink(req: LinkRequest): Promise<LinkReply> {
  const snap = getSnapshot();
  if (snap.status !== 'unlocked') return fail(503, 'Marketing Studio on the PC is locked. Unlock it there first.');
  const { data, settings } = snap;
  const productName = (id?: string) => data.products.find((p) => p.id === id)?.name ?? 'Product';
  const path = req.path.replace(/\/+$/, '');

  if (req.method === 'GET' && path === '/api/status') {
    const c = pendingCounts();
    return { status: 200, json: { business: settings.business.name, waiting: c.videos, creating: data.videos.filter((v) => v.status === 'queued' || v.status === 'rendering').length, approved: data.videos.filter((v) => v.status === 'approved').length, leads: data.leads.length } };
  }

  if (req.method === 'GET' && path === '/api/approvals') {
    const videos = data.videos
      .filter((v) => v.status === 'pending' && v.blobId)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((v) => ({ id: v.id, product: productName(v.productId), shape: FORMAT_INFO[v.format].label, seconds: v.seconds ? Math.round(v.seconds) : 0, uploaded: v.source === 'upload', caption: [v.caption, v.hashtags.join(' ')].filter(Boolean).join('\n\n') }));
    const posts = [...data.publications]
      .sort((a, b) => (b.triedAt ?? b.createdAt) - (a.triedAt ?? a.createdAt))
      .slice(0, 6)
      .map((p) => ({ product: productName(getOne('videos', p.videoId)?.productId), platform: TARGET_INFO[p.target].label, status: p.status }));
    return { status: 200, json: { business: settings.business.name, videos, posts } };
  }

  const m = /^\/api\/videos\/([0-9a-f]{8,64})\/(thumb|file|approve|reject)$/.exec(path);
  if (m) {
    const v = getOne('videos', m[1]);
    if (!v) return fail(404, 'That video no longer exists.');
    const action = m[2];
    if (req.method === 'GET' && (action === 'thumb' || action === 'file')) {
      // Only videos still in the approval flow can be viewed over the link.
      if (v.status !== 'pending' && v.status !== 'approved') return fail(404, 'That video is not available.');
      const id = action === 'thumb' ? v.thumbId : v.blobId;
      const bytes = id ? await getBlob(id) : null;
      if (!bytes) return fail(404, 'No preview is available for this video.');
      return { status: 200, type: action === 'thumb' ? 'image/jpeg' : v.mime ?? 'video/mp4', buffer: bytes };
    }
    if (req.method === 'POST' && (action === 'approve' || action === 'reject')) {
      if (v.status !== 'pending') return fail(409, `This video was already ${v.status}.`);
      await decideVideo(v.id, action === 'approve', 'Decided from the phone link');
      return { status: 200, json: { ok: true, status: action === 'approve' ? 'approved' : 'rejected' } };
    }
    return fail(405, 'Method not allowed.');
  }

  if (req.method === 'POST' && path === '/api/leads') {
    const b = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const name = text(b.name, 120), phone = text(b.phone, 40), email = text(b.email, 160);
    if (!name && !phone && !email) return fail(400, 'A lead needs at least a name, phone or email.');
    const wanted = text(b.product, 120).toLowerCase();
    const product = wanted ? data.products.find((p) => p.name.toLowerCase() === wanted) ?? data.products.find((p) => p.name.toLowerCase().includes(wanted)) : undefined;
    const lead: Lead = {
      id: uid(), name, phone, email, source: text(b.source, 60) || 'automation', productId: product?.id, stage: 'new', score: 0,
      notes: text(b.notes, 1000), value: Math.max(0, Number(b.value) || 0),
      // Follow-ups are only drafted for people who agreed to be contacted; it must be stated explicitly.
      consent: b.consent === true, createdAt: Date.now(),
    };
    await saveLead(lead);
    // Drafting the welcome message runs in the background; if the app is locked meanwhile it simply stops.
    void runAutopilot().catch(() => {});
    return { status: 201, json: { ok: true, id: lead.id } };
  }

  return fail(404, 'Unknown request.');
}

/** A pairing code: 20 symbols from a 30-letter alphabet without look-alikes (about 98 bits). */
export function newPairingCode(): string {
  const A = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
  const out: string[] = [];
  while (out.length < 20) for (const b of crypto.getRandomValues(new Uint8Array(32))) if (b < 240 && out.length < 20) out.push(A[b % 30]);
  return out.join('').replace(/(.{5})(?=.)/g, '$1-');
}
