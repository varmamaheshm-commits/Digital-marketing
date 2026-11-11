/** Background render queue: turns `queued` videos into finished files awaiting approval. */
import { delBlob, getBlob, getOne, getSnapshot, log, patch, patchVolatile, putBlob } from '../core/store';
import { renderVideo } from './render';

let running = false;
let cancelId: string | null = null;

export const isRendering = () => running;
export const cancelRender = (id: string) => { cancelId = id; };

export async function pumpQueue() {
  if (running) return;
  running = true;
  let wake: any = null;
  try {
    wake = await (navigator as any).wakeLock?.request?.('screen').catch(() => null);
    for (;;) {
      const snap = getSnapshot();
      if (snap.status !== 'unlocked') break;
      const next = snap.data.videos.filter((v) => v.status === 'queued').sort((a, b) => a.createdAt - b.createdAt)[0];
      if (!next) break;
      const product = getOne('products', next.productId);
      if (!product) { await patch('videos', next.id, { status: 'failed', error: 'The product was deleted.' }); continue; }
      await patch('videos', next.id, { status: 'rendering', progress: 0, error: undefined });
      try {
        const photos: ArrayBuffer[] = [];
        for (const id of product.imageIds) {
          const b = await getBlob(id);
          if (b) photos.push(b);
        }
        let last = 0;
        const res = await renderVideo(next, photos, snap.settings, (p) => {
          if (p - last >= 0.02 || p === 1) { last = p; patchVolatile('videos', next.id, { progress: p }); }
        }, () => cancelId === next.id || getSnapshot().status !== 'unlocked');
        if (getSnapshot().status !== 'unlocked') break;
        const blobId = await putBlob(res.data);
        const thumbId = res.thumb ? await putBlob(res.thumb) : undefined;
        const old = getOne('videos', next.id);
        if (!old) { await delBlob(blobId); await delBlob(thumbId); continue; } // deleted while rendering
        await patch('videos', next.id, {
          status: 'pending', progress: undefined, blobId, thumbId, mime: res.mime, codec: res.codec,
          seconds: res.seconds, sizeBytes: res.data.byteLength,
        });
        await log('auto', `Video ready for approval: ${product.name} (${next.format}).`);
      } catch (e: any) {
        if (getSnapshot().status !== 'unlocked') break;
        if (!getOne('videos', next.id)) continue;
        const cancelled = e?.message === 'cancelled';
        await patch('videos', next.id, { status: 'failed', progress: undefined, error: cancelled ? 'Cancelled.' : String(e?.message ?? e) });
      }
      cancelId = null;
    }
  } finally {
    running = false;
    wake?.release?.().catch(() => {});
  }
}

/** Videos left mid-render when the app was closed go back to the queue. */
export async function recoverInterrupted() {
  for (const v of getSnapshot().data.videos) {
    if (v.status === 'rendering') await patch('videos', v.id, { status: 'queued', progress: undefined });
  }
}
