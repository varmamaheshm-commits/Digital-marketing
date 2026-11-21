/**
 * Poster maker: draws still images for social posts and ads from the product's photos,
 * the brand colours and the offer. Three layouts, four shapes. Runs on the device's canvas.
 */
import { buildCopy, formatPrice, productFeatures, rng } from '../core/copy';
import { getBlob, getOne, getSnapshot, log, patch, put, putBlob } from '../core/store';
import { POSTER_INFO, uid, type Creative, type PosterFormat, type PosterTemplate, type Product, type Settings } from '../core/types';
import { loadImage } from './render';
import type { Img } from './draw';

type Ctx = CanvasRenderingContext2D;
const FONT = '"Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans Devanagari", "Noto Sans Telugu", "Noto Sans Tamil", sans-serif';
const TEMPLATES: PosterTemplate[] = ['spotlight', 'split', 'offer'];

export function newCreative(p: Product, s: Settings, format: PosterFormat, template?: PosterTemplate, seed = Math.floor(Math.random() * 2 ** 31)): Creative {
  const r = rng(seed);
  const copy = buildCopy(p, s, 'instagram', seed);
  const feats = productFeatures(p);
  const price = p.price ? formatPrice(p, s) : '';
  return {
    id: uid(), productId: p.id, format, template: template ?? (p.offer ? TEMPLATES[Math.floor(r() * 3)] : TEMPLATES[Math.floor(r() * 2)]),
    headline: p.name, sub: feats[Math.floor(r() * Math.max(1, feats.length))] ?? p.description.slice(0, 60),
    badge: p.offer || price, cta: s.business.phone ? `Call / WhatsApp ${s.business.phone}` : 'Message us to order',
    seed, caption: copy.body, hashtags: copy.hashtags, status: 'queued', createdAt: Date.now(),
  };
}

function wrap(ctx: Ctx, text: string, maxW: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const t = cur ? cur + ' ' + w : w;
    if (ctx.measureText(t).width <= maxW || !cur) cur = t;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = kept[maxLines - 1].replace(/\s*\S*$/, '') + '…';
    return kept;
  }
  return lines;
}

/** Writes text at the largest size (down to `min`) that fits the box. Returns the height used. */
function fitText(ctx: Ctx, text: string, x: number, y: number, maxW: number, size: number, min: number, maxLines: number, weight: number, color: string, align: CanvasTextAlign = 'left'): number {
  let s = size, lines: string[] = [];
  for (; s >= min; s -= 2) {
    ctx.font = `${weight} ${s}px ${FONT}`;
    lines = wrap(ctx, text, maxW, maxLines);
    if (lines.every((l) => ctx.measureText(l).width <= maxW) && !lines[lines.length - 1]?.endsWith('…')) break;
  }
  s = Math.max(s, min);
  ctx.font = `${weight} ${s}px ${FONT}`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = 'top';
  lines.forEach((l, i) => ctx.fillText(l, x, y + i * s * 1.15));
  return lines.length * s * 1.15;
}

function cover(ctx: Ctx, img: Img, x: number, y: number, w: number, h: number, zoom = 1) {
  const k = Math.max(w / img.w, h / img.h) * zoom;
  const dw = img.w * k, dh = img.h * k;
  ctx.drawImage(img.src, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}
function round(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function pill(ctx: Ctx, text: string, x: number, y: number, size: number, bg: string, fg: string, maxW: number) {
  ctx.font = `800 ${size}px ${FONT}`;
  let t = text;
  while (ctx.measureText(t).width > maxW - size * 1.6 && t.length > 4) t = t.slice(0, -2).trimEnd() + '…';
  const w = Math.min(maxW, ctx.measureText(t).width + size * 1.6), h = size * 1.7;
  round(ctx, x, y, w, h, h / 2);
  ctx.fillStyle = bg;
  ctx.fill();
  ctx.fillStyle = fg;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText(t, x + size * 0.8, y + h / 2 + 1);
  return { w, h };
}
const isDark = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return ((n >> 16) * 299 + ((n >> 8) & 255) * 587 + (n & 255) * 114) / 1000 < 150;
};

export function drawPoster(ctx: Ctx, c: Creative, imgs: Img[], s: Settings) {
  const { w, h } = POSTER_INFO[c.format];
  const P = /^#[0-9a-f]{6}$/i.test(s.brand.primary) ? s.brand.primary : '#6d28d9';
  const A = /^#[0-9a-f]{6}$/i.test(s.brand.accent) ? s.brand.accent : '#f59e0b';
  const onA = isDark(A) ? '#fff' : '#111';
  const m = Math.round(Math.min(w, h) * 0.06);
  const wide = w / h > 1.4;
  const r = rng(c.seed);
  const img = imgs.length ? imgs[Math.floor(r() * imgs.length)] : null;
  ctx.clearRect(0, 0, w, h);
  const base = Math.min(w, h);

  if (c.template === 'spotlight') {
    if (img) cover(ctx, img, 0, 0, w, h, 1.02); else { ctx.fillStyle = P; ctx.fillRect(0, 0, w, h); }
    const g = ctx.createLinearGradient(0, h * 0.35, 0, h);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.82)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    if (c.badge) pill(ctx, c.badge, m, m, base * 0.045, A, onA, w - 2 * m);
    const textW = wide ? w * 0.6 : w - 2 * m;
    let y = h - m - base * 0.05;
    ctx.font = `600 ${base * 0.032}px ${FONT}`;
    const ctaH = base * 0.05;
    y -= ctaH;
    fitText(ctx, c.cta, m, y, textW, base * 0.034, base * 0.024, 1, 600, '#fff');
    ctx.font = `500 ${base * 0.04}px ${FONT}`;
    const subLines = c.sub ? wrap(ctx, c.sub, textW, 2).length : 0;
    y -= subLines * base * 0.04 * 1.15 + base * 0.02;
    if (c.sub) fitText(ctx, c.sub, m, y, textW, base * 0.04, base * 0.028, 2, 500, 'rgba(255,255,255,0.9)');
    ctx.font = `800 ${base * 0.085}px ${FONT}`;
    const hl = wrap(ctx, c.headline, textW, 2).length;
    y -= hl * base * 0.085 * 1.15 + base * 0.015;
    fitText(ctx, c.headline, m, y, textW, base * 0.085, base * 0.05, 2, 800, '#fff');
    ctx.fillStyle = A;
    ctx.fillRect(m, y - base * 0.03, base * 0.12, base * 0.012);
  } else if (c.template === 'split') {
    ctx.fillStyle = P;
    ctx.fillRect(0, 0, w, h);
    const vertical = h >= w;
    const ix = vertical ? 0 : w * 0.48, iy = 0, iw = vertical ? w : w * 0.52, ih = vertical ? h * 0.56 : h;
    if (img) {
      ctx.save(); ctx.beginPath(); ctx.rect(ix, iy, iw, ih); ctx.clip();
      ctx.filter = 'none'; cover(ctx, img, ix, iy, iw, ih); ctx.restore();
    }
    const tx = vertical ? m : m, ty = vertical ? ih + m : m * 1.4, tw = vertical ? w - 2 * m : w * 0.48 - 2 * m;
    const fg = isDark(P) ? '#fff' : '#111';
    let y = ty;
    if (s.business.name) y += fitText(ctx, s.business.name.toUpperCase(), tx, y, tw, base * 0.03, base * 0.022, 1, 700, A) + base * 0.02;
    y += fitText(ctx, c.headline, tx, y, tw, base * (vertical ? 0.075 : 0.07), base * 0.045, 2, 800, fg) + base * 0.02;
    if (c.sub) y += fitText(ctx, c.sub, tx, y, tw, base * 0.038, base * 0.026, 2, 500, fg) + base * 0.03;
    if (c.badge) { y += pill(ctx, c.badge, tx, y, base * 0.04, A, onA, tw).h + base * 0.03; }
    fitText(ctx, c.cta, tx, Math.min(y, h - m - base * 0.05), tw, base * 0.032, base * 0.022, 1, 600, fg);
  } else {
    // offer: brand background, big offer text, product photo in a circle
    const g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, P);
    g.addColorStop(1, '#111827');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    const d = wide ? h * 0.78 : Math.min(w, h) * 0.52;
    const cx = wide ? w - m - d / 2 : w / 2, cy = wide ? h / 2 : m + d / 2 + base * 0.08;
    ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, d / 2 + base * 0.015, 0, Math.PI * 2); ctx.fillStyle = A; ctx.fill(); ctx.restore();
    if (img) { ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, d / 2, 0, Math.PI * 2); ctx.clip(); cover(ctx, img, cx - d / 2, cy - d / 2, d, d); ctx.restore(); }
    const tw = wide ? w - d - 3 * m : w - 2 * m, tx = wide ? m : w / 2, align: CanvasTextAlign = wide ? 'left' : 'center';
    let y = wide ? m * 1.2 : cy + d / 2 + base * 0.05;
    y += fitText(ctx, (c.badge || c.headline).toUpperCase(), tx, y, tw, base * 0.09, base * 0.05, 2, 900, A, align) + base * 0.015;
    y += fitText(ctx, c.headline, tx, y, tw, base * 0.06, base * 0.036, 2, 800, '#fff', align) + base * 0.015;
    if (c.sub) y += fitText(ctx, c.sub, tx, y, tw, base * 0.036, base * 0.026, 2, 500, 'rgba(255,255,255,0.9)', align) + base * 0.02;
    fitText(ctx, c.cta, tx, Math.min(y, h - m - base * 0.045), tw, base * 0.032, base * 0.022, 1, 600, '#fff', align);
  }
  // Small brand line in the corner for all layouts except split (which shows it in the text).
  if (c.template !== 'split' && s.business.name) {
    ctx.font = `700 ${base * 0.026}px ${FONT}`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillText(s.business.name, w - m, m * 0.9);
  }
}

async function productImages(p: Product): Promise<Img[]> {
  const out: Img[] = [];
  for (const id of p.imageIds.slice(0, 6)) {
    const b = await getBlob(id);
    if (b) { try { out.push(await loadImage(b, 1600)); } catch { /* skip unreadable photo */ } }
  }
  return out;
}

export async function renderPoster(c: Creative): Promise<ArrayBuffer> {
  const snap = getSnapshot();
  const p = getOne('products', c.productId);
  if (!p) throw new Error('The product no longer exists.');
  const { w, h } = POSTER_INFO[c.format];
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  drawPoster(ctx, c, await productImages(p), snap.settings);
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'));
  if (!blob) throw new Error('This device could not create the image.');
  return blob.arrayBuffer();
}

let pumping = false;
/** Draws every queued image. Images are approved directly unless the owner approves everything. */
export async function pumpPosters(): Promise<number> {
  if (pumping) return 0;
  pumping = true;
  let n = 0;
  try {
    for (;;) {
      const snap = getSnapshot();
      if (snap.status !== 'unlocked') break;
      const next = snap.data.images.find((c) => c.status === 'queued');
      if (!next) break;
      try {
        const bytes = await renderPoster(next);
        const blobId = await putBlob(bytes);
        await patch('images', next.id, { blobId, status: 'pending', error: undefined });
        n++;
      } catch (e) {
        await patch('images', next.id, { status: 'failed', error: String((e as Error)?.message ?? e).slice(0, 200) });
      }
    }
    if (n) await log('auto', `Created ${n} image post(s).`);
  } finally {
    pumping = false;
  }
  return n;
}

export async function createPoster(p: Product, format: PosterFormat, template?: PosterTemplate) {
  const c = newCreative(p, getSnapshot().settings, format, template);
  await put('images', c);
  void pumpPosters();
  return c.id;
}
